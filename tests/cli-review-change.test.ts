import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewCommand } from "../src/commands/review.js";
import { reportInput } from "../src/commands/review/record.js";
import { createChange } from "../src/lib/changes.js";

// End-to-end scenarios: each reviews two slices and then the change, with many git snapshots.
vi.setConfig({ testTimeout: 30_000 });

const execFileAsync = promisify(execFile);
const testNow = new Date(2026, 10, 10, 10, 0, 0);
const originalCwd = process.cwd();
const originalSessionEnv = process.env.WEAVE_SESSION_PATH;
const originalRead = reportInput.read;
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Weave Test",
  GIT_AUTHOR_EMAIL: "weave@example.com",
  GIT_COMMITTER_NAME: "Weave Test",
  GIT_COMMITTER_EMAIL: "weave@example.com",
};

afterEach(() => {
  process.chdir(originalCwd);
  if (originalSessionEnv === undefined) {
    delete process.env.WEAVE_SESSION_PATH;
  } else {
    process.env.WEAVE_SESSION_PATH = originalSessionEnv;
  }
  reportInput.read = originalRead;
  process.exitCode = undefined;
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv });
  return stdout.trim();
}

async function write(root: string, file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
}

interface TaskSpec {
  id: string;
  status: string;
  files: string[];
  verification?: string[];
}

function tasksMarkdown(tasks: TaskSpec[]): string {
  const lines = [
    "# Tasks",
    "",
    "## Active Task Index",
    "",
    "| ID | Status | Execution | Repos | Owner | Title | Blocked by |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...tasks.map((task) => `| ${task.id} | ${task.status} | afk | root | | Task ${task.id} | None |`),
    "",
  ];
  for (const task of tasks) {
    lines.push(`### ${task.id}: Task ${task.id}`, "", `Status: ${task.status}`, "Repos: root", "Files:", ...task.files.map((file) => `- \`${file}\` (M)`), "");
    lines.push("### What to build", "", "Build it.", "", "### Verification", "", ...(task.verification ?? ["- Automated tests: passed"]), "");
  }
  lines.push("## QA Findings", "", "None.", "");
  return lines.join("\n");
}

interface Fixture {
  root: string;
  changePath: string;
  changeId: string;
}

// A repo-mode Weave root with review installed, on its change, holding a PRD and an architecture
// file. `main` points at the scaffold commit, so the diff base is the change's uncommitted work.
async function setupRoot(id: string): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-cli-review-change-")));
  await write(root, ".weave/workspace.yml", YAML.stringify({ version: 1, mode: "repo", name: "fixture", repos: {} }));
  await write(root, ".weave/agents.yml", YAML.stringify({ version: 1, installed: { claude: { skills: { "weave-review": { path: ".claude/skills/weave-review/SKILL.md" } } } } }));
  await write(root, ".gitignore", "/.session.yml\n");
  await write(root, "README.md", "initial\n");
  await write(root, "src/alpha/a.ts", "export const a = 1;\n");
  await write(root, "src/beta/b.ts", "export const b = 1;\n");
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "initial"]);
  const session = path.join(root, ".session.yml");
  const created = await createChange({ cwd: root, title: "Final review", now: testNow, randomId: () => id, sessionPath: session });
  const changePath = path.join(root, "wiki", "changes", created.id);
  await write(changePath, "prd.md", "---\nartifact: prd\n---\n\n# PRD\n\nFR1.\n");
  await write(changePath, "architecture/index.md", "# Architecture\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "scaffold"]);
  if ((await git(root, ["branch", "--show-current"])) !== "main") {
    await git(root, ["branch", "-f", "main", "HEAD"]);
  }
  process.env.WEAVE_SESSION_PATH = session;
  process.chdir(root);
  return { root, changePath, changeId: created.id };
}

async function writeSlice(fixture: Fixture, id: string, tasks: TaskSpec[]): Promise<string> {
  const slicePath = path.join(fixture.changePath, "task-slices", id);
  await write(
    slicePath,
    "status.yml",
    YAML.stringify({ version: 1, id, title: id, status: "in_progress", owner: "", repos: ["root"], depends_on: [], task_summary: { total: tasks.length, done: 0, blocked: 0 } }),
  );
  await write(slicePath, "slice.md", `# ${id}\n\nAcceptance.\n`);
  await write(slicePath, "tasks.md", tasksMarkdown(tasks));
  return slicePath;
}

async function run(args: string[], stdin?: string): Promise<{ result: Record<string, any>; exitCode: number | undefined }> {
  if (stdin !== undefined) {
    reportInput.read = async () => stdin;
  }
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  });
  try {
    const command = reviewCommand();
    command.exitOverride();
    await command.parseAsync([...args, "--json"], { from: "user" });
  } finally {
    spy.mockRestore();
  }
  const exitCode = process.exitCode === undefined ? undefined : Number(process.exitCode);
  process.exitCode = undefined;
  return { result: JSON.parse(chunks.join("")) as Record<string, any>, exitCode };
}

async function runText(args: string[]): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  });
  try {
    const command = reviewCommand();
    command.exitOverride();
    await command.parseAsync(args, { from: "user" });
  } finally {
    spy.mockRestore();
  }
  process.exitCode = undefined;
  return chunks.join("");
}

async function ok(args: string[], stdin?: string): Promise<Record<string, any>> {
  const outcome = await run(args, stdin);
  expect(outcome.exitCode, `${args.join(" ")}: ${JSON.stringify(outcome.result)}`).toBeUndefined();
  expect(outcome.result.status).toBe("ok");
  return outcome.result;
}

function finding(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    severity: "important",
    kind: "code",
    location: { repo: "root", path: "src/alpha/a.ts", line: 1 },
    fails: { type: "prd", ref: "FR1" },
    detail: `Problem ${id}.`,
    fix_hint: "Fix it.",
    ...extra,
  };
}

function report(findings: Array<Record<string, unknown>>, minorSort?: Array<[string, string]>): string {
  const json: Record<string, unknown> = { strengths: ["Clear"], findings, declined: [], verdict: findings.length > 0 ? "with_fixes" : "ready" };
  if (minorSort) json.final_only = { minor_sort: minorSort.map(([id, sortClass]) => ({ finding: id, class: sortClass })) };
  return `Reviewed.\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;
}

function fixCheck(checks: Array<[string, string]>): string {
  return `Checked.\n\n\`\`\`json\n${JSON.stringify({ checks: checks.map(([id, result]) => ({ finding: id, result })), new_findings: [] }, null, 2)}\n\`\`\`\n`;
}

interface SliceReview {
  findings?: Array<Record<string, unknown>>;
  // Each finding to resolve, with its `--as` arguments.
  resolutions?: Array<[string, string[]]>;
}

// Reviews one slice end to end: package, record the report, resolve, finalize.
async function reviewSlice(id: string, review: SliceReview = {}): Promise<void> {
  const packaged = await ok(["package", "--slice", id]);
  const runId = packaged.run_id as string;
  await ok(["record", "--run", runId, "--report", "-"], report(review.findings ?? []));
  for (const [findingId, args] of review.resolutions ?? []) {
    await ok(["record", "--run", runId, "--resolve", findingId, ...args]);
  }
  await ok(["record", "--run", runId, "--finalize"]);
}

interface TwoSliceOptions {
  alpha?: SliceReview;
  beta?: SliceReview;
  betaTasks?: TaskSpec[];
  reviewBeta?: boolean;
}

// Two slices: `01-alpha` owns `src/alpha/`, `02-beta` owns `src/beta/`. Both start, change their
// files, finish their tasks, and are reviewed (unless `reviewBeta: false`).
async function setupTwoSlices(id: string, options: TwoSliceOptions = {}): Promise<Fixture> {
  const fixture = await setupRoot(id);
  const alphaTasks: TaskSpec[] = [{ id: "T1", status: "done", files: ["src/alpha/"] }];
  const betaTasks = options.betaTasks ?? [{ id: "T1", status: "done", files: ["src/beta/"] }];
  const alpha = await writeSlice(fixture, "01-alpha", alphaTasks.map((task) => ({ ...task, status: "in_progress" })));
  const beta = await writeSlice(fixture, "02-beta", betaTasks.map((task) => ({ ...task, status: "in_progress" })));
  await ok(["snapshot", "--slice", "01", "--at", "start"]);
  await ok(["snapshot", "--slice", "02", "--at", "start"]);
  await write(fixture.root, "src/alpha/a.ts", "export const a = 2;\n");
  await write(fixture.root, "src/beta/b.ts", "export const b = 2;\n");
  await writeFile(path.join(alpha, "tasks.md"), tasksMarkdown(alphaTasks));
  await writeFile(path.join(beta, "tasks.md"), tasksMarkdown(betaTasks));
  await reviewSlice("01", options.alpha ?? {});
  if (options.reviewBeta !== false) await reviewSlice("02", options.beta ?? {});
  return fixture;
}

async function readYaml(file: string): Promise<Record<string, any>> {
  return YAML.parse(await readFile(file, "utf8")) as Record<string, any>;
}

// Alpha parks a Minor and rules (disagreeing) on an Important; beta parks a Minor and has an
// untested task and a human check.
const savedItems: TwoSliceOptions = {
  alpha: {
    findings: [finding("F1", { severity: "minor", detail: "Alpha naming." }), finding("F2", { detail: "Alpha edge case." })],
    resolutions: [
      ["F1", ["--as", "parked"]],
      ["F2", ["--as", "ruling", "--agreed", "false", "--reason", "The edge case cannot happen.", "--cost", "A crash on empty input."]],
    ],
  },
  beta: {
    findings: [finding("F1", { severity: "minor", location: { repo: "root", path: "src/beta/b.ts", line: 1 }, detail: "Beta comment." })],
    resolutions: [["F1", ["--as", "parked"]]],
  },
  betaTasks: [
    { id: "T1", status: "done", files: ["src/beta/"], verification: ["- Automated tests: passed", "- Human check: open the beta page"] },
    { id: "T2", status: "not_tested", files: ["src/beta/"] },
  ],
};

describe("weave review package --change", () => {
  it("packages the whole change once, with plan and docs edits apart and every slice's saved items", async () => {
    const fixture = await setupTwoSlices("ch01", savedItems);
    await write(fixture.root, "wiki/decisions/261110-abcd-use-refs.md", "---\nid: 261110-abcd-use-refs\nstatus: accepted\n---\n\n# Use refs\n");
    await write(fixture.root, "wiki/knowledge/review.md", "# Review\n\nHow review works.\n");

    expect(await ok(["gate", "--change"])).toMatchObject({ pass: true, blocking: [] });
    const packaged = await ok(["package", "--change"]);
    expect(packaged).toMatchObject({
      run_id: "change/f1",
      scope: { kind: "change" },
      model_level: "most_capable",
      partial: false,
      foreign_files: 0,
      plan_and_docs_files: 2,
      saved_minors: 2,
      settled_rulings: 1,
      reopened_rulings: 0,
    });
    expect(packaged.package_path).toBe(path.join(fixture.root, ".weave", "tmp", "reviews", fixture.changeId, "_change", "f1.package.md"));
    expect(await git(fixture.root, ["rev-parse", "--verify", `refs/weave/reviews/${fixture.changeId}/_change/f1/end`])).toMatch(/^[0-9a-f]{40}$/);

    const text = await readFile(packaged.package_path, "utf8");
    const diff = text.slice(text.indexOf("## Diff\n"), text.indexOf("## Plan and docs edits"));
    const docs = text.slice(text.indexOf("## Plan and docs edits"), text.indexOf("## Context"));
    expect(diff.match(/diff --git a\/src\/alpha\/a\.ts/g)).toHaveLength(1);
    expect(diff.match(/diff --git a\/src\/beta\/b\.ts/g)).toHaveLength(1);
    expect(diff).not.toContain("wiki/decisions");
    expect(diff).not.toContain("wiki/knowledge");
    expect(docs).toContain("diff --git a/wiki/decisions/261110-abcd-use-refs.md");
    expect(docs).toContain("diff --git a/wiki/knowledge/review.md");
    expect(text).not.toMatch(/diff --git a\/wiki\/changes/);
    expect(text).toContain("`01-alpha/r1-F1` (slice `01-alpha`)");
    expect(text).toContain("`02-beta/r1-F1` (slice `02-beta`)");
    expect(text).toContain("`01-alpha/r1-F2`");
    expect(text).toContain("Cost if wrong: A crash on empty input.");
    expect(text).toContain("- 02-beta/T2: Task T2");
    expect(text).toContain("- 02-beta/T1: open the beta page");
    expect(text).toContain("Slice 01-alpha: `wiki/changes/");

    const status = await readYaml(path.join(fixture.changePath, "status.yml"));
    expect(status.review).toMatchObject({ state: "in_progress", latest_run: "f1", partial: false });
    expect(status.review.plan_basis).toHaveProperty(["task-slices/01-alpha/slice.md"]);
  });

  it("refuses with gate_failed while a slice blocks the gate, and records a partial run with --partial", async () => {
    await setupTwoSlices("ch02", { reviewBeta: false });
    const refused = await run(["package", "--change"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.result).toMatchObject({ status: "error", code: "gate_failed" });
    expect(refused.result.details.blocking).toEqual([{ slice: "02-beta", effective_state: "not_reviewed", reasons: ["not_reviewed"] }]);

    const partial = await ok(["package", "--change", "--partial"]);
    expect(partial.partial).toBe(true);
    expect(partial.partial_reasons[0]).toContain("the gate fails: 02-beta: not reviewed");
    expect(partial.gate.pass).toBe(false);
  });

  it("packages a flat change and refuses when review is skipped", async () => {
    const fixture = await setupRoot("ch03");
    await write(fixture.changePath, "tasks.md", tasksMarkdown([{ id: "T1", status: "done", files: ["src/alpha/"] }]));
    await write(fixture.root, "src/alpha/a.ts", "export const a = 5;\n");
    const packaged = await ok(["package", "--change"]);
    expect(packaged).toMatchObject({ run_id: "change/f1", partial: false, gate: { pass: true, flat: true } });
    const text = await readFile(packaged.package_path, "utf8");
    expect(text).toContain("(flat: no slices)");
    expect(text).toContain("diff --git a/src/alpha/a.ts");
    expect(text).toContain("- Tasks: `wiki/changes/");

    const statusPath = path.join(fixture.changePath, "status.yml");
    const status = await readYaml(statusPath);
    status.review = { ...status.review, skipped: { reason: "docs only", at: testNow.toISOString() } };
    await writeFile(statusPath, YAML.stringify(status));
    expect((await run(["package", "--change"])).result).toMatchObject({ status: "error", code: "change_review_skipped" });
  });
});

describe("weave review record on a change run", () => {
  it("validates the Minor sort, runs one fix batch at the change paths, and rejects a second round", async () => {
    const fixture = await setupTwoSlices("ch04", savedItems);
    await ok(["package", "--change"]);
    const reviewDir = path.join(fixture.changePath, "review");

    const unknown = await run(["record", "--run", "change/f1", "--report", "-"], report([finding("F1")], [["01-alpha/r1-F9", "must_fix"]]));
    expect(unknown.exitCode).toBe(4);
    expect(unknown.result).toMatchObject({ status: "error", code: "report_invalid" });
    const notMinor = await run(["record", "--run", "change/f1", "--report", "-"], report([finding("F1")], [["F1", "can_wait"]]));
    expect(notMinor.exitCode).toBe(4);
    expect(notMinor.result.details.errors[0]).toContain("is important, not Minor");
    await expect(readFile(path.join(reviewDir, "f1.report.md"), "utf8")).rejects.toThrow();

    const recorded = await ok(
      ["record", "--run", "change/f1", "--report", "-"],
      report([finding("F1", { location: { repo: "root", path: "src/beta/b.ts", line: 1 } })], [
        ["01/r1-F1", "must_fix"],
        ["02-beta/r1-F1", "can_wait"],
      ]),
    );
    expect(recorded).toMatchObject({ run: "change/f1", state: "in_progress", open: ["change/f1-F1", "01-alpha/r1-F1"] });
    expect(recorded.report_path).toBe(path.join(reviewDir, "f1.report.md"));
    const findings = JSON.parse(await readFile(path.join(reviewDir, "f1.findings.json"), "utf8")) as Record<string, any>;
    expect(findings.scope).toEqual({ kind: "change" });
    expect(findings.end_ref).toBe(`refs/weave/reviews/${fixture.changeId}/_change/f1/end`);
    expect(findings.findings.map((entry: any) => [entry.id, entry.final_sort ?? null, entry.resolution?.as ?? null])).toEqual([
      ["change/f1-F1", null, null],
      ["01-alpha/r1-F1", "must_fix", null],
      ["02-beta/r1-F1", "can_wait", "parked"],
    ]);
    // The slice's own findings file is not rewritten.
    const alphaFindings = JSON.parse(await readFile(path.join(fixture.changePath, "task-slices", "01-alpha", "review", "r1.findings.json"), "utf8")) as Record<string, any>;
    expect(alphaFindings.findings[0].final_sort).toBeUndefined();

    const started = await ok(["snapshot", "--run", "change/f1", "--at", "round-start", "--round", "1"]);
    expect(started.ref).toBe(`refs/weave/reviews/${fixture.changeId}/_change/f1/fix-start`);
    await write(fixture.root, "src/alpha/a.ts", "export const a = 3;\n");
    await write(fixture.root, "src/beta/b.ts", "export const b = 3;\n");
    const batch = await ok(["package", "--run", "change/f1", "--fix-round", "1"]);
    expect(batch.patch_path).toBe(path.join(reviewDir, "f1-fix.patch"));
    expect(batch.targets).toEqual(["change/f1-F1", "01-alpha/r1-F1"]);
    expect(batch.undo).toBe(`git apply -R wiki/changes/${fixture.changeId}/review/f1-fix.patch`);
    expect(await readFile(batch.patch_path, "utf8")).toContain("diff --git a/src/beta/b.ts b/src/beta/b.ts");
    expect(await git(fixture.root, ["rev-parse", "--verify", `refs/weave/reviews/${fixture.changeId}/_change/f1/fix-end`])).toMatch(/^[0-9a-f]{40}$/);

    const checked = await ok(["record", "--run", "change/f1", "--report", "-"], fixCheck([["change/f1-F1", "addressed"], ["01-alpha/r1-F1", "addressed"]]));
    expect(checked.check_path).toBe(path.join(reviewDir, "f1-fix.check.md"));

    const second = await run(["snapshot", "--run", "change/f1", "--at", "round-start", "--round", "2"]);
    expect(second.exitCode).toBe(1);
    expect(second.result).toMatchObject({ status: "error", code: "round_limit" });
    expect((await run(["package", "--run", "change/f1", "--fix-round", "2"])).result).toMatchObject({ code: "round_limit" });
  });

  it("sorts slice review rulings: must fix reopens one for the fix batch, can wait keeps one parked (FR12)", async () => {
    const fixture = await setupTwoSlices("ch13", {
      ...savedItems,
      beta: {
        findings: [
          finding("F1", { severity: "minor", location: { repo: "root", path: "src/beta/b.ts", line: 1 }, detail: "Beta comment." }),
          finding("F2", { location: { repo: "root", path: "src/beta/b.ts", line: 1 }, detail: "Beta retry." }),
        ],
        resolutions: [
          ["F1", ["--as", "parked"]],
          ["F2", ["--as", "ruling", "--agreed", "true", "--reason", "The fix needs slice 01.", "--cost", "A retry storm."]],
        ],
      },
    });
    await ok(["package", "--change"]);
    const reviewDir = path.join(fixture.changePath, "review");
    const betaFindingsPath = path.join(fixture.changePath, "task-slices", "02-beta", "review", "r1.findings.json");
    const betaBefore = await readFile(betaFindingsPath, "utf8");

    const recorded = await ok(
      ["record", "--run", "change/f1", "--report", "-"],
      report([], [
        ["01-alpha/r1-F1", "can_wait"],
        ["01-alpha/r1-F2", "can_wait"],
        ["02/r1-F1", "can_wait"],
        ["02-beta/r1-F2", "must_fix"],
      ]),
    );
    expect(recorded.open).toEqual(["02-beta/r1-F2"]);
    const findings = JSON.parse(await readFile(path.join(reviewDir, "f1.findings.json"), "utf8")) as Record<string, any>;
    expect(findings.findings.map((entry: any) => [entry.id, entry.final_sort ?? null, entry.resolution?.as ?? null, entry.source ?? null])).toEqual([
      ["01-alpha/r1-F1", "can_wait", "parked", "minor_sort"],
      ["02-beta/r1-F1", "can_wait", "parked", "minor_sort"],
      ["02-beta/r1-F2", "must_fix", null, "minor_sort"],
    ]);
    expect(findings.final_only.minor_sort).toContainEqual({ finding: "02-beta/r1-F1", class: "can_wait" });
    // The slice's own files are not rewritten.
    expect(await readFile(betaFindingsPath, "utf8")).toBe(betaBefore);

    // A reopened ruling is a target of the one fix batch.
    await ok(["snapshot", "--run", "change/f1", "--at", "round-start", "--round", "1"]);
    await write(fixture.root, "src/beta/b.ts", "export const b = 3;\n");
    const batch = await ok(["package", "--run", "change/f1", "--fix-round", "1"]);
    expect(batch.targets).toEqual(["02-beta/r1-F2"]);
    await ok(["record", "--run", "change/f1", "--report", "-"], fixCheck([["02-beta/r1-F2", "addressed"]]));
    await ok(["record", "--run", "change/f1", "--resolve", "02-beta/r1-F2", "--as", "fixed", "--round", "1"]);

    // Parked: two can-wait Minors, alpha's ruling, beta's human check, and the batch fix that
    // needs that check repeated. Beta's reopened ruling is fixed, so it is no longer a ruling.
    const finalized = await ok(["record", "--run", "change/f1", "--finalize"]);
    expect(finalized).toMatchObject({ verdict: "ready_with_parked_items", counts: { open_rulings: 1, parked_items: 5 } });
    const record = await readFile(path.join(fixture.changePath, "review.md"), "utf8");
    expect(record).toContain("- `01-alpha/r1-F2`: can wait (the slice review's ruling stays parked)");
    expect(record).toContain("- `02-beta/r1-F2`: must fix (from slice run `02-beta/r1`)");
    const all = record.slice(record.indexOf("## All rulings"));
    expect(all).toContain("  - Final review sort: can wait (`change/f1`)");
    expect(all).toContain("  - Final review sort: must fix, reopened in `change/f1` (now fixed in round 1)");
  });

  it("validates a ruling sort: a ruling must come from a slice review", async () => {
    await setupTwoSlices("ch14");
    await ok(["package", "--change"]);
    const own = await run(["record", "--run", "change/f1", "--report", "-"], report([finding("F1")], [["F1", "must_fix"]]));
    expect(own.exitCode).toBe(4);
    expect(own.result.details.errors[0]).toContain("only Minor findings and slice review rulings are sorted");
  });

  it("lists a dismissed plan problem as the person's ruling and counts it as a parked ruling (FR27)", async () => {
    const fixture = await setupTwoSlices("ch15", {
      beta: {
        findings: [finding("F1", { kind: "plan", location: { repo: "root", path: "src/beta/b.ts", line: 1 }, detail: "The PRD asks for two modes." })],
        resolutions: [["F1", ["--as", "dismissed", "--by", "alice"]]],
      },
    });
    await ok(["package", "--change"]);
    await ok(["record", "--run", "change/f1", "--report", "-"], report([]));
    const finalized = await ok(["record", "--run", "change/f1", "--finalize"]);
    expect(finalized).toMatchObject({ verdict: "ready_with_parked_items", counts: { open_rulings: 1, parked_items: 1, plan_problems_open: 0 } });

    const record = await readFile(path.join(fixture.changePath, "review.md"), "utf8");
    const all = record.slice(record.indexOf("## All rulings"));
    expect(all).toContain("- `02-beta/r1-F1` (important, plan, slice `02-beta`, the person's ruling): dismissed by alice");
    expect(all).toContain("  - Finding: The PRD asks for two modes.");
    expect(record).toContain("- Rulings: 1; parked items: 1; plan problems open: 0");
  });

  it("stops on a plan problem: the change is not ready, and only a person can resolve it", async () => {
    await setupTwoSlices("ch05");
    await ok(["package", "--change"]);
    const recorded = await ok(["record", "--run", "change/f1", "--report", "-"], report([finding("F1", { kind: "plan", fails: { type: "prd", ref: "FR9 built by no slice" } })]));
    expect(recorded).toMatchObject({ state: "not_ready", plan_findings_open: ["change/f1-F1"] });
    const refused = await run(["record", "--run", "change/f1", "--resolve", "F1", "--as", "ruling", "--agreed", "true", "--reason", "x", "--cost", "y"]);
    expect(refused.exitCode).toBe(5);
    expect(refused.result.code).toBe("plan_finding_requires_person");

    const finalized = await ok(["record", "--run", "change/f1", "--finalize"]);
    expect(finalized).toMatchObject({ verdict: "not_ready", counts: { plan_problems_open: 1 } });
  });
});

describe("weave review record --finalize on a change run", () => {
  it("gives ready with parked items, takes ownership of the covered files, writes review.md, and goes out of date on an edit", async () => {
    const fixture = await setupTwoSlices("ch06", savedItems);
    const alphaStatusPath = path.join(fixture.changePath, "task-slices", "01-alpha", "status.yml");
    expect(Object.keys((await readYaml(alphaStatusPath)).review.fingerprint.root)).toEqual(["src/alpha/a.ts"]);

    await ok(["package", "--change"]);
    await ok(
      ["record", "--run", "change/f1", "--report", "-"],
      report([finding("F1", { location: { repo: "root", path: "src/beta/b.ts", line: 1 } })], [
        ["01-alpha/r1-F1", "must_fix"],
        ["02-beta/r1-F1", "can_wait"],
      ]),
    );
    await ok(["snapshot", "--run", "change/f1", "--at", "round-start", "--round", "1"]);
    await write(fixture.root, "src/alpha/a.ts", "export const a = 3;\n");
    await write(fixture.root, "src/beta/b.ts", "export const b = 3;\n");
    await ok(["package", "--run", "change/f1", "--fix-round", "1"]);
    await ok(["record", "--run", "change/f1", "--report", "-"], fixCheck([["change/f1-F1", "addressed"], ["01-alpha/r1-F1", "addressed"]]));
    await ok(["record", "--run", "change/f1", "--resolve", "F1", "--as", "fixed", "--round", "1"]);
    await ok(["record", "--run", "change/f1", "--resolve", "01-alpha/r1-F1", "--as", "fixed", "--round", "1"]);

    const finalized = await ok(["record", "--run", "change/f1", "--finalize"]);
    // Parked: beta's can-wait Minor, alpha's ruling, beta's human check, and the two batch fixes
    // that need that check repeated.
    expect(finalized).toMatchObject({
      verdict: "ready_with_parked_items",
      partial: false,
      counts: { open_rulings: 1, parked_items: 5, plan_problems_open: 0 },
      fingerprint_files: 2,
      released_from: ["01-alpha", "02-beta"],
    });

    const status = await readYaml(path.join(fixture.changePath, "status.yml"));
    expect(status.review).toMatchObject({ state: "ready_with_parked_items", latest_run: "f1", reviewed_task_total: 3, partial: false });
    expect(Object.keys(status.review.fingerprint.root).sort()).toEqual(["src/alpha/a.ts", "src/beta/b.ts"]);
    expect((await readYaml(alphaStatusPath)).review.fingerprint).toEqual({});

    const record = await readFile(path.join(fixture.changePath, "review.md"), "utf8");
    expect(record).toContain("- Verdict: ready with parked items (5)");
    expect(record).toContain("## All rulings");
    expect(record).toContain("`01-alpha/r1-F2` (important, code, slice `01-alpha`, disagreed): The edge case cannot happen.");
    expect(record).toContain("  - Cost if wrong: A crash on empty input.");
    expect(record).toContain("- `01-alpha/r1-F1`: must fix (from slice run `01-alpha/r1`)");
    expect(record).toContain("| change/f1-F1 | important | code | root:src/beta/b.ts:1 | prd: FR1 | fixed in round 1 |");

    const current = await ok(["status", "--change"]);
    expect(current).toMatchObject({ effective_state: "ready_with_parked_items", out_of_date: false, out_of_date_reasons: [] });

    // An edit to a file the final review covered: the verdict is out of date; the slices are not.
    await write(fixture.root, "src/alpha/a.ts", "export const a = 4;\n");
    const stale = await ok(["status", "--change"]);
    expect(stale).toMatchObject({ effective_state: "ready_with_parked_items", out_of_date: true, out_of_date_reasons: ["code_changed"] });
    expect(await runText(["status", "--change"])).toContain("change: ready with parked items (5), verdict out of date (code changed)");
    expect(await ok(["gate", "--change"])).toMatchObject({ pass: true });

    await write(fixture.root, "src/alpha/a.ts", "export const a = 3;\n");
    expect(await ok(["status", "--change"])).toMatchObject({ out_of_date: false });

    // A new slice is a plan change and adds tasks.
    await writeSlice(fixture, "03-gamma", [{ id: "T1", status: "todo", files: ["src/gamma/"] }]);
    expect((await ok(["status", "--change"])).out_of_date_reasons).toEqual(["tasks_added", "plan_changed"]);
    await rm(path.join(fixture.changePath, "task-slices", "03-gamma"), { recursive: true });

    // The run is closed.
    expect((await run(["record", "--run", "change/f1", "--finalize"])).result).toMatchObject({ code: "run_closed" });
  });

  it("gives ready to merge when everything found was fixed", async () => {
    const fixture = await setupTwoSlices("ch07");
    await ok(["package", "--change"]);
    await ok(["record", "--run", "change/f1", "--report", "-"], report([finding("F1")]));
    await ok(["snapshot", "--run", "change/f1", "--at", "round-start", "--round", "1"]);
    await write(fixture.root, "src/alpha/a.ts", "export const a = 7;\n");
    await ok(["package", "--run", "change/f1", "--fix-round", "1"]);
    await ok(["record", "--run", "change/f1", "--report", "-"], fixCheck([["F1", "addressed"]]));
    await ok(["record", "--run", "change/f1", "--resolve", "change/f1-F1", "--as", "fixed", "--round", "1"]);
    const finalized = await ok(["record", "--run", "change/f1", "--finalize"]);
    expect(finalized).toMatchObject({ verdict: "ready_to_merge", counts: { open_rulings: 0, parked_items: 0, plan_problems_open: 0 } });
    expect(await readFile(path.join(fixture.changePath, "review.md"), "utf8")).toContain("- Verdict: ready to merge");

    // The fix batch is part of the baseline: the fixed file is current.
    expect(await ok(["status", "--change"])).toMatchObject({ effective_state: "ready_to_merge", out_of_date: false });
  });

  it("gives not ready for an agreed Critical ruling", async () => {
    await setupTwoSlices("ch08");
    await ok(["package", "--change"]);
    await ok(["record", "--run", "change/f1", "--report", "-"], report([finding("F1", { severity: "critical" })]));
    await ok(["record", "--run", "change/f1", "--resolve", "F1", "--as", "ruling", "--agreed", "true", "--reason", "Needs another slice.", "--cost", "Data loss."]);
    const finalized = await ok(["record", "--run", "change/f1", "--finalize"]);
    expect(finalized).toMatchObject({ verdict: "not_ready", counts: { open_rulings: 1 } });
  });

  it("gives not ready for a partial run, even with nothing found", async () => {
    await setupTwoSlices("ch09", { reviewBeta: false });
    await ok(["package", "--change", "--partial"]);
    await ok(["record", "--run", "change/f1", "--report", "-"], report([]));
    const finalized = await ok(["record", "--run", "change/f1", "--finalize"]);
    expect(finalized).toMatchObject({ verdict: "not_ready", partial: true });
  });

  it("refuses to finalize while the fix batch started but was never packaged", async () => {
    await setupTwoSlices("ch10");
    await ok(["package", "--change"]);
    await ok(["record", "--run", "change/f1", "--report", "-"], report([finding("F1")]));
    await ok(["snapshot", "--run", "change/f1", "--at", "round-start", "--round", "1"]);
    expect((await run(["record", "--run", "change/f1", "--finalize"])).result).toMatchObject({ status: "error", code: "round_not_ended" });
  });

  it("closes a failed change run, leaving the final review not started, and starts the next as f2", async () => {
    await setupTwoSlices("ch12");
    await ok(["package", "--change"]);
    expect(await ok(["record", "--run", "change/f1", "--failed"])).toMatchObject({ run: "change/f1", state: "review_failed" });
    expect(await ok(["status", "--change"])).toMatchObject({ stored_state: "not_started", review: { latest_run: "f1" } });
    expect((await run(["record", "--run", "change/f1", "--report", "-"], report([]))).result).toMatchObject({ code: "run_closed" });
    expect((await ok(["package", "--change"])).run_id).toBe("change/f2");
    expect((await run(["record", "--run", "change/f1", "--report", "-"], report([]))).result).toMatchObject({ code: "run_closed" });
  });

  it("runs the whole final review on a flat change", async () => {
    const fixture = await setupRoot("ch11");
    await write(fixture.changePath, "tasks.md", tasksMarkdown([{ id: "T1", status: "done", files: ["src/alpha/"] }]));
    await write(fixture.root, "src/alpha/a.ts", "export const a = 5;\n");
    expect(await runText(["package", "--change"])).toMatch(/^change\/f1: .*f1\.package\.md\n  1 files \(0 plan and docs edits\), 2 changed lines; 0 saved Minors to sort; model level most_capable\n$/);
    await ok(["record", "--run", "change/f1", "--report", "-"], report([finding("F1", { severity: "minor" })]));
    await ok(["record", "--run", "change/f1", "--resolve", "F1", "--as", "parked"]);
    const finalized = await ok(["record", "--run", "change/f1", "--finalize"]);
    expect(finalized).toMatchObject({ verdict: "ready_with_parked_items", counts: { parked_items: 1 }, reviewed_task_total: 1 });

    await write(fixture.root, "src/alpha/a.ts", "export const a = 6;\n");
    expect((await ok(["status", "--change"])).out_of_date_reasons).toEqual(["code_changed"]);
  });
});
