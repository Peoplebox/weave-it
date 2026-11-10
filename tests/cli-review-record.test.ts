import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewCommand } from "../src/commands/review.js";
import { reportInput } from "../src/commands/review/record.js";
import { createChange } from "../src/lib/changes.js";
import { bodyHash } from "../src/lib/review/rules.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(__dirname, "..");
const cliEntry = path.resolve(projectRoot, "src", "cli.ts");
const tsxBinary = path.resolve(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
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
  slicePath: string;
}

// A repo-mode Weave root with review installed and one slice, `02-work`, owning `src/owned/`.
// The slice's start snapshot is taken, its work is done (an edit, a new file, a deleted file, a
// foreign edit, and a planning note), and run r1 is packaged.
async function setup(options: { tasks?: TaskSpec[]; independentPackage?: boolean } = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-cli-review-record-")));
  await mkdir(path.join(root, ".weave"), { recursive: true });
  await writeFile(path.join(root, ".weave", "workspace.yml"), YAML.stringify({ version: 1, mode: "repo", name: "fixture", repos: {} }));
  await writeFile(
    path.join(root, ".weave", "agents.yml"),
    YAML.stringify({ version: 1, installed: { claude: { skills: { "weave-review": { path: ".claude/skills/weave-review/SKILL.md" } } } } }),
  );
  await mkdir(path.join(root, "src", "owned"), { recursive: true });
  await mkdir(path.join(root, "src", "other"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "initial\n");
  await writeFile(path.join(root, "src", "owned", "a.ts"), "export const a = 1;\n");
  await writeFile(path.join(root, "src", "owned", "old.ts"), "export const old = 1;\n");
  await writeFile(path.join(root, "src", "other", "b.ts"), "export const b = 1;\n");
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "initial"]);
  const session = path.join(root, ".session.yml");
  const created = await createChange({ cwd: root, title: "Review record", now: testNow, randomId: () => "rc05", sessionPath: session });
  const changePath = path.join(root, "wiki", "changes", created.id);
  await writeFile(path.join(changePath, "prd.md"), "---\nartifact: prd\n---\n\n# PRD\n\nFR1.\n");
  await mkdir(path.join(changePath, "architecture"), { recursive: true });
  await writeFile(path.join(changePath, "architecture", "index.md"), "# Architecture\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "scaffold"]);
  process.env.WEAVE_SESSION_PATH = session;
  process.chdir(root);

  const slicePath = path.join(changePath, "task-slices", "02-work");
  await mkdir(slicePath, { recursive: true });
  const tasks = options.tasks ?? [{ id: "T1", status: "done", files: ["src/owned/"] }];
  await writeFile(
    path.join(slicePath, "status.yml"),
    YAML.stringify({ version: 1, id: "02-work", title: "Work", status: "in_progress", owner: "", repos: ["root"], depends_on: [], task_summary: { total: tasks.length, done: 0, blocked: 0 } }),
  );
  await writeFile(path.join(slicePath, "slice.md"), "# Work\n\nAcceptance.\n");
  await writeFile(path.join(slicePath, "tasks.md"), tasksMarkdown(tasks.map((task) => ({ ...task, status: "in_progress" }))));
  expect((await run(["snapshot", "--slice", "02", "--at", "start"])).exitCode).toBeUndefined();

  await writeFile(path.join(root, "src", "owned", "a.ts"), "export const a = 2;\n");
  await writeFile(path.join(root, "src", "owned", "new.ts"), "export const fresh = true;\n");
  await rm(path.join(root, "src", "owned", "old.ts"));
  await writeFile(path.join(root, "src", "other", "b.ts"), "export const b = 2;\n");
  await writeFile(path.join(changePath, "notes.md"), "planning notes\n");
  await writeFile(path.join(slicePath, "tasks.md"), tasksMarkdown(tasks));
  const packaged = await run(["package", "--slice", "02"]);
  expect(packaged.exitCode).toBeUndefined();
  expect(packaged.result.run_id).toBe("02-work/r1");
  return { root, changePath, changeId: created.id, slicePath };
}

async function run(args: string[], stdin?: string): Promise<{ result: Record<string, unknown>; exitCode: number | undefined }> {
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
  return { result: JSON.parse(chunks.join("")) as Record<string, unknown>, exitCode };
}

function runCli(args: string[], cwd: string, input?: string): { status: number | null; json: Record<string, unknown> } {
  const result = spawnSync(process.execPath, [tsxBinary, cliEntry, ...args], {
    cwd,
    env: { ...process.env, WEAVE_NO_NOTICES: "1" },
    encoding: "utf8",
    ...(input !== undefined ? { input } : {}),
  });
  return { status: result.status, json: JSON.parse(result.stdout) as Record<string, unknown> };
}

async function sliceReview(fixture: Fixture): Promise<Record<string, unknown> | undefined> {
  return (YAML.parse(await readFile(path.join(fixture.slicePath, "status.yml"), "utf8")) as { review?: Record<string, unknown> }).review;
}

async function findingsFile(fixture: Fixture, run = "r1"): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path.join(fixture.slicePath, "review", `${run}.findings.json`), "utf8")) as Record<string, any>;
}

function finding(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    severity: "important",
    kind: "code",
    location: { repo: "root", path: "src/owned/a.ts", line: 1 },
    fails: { type: "prd", ref: "FR1" },
    detail: `Problem ${id}.`,
    fix_hint: "Fix it.",
    ...extra,
  };
}

function report(findings: Array<Record<string, unknown>>, verdict = findings.length > 0 ? "with_fixes" : "ready"): string {
  return `Reviewed the slice.\n\n\`\`\`json\n${JSON.stringify({ strengths: ["Small, clear change"], findings, declined: [], verdict }, null, 2)}\n\`\`\`\n`;
}

describe("weave review record --report", () => {
  it("stores the report verbatim and as validated findings, and regenerates review.md", async () => {
    const fixture = await setup();
    const text = report([finding("F1"), finding("F2", { severity: "minor", unknown_field: true })]);

    const { result, exitCode } = await run(["record", "--run", "02/r1", "--report", "-"], text);
    expect(exitCode).toBeUndefined();
    expect(result).toMatchObject({ status: "ok", run: "02-work/r1", state: "in_review", findings: 2, new_findings: 2, open: ["02-work/r1-F1", "02-work/r1-F2"] });

    expect(await readFile(path.join(fixture.slicePath, "review", "r1.report.md"), "utf8")).toBe(text);
    const stored = await findingsFile(fixture);
    expect(stored).toMatchObject({
      run: "02-work/r1",
      scope: { kind: "slice", slice: "02-work" },
      independent: true,
      partial: false,
      model_level: "mid",
      start_ref: `refs/weave/reviews/${fixture.changeId}/02-work/start`,
      end_ref: `refs/weave/reviews/${fixture.changeId}/02-work/r1/end`,
      reports: ["r1.report.md"],
      verdict: "with_fixes",
    });
    expect(stored.findings[1]).toEqual({
      id: "02-work/r1-F2",
      severity: "minor",
      kind: "code",
      location: { repo: "root", path: "src/owned/a.ts", line: 1 },
      fails: { type: "prd", ref: "FR1" },
      detail: "Problem F2.",
      fix_hint: "Fix it.",
      foreign_file: false,
      resolution: null,
    });
    expect(await sliceReview(fixture)).toMatchObject({ state: "in_review", latest_run: "r1", independent: true });

    const record = await readFile(path.join(fixture.slicePath, "review.md"), "utf8");
    expect(record).toContain("## Run 02-work/r1");
    expect(record).toContain("| 02-work/r1-F1 | important | code | root:src/owned/a.ts:1 | prd: FR1 | open |");
    expect(record).toContain("- Independent: yes");
  });

  it("labels a finding on a file outside the slice's anchors as foreign", async () => {
    const fixture = await setup();
    await run(["record", "--run", "02/r1", "--report", "-"], report([finding("F1", { location: { repo: "root", path: "src/other/b.ts" } })]));
    expect((await findingsFile(fixture)).findings[0].foreign_file).toBe(true);
  });

  it("moves the slice to waiting_on_person when a plan finding is reported", async () => {
    const fixture = await setup();
    const { result } = await run(["record", "--run", "02-work/r1", "--report", "-"], report([finding("F1"), finding("F2", { kind: "plan" })]));
    expect(result).toMatchObject({ state: "waiting_on_person", plan_findings_open: ["02-work/r1-F2"] });
    expect(await sliceReview(fixture)).toMatchObject({ state: "waiting_on_person" });
    expect(await readFile(path.join(fixture.slicePath, "review.md"), "utf8")).toContain("| plan | root:src/owned/a.ts:1 | prd: FR1 | waiting on person |");
  });

  it("exits 4 on an invalid report and writes no file and no state", async () => {
    const fixture = await setup();
    const statusBefore = await readFile(path.join(fixture.slicePath, "status.yml"), "utf8");

    const invalid = await run(["record", "--run", "02/r1", "--report", "-"], report([finding("F1", { severity: "high" })]));
    expect(invalid.exitCode).toBe(4);
    expect(invalid.result).toMatchObject({ status: "error", code: "report_invalid" });
    expect((invalid.result.details as { errors: string[] }).errors).toEqual(['findings[0].severity: must be one of critical, important, minor (got "high")']);

    const escaping = await run(["record", "--run", "02/r1", "--report", "-"], report([finding("F1", { location: { repo: "root", path: "../outside.ts" } })]));
    expect(escaping.exitCode).toBe(4);
    const noBlock = await run(["record", "--run", "02/r1", "--report", "-"], "Looks fine to me.");
    expect(noBlock.exitCode).toBe(4);

    expect(await readFile(path.join(fixture.slicePath, "status.yml"), "utf8")).toBe(statusBefore);
    expect(await readdir(fixture.slicePath)).toEqual(["slice.md", "status.yml", "tasks.md"]);
  });

  it("--failed sets review_failed and closes the run", async () => {
    const fixture = await setup();
    const { result, exitCode } = await run(["record", "--run", "02/r1", "--failed"]);
    expect(exitCode).toBeUndefined();
    expect(result).toEqual({ status: "ok", run: "02-work/r1", state: "review_failed", checkpoint: expect.objectContaining({ kind: "planning" }) });
    expect(await sliceReview(fixture)).toMatchObject({ state: "review_failed", latest_run: "r1" });
    expect((await findingsFile(fixture)).outcome).toMatchObject({ state: "review_failed" });
    expect(await readFile(path.join(fixture.slicePath, "review.md"), "utf8")).toContain("- State: review failed");

    const late = await run(["record", "--run", "02/r1", "--report", "-"], report([]));
    expect(late).toMatchObject({ exitCode: 1, result: { code: "run_closed" } });
  });

  it("shows and stores --independent false", async () => {
    const fixture = await setup();
    await run(["record", "--run", "02/r1", "--report", "-", "--independent", "false"], report([]));
    expect(await sliceReview(fixture)).toMatchObject({ independent: false });
    expect((await findingsFile(fixture)).independent).toBe(false);
    expect(await readFile(path.join(fixture.slicePath, "review.md"), "utf8")).toContain("- Independent: no (less independent");
  });

  it("rejects unknown runs and runs that were never packaged", async () => {
    await setup();
    expect(await run(["record", "--run", "09/r1", "--failed"])).toMatchObject({ exitCode: 1, result: { code: "run_not_found" } });
    expect(await run(["record", "--run", "02/r2", "--report", "-"], report([]))).toMatchObject({ exitCode: 1, result: { code: "run_not_found" } });
    expect(await run(["record", "--run", "02", "--failed"])).toMatchObject({ exitCode: 1, result: { code: "invalid_arguments" } });
    expect(await run(["record", "--run", "02/r1", "--failed", "--finalize"])).toMatchObject({ exitCode: 1, result: { code: "invalid_arguments" } });
  });
});

describe("weave review record --resolve", () => {
  it("stores a ruling with its basis, and refuses to park an Important finding", async () => {
    const fixture = await setup();
    await run(["record", "--run", "02/r1", "--report", "-"], report([finding("F1"), finding("F2", { severity: "minor" })]));

    const ruling = await run(["record", "--run", "02/r1", "--resolve", "02/r1-F1", "--as", "ruling", "--agreed", "false", "--reason", "Intended behaviour", "--cost", "One retry"]);
    expect(ruling.exitCode).toBeUndefined();
    expect(ruling.result).toMatchObject({ status: "ok", finding: "02-work/r1-F1", state: "in_review" });
    const stored = (await findingsFile(fixture)).findings[0];
    expect(stored.resolution).toMatchObject({
      as: "ruling",
      agreed: false,
      reason: "Intended behaviour",
      cost_if_wrong: "One retry",
      basis: {
        code: { "root:src/owned/a.ts": await git(fixture.root, ["hash-object", "src/owned/a.ts"]) },
        guidelines: { ".weave/coding-guidelines.md": "absent" },
        documents: { "prd.md": bodyHash("---\nartifact: prd\n---\n\n# PRD\n\nFR1.\n") },
        decisions: {},
      },
    });

    const parkImportant = await run(["record", "--run", "02/r1", "--resolve", "F1", "--as", "parked"]);
    expect(parkImportant).toMatchObject({ exitCode: 1, result: { code: "invalid_resolution" } });
    const missingCost = await run(["record", "--run", "02/r1", "--resolve", "F2", "--as", "ruling", "--agreed", "true", "--reason", "x"]);
    expect(missingCost).toMatchObject({ exitCode: 1, result: { code: "invalid_resolution" } });
    expect(await run(["record", "--run", "02/r1", "--resolve", "F9", "--as", "parked"])).toMatchObject({ exitCode: 1, result: { code: "finding_not_found" } });
    expect((await run(["record", "--run", "02/r1", "--resolve", "r1-F2", "--as", "parked"])).result).toMatchObject({ status: "ok", resolution: { as: "parked" } });

    const record = await readFile(path.join(fixture.slicePath, "review.md"), "utf8");
    expect(record).toContain("- `02-work/r1-F1` (important, disagreed): Intended behaviour");
    expect(record).toContain("  - Cost if wrong: One retry");
    expect(record).toContain("### Saved Minors\n\n- `02-work/r1-F2`");
  });

  it("exits 5 for a plan finding resolved by the agent, then returns to in_review when a person dismisses it", async () => {
    const fixture = await setup();
    await run(["record", "--run", "02/r1", "--report", "-"], report([finding("F1"), finding("F2", { kind: "plan", severity: "minor" })]));
    const findingsBefore = await readFile(path.join(fixture.slicePath, "review", "r1.findings.json"), "utf8");

    const refused = await run(["record", "--run", "02/r1", "--resolve", "02/r1-F2", "--as", "ruling", "--agreed", "false", "--reason", "x", "--cost", "y"]);
    expect(refused.exitCode).toBe(5);
    expect(refused.result).toMatchObject({ status: "error", code: "plan_finding_requires_person", details: { finding: "02-work/r1-F2", state: "waiting_on_person" } });
    expect(await sliceReview(fixture)).toMatchObject({ state: "waiting_on_person" });
    expect(await readFile(path.join(fixture.slicePath, "review", "r1.findings.json"), "utf8")).toBe(findingsBefore);
    expect((await run(["record", "--run", "02/r1", "--resolve", "F2", "--as", "parked"])).exitCode).toBe(5);
    expect((await run(["record", "--run", "02/r1", "--resolve", "F2", "--as", "dismissed"])).result).toMatchObject({ code: "invalid_resolution" });

    const dismissed = await run(["record", "--run", "02/r1", "--resolve", "02/r1-F2", "--as", "dismissed", "--by", "alice"]);
    expect(dismissed.result).toMatchObject({ status: "ok", state: "in_review", open: ["02-work/r1-F1"] });
    expect(await sliceReview(fixture)).toMatchObject({ state: "in_review" });
    expect(await readFile(path.join(fixture.slicePath, "review.md"), "utf8")).toContain("| dismissed by alice |");

    await run(["record", "--run", "02/r1", "--resolve", "F1", "--as", "ruling", "--agreed", "true", "--reason", "Crosses slices", "--cost", "A follow-up"]);
    expect((await run(["record", "--run", "02/r1", "--finalize"])).result).toMatchObject({ status: "ok", state: "reviewed_with_rulings" });
  });

  it("never changes kind or severity when the same run is reported again", async () => {
    const fixture = await setup();
    await run(["record", "--run", "02/r1", "--report", "-"], report([finding("F1")]));
    await run(["record", "--run", "02/r1", "--resolve", "F1", "--as", "ruling", "--agreed", "true", "--reason", "r", "--cost", "c"]);
    const again = await run(["record", "--run", "02/r1", "--report", "-"], report([finding("F1", { kind: "plan", severity: "minor", detail: "Reworded." }), finding("F2")]));
    expect(again.result).toMatchObject({ findings: 2, new_findings: 1, state: "in_review" });

    const stored = await findingsFile(fixture);
    expect(stored.reports).toEqual(["r1.report.md", "r1.report-2.md"]);
    expect(stored.findings[0]).toMatchObject({ id: "02-work/r1-F1", kind: "code", severity: "important", detail: "Reworded.", resolution: { as: "ruling" } });
  });
});

describe("weave review record --finalize", () => {
  it("ends a run with no findings as reviewed and stores fingerprint, plan basis, merge-base, and task total", async () => {
    const fixture = await setup({
      tasks: [
        { id: "T1", status: "done", files: ["src/owned/"] },
        { id: "T2", status: "not_tested", files: ["src/owned/new.ts"], verification: ["- Human check: open the screen"] },
      ],
    });
    await run(["record", "--run", "02/r1", "--report", "-"], report([]));

    const { result, exitCode } = await run(["record", "--run", "02/r1", "--finalize"]);
    expect(exitCode).toBeUndefined();
    expect(result).toEqual({
      status: "ok",
      run: "02-work/r1",
      state: "reviewed",
      counts: { open_rulings: 0, parked_minors: 0, human_checks: 1, untested_tasks: 1 },
      fingerprint_files: 3,
      reviewed_task_total: 2,
      released_from: [],
      from_main: {},
      warnings: [],
      // Ending the run is a recorded moment: its review records are committed (decision 261111-htho).
      checkpoint: expect.objectContaining({ kind: "planning" }),
    });

    const review = (await sliceReview(fixture)) as Record<string, any>;
    expect(review).toMatchObject({ state: "reviewed", latest_run: "r1", reviewed_task_total: 2, independent: true, partial: false });
    // Owned files only: no foreign src/other/b.ts, nothing under wiki/changes/, and absent for the deleted file.
    expect(review.fingerprint).toEqual({
      root: {
        "src/owned/a.ts": await git(fixture.root, ["hash-object", "src/owned/a.ts"]),
        "src/owned/new.ts": await git(fixture.root, ["hash-object", "src/owned/new.ts"]),
        "src/owned/old.ts": "absent",
      },
    });
    expect(review.merge_base).toEqual({ root: await git(fixture.root, ["rev-parse", "main"]) });
    expect(Object.keys(review.plan_basis).sort()).toEqual(["architecture/index.md", "decisions", "prd.md", "task-slices/02-work/slice.md"]);
    expect(review.plan_basis["prd.md"]).toBe(bodyHash("---\nartifact: prd\n---\n\n# PRD\n\nFR1.\n"));
    expect(review.counts).toEqual({ open_rulings: 0, parked_minors: 0, human_checks: 1, untested_tasks: 1 });

    const record = await readFile(path.join(fixture.slicePath, "review.md"), "utf8");
    expect(record).toContain("- State: reviewed (");
    expect(record).toContain("### Untested tasks\n\n- T2: Task T2");
    expect(record).toContain("### Human checks (needs your check)\n\n- T2: open the screen");
    expect(await run(["record", "--run", "02/r1", "--finalize"])).toMatchObject({ exitCode: 1, result: { code: "run_closed" } });
  });

  it("refuses while an Important finding is open, then gives reviewed_with_rulings once it has a ruling", async () => {
    const fixture = await setup();
    await run(["record", "--run", "02/r1", "--report", "-"], report([finding("F1"), finding("F2", { severity: "minor" })]));
    const statusBefore = await readFile(path.join(fixture.slicePath, "status.yml"), "utf8");

    const blocked = await run(["record", "--run", "02/r1", "--finalize"]);
    expect(blocked).toMatchObject({ exitCode: 1, result: { code: "finalize_blocked", details: { open: ["02-work/r1-F1", "02-work/r1-F2"] } } });
    expect(await readFile(path.join(fixture.slicePath, "status.yml"), "utf8")).toBe(statusBefore);

    await run(["record", "--run", "02/r1", "--resolve", "F1", "--as", "ruling", "--agreed", "false", "--reason", "Intended", "--cost", "Low"]);
    expect((await run(["record", "--run", "02/r1", "--finalize"])).result).toMatchObject({ code: "finalize_blocked", details: { open: ["02-work/r1-F2"] } });
    await run(["record", "--run", "02/r1", "--resolve", "F2", "--as", "parked"]);
    const finalized = await run(["record", "--run", "02/r1", "--finalize"]);
    expect(finalized.result).toMatchObject({ status: "ok", state: "reviewed_with_rulings", counts: { open_rulings: 1, parked_minors: 1 } });
    expect(await sliceReview(fixture)).toMatchObject({ state: "reviewed_with_rulings", counts: { open_rulings: 1, parked_minors: 1, human_checks: 0, untested_tasks: 0 } });
  });

  it("refuses while a plan finding waits on a person", async () => {
    await setup();
    await run(["record", "--run", "02/r1", "--report", "-"], report([finding("F1", { kind: "plan" })]));
    expect(await run(["record", "--run", "02/r1", "--finalize"])).toMatchObject({
      exitCode: 1,
      result: { code: "finalize_blocked", details: { plan_findings_open: ["02-work/r1-F1"] } },
    });
  });
});

describe("weave review status --repair", () => {
  it("rebuilds a dropped review block from the findings files, and plain status writes nothing", async () => {
    const fixture = await setup();
    await run(["record", "--run", "02/r1", "--report", "-"], report([finding("F1"), finding("F2", { severity: "minor" })]));
    await run(["record", "--run", "02/r1", "--resolve", "F1", "--as", "ruling", "--agreed", "false", "--reason", "Intended", "--cost", "Low"]);
    await run(["record", "--run", "02/r1", "--resolve", "F2", "--as", "parked"]);
    await run(["record", "--run", "02/r1", "--finalize"]);
    const original = (await sliceReview(fixture)) as Record<string, unknown>;

    // An older CLI's rollup drops the `review` key.
    const statusPath = path.join(fixture.slicePath, "status.yml");
    const doc = YAML.parse(await readFile(statusPath, "utf8")) as Record<string, unknown>;
    delete doc.review;
    await writeFile(statusPath, YAML.stringify(doc));
    const dropped = await readFile(statusPath, "utf8");

    await run(["status"]);
    await run(["status", "--slice", "02"]);
    expect(await readFile(statusPath, "utf8")).toBe(dropped);

    const repaired = await run(["status", "--slice", "02", "--repair"]);
    expect(repaired.result).toMatchObject({
      status: "ok",
      stored_state: "reviewed_with_rulings",
      repaired: [{ slice: "02-work", run: "02-work/r1", state: "reviewed_with_rulings", written: true, recomputed: ["fingerprint", "plan_basis"] }],
    });
    const rebuilt = (await sliceReview(fixture)) as Record<string, unknown>;
    expect(rebuilt).toMatchObject({ state: original.state, latest_run: original.latest_run, counts: original.counts });
    for (const key of ["start_ref", "reviewed_task_total", "merge_base", "plan_basis", "fingerprint", "independent", "partial"]) {
      expect(rebuilt[key]).toEqual(original[key]);
    }

    const again = await run(["status", "--repair"]);
    expect((again.result as { repaired: unknown[] }).repaired).toEqual([
      { slice: "02-work", run: "02-work/r1", state: "reviewed_with_rulings", written: false, recomputed: [], warnings: [] },
    ]);
  });
});

describe("exit codes through the CLI entry", () => {
  it("exits 4 for an invalid report and 5 for a plan finding resolved by the agent", async () => {
    const fixture = await setup();
    const invalid = runCli(["review", "record", "--run", "02/r1", "--report", "-", "--json"], fixture.root, "no json here");
    expect(invalid.status).toBe(4);
    expect(invalid.json).toMatchObject({ status: "error", code: "report_invalid" });

    const valid = runCli(["review", "record", "--run", "02/r1", "--report", "-", "--json"], fixture.root, report([finding("F1", { kind: "plan" })]));
    expect(valid.status).toBe(0);
    expect(valid.json).toMatchObject({ status: "ok", state: "waiting_on_person" });

    const refused = runCli(["review", "record", "--run", "02/r1", "--resolve", "F1", "--as", "parked", "--json"], fixture.root);
    expect(refused.status).toBe(5);
    expect(refused.json).toMatchObject({ code: "plan_finding_requires_person" });
    const other = runCli(["review", "record", "--run", "02/r1", "--resolve", "F7", "--as", "parked", "--json"], fixture.root);
    expect(other.status).toBe(1);

    const dismissed = runCli(["review", "record", "--run", "02/r1", "--resolve", "F1", "--as", "dismissed", "--by", "alice", "--json"], fixture.root);
    expect(dismissed).toMatchObject({ status: 0, json: { state: "in_review" } });
    const finalized = runCli(["review", "record", "--run", "02/r1", "--finalize", "--json"], fixture.root);
    expect(finalized).toMatchObject({ status: 0, json: { state: "reviewed_with_rulings" } });
    expect(await sliceReview(fixture)).toMatchObject({ state: "reviewed_with_rulings", latest_run: "r1" });
  }, 30_000);

  it("uses exit codes 4 and 5 only in weave review record", async () => {
    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.name.endsWith(".ts")) {
          const text = await readFile(full, "utf8");
          for (const match of text.matchAll(/(?:exitCode\s*=\s*|process\.exit\()\s*(\d+)/g)) {
            if (match[1] !== "0" && match[1] !== "1") offenders.push(`${path.relative(projectRoot, full)}: ${match[0]}`);
          }
          if (/\b(?:report_invalid|plan_finding_requires_person)\s*:\s*[45]\b/.test(text) && !full.endsWith(path.join("lib", "review", "record.ts"))) {
            offenders.push(path.relative(projectRoot, full));
          }
        }
      }
    };
    await walk(path.join(projectRoot, "src"));
    expect(offenders).toEqual([]);
  });
});
