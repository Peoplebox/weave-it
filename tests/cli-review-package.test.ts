import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewCommand } from "../src/commands/review.js";
import { createChange } from "../src/lib/changes.js";
import { buildSlicePackage } from "../src/lib/review/package.js";
import { reviewContextForChangePath } from "../src/lib/review/state.js";

const execFileAsync = promisify(execFile);
const testNow = new Date(2026, 10, 10, 10, 0, 0);
const originalCwd = process.cwd();
const originalSessionEnv = process.env.WEAVE_SESSION_PATH;
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
  repos: string;
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
    ...tasks.map((task) => `| ${task.id} | ${task.status} | afk | ${task.repos} | | Task ${task.id} | None |`),
    "",
  ];
  for (const task of tasks) {
    lines.push(`### ${task.id}: Task ${task.id}`, "", `Status: ${task.status}`, `Repos: ${task.repos}`, "Files:", ...task.files.map((file) => `- \`${file}\` (M)`), "");
    lines.push("### What to build", "", "Build it.", "", "### Verification", "", ...(task.verification ?? ["- Automated tests: passed"]), "");
  }
  lines.push("## QA Findings", "", "None.", "");
  return lines.join("\n");
}

async function writeSlice(changePath: string, id: string, repos: string[], tasks: TaskSpec[], review?: Record<string, unknown>): Promise<void> {
  const slicePath = path.join(changePath, "task-slices", id);
  await mkdir(slicePath, { recursive: true });
  await writeFile(
    path.join(slicePath, "status.yml"),
    YAML.stringify({ version: 1, id, title: id, status: "in_progress", owner: "", repos, depends_on: [], task_summary: { total: tasks.length, done: 0, blocked: 0 }, ...(review ? { review } : {}) }),
  );
  await writeFile(path.join(slicePath, "slice.md"), `# ${id}\n`);
  await writeFile(path.join(slicePath, "tasks.md"), tasksMarkdown(tasks));
}

async function setTasks(changePath: string, id: string, tasks: TaskSpec[]): Promise<void> {
  await writeFile(path.join(changePath, "task-slices", id, "tasks.md"), tasksMarkdown(tasks));
}

// A Weave root with review installed. `repos` registers workspace repos (workspace mode).
async function setup(options: { repos?: Record<string, string>; enabled?: boolean } = {}): Promise<{ root: string; changePath: string; changeId: string }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-cli-review-package-")));
  const workspace = options.repos !== undefined;
  await mkdir(path.join(root, ".weave"), { recursive: true });
  await writeFile(
    path.join(root, ".weave", "workspace.yml"),
    YAML.stringify({
      version: 1,
      mode: workspace ? "workspace" : "repo",
      name: "fixture",
      repos: Object.fromEntries(Object.entries(options.repos ?? {}).map(([id, repoPath]) => [id, { path: repoPath, kind: "app" }])),
      ...(options.enabled === false ? { review: { enabled: false } } : {}),
    }),
  );
  await writeFile(
    path.join(root, ".weave", "agents.yml"),
    YAML.stringify({ version: 1, installed: { claude: { skills: { "weave-review": { path: ".claude/skills/weave-review/SKILL.md" } } } } }),
  );
  if (workspace) {
    await writeFile(path.join(root, ".gitignore"), `${Object.values(options.repos ?? {}).map((repoPath) => `/${repoPath}/`).join("\n")}\n`);
  }
  await initRepo(root, { "README.md": "initial\n", "src/owned/a.ts": "export const a = 1;\n", "src/other/b.ts": "export const b = 1;\n" });
  const session = path.join(root, ".session.yml");
  const created = await createChange({ cwd: root, title: "Review package", now: testNow, randomId: () => "pk02", sessionPath: session });
  // Commit the scaffold createChange wrote and make it the target branch's tip, so a fallback diff
  // holds only what each test changes.
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "scaffold"]);
  if ((await git(root, ["branch", "--show-current"])) !== "main") {
    await git(root, ["branch", "-f", "main", "HEAD"]);
  }
  process.env.WEAVE_SESSION_PATH = session;
  process.chdir(root);
  return { root, changePath: path.join(root, "wiki", "changes", created.id), changeId: created.id };
}

async function run(args: string[]): Promise<{ result: Record<string, unknown>; exitCode: number | undefined }> {
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

async function sliceReview(changePath: string, id: string): Promise<Record<string, unknown> | undefined> {
  const status = YAML.parse(await readFile(path.join(changePath, "task-slices", id, "status.yml"), "utf8")) as { review?: Record<string, unknown> };
  return status.review;
}

// HEAD, branch, index file hash, and stash list: packaging must leave all of them alone.
async function repoFacts(repo: string): Promise<Record<string, string>> {
  const indexPath = path.resolve(repo, await git(repo, ["rev-parse", "--git-path", "index"]));
  return {
    head: await git(repo, ["rev-parse", "HEAD"]),
    branch: await git(repo, ["branch", "--show-current"]),
    index: createHash("sha1").update(await readFile(indexPath)).digest("hex"),
    stash: await git(repo, ["stash", "list"]),
  };
}

function section(text: string, heading: string, next: string): string {
  const start = text.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(next, start + heading.length);
  return text.slice(start, end === -1 ? undefined : end);
}

const ownedTask = (status: string, extra: Partial<TaskSpec> = {}): TaskSpec => ({ id: "T1", status, repos: "root", files: ["src/owned/"], ...extra });

describe("weave review package --slice (repo mode)", () => {
  it("packages a ready slice between its start and end snapshots, labels foreign files, and sets in_review", async () => {
    const { root, changePath, changeId } = await setup();
    await writeSlice(changePath, "02-work", ["root"], [ownedTask("in_progress")]);
    expect((await run(["snapshot", "--slice", "02", "--at", "start"])).exitCode).toBeUndefined();

    await writeFile(path.join(root, "src", "owned", "a.ts"), "export const a = 2;\n");
    await writeFile(path.join(root, "src", "owned", "new.ts"), "export const fresh = true;\n");
    await writeFile(path.join(root, "src", "other", "b.ts"), "export const b = 2;\n");
    await writeFile(path.join(changePath, "notes.md"), "planning notes\n");
    await setTasks(changePath, "02-work", [
      ownedTask("done"),
      { id: "T2", status: "not_tested", repos: "root", files: ["src/owned/new.ts"], verification: ["- Human check: click through the new screen"] },
    ]);
    const before = await repoFacts(root);

    const { result, exitCode } = await run(["package", "--slice", "02"]);
    expect(exitCode).toBeUndefined();
    const packagePath = path.join(root, ".weave", "tmp", "reviews", changeId, "02-work", "r1.package.md");
    expect(result).toEqual({
      // No build commit exists for the slice in this fixture, so the end boundary is a snapshot
      // (decision 261111-kx9x).
      boundary: { root: { kind: "snapshot", reason: "build_not_committed" } },
      status: "ok",
      run_id: "02-work/r1",
      package_path: packagePath,
      scope: { kind: "slice", slice: "02-work" },
      partial: false,
      partial_reasons: [],
      fallback_base: null,
      foreign_files: 1,
      model_level: "mid",
      size_hint: { files: 3, lines: 5 },
      settled_rulings: 0,
      reopened_rulings: 0,
      from_main_files: 0,
      warnings: [],
    });
    expect(await repoFacts(root)).toEqual(before);

    const endRef = `refs/weave/reviews/${changeId}/02-work/r1/end`;
    expect(await git(root, ["show", `${endRef}:src/owned/new.ts`])).toBe("export const fresh = true;");
    expect(await sliceReview(changePath, "02-work")).toMatchObject({ state: "in_review", latest_run: "r1", partial: false });

    const text = await readFile(packagePath, "utf8");
    expect(text).toContain(`- From: start snapshot \`refs/weave/reviews/${changeId}/02-work/start\``);
    expect(text).toContain(`- To: end snapshot \`${endRef}\``);
    expect(text).toContain("n/a (snapshots");
    const owned = section(text, "#### Slice files", "#### Possibly another slice's work");
    expect(owned).toContain("+export const a = 2;");
    expect(owned).toContain("src/owned/new.ts");
    expect(owned).not.toContain("src/other/b.ts");
    const foreign = section(text, "#### Possibly another slice's work", "## Context");
    expect(foreign).toContain("+export const b = 2;");
    expect(foreign).not.toContain("src/owned/");
    expect(text.slice(0, text.indexOf("## Context"))).not.toContain("notes.md");
    expect(section(text, "### Untested tasks", "### Human checks")).toContain("- T2: Task T2");
    expect(section(text, "### Human checks (needs your check)", "\n\n\n")).toContain("- T2: click through the new screen");
    expect(text).toContain("no shared guidelines found");

    const status = await run(["status", "--slice", "02"]);
    expect(status.result).toMatchObject({ stored_state: "in_review", review: { latest_run: "r1" } });
  });

  it("returns slice_not_ready for a todo task and packages it as partial with --partial", async () => {
    const { changePath } = await setup();
    await writeSlice(changePath, "02-work", ["root"], [ownedTask("done"), { id: "T2", status: "todo", repos: "root", files: ["src/owned/"] }]);

    const refused = await run(["package", "--slice", "02"]);
    expect(refused).toMatchObject({ exitCode: 1, result: { status: "error", code: "slice_not_ready", details: { tasks: [{ id: "T2", status: "todo" }] } } });
    expect(await sliceReview(changePath, "02-work")).toBeUndefined();

    const partial = await run(["package", "--slice", "02", "--partial"]);
    expect(partial.exitCode).toBeUndefined();
    expect(partial.result).toMatchObject({ run_id: "02-work/r1", partial: true, partial_reasons: ["tasks not ready for review: T2 (todo)"] });
    expect(await sliceReview(changePath, "02-work")).toMatchObject({ state: "in_review", partial: true });
  });

  it("falls back to the change base without a start snapshot, and warns when a named start ref is missing", async () => {
    const { root, changePath, changeId } = await setup();
    const mainHead = await git(root, ["rev-parse", "main"]);
    await writeSlice(changePath, "01-before", ["root"], [ownedTask("done")]);
    await writeFile(path.join(root, "src", "owned", "a.ts"), "export const a = 3;\n");

    const fallback = await run(["package", "--slice", "01"]);
    expect(fallback.result).toMatchObject({ fallback_base: "merge_base", partial: false, warnings: [], size_hint: { files: 1, lines: 2 } });
    const text = await readFile(String(fallback.result.package_path), "utf8");
    expect(text).toContain(`- From: fallback base: change base, merge-base with \`main\` (${mainHead.slice(0, 12)}); the slice has no start snapshot`);

    await writeSlice(changePath, "02-elsewhere", ["root"], [ownedTask("done")], { start_ref: `refs/weave/reviews/${changeId}/02-elsewhere/start` });
    const missing = await run(["package", "--slice", "02"]);
    expect(missing.result).toMatchObject({ fallback_base: "merge_base", partial: false, warnings: ["start_ref_missing_on_this_machine"] });
    expect(await readFile(String(missing.result.package_path), "utf8")).toContain("the start snapshot is missing on this machine");
  });

  it("writes the package partial with base_unknown when there is no diff base at all", async () => {
    const { root, changePath } = await setup();
    // No target branch and no recorded base commit.
    expect(await git(root, ["branch", "--show-current"])).not.toBe("main");
    await git(root, ["branch", "-q", "-D", "main"]);
    const status = YAML.parse(await readFile(path.join(changePath, "status.yml"), "utf8")) as Record<string, unknown>;
    delete status.checkout;
    await writeFile(path.join(changePath, "status.yml"), YAML.stringify(status));
    await writeSlice(changePath, "01-work", ["root"], [ownedTask("done")]);

    const { result, exitCode } = await run(["package", "--slice", "01"]);
    expect(result).toMatchObject({ status: "ok", partial: true, warnings: ["base_unknown"], fallback_base: null, size_hint: { files: 0, lines: 0 } });
    expect(exitCode).toBeUndefined();
    expect(await readFile(String(result.package_path), "utf8")).toContain("no diff base (base_unknown)");
  });

  it("refuses when review is off unless --force, when the change is skipped, and in flat mode", async () => {
    const off = await setup({ enabled: false });
    await writeSlice(off.changePath, "01-work", ["root"], [ownedTask("done")]);
    expect(await run(["package", "--slice", "01"])).toMatchObject({ exitCode: 1, result: { code: "review_disabled" } });
    const forced = await run(["package", "--slice", "01", "--force"]);
    expect(forced).toMatchObject({ exitCode: undefined, result: { status: "ok", run_id: "01-work/r1" } });

    const skipped = await setup();
    await writeSlice(skipped.changePath, "01-work", ["root"], [ownedTask("done")]);
    const status = YAML.parse(await readFile(path.join(skipped.changePath, "status.yml"), "utf8")) as Record<string, unknown>;
    await writeFile(path.join(skipped.changePath, "status.yml"), YAML.stringify({ ...status, review: { skipped: { reason: "docs only", at: testNow.toISOString() } } }));
    expect(await run(["package", "--slice", "01"])).toMatchObject({ exitCode: 1, result: { code: "change_review_skipped" } });

    const flat = await setup();
    await rm(path.join(flat.changePath, "task-slices"), { recursive: true, force: true });
    expect(await run(["package", "--slice", "01"])).toMatchObject({ exitCode: 1, result: { code: "no_slices" } });
    await writeSlice(flat.changePath, "01-work", ["root"], [ownedTask("done")]);
    expect(await run(["package", "--slice", "09"])).toMatchObject({ exitCode: 1, result: { code: "slice_not_found" } });
    expect(await run(["package"])).toMatchObject({ exitCode: 1, result: { code: "invalid_arguments" } });
  });

  it("allocates distinct run ids for concurrent calls and continues after earlier runs", async () => {
    const { changePath } = await setup();
    await writeSlice(changePath, "01-work", ["root"], [ownedTask("done")]);
    const ctx = reviewContextForChangePath(changePath);
    if (!ctx) throw new Error("bad fixture");

    const results = await Promise.all([buildSlicePackage(ctx, "01"), buildSlicePackage(ctx, "01")]);
    expect(results.map((result) => result.run_id).sort()).toEqual(["01-work/r1", "01-work/r2"]);

    // A recorded report for a later run (from another machine) moves the counter past it.
    await mkdir(path.join(changePath, "task-slices", "01-work", "review"), { recursive: true });
    await writeFile(path.join(changePath, "task-slices", "01-work", "review", "r5.report.md"), "report\n");
    expect((await buildSlicePackage(ctx, "01")).run_id).toBe("01-work/r6");
  });
});

describe("weave review package --slice (workspace mode)", () => {
  it("diffs each repo, prefixes paths with the repo id, lists guidelines per repo, and goes partial for a missing checkout", async () => {
    const { root, changePath, changeId } = await setup({ repos: { api: "api", web: "web", docs: "docs" } });
    const api = path.join(root, "api");
    const web = path.join(root, "web");
    await initRepo(api, { "server/routes.ts": "export const routes = [];\n", "server/db.ts": "export const db = 1;\n" });
    await initRepo(web, { "app/page.tsx": "export const page = 1;\n" });
    await mkdir(path.join(root, ".weave"), { recursive: true });
    await writeFile(path.join(root, ".weave", "coding-guidelines.md"), "# Shared\n");
    await mkdir(path.join(api, ".weave"), { recursive: true });
    await writeFile(path.join(api, ".weave", "coding-guidelines.md"), "# API rules\n");
    await git(api, ["add", "-A"]);
    await git(api, ["commit", "-q", "-m", "guidelines"]);

    await writeSlice(changePath, "03-both", ["api", "web", "docs"], [
      { id: "T1", status: "in_progress", repos: "api", files: ["server/routes.ts"] },
      { id: "T2", status: "in_progress", repos: "web", files: ["web/app/"] },
    ]);
    expect((await run(["snapshot", "--slice", "03", "--at", "start"])).result).toMatchObject({ missing_repos: ["docs"] });

    await writeFile(path.join(api, "server", "routes.ts"), "export const routes = ['/users'];\n");
    await writeFile(path.join(api, "server", "db.ts"), "export const db = 2;\n");
    await writeFile(path.join(web, "app", "page.tsx"), "export const page = 2;\n");
    await setTasks(changePath, "03-both", [
      { id: "T1", status: "done", repos: "api", files: ["server/routes.ts"] },
      { id: "T2", status: "done", repos: "web", files: ["web/app/"] },
    ]);
    const facts = { api: await repoFacts(api), web: await repoFacts(web) };

    const { result, exitCode } = await run(["package", "--slice", "03"]);
    expect(exitCode).toBeUndefined();
    expect(result).toMatchObject({
      run_id: "03-both/r1",
      partial: true,
      partial_reasons: ["repo docs is not checked out here"],
      fallback_base: null,
      foreign_files: 1,
      size_hint: { files: 3, lines: 6 },
      warnings: ["missing_repo_checkout"],
    });
    expect({ api: await repoFacts(api), web: await repoFacts(web) }).toEqual(facts);
    expect(await git(api, ["rev-parse", "--verify", `refs/weave/reviews/${changeId}/03-both/r1/end`])).toMatch(/^[0-9a-f]{40}$/);
    expect(await git(web, ["rev-parse", "--verify", `refs/weave/reviews/${changeId}/03-both/r1/end`])).toMatch(/^[0-9a-f]{40}$/);

    const text = await readFile(String(result.package_path), "utf8");
    expect(section(text, "## Diff stat", "## Diff\n")).toContain("- api:server/routes.ts\n- api:server/db.ts (possibly another slice's work)\n- web:app/page.tsx");
    const apiDiff = section(text, "### api\n\n#### Slice files", "### web");
    expect(apiDiff).toContain("+export const routes = ['/users'];");
    expect(section(apiDiff, "#### Possibly another slice's work", "### web")).toContain("+export const db = 2;");
    expect(section(text, "## Boundaries", "## Commits")).toContain("### docs\n\n- Not checked out here");
    const guidelines = section(text, "### Coding guidelines", "### Task evidence");
    expect(guidelines).toContain("- Shared: `.weave/coding-guidelines.md`");
    expect(guidelines).toContain("- api: `api/.weave/coding-guidelines.md`");
    expect(guidelines).toContain("- web: `web/.weave/coding-guidelines.md` (absent)");
    expect(guidelines).toContain("- Not checked out here, guidelines unknown: docs");
  });
});
