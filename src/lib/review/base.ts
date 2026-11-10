// The diff base a review measures a repo's work against (architecture § Diff base): the merge-base
// of HEAD with the change's target branch, else the recorded `checkout.repos.<repo>.base_commit`,
// else unknown. Merging the target into the change moves the merge-base forward, so the target's
// own changes drop out of the diff. Read-only: nothing here writes state or touches the index.
import { readBases } from "../change-bases.js";
import { isAncestor, mergeBase, resolveCommit, runGit } from "../git.js";
import { landedRepoInfo, resolveTarget, targetBranchName } from "../landed.js";
import { localStateDir } from "../local-state.js";

export type DiffBaseSource = "merge_base" | "base_commit" | "unknown";

export interface DiffBase {
  sha?: string;
  source: DiffBaseSource;
  // The target branch the merge-base was taken against, when one was found.
  target?: string;
}

export interface DiffBaseInput {
  // The repo checkout whose HEAD is measured (the change's worktree, or the in-place checkout).
  repoPath: string;
  repoId: string;
  // The change's parsed `status.yml`.
  changeStatus: Record<string, unknown> | undefined;
  // The main checkout of the Weave root repo, which holds the bases record.
  mainRoot: string;
}

export async function resolveDiffBase(input: DiffBaseInput): Promise<DiffBase> {
  const checkout = checkoutEntry(input.changeStatus, input.repoId);
  const target = await resolveTargetBranch(input, checkout.base);
  if (target) {
    const sha = await mergeBase(input.repoPath, "HEAD", target.sha);
    if (sha) {
      return { sha, source: "merge_base", target: target.branch };
    }
  }
  if (checkout.base_commit && (await resolveCommit(input.repoPath, checkout.base_commit))) {
    return { sha: checkout.base_commit, source: "base_commit", ...(target ? { target: target.branch } : {}) };
  }
  return { source: "unknown", ...(target ? { target: target.branch } : {}) };
}

// Files that differ between two merge-bases: what the target branch brought in when the change was
// rebased or the target was merged in between two snapshots. Later slices label these "from main".
export async function filesBetween(repoPath: string, oldBase: string, newBase: string): Promise<string[]> {
  if (oldBase === newBase) {
    return [];
  }
  const result = await runGit(["diff", "--name-only", "--no-renames", "-z", oldBase, newBase], repoPath);
  if (!result.ok) {
    throw new Error(result.stderr || `git diff ${oldBase} ${newBase} failed`);
  }
  return result.stdout.split("\0").filter(Boolean).sort();
}

// The files a rebase brought in from main between two snapshots: among `paths` (the files that
// changed between the snapshots), those that changed between the old and new merge-base and that
// the later snapshot `end` holds exactly as the new merge-base does. A file the change also edited
// differs from the new merge-base, so it stays the change's own. Empty when the merge-base did not
// move or either merge-base is unknown.
export async function filesFromMain(
  repoPath: string,
  input: { oldBase: string | undefined; newBase: string | undefined; end: string; paths: string[] },
): Promise<string[]> {
  const { oldBase, newBase } = input;
  if (!oldBase || !newBase || oldBase === newBase || input.paths.length === 0) {
    return [];
  }
  const changedOnMain = new Set(await filesBetween(repoPath, oldBase, newBase));
  const candidates = [...new Set(input.paths)].filter((file) => changedOnMain.has(file)).sort();
  const edited = new Set<string>();
  for (let start = 0; start < candidates.length; start += 200) {
    const chunk = candidates.slice(start, start + 200);
    const result = await runGit(["diff", "--name-only", "--no-renames", "-z", newBase, input.end, "--", ...chunk.map((file) => `:(literal)${file}`)], repoPath);
    if (!result.ok) {
      throw new Error(result.stderr || `git diff ${newBase} ${input.end} failed`);
    }
    for (const file of result.stdout.split("\0").filter(Boolean)) edited.add(file);
  }
  return candidates.filter((file) => !edited.has(file));
}

// Target selection follows `checkLanded`: the starting branch (bases record, then the status.yml
// checkout block), else the default branch; a stacked change whose parent already landed in the
// default branch is measured against the default branch.
async function resolveTargetBranch(input: DiffBaseInput, statusBase: string | undefined): Promise<{ branch: string; sha: string } | undefined> {
  const changeId = typeof input.changeStatus?.id === "string" ? input.changeStatus.id : undefined;
  const recorded = changeId ? (await readBases(await localStateDir(input.mainRoot), changeId))?.repos[input.repoId] : undefined;
  const startingRef = recorded && recorded.source !== "unknown" && recorded.base ? recorded.base : statusBase;
  const branch = startingRef ? targetBranchName(startingRef) : undefined;

  const { hasOrigin, defaultBranch } = await landedRepoInfo(input.repoPath);
  let resolved = branch ? await resolveTarget(input.repoPath, branch, hasOrigin) : undefined;
  if (!resolved && defaultBranch && branch !== defaultBranch) {
    resolved = await resolveTarget(input.repoPath, defaultBranch, hasOrigin);
  } else if (resolved && defaultBranch && branch !== defaultBranch) {
    const onDefault = await resolveTarget(input.repoPath, defaultBranch, hasOrigin);
    if (onDefault && (await isAncestor(input.repoPath, resolved.target.sha, onDefault.target.sha))) {
      resolved = onDefault;
    }
  }
  return resolved ? { branch: resolved.target.branch, sha: resolved.target.sha } : undefined;
}

function checkoutEntry(changeStatus: Record<string, unknown> | undefined, repoId: string): { base?: string; base_commit?: string } {
  const checkout = asRecord(changeStatus?.checkout);
  const entry = asRecord(asRecord(checkout?.repos)?.[repoId]);
  return {
    ...(typeof entry?.base === "string" && entry.base ? { base: entry.base } : {}),
    ...(typeof entry?.base_commit === "string" && entry.base_commit ? { base_commit: entry.base_commit } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
