// `weave review snapshot --slice <id> --at start [--force] [--json]`: records the slice's start
// boundary, a snapshot of the working tree in every repo the slice touches, and stores the ref name
// as `review.start_ref`. `--run <run> --at round-start --round <n>` records a fix round's start
// boundary instead (see `src/lib/review/rounds.ts`). It never touches HEAD, the branch, the index,
// or the stash.
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import YAML from "yaml";
import { ChangeCommandError } from "../../lib/changes.js";
import { pathExists } from "../../lib/files.js";
import { mainWorktreePath, probeGitRoot } from "../../lib/git.js";
import { resolveDiffBase } from "../../lib/review/base.js";
import { startFixRound, type RoundStartResult } from "../../lib/review/rounds.js";
import { SnapshotBoundary, sliceStartRef, type ReviewBoundary } from "../../lib/review/boundary.js";
import { adoptChange, changeRepoIds, resolveSlice, updateSliceReview, type ReviewContext, type SliceLocation } from "../../lib/review/state.js";
import { readWorkspaceMetadata } from "../../lib/workspace-repos.js";
import { rootRepoId } from "../../lib/worktrees.js";
import { activeReviewContext, runAction, writeResult } from "./shared.js";

interface ReviewSnapshotOptions {
  slice?: string;
  run?: string;
  round?: string;
  at?: string;
  force?: boolean;
  json?: boolean;
}

export interface ReviewSnapshotResult {
  status: "ok";
  slice: string;
  at: "start";
  start_ref: string;
  // Per repo: the ref, or null when the repo is not checked out here.
  refs: Record<string, string | null>;
  // Per repo: the merge-base the snapshot was taken against, or null when it is unknown.
  merge_base: Record<string, string | null>;
  // Per repo: false when an existing start ref was kept.
  created: Record<string, boolean>;
  missing_repos: string[];
}

export interface SliceRepoCheckout {
  id: string;
  // Undefined when the repo is not checked out locally.
  path?: string;
}

export function registerReviewSnapshot(review: Command): void {
  review
    .command("snapshot")
    .description("Record a review boundary: a snapshot of the working tree under refs/weave/reviews/.")
    .option("--slice <id>", "the slice, by folder name or leading number (with --at start)")
    .option("--run <run>", "the review run, such as 02/r1 (with --at round-start)")
    .option("--at <point>", "the boundary to record: start (a slice) or round-start (a fix round of a run)")
    .option("--round <n>", "round-start: the fix round, from 1")
    .option("--force", "replace an existing snapshot (round-start: restart the latest round)")
    .option("--json", "print machine-readable JSON")
    .action(async (options: ReviewSnapshotOptions) => {
      const json = options.json ?? false;
      await runAction(json, async () => {
        const ctx = await activeReviewContext();
        if (options.run !== undefined) {
          const result = await reviewRoundSnapshot(ctx, options);
          writeResult(result, json, renderRoundSnapshot(result));
          return;
        }
        const result = await reviewSnapshot(ctx, options);
        writeResult(result, json, renderReviewSnapshot(result));
      });
    });
}

// `--run <run> --at round-start --round <n>`.
export async function reviewRoundSnapshot(
  ctx: ReviewContext,
  options: { slice?: string; run?: string; at?: string; round?: string; force?: boolean },
  boundary: ReviewBoundary = new SnapshotBoundary(),
): Promise<RoundStartResult> {
  if (options.slice !== undefined || options.run === undefined) {
    throw new ChangeCommandError("invalid_arguments", "Pass either --slice <id> --at start or --run <run> --at round-start --round <n>, not both.");
  }
  if (options.at !== "round-start") {
    throw new ChangeCommandError("invalid_arguments", `--run takes --at round-start, not ${options.at === undefined ? "nothing" : `--at ${options.at}`}.`, {
      at: options.at ?? null,
    });
  }
  return startFixRound(ctx, { run: options.run, round: options.round, ...(options.force ? { force: true } : {}) }, boundary);
}

export function renderRoundSnapshot(result: RoundStartResult): string {
  const lines = [`${result.run} round ${result.round}: ${result.ref}`];
  for (const [repo, ref] of Object.entries(result.refs)) {
    if (ref === null) {
      lines.push(`  ${repo}: not checked out here, skipped`);
      continue;
    }
    const base = result.merge_base[repo];
    lines.push(`  ${repo}: recorded (merge-base ${base ? base.slice(0, 12) : "unknown"})`);
  }
  return lines.join("\n");
}

export async function reviewSnapshot(
  ctx: ReviewContext,
  options: { slice?: string; at?: string; force?: boolean },
  boundary: ReviewBoundary = new SnapshotBoundary(),
): Promise<ReviewSnapshotResult> {
  if (options.slice === undefined) {
    throw new ChangeCommandError("invalid_arguments", "Pass --slice <id> --at start, or --run <run> --at round-start --round <n>.");
  }
  if (options.at !== "start") {
    throw new ChangeCommandError("invalid_arguments", `--slice takes --at start, not ${options.at === undefined ? "nothing" : `--at ${options.at}`}.`, {
      at: options.at ?? null,
    });
  }
  const slice = await resolveSlice(ctx, options.slice);
  await adoptChange(ctx);

  const ref = sliceStartRef(ctx.changeId, slice.id);
  const mainRoot = (await mainWorktreePath(ctx.weaveRoot)) ?? ctx.weaveRoot;
  const changeStatus = await readYamlRecord(path.join(ctx.changePath, "status.yml"));
  const result: ReviewSnapshotResult = {
    status: "ok",
    slice: slice.id,
    at: "start",
    start_ref: ref,
    refs: {},
    merge_base: {},
    created: {},
    missing_repos: [],
  };

  for (const repo of await sliceRepoCheckouts(ctx, slice)) {
    if (!repo.path) {
      result.refs[repo.id] = null;
      result.merge_base[repo.id] = null;
      result.missing_repos.push(repo.id);
      continue;
    }
    const base = await resolveDiffBase({ repoPath: repo.path, repoId: repo.id, changeStatus, mainRoot });
    const snapshot = await boundary.create({ repoPath: repo.path, ref, ...(base.sha ? { mergeBase: base.sha } : {}), force: options.force ?? false });
    result.refs[repo.id] = snapshot.ref;
    result.merge_base[repo.id] = snapshot.mergeBase ?? null;
    result.created[repo.id] = snapshot.created;
  }

  if (Object.values(result.refs).some((value) => value !== null)) {
    await updateSliceReview(ctx, slice.id, (block) => ({ ...(block ?? {}), start_ref: ref }));
  }
  return result;
}

// The repos a slice lists in `repos:` (root when it lists none), each with its checkout in the
// change's folder: the Weave root for `root`, the registered path for the others. A repo that is
// not registered, not on disk, or not its own git repo is reported without a path.
export async function sliceRepoCheckouts(ctx: ReviewContext, slice: SliceLocation): Promise<SliceRepoCheckout[]> {
  const status = await readYamlRecord(slice.statusPath);
  const listed = Array.isArray(status?.repos) ? status.repos.filter((id): id is string => typeof id === "string" && id.trim() !== "").map((id) => id.trim()) : [];
  return repoCheckouts(ctx, listed.length > 0 ? [...new Set(listed)] : [rootRepoId]);
}

// Every repo the change touches (`changeRepoIds`), each with its checkout in the change's folder.
export async function changeRepoCheckouts(ctx: ReviewContext): Promise<SliceRepoCheckout[]> {
  return repoCheckouts(ctx, await changeRepoIds(ctx));
}

// The local checkout of each repo id (`root` is the Weave root), with no path when the repo is not
// checked out here.
export async function repoCheckouts(ctx: ReviewContext, ids: string[]): Promise<SliceRepoCheckout[]> {
  const metadata = await readWorkspaceMetadata(ctx.weaveRoot);
  const checkouts: SliceRepoCheckout[] = [];
  for (const id of ids) {
    const entry = metadata?.repos[id];
    const candidate = id === rootRepoId ? ctx.weaveRoot : entry ? path.join(ctx.weaveRoot, entry.path) : undefined;
    checkouts.push({ id, ...(candidate && (await isRepoTop(candidate)) ? { path: candidate } : {}) });
  }
  return checkouts;
}

async function isRepoTop(candidate: string): Promise<boolean> {
  if (!(await pathExists(candidate))) {
    return false;
  }
  const probe = await probeGitRoot(candidate);
  if (probe.kind !== "repo") {
    return false;
  }
  return probe.root === (await realpath(candidate));
}

async function readYamlRecord(file: string): Promise<Record<string, unknown> | undefined> {
  if (!(await pathExists(file))) {
    return undefined;
  }
  try {
    const parsed = YAML.parse(await readFile(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function renderReviewSnapshot(result: ReviewSnapshotResult): string {
  const lines = [`${result.slice}: ${result.start_ref}`];
  for (const [repo, ref] of Object.entries(result.refs)) {
    if (ref === null) {
      lines.push(`  ${repo}: not checked out here, skipped`);
      continue;
    }
    const base = result.merge_base[repo];
    lines.push(`  ${repo}: ${result.created[repo] ? "recorded" : "kept existing"} (merge-base ${base ? base.slice(0, 12) : "unknown"})`);
  }
  return lines.join("\n");
}
