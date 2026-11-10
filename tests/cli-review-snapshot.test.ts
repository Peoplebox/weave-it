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

async function initRepo(cwd: string, file = "README.md"): Promise<void> {
  await mkdir(cwd, { recursive: true });
  await git(cwd, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(cwd, file), "initial\n");
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "-m", "initial"]);
}

const taskTable = [
  "# Tasks",
  "",
  "## Active Task Index",
  "",
  "| ID | Status | Execution | Repos | Owner | Title | Blocked by |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  "| T1 | in_progress | afk | root | | Task 1 | None |",
  "",
].join("\n");

async function addSlice(changePath: string, id: string, repos: string[]): Promise<void> {
  const slicePath = path.join(changePath, "task-slices", id);
  await mkdir(slicePath, { recursive: true });
  await writeFile(
    path.join(slicePath, "status.yml"),
    YAML.stringify({ version: 1, id, title: id, status: "pending", owner: "", repos, depends_on: [], task_summary: { total: 1, done: 0, blocked: 0 } }),
  );
  await writeFile(path.join(slicePath, "tasks.md"), taskTable);
}

// A Weave root with review installed. `repos` registers workspace repos (workspace mode).
async function setup(options: { repos?: Record<string, string>; slices?: Record<string, string[]> } = {}): Promise<{ root: string; changePath: string; changeId: string }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-cli-review-snapshot-")));
  const workspace = options.repos !== undefined;
  await mkdir(path.join(root, ".weave"), { recursive: true });
  await writeFile(
    path.join(root, ".weave", "workspace.yml"),
    YAML.stringify({
      version: 1,
      mode: workspace ? "workspace" : "repo",
      name: "fixture",
      repos: Object.fromEntries(Object.entries(options.repos ?? {}).map(([id, repoPath]) => [id, { path: repoPath, kind: "app" }])),
    }),
  );
  await writeFile(
    path.join(root, ".weave", "agents.yml"),
    YAML.stringify({ version: 1, installed: { claude: { skills: { "weave-review": { path: ".claude/skills/weave-review/SKILL.md" } } } } }),
  );
  if (workspace) {
    await writeFile(path.join(root, ".gitignore"), `${Object.values(options.repos ?? {}).map((repoPath) => `/${repoPath}/`).join("\n")}\n`);
  }
  await initRepo(root);
  const session = path.join(root, ".session.yml");
  const created = await createChange({ cwd: root, title: "Review snapshot", now: testNow, randomId: () => "sn01", sessionPath: session });
  const changePath = path.join(root, "wiki", "changes", created.id);
  for (const [id, repos] of Object.entries(options.slices ?? { "02-snapshot": ["root"] })) {
    await addSlice(changePath, id, repos);
  }
  process.env.WEAVE_SESSION_PATH = session;
  process.chdir(root);
  return { root, changePath, changeId: created.id };
}

async function runJson(args: string[]): Promise<{ result: Record<string, unknown>; exitCode: number | undefined }> {
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
  return { result: JSON.parse(chunks.join("")) as Record<string, unknown>, exitCode: process.exitCode === undefined ? undefined : Number(process.exitCode) };
}

async function readSliceStatus(changePath: string, id: string): Promise<Record<string, unknown>> {
  return YAML.parse(await readFile(path.join(changePath, "task-slices", id, "status.yml"), "utf8")) as Record<string, unknown>;
}

// HEAD, branch, index file hash, porcelain status, and stash list (`--no-optional-locks` stops
// `git status` from refreshing the index itself).
async function repoFacts(repo: string): Promise<Record<string, string>> {
  const indexPath = path.resolve(repo, await git(repo, ["rev-parse", "--git-path", "index"]));
  return {
    head: await git(repo, ["rev-parse", "HEAD"]),
    branch: await git(repo, ["branch", "--show-current"]),
    index: createHash("sha1").update(await readFile(indexPath)).digest("hex"),
    status: await git(repo, ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"]),
    stash: await git(repo, ["stash", "list"]),
  };
}

async function dirty(repo: string): Promise<void> {
  await writeFile(path.join(repo, "stashed.txt"), "stash me\n");
  await git(repo, ["add", "stashed.txt"]);
  await git(repo, ["stash", "push", "-q", "-m", "fixture stash"]);
  await writeFile(path.join(repo, "staged.txt"), "staged\n");
  await git(repo, ["add", "staged.txt"]);
  await writeFile(path.join(repo, "untracked.txt"), "new\n");
}

describe("weave review snapshot --slice --at start", () => {
  it("records the start ref, keeps it on a second call, and replaces it with --force", async () => {
    const { root, changePath, changeId } = await setup();
    const ref = `refs/weave/reviews/${changeId}/02-snapshot/start`;
    const mainHead = await git(root, ["rev-parse", "main"]);
    await dirty(root);
    const before = await repoFacts(root);

    const first = await runJson(["snapshot", "--slice", "02", "--at", "start"]);
    expect(first.exitCode).toBeUndefined();
    expect(first.result).toEqual({
      status: "ok",
      slice: "02-snapshot",
      at: "start",
      start_ref: ref,
      refs: { root: ref },
      merge_base: { root: mainHead },
      created: { root: true },
      missing_repos: [],
    });
    const sha = await git(root, ["rev-parse", ref]);
    expect(await git(root, ["show", `${ref}:untracked.txt`])).toBe("new");
    expect((await readSliceStatus(changePath, "02-snapshot")).review).toMatchObject({ start_ref: ref });
    expect(await repoFacts(root)).toEqual(before);

    const status = await runJson(["status", "--slice", "02"]);
    expect(status.result).toMatchObject({ review: { start_ref: ref }, effective_state: "not_ready_for_review" });

    await writeFile(path.join(root, "untracked.txt"), "changed\n");
    const second = await runJson(["snapshot", "--slice", "02-snapshot", "--at", "start"]);
    expect(second.result).toMatchObject({ refs: { root: ref }, merge_base: { root: mainHead }, created: { root: false } });
    expect(await git(root, ["rev-parse", ref])).toBe(sha);

    const forced = await runJson(["snapshot", "--slice", "02", "--at", "start", "--force"]);
    expect(forced.result).toMatchObject({ created: { root: true } });
    expect(await git(root, ["rev-parse", ref])).not.toBe(sha);
    expect(await git(root, ["show", `${ref}:untracked.txt`])).toBe("changed");
  });

  it("adopts the change on first contact", async () => {
    const { changePath } = await setup();
    await runJson(["snapshot", "--slice", "02", "--at", "start"]);
    const change = YAML.parse(await readFile(path.join(changePath, "status.yml"), "utf8")) as { review?: { adopted_at?: string } };
    expect(typeof change.review?.adopted_at).toBe("string");
  });

  it("returns slice_not_found, no_slices, and invalid_arguments", async () => {
    const { changePath } = await setup();
    const unknown = await runJson(["snapshot", "--slice", "99", "--at", "start"]);
    expect(unknown).toMatchObject({ exitCode: 1, result: { status: "error", code: "slice_not_found" } });

    const badPoint = await runJson(["snapshot", "--slice", "02", "--at", "end"]);
    expect(badPoint).toMatchObject({ exitCode: 1, result: { status: "error", code: "invalid_arguments" } });
    process.exitCode = undefined;
    const noSlice = await runJson(["snapshot", "--at", "start"]);
    expect(noSlice).toMatchObject({ exitCode: 1, result: { status: "error", code: "invalid_arguments" } });
    // Nothing was written by the failed calls.
    expect((await readSliceStatus(changePath, "02-snapshot")).review).toBeUndefined();

    const flat = await setup({ slices: {} });
    await rm(path.join(flat.changePath, "task-slices"), { recursive: true, force: true });
    process.exitCode = undefined;
    const noSlices = await runJson(["snapshot", "--slice", "01", "--at", "start"]);
    expect(noSlices).toMatchObject({ exitCode: 1, result: { status: "error", code: "no_slices" } });
  });

  it("writes each ref into its own repo in a workspace and reports a missing checkout", async () => {
    const { root, changeId } = await setup({
      repos: { api: "api", web: "web", docs: "docs" },
      slices: { "01-both": ["api", "web", "docs"] },
    });
    const api = path.join(root, "api");
    const web = path.join(root, "web");
    await initRepo(api, "api.txt");
    await initRepo(web, "web.txt");
    await git(api, ["checkout", "-q", "-b", "change/sn01"]);
    await writeFile(path.join(api, "api.txt"), "api work\n");
    await dirty(web);
    const facts = { root: await repoFacts(root), api: await repoFacts(api), web: await repoFacts(web) };

    const { result, exitCode } = await runJson(["snapshot", "--slice", "01", "--at", "start"]);
    const ref = `refs/weave/reviews/${changeId}/01-both/start`;
    expect(exitCode).toBeUndefined();
    expect(result).toMatchObject({
      status: "ok",
      refs: { api: ref, web: ref, docs: null },
      merge_base: { api: await git(api, ["rev-parse", "main"]), web: await git(web, ["rev-parse", "main"]), docs: null },
      created: { api: true, web: true },
      missing_repos: ["docs"],
    });

    // Each ref lives in its own repo and holds that repo's files; the Weave root got none.
    expect(await git(api, ["show", `${ref}:api.txt`])).toBe("api work");
    expect(await git(web, ["show", `${ref}:untracked.txt`])).toBe("new");
    await expect(git(api, ["show", `${ref}:web.txt`])).rejects.toThrow();
    await expect(git(root, ["rev-parse", "--verify", "--quiet", ref])).rejects.toThrow();
    expect({ root: await repoFacts(root), api: await repoFacts(api), web: await repoFacts(web) }).toEqual(facts);
  });
});
