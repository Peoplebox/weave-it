// Slice review packages (architecture § Slice flow step 1, § Packages): everything a fresh reviewer
// needs, in one file inside the change's own checkout folder. A package holds the whole-tree diff
// between the slice's start and end boundaries in every repo the slice touches, with files outside
// the slice's task `Files:` anchors labelled "possibly another slice's work", and a context manifest
// (planning documents, applicable decisions, guideline files, task evidence as claims, untested
// tasks, human checks). The caller only names the slice; this module picks every range.
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { changeRepoCheckouts, sliceRepoCheckouts, type SliceRepoCheckout } from "../../commands/review/snapshot.js";
import { ChangeCommandError } from "../change-error.js";
import { listDecisions, matchesAppliesTo, type DecisionSummary } from "../decisions.js";
import { pathExists } from "../files.js";
import { mainWorktreePath, runGit } from "../git.js";
import { withChangeLock } from "../local-state.js";
import { parseSliceTasksMarkdown, type TaskStatus } from "../sliceRollup.js";
import { readWorkspaceMetadata } from "../workspace-repos.js";
import { filesFromMain, resolveDiffBase } from "./base.js";
import { changeRunRef, changeScopeId, reviewRefPrefix, SnapshotBoundary, type ReviewBoundary } from "./boundary.js";
import { classifyRulings, computeChangePlanBasis, computePlanBasis, isPlanOrDocsPath, planDecisionIds, type Ruling } from "./fingerprint.js";
import { describeBlocking, evaluateGate, type GateResult } from "./gate.js";
import { fixesNeedingCheck, readRunRecords, type RunRecord, type StoredFinding } from "./record.js";
import { guidelineRepos, resolveGuidelines, type GuidelineResolution } from "./guidelines.js";
import { excludedPathspecs, isReadyForReview } from "./rules.js";
import {
  adoptChange,
  changeRunLocation,
  listSlices,
  readChangeReview,
  readSliceReview,
  resolveSlice,
  reviewActivation,
  updateChangeReview,
  updateSliceReview,
  type ReviewContext,
  type SliceLocation,
} from "./state.js";

// A slice run whose diff changes more lines than this is a large review: the hint is raised from
// `mid` to `most_capable`.
export const mostCapableLineThreshold = 1500;
// Lines of context around each change in the package diff.
export const packageDiffContext = 10;

const rootRepoId = "root";

export type PackageModelLevel = "mid" | "most_capable";
export type FallbackBase = "change_base" | "merge_base";

export interface SlicePackageOptions {
  // Package a slice whose tasks are not all `done` or `not_tested` (on-demand runs).
  partial?: boolean;
  // Package even when the workspace has review switched off.
  force?: boolean;
  // Write the package here instead of the default location.
  out?: string;
  now?: Date;
}

export interface PackageResult {
  status: "ok";
  run_id: string;
  package_path: string;
  scope: { kind: "slice"; slice: string } | { kind: "change" };
  partial: boolean;
  partial_reasons: string[];
  fallback_base: FallbackBase | null;
  foreign_files: number;
  model_level: PackageModelLevel;
  size_hint: { files: number; lines: number };
  // Rulings listed under "Settled rulings (do not raise again)" and "Reopened rulings".
  settled_rulings: number;
  reopened_rulings: number;
  // Files listed under "From main (ignore)": brought in by a rebase between the boundaries.
  from_main_files: number;
  warnings: string[];
}

// --- task evidence ---------------------------------------------------------------------------

export interface TaskRef {
  id: string;
  title: string;
  status: TaskStatus | null;
}

export interface FileAnchor {
  // Relative to the repo root, or to the Weave root; matched exactly or as a path prefix.
  path: string;
  // The task's `Repos:`; empty when the task names none.
  repos: string[];
}

export interface TaskSection extends TaskRef {
  repos: string[];
  files: string[];
  humanChecks: string[];
  verification: string[];
}

export interface TaskEvidence {
  untested: TaskRef[];
  humanChecks: Array<{ task: string; step: string }>;
  evidence: Array<{ task: string; lines: string[] }>;
}

// Every `### T<n>: <title>` section of a `tasks.md`, with its status (the Active Task Index row,
// else the section's own `Status:` line), `Repos:`, `Files:` anchors, and `### Verification` lines.
export function parseTaskSections(tasksMd: string): TaskSection[] {
  const indexStatuses = new Map<string, TaskStatus>();
  for (const row of tasksMd.matchAll(/^\| (T\d+) \| ([^|]+) \|/gm)) {
    const status = asTaskStatus(row[2]);
    if (status) indexStatuses.set(row[1], status);
  }

  const lines = tasksMd.split(/\r?\n/);
  const sections: TaskSection[] = [];
  let current: TaskSection | undefined;
  let block: "none" | "files" | "verification" = "none";
  let detailStatus: TaskStatus | null = null;

  const close = (): void => {
    if (current) {
      current.status = indexStatuses.get(current.id) ?? detailStatus;
      sections.push(current);
    }
    current = undefined;
    block = "none";
    detailStatus = null;
  };

  for (const line of lines) {
    const task = /^###\s+(T\d+):\s*(.*?)\s*$/.exec(line);
    if (task) {
      close();
      current = { id: task[1], title: task[2], status: null, repos: [], files: [], humanChecks: [], verification: [] };
      continue;
    }
    if (/^#{1,2}\s/.test(line)) {
      close();
      continue;
    }
    if (!current) continue;
    if (/^###\s/.test(line)) {
      block = /^###\s+Verification\s*$/.test(line) ? "verification" : "none";
      continue;
    }

    const status = /^Status:\s*(\S+)/.exec(line);
    if (status && block === "none") {
      detailStatus = asTaskStatus(status[1]);
      continue;
    }
    const repos = /^Repos:\s*(.*)$/.exec(line);
    if (repos && block === "none") {
      current.repos = repos[1].split(/[\s,]+/).filter((value) => value && value.toLowerCase() !== "none");
      continue;
    }
    const files = /^Files:\s*(.*)$/.exec(line);
    if (files && block === "none") {
      block = "files";
      current.files.push(...files[1].split(",").map(anchorPath).filter((value): value is string => value !== undefined));
      continue;
    }

    if (block === "files") {
      const item = /^\s*[-*]\s+(.*)$/.exec(line);
      if (item) {
        const anchor = anchorPath(item[1]);
        if (anchor) current.files.push(anchor);
      } else if (line.trim() !== "") {
        block = "none";
      }
      continue;
    }
    if (block === "verification") {
      const trimmed = line.trim();
      if (trimmed === "" || /^<!--.*-->$/.test(trimmed)) continue;
      const human = /^(?:[-*]\s+)?Human check:\s*(.+)$/.exec(trimmed);
      if (human) {
        current.humanChecks.push(human[1].trim());
      } else {
        current.verification.push(trimmed);
      }
    }
  }
  close();
  return sections;
}

// Untested tasks, `Human check:` steps (only under a task's `### Verification`), and each task's
// verification lines. `invalid` tasks are ignored.
export function parseTaskEvidence(tasksMd: string): TaskEvidence {
  const tasks = parseTaskSections(tasksMd).filter((task) => task.status !== "invalid");
  return {
    untested: tasks.filter((task) => task.status === "not_tested").map(taskRef),
    humanChecks: tasks.flatMap((task) => task.humanChecks.map((step) => ({ task: task.id, step }))),
    evidence: tasks.filter((task) => task.verification.length > 0).map((task) => ({ task: task.id, lines: [...task.verification] })),
  };
}

// The `Files:` anchors of every active task.
export function parseFileAnchors(tasksMd: string): FileAnchor[] {
  return parseTaskSections(tasksMd)
    .filter((task) => task.status !== "invalid")
    .flatMap((task) => task.files.map((file) => ({ path: file, repos: [...task.repos] })));
}

// --- ownership -------------------------------------------------------------------------------

export interface DiffedPath {
  repo: string;
  // Relative to the repo root.
  path: string;
  // The repo's folder relative to the Weave root ("" for the root repo).
  repoDir?: string;
}

export interface SliceOwnership {
  repos: string[];
  anchors: FileAnchor[];
}

// Splits changed files into the slice's own (inside the slice's repos and under a task `Files:`
// anchor, matched as an exact file or a path prefix, against the repo-relative or the
// Weave-root-relative path) and the rest, which may be another slice's work.
export function labelForeignFiles<T extends DiffedPath>(paths: T[], slice: SliceOwnership): { owned: T[]; foreign: T[] } {
  const owned: T[] = [];
  const foreign: T[] = [];
  for (const file of paths) {
    const candidates = [file.path, weaveRelativePath(file)];
    const inRepo = slice.repos.includes(file.repo);
    const anchored = slice.anchors.some(
      (anchor) =>
        (anchor.repos.length === 0 || anchor.repos.includes(file.repo)) &&
        candidates.some((candidate) => matchesAppliesTo(candidate, anchor.path)),
    );
    (inRepo && anchored ? owned : foreign).push(file);
  }
  return { owned, foreign };
}

export function sliceModelLevel(lines: number): PackageModelLevel {
  return lines > mostCapableLineThreshold ? "most_capable" : "mid";
}

// --- run allocation --------------------------------------------------------------------------

// `refs/weave/reviews/<change>/<slice>/r<N>/end`.
export function sliceRunEndRef(changeId: string, sliceId: string, run: string): string {
  return `${reviewRefPrefix}/${changeId}/${sliceId}/${run}/end`;
}

// `<checkout>/.weave/tmp/reviews/<change>/<slice>`.
export function slicePackageDir(ctx: ReviewContext, sliceId: string): string {
  return path.join(ctx.weaveRoot, ".weave", "tmp", "reviews", ctx.changeId, sliceId);
}

// One more than the highest `r<N>` (or `f<N>` with `letter: "f"`) among `names` (ref names, file
// names, or run ids).
export function nextRunNumber(names: string[], letter: "r" | "f" = "r"): number {
  let highest = 0;
  const pattern = new RegExp(`(?:^|/)${letter}(\\d+)(?=$|[/.-])`, "g");
  for (const name of names) {
    for (const match of name.matchAll(pattern)) {
      highest = Math.max(highest, Number.parseInt(match[1], 10));
    }
  }
  return highest + 1;
}

// Allocates the next run of a slice under the change lock, and reserves it by creating the run's
// package file before the lock is released, so concurrent calls never share a run id.
export async function allocateSliceRun(ctx: ReviewContext, slice: SliceLocation, repoPaths: string[]): Promise<{ run: string; reservation: string }> {
  const dir = slicePackageDir(ctx, slice.id);
  await ensureTmpIgnored(ctx.weaveRoot);
  await mkdir(dir, { recursive: true });
  return withChangeLock(ctx.changePath, ctx.changeId, async () => {
    const names: string[] = [];
    const refPrefix = `${reviewRefPrefix}/${ctx.changeId}/${slice.id}/`;
    for (const repoPath of repoPaths) {
      const refs = await runGit(["for-each-ref", "--format=%(refname)", refPrefix], repoPath);
      if (refs.ok) names.push(...refs.stdout.split("\n").filter(Boolean).map((ref) => ref.slice(refPrefix.length)));
    }
    names.push(...(await listNames(path.join(slice.path, "review"))), ...(await listNames(dir)));
    const latest = (await readSliceReview(slice.statusPath).catch(() => undefined))?.latest_run;
    if (typeof latest === "string") names.push(latest);

    for (let number = nextRunNumber(names); ; number += 1) {
      const reservation = path.join(dir, `r${number}.package.md`);
      try {
        await writeFile(reservation, `# Review package r${number}\n\nBeing written.\n`, { flag: "wx" });
        return { run: `r${number}`, reservation };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  });
}

// --- building --------------------------------------------------------------------------------

export interface RepoDiff {
  repo: string;
  repoDir: string;
  // Absent when the repo is not checked out here.
  checkedOut: boolean;
  from?: { kind: "start"; ref: string; sha: string } | { kind: "fallback"; base: FallbackBase; sha: string; target?: string };
  baseUnknown?: boolean;
  startRefMissing?: boolean;
  end?: { ref: string; sha: string };
  owned: DiffedPath[];
  foreign: DiffedPath[];
  // Files a rebase brought in from main between the start and end snapshots (see `filesFromMain`).
  fromMain: DiffedPath[];
  // The start and end snapshots' merge-bases, when they differ.
  mergeBaseMoved?: { from: string; to: string };
  // The merge-bases are known to differ but the "from main" files could not be worked out.
  fromMainUnknown?: boolean;
  lines: number;
  ownedDiff: string;
  foreignDiff: string;
}

export interface PackageModel {
  runId: string;
  ctx: ReviewContext;
  slice: SliceLocation;
  workspace: boolean;
  repos: RepoDiff[];
  partialReasons: string[];
  warnings: string[];
  modelLevel: PackageModelLevel;
  sizeHint: { files: number; lines: number };
  planningDocs: Array<{ label: string; path: string; present: boolean }>;
  decisions: DecisionSummary[];
  guidelines: GuidelineResolution;
  tasks: TaskSection[];
  evidence: TaskEvidence;
  noAnchors: boolean;
  rulings: { settled: Ruling[]; reopened: Ruling[] };
}

// `weave review package --slice`: adopt the change, allocate the run, take the end snapshot in every
// slice repo, write the package, then mark the slice `in_review`. A failure after the snapshot keeps
// the end ref and leaves the slice state as it was.
export async function buildSlicePackage(
  ctx: ReviewContext,
  sliceId: string,
  options: SlicePackageOptions = {},
  boundary: ReviewBoundary = new SnapshotBoundary(),
): Promise<PackageResult> {
  const activation = await reviewActivation(ctx);
  if (!activation.enabled && !options.force) {
    throw new ChangeCommandError("review_disabled", "Code review is switched off for this workspace (review.enabled: false). Pass --force to package anyway.");
  }
  if (activation.skipped) {
    throw new ChangeCommandError("change_review_skipped", `Review is skipped for change ${ctx.changeId}.`, { change: ctx.changeId });
  }
  const slice = await resolveSlice(ctx, sliceId);
  await adoptChange(ctx, { activation, ...(options.now ? { now: options.now } : {}) });

  const tasksMd = (await pathExists(slice.tasksPath)) ? await readFile(slice.tasksPath, "utf8") : "";
  const tasks = parseTaskSections(tasksMd);
  const partialReasons: string[] = [];
  if (!isReadyForReview(parseSliceTasksMarkdown(tasksMd).statuses)) {
    const open = tasks.filter((task) => task.status !== "done" && task.status !== "not_tested" && task.status !== "invalid");
    if (!options.partial) {
      throw new ChangeCommandError(
        "slice_not_ready",
        `Slice ${slice.id} is not ready for review: every active task must be done or not_tested. Pass --partial to package it anyway.`,
        { slice: slice.id, tasks: open.map((task) => ({ id: task.id, status: task.status })) },
      );
    }
    partialReasons.push(
      open.length > 0
        ? `tasks not ready for review: ${open.map((task) => `${task.id} (${task.status ?? "unknown"})`).join(", ")}`
        : "the slice has no active tasks",
    );
  }

  const metadata = await readWorkspaceMetadata(ctx.weaveRoot);
  const workspace = metadata?.mode === "workspace";
  const checkouts = await sliceRepoCheckouts(ctx, slice);
  const { run, reservation } = await allocateSliceRun(
    ctx,
    slice,
    checkouts.flatMap((repo) => (repo.path ? [repo.path] : [])),
  );
  const runId = `${slice.id}/${run}`;
  const endRef = sliceRunEndRef(ctx.changeId, slice.id, run);

  const changeStatus = await readYamlRecord(path.join(ctx.changePath, "status.yml"));
  const mainRoot = (await mainWorktreePath(ctx.weaveRoot)) ?? ctx.weaveRoot;
  const startRef = (await readSliceReview(slice.statusPath))?.start_ref;
  const anchors = parseFileAnchors(tasksMd);
  const ownership: SliceOwnership = { repos: checkouts.map((repo) => repo.id), anchors };
  const warnings: string[] = [];
  const repos: RepoDiff[] = [];

  for (const checkout of checkouts) {
    const diff = await diffRepo(ctx, checkout, { boundary, endRef, startRef, changeStatus, mainRoot, ownership, noAnchors: anchors.length === 0 });
    repos.push(diff);
    if (!diff.checkedOut) {
      partialReasons.push(`repo ${checkout.id} is not checked out here`);
      addOnce(warnings, "missing_repo_checkout");
    }
    if (diff.startRefMissing) addOnce(warnings, "start_ref_missing_on_this_machine");
    if (diff.baseUnknown) {
      partialReasons.push(`repo ${checkout.id} has no diff base`);
      addOnce(warnings, "base_unknown");
    }
    if (diff.fromMainUnknown) addOnce(warnings, "from_main_unknown");
  }
  if (anchors.length === 0) addOnce(warnings, "no_file_anchors");

  const guidelines = await resolveGuidelines({
    checkoutRoot: ctx.weaveRoot,
    mode: workspace ? "workspace" : "repo",
    repos: guidelineRepos(metadata, checkouts.map((repo) => repo.id)),
  });
  for (const repo of guidelines.missingRepos) {
    const reason = `repo ${repo} is not checked out here`;
    if (!partialReasons.includes(reason)) partialReasons.push(reason);
  }

  const files = repos.reduce((sum, repo) => sum + repo.owned.length + repo.foreign.length, 0);
  const lines = repos.reduce((sum, repo) => sum + repo.lines, 0);
  const diffed = repos.flatMap((repo) => [...repo.owned, ...repo.foreign]);
  const rulings = await classifyRulings(ctx, { kind: "slice", slice: slice.id, files: diffed.map((file) => ({ repo: file.repo, path: file.path })) });
  for (const warning of rulings.warnings) addOnce(warnings, warning);
  // What this run is judged against. A run that ends up waiting on a person is compared with it on
  // every read, so a plan change shows as `not_reviewed (plan changed)`; finalize replaces it.
  const planBasis = await computePlanBasis(ctx.changePath, slice.id, await planDecisionIds(ctx.weaveRoot, diffed.map(weaveRelativePath), []), {
    weaveRoot: ctx.weaveRoot,
  });
  const model: PackageModel = {
    runId,
    ctx,
    slice,
    workspace,
    repos,
    partialReasons,
    warnings,
    modelLevel: sliceModelLevel(lines),
    sizeHint: { files, lines },
    planningDocs: await planningDocuments(ctx, slice, changeStatus),
    decisions: await applicableDecisions(ctx, diffed),
    guidelines,
    tasks,
    evidence: parseTaskEvidence(tasksMd),
    noAnchors: anchors.length === 0,
    rulings: { settled: rulings.settled, reopened: rulings.reopened },
  };

  const packagePath = options.out ? path.resolve(options.out) : reservation;
  await mkdir(path.dirname(packagePath), { recursive: true });
  await writeFile(packagePath, renderSlicePackage(model));
  if (packagePath !== reservation) {
    await writeFile(reservation, `# Review package ${runId}\n\nWritten to ${packagePath}\n`);
  }

  const partial = partialReasons.length > 0;
  await updateSliceReview(
    ctx,
    slice.id,
    (block) => ({ ...(block ?? {}), state: "in_review", latest_run: run, partial, plan_basis: planBasis }),
    options.now ? { now: options.now } : {},
  );

  const fallbacks = repos.flatMap((repo) => (repo.from?.kind === "fallback" ? [repo.from.base] : []));
  return {
    status: "ok",
    run_id: runId,
    package_path: packagePath,
    scope: { kind: "slice", slice: slice.id },
    partial,
    partial_reasons: partialReasons,
    fallback_base: fallbacks.includes("change_base") ? "change_base" : fallbacks.includes("merge_base") ? "merge_base" : null,
    foreign_files: model.noAnchors ? 0 : repos.reduce((sum, repo) => sum + repo.foreign.length, 0),
    model_level: model.modelLevel,
    size_hint: model.sizeHint,
    settled_rulings: rulings.settled.length,
    reopened_rulings: rulings.reopened.length,
    from_main_files: repos.reduce((sum, repo) => sum + repo.fromMain.length, 0),
    warnings,
  };
}

async function diffRepo(
  ctx: ReviewContext,
  checkout: SliceRepoCheckout,
  input: {
    boundary: ReviewBoundary;
    endRef: string;
    startRef: string | undefined;
    changeStatus: Record<string, unknown> | undefined;
    mainRoot: string;
    ownership: SliceOwnership;
    noAnchors: boolean;
  },
): Promise<RepoDiff> {
  const repoPath = checkout.path;
  const result: RepoDiff = {
    repo: checkout.id,
    repoDir: repoPath ? toPosix(path.relative(ctx.weaveRoot, repoPath)) : "",
    checkedOut: repoPath !== undefined,
    owned: [],
    foreign: [],
    fromMain: [],
    lines: 0,
    ownedDiff: "",
    foreignDiff: "",
  };
  if (!repoPath) {
    return result;
  }

  const base = await resolveDiffBase({ repoPath, repoId: checkout.id, changeStatus: input.changeStatus, mainRoot: input.mainRoot });
  const end = await input.boundary.create({ repoPath, ref: input.endRef, ...(base.sha ? { mergeBase: base.sha } : {}), force: true });
  result.end = { ref: end.ref, sha: end.sha };

  if (input.startRef) {
    const start = await input.boundary.read(repoPath, input.startRef);
    if (start) {
      result.from = { kind: "start", ref: input.startRef, sha: start.sha };
      if (start.mergeBase && end.mergeBase && start.mergeBase !== end.mergeBase) {
        result.mergeBaseMoved = { from: start.mergeBase, to: end.mergeBase };
      }
    } else {
      result.startRefMissing = true;
    }
  }
  if (!result.from) {
    if (!base.sha) {
      result.baseUnknown = true;
      return result;
    }
    result.from = {
      kind: "fallback",
      base: base.source === "merge_base" ? "merge_base" : "change_base",
      sha: base.sha,
      ...(base.target ? { target: base.target } : {}),
    };
  }

  const weaveRel = path.relative(repoPath, ctx.weaveRoot);
  const exclude = weaveRel.startsWith("..") || path.isAbsolute(weaveRel) ? [] : excludedPathspecs(toPosix(weaveRel));
  const options = { context: packageDiffContext, exclude };
  let stat = await input.boundary.diffStat(repoPath, result.from.sha, input.endRef, options);
  // After a rebase between the boundaries, files that came in from main are listed apart and left
  // out of the diff, the size, and the ownership labels.
  let fromMain: string[] = [];
  if (result.mergeBaseMoved) {
    try {
      fromMain = await filesFromMain(repoPath, { oldBase: result.mergeBaseMoved.from, newBase: result.mergeBaseMoved.to, end: end.sha, paths: stat.paths });
    } catch {
      result.fromMainUnknown = true;
    }
  }
  const mainExcludes = fromMain.map(literalExclude);
  if (fromMain.length > 0) {
    stat = await input.boundary.diffStat(repoPath, result.from.sha, input.endRef, { ...options, exclude: [...exclude, ...mainExcludes] });
  }
  result.fromMain = fromMain.map((file) => ({ repo: checkout.id, path: file, repoDir: result.repoDir }));
  result.lines = stat.lines;
  const changed = stat.paths.map((file) => ({ repo: checkout.id, path: file, repoDir: result.repoDir }));
  // Without any anchors nothing can be told apart, so every file counts as the slice's own.
  const { owned, foreign } = input.noAnchors ? { owned: changed, foreign: [] } : labelForeignFiles(changed, input.ownership);
  result.owned = owned;
  result.foreign = foreign;
  if (owned.length > 0) {
    result.ownedDiff = await input.boundary.diff(repoPath, result.from.sha, input.endRef, {
      context: packageDiffContext,
      exclude: [...exclude, ...mainExcludes, ...foreign.map((file) => literalExclude(file.path))],
    });
  }
  if (foreign.length > 0) {
    result.foreignDiff = await input.boundary.diff(repoPath, result.from.sha, input.endRef, {
      context: packageDiffContext,
      exclude: [...exclude, ...mainExcludes, ...owned.map((file) => literalExclude(file.path))],
    });
  }
  return result;
}

// Planning documents by change type: the PRD and architecture for `feat`, findings for `fix`, the
// exploration otherwise; architecture whenever it exists; always the slice's own `slice.md`, plus
// its `contracts.md` when present. Paths are relative to the checkout root.
async function planningDocuments(
  ctx: ReviewContext,
  slice: SliceLocation,
  changeStatus: Record<string, unknown> | undefined,
): Promise<Array<{ label: string; path: string; present: boolean }>> {
  const type = typeof changeStatus?.type === "string" ? changeStatus.type : "feat";
  const docs: Array<{ label: string; path: string; present: boolean }> = [];
  const add = async (label: string, absolute: string): Promise<void> => {
    docs.push({ label, path: toPosix(path.relative(ctx.weaveRoot, absolute)), present: await pathExists(absolute) });
  };

  if (type === "feat") {
    await add("PRD", path.join(ctx.changePath, "prd.md"));
  } else if (type === "fix") {
    await add("Findings", path.join(ctx.changePath, "findings.md"));
  } else {
    await add("Exploration", path.join(ctx.changePath, "exploration.md"));
  }
  const architecture = await markdownFiles(path.join(ctx.changePath, "architecture"));
  if (architecture.length === 0 && type === "feat") {
    await add("Architecture", path.join(ctx.changePath, "architecture", "index.md"));
  }
  for (const file of architecture) {
    await add("Architecture", file);
  }
  await add("Slice", path.join(slice.path, "slice.md"));
  const contracts = path.join(slice.path, "contracts.md");
  if (await pathExists(contracts)) {
    await add("Slice contracts", contracts);
  }
  return docs;
}

// Accepted decisions whose `applies_to` matches any diffed file (Weave-root-relative).
async function applicableDecisions(ctx: ReviewContext, diffed: DiffedPath[]): Promise<DecisionSummary[]> {
  let decisions: DecisionSummary[];
  try {
    decisions = (await listDecisions({ cwd: ctx.weaveRoot, status: "accepted" })).decisions;
  } catch {
    return [];
  }
  const files = diffed.map(weaveRelativePath);
  return decisions.filter((decision) => decision.applies_to.some((pattern) => files.some((file) => matchesAppliesTo(file, pattern))));
}

// --- rendering -------------------------------------------------------------------------------

export function renderSlicePackage(model: PackageModel): string {
  const { ctx, slice } = model;
  const out: string[] = [];
  const repoIds = model.repos.map((repo) => repo.repo);
  out.push(`# Review package: ${model.runId}`, "");
  out.push(`- Run: \`${model.runId}\``);
  out.push(`- Scope: slice \`${slice.id}\` of change \`${ctx.changeId}\``);
  out.push(`- Repos: ${repoIds.join(", ") || "none"}`);
  out.push(`- Partial: ${model.partialReasons.length > 0 ? `yes (${model.partialReasons.join("; ")})` : "no"}`);
  out.push(`- Warnings: ${model.warnings.length > 0 ? model.warnings.join(", ") : "none"}`);
  out.push(`- Size: ${model.sizeHint.files} files, ${model.sizeHint.lines} changed lines; model level hint: ${model.modelLevel}`);
  out.push("");
  out.push("Paths are relative to each repo root" + (model.workspace ? ", prefixed by the repo id." : "."));
  out.push("Boundaries are snapshots of the working tree on the machine that built the slice.");
  out.push("");

  out.push("## Boundaries", "");
  for (const repo of model.repos) {
    out.push(`### ${repo.repo}`, "");
    if (!repo.checkedOut) {
      out.push("- Not checked out here: no diff for this repo.", "");
      continue;
    }
    if (repo.from?.kind === "start") {
      out.push(`- From: start snapshot \`${repo.from.ref}\` (${short(repo.from.sha)})`);
    } else if (repo.from?.kind === "fallback") {
      const detail =
        repo.from.base === "merge_base"
          ? `merge-base with \`${repo.from.target ?? "the target branch"}\``
          : "the recorded base commit";
      const reason = repo.startRefMissing ? "the start snapshot is missing on this machine" : "the slice has no start snapshot";
      out.push(`- From: fallback base: change base, ${detail} (${short(repo.from.sha)}); ${reason}, so earlier slices' work may be included`);
    } else {
      out.push("- From: no diff base (base_unknown): no target branch and no recorded base commit, so no diff for this repo");
    }
    if (repo.end) {
      out.push(`- To: end snapshot \`${repo.end.ref}\` (${short(repo.end.sha)})`);
    }
    out.push("");
  }

  out.push("## Commits", "", "n/a (snapshots: the slice's work is uncommitted)", "");

  out.push("## Diff stat", "");
  if (model.sizeHint.files === 0) {
    out.push("No files changed.", "");
  } else {
    for (const repo of model.repos) {
      for (const file of repo.owned) out.push(`- ${displayPath(model, file)}`);
      for (const file of repo.foreign) out.push(`- ${displayPath(model, file)} (possibly another slice's work)`);
    }
    out.push("", `${model.sizeHint.files} files changed, ${model.sizeHint.lines} lines added or removed.`, "");
  }

  out.push("## Diff", "");
  if (model.noAnchors) {
    out.push("The slice's tasks name no `Files:` anchors, so every changed file is shown as the slice's own.", "");
  }
  for (const repo of model.repos) {
    if (!repo.checkedOut || !repo.from) continue;
    out.push(`### ${repo.repo}`, "");
    if (repo.owned.length === 0 && repo.foreign.length === 0) {
      out.push("No changes.", "");
      continue;
    }
    out.push("#### Slice files", "");
    out.push(...(repo.ownedDiff ? fenced("diff", repo.ownedDiff) : ["None."]), "");
    if (repo.foreign.length > 0) {
      out.push("#### Possibly another slice's work", "");
      out.push(
        "These files changed between the boundaries but are outside the slice's task `Files:` anchors. Another slice may have changed them. Judge only the slice files; mention these only where the slice's own code depends on them.",
        "",
      );
      out.push(...fenced("diff", repo.foreignDiff), "");
    }
  }

  const fromMain = model.repos.filter((repo) => repo.fromMain.length > 0);
  if (fromMain.length > 0) {
    out.push("## From main (ignore)", "");
    out.push(
      "The change was rebased onto main between the slice's boundaries, so these files changed on main, not in this slice. They are left out of the diff above and of the review's fingerprint. Do not review them.",
      "",
    );
    for (const repo of fromMain) {
      if (repo.mergeBaseMoved) {
        out.push(`- ${repo.repo}: merge-base moved from ${short(repo.mergeBaseMoved.from)} to ${short(repo.mergeBaseMoved.to)}`);
      }
      for (const file of repo.fromMain) out.push(`  - ${displayPath(model, file)}`);
    }
    out.push("");
  }

  out.push("## Context", "");
  out.push("### Planning documents", "");
  for (const doc of model.planningDocs) {
    out.push(`- ${doc.label}: \`${doc.path}\`${doc.present ? "" : " (missing)"}`);
  }
  out.push("");

  out.push("### Decisions that apply", "");
  if (model.decisions.length === 0) {
    out.push("No accepted decision applies to the changed files.");
  } else {
    for (const decision of model.decisions) {
      out.push(`- \`${decision.id}\`: ${decision.title} (\`${toPosix(decision.path)}\`)`);
    }
  }
  out.push("");

  out.push("### Coding guidelines", "");
  for (const file of model.guidelines.files) {
    if (file.scope === "shared") {
      out.push(file.status === "present" ? `- Shared: \`${file.path}\`` : `- Shared: no shared guidelines found (\`${file.path}\` is absent)`);
    } else {
      out.push(`- ${file.repo}: \`${file.path}\`${file.status === "present" ? "" : " (absent)"}`);
    }
  }
  if (model.guidelines.missingRepos.length > 0) {
    out.push(`- Not checked out here, guidelines unknown: ${model.guidelines.missingRepos.join(", ")}`);
  }
  if (model.workspace) {
    out.push("", "A repo's own file wins where it conflicts with the shared file.");
  }
  out.push("");

  out.push("### Settled rulings (do not raise again)", "");
  if (model.rulings.settled.length === 0) {
    out.push("None.");
  } else {
    out.push("Earlier reviews ruled on these findings and nothing they relied on has changed. Do not raise them again.", "");
    for (const ruling of model.rulings.settled) out.push(...renderRuling(model, ruling));
  }
  out.push("");

  out.push("### Reopened rulings", "");
  if (model.rulings.reopened.length === 0) {
    out.push("None.");
  } else {
    out.push("Earlier reviews ruled on these findings, but something the ruling relied on has changed since. Judge them again.", "");
    for (const ruling of model.rulings.reopened) {
      out.push(...renderRuling(model, ruling), `  - Changed since the ruling: ${ruling.changed.map((entry) => `\`${entry}\``).join(", ")}`);
    }
  }
  out.push("");

  out.push("### Task evidence (claims to verify)", "");
  out.push("These are the builder's own verification notes. Treat them as claims to check against the diff, not as facts.", "");
  if (model.evidence.evidence.length === 0) {
    out.push("None recorded.");
  } else {
    const titles = new Map(model.tasks.map((task) => [task.id, task]));
    for (const entry of model.evidence.evidence) {
      const task = titles.get(entry.task);
      out.push(`#### ${entry.task}: ${task?.title ?? ""} (${task?.status ?? "unknown"})`, "");
      out.push(...entry.lines, "");
    }
  }
  out.push("");

  out.push("### Untested tasks", "");
  out.push(...(model.evidence.untested.length === 0 ? ["None."] : model.evidence.untested.map((task) => `- ${task.id}: ${task.title}`)), "");

  out.push("### Human checks (needs your check)", "");
  out.push(...(model.evidence.humanChecks.length === 0 ? ["None."] : model.evidence.humanChecks.map((check) => `- ${check.task}: ${check.step}`)), "");

  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

// --- change package --------------------------------------------------------------------------

export interface ChangePackageResult extends PackageResult {
  scope: { kind: "change" };
  model_level: "most_capable";
  gate: Pick<GateResult, "pass" | "blocking" | "flat">;
  // Files under "Plan and docs edits".
  plan_and_docs_files: number;
  // Saved Minors from the slices' latest runs, listed for the final reviewer to sort.
  saved_minors: number;
}

// Allocates the next change run `f<N>` under the change lock and reserves it by creating its
// package file, like `allocateSliceRun`.
export async function allocateChangeRun(ctx: ReviewContext, repoPaths: string[]): Promise<{ run: string; reservation: string }> {
  const dir = slicePackageDir(ctx, changeScopeId);
  await ensureTmpIgnored(ctx.weaveRoot);
  await mkdir(dir, { recursive: true });
  return withChangeLock(ctx.changePath, ctx.changeId, async () => {
    const names: string[] = [];
    const refPrefix = `${reviewRefPrefix}/${ctx.changeId}/${changeScopeId}/`;
    for (const repoPath of repoPaths) {
      const refs = await runGit(["for-each-ref", "--format=%(refname)", refPrefix], repoPath);
      if (refs.ok) names.push(...refs.stdout.split("\n").filter(Boolean).map((ref) => ref.slice(refPrefix.length)));
    }
    names.push(...(await listNames(path.join(ctx.changePath, "review"))), ...(await listNames(dir)));
    const latest = (await readChangeReview(ctx.changePath).catch(() => undefined))?.latest_run;
    if (typeof latest === "string") names.push(latest);

    for (let number = nextRunNumber(names, "f"); ; number += 1) {
      const reservation = path.join(dir, `f${number}.package.md`);
      try {
        await writeFile(reservation, `# Review package change/f${number}\n\nBeing written.\n`, { flag: "wx" });
        return { run: `f${number}`, reservation };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  });
}

interface ChangeRepoDiff {
  repo: string;
  repoDir: string;
  checkedOut: boolean;
  base?: { sha: string; source: "merge_base" | "base_commit"; target?: string };
  baseUnknown?: boolean;
  end?: { ref: string; sha: string };
  commits: string[];
  code: DiffedPath[];
  docs: DiffedPath[];
  lines: number;
  codeDiff: string;
  docsDiff: string;
}

interface SliceSavedItems {
  slice: string;
  state: string;
  run: string | null;
  minors: StoredFinding[];
  fixesNeedingCheck: StoredFinding[];
}

interface ChangePackageModel {
  runId: string;
  ctx: ReviewContext;
  workspace: boolean;
  flat: boolean;
  repos: ChangeRepoDiff[];
  partialReasons: string[];
  warnings: string[];
  gate: GateResult;
  sizeHint: { files: number; lines: number };
  planningDocs: Array<{ label: string; path: string; present: boolean }>;
  decisions: DecisionSummary[];
  guidelines: GuidelineResolution;
  rulings: { settled: Ruling[]; reopened: Ruling[] };
  saved: SliceSavedItems[];
  untested: Array<{ id: string; title: string }>;
  humanChecks: Array<{ task: string; step: string }>;
  evidence: Array<{ task: string; title: string; status: string | null; lines: string[] }>;
}

// `weave review package --change`: the whole change for the final reviewer. Checks the gate (a
// failing gate needs `--partial` and makes the run partial), allocates `change/f<N>`, takes the end
// snapshot `_change/f<N>/end` in every change repo, and writes one package: the diff from each
// repo's diff base (merge-base with the target branch, else `base_commit`) to the end snapshot,
// with knowledge, decision, and guideline edits apart under "Plan and docs edits", and the saved
// Minors, rulings, untested tasks, and human checks of every slice. Works in flat mode. Marks the
// change review `in_progress`.
export async function buildChangePackage(
  ctx: ReviewContext,
  options: SlicePackageOptions = {},
  boundary: ReviewBoundary = new SnapshotBoundary(),
): Promise<ChangePackageResult> {
  const activation = await reviewActivation(ctx);
  if (!activation.enabled && !options.force) {
    throw new ChangeCommandError("review_disabled", "Code review is switched off for this workspace (review.enabled: false). Pass --force to package anyway.");
  }
  if (activation.skipped) {
    throw new ChangeCommandError("change_review_skipped", `Review is skipped for change ${ctx.changeId}.`, { change: ctx.changeId });
  }
  await adoptChange(ctx, { activation, ...(options.now ? { now: options.now } : {}) });
  const gate = await evaluateGate(ctx, { evaluateWhenInactive: true, ...(options.now ? { now: options.now } : {}) });
  const partialReasons: string[] = [];
  if (!gate.pass) {
    if (!options.partial) {
      throw new ChangeCommandError(
        "gate_failed",
        `The final review cannot start yet: ${gate.blocking.map(describeBlocking).join("; ")}. Pass --partial to package the change anyway.`,
        { blocking: gate.blocking },
      );
    }
    partialReasons.push(`the gate fails: ${gate.blocking.map(describeBlocking).join("; ")}`);
  }

  const metadata = await readWorkspaceMetadata(ctx.weaveRoot);
  const workspace = metadata?.mode === "workspace";
  const checkouts = await changeRepoCheckouts(ctx);
  const { run, reservation } = await allocateChangeRun(ctx, checkouts.flatMap((repo) => (repo.path ? [repo.path] : [])));
  const runId = `change/${run}`;
  const endRef = changeRunRef(ctx.changeId, run, "end");
  const changeStatus = await readYamlRecord(path.join(ctx.changePath, "status.yml"));
  const mainRoot = (await mainWorktreePath(ctx.weaveRoot)) ?? ctx.weaveRoot;
  const warnings: string[] = [];
  const repos: ChangeRepoDiff[] = [];
  for (const checkout of checkouts) {
    const diff = await diffChangeRepo(ctx, checkout, { boundary, endRef, changeStatus, mainRoot });
    repos.push(diff);
    if (!diff.checkedOut) {
      partialReasons.push(`repo ${checkout.id} is not checked out here`);
      addOnce(warnings, "missing_repo_checkout");
    }
    if (diff.baseUnknown) {
      partialReasons.push(`repo ${checkout.id} has no diff base`);
      addOnce(warnings, "base_unknown");
    }
  }

  const guidelines = await resolveGuidelines({
    checkoutRoot: ctx.weaveRoot,
    mode: workspace ? "workspace" : "repo",
    repos: guidelineRepos(metadata, checkouts.map((repo) => repo.id)),
  });
  for (const repo of guidelines.missingRepos) {
    const reason = `repo ${repo} is not checked out here`;
    if (!partialReasons.includes(reason)) partialReasons.push(reason);
  }

  const diffed = repos.flatMap((repo) => [...repo.code, ...repo.docs]);
  const rulings = await classifyRulings(ctx, { kind: "change" });
  for (const warning of rulings.warnings) addOnce(warnings, warning);
  const slices = await listSlices(ctx);
  const saved: SliceSavedItems[] = [];
  const untested: Array<{ id: string; title: string }> = [];
  const humanChecks: Array<{ task: string; step: string }> = [];
  const evidence: ChangePackageModel["evidence"] = [];
  const taskSources = slices.length > 0 ? slices.map((slice) => ({ prefix: `${slice.id}/`, file: slice.tasksPath })) : [{ prefix: "", file: changeRunLocation(ctx).tasksPath }];
  for (const source of taskSources) {
    const tasksMd = (await pathExists(source.file)) ? await readFile(source.file, "utf8") : "";
    const sections = parseTaskSections(tasksMd);
    const own = parseTaskEvidence(tasksMd);
    untested.push(...own.untested.map((task) => ({ id: `${source.prefix}${task.id}`, title: task.title })));
    humanChecks.push(...own.humanChecks.map((check) => ({ task: `${source.prefix}${check.task}`, step: check.step })));
    for (const entry of own.evidence) {
      const task = sections.find((candidate) => candidate.id === entry.task);
      evidence.push({ task: `${source.prefix}${entry.task}`, title: task?.title ?? "", status: task?.status ?? null, lines: entry.lines });
    }
  }
  for (const slice of slices) {
    const block = await readSliceReview(slice.statusPath).catch(() => undefined);
    const latest: RunRecord | undefined = (await readRunRecords(slice).catch(() => [] as RunRecord[]))[0];
    saved.push({
      slice: slice.id,
      state: typeof block?.state === "string" ? block.state : "not_reviewed",
      run: latest?.run ?? null,
      minors: (latest?.findings ?? []).filter((finding) => finding.severity === "minor" && finding.resolution?.as === "parked"),
      fixesNeedingCheck: latest ? fixesNeedingCheck(latest.findings) : [],
    });
  }

  const planBasis = await computeChangePlanBasis(ctx.changePath, await planDecisionIds(ctx.weaveRoot, diffed.map(weaveRelativePath), []), { weaveRoot: ctx.weaveRoot });
  const model: ChangePackageModel = {
    runId,
    ctx,
    workspace,
    flat: slices.length === 0,
    repos,
    partialReasons,
    warnings,
    gate,
    sizeHint: { files: diffed.length, lines: repos.reduce((sum, repo) => sum + repo.lines, 0) },
    planningDocs: await changePlanningDocuments(ctx, slices, changeStatus),
    decisions: await applicableDecisions(ctx, diffed),
    guidelines,
    rulings: { settled: rulings.settled, reopened: rulings.reopened },
    saved,
    untested,
    humanChecks,
    evidence,
  };

  const packagePath = options.out ? path.resolve(options.out) : reservation;
  await mkdir(path.dirname(packagePath), { recursive: true });
  await writeFile(packagePath, renderChangePackage(model));
  if (packagePath !== reservation) {
    await writeFile(reservation, `# Review package ${runId}\n\nWritten to ${packagePath}\n`);
  }

  const partial = partialReasons.length > 0;
  await updateChangeReview(
    ctx,
    (block) => ({ ...(block ?? {}), state: "in_progress", latest_run: run, partial, plan_basis: planBasis }),
    options.now ? { now: options.now } : {},
  );

  return {
    status: "ok",
    run_id: runId,
    package_path: packagePath,
    scope: { kind: "change" },
    partial,
    partial_reasons: partialReasons,
    fallback_base: repos.some((repo) => repo.base?.source === "base_commit") ? "change_base" : null,
    foreign_files: 0,
    model_level: "most_capable",
    size_hint: model.sizeHint,
    settled_rulings: rulings.settled.length,
    reopened_rulings: rulings.reopened.length,
    from_main_files: 0,
    warnings,
    gate: { pass: gate.pass, blocking: gate.blocking, flat: gate.flat },
    plan_and_docs_files: repos.reduce((sum, repo) => sum + repo.docs.length, 0),
    saved_minors: saved.reduce((sum, entry) => sum + entry.minors.length, 0),
  };
}

async function diffChangeRepo(
  ctx: ReviewContext,
  checkout: SliceRepoCheckout,
  input: { boundary: ReviewBoundary; endRef: string; changeStatus: Record<string, unknown> | undefined; mainRoot: string },
): Promise<ChangeRepoDiff> {
  const repoPath = checkout.path;
  const result: ChangeRepoDiff = {
    repo: checkout.id,
    repoDir: repoPath ? toPosix(path.relative(ctx.weaveRoot, repoPath)) : "",
    checkedOut: repoPath !== undefined,
    commits: [],
    code: [],
    docs: [],
    lines: 0,
    codeDiff: "",
    docsDiff: "",
  };
  if (!repoPath) return result;

  const base = await resolveDiffBase({ repoPath, repoId: checkout.id, changeStatus: input.changeStatus, mainRoot: input.mainRoot });
  const end = await input.boundary.create({ repoPath, ref: input.endRef, ...(base.sha ? { mergeBase: base.sha } : {}), force: true });
  result.end = { ref: end.ref, sha: end.sha };
  if (!base.sha || base.source === "unknown") {
    result.baseUnknown = true;
    return result;
  }
  result.base = { sha: base.sha, source: base.source, ...(base.target ? { target: base.target } : {}) };
  const log = await runGit(["log", "--format=%h %s", `${base.sha}..HEAD`], repoPath);
  if (log.ok) result.commits = log.stdout.split("\n").filter(Boolean);

  const weaveRel = path.relative(repoPath, ctx.weaveRoot);
  const exclude = weaveRel.startsWith("..") || path.isAbsolute(weaveRel) ? [] : excludedPathspecs(toPosix(weaveRel));
  const options = { context: packageDiffContext, exclude };
  const stat = await input.boundary.diffStat(repoPath, base.sha, input.endRef, options);
  result.lines = stat.lines;
  for (const file of stat.paths) {
    const entry = { repo: checkout.id, path: file, repoDir: result.repoDir };
    (isPlanOrDocsPath(entry) ? result.docs : result.code).push(entry);
  }
  if (result.code.length > 0) {
    result.codeDiff = await input.boundary.diff(repoPath, base.sha, input.endRef, { ...options, exclude: [...exclude, ...result.docs.map((file) => literalExclude(file.path))] });
  }
  if (result.docs.length > 0) {
    result.docsDiff = await input.boundary.diff(repoPath, base.sha, input.endRef, { ...options, exclude: [...exclude, ...result.code.map((file) => literalExclude(file.path))] });
  }
  return result;
}

// The change's planning documents: the PRD (feat), findings (fix), or exploration; every
// architecture file; every slice's `slice.md` and `contracts.md`; or, in flat mode, `tasks.md`.
async function changePlanningDocuments(
  ctx: ReviewContext,
  slices: SliceLocation[],
  changeStatus: Record<string, unknown> | undefined,
): Promise<Array<{ label: string; path: string; present: boolean }>> {
  const type = typeof changeStatus?.type === "string" ? changeStatus.type : "feat";
  const docs: Array<{ label: string; path: string; present: boolean }> = [];
  const add = async (label: string, absolute: string): Promise<void> => {
    docs.push({ label, path: toPosix(path.relative(ctx.weaveRoot, absolute)), present: await pathExists(absolute) });
  };
  await add(type === "feat" ? "PRD" : type === "fix" ? "Findings" : "Exploration", path.join(ctx.changePath, type === "feat" ? "prd.md" : type === "fix" ? "findings.md" : "exploration.md"));
  const architecture = await markdownFiles(path.join(ctx.changePath, "architecture"));
  if (architecture.length === 0 && type === "feat") {
    await add("Architecture", path.join(ctx.changePath, "architecture", "index.md"));
  }
  for (const file of architecture) await add("Architecture", file);
  if (slices.length === 0) {
    await add("Tasks", changeRunLocation(ctx).tasksPath);
  }
  for (const slice of slices) {
    await add(`Slice ${slice.id}`, path.join(slice.path, "slice.md"));
    const contracts = path.join(slice.path, "contracts.md");
    if (await pathExists(contracts)) await add(`Slice ${slice.id} contracts`, contracts);
  }
  return docs;
}

export function renderChangePackage(model: ChangePackageModel): string {
  const { ctx } = model;
  const out: string[] = [];
  out.push(`# Review package: ${model.runId}`, "");
  out.push(`- Run: \`${model.runId}\``);
  out.push(`- Scope: the whole change \`${ctx.changeId}\`${model.flat ? " (flat: no slices)" : `, ${model.saved.length} slices`}`);
  out.push(`- Repos: ${model.repos.map((repo) => repo.repo).join(", ") || "none"}`);
  out.push(`- Gate: ${model.gate.pass ? "pass" : `fails (${model.gate.blocking.map(describeBlocking).join("; ")})`}`);
  out.push(`- Partial: ${model.partialReasons.length > 0 ? `yes (${model.partialReasons.join("; ")})` : "no"}`);
  out.push(`- Warnings: ${model.warnings.length > 0 ? model.warnings.join(", ") : "none"}`);
  out.push(`- Size: ${model.sizeHint.files} files, ${model.sizeHint.lines} changed lines; model level hint: most_capable`);
  out.push("");
  out.push("Paths are relative to each repo root" + (model.workspace ? ", prefixed by the repo id." : "."));
  out.push("The end boundary is a snapshot of the working tree on this machine. The change's own planning files (`wiki/changes/**`) are never part of the diff.");
  out.push("");

  out.push("## Boundaries", "");
  for (const repo of model.repos) {
    out.push(`### ${repo.repo}`, "");
    if (!repo.checkedOut) {
      out.push("- Not checked out here: no diff for this repo, so the review is partial.", "");
      continue;
    }
    if (repo.base) {
      const detail = repo.base.source === "merge_base" ? `merge-base with \`${repo.base.target ?? "the target branch"}\`` : "the recorded base commit (no target branch found)";
      out.push(`- From: diff base, ${detail} (${short(repo.base.sha)})`);
    } else {
      out.push("- From: no diff base (base_unknown): no target branch and no recorded base commit, so no diff for this repo");
    }
    if (repo.end) out.push(`- To: end snapshot \`${repo.end.ref}\` (${short(repo.end.sha)})`);
    out.push("");
  }

  out.push("## Commits", "");
  const withCommits = model.repos.filter((repo) => repo.commits.length > 0);
  if (withCommits.length === 0) {
    out.push("None: the change's work is uncommitted (the diff is against the working tree snapshot).", "");
  } else {
    for (const repo of withCommits) {
      out.push(`### ${repo.repo}`, "", ...repo.commits.map((commit) => `- ${commit}`), "");
    }
  }

  out.push("## Diff stat", "");
  const code = model.repos.flatMap((repo) => repo.code);
  const docs = model.repos.flatMap((repo) => repo.docs);
  if (code.length + docs.length === 0) {
    out.push("No files changed.", "");
  } else {
    for (const file of code) out.push(`- ${model.workspace ? `${file.repo}:${file.path}` : file.path}`);
    for (const file of docs) out.push(`- ${model.workspace ? `${file.repo}:${file.path}` : file.path} (plan and docs edit)`);
    out.push("", `${model.sizeHint.files} files changed, ${model.sizeHint.lines} lines added or removed.`, "");
  }

  out.push("## Diff", "");
  for (const repo of model.repos) {
    if (!repo.checkedOut || !repo.base) continue;
    out.push(`### ${repo.repo}`, "");
    out.push(...(repo.codeDiff ? fenced("diff", repo.codeDiff) : ["No code changes."]), "");
  }

  out.push("## Plan and docs edits", "");
  out.push(
    "Edits to the knowledge wiki, recorded decisions, and coding guidelines. They are not code: check that they agree with the code above and with each other, and that the knowledge wiki will still describe the product once the change lands.",
    "",
  );
  if (docs.length === 0) {
    out.push("None.", "");
  } else {
    for (const repo of model.repos) {
      if (!repo.docsDiff) continue;
      out.push(`### ${repo.repo}`, "", ...fenced("diff", repo.docsDiff), "");
    }
  }

  out.push("## Context", "");
  out.push("### Planning documents", "");
  for (const doc of model.planningDocs) out.push(`- ${doc.label}: \`${doc.path}\`${doc.present ? "" : " (missing)"}`);
  out.push("");

  out.push("### Decisions that apply", "");
  if (model.decisions.length === 0) {
    out.push("No accepted decision applies to the changed files.");
  } else {
    for (const decision of model.decisions) out.push(`- \`${decision.id}\`: ${decision.title} (\`${toPosix(decision.path)}\`)`);
  }
  out.push("");

  out.push("### Coding guidelines", "");
  for (const file of model.guidelines.files) {
    if (file.scope === "shared") {
      out.push(file.status === "present" ? `- Shared: \`${file.path}\`` : `- Shared: no shared guidelines found (\`${file.path}\` is absent)`);
    } else {
      out.push(`- ${file.repo}: \`${file.path}\`${file.status === "present" ? "" : " (absent)"}`);
    }
  }
  if (model.guidelines.missingRepos.length > 0) out.push(`- Not checked out here, guidelines unknown: ${model.guidelines.missingRepos.join(", ")}`);
  if (model.workspace) out.push("", "A repo's own file wins where it conflicts with the shared file.");
  out.push("");

  if (!model.flat) {
    out.push("### Slice reviews", "");
    for (const entry of model.saved) out.push(`- \`${entry.slice}\`: ${entry.state.replace(/_/g, " ")}${entry.run ? ` (latest run \`${entry.run}\`)` : ""}`);
    out.push("");
  }

  out.push("### Saved Minors (sort each one)", "");
  const minors = model.saved.flatMap((entry) => entry.minors.map((finding) => ({ slice: entry.slice, finding })));
  if (minors.length === 0) {
    out.push("None.");
  } else {
    out.push("Slice reviews saved these Minor findings for the final review. Sort every one into `must_fix` or `can_wait` in `final_only.minor_sort`, using its full id.", "");
    for (const { slice, finding } of minors) {
      const location = `${model.workspace ? `${finding.location.repo}:` : ""}${finding.location.path}${finding.location.line ? `:${finding.location.line}` : ""}`;
      out.push(`- \`${finding.id}\` (slice \`${slice}\`) at \`${location}\`: ${oneLine(finding.detail)}${finding.fix_hint ? ` Fix hint: ${oneLine(finding.fix_hint)}` : ""}`);
    }
  }
  out.push("");

  out.push("### Settled rulings (do not raise again)", "");
  if (model.rulings.settled.length === 0) {
    out.push("None.");
  } else {
    out.push(
      "Slice reviews or earlier final reviews ruled on these findings and nothing they relied on has changed. Do not raise them again. Sort every slice review ruling (`<slice>/r<N>-F<n>`) into `must_fix` (its cost if wrong is not acceptable for the whole change; it is reopened for the fix batch) or `can_wait` (it stays parked) in `final_only.minor_sort`, using its full id. A ruling from an earlier final review is not sorted: when its cost if wrong is not acceptable, raise a new finding.",
      "",
    );
    for (const ruling of model.rulings.settled) out.push(...renderRuling(model, ruling));
  }
  out.push("");

  out.push("### Reopened rulings", "");
  if (model.rulings.reopened.length === 0) {
    out.push("None.");
  } else {
    out.push("Earlier reviews ruled on these findings, but something the ruling relied on has changed since. Judge them again, and sort each slice review ruling among them in `final_only.minor_sort` as above.", "");
    for (const ruling of model.rulings.reopened) {
      out.push(...renderRuling(model, ruling), `  - Changed since the ruling: ${ruling.changed.map((entry) => `\`${entry}\``).join(", ")}`);
    }
  }
  out.push("");

  out.push("### Task evidence (claims to verify)", "");
  out.push("These are the builders' own verification notes. Treat them as claims to check against the diff, not as facts.", "");
  if (model.evidence.length === 0) {
    out.push("None recorded.");
  } else {
    for (const entry of model.evidence) out.push(`#### ${entry.task}: ${entry.title} (${entry.status ?? "unknown"})`, "", ...entry.lines, "");
  }
  out.push("");

  out.push("### Untested tasks", "");
  out.push(...(model.untested.length === 0 ? ["None."] : model.untested.map((task) => `- ${task.id}: ${task.title}`)), "");

  out.push("### Human checks (needs your check)", "");
  const checks = [
    ...model.humanChecks.map((check) => `- ${check.task}: ${check.step}`),
    ...model.saved.flatMap((entry) => entry.fixesNeedingCheck.map((finding) => `- \`${finding.id}\`: a slice review fix; repeat the slice's human checks against it`)),
  ];
  out.push(...(checks.length === 0 ? ["None."] : checks), "");

  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

// --- helpers ---------------------------------------------------------------------------------

function renderRuling(model: { workspace: boolean }, ruling: Ruling): string[] {
  const location = `${model.workspace ? `${ruling.location.repo}:` : ""}${ruling.location.path}${ruling.location.line ? `:${ruling.location.line}` : ""}`;
  const fails = `${ruling.fails.type}${ruling.fails.ref ? `: ${ruling.fails.ref}` : ""}`;
  return [
    `- \`${ruling.finding}\` (${ruling.severity}, ${ruling.kind}) at \`${location}\`, fails ${oneLine(fails)}: ${oneLine(ruling.detail)}`,
    `  - Ruling (${ruling.agreed ? "agreed the finding is real" : "disagreed"}): ${oneLine(ruling.reason)}`,
    `  - Cost if wrong: ${oneLine(ruling.cost_if_wrong)}`,
  ];
}

function oneLine(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, " ").trim();
}

function taskRef(task: TaskSection): TaskRef {
  return { id: task.id, title: task.title, status: task.status };
}

function asTaskStatus(value: string): TaskStatus | null {
  const normalized = value.trim().toLowerCase();
  return ["todo", "in_progress", "done", "not_tested", "blocked", "invalid"].includes(normalized) ? (normalized as TaskStatus) : null;
}

// The path of a `Files:` entry such as "`src/lib/foo.ts` (C: bar)" or "src/lib/foo.ts (M)".
function anchorPath(entry: string): string | undefined {
  const trimmed = entry.trim();
  const quoted = /`([^`]+)`/.exec(trimmed);
  const value = (quoted ? quoted[1] : trimmed.split(/\s+/)[0] ?? "").trim().replace(/^\.\//, "");
  if (!value || value.toLowerCase() === "none" || value.startsWith("<")) {
    return undefined;
  }
  return value;
}

function weaveRelativePath(file: DiffedPath): string {
  return file.repoDir ? path.posix.join(file.repoDir, file.path) : file.path;
}

function displayPath(model: PackageModel, file: DiffedPath): string {
  return model.workspace ? `${file.repo}:${file.path}` : file.path;
}

function literalExclude(file: string): string {
  return `:(exclude,literal)${file}`;
}

// A fence longer than any backtick run in the content.
export function fenced(language: string, content: string): string[] {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return [`${fence}${language}`, content.replace(/\n$/, ""), fence];
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function addOnce(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

// Creates `.weave/tmp/` with a `.gitignore` of `*`, so packages are never committed or snapshotted.
export async function ensureTmpIgnored(weaveRoot: string): Promise<void> {
  const tmp = path.join(weaveRoot, ".weave", "tmp");
  await mkdir(tmp, { recursive: true });
  try {
    await writeFile(path.join(tmp, ".gitignore"), "*\n", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function markdownFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await markdownFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(full);
    }
  }
  // The folder's own index.md first, the way the architecture folder is read.
  const index = files.indexOf(path.join(dir, "index.md"));
  return index > 0 ? [files[index], ...files.slice(0, index), ...files.slice(index + 1)] : files;
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
