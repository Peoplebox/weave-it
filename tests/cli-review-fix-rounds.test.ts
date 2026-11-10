import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewCommand } from "../src/commands/review.js";
import { reportInput } from "../src/commands/review/record.js";
import { createChange } from "../src/lib/changes.js";

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

async function initRepo(cwd: string, files: Record<string, string>): Promise<void> {
  await mkdir(cwd, { recursive: true });
  await git(cwd, ["init", "-q", "-b", "main"]);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
    await writeFile(path.join(cwd, file), content);
  }
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "-m", "initial"]);
}

interface TaskSpec {
  id: string;
  status: string;
  repos?: string;
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
    ...tasks.map((task) => `| ${task.id} | ${task.status} | afk | ${task.repos ?? "root"} | | Task ${task.id} | None |`),
    "",
  ];
  for (const task of tasks) {
    lines.push(`### ${task.id}: Task ${task.id}`, "", `Status: ${task.status}`, `Repos: ${task.repos ?? "root"}`, "Files:", ...task.files.map((file) => `- \`${file}\` (M)`), "");
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

async function writeConfig(root: string, repos: Record<string, string> = {}): Promise<void> {
  const workspace = Object.keys(repos).length > 0;
  await mkdir(path.join(root, ".weave"), { recursive: true });
  await writeFile(
    path.join(root, ".weave", "workspace.yml"),
    YAML.stringify({
      version: 1,
      mode: workspace ? "workspace" : "repo",
      name: "fixture",
      repos: Object.fromEntries(Object.entries(repos).map(([id, repoPath]) => [id, { path: repoPath, kind: "app" }])),
    }),
  );
  await writeFile(
    path.join(root, ".weave", "agents.yml"),
    YAML.stringify({ version: 1, installed: { claude: { skills: { "weave-review": { path: ".claude/skills/weave-review/SKILL.md" } } } } }),
  );
  if (workspace) {
    await writeFile(path.join(root, ".gitignore"), `/.session.yml\n${Object.values(repos).map((repoPath) => `/${repoPath}/`).join("\n")}\n`);
  } else {
    await writeFile(path.join(root, ".gitignore"), "/.session.yml\n");
  }
}

async function createFixtureChange(root: string): Promise<{ changePath: string; changeId: string }> {
  const session = path.join(root, ".session.yml");
  const created = await createChange({ cwd: root, title: "Fix rounds", now: testNow, randomId: () => "fx06", sessionPath: session });
  const changePath = path.join(root, "wiki", "changes", created.id);
  await writeFile(path.join(changePath, "prd.md"), "---\nartifact: prd\n---\n\n# PRD\n\nFR1.\n");
  await mkdir(path.join(changePath, "architecture"), { recursive: true });
  await writeFile(path.join(changePath, "architecture", "index.md"), "# Architecture\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "scaffold"]);
  if ((await git(root, ["branch", "--show-current"])) !== "main") {
    await git(root, ["branch", "-f", "main", "HEAD"]);
  }
  process.env.WEAVE_SESSION_PATH = session;
  process.chdir(root);
  return { changePath, changeId: created.id };
}

async function writeSlice(changePath: string, id: string, repos: string[], tasks: TaskSpec[]): Promise<string> {
  const slicePath = path.join(changePath, "task-slices", id);
  await mkdir(slicePath, { recursive: true });
  await writeFile(
    path.join(slicePath, "status.yml"),
    YAML.stringify({ version: 1, id, title: id, status: "in_progress", owner: "", repos, depends_on: [], task_summary: { total: tasks.length, done: 0, blocked: 0 } }),
  );
  await writeFile(path.join(slicePath, "slice.md"), `# ${id}\n\nAcceptance.\n`);
  await writeFile(path.join(slicePath, "tasks.md"), tasksMarkdown(tasks));
  return slicePath;
}

// A repo-mode Weave root with review installed and one slice, `02-work`, owning `src/owned/`. Its
// start snapshot is taken, its work is done, and run r1 is packaged.
async function setup(options: { tasks?: TaskSpec[] } = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-cli-review-rounds-")));
  await writeConfig(root);
  await initRepo(root, { "README.md": "initial\n", "src/owned/a.ts": "export const a = 1;\n", "src/owned/b.ts": "export const b = 1;\n", "src/other/c.ts": "export const c = 1;\n" });
  const { changePath, changeId } = await createFixtureChange(root);
  const tasks = options.tasks ?? [{ id: "T1", status: "done", files: ["src/owned/"] }];
  const slicePath = await writeSlice(changePath, "02-work", ["root"], tasks.map((task) => ({ ...task, status: "in_progress" })));
  expect((await run(["snapshot", "--slice", "02", "--at", "start"])).exitCode).toBeUndefined();

  await writeFile(path.join(root, "src", "owned", "a.ts"), "export const a = 2;\n");
  await writeFile(path.join(root, "src", "owned", "b.ts"), "export const b = 2;\n");
  await writeFile(path.join(slicePath, "tasks.md"), tasksMarkdown(tasks));
  const packaged = await run(["package", "--slice", "02"]);
  expect(packaged.result.run_id).toBe("02-work/r1");
  return { root, changePath, changeId, slicePath };
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
    fails: { type: "prd", ref: "FR1" },
    detail: `Problem ${id}.`,
    fix_hint: "Fix it.",
    ...extra,
  };
}

function report(findings: Array<Record<string, unknown>>): string {
  return `Reviewed.\n\n\`\`\`json\n${JSON.stringify({ strengths: ["Clear"], findings, declined: [], verdict: findings.length > 0 ? "with_fixes" : "ready" }, null, 2)}\n\`\`\`\n`;
}

function fixCheck(checks: Array<[string, string]>, newFindings: Array<Record<string, unknown>> = []): string {
  const json = { checks: checks.map(([id, result]) => ({ finding: id, result })), new_findings: newFindings };
  return `Checked the round.\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;
}

async function findingsFile(fixture: Fixture, runName = "r1"): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path.join(fixture.slicePath, "review", `${runName}.findings.json`), "utf8")) as Record<string, any>;
}

async function sliceReview(slicePath: string): Promise<Record<string, any> | undefined> {
  return (YAML.parse(await readFile(path.join(slicePath, "status.yml"), "utf8")) as { review?: Record<string, any> }).review;
}

// HEAD, branch, index file hash, and stash list: round snapshots must leave all of them alone.
async function repoFacts(repo: string): Promise<Record<string, string>> {
  const indexPath = path.resolve(repo, await git(repo, ["rev-parse", "--git-path", "index"]));
  return {
    head: await git(repo, ["rev-parse", "HEAD"]),
    branch: await git(repo, ["branch", "--show-current"]),
    index: createHash("sha1").update(await readFile(indexPath)).digest("hex"),
    status: await git(repo, ["--no-optional-locks", "status", "--porcelain"]),
    stash: await git(repo, ["stash", "list"]),
  };
}

// Every file under `dir` (relative path -> content), skipping `.git`.
async function treeContents(dir: string, base = dir): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, await treeContents(full, base));
    else out[path.relative(base, full).split(path.sep).join("/")] = await readFile(full, "utf8");
  }
  return out;
}

const roundRef = (fixture: { changeId: string }, round: number, point: "start" | "end", slice = "02-work"): string =>
  `refs/weave/reviews/${fixture.changeId}/${slice}/r1/round${round}-${point}`;

describe("weave review snapshot --run --at round-start", () => {
  it("needs a recorded report, keeps rounds in order, and refuses a second start unless --force", async () => {
    const fixture = await setup();
    const early = await run(["snapshot", "--run", "02/r1", "--at", "round-start", "--round", "1"]);
    expect(early).toMatchObject({ exitCode: 1, result: { code: "report_not_recorded" } });

    await run(["record", "--run", "02/r1", "--report", "-"], report([finding("F1")]));
    const facts = await repoFacts(fixture.root);
    const started = await run(["snapshot", "--run", "02/r1", "--at", "round-start", "--round", "1"]);
    expect(started.exitCode).toBeUndefined();
    expect(started.result).toMatchObject({
      status: "ok",
      run: "02-work/r1",
      at: "round-start",
      round: 1,
      refs: { root: roundRef(fixture, 1, "start") },
      merge_base: { root: await git(fixture.root, ["rev-parse", "main"]) },
    });
    expect(await repoFacts(fixture.root)).toEqual(facts);
    expect(await git(fixture.root, ["rev-parse", "--verify", roundRef(fixture, 1, "start")])).toMatch(/^[0-9a-f]{40}$/);
    expect((await findingsFile(fixture)).rounds).toEqual([{ round: 1, start_ref: roundRef(fixture, 1, "start"), started_at: expect.any(String) }]);

    expect((await run(["snapshot", "--run", "02/r1", "--at", "round-start", "--round", "2"])).result).toMatchObject({ code: "round_not_ended" });
    expect((await run(["snapshot", "--run", "02/r1", "--at", "round-start", "--round", "3"])).result).toMatchObject({ code: "round_not_started" });
    expect((await run(["snapshot", "--run", "02/r1", "--at", "round-start", "--round", "1"])).result).toMatchObject({ code: "round_already_started" });
    expect((await run(["snapshot", "--run", "02/r1", "--at", "round-start", "--round", "0"])).result).toMatchObject({ code: "invalid_arguments" });
    expect((await run(["snapshot", "--run", "02/r1", "--at", "start"])).result).toMatchObject({ code: "invalid_arguments" });
    expect((await run(["snapshot", "--run", "02/r1", "--at", "round-start", "--round", "1", "--force"])).result).toMatchObject({ status: "ok", round: 1 });
  });
});

describe("weave review package --run --fix-round", () => {
  it("fails with round_not_started without the round-start snapshot", async () => {
    const fixture = await setup();
    await run(["record", "--run", "02/r1", "--report", "-"], report([finding("F1")]));
    expect((await run(["package", "--run", "02/r1", "--fix-round", "1"])).result).toMatchObject({ status: "error", code: "round_not_started" });

    await run(["snapshot", "--run", "02/r1", "--at", "round-start", "--round", "1"]);
    await git(fixture.root, ["update-ref", "-d", roundRef(fixture, 1, "start")]);
    const missing = await run(["package", "--run", "02/r1", "--fix-round", "1"]);
    expect(missing).toMatchObject({ exitCode: 1, result: { code: "round_not_started", details: { missing_refs: ["root"] } } });
    await expect(git(fixture.root, ["rev-parse", "--verify", "--quiet", roundRef(fixture, 1, "end")])).rejects.toThrow();
    expect((await run(["package", "--fix-round", "1"])).result).toMatchObject({ code: "invalid_arguments" });
  });

  it("saves a patch of only the round's edits, lists files touched, and packages only open Critical and Important findings", async () => {
    const fixture = await setup();
    await run(
      "record --run 02/r1 --report -".split(" "),
      report([finding("F1"), finding("F2", { severity: "critical", location: { repo: "root", path: "src/owned/b.ts" } }), finding("F3", { severity: "minor" }), finding("F4")]),
    );
    await run(["record", "--run", "02/r1", "--resolve", "F4", "--as", "ruling", "--agreed", "false", "--reason", "Intended", "--cost", "Low"]);
    await run(["snapshot", "--run", "02/r1", "--at", "round-start", "--round", "1"]);

    await writeFile(path.join(fixture.root, "src", "owned", "a.ts"), "export const a = 3;\n");
    await writeFile(path.join(fixture.root, "src", "owned", "a.test.ts"), "test('a', () => {});\n");
    await writeFile(path.join(fixture.root, "src", "owned", "logo.bin"), Buffer.from([0, 1, 2, 255, 0, 7]));
    await writeFile(path.join(fixture.changePath, "notes.md"), "a planning edit during the round\n");
    const facts = await repoFacts(fixture.root);

    const { result, exitCode } = await run(["package", "--run", "02/r1", "--fix-round", "1"]);
    expect(exitCode).toBeUndefined();
    const patchPath = path.join(fixture.slicePath, "review", "r1-round1.patch");
    expect(result).toMatchObject({
      status: "ok",
      run_id: "02-work/r1",
      round: 1,
      patch_path: patchPath,
      model_level: "cheap-mid",
      size_hint: { files: 3, lines: 3 },
      files_touched: { root: ["src/owned/a.test.ts", "src/owned/a.ts", "src/owned/logo.bin"] },
      targets: ["02-work/r1-F1", "02-work/r1-F2"],
      undo: `git apply -R wiki/changes/${fixture.changeId}/task-slices/02-work/review/r1-round1.patch`,
    });
    expect(result.package_path).toBe(path.join(fixture.root, ".weave", "tmp", "reviews", fixture.changeId, "02-work", "r1-round1.package.md"));
    const facts2 = await repoFacts(fixture.root);
    expect({ ...facts2, status: undefined }).toEqual({ ...facts, status: undefined });

    const patch = await readFile(patchPath, "utf8");
    const patched = [...patch.matchAll(/^diff --git a\/(\S+) b\//gm)].map((match) => match[1]);
    expect(patched).toEqual(result.files_touched.root);
    expect(patch).not.toContain("wiki/changes");
    expect(patch).toContain("GIT binary patch");

    const text = await readFile(result.package_path, "utf8");
    expect(text).toContain("# Fix check package: 02-work/r1 round 1");
    expect(text).toContain("model level hint: cheap-mid");
    expect(text).toContain("### 02-work/r1-F1 (important)");
    expect(text).toContain("### 02-work/r1-F2 (critical)");
    expect(text).not.toContain("02-work/r1-F3");
    expect(text).not.toContain("02-work/r1-F4");
    expect(text).toContain("+export const a = 3;");
    expect(text).toContain("- Shared: no shared guidelines found");

    const round = (await findingsFile(fixture)).rounds[0];
    expect(round).toMatchObject({
      round: 1,
      end_ref: roundRef(fixture, 1, "end"),
      patch: "review/r1-round1.patch",
      files: ["src/owned/a.test.ts", "src/owned/a.ts", "src/owned/logo.bin"],
      targets: ["02-work/r1-F1", "02-work/r1-F2"],
    });

    // The patch reverses to the round-start tree for the owned files, and planning files stay.
    await execFileAsync("git", ["apply", "-R", path.relative(fixture.root, patchPath)], { cwd: fixture.root });
    expect(await readFile(path.join(fixture.root, "src", "owned", "a.ts"), "utf8")).toBe("export const a = 2;\n");
    await expect(readFile(path.join(fixture.root, "src", "owned", "a.test.ts"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(fixture.root, "src", "owned", "logo.bin"))).rejects.toThrow();
    expect(await readFile(path.join(fixture.changePath, "notes.md"), "utf8")).toBe("a planning edit during the round\n");
  });
});

describe("weave review record: fix checks and --as fixed", () => {
  async function packagedRound(fixture: Fixture): Promise<void> {
    await run(["record", "--run", "02/r1", "--report", "-"], report([finding("F1"), finding("F2"), finding("F3", { severity: "minor" })]));
    await run(["snapshot", "--run", "02/r1", "--at", "round-start", "--round", "1"]);
    await writeFile(path.join(fixture.root, "src", "owned", "a.ts"), "export const a = 3;\n");
    expect((await run(["package", "--run", "02/r1", "--fix-round", "1"])).exitCode).toBeUndefined();
  }

  it("stores the check verbatim, keeps not_addressed findings open, and adds new findings with fresh ids", async () => {
    const fixture = await setup();
    await run(["record", "--run", "02/r1", "--report", "-"], report([finding("F1")]));
    const unchecked = await run(["record", "--run", "02/r1", "--report", "-"], fixCheck([["02/r1-F1", "addressed"]]));
    expect(unchecked).toMatchObject({ exitCode: 1, result: { code: "round_not_found" } });

    await run(["record", "--run", "02/r1", "--report", "-"], report([finding("F1"), finding("F2"), finding("F3", { severity: "minor" })]));
    await run(["snapshot", "--run", "02/r1", "--at", "round-start", "--round", "1"]);
    await writeFile(path.join(fixture.root, "src", "owned", "a.ts"), "export const a = 3;\n");
    await run(["package", "--run", "02/r1", "--fix-round", "1"]);

    const findingsBefore = await readFile(path.join(fixture.slicePath, "review", "r1.findings.json"), "utf8");
    const invalid = await run(["record", "--run", "02/r1", "--report", "-"], fixCheck([["02/r1-F9", "addressed"]]));
    expect(invalid).toMatchObject({ exitCode: 4, result: { code: "report_invalid" } });
    expect(await readFile(path.join(fixture.slicePath, "review", "r1.findings.json"), "utf8")).toBe(findingsBefore);
    await expect(readFile(path.join(fixture.slicePath, "review", "r1-round1.check.md"), "utf8")).rejects.toThrow();

    const text = fixCheck(
      [
        ["02/r1-F1", "addressed"],
        ["02-work/r1-F2", "not_addressed"],
      ],
      [finding("N1", { location: { repo: "root", path: "src/owned/a.ts", line: 1 }, detail: "The fix broke the zero case." }), finding("N2", { location: { repo: "root", path: "src/other/c.ts" }, severity: "minor" })],
    );
    const { result, exitCode } = await run(["record", "--run", "02/r1", "--report", "-"], text);
    expect(exitCode).toBeUndefined();
    expect(result).toMatchObject({
      status: "ok",
      kind: "fix_check",
      round: 1,
      addressed: ["02-work/r1-F1"],
      not_addressed: ["02-work/r1-F2"],
      new_findings: ["02-work/r1-F4", "02-work/r1-F5"],
      state: "in_review",
      open: ["02-work/r1-F1", "02-work/r1-F2", "02-work/r1-F3", "02-work/r1-F4", "02-work/r1-F5"],
    });
    expect(await readFile(path.join(fixture.slicePath, "review", "r1-round1.check.md"), "utf8")).toBe(text);
    const stored = await findingsFile(fixture);
    expect(stored.reports).toEqual(["r1.report.md", "r1.report-2.md"]);
    expect(stored.findings.find((item: any) => item.id === "02-work/r1-F4")).toMatchObject({
      severity: "important",
      kind: "code",
      source: "fix_check",
      round: 1,
      foreign_file: false,
      resolution: null,
    });
    expect(stored.findings.find((item: any) => item.id === "02-work/r1-F5")).toMatchObject({ severity: "minor", foreign_file: true });
    expect(stored.rounds[0].check).toMatchObject({
      report: "r1-round1.check.md",
      checks: [
        { finding: "02-work/r1-F1", result: "addressed" },
        { finding: "02-work/r1-F2", result: "not_addressed" },
      ],
      new_findings: ["02-work/r1-F4", "02-work/r1-F5"],
    });

    // A second check for the same round has no round to go to.
    expect((await run(["record", "--run", "02/r1", "--report", "-"], text)).result).toMatchObject({ code: "round_not_found" });
    // A checked round cannot be packaged again.
    expect((await run(["package", "--run", "02/r1", "--fix-round", "1"])).result).toMatchObject({ code: "round_closed" });

    // A new finding's kind and severity stay frozen when the main report is recorded again.
    await run(["record", "--run", "02/r1", "--report", "-"], report([finding("F4", { severity: "minor", kind: "plan" }), finding("F1")]));
    expect((await findingsFile(fixture)).findings.find((item: any) => item.id === "02-work/r1-F4")).toMatchObject({ severity: "important", kind: "code", source: "fix_check" });
  });

  it("records --as fixed with the round's patch and files, and needs an existing packaged round", async () => {
    const fixture = await setup();
    await packagedRound(fixture);
    expect((await run(["record", "--run", "02/r1", "--resolve", "F1", "--as", "fixed"])).result).toMatchObject({ code: "invalid_resolution" });
    expect((await run(["record", "--run", "02/r1", "--resolve", "F1", "--as", "fixed", "--round", "2"])).result).toMatchObject({ code: "round_not_found" });

    const fixed = await run(["record", "--run", "02/r1", "--resolve", "F1", "--as", "fixed", "--round", "1"]);
    expect(fixed.exitCode).toBeUndefined();
    expect(fixed.result).toMatchObject({
      status: "ok",
      finding: "02-work/r1-F1",
      resolution: { as: "fixed", round: 1, patch: "review/r1-round1.patch", files: ["src/owned/a.ts"], needs_your_check: false },
      state: "in_review",
      open: ["02-work/r1-F2", "02-work/r1-F3"],
    });
    const record = await readFile(path.join(fixture.slicePath, "review.md"), "utf8");
    expect(record).toContain("| 02-work/r1-F1 | 1 | `review/r1-round1.patch` | `src/owned/a.ts` | no |");
    expect(record).toContain("| 02-work/r1-F1 | important | code | root:src/owned/a.ts:1 | prd: FR1 | fixed in round 1 |");
    expect((await sliceReview(fixture.slicePath))?.counts).toMatchObject({ human_checks: 0 });
  });

  it("marks a fix on a slice with a Human check step as needing your check and counts it", async () => {
    const fixture = await setup({ tasks: [{ id: "T1", status: "done", files: ["src/owned/"], verification: ["- Automated tests: passed", "- Human check: open the page and click save"] }] });
    await packagedRound(fixture);
    const fixed = await run(["record", "--run", "02/r1", "--resolve", "F1", "--as", "fixed", "--round", "1"]);
    expect(fixed.result.resolution).toMatchObject({ needs_your_check: true });
    expect((await sliceReview(fixture.slicePath))?.counts).toMatchObject({ human_checks: 2 });
    const record = await readFile(path.join(fixture.slicePath, "review.md"), "utf8");
    expect(record).toContain("| 02-work/r1-F1 | 1 | `review/r1-round1.patch` | `src/owned/a.ts` | yes |");
    const humanChecks = record.slice(record.indexOf("### Human checks (needs your check)"));
    expect(humanChecks).toContain("- T1: open the page and click save");
    expect(humanChecks).toContain("- `02-work/r1-F1`: fixed in round 1; repeat the slice's human checks against the fix");
  });
});

describe("weave review package --run (resume)", () => {
  it("returns the next round after a person dismisses the plan finding, without a new run", async () => {
    const fixture = await setup();
    await run(["record", "--run", "02/r1", "--report", "-"], report([finding("F1"), finding("F2", { kind: "plan" })]));
    expect((await sliceReview(fixture.slicePath))?.state).toBe("waiting_on_person");
    const waiting = await run(["package", "--run", "02/r1"]);
    expect(waiting).toMatchObject({ exitCode: 1, result: { code: "run_not_resumable" } });

    await run(["record", "--run", "02/r1", "--resolve", "F2", "--as", "dismissed", "--by", "alice"]);
    const resumed = await run(["package", "--run", "02/r1"]);
    expect(resumed.exitCode).toBeUndefined();
    expect(resumed.result).toEqual({ status: "ok", run_id: "02-work/r1", resume_round: 1, open: ["02-work/r1-F1"] });
    expect(await sliceReview(fixture.slicePath)).toMatchObject({ state: "in_review", latest_run: "r1" });
    await expect(readFile(path.join(fixture.root, ".weave", "tmp", "reviews", fixture.changeId, "02-work", "r2.package.md"), "utf8")).rejects.toThrow();

    await run(["snapshot", "--run", "02/r1", "--at", "round-start", "--round", "1"]);
    await writeFile(path.join(fixture.root, "src", "owned", "a.ts"), "export const a = 4;\n");
    await run(["package", "--run", "02/r1", "--fix-round", "1"]);
    expect((await run(["package", "--run", "02/r1"])).result).toMatchObject({ resume_round: 2 });

    await run(["record", "--run", "02/r1", "--resolve", "F1", "--as", "fixed", "--round", "1"]);
    await run(["record", "--run", "02/r1", "--finalize"]);
    expect((await run(["package", "--run", "02/r1"])).result).toMatchObject({ code: "run_not_resumable", details: { state: "reviewed_with_rulings" } });
  });

  it("refuses a run with no dismissed plan finding", async () => {
    await setup();
    await run(["record", "--run", "02/r1", "--report", "-"], report([finding("F1")]));
    expect((await run(["package", "--run", "02/r1"])).result).toMatchObject({ code: "run_not_resumable" });
  });
});

describe("a two-round fix flow", () => {
  it("ends reviewed with every fix recorded, and both round patches reverse to the original end snapshot", async () => {
    const fixture = await setup();
    const endRef = `refs/weave/reviews/${fixture.changeId}/02-work/r1/end`;
    await run(["record", "--run", "02/r1", "--report", "-"], report([finding("F1"), finding("F2", { location: { repo: "root", path: "src/owned/b.ts" } })]));

    // Round 1 fixes F1 and adds a test; the checker raises F3.
    await run(["snapshot", "--run", "02/r1", "--at", "round-start", "--round", "1"]);
    await writeFile(path.join(fixture.root, "src", "owned", "a.ts"), "export const a = 3;\n");
    await writeFile(path.join(fixture.root, "src", "owned", "a.test.ts"), "test('a', () => {});\n");
    expect((await run(["package", "--run", "02/r1", "--fix-round", "1"])).result.targets).toEqual(["02-work/r1-F1", "02-work/r1-F2"]);
    const check1 = await run(
      ["record", "--run", "02/r1", "--report", "-"],
      fixCheck([["02/r1-F1", "addressed"], ["02/r1-F2", "not_addressed"]], [finding("F1", { location: { repo: "root", path: "src/owned/a.test.ts" }, detail: "The test asserts nothing." })]),
    );
    expect(check1.result.new_findings).toEqual(["02-work/r1-F3"]);
    await run(["record", "--run", "02/r1", "--resolve", "F1", "--as", "fixed", "--round", "1"]);

    // Round 2 fixes F2 and F3.
    expect((await run(["snapshot", "--run", "02/r1", "--at", "round-start", "--round", "2"])).exitCode).toBeUndefined();
    await writeFile(path.join(fixture.root, "src", "owned", "b.ts"), "export const b = 3;\n");
    await writeFile(path.join(fixture.root, "src", "owned", "a.test.ts"), "test('a', () => { expect(a).toBe(3); });\n");
    const round2 = await run(["package", "--run", "02/r1", "--fix-round", "2"]);
    expect(round2.result).toMatchObject({ targets: ["02-work/r1-F2", "02-work/r1-F3"], files_touched: { root: ["src/owned/a.test.ts", "src/owned/b.ts"] } });
    await run(["record", "--run", "02/r1", "--report", "-"], fixCheck([["02/r1-F2", "addressed"], ["02/r1-F3", "addressed"]]));
    await run(["record", "--run", "02/r1", "--resolve", "F2", "--as", "fixed", "--round", "2"]);
    await run(["record", "--run", "02/r1", "--resolve", "02/r1-F3", "--as", "fixed", "--round", "2"]);

    const finalized = await run(["record", "--run", "02/r1", "--finalize"]);
    expect(finalized.result).toMatchObject({ status: "ok", state: "reviewed" });
    // The test file a fix created is fingerprinted with the slice's files.
    expect(Object.keys((await sliceReview(fixture.slicePath))?.fingerprint.root).sort()).toEqual(["src/owned/a.test.ts", "src/owned/a.ts", "src/owned/b.ts"]);

    const record = await readFile(path.join(fixture.slicePath, "review.md"), "utf8");
    const fixes = record.slice(record.indexOf("### Fixes"), record.indexOf("### Rulings"));
    expect(fixes).toContain("| 02-work/r1-F1 | 1 | `review/r1-round1.patch` | `src/owned/a.test.ts`, `src/owned/a.ts` | no |");
    expect(fixes).toContain("| 02-work/r1-F2 | 2 | `review/r1-round2.patch` | `src/owned/a.test.ts`, `src/owned/b.ts` | no |");
    expect(fixes).toContain("| 02-work/r1-F3 | 2 | `review/r1-round2.patch` | `src/owned/a.test.ts`, `src/owned/b.ts` | no |");
    expect(fixes).toContain("- Round 1: patch `review/r1-round1.patch` (2 files); fix check `review/r1-round1.check.md`: 1 addressed, 1 not addressed, new: `02-work/r1-F3`");
    expect(fixes).toContain("- Round 2: patch `review/r1-round2.patch` (2 files); fix check `review/r1-round2.check.md`: 2 addressed, 0 not addressed, no new findings");

    // Undo round 2, then round 1: the owned files match the original review's end snapshot, and
    // nothing under wiki/changes/ moves.
    const weaveFilesBefore = await treeContents(path.join(fixture.root, "wiki", "changes"));
    for (const round of [2, 1]) {
      await execFileAsync("git", ["apply", "-R", `wiki/changes/${fixture.changeId}/task-slices/02-work/review/r1-round${round}.patch`], { cwd: fixture.root });
    }
    expect(await treeContents(path.join(fixture.root, "wiki", "changes"))).toEqual(weaveFilesBefore);
    const owned = await treeContents(path.join(fixture.root, "src", "owned"));
    const atEnd: Record<string, string> = {};
    for (const file of (await git(fixture.root, ["ls-tree", "-r", "--name-only", endRef, "--", "src/owned"])).split("\n")) {
      atEnd[file.slice("src/owned/".length)] = `${await git(fixture.root, ["show", `${endRef}:${file}`])}\n`;
    }
    expect(owned).toEqual(atEnd);
  });

  it("reverses round patches cleanly in a two-repo workspace", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-cli-review-rounds-ws-")));
    await writeConfig(root, { api: "api", web: "web" });
    await initRepo(root, { "README.md": "initial\n" });
    const { changePath, changeId } = await createFixtureChange(root);
    const api = path.join(root, "api");
    const web = path.join(root, "web");
    await initRepo(api, { "server/routes.ts": "export const routes = [];\n" });
    await initRepo(web, { "app/page.tsx": "export const page = 1;\n" });
    const tasks = (status: string): TaskSpec[] => [
      { id: "T1", status, repos: "api", files: ["server/"] },
      { id: "T2", status, repos: "web", files: ["app/"] },
    ];
    const slicePath = await writeSlice(changePath, "03-both", ["api", "web"], tasks("in_progress"));
    await run(["snapshot", "--slice", "03", "--at", "start"]);
    await writeFile(path.join(api, "server", "routes.ts"), "export const routes = ['/users'];\n");
    await writeFile(path.join(web, "app", "page.tsx"), "export const page = 2;\n");
    await writeFile(path.join(slicePath, "tasks.md"), tasksMarkdown(tasks("done")));
    expect((await run(["package", "--slice", "03"])).result.run_id).toBe("03-both/r1");
    await run(
      ["record", "--run", "03/r1", "--report", "-"],
      report([finding("F1", { location: { repo: "api", path: "server/routes.ts" } }), finding("F2", { location: { repo: "web", path: "app/page.tsx" } })]),
    );

    const roundStart = { api: await treeContents(api), web: await treeContents(web) };
    await run(["snapshot", "--run", "03/r1", "--at", "round-start", "--round", "1"]);
    await writeFile(path.join(api, "server", "routes.ts"), "export const routes = ['/users', '/teams'];\n");
    await writeFile(path.join(api, "server", "routes.test.ts"), "test('routes', () => {});\n");
    await writeFile(path.join(web, "app", "page.tsx"), "export const page = 3;\n");
    const packaged = await run(["package", "--run", "03/r1", "--fix-round", "1"]);
    expect(packaged.exitCode).toBeUndefined();
    expect(packaged.result).toMatchObject({
      files_touched: { api: ["server/routes.test.ts", "server/routes.ts"], web: ["app/page.tsx"] },
      size_hint: { files: 3 },
    });
    await run(["record", "--run", "03/r1", "--resolve", "F1", "--as", "fixed", "--round", "1"]);
    expect((await findingsFile({ root, changePath, changeId, slicePath })).findings[0].resolution.files).toEqual([
      "api:server/routes.test.ts",
      "api:server/routes.ts",
      "web:app/page.tsx",
    ]);

    const patch = await readFile(String(packaged.result.patch_path), "utf8");
    expect(patch).toContain("# Weave fix round 1 of run 03-both/r1: repo api (paths start with api/); apply from the Weave root\ndiff --git a/api/server/routes.test.ts b/api/server/routes.test.ts");
    expect(patch).toContain("# Weave fix round 1 of run 03-both/r1: repo web (paths start with web/); apply from the Weave root\ndiff --git a/web/app/page.tsx b/web/app/page.tsx");

    await execFileAsync("git", ["apply", "-R", path.relative(root, String(packaged.result.patch_path))], { cwd: root });
    expect({ api: await treeContents(api), web: await treeContents(web) }).toEqual(roundStart);
  });
});
