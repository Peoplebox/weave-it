import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { recordBases } from "../src/lib/change-bases.js";
import { filesBetween, resolveDiffBase } from "../src/lib/review/base.js";

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

async function commitFile(cwd: string, name: string, content: string): Promise<string> {
  await mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
  await writeFile(path.join(cwd, name), content);
  await git(cwd, ["add", name]);
  await git(cwd, ["commit", "-q", "-m", `edit ${name}`]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

// A local repo (no origin) whose first branch is `branch`, with one commit, then on change/<id>.
async function localRepo(branch = "main"): Promise<{ repo: string; first: string }> {
  const repo = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-review-base-")));
  await git(repo, ["init", "-q", "-b", branch]);
  await git(repo, ["config", "init.defaultBranch", branch]);
  const first = await commitFile(repo, "file.txt", "one\n");
  await git(repo, ["checkout", "-q", "-b", "change/c1"]);
  await commitFile(repo, "change.txt", "work\n");
  return { repo, first };
}

const status = (checkout?: Record<string, unknown>) => ({ id: "c1", ...(checkout ? { checkout: { mode: "worktree", repos: { root: checkout } } } : {}) });

describe("resolveDiffBase", () => {
  it("resolves an in-place change without base_commit through the merge-base with the default branch", async () => {
    const { repo, first } = await localRepo();
    const base = await resolveDiffBase({ repoPath: repo, repoId: "root", changeStatus: status(), mainRoot: repo });
    expect(base).toEqual({ sha: first, source: "merge_base", target: "main" });
  });

  it("uses the starting branch from the status.yml checkout block, measured on origin when there is one", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-review-base-origin-")));
    const origin = path.join(root, "origin.git");
    await mkdir(origin);
    await git(origin, ["init", "-q", "--bare", "-b", "main"]);
    const work = path.join(root, "work");
    await git(root, ["clone", "-q", origin, "work"]);
    await git(work, ["checkout", "-q", "-B", "main"]);
    await commitFile(work, "file.txt", "one\n");
    await git(work, ["push", "-q", "-u", "origin", "main"]);
    await git(work, ["checkout", "-q", "-b", "develop"]);
    const developTip = await commitFile(work, "develop.txt", "d\n");
    await git(work, ["push", "-q", "-u", "origin", "develop"]);
    await git(work, ["checkout", "-q", "-b", "change/c1"]);
    await commitFile(work, "change.txt", "work\n");

    const base = await resolveDiffBase({ repoPath: work, repoId: "root", changeStatus: status({ base: "origin/develop" }), mainRoot: work });
    expect(base).toEqual({ sha: developTip, source: "merge_base", target: "develop" });
  });

  it("prefers the recorded bases file over the status.yml checkout block", async () => {
    const { repo } = await localRepo();
    await git(repo, ["checkout", "-q", "-b", "develop", "main"]);
    const developTip = await commitFile(repo, "develop.txt", "d\n");
    await git(repo, ["checkout", "-q", "-b", "change/c2"]);
    await commitFile(repo, "work.txt", "w\n");
    await recordBases(repo, "c1", { root: { base: "develop", base_commit: developTip, source: "created" } });

    const base = await resolveDiffBase({ repoPath: repo, repoId: "root", changeStatus: status({ base: "main" }), mainRoot: repo });
    expect(base).toMatchObject({ sha: developTip, source: "merge_base", target: "develop" });
  });

  it("falls back to base_commit when no target branch is reachable, then to unknown", async () => {
    // No main or master and a starting branch that does not exist: there is no target.
    const { repo, first } = await localRepo("trunk");
    await git(repo, ["config", "init.defaultBranch", "nowhere"]);

    const withCommit = await resolveDiffBase({ repoPath: repo, repoId: "root", changeStatus: status({ base: "gone", base_commit: first }), mainRoot: repo });
    expect(withCommit).toEqual({ sha: first, source: "base_commit" });

    const without = await resolveDiffBase({ repoPath: repo, repoId: "root", changeStatus: status({ base: "gone" }), mainRoot: repo });
    expect(without).toEqual({ source: "unknown" });

    // A recorded base_commit that no longer exists counts as unknown too.
    const missing = await resolveDiffBase({
      repoPath: repo,
      repoId: "root",
      changeStatus: status({ base: "gone", base_commit: "0123456789abcdef0123456789abcdef01234567" }),
      mainRoot: repo,
    });
    expect(missing).toEqual({ source: "unknown" });
  });

  it("moves the base forward when the target is merged into the change branch", async () => {
    const { repo, first } = await localRepo();
    const before = await resolveDiffBase({ repoPath: repo, repoId: "root", changeStatus: status(), mainRoot: repo });
    expect(before.sha).toBe(first);

    await git(repo, ["checkout", "-q", "main"]);
    const mainTip = await commitFile(repo, "main-only.txt", "m\n");
    await git(repo, ["checkout", "-q", "change/c1"]);
    await git(repo, ["merge", "-q", "--no-edit", "main"]);

    const after = await resolveDiffBase({ repoPath: repo, repoId: "root", changeStatus: status({ base_commit: first }), mainRoot: repo });
    expect(after).toEqual({ sha: mainTip, source: "merge_base", target: "main" });
  });
});

describe("filesBetween", () => {
  it("lists exactly the files the target changed between two merge-bases after a rebase", async () => {
    const { repo, first } = await localRepo();
    await git(repo, ["checkout", "-q", "main"]);
    await commitFile(repo, "src/a.ts", "a\n");
    await commitFile(repo, "file.txt", "one\ntwo\n");
    await git(repo, ["checkout", "-q", "change/c1"]);
    await commitFile(repo, "change-two.txt", "more\n");
    await git(repo, ["rebase", "-q", "main"]);

    const after = await resolveDiffBase({ repoPath: repo, repoId: "root", changeStatus: status(), mainRoot: repo });
    expect(after.sha).not.toBe(first);
    expect(await filesBetween(repo, first, after.sha as string)).toEqual(["file.txt", "src/a.ts"]);
    expect(await filesBetween(repo, first, first)).toEqual([]);
  });
});
