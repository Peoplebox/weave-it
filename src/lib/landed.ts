import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BaseRepoRecord } from "./change-bases.js";
import { pathExists } from "./files.js";
import {
  cherryMarks,
  firstParentCommits,
  gitCapsKey,
  gitVersionCaps,
  isAncestor,
  mergeBase,
  mergeTreeWrite,
  onFirstParentLine,
  resolveCommit,
  resolveDefaultBase,
  revCount,
  runGit,
  treeOf,
  type GitCaps,
} from "./git.js";
import { writeFileAtomic } from "./local-state.js";

// One definition of "landed", shared by everything in Weave (ADR 261108-kl3n): a change
// has landed when merging its tip into its starting branch would change nothing.
export type LandedResult = "landed" | "landed_with_newer_commits" | "not_landed" | "no_commits" | "unchecked";
// - merged: the tip is in the target through a merge (or a fast-forward of a known base)
// - contained: the tip lies on the target's own line and the base is unknown, so a
//   fast-forward cannot be told from a branch that was never committed to
// - rebased / squashed: the target already holds the changes under different commits
export type LandedMethod = "merged" | "contained" | "rebased" | "squashed" | null;

export interface LandedTarget {
  branch: string;
  ref: string;
  sha: string;
}

export interface LandedInput {
  repoPath: string;
  repoId: string;
  changeId: string;
  // Commit sha of the change branch tip.
  tip: string;
  base: BaseRepoRecord;
  // Target branches a successful refresh found deleted on origin.
  goneTargets?: Set<string>;
}

export interface LandedOutcome {
  result: LandedResult;
  method: LandedMethod;
  reason: string | null;
  target: LandedTarget | null;
  // The default branch was used because the starting branch was unknown or gone.
  fellBack: boolean;
  // Weave's copy of origin is ahead of the user's own `origin/<t>`.
  localViewOlder: boolean;
  defaultBranch: string | null;
  cached: boolean;
}

export const newerCommitsWalkLimit = 50;
const cacheLimit = 1000;

interface CacheEntry {
  result: LandedResult;
  method: LandedMethod;
  reason: string | null;
  checked_at: string;
}

interface CacheFile {
  version: 1;
  git_caps: string;
  entries: Record<string, CacheEntry>;
}

// `landed.json` is only an optimisation: results are a pure function of the key and the
// git capabilities, it is written without the state lock, and losing a write costs one
// recomputation.
export class LandedCache {
  private dirty = false;

  private constructor(
    private readonly file: string,
    private data: CacheFile,
  ) {}

  static async load(stateDir: string, caps?: GitCaps): Promise<LandedCache> {
    const file = path.join(stateDir, "landed.json");
    const capsKey = gitCapsKey(caps ?? (await gitVersionCaps()));
    let data: CacheFile = { version: 1, git_caps: capsKey, entries: {} };
    if (await pathExists(file)) {
      try {
        const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<CacheFile>;
        if (parsed.version === 1 && parsed.git_caps === capsKey && parsed.entries && typeof parsed.entries === "object") {
          data = { version: 1, git_caps: capsKey, entries: parsed.entries };
        }
      } catch {
        // A corrupt cache is simply rebuilt.
      }
    }
    return new LandedCache(file, data);
  }

  static key(repoId: string, tip: string, targetSha: string, baseCommit: string | null): string {
    return `${repoId}:${tip}:${targetSha}:${baseCommit ?? "-"}`;
  }

  get(key: string): CacheEntry | undefined {
    return this.data.entries[key];
  }

  set(key: string, entry: CacheEntry): void {
    this.data.entries[key] = entry;
    this.dirty = true;
  }

  get size(): number {
    return Object.keys(this.data.entries).length;
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    const entries = Object.entries(this.data.entries);
    if (entries.length > cacheLimit) {
      entries.sort(([, a], [, b]) => a.checked_at.localeCompare(b.checked_at));
      this.data.entries = Object.fromEntries(entries.slice(entries.length - cacheLimit));
    }
    await writeFileAtomic(this.file, JSON.stringify(this.data));
    this.dirty = false;
  }
}

// `origin/change/worktrees` → `change/worktrees`; local names pass through.
export function targetBranchName(ref: string): string {
  return ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/origin\//, "").replace(/^origin\//, "");
}

async function hasOriginRemote(repoPath: string): Promise<boolean> {
  return (await runGit(["remote", "get-url", "origin"], repoPath)).ok;
}

async function resolveTarget(
  repoPath: string,
  branch: string,
  hasOrigin: boolean,
): Promise<{ target: LandedTarget; localViewOlder: boolean } | undefined> {
  // A merge into only the local branch never counts while there is a remote: the
  // remote is the source of truth for landing.
  if (!hasOrigin) {
    const ref = `refs/heads/${branch}`;
    const sha = await resolveCommit(repoPath, ref);
    return sha ? { target: { branch, ref, sha }, localViewOlder: false } : undefined;
  }
  const weaveRef = `refs/weave/remotes/origin/${branch}`;
  const userRef = `refs/remotes/origin/${branch}`;
  const [weaveSha, userSha] = await Promise.all([resolveCommit(repoPath, weaveRef), resolveCommit(repoPath, userRef)]);
  if (weaveSha && userSha) {
    if (weaveSha === userSha) return { target: { branch, ref: weaveRef, sha: weaveSha }, localViewOlder: false };
    if (await isAncestor(repoPath, weaveSha, userSha)) {
      return { target: { branch, ref: userRef, sha: userSha }, localViewOlder: false };
    }
    // Weave's copy is newer, or the two diverged: Weave's fetch is the more recent view.
    const weaveAhead = Boolean(await isAncestor(repoPath, userSha, weaveSha));
    return { target: { branch, ref: weaveRef, sha: weaveSha }, localViewOlder: weaveAhead };
  }
  if (weaveSha) return { target: { branch, ref: weaveRef, sha: weaveSha }, localViewOlder: false };
  if (userSha) return { target: { branch, ref: userRef, sha: userSha }, localViewOlder: false };
  return undefined;
}

type CommitCheck = { landed: true; method: Exclude<LandedMethod, null> } | { landed: false } | { unknown: string };

// Whether one commit's work is already in the target, by ancestry or by tree equality.
async function commitLanded(repoPath: string, commit: string, target: LandedTarget, targetTree: string, caps: GitCaps): Promise<CommitCheck> {
  const ancestor = await isAncestor(repoPath, commit, target.sha);
  if (ancestor === undefined) return { unknown: "git merge-base failed" };
  if (ancestor) return { landed: true, method: "merged" };

  const marks = await cherryMarks(repoPath, target.sha, commit);
  if (!caps.mergeTreeWrite) {
    if (marks && marks.length > 0 && marks.every((mark) => mark === "-")) return { landed: true, method: "rebased" };
    return { unknown: "git 2.38+ is needed to detect squash merges" };
  }
  const merged = await mergeTreeWrite(repoPath, target.sha, commit);
  if (!merged.tree) return { unknown: merged.error ?? "merge-tree failed" };
  if (merged.tree !== targetTree) return { landed: false };
  const rebased = Boolean(marks && marks.length > 0 && marks.every((mark) => mark === "-"));
  return { landed: true, method: rebased ? "rebased" : "squashed" };
}

export interface LandedRepoInfo {
  hasOrigin: boolean;
  defaultBranch: string | undefined;
}

// Facts about a repo that every change in it shares; callers checking many changes look
// them up once.
export async function landedRepoInfo(repoPath: string): Promise<LandedRepoInfo> {
  const [hasOrigin, base] = await Promise.all([hasOriginRemote(repoPath), resolveDefaultBase(repoPath, { fetch: false })]);
  return { hasOrigin, defaultBranch: base?.branch };
}

export async function checkLanded(
  input: LandedInput,
  options: { cache?: LandedCache; caps?: GitCaps; repoInfo?: LandedRepoInfo } = {},
): Promise<LandedOutcome> {
  const empty = { target: null, fellBack: false, localViewOlder: false, defaultBranch: null, cached: false };
  try {
    const caps = options.caps ?? (await gitVersionCaps());
    const { hasOrigin, defaultBranch } = options.repoInfo ?? (await landedRepoInfo(input.repoPath));

    // 1. Target: the starting branch, or the default branch when it's unknown or gone.
    let branch = input.base.base ? targetBranchName(input.base.base) : undefined;
    let fellBack = !branch;
    if (branch && input.goneTargets?.has(branch)) {
      branch = undefined;
      fellBack = true;
    }
    let resolved = branch ? await resolveTarget(input.repoPath, branch, hasOrigin) : undefined;
    if (!resolved && defaultBranch && branch !== defaultBranch) {
      fellBack = true;
      resolved = await resolveTarget(input.repoPath, defaultBranch, hasOrigin);
    }
    if (!resolved) {
      return { ...empty, result: "unchecked", method: null, reason: "couldn't find the branch to compare against", fellBack, defaultBranch: defaultBranch ?? null };
    }
    const { target, localViewOlder } = resolved;
    const outcome = (result: LandedResult, method: LandedMethod, reason: string | null, cached = false): LandedOutcome => ({
      result,
      method,
      reason,
      target,
      fellBack,
      localViewOlder,
      defaultBranch: defaultBranch ?? null,
      cached,
    });

    // A recorded fork point that no longer exists (garbage-collected) counts as unknown.
    const baseCommit = input.base.base_commit && (await resolveCommit(input.repoPath, input.base.base_commit)) ? input.base.base_commit : null;
    const key = LandedCache.key(input.repoId, input.tip, target.sha, baseCommit);
    const hit = options.cache?.get(key);
    if (hit) return outcome(hit.result, hit.method, hit.reason, true);

    const computed = await computeLanded(input.repoPath, input.tip, target, baseCommit, caps);
    if (computed.result !== "unchecked") {
      options.cache?.set(key, { ...computed, checked_at: new Date().toISOString() });
    }
    return outcome(computed.result, computed.method, computed.reason);
  } catch (error) {
    return { ...empty, result: "unchecked", method: null, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function computeLanded(
  repoPath: string,
  tip: string,
  target: LandedTarget,
  baseCommit: string | null,
  caps: GitCaps,
): Promise<{ result: LandedResult; method: LandedMethod; reason: string | null }> {
  // 2. No commits: only meaningful against a known fork point. Without one, the merge
  //    base of an already-merged branch is its own tip and would read as empty.
  if (baseCommit) {
    const count = await revCount(repoPath, `${baseCommit}..${tip}`);
    if (count === undefined) return { result: "unchecked", method: null, reason: "git rev-list failed" };
    if (count === 0) return { result: "no_commits", method: null, reason: null };
  }

  const targetTree = await treeOf(repoPath, target.sha);
  if (!targetTree) return { result: "unchecked", method: null, reason: `couldn't read ${target.branch}` };

  // 3 and 4. The tip itself: merged, rebased, or squashed.
  const tipCheck = await commitLanded(repoPath, tip, target, targetTree, caps);
  if ("landed" in tipCheck && tipCheck.landed) {
    let method: LandedMethod = tipCheck.method;
    if (method === "merged" && !baseCommit) {
      const onLine = await onFirstParentLine(repoPath, tip, target.sha);
      if (onLine) method = "contained";
    }
    return { result: "landed", method, reason: null };
  }

  // 5. Newer commits: walk back along the branch for a commit whose work landed.
  const from = baseCommit ?? (await mergeBase(repoPath, target.sha, tip));
  const range = from ? `${from}..${tip}` : tip;
  const commits = await firstParentCommits(repoPath, range, newerCommitsWalkLimit + 1);
  if (!commits) return { result: "unchecked", method: null, reason: "git rev-list failed" };
  for (const commit of commits.slice(1)) {
    const check = await commitLanded(repoPath, commit, target, targetTree, caps);
    if ("landed" in check && check.landed) {
      return { result: "landed_with_newer_commits", method: check.method, reason: null };
    }
  }

  // Without a fork point, a true merge followed by more commits moves the merge base up to
  // the merged commit. A merge base that reached the target through a merge commit's side
  // parent, rather than along its own line, is branch work that landed.
  if (!baseCommit && from && from !== tip) {
    const onLine = await onFirstParentLine(repoPath, from, target.sha);
    if (onLine === false) return { result: "landed_with_newer_commits", method: "merged", reason: null };
  }

  if ("unknown" in tipCheck) return { result: "unchecked", method: null, reason: tipCheck.unknown };
  return { result: "not_landed", method: null, reason: null };
}
