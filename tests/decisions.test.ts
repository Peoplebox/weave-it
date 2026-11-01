import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { adrCommand } from "../src/commands/adr.js";
import { createChange } from "../src/lib/changes.js";
import {
  checkDecisions,
  decisionGuidanceMarker,
  ensureDecisionGuidance,
  listDecisions,
  matchesAppliesTo,
  newDecision,
  setDecisionStatus,
} from "../src/lib/decisions.js";
import { initWorkspace } from "../src/lib/init-workspace.js";

const execFileAsync = promisify(execFile);
const testNow = new Date(2026, 10, 1, 10, 0, 0);
const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  process.exitCode = undefined;
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await git(cwd, ["add", "."]);
  await git(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message]);
}

async function repo(mode: "repo" | "workspace" = "repo", repos: Record<string, unknown> = {}): Promise<string> {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-decisions-")));
  await mkdir(path.join(cwd, ".weave"), { recursive: true });
  await writeFile(path.join(cwd, ".weave", "workspace.yml"), YAML.stringify({ version: 1, mode, name: "test", repos }));
  await git(cwd, ["init", "-b", "main"]);
  await commitAll(cwd, "init");
  return cwd;
}

function sessionPath(cwd: string): string {
  return path.join(cwd, ".session.yml");
}

async function create(cwd: string, title: string, id: string, extra: { appliesTo?: string[]; supersedes?: string[] } = {}) {
  return newDecision({ cwd, title, now: testNow, randomId: () => id, sessionPath: sessionPath(cwd), owner: "Priya", ...extra });
}

describe("matchesAppliesTo", () => {
  it.each([
    ["src/lib/changes.ts", "src/lib/changes.ts", true],
    ["src/lib/changes.ts", "src/lib", true],
    ["src/lib/changes.ts", "src/lib/", true],
    ["src/library/changes.ts", "src/lib", false],
    ["src/lib/changes.ts", "src/**", true],
    ["src/lib/deep/changes.ts", "src/**/changes.ts", true],
    ["src/changes.ts", "src/**/changes.ts", true],
    ["src/lib/changes.ts", "src/*.ts", false],
    ["src/changes.ts", "src/*.ts", true],
    ["src/a.ts", "src/?.ts", true],
    ["src/a.tsx", "src/*.ts", false],
    ["./src/a.ts", "src/a.ts", true],
    ["src/a.ts", "", false],
  ])("%s against %s is %s", (file, pattern, expected) => {
    expect(matchesAppliesTo(file, pattern)).toBe(expected);
  });
});

describe("newDecision", () => {
  it("creates a proposed decision in wiki/decisions with an index", async () => {
    const cwd = await repo();

    const result = await create(cwd, "Use a separate approvals table", "a3f9", { appliesTo: ["src/approvals/**"] });

    expect(result.decision).toMatchObject({
      id: "261101-a3f9-use-a-separate-approvals-table",
      status: "proposed",
      date: "2026-11-01",
      owner: "Priya",
      applies_to: ["src/approvals/**"],
      supersedes: [],
      managed: true,
      path: "wiki/decisions/261101-a3f9-use-a-separate-approvals-table.md",
    });
    const content = await readFile(path.join(cwd, result.decision.path), "utf8");
    expect(content).toContain("## Reconsider When");
    expect(content).toContain("## Alternatives Rejected");
    const index = await readFile(path.join(cwd, "wiki", "decisions", "index.md"), "utf8");
    expect(index).toContain("[261101-a3f9-use-a-separate-approvals-table](261101-a3f9-use-a-separate-approvals-table.md)");
    expect(index).toContain("`src/approvals/**`");
  });

  it("records the active change", async () => {
    const cwd = await repo();
    const change = await createChange({ cwd, title: "Approvals", now: testNow, randomId: () => "c111", sessionPath: sessionPath(cwd) });

    const result = await create(cwd, "Decision on a change", "a111");

    expect(result.decision.change).toBe(change.id);
  });

  it("requires a title and an existing decision to supersede", async () => {
    const cwd = await repo();

    await expect(create(cwd, "   ", "a111")).rejects.toMatchObject({ code: "missing_title" });
    await expect(create(cwd, "Replacement", "a222", { supersedes: ["nope"] })).rejects.toMatchObject({ code: "unknown_decision" });
  });

  it("retries the id instead of overwriting an existing decision", async () => {
    const cwd = await repo();
    const ids = ["a111", "a111", "b222"];
    await newDecision({ cwd, title: "Same title", now: testNow, randomId: () => ids.shift() as string, sessionPath: sessionPath(cwd) });

    const second = await newDecision({ cwd, title: "Same title", now: testNow, randomId: () => ids.shift() as string, sessionPath: sessionPath(cwd) });

    expect(second.decision.id).toBe("261101-b222-same-title");
  });

  it("uses a folder the repo already has instead of adding a second home", async () => {
    const cwd = await repo();
    await mkdir(path.join(cwd, "docs", "adr"), { recursive: true });

    const result = await create(cwd, "In the existing folder", "a111");

    expect(result.decision.path).toBe("docs/adr/261101-a111-in-the-existing-folder.md");
  });

  it("does not overwrite an index it did not write", async () => {
    const cwd = await repo();
    await mkdir(path.join(cwd, "docs", "adr"), { recursive: true });
    await writeFile(path.join(cwd, "docs", "adr", "index.md"), "# Our own index\n");

    await create(cwd, "Next to a hand-written index", "a111");

    await expect(readFile(path.join(cwd, "docs", "adr", "index.md"), "utf8")).resolves.toBe("# Our own index\n");
  });
});

describe("listDecisions", () => {
  it("filters by status and by the files a decision applies to, relative to the cwd", async () => {
    const cwd = await repo();
    const billing = await create(cwd, "Billing rule", "a111", { appliesTo: ["services/billing/**"] });
    await create(cwd, "Web rule", "b222", { appliesTo: ["apps/web/"] });
    await setDecisionStatus({ cwd, decision: billing.decision.id, status: "accepted", sessionPath: sessionPath(cwd) });

    const accepted = await listDecisions({ cwd, status: "accepted", sessionPath: sessionPath(cwd) });
    expect(accepted.decisions.map((decision) => decision.id)).toEqual([billing.decision.id]);

    const byPath = await listDecisions({ cwd, filePath: "apps/web/page.tsx", sessionPath: sessionPath(cwd) });
    expect(byPath.decisions.map((decision) => decision.title)).toEqual(["Web rule"]);

    const nested = path.join(cwd, "services", "billing");
    await mkdir(nested, { recursive: true });
    const fromNested = await listDecisions({ cwd: nested, filePath: "invoice.ts", sessionPath: sessionPath(cwd) });
    expect(fromNested.decisions.map((decision) => decision.title)).toEqual(["Billing rule"]);
  });

  it("reads ADRs written outside Weave without claiming to manage them", async () => {
    const cwd = await repo();
    await mkdir(path.join(cwd, "docs", "adr"), { recursive: true });
    await writeFile(path.join(cwd, "docs", "adr", "0001-use-postgres.md"), "# Use Postgres\n\n## Status\n\nAccepted\n");
    await writeFile(path.join(cwd, "docs", "adr", "README.md"), "# ADRs\n");

    const result = await listDecisions({ cwd, sessionPath: sessionPath(cwd) });

    expect(result.decisions).toEqual([
      expect.objectContaining({ id: "0001-use-postgres", title: "Use Postgres", status: "accepted", managed: false }),
    ]);
    await expect(
      setDecisionStatus({ cwd, decision: "0001", status: "superseded", supersededBy: "0001", sessionPath: sessionPath(cwd) }),
    ).rejects.toMatchObject({ code: "unmanaged_decision" });
  });
});

describe("setDecisionStatus", () => {
  it("retires a superseded decision only when its replacement is accepted", async () => {
    const cwd = await repo();
    const old = await create(cwd, "Old approach", "a111");
    await setDecisionStatus({ cwd, decision: "a111", status: "accepted", sessionPath: sessionPath(cwd) });
    const replacement = await create(cwd, "New approach", "b222", { supersedes: ["a111"] });

    let decisions = (await listDecisions({ cwd, sessionPath: sessionPath(cwd) })).decisions;
    expect(decisions.find((decision) => decision.id === old.decision.id)?.status).toBe("accepted");

    const result = await setDecisionStatus({ cwd, decision: "b222", status: "accepted", sessionPath: sessionPath(cwd) });

    expect(result.superseded.map((decision) => decision.id)).toEqual([old.decision.id]);
    decisions = (await listDecisions({ cwd, sessionPath: sessionPath(cwd) })).decisions;
    expect(decisions.find((decision) => decision.id === old.decision.id)).toMatchObject({
      status: "superseded",
      superseded_by: replacement.decision.id,
    });
    await expect(readFile(path.join(cwd, old.decision.path), "utf8")).resolves.toContain("# Old approach");
    await expect(readFile(path.join(cwd, "wiki", "decisions", "index.md"), "utf8")).resolves.toMatch(/Old approach \| superseded/);
  });

  it("never lets an accepted decision go back, and needs a replacement to supersede", async () => {
    const cwd = await repo();
    await create(cwd, "Fixed", "a111");
    await setDecisionStatus({ cwd, decision: "a111", status: "accepted", sessionPath: sessionPath(cwd) });

    await expect(setDecisionStatus({ cwd, decision: "a111", status: "proposed", sessionPath: sessionPath(cwd) })).rejects.toMatchObject({
      code: "invalid_status_transition",
    });
    await expect(setDecisionStatus({ cwd, decision: "a111", status: "accepted", sessionPath: sessionPath(cwd) })).rejects.toMatchObject({
      code: "invalid_status_transition",
    });
    await expect(setDecisionStatus({ cwd, decision: "a111", status: "superseded", sessionPath: sessionPath(cwd) })).rejects.toMatchObject({
      code: "missing_superseded_by",
    });
    await expect(
      setDecisionStatus({ cwd, decision: "a111", status: "superseded", supersededBy: "a111", sessionPath: sessionPath(cwd) }),
    ).rejects.toMatchObject({ code: "invalid_superseded_by" });
  });

  it("reports ambiguous references", async () => {
    const cwd = await repo();
    await create(cwd, "Shared words one", "a111");
    await create(cwd, "Shared words two", "b222");

    await expect(setDecisionStatus({ cwd, decision: "shared-words", status: "accepted", sessionPath: sessionPath(cwd) })).rejects.toMatchObject({
      code: "ambiguous_decision",
    });
  });
});

describe("checkDecisions", () => {
  it("reports decisions touched by committed, uncommitted, and untracked changes, and never the ADR files", async () => {
    const cwd = await repo();
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src", "committed.ts"), "1\n");
    await writeFile(path.join(cwd, "src", "edited.ts"), "1\n");
    await commitAll(cwd, "base");
    await git(cwd, ["checkout", "-b", "work"]);
    await writeFile(path.join(cwd, "src", "committed.ts"), "2\n");
    await commitAll(cwd, "work");
    await writeFile(path.join(cwd, "src", "edited.ts"), "2\n");
    await writeFile(path.join(cwd, "src", "untracked.ts"), "1\n");

    const touching = await create(cwd, "Source rule", "a111", { appliesTo: ["src/**"] });
    await create(cwd, "Unrelated rule", "b222", { appliesTo: ["apps/**"] });
    const noPaths = await create(cwd, "Pathless rule", "c333");

    const result = await checkDecisions({ cwd, sessionPath: sessionPath(cwd) });

    expect(result.changed_files).toEqual(["src/committed.ts", "src/edited.ts", "src/untracked.ts"]);
    expect(result.touched).toEqual([{ decision: expect.objectContaining({ id: touching.decision.id }), files: result.changed_files }]);
    expect(result.without_paths.map((decision) => decision.id)).toEqual([noPaths.decision.id]);
    expect(result.message).toContain("1 decision(s) apply");
  });

  it("ignores superseded decisions", async () => {
    const cwd = await repo();
    await create(cwd, "Old rule", "a111", { appliesTo: ["src/**"] });
    await setDecisionStatus({ cwd, decision: "a111", status: "accepted", sessionPath: sessionPath(cwd) });
    await create(cwd, "New rule", "b222", { appliesTo: ["src/**"], supersedes: ["a111"] });
    await setDecisionStatus({ cwd, decision: "b222", status: "accepted", sessionPath: sessionPath(cwd) });
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src", "new.ts"), "1\n");

    const result = await checkDecisions({ cwd, sessionPath: sessionPath(cwd) });

    expect(result.touched.map(({ decision }) => decision.title)).toEqual(["New rule"]);
  });

  it("checks registered repos in workspace mode, using paths from the workspace root", async () => {
    const cwd = await repo("workspace", { billing: { path: "billing", kind: "repo" }, missing: { path: "missing", kind: "repo" } });
    const billing = path.join(cwd, "billing");
    await mkdir(billing, { recursive: true });
    await git(billing, ["init", "-b", "main"]);
    await writeFile(path.join(billing, "invoice.ts"), "1\n");
    await create(cwd, "Invoice rule", "a111", { appliesTo: ["billing/**"] });

    const result = await checkDecisions({ cwd: billing, sessionPath: sessionPath(cwd) });

    expect(result.changed_files).toContain("billing/invoice.ts");
    expect(result.touched.map(({ decision }) => decision.title)).toEqual(["Invoice rule"]);
    expect(result.skipped).toEqual([{ path: "missing", reason: "not a git repository" }]);
  });

  it("fails clearly on an unknown base", async () => {
    const cwd = await repo();

    await expect(checkDecisions({ cwd, base: "no-such-ref", sessionPath: sessionPath(cwd) })).rejects.toMatchObject({ code: "unknown_base" });
  });
});

describe("ensureDecisionGuidance", () => {
  it("creates AGENTS.md when there is none", async () => {
    const cwd = await repo();

    await expect(ensureDecisionGuidance(cwd)).resolves.toBe("created");

    const content = await readFile(path.join(cwd, "AGENTS.md"), "utf8");
    expect(content).toContain(decisionGuidanceMarker);
    expect(content).toContain("weave adr list --path <file> --json");
  });

  it("appends to an existing AGENTS.md without changing it, and only once", async () => {
    const cwd = await repo();
    const original = "# Our rules\n\nNever touch prod.\n";
    await writeFile(path.join(cwd, "AGENTS.md"), original);

    await expect(ensureDecisionGuidance(cwd)).resolves.toBe("appended");
    await expect(ensureDecisionGuidance(cwd)).resolves.toBe("unchanged");

    const content = await readFile(path.join(cwd, "AGENTS.md"), "utf8");
    expect(content.startsWith(original)).toBe(true);
    expect(content.split(decisionGuidanceMarker)).toHaveLength(2);
  });

  it("is added by weave init on an already-initialised project", async () => {
    const cwd = await repo();

    const result = await initWorkspace({ cwd, sessionPath: sessionPath(cwd), yes: true } as Parameters<typeof initWorkspace>[0]);

    expect(result.status).toBe("already_initialized");
    expect(result.message).toContain("Added decision guidance to AGENTS.md.");
    await expect(readFile(path.join(cwd, "AGENTS.md"), "utf8")).resolves.toContain(decisionGuidanceMarker);
  });
});

describe("weave adr CLI", () => {
  async function run(args: string[]): Promise<Record<string, unknown>> {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await adrCommand().parseAsync(args, { from: "user" });
    } finally {
      process.stdout.write = original;
    }
    return JSON.parse(chunks.join("")) as Record<string, unknown>;
  }

  it("creates, lists, accepts, and checks through the commands", async () => {
    const cwd = await repo();
    process.chdir(cwd);

    const created = await run(["new", "CLI decision", "--slug", "cli", "--applies-to", "src/**", "--applies-to", "docs/", "--owner", "Sam", "--json"]);
    const decision = created.decision as { id: string; applies_to: string[]; owner: string };
    expect(decision.applies_to).toEqual(["src/**", "docs/"]);
    expect(decision.owner).toBe("Sam");
    await expect(readFile(path.join(cwd, "AGENTS.md"), "utf8")).resolves.toContain(decisionGuidanceMarker);

    const accepted = await run(["status", decision.id, "accepted", "--json"]);
    expect(accepted.decision).toMatchObject({ status: "accepted" });

    const listed = await run(["list", "--status", "accepted", "--path", "src/a.ts", "--json"]);
    expect((listed.decisions as { id: string }[]).map((entry) => entry.id)).toEqual([decision.id]);

    const checked = await run(["check", "--json"]);
    expect(checked.status).toBe("ok");
  });

  it("reports errors as JSON with a code", async () => {
    const cwd = await repo();
    process.chdir(cwd);

    const result = await run(["status", "missing", "accepted", "--json"]);

    expect(result).toMatchObject({ status: "error", code: "unknown_decision" });
    expect(process.exitCode).toBe(1);
  });
});
