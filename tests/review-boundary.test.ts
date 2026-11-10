import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { localStateDir } from "../src/lib/local-state.js";
import { parseSnapshotMergeBase, SnapshotBoundary, sliceStartRef, snapshotMessage } from "../src/lib/review/boundary.js";
import { excludedPathspecs } from "../src/lib/review/rules.js";

const execFileAsync = promisify(execFile);
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Weave Test",
  GIT_AUTHOR_EMAIL: "weave@example.com",
  GIT_COMMITTER_NAME: "Weave Test",
  GIT_COMMITTER_EMAIL: "weave@example.com",
};

async function git(cwd: string, args: string[], input?: string): Promise<string> {
  if (input !== undefined) {
    return new Promise((resolve, reject) => {
      const child = execFile("git", args, { cwd, env: gitEnv }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim())));
      child.stdin?.end(input);
    });
  }
  const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv });
  return stdout.trim();
}

async function write(cwd: string, name: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
  await writeFile(path.join(cwd, name), content);
}

// A repo on main with tracked.txt, .gitignore (ignoring *.log), and a change folder file.
async function repoFixture(): Promise<string> {
  const repo = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-review-boundary-")));
  await git(repo, ["init", "-q", "-b", "main"]);
  await write(repo, "tracked.txt", "one\n");
  await write(repo, ".gitignore", "*.log\n");
  await write(repo, "wiki/changes/c1/status.yml", "id: c1\n");
  await write(repo, "image.bin", Buffer.from([0, 1, 2, 3, 255, 254, 0, 9]));
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "initial"]);
  return repo;
}

async function treeFiles(repo: string, ref: string): Promise<Record<string, string>> {
  const listing = await git(repo, ["ls-tree", "-r", "--name-only", ref]);
  const files: Record<string, string> = {};
  for (const name of listing.split("\n").filter(Boolean)) {
    files[name] = await git(repo, ["show", `${ref}:${name}`]);
  }
  return files;
}

async function tempIndexes(repo: string): Promise<string[]> {
  const entries = await readdir(await localStateDir(repo)).catch(() => [] as string[]);
  return entries.filter((name) => name.startsWith("review-index-"));
}

// HEAD, branch, index file hash, porcelain status, and stash list. `--no-optional-locks` keeps
// `git status` itself from refreshing the index file.
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

// Leaves a stash entry, a staged file, an unstaged edit, and an untracked file.
async function dirty(repo: string): Promise<void> {
  await write(repo, "stashed.txt", "stash me\n");
  await git(repo, ["add", "stashed.txt"]);
  await git(repo, ["stash", "push", "-q", "-m", "fixture stash"]);
  await write(repo, "staged.txt", "staged\n");
  await git(repo, ["add", "staged.txt"]);
  await write(repo, "tracked.txt", "one\ntwo\n");
  await write(repo, "untracked.txt", "new\n");
  await write(repo, "debug.log", "ignored\n");
}

const boundary = new SnapshotBoundary();
const exclude = excludedPathspecs("");

describe("SnapshotBoundary.create", () => {
  it("captures modified, staged, and untracked files and honours .gitignore", async () => {
    const repo = await repoFixture();
    await dirty(repo);
    const ref = sliceStartRef("c1", "02-snap");
    const created = await boundary.create({ repoPath: repo, ref, mergeBase: await git(repo, ["rev-parse", "HEAD"]) });
    expect(created).toMatchObject({ ref, created: true });

    const files = await treeFiles(repo, ref);
    expect(files["tracked.txt"]).toBe("one\ntwo");
    expect(files["staged.txt"]).toBe("staged");
    expect(files["untracked.txt"]).toBe("new");
    expect(files).not.toHaveProperty("debug.log");
    expect(files).not.toHaveProperty("stashed.txt");
    // Parentless commit, with the merge-base in its message.
    expect(await git(repo, ["rev-list", "--parents", "-n", "1", ref])).toBe(created.sha);
    expect(await tempIndexes(repo)).toEqual([]);
  });

  it("keeps an existing ref unless forced, and reads back the recorded merge-base", async () => {
    const repo = await repoFixture();
    const head = await git(repo, ["rev-parse", "HEAD"]);
    const ref = sliceStartRef("c1", "02-snap");
    const first = await boundary.create({ repoPath: repo, ref, mergeBase: head });
    expect(await boundary.read(repo, ref)).toEqual({ sha: first.sha, mergeBase: head });

    await write(repo, "tracked.txt", "changed\n");
    const again = await boundary.create({ repoPath: repo, ref });
    expect(again).toEqual({ ref, sha: first.sha, mergeBase: head, created: false });

    const forced = await boundary.create({ repoPath: repo, ref, force: true });
    expect(forced.created).toBe(true);
    expect(forced.sha).not.toBe(first.sha);
    expect(await boundary.read(repo, ref)).toEqual({ sha: forced.sha });
    expect(await boundary.read(repo, `${ref}-missing`)).toBeUndefined();
  });

  it("removes the temporary index when git fails", async () => {
    const repo = await repoFixture();
    await expect(boundary.create({ repoPath: repo, ref: "refs/weave/reviews/bad..ref" })).rejects.toMatchObject({ code: "snapshot_failed" });
    expect(await tempIndexes(repo)).toEqual([]);
  });

  it("captures a same-size edit that the index still sees as clean by its stat data", async () => {
    // The racy case: the file and the index share a timestamp, so only a content check can tell the
    // edit apart. The temporary index must keep the real index's timestamp for git to make that check.
    const repo = await repoFixture();
    await git(repo, ["config", "core.trustctime", "false"]);
    const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    await utimes(path.join(repo, "tracked.txt"), stamp, stamp);
    await git(repo, ["add", "tracked.txt"]);
    await writeFile(path.join(repo, "tracked.txt"), "two\n");
    await utimes(path.join(repo, "tracked.txt"), stamp, stamp);
    await utimes(path.join(repo, ".git", "index"), stamp, stamp);

    const created = await boundary.create({ repoPath: repo, ref: sliceStartRef("c1", "01") });
    expect((await treeFiles(repo, created.ref))["tracked.txt"]).toBe("two");
  });

  it("works in a repo with no commits and no index yet", async () => {
    const repo = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-review-boundary-empty-")));
    await git(repo, ["init", "-q", "-b", "main"]);
    await write(repo, "a.txt", "a\n");
    const created = await boundary.create({ repoPath: repo, ref: sliceStartRef("c1", "01") });
    expect(Object.keys(await treeFiles(repo, created.ref))).toEqual(["a.txt"]);
  });
});

describe("snapshot messages", () => {
  it("round-trips the merge-base and reads unknown as absent", () => {
    const sha = "a".repeat(40);
    expect(parseSnapshotMergeBase(snapshotMessage(sha))).toBe(sha);
    expect(parseSnapshotMergeBase(snapshotMessage(undefined))).toBeUndefined();
  });
});

describe("diffs and patches between boundaries", () => {
  async function twoSnapshots(): Promise<{ repo: string; start: string; end: string }> {
    const repo = await repoFixture();
    const start = (await boundary.create({ repoPath: repo, ref: "refs/weave/reviews/c1/02/start" })).ref;
    await write(repo, "tracked.txt", "one\nchanged\n");
    await write(repo, "added.txt", "added\n");
    await write(repo, "image.bin", Buffer.from([9, 0, 8, 0, 7, 0, 255]));
    await rm(path.join(repo, ".gitignore"));
    await write(repo, "wiki/changes/c1/status.yml", "id: c1\nreview: {}\n");
    await write(repo, "wiki/changes/c1/notes.md", "notes\n");
    const end = (await boundary.create({ repoPath: repo, ref: "refs/weave/reviews/c1/02/r1/end" })).ref;
    return { repo, start, end };
  }

  it("never includes wiki/changes in diffs, stats, or patches", async () => {
    const { repo, start, end } = await twoSnapshots();
    const diff = await boundary.diff(repo, start, end, { context: 10, exclude });
    expect(diff).toContain("tracked.txt");
    expect(diff).toContain("added.txt");
    expect(diff).not.toContain("wiki/changes");

    const stat = await boundary.diffStat(repo, start, end, { context: 10, exclude });
    expect(stat.paths.sort()).toEqual([".gitignore", "added.txt", "image.bin", "tracked.txt"]);
    expect(stat.files).toBe(4);
    expect(stat.lines).toBe(3);

    const patch = await boundary.patch(repo, start, end, { context: 3, exclude });
    expect(patch).not.toContain("wiki/changes");
    expect(patch).toContain("GIT binary patch");

    // The diff base may be a commit sha.
    const head = await git(repo, ["rev-parse", "HEAD"]);
    expect(await boundary.diff(repo, head, end, { context: 3, exclude })).not.toContain("wiki/changes");
  });

  it("produces a patch that git apply -R reverses to the earlier tree", async () => {
    const { repo, start, end } = await twoSnapshots();
    const patch = await boundary.patch(repo, start, end, { context: 3, exclude });
    await git(repo, ["apply", "-R", "--binary"], patch);

    const restored = (await boundary.create({ repoPath: repo, ref: "refs/weave/reviews/c1/02/restored" })).ref;
    expect(await boundary.diff(repo, start, restored, { context: 3, exclude })).toBe("");
    // The excluded change folder edits stay in place.
    expect(await readFile(path.join(repo, "wiki/changes/c1/notes.md"), "utf8")).toBe("notes\n");
  });
});

describe("snapshots leave the checkout untouched", () => {
  it("in a plain repo", async () => {
    const repo = await repoFixture();
    await dirty(repo);
    const before = await repoFacts(repo);
    await boundary.create({ repoPath: repo, ref: sliceStartRef("c1", "02") });
    await boundary.create({ repoPath: repo, ref: sliceStartRef("c1", "02"), force: true });
    expect(await repoFacts(repo)).toEqual(before);
  });

  it("from a linked worktree, writing the ref into the shared object store", async () => {
    const repo = await repoFixture();
    const worktree = path.join(path.dirname(repo), `${path.basename(repo)}-wt`);
    await git(repo, ["worktree", "add", "-q", "-b", "change/c1", worktree]);
    await dirty(worktree);
    const mainBefore = await repoFacts(repo);
    const before = await repoFacts(worktree);

    const created = await boundary.create({ repoPath: worktree, ref: sliceStartRef("c1", "02") });
    expect(await repoFacts(worktree)).toEqual(before);
    expect(await repoFacts(repo)).toEqual(mainBefore);

    // The ref is visible from the main checkout and holds the worktree's files, not main's.
    expect(await git(repo, ["rev-parse", sliceStartRef("c1", "02")])).toBe(created.sha);
    const files = await treeFiles(repo, created.ref);
    expect(files["untracked.txt"]).toBe("new");
    expect(files["tracked.txt"]).toBe("one\ntwo");
    expect(await tempIndexes(repo)).toEqual([]);
  });
});
