import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { newDecision, setDecisionStatus } from "../src/lib/decisions.js";
import {
  absentHash,
  classifyRulings,
  computeFingerprint,
  computePlanBasis,
  computeRulingBasis,
  currentRulingBasis,
  evaluateOutOfDate,
  outOfDateReasons,
  planDecisionIds,
  rulingBasisChanges,
  rulingReopened,
  shortDecisionId,
  type RulingBasis,
} from "../src/lib/review/fingerprint.js";
import { bodyHash, effectiveState } from "../src/lib/review/rules.js";
import type { ReviewContext } from "../src/lib/review/state.js";

const execFileAsync = promisify(execFile);
const prdText = "---\nartifact: prd\nupdated_at: one\n---\n\n# PRD\n\nBody.\n";
const originalSessionEnv = process.env.WEAVE_SESSION_PATH;
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Weave Test",
  GIT_AUTHOR_EMAIL: "weave@example.com",
  GIT_COMMITTER_NAME: "Weave Test",
  GIT_COMMITTER_EMAIL: "weave@example.com",
};

afterEach(() => {
  if (originalSessionEnv === undefined) delete process.env.WEAVE_SESSION_PATH;
  else process.env.WEAVE_SESSION_PATH = originalSessionEnv;
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv });
  return stdout.trim();
}

async function write(root: string, file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
}

// A Weave root (repo mode) holding one change with a PRD, architecture, and a slice.
async function fixture(): Promise<{ root: string; changePath: string }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-review-fingerprint-")));
  process.env.WEAVE_SESSION_PATH = path.join(root, ".session.yml");
  await write(root, ".weave/workspace.yml", YAML.stringify({ version: 1, mode: "repo", name: "fixture", repos: {} }));
  await write(root, "src/a.ts", "export const a = 1;\n");
  await write(root, "src/b.ts", "export const b = 1;\n");
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "initial"]);
  const changePath = path.join(root, "wiki", "changes", "261110-abcd-thing");
  await write(changePath, "status.yml", YAML.stringify({ id: "261110-abcd-thing", type: "feat" }));
  await write(changePath, "prd.md", prdText);
  await write(changePath, "architecture/index.md", "# Architecture\n");
  await write(changePath, "architecture/schema.md", "# Schema\n");
  await write(changePath, "task-slices/02-work/slice.md", "# Slice\n");
  return { root, changePath };
}

describe("computeFingerprint", () => {
  it("hashes owned files with git blob hashes and records absent for deleted ones", async () => {
    const { root } = await fixture();
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 2;\n");
    await rm(path.join(root, "src", "b.ts"));

    const fingerprint = await computeFingerprint(
      [{ id: "root", path: root }, { id: "api" }],
      { root: ["src/b.ts", "src/a.ts"], api: ["server.ts"] },
    );
    expect(fingerprint).toEqual({
      root: { "src/a.ts": await git(root, ["hash-object", "src/a.ts"]), "src/b.ts": absentHash },
    });
  });
});

describe("computePlanBasis", () => {
  it("hashes planning document bodies, ignores frontmatter-only edits, and changes on a body edit", async () => {
    const { root, changePath } = await fixture();
    const decision = await newDecision({ cwd: root, title: "Use snapshots", randomId: () => "wdfo", now: new Date(2026, 10, 10), sessionPath: process.env.WEAVE_SESSION_PATH });
    const id = shortDecisionId(decision.decision.id);

    const basis = await computePlanBasis(changePath, "02-work", [id, "261101-none"], { weaveRoot: root });
    expect(Object.keys(basis).sort()).toEqual(["architecture/index.md", "architecture/schema.md", "decisions", "prd.md", "task-slices/02-work/slice.md"]);
    expect(basis["prd.md"]).toBe(bodyHash(prdText));
    expect(basis.decisions[id]).toMatch(/^sha256:/);
    expect(basis.decisions["261101-none"]).toBe(absentHash);

    await writeFile(path.join(changePath, "prd.md"), "---\nartifact: prd\nupdated_at: two\nstatus: final\n---\n\n# PRD\n\nBody.\n");
    expect(await computePlanBasis(changePath, "02-work", [id, "261101-none"], { weaveRoot: root })).toEqual(basis);

    await writeFile(path.join(changePath, "prd.md"), "---\nartifact: prd\n---\n\n# PRD\n\nBody changed.\n");
    expect((await computePlanBasis(changePath, "02-work", [id, "261101-none"], { weaveRoot: root }))["prd.md"]).not.toBe(basis["prd.md"]);
  });

  it("includes the slice contracts when present and the findings file for a fix", async () => {
    const { root, changePath } = await fixture();
    await write(changePath, "status.yml", YAML.stringify({ id: "261110-abcd-thing", type: "fix" }));
    await write(changePath, "task-slices/02-work/contracts.md", "# Contracts\n");
    const basis = await computePlanBasis(changePath, "02-work", [], { weaveRoot: root });
    expect(basis["findings.md"]).toBe(absentHash);
    expect(basis["task-slices/02-work/contracts.md"]).toBe(bodyHash("# Contracts\n"));
    expect(basis["prd.md"]).toBeUndefined();
  });
});

describe("planDecisionIds", () => {
  it("takes accepted decisions applying to the diffed files plus decisions a finding cites", async () => {
    const { root } = await fixture();
    const session = process.env.WEAVE_SESSION_PATH;
    const applying = await newDecision({ cwd: root, title: "Applies", randomId: () => "aaaa", appliesTo: ["src/a.ts"], sessionPath: session });
    const cited = await newDecision({ cwd: root, title: "Cited", randomId: () => "bbbb", appliesTo: ["docs/"], sessionPath: session });
    await newDecision({ cwd: root, title: "Unrelated", randomId: () => "cccc", appliesTo: ["docs/"], sessionPath: session });
    // New decisions start proposed; only accepted ones apply by path.
    for (const decision of [applying, cited]) {
      const file = path.join(root, decision.decision.path);
      const text = await (await import("node:fs/promises")).readFile(file, "utf8");
      await writeFile(file, text.replace(/^status: proposed$/m, "status: accepted"));
    }

    const ids = await planDecisionIds(root, ["src/a.ts"], [
      { id: "x", location: { repo: "root", path: "src/a.ts" }, fails: { type: "decision", ref: `${shortDecisionId(cited.decision.id)} says so` } },
    ]);
    expect(ids).toEqual([shortDecisionId(applying.decision.id), shortDecisionId(cited.decision.id)].sort());
  });
});

describe("computeRulingBasis", () => {
  it("hashes the finding's file, the guideline files, and the cited or fallback documents", async () => {
    const { root, changePath } = await fixture();
    await write(root, ".weave/coding-guidelines.md", "---\nscope: shared\n---\n# Rules\n");
    const guidelines = [{ scope: "shared" as const, path: ".weave/coding-guidelines.md", status: "present" as const }];
    const repos = [{ id: "root", path: root }];
    const finding = (type: string, ref: string, file = "src/a.ts") => ({ id: "02-work/r1-F1", location: { repo: "root", path: file }, fails: { type, ref } });

    const prd = await computeRulingBasis(finding("prd", "FR3"), guidelines, changePath, { repos, sliceId: "02-work", weaveRoot: root });
    expect(prd).toEqual({
      code: { "root:src/a.ts": await git(root, ["hash-object", "src/a.ts"]) },
      guidelines: { ".weave/coding-guidelines.md": bodyHash("# Rules\n") },
      documents: { "prd.md": bodyHash(prdText) },
      decisions: {},
    });

    const cited = await computeRulingBasis(finding("architecture", "architecture/schema.md#refs"), guidelines, changePath, { repos, weaveRoot: root });
    expect(Object.keys(cited.documents)).toEqual(["architecture/schema.md"]);
    const viaRoot = await computeRulingBasis(finding("architecture", "wiki/changes/261110-abcd-thing/architecture/schema.md"), guidelines, changePath, { repos, weaveRoot: root });
    expect(Object.keys(viaRoot.documents)).toEqual(["architecture/schema.md"]);
    const escaping = await computeRulingBasis(finding("architecture", "../../../../etc/passwd.md"), guidelines, changePath, { repos, weaveRoot: root });
    expect(Object.keys(escaping.documents)).toEqual(["architecture/index.md"]);
    const acceptance = await computeRulingBasis(finding("acceptance", "T1"), guidelines, changePath, { repos, sliceId: "02-work", weaveRoot: root });
    expect(Object.keys(acceptance.documents)).toEqual(["task-slices/02-work/slice.md"]);

    const deleted = await computeRulingBasis(finding("correctness", "", "src/gone.ts"), [], changePath, { repos, weaveRoot: root });
    expect(deleted).toEqual({ code: { "root:src/gone.ts": absentHash }, guidelines: {}, documents: {}, decisions: {} });
  });
});

// --- out of date ------------------------------------------------------------------------------

const changeId = "261110-abcd-thing";

function tasksMd(ids: string[], status = "done"): string {
  const lines = ["# Tasks", "", "## Active Task Index", "", "| ID | Status | Execution | Repos | Owner | Title | Blocked by |", "| --- | --- | --- | --- | --- | --- | --- |"];
  lines.push(...ids.map((id) => `| ${id} | ${status} | afk | root | | Task ${id} | None |`), "");
  for (const id of ids) lines.push(`### ${id}: Task ${id}`, "", `Status: ${status}`, "Repos: root", "Files:", "- `src/a.ts` (M)", "");
  return lines.join("\n");
}

// The fixture with slice 02-work reviewed: `src/a.ts` fingerprinted, two tasks, and the plan basis
// (including one accepted decision) as it is now.
async function reviewedFixture(state = "reviewed"): Promise<{ root: string; changePath: string; ctx: ReviewContext; decisionFile: string; decisionId: string; statusPath: string }> {
  const { root, changePath } = await fixture();
  const ctx: ReviewContext = { weaveRoot: root, changeId, changePath };
  const decision = await newDecision({ cwd: root, title: "Use snapshots", randomId: () => "wdfo", sessionPath: process.env.WEAVE_SESSION_PATH });
  const decisionFile = path.join(root, decision.decision.path);
  await writeFile(decisionFile, (await readFile(decisionFile, "utf8")).replace(/^status: proposed$/m, "status: accepted"));
  const decisionId = shortDecisionId(decision.decision.id);
  const slicePath = path.join(changePath, "task-slices", "02-work");
  await write(slicePath, "tasks.md", tasksMd(["T1", "T2"]));
  const statusPath = path.join(slicePath, "status.yml");
  await write(
    slicePath,
    "status.yml",
    YAML.stringify({
      version: 1,
      id: "02-work",
      repos: ["root"],
      review: {
        state,
        latest_run: "r1",
        reviewed_task_total: 2,
        plan_basis: await computePlanBasis(changePath, "02-work", [decisionId], { weaveRoot: root }),
        fingerprint: await computeFingerprint([{ id: "root", path: root }], { root: ["src/a.ts"] }),
      },
    }),
  );
  return { root, changePath, ctx, decisionFile, decisionId, statusPath };
}

describe("outOfDateReasons", () => {
  it("gives no reason while nothing changed, and code_changed only for an edit inside the reviewed set", async () => {
    const { root, ctx, statusPath } = await reviewedFixture();
    const before = await readFile(statusPath, "utf8");
    expect(await outOfDateReasons(ctx, "02")).toEqual([]);

    await writeFile(path.join(root, "src", "b.ts"), "export const b = 2;\n");
    expect(await outOfDateReasons(ctx, "02")).toEqual([]);

    await writeFile(path.join(root, "src", "a.ts"), "export const a = 2;\n");
    expect(await outOfDateReasons(ctx, "02")).toEqual(["code_changed"]);
    await rm(path.join(root, "src", "a.ts"));
    expect(await outOfDateReasons(ctx, "02")).toEqual(["code_changed"]);

    // Reverting returns the slice to current; reading never wrote anything.
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    expect(await outOfDateReasons(ctx, "02")).toEqual([]);
    expect(await readFile(statusPath, "utf8")).toBe(before);
  });

  it("gives tasks_added when the active task count rises, but not for an invalid task", async () => {
    const { changePath, ctx } = await reviewedFixture();
    const tasksPath = path.join(changePath, "task-slices", "02-work", "tasks.md");
    await writeFile(tasksPath, tasksMd(["T1", "T2"]).replace("| T2 | done |", "| T2 | invalid |") + "\n### T3: Task T3\n\nStatus: done\n");
    expect(await outOfDateReasons(ctx, "02")).toEqual([]);
    await writeFile(tasksPath, tasksMd(["T1", "T2", "T3"], "todo"));
    expect(await outOfDateReasons(ctx, "02")).toEqual(["tasks_added"]);
  });

  it("gives plan_changed for a body edit to the PRD, an architecture file, slice.md, or a cited decision, and not for frontmatter-only edits", async () => {
    const { changePath, ctx, decisionFile } = await reviewedFixture();
    const edits: Array<[string, (text: string) => string]> = [
      [path.join(changePath, "prd.md"), (text) => text.replace("Body.", "Body changed.")],
      [path.join(changePath, "architecture", "schema.md"), (text) => `${text}More.\n`],
      [path.join(changePath, "task-slices", "02-work", "slice.md"), (text) => `${text}Another criterion.\n`],
      [decisionFile, (text) => `${text}\nA new consequence.\n`],
    ];
    for (const [file, edit] of edits) {
      const original = await readFile(file, "utf8");
      await writeFile(file, edit(original));
      expect(await outOfDateReasons(ctx, "02"), file).toEqual(["plan_changed"]);
      await writeFile(file, original);
      expect(await outOfDateReasons(ctx, "02"), file).toEqual([]);
    }

    // Frontmatter-only edits, including a decision's status, change nothing.
    await writeFile(path.join(changePath, "prd.md"), prdText.replace("updated_at: one", "updated_at: two\nstatus: final"));
    const accepted = await readFile(decisionFile, "utf8");
    await writeFile(decisionFile, accepted.replace(/^status: accepted$/m, "status: superseded"));
    expect(await outOfDateReasons(ctx, "02")).toEqual([]);

    // Superseding the decision (`weave adr new --supersedes` sets `superseded_by`) is a plan change.
    await writeFile(decisionFile, accepted.replace(/^status: accepted$/m, "status: superseded").replace(/^superseded_by: null$/m, "superseded_by: 261110-zzzz-new-way"));
    expect(await outOfDateReasons(ctx, "02")).toEqual(["plan_changed"]);
    await writeFile(decisionFile, accepted);
    expect(await outOfDateReasons(ctx, "02")).toEqual([]);

    // A new architecture facet is a plan change too.
    await write(changePath, "architecture/api.md", "# API\n");
    expect(await outOfDateReasons(ctx, "02")).toEqual(["plan_changed"]);
  });

  it("gives plan_changed once a decision superseding a cited one is accepted, which sets its superseded_by", async () => {
    const { root, ctx, decisionId } = await reviewedFixture();
    expect(await outOfDateReasons(ctx, "02")).toEqual([]);
    const replacement = await newDecision({ cwd: root, title: "Use commits instead", randomId: () => "zzzz", supersedes: [decisionId], sessionPath: process.env.WEAVE_SESSION_PATH });
    // A proposed replacement leaves the cited decision untouched.
    expect(await outOfDateReasons(ctx, "02")).toEqual([]);
    await setDecisionStatus({ cwd: root, decision: replacement.decision.id, status: "accepted", sessionPath: process.env.WEAVE_SESSION_PATH });
    expect(await outOfDateReasons(ctx, "02")).toEqual(["plan_changed"]);
  });

  it("combines reasons", async () => {
    const { root, changePath, ctx } = await reviewedFixture("reviewed_with_rulings");
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 3;\n");
    await writeFile(path.join(changePath, "task-slices", "02-work", "tasks.md"), tasksMd(["T1", "T2", "T3"]));
    await writeFile(path.join(changePath, "prd.md"), prdText.replace("Body.", "New body."));
    expect(await outOfDateReasons(ctx, "02")).toEqual(["code_changed", "tasks_added", "plan_changed"]);
  });

  it("checks only plan_changed for a waiting slice, which then reads not_reviewed", async () => {
    const { root, changePath, ctx } = await reviewedFixture("waiting_on_person");
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 3;\n");
    await writeFile(path.join(changePath, "task-slices", "02-work", "tasks.md"), tasksMd(["T1", "T2", "T3"]));
    expect(await outOfDateReasons(ctx, "02")).toEqual([]);
    await writeFile(path.join(changePath, "prd.md"), prdText.replace("Body.", "New body."));
    const reasons = await outOfDateReasons(ctx, "02");
    expect(reasons).toEqual(["plan_changed"]);
    expect(effectiveState({ state: "waiting_on_person" }, { readyForReview: true, outOfDateReasons: reasons })).toEqual({
      state: "not_reviewed",
      outOfDate: false,
      reasons: ["plan_changed"],
    });
  });

  it("gives no reason for other states", async () => {
    for (const state of ["in_review", "skipped", "review_failed", "predates_review"]) {
      const { root, ctx } = await reviewedFixture(state);
      await writeFile(path.join(root, "src", "a.ts"), "export const a = 3;\n");
      expect(await outOfDateReasons(ctx, "02"), state).toEqual([]);
    }
  });

  it("adds a repo_missing warning, and no reason, for a fingerprinted repo that is not checked out", async () => {
    const { root, changePath, ctx, statusPath } = await reviewedFixture();
    const status = YAML.parse(await readFile(statusPath, "utf8")) as { review: Record<string, any> };
    status.review.fingerprint.api = { "server.ts": "0000000000000000000000000000000000000000" };
    await writeFile(statusPath, YAML.stringify(status));
    const slice = { id: "02-work", path: path.join(changePath, "task-slices", "02-work"), statusPath, tasksPath: path.join(changePath, "task-slices", "02-work", "tasks.md") };
    expect(await evaluateOutOfDate(ctx, slice)).toEqual({ reasons: [], warnings: ["repo_missing:api"] });
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 3;\n");
    expect(await evaluateOutOfDate(ctx, slice)).toEqual({ reasons: ["code_changed"], warnings: ["repo_missing:api"] });
  });
});

// --- rulings ----------------------------------------------------------------------------------

describe("rulingReopened and classifyRulings", () => {
  async function rulingFixture(): Promise<{ root: string; changePath: string; ctx: ReviewContext; decisionFile: string; basis: RulingBasis }> {
    const { root, changePath, ctx, decisionFile, decisionId } = await reviewedFixture();
    await write(root, ".weave/coding-guidelines.md", "---\nscope: shared\n---\n# Rules\n");
    const guidelines = [{ scope: "shared" as const, path: ".weave/coding-guidelines.md", status: "present" as const }];
    const repos = [{ id: "root", path: root }];
    const prdBasis = await computeRulingBasis({ id: "x", location: { repo: "root", path: "src/a.ts" }, fails: { type: "prd", ref: "FR1" } }, guidelines, changePath, { repos, weaveRoot: root });
    const decisionBasis = await computeRulingBasis({ id: "y", location: { repo: "root", path: "src/a.ts" }, fails: { type: "decision", ref: decisionId } }, [], changePath, { repos, weaveRoot: root });
    return { root, changePath, ctx, decisionFile, basis: { ...prdBasis, decisions: decisionBasis.decisions } };
  }

  it("reopens on a code, guideline, document, or decision change, and not on frontmatter-only edits", async () => {
    const { root, changePath, ctx, decisionFile, basis } = await rulingFixture();
    expect(Object.keys(basis.decisions)).toHaveLength(1);
    expect(rulingReopened(basis, await currentRulingBasis(ctx, basis))).toBe(false);

    const edits: Array<[string, (text: string) => string]> = [
      [path.join(root, "src", "a.ts"), () => "export const a = 9;\n"],
      [path.join(root, ".weave", "coding-guidelines.md"), (text) => `${text}- New rule.\n`],
      [path.join(changePath, "prd.md"), (text) => text.replace("Body.", "Body changed.")],
      [decisionFile, (text) => `${text}\nChanged.\n`],
    ];
    for (const [file, edit] of edits) {
      const original = await readFile(file, "utf8");
      await writeFile(file, edit(original));
      expect(rulingReopened(basis, await currentRulingBasis(ctx, basis)), file).toBe(true);
      await writeFile(file, original);
    }

    await writeFile(path.join(root, ".weave", "coding-guidelines.md"), "---\nscope: shared\nupdated: yes\n---\n# Rules\n");
    await writeFile(path.join(changePath, "prd.md"), prdText.replace("updated_at: one", "updated_at: three"));
    const accepted = await readFile(decisionFile, "utf8");
    await writeFile(decisionFile, accepted.replace(/^status: accepted$/m, "status: superseded"));
    expect(rulingReopened(basis, await currentRulingBasis(ctx, basis))).toBe(false);

    // Superseding the cited decision reopens the ruling.
    await writeFile(decisionFile, accepted.replace(/^superseded_by: null$/m, "superseded_by: 261110-zzzz-new-way"));
    expect(rulingBasisChanges(basis, await currentRulingBasis(ctx, basis))).toEqual([`decision ${Object.keys(basis.decisions)[0]}`]);
  });

  it("never reopens a ruling for a code entry whose repo is not checked out", async () => {
    const { ctx, basis } = await rulingFixture();
    const withMissing: RulingBasis = { ...basis, code: { ...basis.code, "api:server.ts": "deadbeef" } };
    const warnings: string[] = [];
    expect(rulingReopened(withMissing, await currentRulingBasis(ctx, withMissing, { warnings }))).toBe(false);
    expect(warnings).toEqual(["repo_missing:api"]);
  });

  it("splits the slice's rulings, and other slices' rulings on the package's files, into settled and reopened", async () => {
    const { root, changePath, ctx, basis } = await rulingFixture();
    const ruling = (id: string, file: string, recorded: RulingBasis) => ({
      id,
      severity: "minor",
      kind: "code",
      location: { repo: "root", path: file, line: 1 },
      fails: { type: "prd", ref: "FR1" },
      detail: `Detail ${id}.`,
      foreign_file: false,
      resolution: { as: "ruling", agreed: false, reason: "Fine as is.", cost_if_wrong: "Low.", basis: recorded },
    });
    const bBasis = { ...basis, code: { "root:src/b.ts": await git(root, ["hash-object", "src/b.ts"]) } };
    await write(changePath, "task-slices/02-work/review/r1.findings.json", JSON.stringify({ run: "02-work/r1", findings: [ruling("02-work/r1-F1", "src/a.ts", basis), { ...ruling("02-work/r1-F2", "src/a.ts", basis), resolution: { as: "parked" } }] }));
    await write(changePath, "task-slices/03-more/status.yml", YAML.stringify({ id: "03-more", repos: ["root"] }));
    await write(changePath, "task-slices/03-more/review/r1.findings.json", JSON.stringify({ run: "03-more/r1", findings: [ruling("03-more/r1-F1", "src/b.ts", bBasis)] }));

    let classified = await classifyRulings(ctx, { kind: "slice", slice: "02-work" });
    expect(classified.settled.map((entry) => entry.finding)).toEqual(["02-work/r1-F1"]);
    expect(classified.reopened).toEqual([]);

    await writeFile(path.join(root, "src", "a.ts"), "export const a = 5;\n");
    classified = await classifyRulings(ctx, { kind: "slice", slice: "02-work", files: [{ repo: "root", path: "src/b.ts" }] });
    expect(classified.settled.map((entry) => entry.finding)).toEqual(["03-more/r1-F1"]);
    expect(classified.reopened.map((entry) => ({ finding: entry.finding, changed: entry.changed }))).toEqual([{ finding: "02-work/r1-F1", changed: ["code root:src/a.ts"] }]);

    const change = await classifyRulings(ctx, { kind: "change" });
    expect([...change.settled, ...change.reopened].map((entry) => entry.finding).sort()).toEqual(["02-work/r1-F1", "03-more/r1-F1"]);
  });
});
