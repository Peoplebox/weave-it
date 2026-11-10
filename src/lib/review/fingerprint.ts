// Fingerprints and basis hashes stored when a review is finalized or a ruling is recorded
// (architecture/schema.md: `fingerprint`, `plan_basis`, Ruling basis), and the read-time checks
// that compare them with the current tree and documents: out-of-date reasons, file ownership
// handoff between slices, and reopened rulings. Out-of-date and reopened are derived, never stored.
//
// - A fingerprint maps each reviewed, slice-owned file to its git blob hash in the working tree,
//   or `absent` when the file is deleted. Foreign files, `wiki/changes/**`, and plan and docs
//   edits are never fingerprinted.
// - `plan_basis` and the document parts of a ruling basis are frontmatter-stripped body hashes,
//   so lifecycle-only frontmatter edits never count as a change. Decisions also hash their
//   `superseded_by` (`decisionHash`), so superseding one counts as a plan change.
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { changeRepoCheckouts, repoCheckouts, sliceRepoCheckouts, type SliceRepoCheckout } from "../../commands/review/snapshot.js";
import { ChangeCommandError } from "../change-error.js";
import { listDecisions, matchesAppliesTo, type DecisionSummary } from "../decisions.js";
import { pathExists } from "../files.js";
import { mainWorktreePath, runGit } from "../git.js";
import { filesFromMain, resolveDiffBase } from "./base.js";
import { changeRunRef, SnapshotBoundary, sliceRoundRef, sliceStartRef, type ReviewBoundary } from "./boundary.js";
import type { GuidelineFile } from "./guidelines.js";
import { labelForeignFiles, parseFileAnchors, parseTaskSections, sliceRunEndRef, type DiffedPath } from "./package.js";
import type { StoredFinding } from "./record.js";
import { bodyHash, decisionHash, excludedPathspecs, planAndDocsPaths, type OutOfDateReason } from "./rules.js";
import {
  listSlices,
  readChangeReview,
  readSliceReview,
  resolveSlice,
  updateSliceReviewLocked,
  type ReviewContext,
  type SliceLocation,
  type ChangeReviewBlock,
  type SliceReviewBlock,
} from "./state.js";

// The fingerprint value of a reviewed file that no longer exists.
export const absentHash = "absent";

// Per repo id: repo-relative path -> blob hash or `absent`.
export type Fingerprint = Record<string, Record<string, string>>;

// Change-folder-relative document path -> body hash or `absent`, plus cited decisions by short id.
export type PlanBasis = Record<string, string | Record<string, string>> & { decisions: Record<string, string> };

export interface RulingBasis {
  // `<repo>:<path>` -> blob hash or `absent`.
  code: Record<string, string>;
  // Weave-root-relative guideline path -> body hash or `absent`.
  guidelines: Record<string, string>;
  // Document path -> body hash or `absent`. Paths inside the change folder are relative to it
  // (`prd.md`); others are relative to the Weave root (`wiki/knowledge/...`). `resolveBasisDocument`
  // turns a key back into a file.
  documents: Record<string, string>;
  // Short decision id (`261108-4ko1`) -> body hash or `absent`.
  decisions: Record<string, string>;
}

// What a ruling basis needs from a finding.
export interface BasisFinding {
  id: string;
  location: { repo: string; path: string };
  fails: { type: string; ref: string };
}

export interface CoveredFiles {
  // Per repo id: the slice-owned paths (relative to the repo root) the run's diff covered.
  files: Record<string, string[]>;
  // Every diffed path, owned or foreign, relative to the Weave root (for matching decisions).
  weavePaths: string[];
  // Per repo id: the merge-base recorded in the run's end snapshot.
  mergeBase: Record<string, string>;
  // Per repo id: files a rebase brought in from main between the boundaries. They are left out of
  // `files` and never fingerprinted. Only repos with such files are listed.
  fromMain: Record<string, string[]>;
  warnings: string[];
}

// --- fingerprints ----------------------------------------------------------------------------

// Blob hashes of `ownedPaths` in each repo's working tree. Repos that are not checked out here are
// left out. A path that no longer exists is recorded as `absent`.
export async function computeFingerprint(repos: SliceRepoCheckout[], ownedPaths: Record<string, string[]>): Promise<Fingerprint> {
  const fingerprint: Fingerprint = {};
  for (const repo of repos) {
    const paths = [...new Set(ownedPaths[repo.id] ?? [])].sort();
    if (!repo.path || paths.length === 0) {
      continue;
    }
    fingerprint[repo.id] = await blobHashes(repo.path, paths);
  }
  return fingerprint;
}

// `git hash-object` of each path in the working tree, or `absent` when it does not exist.
export async function blobHashes(repoPath: string, paths: string[]): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const present: string[] = [];
  for (const file of paths) {
    const stats = await lstat(path.join(repoPath, file)).catch(() => undefined);
    if (!stats) {
      hashes[file] = absentHash;
    } else if (stats.isFile() || stats.isSymbolicLink()) {
      present.push(file);
    }
  }
  for (let start = 0; start < present.length; start += 200) {
    const chunk = present.slice(start, start + 200);
    const result = await runGit(["hash-object", "--", ...chunk], repoPath);
    const lines = result.stdout.split("\n").filter(Boolean);
    if (!result.ok || lines.length !== chunk.length) {
      throw new ChangeCommandError("fingerprint_failed", `Could not hash reviewed files in ${repoPath}: ${result.stderr || "unexpected output"}`, {
        repoPath,
      });
    }
    chunk.forEach((file, index) => {
      hashes[file] = lines[index];
    });
  }
  return Object.fromEntries(Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right)));
}

// The files a slice run reviewed: in every slice repo, the paths changed between the slice's start
// boundary (or the fallback diff base) and the run's end snapshot, without excluded paths, files
// labelled foreign, plan and docs edits, and files from main (when the merge-base moved between
// the two snapshots, see `filesFromMain`). Files the run's fix rounds changed (between each
// `round<n>-start` and `round<n>-end` ref) join the set under the same rules, so a file a fix
// created is fingerprinted too.
export async function runCoveredFiles(
  ctx: ReviewContext,
  slice: SliceLocation,
  run: string,
  options: { startRef?: string; boundary?: ReviewBoundary } = {},
): Promise<CoveredFiles> {
  const boundary = options.boundary ?? new SnapshotBoundary();
  const checkouts = await sliceRepoCheckouts(ctx, slice);
  const tasksMd = (await pathExists(slice.tasksPath)) ? await readFile(slice.tasksPath, "utf8") : "";
  const anchors = parseFileAnchors(tasksMd);
  const ownership = { repos: checkouts.map((repo) => repo.id), anchors };
  const startRef = options.startRef ?? sliceStartRef(ctx.changeId, slice.id);
  const endRef = sliceRunEndRef(ctx.changeId, slice.id, run);
  const changeStatus = await readYamlRecord(path.join(ctx.changePath, "status.yml"));
  const mainRoot = (await mainWorktreePath(ctx.weaveRoot)) ?? ctx.weaveRoot;
  const covered: CoveredFiles = { files: {}, weavePaths: [], mergeBase: {}, fromMain: {}, warnings: [] };

  for (const checkout of checkouts) {
    const repoPath = checkout.path;
    if (!repoPath) {
      covered.warnings.push(`repo_missing:${checkout.id}`);
      continue;
    }
    const end = await boundary.read(repoPath, endRef);
    if (!end) {
      covered.warnings.push(`end_ref_missing:${checkout.id}`);
      continue;
    }
    if (end.mergeBase) covered.mergeBase[checkout.id] = end.mergeBase;
    const start = await boundary.read(repoPath, startRef);
    const from = start?.sha ?? (await resolveDiffBase({ repoPath, repoId: checkout.id, changeStatus, mainRoot })).sha;
    if (!from) {
      covered.warnings.push(`base_unknown:${checkout.id}`);
      continue;
    }
    const repoDir = toPosix(path.relative(ctx.weaveRoot, repoPath));
    const weaveRel = path.relative(repoPath, ctx.weaveRoot);
    const exclude = weaveRel.startsWith("..") || path.isAbsolute(weaveRel) ? [] : excludedPathspecs(toPosix(weaveRel));
    const stat = await boundary.diffStat(repoPath, from, endRef, { context: 0, exclude });
    const fromMain = new Set<string>();
    const withoutMain = async (paths: string[], oldBase: string | undefined, newBase: string | undefined, to: string): Promise<string[]> => {
      try {
        const moved = new Set(await filesFromMain(repoPath, { oldBase, newBase, end: to, paths }));
        for (const file of moved) fromMain.add(file);
        return paths.filter((file) => !moved.has(file));
      } catch {
        if (!covered.warnings.includes(`from_main_unknown:${checkout.id}`)) covered.warnings.push(`from_main_unknown:${checkout.id}`);
        return paths;
      }
    };
    const paths = new Set(start ? await withoutMain(stat.paths, start.mergeBase, end.mergeBase, end.sha) : stat.paths);
    for (let round = 1; ; round += 1) {
      const roundStart = await boundary.read(repoPath, sliceRoundRef(ctx.changeId, slice.id, run, round, "start"));
      const roundEnd = roundStart ? await boundary.read(repoPath, sliceRoundRef(ctx.changeId, slice.id, run, round, "end")) : undefined;
      if (!roundStart || !roundEnd) break;
      const roundPaths = (await boundary.diffStat(repoPath, roundStart.sha, roundEnd.sha, { context: 0, exclude })).paths;
      for (const file of await withoutMain(roundPaths, roundStart.mergeBase, roundEnd.mergeBase, roundEnd.sha)) paths.add(file);
    }
    for (const file of paths) fromMain.delete(file);
    if (fromMain.size > 0) covered.fromMain[checkout.id] = [...fromMain].sort();
    const changed: DiffedPath[] = [...paths].map((file) => ({ repo: checkout.id, path: file, repoDir }));
    covered.weavePaths.push(...changed.map(weaveRelative));
    // Without any anchors nothing can be told apart, so every file counts as the slice's own.
    const owned = anchors.length === 0 ? changed : labelForeignFiles(changed, ownership).owned;
    covered.files[checkout.id] = owned
      .filter((file) => !planAndDocsPaths.some((pattern) => matchesAppliesTo(weaveRelative(file), pattern)))
      .map((file) => file.path);
  }
  return covered;
}

// The files a change run reviewed: in every change repo, the paths changed between the diff base
// recorded in the run's end snapshot (else the current diff base) and that snapshot, plus the paths
// its fix batch changed (between `fix-start` and `fix-end`), without excluded paths and plan and
// docs edits. Nothing is labelled foreign: the change review owns every file of the change.
export async function changeCoveredFiles(ctx: ReviewContext, run: string, options: { boundary?: ReviewBoundary } = {}): Promise<CoveredFiles> {
  const boundary = options.boundary ?? new SnapshotBoundary();
  const endRef = changeRunRef(ctx.changeId, run, "end");
  const fixStartRef = changeRunRef(ctx.changeId, run, "fix-start");
  const fixEndRef = changeRunRef(ctx.changeId, run, "fix-end");
  const changeStatus = await readYamlRecord(path.join(ctx.changePath, "status.yml"));
  const mainRoot = (await mainWorktreePath(ctx.weaveRoot)) ?? ctx.weaveRoot;
  const covered: CoveredFiles = { files: {}, weavePaths: [], mergeBase: {}, fromMain: {}, warnings: [] };

  for (const checkout of await changeRepoCheckouts(ctx)) {
    const repoPath = checkout.path;
    if (!repoPath) {
      covered.warnings.push(`repo_missing:${checkout.id}`);
      continue;
    }
    const end = await boundary.read(repoPath, endRef);
    if (!end) {
      covered.warnings.push(`end_ref_missing:${checkout.id}`);
      continue;
    }
    if (end.mergeBase) covered.mergeBase[checkout.id] = end.mergeBase;
    const from = end.mergeBase ?? (await resolveDiffBase({ repoPath, repoId: checkout.id, changeStatus, mainRoot })).sha;
    if (!from) {
      covered.warnings.push(`base_unknown:${checkout.id}`);
      continue;
    }
    const repoDir = toPosix(path.relative(ctx.weaveRoot, repoPath));
    const weaveRel = path.relative(repoPath, ctx.weaveRoot);
    const exclude = weaveRel.startsWith("..") || path.isAbsolute(weaveRel) ? [] : excludedPathspecs(toPosix(weaveRel));
    const paths = new Set((await boundary.diffStat(repoPath, from, endRef, { context: 0, exclude })).paths);
    const fixStart = await boundary.read(repoPath, fixStartRef);
    const fixEnd = fixStart ? await boundary.read(repoPath, fixEndRef) : undefined;
    if (fixStart && fixEnd) {
      for (const file of (await boundary.diffStat(repoPath, fixStart.sha, fixEnd.sha, { context: 0, exclude })).paths) paths.add(file);
    }
    const changed: DiffedPath[] = [...paths].sort().map((file) => ({ repo: checkout.id, path: file, repoDir }));
    covered.weavePaths.push(...changed.map(weaveRelative));
    covered.files[checkout.id] = changed.filter((file) => !isPlanOrDocsPath(file)).map((file) => file.path);
  }
  return covered;
}

// A plan and docs edit (`planAndDocsPaths`, relative to the Weave root), or a repo's own
// `.weave/coding-guidelines.md`. Change packages list these apart from the code; no fingerprint
// holds them.
export function isPlanOrDocsPath(file: DiffedPath): boolean {
  return file.path === ".weave/coding-guidelines.md" || planAndDocsPaths.some((pattern) => matchesAppliesTo(weaveRelative(file), pattern));
}

// --- plan basis ------------------------------------------------------------------------------

// Body hashes of the documents a slice review was judged against: the change's planning document
// (the PRD for `feat`, findings for `fix`, the exploration otherwise), every architecture file, the
// slice's `slice.md` and `contracts.md`, and the given decisions. Keys are relative to the change
// folder; decisions are keyed by short id.
export async function computePlanBasis(
  changePath: string,
  sliceId: string,
  decisionIds: string[],
  options: { weaveRoot?: string } = {},
): Promise<PlanBasis> {
  return planBasisFor(changePath, [sliceId], decisionIds, options);
}

// The change review's `plan_basis`: like a slice's, with every slice's `slice.md` and
// `contracts.md` (none in flat mode), so a new or edited slice also counts as a plan change.
export async function computeChangePlanBasis(changePath: string, decisionIds: string[], options: { weaveRoot?: string } = {}): Promise<PlanBasis> {
  return planBasisFor(changePath, await sliceFolders(changePath), decisionIds, options);
}

async function planBasisFor(changePath: string, sliceIds: string[], decisionIds: string[], options: { weaveRoot?: string }): Promise<PlanBasis> {
  const changeStatus = await readYamlRecord(path.join(changePath, "status.yml"));
  const type = typeof changeStatus?.type === "string" ? changeStatus.type : "feat";
  const docs = [type === "feat" ? "prd.md" : type === "fix" ? "findings.md" : "exploration.md"];
  docs.push(...(await markdownFiles(changePath, "architecture")));
  for (const sliceId of sliceIds) {
    docs.push(`task-slices/${sliceId}/slice.md`);
    if (await pathExists(path.join(changePath, "task-slices", sliceId, "contracts.md"))) {
      docs.push(`task-slices/${sliceId}/contracts.md`);
    }
  }

  const basis: PlanBasis = { decisions: {} };
  for (const doc of docs) {
    basis[doc] = await documentHash(path.join(changePath, doc));
  }
  const weaveRoot = options.weaveRoot ?? weaveRootFor(changePath);
  basis.decisions = await decisionHashes(weaveRoot, decisionIds);
  return basis;
}

// Short ids of the accepted decisions that apply to `weavePaths`, plus every decision a finding
// cites (`fails.type: decision`), sorted.
export async function planDecisionIds(weaveRoot: string, weavePaths: string[], findings: BasisFinding[]): Promise<string[]> {
  const decisions = await allDecisions(weaveRoot);
  const ids = new Set<string>();
  for (const decision of decisions) {
    if (decision.status === "accepted" && decision.applies_to.some((pattern) => weavePaths.some((file) => matchesAppliesTo(file, pattern)))) {
      ids.add(shortDecisionId(decision.id));
    }
  }
  for (const finding of findings) {
    if (finding.fails.type === "decision") {
      for (const decision of citedDecisions(finding.fails.ref, decisions)) ids.add(shortDecisionId(decision.id));
    }
  }
  return [...ids].sort();
}

// --- ruling basis ----------------------------------------------------------------------------

// What a ruling was judged against: the blob of the finding's file, the run's guideline files, the
// documents the finding cites (falling back to the PRD, `architecture/index.md`, or the slice's
// `slice.md` by `fails.type`), and cited decisions. A change to any of these reopens the ruling.
export async function computeRulingBasis(
  finding: BasisFinding,
  guidelineFiles: GuidelineFile[],
  changePath: string,
  options: { repos: SliceRepoCheckout[]; sliceId?: string; weaveRoot?: string },
): Promise<RulingBasis> {
  const weaveRoot = options.weaveRoot ?? weaveRootFor(changePath);
  const basis: RulingBasis = { code: {}, guidelines: {}, documents: {}, decisions: {} };

  const repo = options.repos.find((candidate) => candidate.id === finding.location.repo);
  if (repo?.path && finding.location.path) {
    const hashes = await blobHashes(repo.path, [finding.location.path]);
    basis.code[`${repo.id}:${finding.location.path}`] = hashes[finding.location.path] ?? absentHash;
  }

  for (const file of guidelineFiles) {
    basis.guidelines[file.path] = file.status === "present" ? await documentHash(path.join(weaveRoot, file.path)) : absentHash;
  }

  const { type, ref } = finding.fails;
  if (type === "decision") {
    const decisions = citedDecisions(ref, await allDecisions(weaveRoot));
    basis.decisions = await decisionHashes(weaveRoot, decisions.map((decision) => shortDecisionId(decision.id)));
  } else if (type !== "guideline" && type !== "correctness") {
    const keys = new Set<string>();
    const cited = await citedDocument(ref, changePath, weaveRoot);
    if (cited) keys.add(cited);
    if (keys.size === 0) {
      if (type === "prd") keys.add("prd.md");
      if (type === "architecture") keys.add("architecture/index.md");
      if (type === "acceptance" && options.sliceId) keys.add(`task-slices/${options.sliceId}/slice.md`);
    }
    for (const key of keys) {
      basis.documents[key] = await documentHash(resolveBasisDocument(changePath, weaveRoot, key));
    }
  }
  return basis;
}

// The file a ruling-basis document key names: inside the change folder when it exists there,
// otherwise relative to the Weave root.
export function resolveBasisDocument(changePath: string, weaveRoot: string, key: string): string {
  return key.startsWith("wiki/") || key.startsWith(".weave/") ? path.join(weaveRoot, key) : path.join(changePath, key);
}

// `261108-4ko1-some-title` -> `261108-4ko1`.
export function shortDecisionId(id: string): string {
  const match = /^(\d{6}-[a-z0-9]{4})/.exec(id);
  return match ? match[1] : id;
}

// --- out of date -----------------------------------------------------------------------------

export interface OutOfDateEvaluation {
  reasons: OutOfDateReason[];
  // `repo_missing:<repo>` for a fingerprinted repo that is not checked out here. Its files add no
  // reason, so a missing checkout never flips a slice to current or out of date by accident.
  warnings: string[];
}

// Why a slice's stored review no longer describes the slice (architecture § Shared rules,
// `effectiveState`). Compares, at read time:
// - `code_changed`: a fingerprinted file's blob hash (or `absent`) with the working tree
// - `tasks_added`: the active task count with `reviewed_task_total`
// - `plan_changed`: `plan_basis` with the current frontmatter-stripped body hashes
// Only `reviewed` and `reviewed_with_rulings` slices are checked for all three; a
// `waiting_on_person` slice is checked for `plan_changed` only (a plan change answers its plan
// problem). Every other state has no reasons. Nothing is written.
export async function outOfDateReasons(ctx: ReviewContext, sliceId: string): Promise<OutOfDateReason[]> {
  return (await evaluateOutOfDate(ctx, await resolveSlice(ctx, sliceId))).reasons;
}

// `outOfDateReasons` with its warnings. Pass `block` when the caller already read it.
export async function evaluateOutOfDate(
  ctx: ReviewContext,
  slice: SliceLocation,
  options: { block?: SliceReviewBlock | null } = {},
): Promise<OutOfDateEvaluation> {
  const block = options.block !== undefined ? options.block : await readSliceReview(slice.statusPath).catch(() => undefined);
  const evaluation: OutOfDateEvaluation = { reasons: [], warnings: [] };
  const state = block?.state;
  const reviewed = state === "reviewed" || state === "reviewed_with_rulings";
  if (!block || (!reviewed && state !== "waiting_on_person")) {
    return evaluation;
  }
  if (reviewed && isRecord(block.fingerprint) && (await fingerprintChanged(ctx, block.fingerprint, evaluation.warnings))) {
    evaluation.reasons.push("code_changed");
  }
  if (reviewed && typeof block.reviewed_task_total === "number") {
    const tasksMd = (await pathExists(slice.tasksPath)) ? await readFile(slice.tasksPath, "utf8") : "";
    const active = parseTaskSections(tasksMd).filter((task) => task.status !== "invalid").length;
    if (active > block.reviewed_task_total) evaluation.reasons.push("tasks_added");
  }
  if (isRecord(block.plan_basis) && (await planBasisChanged(ctx, slice.id, block.plan_basis))) {
    evaluation.reasons.push("plan_changed");
  }
  return evaluation;
}

// Whether any fingerprinted file differs from the working tree. Repos not checked out here are
// skipped with a warning.
async function fingerprintChanged(ctx: ReviewContext, fingerprint: Record<string, unknown>, warnings: string[]): Promise<boolean> {
  let changed = false;
  for (const checkout of await repoCheckouts(ctx, Object.keys(fingerprint).sort())) {
    const stored = stringEntries(fingerprint[checkout.id]);
    const paths = Object.keys(stored).filter(isSafeRelativePath);
    if (paths.length === 0) continue;
    if (!checkout.path) {
      warnings.push(`repo_missing:${checkout.id}`);
      continue;
    }
    const current = await blobHashes(checkout.path, paths);
    if (paths.some((file) => (current[file] ?? absentHash) !== stored[file])) changed = true;
  }
  return changed;
}

// Whether the planning documents a review was judged against changed: any stored document or
// decision hash differs from the current body hash, or a planning document appeared or vanished
// (a new architecture file, for example).
async function planBasisChanged(ctx: ReviewContext, sliceId: string, stored: Record<string, unknown>): Promise<boolean> {
  const storedDecisions = stringEntries(stored.decisions);
  return planBasisDiffers(stored, await computePlanBasis(ctx.changePath, sliceId, Object.keys(storedDecisions), { weaveRoot: ctx.weaveRoot }));
}

function planBasisDiffers(stored: Record<string, unknown>, current: PlanBasis): boolean {
  const storedDecisions = stringEntries(stored.decisions);
  const documentKeys = new Set([...Object.keys(stored), ...Object.keys(current)].filter((key) => key !== "decisions"));
  for (const key of documentKeys) {
    const before = typeof stored[key] === "string" ? stored[key] : absentHash;
    const now = typeof current[key] === "string" ? current[key] : absentHash;
    if (before !== now) return true;
  }
  return Object.entries(storedDecisions).some(([id, hash]) => (current.decisions[id] ?? absentHash) !== hash);
}

// Change review states that carry a verdict, which can go out of date.
const changeVerdictStates: readonly string[] = ["ready_to_merge", "ready_with_parked_items", "not_ready"];

// Why the change verdict no longer describes the change ("verdict out of date"): the same
// comparisons as a slice's, over the change review's own fingerprint, `plan_basis` (every slice's
// documents), and `reviewed_task_total` (every active task of the change). Only a change with a
// verdict has reasons. Nothing is written.
export async function evaluateChangeOutOfDate(ctx: ReviewContext, options: { block?: ChangeReviewBlock | null } = {}): Promise<OutOfDateEvaluation> {
  const block = options.block !== undefined ? options.block : await readChangeReview(ctx.changePath).catch(() => undefined);
  const evaluation: OutOfDateEvaluation = { reasons: [], warnings: [] };
  if (!block || typeof block.state !== "string" || !changeVerdictStates.includes(block.state)) {
    return evaluation;
  }
  if (isRecord(block.fingerprint) && (await fingerprintChanged(ctx, block.fingerprint, evaluation.warnings))) {
    evaluation.reasons.push("code_changed");
  }
  if (typeof block.reviewed_task_total === "number" && (await activeChangeTaskTotal(ctx)) > block.reviewed_task_total) {
    evaluation.reasons.push("tasks_added");
  }
  if (isRecord(block.plan_basis)) {
    const stored = block.plan_basis;
    const current = await computeChangePlanBasis(ctx.changePath, Object.keys(stringEntries(stored.decisions)), { weaveRoot: ctx.weaveRoot });
    if (planBasisDiffers(stored, current)) evaluation.reasons.push("plan_changed");
  }
  return evaluation;
}

// Active (non-`invalid`) tasks across every slice, or in the change's `tasks.md` in flat mode.
async function activeChangeTaskTotal(ctx: ReviewContext): Promise<number> {
  const slices = await listSlices(ctx);
  const files = slices.length > 0 ? slices.map((slice) => slice.tasksPath) : [path.join(ctx.changePath, "tasks.md")];
  let total = 0;
  for (const file of files) {
    if (!(await pathExists(file))) continue;
    total += parseTaskSections(await readFile(file, "utf8")).filter((task) => task.status !== "invalid").length;
  }
  return total;
}

// --- file ownership --------------------------------------------------------------------------

// Hands the files a newer review covered to that review: removes them from every other slice's
// `review.fingerprint` (architecture § File ownership), so slices that share files never cascade
// out of date. `exceptSliceId` is the slice whose run just finalized; a change run passes none.
// Only fingerprint maps change. The caller must hold the change lock (call it inside the
// finalizing `updateSliceReview` mutate). Returns the slices whose fingerprint lost files.
export async function releaseOwnership(
  ctx: ReviewContext,
  coveredFiles: Record<string, string[]>,
  exceptSliceId?: string,
  options: { now?: Date } = {},
): Promise<string[]> {
  const covered = Object.entries(coveredFiles).filter(([, files]) => files.length > 0);
  if (covered.length === 0) return [];
  const released: string[] = [];
  for (const slice of await listSlices(ctx)) {
    if (slice.id === exceptSliceId) continue;
    const block = await readSliceReview(slice.statusPath).catch(() => undefined);
    if (!block || !isRecord(block.fingerprint) || !covered.some(([repo, files]) => files.some((file) => hasKey(block.fingerprint?.[repo], file)))) {
      continue;
    }
    await updateSliceReviewLocked(
      ctx,
      slice.id,
      (current) => {
        if (!current || !isRecord(current.fingerprint)) return current;
        const fingerprint: Record<string, Record<string, string>> = {};
        for (const [repo, files] of Object.entries(current.fingerprint)) {
          const kept = { ...stringEntries(files) };
          for (const file of coveredFiles[repo] ?? []) delete kept[file];
          if (Object.keys(kept).length > 0) fingerprint[repo] = kept;
        }
        return { ...current, fingerprint };
      },
      options,
    );
    released.push(slice.id);
  }
  return released;
}

// --- rulings ---------------------------------------------------------------------------------

// A finding resolved as a ruling, with what changed in its basis since the ruling was recorded.
export interface Ruling {
  finding: string;
  run: string;
  // The slice of a slice run; null for a change run.
  slice: string | null;
  severity: string;
  kind: string;
  location: { repo: string; path: string; line?: number };
  fails: { type: string; ref: string };
  detail: string;
  agreed: boolean;
  reason: string;
  cost_if_wrong: string;
  basis: RulingBasis;
  // Basis entries whose hash changed, such as `code root:src/a.ts` or `document prd.md`. Empty for
  // a settled ruling.
  changed: string[];
}

// Which rulings to classify. A slice scope holds the slice's own rulings from every run, plus
// other slices' rulings on any of `files` (the files the slice's package shows). A change scope
// holds every ruling of every slice run and change run.
export type RulingScope = { kind: "slice"; slice: string; files?: Array<{ repo: string; path: string }> } | { kind: "change" };

export interface RulingClassification {
  settled: Ruling[];
  reopened: Ruling[];
  warnings: string[];
}

// A ruling reopens when any hash its basis recorded differs from the current one: the code it
// covers, a guideline file, a planning document, or a recorded decision (FR34). Entries `current`
// does not hold (for example a repo that is not checked out here) never reopen a ruling.
export function rulingReopened(basis: RulingBasis, current: RulingBasis): boolean {
  return rulingBasisChanges(basis, current).length > 0;
}

// The basis entries that changed, labelled `code|guideline|document|decision <key>`.
export function rulingBasisChanges(basis: RulingBasis, current: RulingBasis): string[] {
  const changed: string[] = [];
  for (const [part, label] of basisParts) {
    const before = stringEntries(basis[part]);
    const now = stringEntries(current[part]);
    for (const [key, hash] of Object.entries(before)) {
      if (key in now && now[key] !== hash) changed.push(`${label} ${key}`);
    }
  }
  return changed;
}

// Recomputes the hashes of every entry a ruling basis holds, the way `computeRulingBasis` did when
// the ruling was recorded. Code entries whose repo is not checked out here are left out, with a
// `repo_missing:<repo>` warning.
export async function currentRulingBasis(
  ctx: ReviewContext,
  basis: RulingBasis,
  options: { warnings?: string[]; cache?: Map<string, string> } = {},
): Promise<RulingBasis> {
  const cache = options.cache ?? new Map<string, string>();
  const cached = async (key: string, compute: () => Promise<string>): Promise<string> => {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const value = await compute();
    cache.set(key, value);
    return value;
  };
  const current: RulingBasis = { code: {}, guidelines: {}, documents: {}, decisions: {} };

  const code = stringEntries(basis.code);
  const repoIds = [...new Set(Object.keys(code).map((key) => key.split(":")[0] ?? ""))].filter(Boolean).sort();
  const checkouts = new Map((await repoCheckouts(ctx, repoIds)).map((checkout) => [checkout.id, checkout.path]));
  for (const key of Object.keys(code)) {
    const separator = key.indexOf(":");
    const repo = key.slice(0, separator);
    const file = key.slice(separator + 1);
    if (separator <= 0 || !isSafeRelativePath(file)) continue;
    const repoPath = checkouts.get(repo);
    if (!repoPath) {
      if (options.warnings && !options.warnings.includes(`repo_missing:${repo}`)) options.warnings.push(`repo_missing:${repo}`);
      continue;
    }
    current.code[key] = await cached(`code:${key}`, async () => (await blobHashes(repoPath, [file]))[file] ?? absentHash);
  }
  for (const key of Object.keys(stringEntries(basis.guidelines)).filter(isSafeRelativePath)) {
    current.guidelines[key] = await cached(`guideline:${key}`, () => documentHash(path.join(ctx.weaveRoot, key)));
  }
  for (const key of Object.keys(stringEntries(basis.documents)).filter(isSafeRelativePath)) {
    current.documents[key] = await cached(`document:${key}`, () => documentHash(resolveBasisDocument(ctx.changePath, ctx.weaveRoot, key)));
  }
  const decisionIds = Object.keys(stringEntries(basis.decisions));
  const missing = decisionIds.filter((id) => !cache.has(`decision:${id}`));
  if (missing.length > 0) {
    for (const [id, hash] of Object.entries(await decisionHashes(ctx.weaveRoot, missing))) cache.set(`decision:${id}`, hash);
  }
  for (const id of decisionIds) current.decisions[id] = cache.get(`decision:${id}`) ?? absentHash;
  return current;
}

// Every ruling in scope, split into settled rulings (later reviewers must not raise them again)
// and reopened rulings (their basis changed, so they are open to review again). Read from the
// `review/*.findings.json` files; nothing is written.
export async function classifyRulings(ctx: ReviewContext, scope: RulingScope): Promise<RulingClassification> {
  const result: RulingClassification = { settled: [], reopened: [], warnings: [] };
  const sources: Array<{ slice: string | null; dir: string }> = [];
  for (const slice of await listSlices(ctx)) {
    if (scope.kind === "slice" && slice.id !== scope.slice && !scope.files?.length) continue;
    sources.push({ slice: slice.id, dir: path.join(slice.path, "review") });
  }
  if (scope.kind === "change") sources.push({ slice: null, dir: path.join(ctx.changePath, "review") });

  const wanted = scope.kind === "slice" ? new Set((scope.files ?? []).map((file) => `${file.repo}:${file.path}`)) : undefined;
  const cache = new Map<string, string>();
  for (const source of sources) {
    for (const record of await readFindingRecords(source.dir, result.warnings)) {
      for (const finding of record.findings) {
        const resolution = finding.resolution;
        if (resolution?.as !== "ruling" || !isRecord(resolution.basis)) continue;
        const own = scope.kind === "change" || source.slice === scope.slice;
        if (!own && !wanted?.has(`${finding.location?.repo}:${finding.location?.path}`)) continue;
        const basis = normalizeBasis(resolution.basis);
        const current = await currentRulingBasis(ctx, basis, { warnings: result.warnings, cache });
        const ruling: Ruling = {
          finding: finding.id,
          run: record.run,
          slice: source.slice,
          severity: finding.severity,
          kind: finding.kind,
          location: { repo: finding.location?.repo ?? "", path: finding.location?.path ?? "", ...(finding.location?.line ? { line: finding.location.line } : {}) },
          fails: { type: finding.fails?.type ?? "", ref: finding.fails?.ref ?? "" },
          detail: finding.detail ?? "",
          agreed: resolution.agreed === true,
          reason: resolution.reason ?? "",
          cost_if_wrong: resolution.cost_if_wrong ?? "",
          basis,
          changed: rulingBasisChanges(basis, current),
        };
        (ruling.changed.length > 0 ? result.reopened : result.settled).push(ruling);
      }
    }
  }
  return result;
}

const basisParts: ReadonlyArray<readonly [keyof RulingBasis, string]> = [
  ["code", "code"],
  ["guidelines", "guideline"],
  ["documents", "document"],
  ["decisions", "decision"],
];

function normalizeBasis(value: Record<string, unknown>): RulingBasis {
  return {
    code: stringEntries(value.code),
    guidelines: stringEntries(value.guidelines),
    documents: stringEntries(value.documents),
    decisions: stringEntries(value.decisions),
  };
}

// The run records in a `review/` folder (`r<N>` or `f<N>` findings files), oldest run first.
// Unreadable files are skipped with an `invalid_review_record:<file>` warning.
async function readFindingRecords(dir: string, warnings: string[]): Promise<Array<{ run: string; findings: StoredFinding[] }>> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = names
    .flatMap((name) => {
      const match = /^([a-z])(\d+)\.findings\.json$/.exec(name);
      return match ? [{ name, order: `${match[1]}${match[2].padStart(6, "0")}` }] : [];
    })
    .sort((left, right) => left.order.localeCompare(right.order));
  const records: Array<{ run: string; findings: StoredFinding[] }> = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, file.name), "utf8")) as unknown;
      if (!isRecord(parsed) || !Array.isArray(parsed.findings)) throw new Error("not a findings record");
      records.push({ run: typeof parsed.run === "string" ? parsed.run : file.name, findings: parsed.findings.filter(isRecord) as unknown as StoredFinding[] });
    } catch {
      warnings.push(`invalid_review_record:${path.join(dir, file.name)}`);
    }
  }
  return records;
}

// --- helpers ---------------------------------------------------------------------------------

async function decisionDocumentHash(file: string): Promise<string> {
  try {
    return decisionHash(await readFile(file, "utf8"));
  } catch {
    return absentHash;
  }
}

async function documentHash(file: string): Promise<string> {
  try {
    return bodyHash(await readFile(file, "utf8"));
  } catch {
    return absentHash;
  }
}

// Decision hashes by short id (`decisionHash`: the body plus `superseded_by`), `absent` for an
// unknown id.
export async function decisionHashes(weaveRoot: string, ids: string[]): Promise<Record<string, string>> {
  const decisions = await allDecisions(weaveRoot);
  const hashes: Record<string, string> = {};
  for (const id of [...new Set(ids)].sort()) {
    const decision = decisions.find((candidate) => shortDecisionId(candidate.id) === id || candidate.id === id);
    hashes[id] = decision ? await decisionDocumentHash(path.resolve(weaveRoot, decision.path)) : absentHash;
  }
  return hashes;
}

async function allDecisions(weaveRoot: string): Promise<DecisionSummary[]> {
  try {
    return (await listDecisions({ cwd: weaveRoot })).decisions;
  } catch {
    return [];
  }
}

// Decisions whose short id appears in a `fails.ref` such as `261108-4ko1` or a decision file path.
function citedDecisions(ref: string, decisions: DecisionSummary[]): DecisionSummary[] {
  return decisions.filter((decision) => ref.includes(shortDecisionId(decision.id)));
}

// A `fails.ref` that names an existing document inside the Weave root, as a basis key. The ref is
// untrusted, so absolute paths and `..` segments are ignored.
async function citedDocument(ref: string, changePath: string, weaveRoot: string): Promise<string | undefined> {
  const cleaned = (ref.split("#")[0] ?? "").trim().replace(/^`|`$/g, "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!cleaned || path.isAbsolute(cleaned) || cleaned.split("/").includes("..") || !/\.md$/i.test(cleaned)) {
    return undefined;
  }
  if (!cleaned.startsWith("wiki/") && !cleaned.startsWith(".weave/")) {
    return (await pathExists(path.join(changePath, cleaned))) ? cleaned : undefined;
  }
  if (!(await pathExists(path.join(weaveRoot, cleaned)))) {
    return undefined;
  }
  // A Weave-root path that points into this change folder is stored change-relative.
  const insideChange = path.relative(changePath, path.join(weaveRoot, cleaned));
  return !insideChange.startsWith("..") && !path.isAbsolute(insideChange) ? toPosix(insideChange) : cleaned;
}

// Slice folder names under `task-slices/`, sorted; empty in flat mode.
async function sliceFolders(changePath: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(changePath, "task-slices"), { withFileTypes: true });
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(changePath, "task-slices", entry.name);
      if ((await pathExists(path.join(dir, "status.yml"))) || (await pathExists(path.join(dir, "tasks.md")))) ids.push(entry.name);
    }
    return ids.sort();
  } catch {
    return [];
  }
}

async function markdownFiles(changePath: string, folder: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(path.join(changePath, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(child);
      }
    }
  };
  await walk(folder);
  return files.sort();
}

function weaveRelative(file: DiffedPath): string {
  return file.repoDir ? path.posix.join(file.repoDir, file.path) : file.path;
}

// `<root>/wiki/changes/<id>` -> `<root>`.
function weaveRootFor(changePath: string): string {
  return path.resolve(changePath, "..", "..", "..");
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

async function readYamlRecord(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = YAML.parse(await readFile(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// The string-valued entries of a mapping read back from YAML or JSON.
function stringEntries(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function hasKey(value: unknown, key: string): boolean {
  return isRecord(value) && key in value;
}

// A stored path that stays inside its root: relative, with no `..` segment.
function isSafeRelativePath(value: string): boolean {
  return value !== "" && !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..");
}
