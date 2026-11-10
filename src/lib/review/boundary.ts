// Review boundaries (decision 261110-wdfo): the points a slice or fix-round review measures between.
// Until checkpoint commits exist they are snapshots of the working tree, stored as parentless commits
// under `refs/weave/reviews/`. Everything goes through `ReviewBoundary`, so a commit-based
// implementation can replace `SnapshotBoundary` later without changing the review skill.
//
// A snapshot never touches HEAD, the branch, the real index, or the stash: it stages into a
// temporary index file (seeded from a copy of the real one, so git only rehashes changed files),
// writes a tree and a commit from it, and points a ref at that commit.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ChangeCommandError } from "../change-error.js";
import { localStateDir } from "../local-state.js";

const execFileAsync = promisify(execFile);

export const reviewRefPrefix = "refs/weave/reviews";
const snapshotSubject = "weave review snapshot";
const maxOutputBytes = 512 * 1024 * 1024;

export interface BoundaryCreateInput {
  repoPath: string;
  ref: string;
  // The merge-base the snapshot is taken against, recorded in the commit message.
  mergeBase?: string;
  // Replace an existing ref instead of keeping it.
  force?: boolean;
}

export interface BoundaryCreateResult {
  ref: string;
  sha: string;
  mergeBase?: string;
  // False when an existing ref was kept.
  created: boolean;
}

export interface BoundaryDiffOptions {
  // Lines of context (`-U<n>`).
  context: number;
  // Pathspecs to leave out, such as `excludedPathspecs(...)` from rules.ts.
  exclude: string[];
  // `patch` only: a folder (relative to where the patch will be applied) prefixed to every path,
  // so one patch file can hold several repos and still apply from the workspace root.
  pathPrefix?: string;
}

export interface BoundaryDiffStat {
  files: number;
  // Added plus deleted lines; binary files count as 0.
  lines: number;
  paths: string[];
}

export interface ReviewBoundary {
  create(input: BoundaryCreateInput): Promise<BoundaryCreateResult>;
  read(repoPath: string, ref: string): Promise<{ sha: string; mergeBase?: string } | undefined>;
  // `from` and `to` are refs or commit shas (the diff base is a sha).
  diff(repoPath: string, from: string, to: string, opts: BoundaryDiffOptions): Promise<string>;
  diffStat(repoPath: string, from: string, to: string, opts: BoundaryDiffOptions): Promise<BoundaryDiffStat>;
  // Binary-safe, and reversible with `git apply -R`.
  patch(repoPath: string, from: string, to: string, opts: BoundaryDiffOptions): Promise<string>;
}

// `refs/weave/reviews/<change>/<slice>/start`.
export function sliceStartRef(changeId: string, sliceId: string): string {
  return `${reviewRefPrefix}/${changeId}/${sliceId}/start`;
}

// `refs/weave/reviews/<change>/<slice>/r<N>/round<n>-start` or `-end`: the boundaries of one fix
// round of a slice run.
export function sliceRoundRef(changeId: string, sliceId: string, run: string, round: number, point: "start" | "end"): string {
  return `${reviewRefPrefix}/${changeId}/${sliceId}/${run}/round${round}-${point}`;
}

// The folder name change runs use under `refs/weave/reviews/<change>/` and `.weave/tmp/reviews/<change>/`.
export const changeScopeId = "_change";

// `refs/weave/reviews/<change>/_change/f<N>/end`, `fix-start`, or `fix-end`: the boundaries of a
// change run and of its single fix batch.
export function changeRunRef(changeId: string, run: string, point: "end" | "fix-start" | "fix-end"): string {
  return `${reviewRefPrefix}/${changeId}/${changeScopeId}/${run}/${point}`;
}

export function snapshotMessage(mergeBase: string | undefined): string {
  return `${snapshotSubject}\n\nmerge-base: ${mergeBase ?? "unknown"}\n`;
}

// The merge-base recorded in a snapshot commit message, or undefined when it was unknown.
export function parseSnapshotMergeBase(message: string): string | undefined {
  // Snapshots record `merge-base: <sha>`; checkpoint commits carry a `Weave-Merge-Base:` trailer
  // (decision 261111-kx9x).
  const match = /^(?:merge-base|Weave-Merge-Base): ([0-9a-f]{7,64})$/m.exec(message);
  return match?.[1];
}

export class SnapshotBoundary implements ReviewBoundary {
  async create(input: BoundaryCreateInput): Promise<BoundaryCreateResult> {
    if (!input.force) {
      const existing = await this.read(input.repoPath, input.ref);
      if (existing) {
        return { ref: input.ref, sha: existing.sha, ...(existing.mergeBase ? { mergeBase: existing.mergeBase } : {}), created: false };
      }
    }

    const top = await gitOrFail(["rev-parse", "--show-toplevel"], input.repoPath);
    const realIndex = path.resolve(top, await gitOrFail(["rev-parse", "--git-path", "index"], top));
    const stateDir = await localStateDir(top);
    await mkdir(stateDir, { recursive: true });
    const tempIndex = path.join(stateDir, `review-index-${process.pid}-${randomBytes(6).toString("hex")}`);
    try {
      // Without a real index (a repo with nothing staged yet) git starts from an empty one.
      await copyFile(realIndex, tempIndex).catch(() => undefined);
      // Keep the real index's timestamps on the copy. Git treats an entry as possibly stale ("racy")
      // when the file changed no earlier than the index was written; a fresh mtime on the copy would
      // hide that, and a same-size edit made in that window would be missed.
      await stat(realIndex)
        .then((info) => utimes(tempIndex, info.atime, info.mtime))
        .catch(() => undefined);
      const env = { GIT_INDEX_FILE: tempIndex };
      const added = await git(["add", "-A"], top, env);
      if (!added.ok) {
        // A copied index git cannot use (for example a split index): start from an empty one.
        await rm(tempIndex, { force: true });
        await gitOrFail(["add", "-A"], top, env);
      }
      const tree = await gitOrFail(["write-tree"], top, env);
      const sha = await gitOrFail(["commit-tree", "--no-gpg-sign", tree, "-m", snapshotMessage(input.mergeBase)], top);
      await gitOrFail(["update-ref", input.ref, sha], top);
      return { ref: input.ref, sha, ...(input.mergeBase ? { mergeBase: input.mergeBase } : {}), created: true };
    } finally {
      await rm(tempIndex, { force: true });
      await rm(`${tempIndex}.lock`, { force: true });
    }
  }

  async read(repoPath: string, ref: string): Promise<{ sha: string; mergeBase?: string } | undefined> {
    const resolved = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoPath);
    const sha = resolved.ok ? resolved.stdout.trim() : "";
    if (!sha) {
      return undefined;
    }
    const message = await git(["log", "-1", "--format=%B", sha], repoPath);
    const mergeBase = message.ok ? parseSnapshotMergeBase(message.stdout) : undefined;
    return { sha, ...(mergeBase ? { mergeBase } : {}) };
  }

  async diff(repoPath: string, from: string, to: string, opts: BoundaryDiffOptions): Promise<string> {
    return gitRawOrFail(["diff", "--no-color", "--no-ext-diff", `-U${opts.context}`, from, to, "--", ".", ...opts.exclude], repoPath);
  }

  async diffStat(repoPath: string, from: string, to: string, opts: BoundaryDiffOptions): Promise<BoundaryDiffStat> {
    const output = await gitRawOrFail(["diff", "--numstat", "-z", "--no-renames", from, to, "--", ".", ...opts.exclude], repoPath);
    const paths: string[] = [];
    let lines = 0;
    for (const record of output.split("\0").filter(Boolean)) {
      const [added, deleted, ...rest] = record.split("\t");
      paths.push(rest.join("\t"));
      lines += (Number.parseInt(added ?? "", 10) || 0) + (Number.parseInt(deleted ?? "", 10) || 0);
    }
    return { files: paths.length, lines, paths };
  }

  async patch(repoPath: string, from: string, to: string, opts: BoundaryDiffOptions): Promise<string> {
    const prefix = opts.pathPrefix ? `${opts.pathPrefix.replace(/\/+$/, "")}/` : "";
    return gitRawOrFail(
      [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-renames",
        "--binary",
        "--full-index",
        `--src-prefix=a/${prefix}`,
        `--dst-prefix=b/${prefix}`,
        `-U${opts.context}`,
        from,
        to,
        "--",
        ".",
        ...opts.exclude,
      ],
      repoPath,
    );
  }
}

// --- git plumbing ------------------------------------------------------------------------------

interface RawResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

// Raw git output (not trimmed: patches need their trailing newline). Snapshot commits get Weave's
// identity unless the environment sets one, as elsewhere in Weave.
async function git(args: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<RawResult> {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Weave",
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "weave@example.invalid",
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Weave",
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "weave@example.invalid",
    ...extraEnv,
  };
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, env, maxBuffer: maxOutputBytes, encoding: "utf8" });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: failure.stdout ?? "", stderr: (failure.stderr || failure.message || "").trim() };
  }
}

async function gitRawOrFail(args: string[], cwd: string, extraEnv?: Record<string, string>): Promise<string> {
  const result = await git(args, cwd, extraEnv);
  if (!result.ok) {
    throw new ChangeCommandError("snapshot_failed", `git ${args[0]} failed in ${cwd}: ${result.stderr}`, {
      repoPath: cwd,
      command: `git ${args.join(" ")}`,
      stderr: result.stderr,
    });
  }
  return result.stdout;
}

async function gitOrFail(args: string[], cwd: string, extraEnv?: Record<string, string>): Promise<string> {
  return (await gitRawOrFail(args, cwd, extraEnv)).trim();
}
