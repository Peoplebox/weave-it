import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatherFacts } from "../src/lib/change-facts.js";
import { reviewCommand } from "../src/commands/review.js";
import { closeChange, createChange } from "../src/lib/changes.js";
import { pathExists } from "../src/lib/files.js";
import { pruneReviews } from "../src/lib/review/prune.js";

// Every git repo here lives in a temporary folder: prune deletes refs, and must never run
// against this repository.
const execFileAsync = promisify(execFile);
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Weave Test",
  GIT_AUTHOR_EMAIL: "weave@example.com",
  GIT_COMMITTER_NAME: "Weave Test",
  GIT_COMMITTER_EMAIL: "weave@example.com",
};

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv });
  return stdout.trim();
}

const repoIds = ["api", "web"] as const;

interface Workspace {
  base: string;
  root: string;
  session: string;
}

// A two-repo workspace (worktree checkout) without remotes, so landing is a local merge.
async function workspace(): Promise<Workspace> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-review-prune-")));
  const root = path.join(base, "acme");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await mkdir(path.join(root, ".weave"));
  await writeFile(
    path.join(root, ".weave", "workspace.yml"),
    YAML.stringify({ version: 1, mode: "workspace", name: "acme", checkout: "worktree", repos: { api: { path: "api", kind: "app" }, web: { path: "web", kind: "app" } } }),
  );
  await writeFile(path.join(root, ".gitignore"), "/api/\n/web/\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "workspace"]);
  for (const repo of repoIds) {
    const repoPath = path.join(root, repo);
    await mkdir(repoPath);
    await git(repoPath, ["init", "-q", "-b", "main"]);
    await writeFile(path.join(repoPath, "README.md"), `${repo}\n`);
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-q", "-m", "initial"]);
  }
  return { base, root, session: path.join(base, "session.yml") };
}

interface Change {
  id: string;
  folder: string;
}

async function newChange(ws: Workspace, title: string, randomId: string): Promise<Change> {
  const created = await createChange({ cwd: ws.root, title, repos: [...repoIds], randomId: () => randomId, sessionPath: ws.session });
  return { id: created.id, folder: created.folder! };
}

function checkouts(ws: Workspace, change: Change): Array<{ id: string; folder: string; main: string }> {
  return [
    { id: "root", folder: change.folder, main: ws.root },
    ...repoIds.map((id) => ({ id, folder: path.join(change.folder, id), main: path.join(ws.root, id) })),
  ];
}

async function commitWork(ws: Workspace, change: Change, label: string): Promise<void> {
  for (const checkout of checkouts(ws, change)) {
    await writeFile(path.join(checkout.folder, `${label}.txt`), `${label}\n`);
    await git(checkout.folder, ["add", "-A"]);
    await git(checkout.folder, ["commit", "-q", "-m", label]);
  }
}

// Lands the change in every repo with a merge commit in each main checkout.
async function land(ws: Workspace, change: Change): Promise<void> {
  for (const checkout of checkouts(ws, change)) {
    await git(checkout.main, ["merge", "-q", "--no-ff", "-m", "land", `change/${change.id}`]);
  }
}

async function addReviewRefs(repoPath: string, changeId: string): Promise<void> {
  await git(repoPath, ["update-ref", `refs/weave/reviews/${changeId}/01-slice/start`, "HEAD"]);
  await git(repoPath, ["update-ref", `refs/weave/reviews/${changeId}/01-slice/r1/end`, "HEAD"]);
}

async function reviewRefs(repoPath: string, changeId?: string): Promise<string[]> {
  const out = await git(repoPath, ["for-each-ref", "--format=%(refname)", changeId ? `refs/weave/reviews/${changeId}/` : "refs/weave/reviews/"]);
  return out ? out.split("\n") : [];
}

async function addPackage(checkout: string, changeId: string): Promise<string> {
  const dir = path.join(checkout, ".weave", "tmp", "reviews", changeId);
  await mkdir(path.join(dir, "01-slice"), { recursive: true });
  await writeFile(path.join(dir, "01-slice", "r1.package.md"), "# package\n");
  return dir;
}

async function allRepos(ws: Workspace): Promise<string[]> {
  return [ws.root, ...repoIds.map((id) => path.join(ws.root, id))];
}

beforeEach(() => {
  process.env.WEAVE_NO_BACKGROUND_REFRESH = "1";
});

const originalCwd = process.cwd();

afterEach(() => {
  delete process.env.WEAVE_NO_BACKGROUND_REFRESH;
  process.chdir(originalCwd);
  process.exitCode = undefined;
});

async function runPrune(cwd: string, args: string[]): Promise<{ stdout: string; exitCode: number | undefined }> {
  process.chdir(cwd);
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  });
  try {
    const command = reviewCommand();
    command.exitOverride();
    await command.parseAsync(["prune", ...args], { from: "user" });
  } finally {
    spy.mockRestore();
    process.chdir(originalCwd);
  }
  return { stdout: chunks.join(""), exitCode: process.exitCode === undefined ? undefined : Number(process.exitCode) };
}

describe("pruneReviews", () => {
  it("deletes a landed change's refs in every repo and its packages, and leaves Weave's remote refs alone", async () => {
    const ws = await workspace();
    const change = await newChange(ws, "Login", "a1b2");
    await commitWork(ws, change, "login");
    await land(ws, change);
    for (const repo of await allRepos(ws)) {
      await addReviewRefs(repo, change.id);
      await git(repo, ["update-ref", "refs/weave/remotes/origin/main", "HEAD"]);
    }
    const packages = await addPackage(change.folder, change.id);

    const result = await pruneReviews(ws.root);

    expect(result).toEqual({
      status: "ok",
      pruned: [{ change: change.id, reason: "landed", refs_deleted: { root: 2, api: 2, web: 2 }, packages_deleted: true }],
      kept: [],
    });
    for (const repo of await allRepos(ws)) {
      expect(await reviewRefs(repo)).toEqual([]);
      expect(await git(repo, ["for-each-ref", "--format=%(refname)", "refs/weave/remotes/"])).toBe("refs/weave/remotes/origin/main");
    }
    expect(await pathExists(packages)).toBe(false);
    // The change itself is untouched: branch and folder stay.
    expect(await git(ws.root, ["rev-parse", "--verify", "--quiet", `refs/heads/change/${change.id}`])).not.toBe("");
    expect(await pathExists(change.folder)).toBe(true);
  }, 60_000);

  it("keeps changes that have not fully landed", async () => {
    const ws = await workspace();
    const open = await newChange(ws, "Open", "o1o1");
    await commitWork(ws, open, "open");
    const newer = await newChange(ws, "Newer", "n1n1");
    await commitWork(ws, newer, "newer");
    await land(ws, newer);
    await commitWork(ws, newer, "more");
    const empty = await newChange(ws, "Empty", "e1e1");
    for (const change of [open, newer, empty]) {
      for (const repo of await allRepos(ws)) await addReviewRefs(repo, change.id);
      await addPackage(change.folder, change.id);
    }

    const result = await pruneReviews(ws.root);

    expect(result.pruned).toEqual([]);
    expect(result.kept).toEqual(
      expect.arrayContaining([
        { change: open.id, reason: "not_landed" },
        { change: newer.id, reason: "landed_with_newer_commits" },
        { change: empty.id, reason: "no_commits" },
      ]),
    );
    for (const repo of await allRepos(ws)) expect(await reviewRefs(repo)).toHaveLength(6);
    for (const change of [open, newer, empty]) expect(await pathExists(path.join(change.folder, ".weave", "tmp", "reviews", change.id))).toBe(true);
  }, 60_000);

  it("keeps a change whose landed check did not finish", async () => {
    const ws = await workspace();
    const change = await newChange(ws, "Login", "a1b2");
    await commitWork(ws, change, "login");
    await land(ws, change);
    await addReviewRefs(ws.root, change.id);

    const facts = await gatherFacts(ws.root, { inlineBudgetMs: -1 });
    const result = await pruneReviews(ws.root, { facts });

    expect(result).toEqual({ status: "ok", pruned: [], kept: [{ change: change.id, reason: "unchecked" }] });
    expect(await reviewRefs(ws.root)).toHaveLength(2);
  }, 60_000);

  it("prunes a change with refs but no folder, branch, planning folder, or local state as missing", async () => {
    const ws = await workspace();
    const gone = "261101-zzzz-gone";
    for (const repo of await allRepos(ws)) await addReviewRefs(repo, gone);
    await git(path.join(ws.root, "api"), ["update-ref", "refs/weave/remotes/origin/main", "HEAD"]);
    const packages = await addPackage(ws.root, gone);
    // A change whose branch survives only in Weave's copy of origin still exists.
    const remoteOnly = "261101-rrrr-remote-only";
    await addReviewRefs(path.join(ws.root, "web"), remoteOnly);
    await git(path.join(ws.root, "web"), ["update-ref", `refs/weave/remotes/origin/change/${remoteOnly}`, "HEAD"]);

    const result = await pruneReviews(ws.root);

    expect(result.pruned).toEqual([{ change: gone, reason: "missing", refs_deleted: { root: 2, api: 2, web: 2 }, packages_deleted: true }]);
    expect(result.kept).toEqual([{ change: remoteOnly, reason: "unchecked" }]);
    for (const repo of await allRepos(ws)) expect(await reviewRefs(repo, gone)).toEqual([]);
    expect(await reviewRefs(path.join(ws.root, "web"), remoteOnly)).toHaveLength(2);
    expect(await git(path.join(ws.root, "api"), ["for-each-ref", "--format=%(refname)", "refs/weave/remotes/"])).toBe("refs/weave/remotes/origin/main");
    expect(await pathExists(packages)).toBe(false);
  }, 60_000);

  it("limits pruning to one change with --change, under the same rule", async () => {
    const ws = await workspace();
    const landed = await newChange(ws, "Login", "a1b2");
    await commitWork(ws, landed, "login");
    await land(ws, landed);
    const gone = "261101-zzzz-gone";
    for (const id of [landed.id, gone]) await addReviewRefs(ws.root, id);

    expect(await pruneReviews(ws.root, { change: gone })).toEqual({
      status: "ok",
      pruned: [{ change: gone, reason: "missing", refs_deleted: { root: 2 }, packages_deleted: false }],
      kept: [],
    });
    expect(await reviewRefs(ws.root, landed.id)).toHaveLength(2);
    expect(await pruneReviews(ws.root, { change: "261101-nope-unknown" })).toEqual({ status: "ok", pruned: [], kept: [] });
  }, 60_000);
});

describe("weave review prune", () => {
  it("prints the contract JSON and a short text summary", async () => {
    const ws = await workspace();
    const landed = await newChange(ws, "Login", "a1b2");
    await commitWork(ws, landed, "login");
    await land(ws, landed);
    const open = await newChange(ws, "Open", "o1o1");
    await commitWork(ws, open, "open");
    const gone = "261101-zzzz-gone";
    for (const id of [landed.id, open.id, gone]) await addReviewRefs(path.join(ws.root, "api"), id);

    // `--change` on an open change prunes nothing, run from inside the change folder.
    const scoped = await runPrune(open.folder, ["--change", open.id, "--json"]);
    expect(scoped.exitCode).toBeUndefined();
    expect(JSON.parse(scoped.stdout)).toEqual({ status: "ok", pruned: [], kept: [{ change: open.id, reason: "not_landed" }] });

    const all = await runPrune(path.join(ws.root, "api"), ["--json"]);
    expect(JSON.parse(all.stdout)).toEqual({
      status: "ok",
      pruned: [
        { change: gone, reason: "missing", refs_deleted: { api: 2 }, packages_deleted: false },
        { change: landed.id, reason: "landed", refs_deleted: { api: 2 }, packages_deleted: false },
      ],
      kept: [{ change: open.id, reason: "not_landed" }],
    });
    expect(await reviewRefs(path.join(ws.root, "api"))).toHaveLength(2);

    await addReviewRefs(ws.root, gone);
    const text = await runPrune(ws.root, []);
    expect(text.stdout).toBe(`Pruned review refs for 1 change.\n  ${gone}  no longer exists\n`);
    expect((await runPrune(ws.root, [])).stdout).toBe("Nothing to prune.\n");
  }, 60_000);
});

describe("prune regressions", () => {
  it("leaves review refs in place when a change is closed", async () => {
    const ws = await workspace();
    const change = await newChange(ws, "Login", "a1b2");
    await commitWork(ws, change, "login");
    for (const repo of await allRepos(ws)) await addReviewRefs(repo, change.id);

    await closeChange({ cwd: ws.root, change: change.id, sessionPath: ws.session });

    expect(await pathExists(change.folder)).toBe(false);
    for (const repo of await allRepos(ws)) expect(await reviewRefs(repo, change.id)).toHaveLength(2);
    // Closed but not landed, with its branch kept: a later prune keeps it too.
    expect(await pruneReviews(ws.root)).toEqual({ status: "ok", pruned: [], kept: [{ change: change.id, reason: "not_landed" }] });
  }, 60_000);

  it("reports a repo whose ref deletion fails and continues with the other repos", async () => {
    const ws = await workspace();
    const change = await newChange(ws, "Login", "a1b2");
    await commitWork(ws, change, "login");
    await land(ws, change);
    for (const repo of await allRepos(ws)) await addReviewRefs(repo, change.id);
    const packages = await addPackage(change.folder, change.id);
    // A stale lock file makes git refuse to delete this ref in the api repo.
    const api = path.join(ws.root, "api");
    await writeFile(path.join(api, ".git", "refs", "weave", "reviews", change.id, "01-slice", "start.lock"), "");

    const result = await pruneReviews(ws.root);

    expect(result.pruned).toEqual([{ change: change.id, reason: "landed", refs_deleted: { root: 2, web: 2 }, packages_deleted: false }]);
    expect(result.kept).toEqual([{ change: change.id, reason: "error", repo: "api", message: expect.stringContaining("start.lock") }]);
    expect(await reviewRefs(ws.root)).toEqual([]);
    expect(await reviewRefs(path.join(ws.root, "web"))).toEqual([]);
    expect(await reviewRefs(api)).toHaveLength(2);
    // Packages stay until every ref is gone, so the next prune can finish the job.
    expect(await pathExists(packages)).toBe(true);
  }, 60_000);
});
