import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewCommand } from "../src/commands/review.js";
import { reportInput } from "../src/commands/review/record.js";
import { createChange } from "../src/lib/changes.js";
import { rollupChange } from "../src/lib/sliceRollup.js";

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

function tasksMarkdown(status: string, files: string[], ids = ["T1"]): string {
  const lines = [
    "# Tasks",
    "",
    "## Active Task Index",
    "",
    "| ID | Status | Execution | Repos | Owner | Title | Blocked by |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...ids.map((id) => `| ${id} | ${status} | afk | root | | Task ${id} | None |`),
    "",
  ];
  for (const id of ids) {
    lines.push(`### ${id}: Task ${id}`, "", `Status: ${status}`, "Repos: root", "Files:", ...files.map((file) => `- \`${file}\` (M)`), "");
    lines.push("### Verification", "", "- Automated tests: passed", "");
  }
  return lines.join("\n");
}

interface Fixture {
  root: string;
  changePath: string;
  changeId: string;
}

// A repo-mode Weave root with review installed, on the change branch, holding a PRD and an
// architecture file. Slices are added with `addSlice`.
async function setup(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-review-out-of-date-")));
  await write(root, ".weave/workspace.yml", YAML.stringify({ version: 1, mode: "repo", name: "fixture", repos: {} }));
  await write(
    root,
    ".weave/agents.yml",
    YAML.stringify({ version: 1, installed: { claude: { skills: { "weave-review": { path: ".claude/skills/weave-review/SKILL.md" } } } } }),
  );
  await write(root, "README.md", "initial\n");
  await write(root, "src/owned/a.ts", "export const a = 1;\n");
  await write(root, "src/shared.ts", "export const shared = 1;\n");
  await write(root, "src/more/c.ts", "export const c = 1;\n");
  await write(root, "src/other/b.ts", "export const b = 1;\n");
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "initial"]);
  const session = path.join(root, ".session.yml");
  const created = await createChange({ cwd: root, title: "Out of date", now: testNow, randomId: () => "od07", sessionPath: session });
  const changePath = path.join(root, "wiki", "changes", created.id);
  await write(changePath, "prd.md", "---\nartifact: prd\n---\n\n# PRD\n\nFR1.\n");
  await write(changePath, "architecture/index.md", "# Architecture\n");
  if ((await git(root, ["branch", "--show-current"])) === "main") {
    await git(root, ["checkout", "-q", "-b", `change/${created.id}`]);
  }
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "scaffold"]);
  process.env.WEAVE_SESSION_PATH = session;
  process.chdir(root);
  return { root, changePath, changeId: created.id };
}

// Adds a slice whose tasks are in progress and takes its start snapshot.
async function addSlice(fixture: Fixture, id: string, files: string[]): Promise<string> {
  const slicePath = path.join(fixture.changePath, "task-slices", id);
  await write(
    slicePath,
    "status.yml",
    YAML.stringify({ version: 1, id, title: id, status: "in_progress", owner: "", repos: ["root"], depends_on: [], task_summary: { total: 1, done: 0, blocked: 0 } }),
  );
  await write(slicePath, "slice.md", `# ${id}\n\nAcceptance.\n`);
  await write(slicePath, "tasks.md", tasksMarkdown("in_progress", files));
  expect((await run(["snapshot", "--slice", id, "--at", "start"])).exitCode).toBeUndefined();
  return slicePath;
}

async function finishTasks(slicePath: string, files: string[]): Promise<void> {
  await writeFile(path.join(slicePath, "tasks.md"), tasksMarkdown("done", files));
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

function finding(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    severity: "important",
    kind: "code",
    location: { repo: "root", path: "src/owned/a.ts", line: 1 },
    fails: { type: "correctness", ref: "" },
    detail: `Problem ${id}.`,
    fix_hint: "Fix it.",
    ...extra,
  };
}

function report(findings: Array<Record<string, unknown>>): string {
  return `Reviewed.\n\n\`\`\`json\n${JSON.stringify({ strengths: ["Clear"], findings, declined: [], verdict: findings.length > 0 ? "with_fixes" : "ready" })}\n\`\`\`\n`;
}

// Packages the slice, records a clean report, and finalizes the run.
async function reviewClean(slice: string): Promise<Record<string, any>> {
  const packaged = await run(["package", "--slice", slice]);
  expect(packaged.exitCode).toBeUndefined();
  const runId = packaged.result.run_id as string;
  expect((await run(["record", "--run", runId, "--report", "-"], report([]))).exitCode).toBeUndefined();
  const finalized = await run(["record", "--run", runId, "--finalize"]);
  expect(finalized.exitCode).toBeUndefined();
  return finalized.result;
}

async function status(slice: string): Promise<Record<string, any>> {
  const { result, exitCode } = await run(["status", "--slice", slice]);
  expect(exitCode).toBeUndefined();
  return result;
}

async function sliceReview(fixture: Fixture, id: string): Promise<Record<string, any>> {
  return (YAML.parse(await readFile(path.join(fixture.changePath, "task-slices", id, "status.yml"), "utf8")) as { review: Record<string, any> }).review;
}

async function statusBytes(fixture: Fixture, ids: string[]): Promise<string[]> {
  return Promise.all([path.join(fixture.changePath, "status.yml"), ...ids.map((id) => path.join(fixture.changePath, "task-slices", id, "status.yml"))].map((file) => readFile(file, "utf8")));
}

function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const next = text.slice(start + heading.length).search(/\n#{2,3} /);
  return next === -1 ? text.slice(start) : text.slice(start, start + heading.length + next);
}

describe("out-of-date reviews", () => {
  it("marks a reviewed slice out of date for an edit inside the reviewed set only, returns to current on revert, and never writes", async () => {
    const fixture = await setup();
    const slicePath = await addSlice(fixture, "02-work", ["src/owned/"]);
    await writeFile(path.join(fixture.root, "src/owned/a.ts"), "export const a = 2;\n");
    await finishTasks(slicePath, ["src/owned/"]);
    expect(await reviewClean("02")).toMatchObject({ state: "reviewed", released_from: [], from_main: {} });
    await rollupChange({ changePath: fixture.changePath });
    const rollupCheck = async (): Promise<void> => {
      const check = await rollupChange({ changePath: fixture.changePath, check: true });
      expect(check.status).toBe("ok");
      expect(check.slices.every((slice) => !slice.changed)).toBe(true);
    };
    await rollupCheck();
    const before = await statusBytes(fixture, ["02-work"]);

    expect(await status("02")).toMatchObject({ stored_state: "reviewed", effective_state: "reviewed", out_of_date: false, out_of_date_reasons: [], warnings: [] });

    // An edit outside the reviewed set changes nothing.
    await writeFile(path.join(fixture.root, "src/other/b.ts"), "export const b = 2;\n");
    expect(await status("02")).toMatchObject({ effective_state: "reviewed", out_of_date_reasons: [] });

    // An edit inside it marks the slice out of date; the stored state is kept.
    await writeFile(path.join(fixture.root, "src/owned/a.ts"), "export const a = 3;\n");
    expect(await status("02")).toMatchObject({
      stored_state: "reviewed",
      effective_state: "out_of_date",
      out_of_date: true,
      out_of_date_reasons: ["code_changed"],
    });
    await rollupCheck();

    // A new active task adds tasks_added.
    await writeFile(path.join(slicePath, "tasks.md"), tasksMarkdown("done", ["src/owned/"], ["T1", "T2"]));
    expect((await status("02")).out_of_date_reasons).toEqual(["code_changed", "tasks_added"]);
    await finishTasks(slicePath, ["src/owned/"]);

    // Reverting returns the slice to current.
    await writeFile(path.join(fixture.root, "src/owned/a.ts"), "export const a = 2;\n");
    expect(await status("02")).toMatchObject({ effective_state: "reviewed", out_of_date: false, out_of_date_reasons: [] });
    await rollupCheck();
    expect(await statusBytes(fixture, ["02-work"])).toEqual(before);

    // The text view reads "reviewed, out of date (...)".
    await writeFile(path.join(fixture.root, "src/owned/a.ts"), "export const a = 4;\n");
    const all = await run(["status"]);
    expect(all.result.slices[0]).toMatchObject({ slice: "02-work", effective_state: "out_of_date" });
  });

  it("marks every reviewed slice plan_changed for a PRD body edit, and not for a frontmatter-only edit", async () => {
    const fixture = await setup();
    const slicePath = await addSlice(fixture, "02-work", ["src/owned/"]);
    await writeFile(path.join(fixture.root, "src/owned/a.ts"), "export const a = 2;\n");
    await finishTasks(slicePath, ["src/owned/"]);
    await reviewClean("02");

    const prd = path.join(fixture.changePath, "prd.md");
    const original = await readFile(prd, "utf8");
    await writeFile(prd, original.replace("artifact: prd", "artifact: prd\nupdated_at: later"));
    expect((await status("02")).out_of_date_reasons).toEqual([]);
    await writeFile(prd, original.replace("FR1.", "FR1, changed."));
    expect(await status("02")).toMatchObject({ effective_state: "out_of_date", out_of_date_reasons: ["plan_changed"] });
    await writeFile(path.join(slicePath, "slice.md"), "# 02-work\n\nAcceptance.\n");
    await writeFile(prd, original);
    expect((await status("02")).out_of_date_reasons).toEqual([]);
  });

  it("hands a shared file to the latest review, so an edit to it marks only that slice out of date", async () => {
    const fixture = await setup();
    const slice02 = await addSlice(fixture, "02-work", ["src/owned/", "src/shared.ts"]);
    await writeFile(path.join(fixture.root, "src/owned/a.ts"), "export const a = 2;\n");
    await writeFile(path.join(fixture.root, "src/shared.ts"), "export const shared = 2;\n");
    await finishTasks(slice02, ["src/owned/", "src/shared.ts"]);
    await reviewClean("02");
    expect(Object.keys((await sliceReview(fixture, "02-work")).fingerprint.root).sort()).toEqual(["src/owned/a.ts", "src/shared.ts"]);

    const slice03 = await addSlice(fixture, "03-more", ["src/shared.ts", "src/more/"]);
    await writeFile(path.join(fixture.root, "src/shared.ts"), "export const shared = 3;\n");
    await writeFile(path.join(fixture.root, "src/more/c.ts"), "export const c = 2;\n");
    // A foreign edit during slice 03: never fingerprinted by anyone.
    await writeFile(path.join(fixture.root, "src/other/b.ts"), "export const b = 2;\n");
    await finishTasks(slice03, ["src/shared.ts", "src/more/"]);
    const before02 = await sliceReview(fixture, "02-work");
    expect(await reviewClean("03")).toMatchObject({ state: "reviewed", released_from: ["02-work"] });

    const after02 = await sliceReview(fixture, "02-work");
    expect(after02.fingerprint).toEqual({ root: { "src/owned/a.ts": before02.fingerprint.root["src/owned/a.ts"] } });
    // Only the fingerprint map changed in slice 02's block.
    const { fingerprint: _a, updated_at: _b, ...rest02After } = after02;
    const { fingerprint: _c, updated_at: _d, ...rest02Before } = before02;
    expect(rest02After).toEqual(rest02Before);
    expect(Object.keys((await sliceReview(fixture, "03-more")).fingerprint.root).sort()).toEqual(["src/more/c.ts", "src/shared.ts"]);

    // The shared file was edited after slice 02's review, but slice 02 no longer owns it.
    expect((await status("02")).effective_state).toBe("reviewed");
    expect((await status("03")).effective_state).toBe("reviewed");
    await writeFile(path.join(fixture.root, "src/shared.ts"), "export const shared = 4;\n");
    expect((await status("02")).effective_state).toBe("reviewed");
    expect(await status("03")).toMatchObject({ effective_state: "out_of_date", out_of_date_reasons: ["code_changed"] });
  });

  it("labels files from main after a rebase between the boundaries and keeps them out of the fingerprint", async () => {
    const fixture = await setup();
    const slicePath = await addSlice(fixture, "02-work", ["src/owned/"]);
    const startBase = await git(fixture.root, ["rev-parse", "main"]);
    await writeFile(path.join(fixture.root, "src/owned/a.ts"), "export const a = 2;\n");

    // Main moves on: a file inside the slice's anchors and one outside, both changed only on main,
    // plus a file both main and the slice change. Then the change is rebased onto main.
    // Main's commit is made in a separate worktree, so the change checkout is not touched.
    const mainTree = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-review-main-")));
    await git(fixture.root, ["worktree", "add", "-q", path.join(mainTree, "main"), "main"]);
    const mainCheckout = path.join(mainTree, "main");
    await write(mainCheckout, "src/owned/from-main.ts", "export const fromMain = 1;\n");
    await write(mainCheckout, "src/other/main-only.ts", "export const mainOnly = 1;\n");
    await write(mainCheckout, "src/more/c.ts", "export const c = 'main';\n");
    await git(mainCheckout, ["add", "-A"]);
    await git(mainCheckout, ["commit", "-q", "-m", "main work"]);
    await git(fixture.root, ["worktree", "remove", "--force", mainCheckout]);
    await git(fixture.root, ["rebase", "-q", "--autostash", "main"]);
    const endBase = await git(fixture.root, ["rev-parse", "main"]);
    expect(endBase).not.toBe(startBase);
    await writeFile(path.join(fixture.root, "src/more/c.ts"), "export const c = 'main and slice';\n");
    await finishTasks(slicePath, ["src/owned/", "src/more/"]);

    const packaged = await run(["package", "--slice", "02"]);
    expect(packaged.exitCode).toBeUndefined();
    expect(packaged.result).toMatchObject({ from_main_files: 2, size_hint: { files: 2 } });
    const text = await readFile(packaged.result.package_path as string, "utf8");
    const fromMain = section(text, "## From main (ignore)");
    expect(fromMain).toContain(`merge-base moved from ${startBase.slice(0, 12)} to ${endBase.slice(0, 12)}`);
    expect(fromMain).toContain("src/owned/from-main.ts");
    expect(fromMain).toContain("src/other/main-only.ts");
    expect(fromMain).not.toContain("src/more/c.ts");
    const diff = section(text, "## Diff");
    expect(diff).not.toContain("from-main.ts");
    expect(diff).not.toContain("main-only.ts");
    expect(diff).toContain("src/owned/a.ts");
    expect(diff).toContain("src/more/c.ts");

    const runId = packaged.result.run_id as string;
    await run(["record", "--run", runId, "--report", "-"], report([]));
    const finalized = await run(["record", "--run", runId, "--finalize"]);
    expect(finalized.result.from_main).toEqual({ root: ["src/other/main-only.ts", "src/owned/from-main.ts"] });
    expect(Object.keys((await sliceReview(fixture, "02-work")).fingerprint.root).sort()).toEqual(["src/more/c.ts", "src/owned/a.ts"]);
    expect((await sliceReview(fixture, "02-work")).merge_base).toEqual({ root: endBase });
  });

  it("omits the from-main section when the merge-base did not move", async () => {
    const fixture = await setup();
    const slicePath = await addSlice(fixture, "02-work", ["src/owned/"]);
    await writeFile(path.join(fixture.root, "src/owned/a.ts"), "export const a = 2;\n");
    await finishTasks(slicePath, ["src/owned/"]);
    const packaged = await run(["package", "--slice", "02"]);
    expect(packaged.result.from_main_files).toBe(0);
    expect(await readFile(packaged.result.package_path as string, "utf8")).not.toContain("From main");
  });

  it("turns a waiting slice whose plan changed into not_reviewed (plan changed), and the next package is a fresh run", async () => {
    const fixture = await setup();
    const slicePath = await addSlice(fixture, "02-work", ["src/owned/"]);
    await writeFile(path.join(fixture.root, "src/owned/a.ts"), "export const a = 2;\n");
    await finishTasks(slicePath, ["src/owned/"]);
    expect((await run(["package", "--slice", "02"])).result.run_id).toBe("02-work/r1");
    const recorded = await run(["record", "--run", "02/r1", "--report", "-"], report([finding("F1", { kind: "plan", fails: { type: "prd", ref: "FR1" } })]));
    expect(recorded.result.state).toBe("waiting_on_person");
    expect((await sliceReview(fixture, "02-work")).plan_basis).toMatchObject({ "prd.md": expect.stringMatching(/^sha256:/) });

    // Code edits do not matter to a waiting slice; it keeps waiting.
    await writeFile(path.join(fixture.root, "src/owned/a.ts"), "export const a = 3;\n");
    expect(await status("02")).toMatchObject({ stored_state: "waiting_on_person", effective_state: "waiting_on_person", out_of_date_reasons: [] });

    const before = await statusBytes(fixture, ["02-work"]);
    await writeFile(path.join(fixture.changePath, "prd.md"), "---\nartifact: prd\n---\n\n# PRD\n\nFR1, now clarified.\n");
    expect(await status("02")).toMatchObject({
      stored_state: "waiting_on_person",
      effective_state: "not_reviewed",
      out_of_date: false,
      out_of_date_reasons: ["plan_changed"],
    });
    expect(await statusBytes(fixture, ["02-work"])).toEqual(before);

    const fresh = await run(["package", "--slice", "02"]);
    expect(fresh.exitCode).toBeUndefined();
    expect(fresh.result.run_id).toBe("02-work/r2");
    expect(await status("02")).toMatchObject({ stored_state: "in_review", effective_state: "in_review", out_of_date_reasons: [] });
  });

  it("lists settled rulings, reopens a ruling when its code changes, and marks it reopened in review.md", async () => {
    const fixture = await setup();
    const slicePath = await addSlice(fixture, "02-work", ["src/owned/"]);
    await writeFile(path.join(fixture.root, "src/owned/a.ts"), "export const a = 2;\n");
    await finishTasks(slicePath, ["src/owned/"]);
    await run(["package", "--slice", "02"]);
    await run(["record", "--run", "02/r1", "--report", "-"], report([finding("F1")]));
    const ruled = await run(["record", "--run", "02/r1", "--resolve", "F1", "--as", "ruling", "--agreed", "false", "--reason", "Intended.", "--cost", "A wrong constant."]);
    expect(ruled.exitCode).toBeUndefined();
    expect((await run(["record", "--run", "02/r1", "--finalize"])).result.state).toBe("reviewed_with_rulings");

    const settled = await run(["package", "--slice", "02"]);
    expect(settled.result).toMatchObject({ run_id: "02-work/r2", settled_rulings: 1, reopened_rulings: 0 });
    let text = await readFile(settled.result.package_path as string, "utf8");
    expect(section(text, "### Settled rulings (do not raise again)")).toContain("`02-work/r1-F1`");
    expect(section(text, "### Settled rulings (do not raise again)")).toContain("Intended.");
    expect(section(text, "### Reopened rulings")).toContain("None.");

    await writeFile(path.join(fixture.root, "src/owned/a.ts"), "export const a = 5;\n");
    const reopened = await run(["package", "--slice", "02"]);
    expect(reopened.result).toMatchObject({ run_id: "02-work/r3", settled_rulings: 0, reopened_rulings: 1 });
    text = await readFile(reopened.result.package_path as string, "utf8");
    expect(section(text, "### Settled rulings (do not raise again)")).toContain("None.");
    expect(section(text, "### Reopened rulings")).toContain("`02-work/r1-F1`");
    expect(section(text, "### Reopened rulings")).toContain("`code root:src/owned/a.ts`");

    await run(["record", "--run", "02/r3", "--report", "-"], report([]));
    const record = await readFile(path.join(slicePath, "review.md"), "utf8");
    expect(record).toContain("ruling (reopened)");
    expect(record).toContain("Reopened: yes");
    // Reopened is derived: the stored ruling is unchanged.
    const stored = JSON.parse(await readFile(path.join(slicePath, "review", "r1.findings.json"), "utf8")) as { findings: Array<{ resolution: Record<string, unknown> }> };
    expect(stored.findings[0].resolution.reopened).toBeUndefined();
  });
});
