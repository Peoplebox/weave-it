import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { readBases, recordBases, recoverBase, rejectReflogBase, resolveChangeBase, type BaseRepoRecord } from "../src/lib/change-bases.js";
import { gitVersionCaps } from "../src/lib/git.js";
import { checkLanded, LandedCache, newerCommitsWalkLimit } from "../src/lib/landed.js";
import { localStateDir } from "../src/lib/local-state.js";

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

interface Repo {
  base: string;
  work: string;
  origin: string;
}

// A clone with a bare file-path origin. `main` has one commit holding `file.txt`.
async function repoFixture(): Promise<Repo> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-landed-")));
  const origin = path.join(base, "origin.git");
  await mkdir(origin);
  await git(origin, ["init", "--bare", "-b", "main"]);
  const work = path.join(base, "work");
  await git(base, ["clone", "--quiet", origin, "work"]);
  await git(work, ["checkout", "-q", "-b", "main"]).catch(() => undefined);
  await writeFile(path.join(work, "file.txt"), "one\ntwo\nthree\n");
  await git(work, ["add", "."]);
  await git(work, ["commit", "-q", "-m", "initial"]);
  await git(work, ["push", "-q", "-u", "origin", "main"]);
  await git(work, ["remote", "set-head", "origin", "main"]);
  return { base, work, origin };
}

async function commitFile(cwd: string, name: string, content: string, message = `edit ${name}`): Promise<string> {
  await writeFile(path.join(cwd, name), content);
  await git(cwd, ["add", name]);
  await git(cwd, ["commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

// Starts change/<id> from origin/main with two commits, then returns to main.
async function changeBranch(repo: Repo, id: string): Promise<{ tip: string; base: BaseRepoRecord }> {
  const baseCommit = await git(repo.work, ["rev-parse", "origin/main"]);
  await git(repo.work, ["checkout", "-q", "-b", `change/${id}`, baseCommit]);
  await commitFile(repo.work, `${id}-a.txt`, "a\n");
  const tip = await commitFile(repo.work, `${id}-b.txt`, "b\n");
  await git(repo.work, ["checkout", "-q", "main"]);
  return { tip, base: { base: "origin/main", base_commit: baseCommit, source: "created" } };
}

async function pushMain(repo: Repo): Promise<void> {
  await git(repo.work, ["push", "-q", "origin", "main"]);
  await git(repo.work, ["fetch", "-q", "origin"]);
}

const unknownBase: BaseRepoRecord = { base: null, base_commit: null, source: "unknown" };

function input(repo: Repo, id: string, tip: string, base: BaseRepoRecord) {
  return { repoPath: repo.work, repoId: "root", changeId: id, tip, base };
}

afterEach(() => {
  delete process.env.WEAVE_TEST_GIT_NO_MERGE_TREE;
});

describe("checkLanded", () => {
  it("recognises a normal merge", async () => {
    const repo = await repoFixture();
    const { tip, base } = await changeBranch(repo, "a");
    await git(repo.work, ["merge", "-q", "--no-ff", "-m", "merge a", "change/a"]);
    await pushMain(repo);

    const outcome = await checkLanded(input(repo, "a", tip, base));
    expect(outcome).toMatchObject({ result: "landed", method: "merged", target: { branch: "main" }, fellBack: false });
  });

  it("recognises a squash merge", async () => {
    const repo = await repoFixture();
    const { tip, base } = await changeBranch(repo, "a");
    await git(repo.work, ["merge", "-q", "--squash", "change/a"]);
    await git(repo.work, ["commit", "-q", "-m", "squash a"]);
    await pushMain(repo);

    expect(await checkLanded(input(repo, "a", tip, base))).toMatchObject({ result: "landed", method: "squashed" });
  });

  it("recognises a rebase merge", async () => {
    const repo = await repoFixture();
    const { tip, base } = await changeBranch(repo, "a");
    await commitFile(repo.work, "other.txt", "other\n");
    await git(repo.work, ["cherry-pick", `${base.base_commit}..change/a`]);
    await pushMain(repo);

    expect(await checkLanded(input(repo, "a", tip, base))).toMatchObject({ result: "landed", method: "rebased" });
  });

  it("finds newer commits after a squash merge", async () => {
    const repo = await repoFixture();
    const { base } = await changeBranch(repo, "a");
    await git(repo.work, ["merge", "-q", "--squash", "change/a"]);
    await git(repo.work, ["commit", "-q", "-m", "squash a"]);
    await pushMain(repo);
    await git(repo.work, ["checkout", "-q", "change/a"]);
    const tip = await commitFile(repo.work, "later.txt", "later\n");
    await git(repo.work, ["checkout", "-q", "main"]);

    expect(await checkLanded(input(repo, "a", tip, base))).toMatchObject({ result: "landed_with_newer_commits", method: "squashed" });
  });

  it("finds newer commits after a normal merge when the base is unknown", async () => {
    const repo = await repoFixture();
    await changeBranch(repo, "a");
    await git(repo.work, ["merge", "-q", "--no-ff", "-m", "merge a", "change/a"]);
    await pushMain(repo);
    await git(repo.work, ["checkout", "-q", "change/a"]);
    const tip = await commitFile(repo.work, "later.txt", "later\n");
    await git(repo.work, ["checkout", "-q", "main"]);

    expect(await checkLanded(input(repo, "a", tip, unknownBase))).toMatchObject({ result: "landed_with_newer_commits", method: "merged" });
  });

  it("reports no commits for an empty branch with a known base", async () => {
    const repo = await repoFixture();
    const baseCommit = await git(repo.work, ["rev-parse", "origin/main"]);
    const base: BaseRepoRecord = { base: "origin/main", base_commit: baseCommit, source: "created" };

    expect(await checkLanded(input(repo, "a", baseCommit, base))).toMatchObject({ result: "no_commits", method: null });
  });

  it("calls a merged branch with an unknown base landed, not empty", async () => {
    const repo = await repoFixture();
    const { tip } = await changeBranch(repo, "a");
    await git(repo.work, ["merge", "-q", "--no-ff", "-m", "merge a", "change/a"]);
    await pushMain(repo);

    expect(await checkLanded(input(repo, "a", tip, unknownBase))).toMatchObject({ result: "landed", method: "merged", fellBack: true });
  });

  it("calls an empty branch with an unknown base contained, never merged", async () => {
    const repo = await repoFixture();
    const tip = await git(repo.work, ["rev-parse", "origin/main"]);
    await commitFile(repo.work, "next.txt", "next\n");
    await pushMain(repo);

    expect(await checkLanded(input(repo, "a", tip, unknownBase))).toMatchObject({ result: "landed", method: "contained" });
  });

  it("measures a stacked change against its parent branch", async () => {
    const repo = await repoFixture();
    await git(repo.work, ["checkout", "-q", "-b", "change/parent"]);
    await commitFile(repo.work, "parent.txt", "parent\n");
    await git(repo.work, ["push", "-q", "-u", "origin", "change/parent"]);
    const parentTip = await git(repo.work, ["rev-parse", "HEAD"]);
    await git(repo.work, ["checkout", "-q", "-b", "change/child"]);
    await commitFile(repo.work, "child.txt", "child\n");
    // Two commits, so the squash can't be mistaken for a one-commit rebase.
    const tip = await commitFile(repo.work, "child-2.txt", "child 2\n");
    await git(repo.work, ["checkout", "-q", "change/parent"]);
    await git(repo.work, ["merge", "-q", "--squash", "change/child"]);
    await git(repo.work, ["commit", "-q", "-m", "squash child"]);
    await git(repo.work, ["push", "-q", "origin", "change/parent"]);
    await git(repo.work, ["checkout", "-q", "main"]);
    const base: BaseRepoRecord = { base: "origin/change/parent", base_commit: parentTip, source: "created" };

    expect(await checkLanded(input(repo, "child", tip, base))).toMatchObject({
      result: "landed",
      method: "squashed",
      target: { branch: "change/parent" },
      fellBack: false,
    });
  });

  it("falls back to the default branch when the starting branch is gone on origin", async () => {
    const repo = await repoFixture();
    const { tip, base } = await changeBranch(repo, "a");
    await git(repo.work, ["merge", "-q", "--no-ff", "-m", "merge a", "change/a"]);
    await pushMain(repo);
    const stacked: BaseRepoRecord = { ...base, base: "origin/change/gone" };

    const outcome = await checkLanded({ ...input(repo, "a", tip, stacked), goneTargets: new Set(["change/gone"]) });
    expect(outcome).toMatchObject({ result: "landed", target: { branch: "main" }, fellBack: true });
  });

  it("says not landed when the target later edited the same lines", async () => {
    const repo = await repoFixture();
    const baseCommit = await git(repo.work, ["rev-parse", "origin/main"]);
    await git(repo.work, ["checkout", "-q", "-b", "change/a"]);
    const tip = await commitFile(repo.work, "file.txt", "one\nTWO\nthree\n");
    await git(repo.work, ["checkout", "-q", "main"]);
    await git(repo.work, ["merge", "-q", "--squash", "change/a"]);
    await git(repo.work, ["commit", "-q", "-m", "squash a"]);
    await commitFile(repo.work, "file.txt", "one\nTWO!\nthree\n");
    await pushMain(repo);

    const outcome = await checkLanded(input(repo, "a", tip, { base: "origin/main", base_commit: baseCommit, source: "created" }));
    expect(outcome).toMatchObject({ result: "not_landed" });
  });

  it("never counts a merge into the local branch only", async () => {
    const repo = await repoFixture();
    const { tip, base } = await changeBranch(repo, "a");
    await git(repo.work, ["merge", "-q", "--no-ff", "-m", "merge a", "change/a"]);

    expect(await checkLanded(input(repo, "a", tip, base))).toMatchObject({ result: "not_landed", target: { ref: "refs/remotes/origin/main" } });
  });

  it("compares local branches in a repo with no remote", async () => {
    const repo = await repoFixture();
    await git(repo.work, ["remote", "remove", "origin"]);
    const baseCommit = await git(repo.work, ["rev-parse", "main"]);
    await git(repo.work, ["checkout", "-q", "-b", "change/a"]);
    const tip = await commitFile(repo.work, "a.txt", "a\n");
    await git(repo.work, ["checkout", "-q", "main"]);
    await git(repo.work, ["merge", "-q", "--no-ff", "-m", "merge a", "change/a"]);

    const outcome = await checkLanded(input(repo, "a", tip, { base: "main", base_commit: baseCommit, source: "created" }));
    expect(outcome).toMatchObject({ result: "landed", method: "merged", target: { ref: "refs/heads/main" } });
  });

  it("stops looking for newer commits after the walk limit", async () => {
    const repo = await repoFixture();
    const { base } = await changeBranch(repo, "a");
    await git(repo.work, ["merge", "-q", "--squash", "change/a"]);
    await git(repo.work, ["commit", "-q", "-m", "squash a"]);
    await pushMain(repo);
    await git(repo.work, ["checkout", "-q", "change/a"]);
    let tip = "";
    for (let index = 0; index <= newerCommitsWalkLimit; index += 1) {
      tip = await commitFile(repo.work, "later.txt", `later ${index}\n`);
    }
    await git(repo.work, ["checkout", "-q", "main"]);

    // The landed commit sits one step past the limit, so the walk never reaches it.
    expect(await checkLanded(input(repo, "a", tip, base))).toMatchObject({ result: "not_landed" });
  }, 60_000);

  it("still recognises normal and rebase merges without merge-tree (git < 2.38)", async () => {
    process.env.WEAVE_TEST_GIT_NO_MERGE_TREE = "1";
    const repo = await repoFixture();
    const merged = await changeBranch(repo, "a");
    await git(repo.work, ["merge", "-q", "--no-ff", "-m", "merge a", "change/a"]);
    const rebased = await changeBranch(repo, "b");
    await git(repo.work, ["cherry-pick", `${rebased.base.base_commit}..change/b`]);
    const squashed = await changeBranch(repo, "c");
    await git(repo.work, ["merge", "-q", "--squash", "change/c"]);
    await git(repo.work, ["commit", "-q", "-m", "squash c"]);
    await pushMain(repo);

    expect(await checkLanded(input(repo, "a", merged.tip, merged.base))).toMatchObject({ result: "landed", method: "merged" });
    expect(await checkLanded(input(repo, "b", rebased.tip, rebased.base))).toMatchObject({ result: "landed", method: "rebased" });
    expect(await checkLanded(input(repo, "c", squashed.tip, squashed.base))).toMatchObject({
      result: "unchecked",
      reason: "git 2.38+ is needed to detect squash merges",
    });
  });

  it("writes no objects into the user's object store", async () => {
    const repo = await repoFixture();
    const { tip, base } = await changeBranch(repo, "a");
    await git(repo.work, ["merge", "-q", "--squash", "change/a"]);
    await git(repo.work, ["commit", "-q", "-m", "squash a"]);
    await pushMain(repo);
    const before = await git(repo.work, ["count-objects", "-v"]);

    expect(await checkLanded(input(repo, "a", tip, base))).toMatchObject({ result: "landed", method: "squashed" });
    expect(await git(repo.work, ["count-objects", "-v"])).toBe(before);
  });

  it("caches results and drops them when git capabilities change", async () => {
    const repo = await repoFixture();
    const { tip, base } = await changeBranch(repo, "a");
    await git(repo.work, ["merge", "-q", "--squash", "change/a"]);
    await git(repo.work, ["commit", "-q", "-m", "squash a"]);
    await pushMain(repo);
    const stateDir = await localStateDir(repo.work);
    await mkdir(stateDir, { recursive: true });

    const first = await LandedCache.load(stateDir);
    expect(await checkLanded(input(repo, "a", tip, base), { cache: first })).toMatchObject({ result: "landed", cached: false });
    await first.save();

    const second = await LandedCache.load(stateDir);
    expect(await checkLanded(input(repo, "a", tip, base), { cache: second })).toMatchObject({ result: "landed", method: "squashed", cached: true });

    process.env.WEAVE_TEST_GIT_NO_MERGE_TREE = "1";
    const afterUpgrade = await LandedCache.load(stateDir, await gitVersionCaps());
    expect(afterUpgrade.size).toBe(0);
  });

  it("misses the cache when the target moves", async () => {
    const repo = await repoFixture();
    const { tip, base } = await changeBranch(repo, "a");
    const stateDir = await localStateDir(repo.work);
    await mkdir(stateDir, { recursive: true });
    const cache = await LandedCache.load(stateDir);
    expect(await checkLanded(input(repo, "a", tip, base), { cache })).toMatchObject({ result: "not_landed" });

    await git(repo.work, ["merge", "-q", "--no-ff", "-m", "merge a", "change/a"]);
    await pushMain(repo);
    expect(await checkLanded(input(repo, "a", tip, base), { cache })).toMatchObject({ result: "landed", cached: false });
  });
});

describe("starting-branch memory", () => {
  it("rejects reflog values that don't name a starting branch", () => {
    expect(rejectReflogBase("0a2d3e82ac305032a2aa0add6bcd0614a5f4b782", "x")).toBe("sha");
    expect(rejectReflogBase("HEAD", "x")).toBe("head");
    expect(rejectReflogBase("origin/change/x", "x")).toBe("self");
    expect(rejectReflogBase("change/x", "x")).toBe("self");
    expect(rejectReflogBase("origin/main", "x")).toBeUndefined();
    expect(rejectReflogBase("origin/change/parent", "x")).toBeUndefined();
  });

  it("recovers an add_new branch's base from the folder's status.yml", async () => {
    const repo = await repoFixture();
    const baseCommit = await git(repo.work, ["rev-parse", "origin/main"]);
    const folder = path.join(repo.base, "folder");
    await git(repo.work, ["worktree", "add", "-q", "--no-track", "-b", "change/x", folder, baseCommit]);
    const statusPath = path.join(folder, "status.yml");
    await writeFile(statusPath, YAML.stringify({ checkout: { mode: "worktree", repos: { root: { path: ".", base: "origin/main", base_commit: baseCommit } } } }));

    expect(await recoverBase({ repoPath: repo.work, repoId: "root", changeId: "x", statusPath })).toEqual({
      base: "origin/main",
      base_commit: baseCommit,
      source: "created",
    });
    // Without the folder, the reflog only has the sha: the fork point is kept, the branch is unknown.
    expect(await recoverBase({ repoPath: repo.work, repoId: "root", changeId: "x" })).toEqual({
      base: null,
      base_commit: baseCommit,
      source: "unknown",
    });
  });

  it("rejects an add_tracking branch's own remote branch as its base", async () => {
    const repo = await repoFixture();
    await git(repo.work, ["push", "-q", "origin", "main:change/y"]);
    await git(repo.work, ["fetch", "-q", "origin"]);
    await git(repo.work, ["branch", "--track", "change/y", "origin/change/y"]);

    expect(await recoverBase({ repoPath: repo.work, repoId: "root", changeId: "y" })).toEqual({ base: null, base_commit: null, source: "unknown" });
  });

  it("keeps the fork point but not HEAD for a checkout -b branch", async () => {
    const repo = await repoFixture();
    const head = await git(repo.work, ["rev-parse", "HEAD"]);
    await git(repo.work, ["checkout", "-q", "-b", "change/z"]);
    await git(repo.work, ["checkout", "-q", "main"]);

    expect(await recoverBase({ repoPath: repo.work, repoId: "root", changeId: "z" })).toEqual({ base: null, base_commit: head, source: "unknown" });
  });

  it("recovers a named starting branch from the reflog", async () => {
    const repo = await repoFixture();
    const head = await git(repo.work, ["rev-parse", "origin/main"]);
    await git(repo.work, ["branch", "--no-track", "change/w", "origin/main"]);

    expect(await recoverBase({ repoPath: repo.work, repoId: "root", changeId: "w" })).toEqual({ base: "origin/main", base_commit: head, source: "reflog" });
  });

  it("records a recovered base once and upgrades an unknown one from status.yml", async () => {
    const repo = await repoFixture();
    await git(repo.work, ["push", "-q", "origin", "main:change/v"]);
    await git(repo.work, ["fetch", "-q", "origin"]);
    await git(repo.work, ["branch", "--track", "change/v", "origin/change/v"]);
    const stateDir = await localStateDir(repo.work);

    expect(await resolveChangeBase({ mainRoot: repo.work, repoPath: repo.work, repoId: "root", changeId: "v" })).toMatchObject({ source: "unknown" });
    expect((await readBases(stateDir, "v"))?.repos.root).toMatchObject({ source: "unknown" });

    const statusPath = path.join(repo.base, "status.yml");
    const baseCommit = await git(repo.work, ["rev-parse", "origin/main"]);
    await writeFile(statusPath, YAML.stringify({ checkout: { repos: { root: { base: "origin/main", base_commit: baseCommit } } } }));
    expect(await resolveChangeBase({ mainRoot: repo.work, repoPath: repo.work, repoId: "root", changeId: "v", statusPath })).toMatchObject({
      base: "origin/main",
      source: "created",
    });
    expect((await readBases(stateDir, "v"))?.repos.root).toMatchObject({ source: "created" });
  });

  it("never lets a recovered record replace a created one", async () => {
    const repo = await repoFixture();
    const stateDir = await localStateDir(repo.work);
    await recordBases(repo.work, "u", { root: { base: "origin/main", base_commit: "abc", source: "created" } });
    await recordBases(repo.work, "u", { root: { base: "origin/other", base_commit: "def", source: "reflog" } });

    expect((await readBases(stateDir, "u"))?.repos.root).toEqual({ base: "origin/main", base_commit: "abc", source: "created" });
  });
});
