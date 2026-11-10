// Fix rounds of a review run (architecture § Slice flow step 5, § Resolving a plan problem;
// schema.md Refs and Readable records; decision 261110-wdfo). A round is bounded by two snapshots:
// `snapshot --at round-start` before the agent fixes anything, and `package --fix-round`, which
// takes the round end, saves the exact round patch beside the slice (reversible with
// `git apply -R` from the Weave root, never touching `wiki/changes/**`), and writes a small package
// for a fresh fix checker. Rounds are numbered from 1 per run and recorded under `rounds[]` in the
// run's findings file; the refs are the boundaries, the findings file is the record.
//
// The skill decides how many rounds to run (`review.slice_rounds`); this module only keeps them
// in order.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { SliceRepoCheckout } from "../../commands/review/snapshot.js";
import { ChangeCommandError } from "../change-error.js";
import { pathExists } from "../files.js";
import { mainWorktreePath } from "../git.js";
import { writeFileAtomic } from "../local-state.js";
import { readWorkspaceMetadata } from "../workspace-repos.js";
import { resolveDiffBase } from "./base.js";
import { changeRunRef, SnapshotBoundary, sliceRoundRef, type ReviewBoundary } from "./boundary.js";
import { CommitBoundary } from "./commit-boundary.js";
import { guidelineRepos, resolveGuidelines, type GuidelineResolution } from "./guidelines.js";
import { ensureTmpIgnored, fenced, packageDiffContext, slicePackageDir } from "./package.js";
import {
  assertRunWritable,
  parseRoundNumber,
  readRunBlock,
  readRunRecord,
  resolveRun,
  runRepoCheckouts,
  runRoundStem,
  updateRunBlock,
  writeRunRecord,
  type ResolvedRun,
  type RunRecord,
  type RunRound,
  type StoredFinding,
} from "./record.js";
import { excludedPathspecs } from "./rules.js";
import type { ReviewContext } from "./state.js";

// The model level hint for a fix checker: a scoped re-check of one round's diff.
export const fixRoundModelLevel = "cheap-mid";
// Lines of context in a saved round patch (git's default, so it applies the way git would).
export const roundPatchContext = 3;

// --- naming ----------------------------------------------------------------------------------

// The boundary ref of one end of a round, the same name in every repo of the run. A change run has
// one fix batch: `_change/f<N>/fix-start` and `fix-end`.
export function roundRef(ctx: ReviewContext, target: ResolvedRun, round: number, point: "start" | "end"): string {
  if (target.scope === "change") {
    return changeRunRef(ctx.changeId, target.run, point === "start" ? "fix-start" : "fix-end");
  }
  return sliceRoundRef(ctx.changeId, target.slice.id, target.run, round, point);
}

// `r1-round2` (or `f1-fix` for a change run): the stem of a round's patch, check, and package files.
export function roundFileStem(target: ResolvedRun, round: number): string {
  return runRoundStem(target, round);
}

// `review/r1-round2.patch`, relative to the slice folder (`review/f1-fix.patch`, relative to the
// change folder, for a change run).
export function roundPatchName(target: ResolvedRun, round: number): string {
  return `review/${roundFileStem(target, round)}.patch`;
}

// --- round start -----------------------------------------------------------------------------

export interface RoundStartOptions {
  run: string;
  round: string | number | undefined;
  // Restart the latest round: replace its start snapshot and forget its end, patch, and package.
  force?: boolean;
  now?: Date;
}

export interface RoundStartResult {
  status: "ok";
  run: string;
  at: "round-start";
  round: number;
  ref: string;
  // Per repo: the ref, or null when the repo is not checked out here.
  refs: Record<string, string | null>;
  // Per repo: the merge-base the snapshot was taken against, or null when it is unknown.
  merge_base: Record<string, string | null>;
  missing_repos: string[];
}

// `snapshot --run <run> --at round-start --round <n>`: records the round's start boundary in every
// slice repo checked out here, before any fix. Round 1 needs a recorded report; round n > 1 needs
// round n-1 to have ended (been packaged). A round already started fails with
// `round_already_started` unless `force` restarts it (only the latest round, and only before it is
// checked or a finding is marked fixed in it).
export async function startFixRound(ctx: ReviewContext, options: RoundStartOptions, boundary: ReviewBoundary = new SnapshotBoundary()): Promise<RoundStartResult> {
  const round = parseRoundNumber(options.round);
  if (round === undefined) {
    throw new ChangeCommandError("invalid_arguments", "--at round-start needs --round <n>: a whole number from 1.", { round: options.round ?? null });
  }
  const target = await resolveRun(ctx, options.run);
  const initial = await writableRunWithReport(ctx, target);
  assertRoundCanStart(target, initial, round, options.force ?? false);

  const ref = roundRef(ctx, target, round, "start");
  const checkouts = await runRepoCheckouts(ctx, target);
  if (!checkouts.some((repo) => repo.path)) {
    throw new ChangeCommandError("missing_repo_checkout", `None of ${target.scope === "change" ? "the change" : `slice ${target.slice.id}`}'s repos is checked out here, so round ${round} cannot start.`, {
      run: target.runId,
      repos: checkouts.map((repo) => repo.id),
    });
  }
  const changeStatus = await readYamlRecord(path.join(ctx.changePath, "status.yml"));
  const mainRoot = (await mainWorktreePath(ctx.weaveRoot)) ?? ctx.weaveRoot;
  const result: RoundStartResult = { status: "ok", run: target.runId, at: "round-start", round, ref, refs: {}, merge_base: {}, missing_repos: [] };
  for (const repo of checkouts) {
    if (!repo.path) {
      result.refs[repo.id] = null;
      result.merge_base[repo.id] = null;
      result.missing_repos.push(repo.id);
      continue;
    }
    const base = await resolveDiffBase({ repoPath: repo.path, repoId: repo.id, changeStatus, mainRoot });
    // The findings file decides whether the round started; a leftover ref from an attempt that
    // never got recorded is replaced.
    const snapshot = await boundary.create({ repoPath: repo.path, ref, ...(base.sha ? { mergeBase: base.sha } : {}), force: true });
    result.refs[repo.id] = snapshot.ref;
    result.merge_base[repo.id] = snapshot.mergeBase ?? null;
  }

  const now = options.now ?? new Date();
  await updateRunBlock(
    ctx,
    target,
    async (block) => {
      const record = await readRunRecord(target.slice, target.run);
      await assertRunWritable(target, block, record);
      if (!record) throw reportNotRecorded(target);
      assertRoundCanStart(target, record, round, options.force ?? false);
      const rounds = (record.rounds ?? []).filter((entry) => entry.round !== round);
      rounds.push({ round, start_ref: ref, started_at: now.toISOString() });
      record.rounds = rounds.sort((left, right) => left.round - right.round);
      record.updated_at = now.toISOString();
      await writeRunRecord(target.slice, record);
      return block;
    },
    { now },
  );
  return result;
}

// A change run has exactly one fix batch (round 1); any later round gives `round_limit`.
function assertRoundCanStart(target: ResolvedRun, record: RunRecord, round: number, force: boolean): void {
  if (target.scope === "change" && round > 1) {
    throw new ChangeCommandError("round_limit", `Run ${target.runId} is a change run: it has one fix batch (round 1), so round ${round} cannot start.`, {
      run: target.runId,
      round,
      limit: 1,
    });
  }
  const rounds = record.rounds ?? [];
  const existing = rounds.find((entry) => entry.round === round);
  if (existing) {
    const later = rounds.some((entry) => entry.round > round);
    const fixedHere = record.findings.some((finding) => finding.resolution?.as === "fixed" && finding.resolution.round === round);
    if (!force || later || existing.check || fixedHere) {
      const why = !force
        ? "Pass --force to restart it."
        : later
          ? "A later round has started, so it can no longer be restarted."
          : "Its fix check or fixes are already recorded, so it can no longer be restarted.";
      throw new ChangeCommandError("round_already_started", `Round ${round} of run ${target.runId} has already started. ${why}`, {
        run: target.runId,
        round,
      });
    }
    return;
  }
  if (round === 1) return;
  const previous = rounds.find((entry) => entry.round === round - 1);
  if (!previous) {
    throw new ChangeCommandError("round_not_started", `Round ${round - 1} of run ${target.runId} never started, so round ${round} cannot start.`, {
      run: target.runId,
      round,
      previous_round: round - 1,
      rounds: rounds.map((entry) => entry.round),
    });
  }
  if (!previous.end_ref) {
    throw new ChangeCommandError(
      "round_not_ended",
      `Round ${round - 1} of run ${target.runId} has not ended. Run \`weave review package --run ${target.runId} --fix-round ${round - 1}\` first.`,
      { run: target.runId, round, previous_round: round - 1 },
    );
  }
}

// --- round package ---------------------------------------------------------------------------

export interface FixRoundPackageOptions {
  // Write the package here instead of the default location.
  out?: string;
  now?: Date;
}

export interface FixRoundPackageResult {
  status: "ok";
  run_id: string;
  round: number;
  package_path: string;
  patch_path: string;
  model_level: typeof fixRoundModelLevel;
  size_hint: { files: number; lines: number };
  // Per repo: the repo-relative paths the round changed (the paths in the patch).
  files_touched: Record<string, string[]>;
  // The open Critical and Important findings the round set out to fix.
  targets: string[];
  // Reverses the round, run from the Weave root.
  undo: string;
  warnings: string[];
}

interface RoundRepoDiff {
  repo: string;
  // The repo's folder relative to the Weave root ("" for the root repo).
  repoDir: string;
  start: string;
  end: string;
  paths: string[];
  lines: number;
  diff: string;
  patch: string;
}

// `package --run <run> --fix-round <n>`: snapshots the round end in every slice repo, diffs it
// against the round-start ref (`round_not_started` when that is missing), saves the round patch to
// `task-slices/<slice>/review/r<N>-round<n>.patch`, and writes the fix checker's package with the
// round diff, the findings the round set out to fix, and the guideline files. Packaging the round
// again replaces the end snapshot and the patch, until the round is checked or a later round starts.
export async function buildFixRoundPackage(
  ctx: ReviewContext,
  runId: string,
  roundValue: string | number | undefined,
  options: FixRoundPackageOptions = {},
  boundary: ReviewBoundary = new SnapshotBoundary(),
): Promise<FixRoundPackageResult> {
  const round = parseRoundNumber(roundValue);
  if (round === undefined) {
    throw new ChangeCommandError("invalid_arguments", "--fix-round takes the round number, a whole number from 1.", { round: roundValue ?? null });
  }
  const target = await resolveRun(ctx, runId);
  const initial = await writableRunWithReport(ctx, target);
  if (target.scope === "change" && round > 1) {
    throw new ChangeCommandError("round_limit", `Run ${target.runId} is a change run: it has one fix batch (round 1), not round ${round}.`, { run: target.runId, round, limit: 1 });
  }
  assertRoundPackageable(target, initial, round);

  const startRef = roundRef(ctx, target, round, "start");
  const endRef = roundRef(ctx, target, round, "end");
  const checkouts = await runRepoCheckouts(ctx, target);
  const present = checkouts.filter((repo): repo is SliceRepoCheckout & { path: string } => repo.path !== undefined);
  const starts = new Map<string, string>();
  const missing: string[] = [];
  for (const repo of present) {
    const start = await boundary.read(repo.path, startRef);
    if (start) starts.set(repo.id, start.sha);
    else missing.push(repo.id);
  }
  if (present.length === 0 || missing.length > 0) {
    throw new ChangeCommandError(
      "round_not_started",
      `Round ${round} of run ${target.runId} has no round-start snapshot${missing.length > 0 ? ` in ${missing.join(", ")}` : ""} on this machine. Run \`weave review snapshot --run ${target.runId} --at round-start --round ${round}\` before fixing.`,
      { run: target.runId, round, missing_refs: missing.length > 0 ? missing : checkouts.map((repo) => repo.id) },
    );
  }

  const metadata = await readWorkspaceMetadata(ctx.weaveRoot);
  const workspace = metadata?.mode === "workspace";
  const changeStatus = await readYamlRecord(path.join(ctx.changePath, "status.yml"));
  const mainRoot = (await mainWorktreePath(ctx.weaveRoot)) ?? ctx.weaveRoot;
  const warnings: string[] = checkouts.some((repo) => !repo.path) ? ["missing_repo_checkout"] : [];
  if (boundary instanceof CommitBoundary) {
    // The round's fix commit names the findings it set out to fix (decision 261111-kx9x).
    const targetIds = new Set(roundTargets(initial.findings));
    boundary.setFixContext({
      run: target.runId,
      round,
      scope: target.scope,
      findings: initial.findings.filter((finding) => targetIds.has(finding.id)).map((finding) => ({ id: finding.id, detail: finding.detail })),
    });
  }
  const repos: RoundRepoDiff[] = [];
  for (const repo of present) {
    const base = await resolveDiffBase({ repoPath: repo.path, repoId: repo.id, changeStatus, mainRoot });
    await boundary.create({ repoPath: repo.path, ref: endRef, ...(base.sha ? { mergeBase: base.sha } : {}), force: true });
    const start = starts.get(repo.id) as string;
    const exclude = repoExcludes(ctx.weaveRoot, repo.path);
    const repoDir = toPosix(path.relative(ctx.weaveRoot, repo.path));
    const stat = await boundary.diffStat(repo.path, start, endRef, { context: roundPatchContext, exclude });
    const changed = stat.paths.length > 0;
    repos.push({
      repo: repo.id,
      repoDir,
      start,
      end: endRef,
      paths: stat.paths,
      lines: stat.lines,
      diff: changed ? await boundary.diff(repo.path, start, endRef, { context: packageDiffContext, exclude }) : "",
      patch: changed
        ? await boundary.patch(repo.path, start, endRef, { context: roundPatchContext, exclude, ...(repoDir && !repoDir.startsWith("..") ? { pathPrefix: repoDir } : {}) })
        : "",
    });
  }

  const patchName = roundPatchName(target, round);
  const patchPath = path.join(target.slice.path, patchName);
  const undo = `git apply -R ${toPosix(path.relative(ctx.weaveRoot, patchPath))}`;
  const filesTouched = Object.fromEntries(repos.map((repo) => [repo.repo, [...repo.paths]]));
  const files = repos.flatMap((repo) => repo.paths.map((file) => (workspace ? `${repo.repo}:${file}` : file)));
  const targets = roundTargets(initial.findings);
  const guidelines = await resolveGuidelines({
    checkoutRoot: ctx.weaveRoot,
    mode: workspace ? "workspace" : "repo",
    repos: guidelineRepos(metadata, checkouts.map((repo) => repo.id)),
  });

  const dir = slicePackageDir(ctx, target.slice.id);
  await ensureTmpIgnored(ctx.weaveRoot);
  const packagePath = options.out ? path.resolve(options.out) : path.join(dir, `${roundFileStem(target, round)}.package.md`);
  await mkdir(path.dirname(packagePath), { recursive: true });
  const now = options.now ?? new Date();

  let targetFindings: StoredFinding[] = [];
  await updateRunBlock(
    ctx,
    target,
    async (block) => {
      const record = await readRunRecord(target.slice, target.run);
      await assertRunWritable(target, block, record);
      if (!record) throw reportNotRecorded(target);
      const entry = assertRoundPackageable(target, record, round);
      const ids = roundTargets(record.findings);
      targetFindings = record.findings.filter((finding) => ids.includes(finding.id));
      await writeFileAtomic(patchPath, renderRoundPatch(target, round, repos, workspace));
      Object.assign(entry, { end_ref: endRef, ended_at: now.toISOString(), patch: patchName, undo, files, targets: ids });
      record.updated_at = now.toISOString();
      await writeRunRecord(target.slice, record);
      return block;
    },
    { now },
  );

  const lines = repos.reduce((sum, repo) => sum + repo.lines, 0);
  await writeFile(
    packagePath,
    renderFixRoundPackage({ ctx, target, round, workspace, repos, findings: targetFindings, guidelines, patchName, undo, warnings, missingRepos: checkouts.filter((repo) => !repo.path).map((repo) => repo.id) }),
  );
  return {
    status: "ok",
    run_id: target.runId,
    round,
    package_path: packagePath,
    patch_path: patchPath,
    model_level: fixRoundModelLevel,
    size_hint: { files: files.length, lines },
    files_touched: filesTouched,
    targets: targets.filter((id) => targetFindings.some((finding) => finding.id === id)),
    undo,
    warnings,
  };
}

function assertRoundPackageable(target: ResolvedRun, record: RunRecord, round: number): RunRound {
  const rounds = record.rounds ?? [];
  const entry = rounds.find((candidate) => candidate.round === round);
  if (!entry) {
    throw new ChangeCommandError(
      "round_not_started",
      `Round ${round} of run ${target.runId} was never started. Run \`weave review snapshot --run ${target.runId} --at round-start --round ${round}\` before fixing.`,
      { run: target.runId, round, rounds: rounds.map((candidate) => candidate.round) },
    );
  }
  if (entry.check || rounds.some((candidate) => candidate.round > round)) {
    throw new ChangeCommandError(
      "round_closed",
      `Round ${round} of run ${target.runId} is ${entry.check ? "already checked" : "followed by a later round"}, so its patch can no longer change.`,
      { run: target.runId, round },
    );
  }
  return entry;
}

// The findings a fix round sets out to fix: open (unresolved) Critical and Important code findings,
// plus, in a change run's fix batch, the Minors the final reviewer sorted as must-fix.
export function roundTargets(findings: StoredFinding[]): string[] {
  return findings
    .filter(
      (finding) =>
        finding.resolution === null &&
        finding.kind === "code" &&
        (finding.severity === "critical" || finding.severity === "important" || finding.final_sort === "must_fix"),
    )
    .map((finding) => finding.id);
}

// The saved patch: in repo mode the plain patch; in workspace mode one section per repo, each
// headed with the repo id and the folder its paths start with. Every path is relative to the Weave
// root, so the whole file reverses with one `git apply -R` from there. Header lines are text git
// skips before each `diff --git`.
export function renderRoundPatch(target: ResolvedRun, round: number, repos: Array<{ repo: string; repoDir: string; patch: string }>, workspace: boolean): string {
  const withChanges = repos.filter((repo) => repo.patch !== "");
  if (!workspace) {
    return withChanges.map((repo) => repo.patch).join("");
  }
  return withChanges
    .map((repo) => {
      const where = repo.repoDir ? `paths start with ${repo.repoDir}/` : "paths are relative to the Weave root";
      return `# Weave fix round ${round} of run ${target.runId}: repo ${repo.repo} (${where}); apply from the Weave root\n${repo.patch}`;
    })
    .join("");
}

interface FixRoundPackageModel {
  ctx: ReviewContext;
  target: ResolvedRun;
  round: number;
  workspace: boolean;
  repos: RoundRepoDiff[];
  findings: StoredFinding[];
  guidelines: GuidelineResolution;
  patchName: string;
  undo: string;
  warnings: string[];
  missingRepos: string[];
}

export function renderFixRoundPackage(model: FixRoundPackageModel): string {
  const { ctx, target, round } = model;
  const files = model.repos.reduce((sum, repo) => sum + repo.paths.length, 0);
  const lines = model.repos.reduce((sum, repo) => sum + repo.lines, 0);
  const out: string[] = [`# Fix check package: ${target.runId} round ${round}`, ""];
  out.push(`- Run: \`${target.runId}\``);
  out.push(`- Round: ${round}`);
  out.push(`- Scope: ${target.scope === "change" ? `the final review's fix batch for change \`${ctx.changeId}\`` : `slice \`${target.slice.id}\` of change \`${ctx.changeId}\``}`);
  out.push(`- Repos: ${model.repos.map((repo) => repo.repo).join(", ") || "none"}${model.missingRepos.length > 0 ? ` (not checked out here: ${model.missingRepos.join(", ")})` : ""}`);
  out.push(`- Warnings: ${model.warnings.length > 0 ? model.warnings.join(", ") : "none"}`);
  out.push(`- Size: ${files} files, ${lines} changed lines; model level hint: ${fixRoundModelLevel}`);
  out.push(`- Patch: \`${model.patchName}\` in the ${target.scope === "change" ? "change" : "slice"} folder (undo from the Weave root: \`${model.undo}\`)`);
  out.push("");
  out.push("Check only whether this round's diff fixes the findings listed below, and whether it introduces a new problem. Paths are relative to each repo root" + (model.workspace ? ", prefixed by the repo id." : "."));
  out.push("");

  out.push("## Findings this round set out to fix", "");
  if (model.findings.length === 0) {
    out.push(`None: no open Critical or Important finding${target.scope === "change" ? " or must-fix Minor" : ""} when the round was packaged.`, "");
  } else {
    for (const finding of model.findings) {
      const location = `${finding.location.repo}:${finding.location.path}${finding.location.line ? `:${finding.location.line}` : ""}`;
      out.push(`### ${finding.id} (${finding.severity})`, "");
      out.push(`- Location: \`${location}\``);
      out.push(`- Fails: ${finding.fails.type}${finding.fails.ref ? `: ${finding.fails.ref}` : ""}`);
      out.push(`- Detail: ${oneLine(finding.detail)}`);
      if (finding.fix_hint) out.push(`- Fix hint: ${oneLine(finding.fix_hint)}`);
      out.push("");
    }
  }

  out.push("## Boundaries", "");
  for (const repo of model.repos) {
    out.push(`- ${repo.repo}: from \`${roundRef(ctx, target, round, "start")}\` (${repo.start.slice(0, 12)}) to \`${repo.end}\``);
  }
  out.push("");

  out.push("## Diff stat", "");
  if (files === 0) {
    out.push("No files changed in this round.", "");
  } else {
    for (const repo of model.repos) {
      for (const file of repo.paths) out.push(`- ${model.workspace ? `${repo.repo}:${file}` : file}`);
    }
    out.push("", `${files} files changed, ${lines} lines added or removed.`, "");
  }

  out.push("## Round diff", "");
  for (const repo of model.repos) {
    out.push(`### ${repo.repo}`, "");
    out.push(...(repo.diff ? fenced("diff", repo.diff) : ["No changes."]), "");
  }

  out.push("## Coding guidelines", "");
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
  out.push("");
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

// --- resume ----------------------------------------------------------------------------------

export interface ResumeRunResult {
  status: "ok";
  run_id: string;
  // The fix round to start next: one more than the run's last round.
  resume_round: number;
  // The open code findings the resumed round can fix.
  open: string[];
}

// `package --run <run>` without `--fix-round`: a run paused on a plan problem that a person then
// dismissed resumes in place. It is resumable while it is the slice's latest run, not finalized or
// failed, the slice is `in_review`, a plan finding was dismissed, and code findings are still open.
// Nothing is written and no run id is allocated. Any other run gives `run_not_resumable`.
export async function resumeRun(ctx: ReviewContext, runId: string): Promise<ResumeRunResult> {
  const target = await resolveRun(ctx, runId);
  const block = await readRunBlock(ctx, target);
  const inProgress = target.scope === "change" ? "in_progress" : "in_review";
  const record = await readRunRecord(target.slice, target.run);
  const open = (record?.findings ?? []).filter((finding) => finding.resolution === null && finding.kind === "code").map((finding) => finding.id);
  const reason = !record
    ? "it has no recorded report"
    : record.outcome
      ? `it is already ${record.outcome.state.replace(/_/g, " ")}`
      : block?.latest_run !== target.run
        ? "it is not the slice's latest run"
        : block?.state !== inProgress
          ? `the ${target.scope === "change" ? "change review" : "slice"} is ${(block?.state ?? "not in review").replace(/_/g, " ")}`
          : !record.findings.some((finding) => finding.kind === "plan" && finding.resolution?.as === "dismissed")
            ? "no plan finding was dismissed in it"
            : open.length === 0
              ? "it has no open code findings"
              : undefined;
  if (reason !== undefined || !record) {
    throw new ChangeCommandError("run_not_resumable", `Run ${target.runId} cannot be resumed: ${reason ?? "it has no recorded report"}.`, {
      run: target.runId,
      reason: reason ?? "it has no recorded report",
      ...(record?.outcome ? { state: record.outcome.state } : block?.state ? { state: block.state } : {}),
    });
  }
  const last = (record.rounds ?? []).reduce((highest, entry) => Math.max(highest, entry.round), 0);
  return { status: "ok", run_id: target.runId, resume_round: last + 1, open };
}

// --- helpers ---------------------------------------------------------------------------------

async function writableRunWithReport(ctx: ReviewContext, target: ResolvedRun): Promise<RunRecord> {
  const record = await readRunRecord(target.slice, target.run);
  await assertRunWritable(target, await readRunBlock(ctx, target), record);
  if (!record) throw reportNotRecorded(target);
  return record;
}

function reportNotRecorded(target: ResolvedRun): ChangeCommandError {
  return new ChangeCommandError(
    "report_not_recorded",
    `Run ${target.runId} has no recorded report yet. Record the reviewer's report with \`weave review record --run ${target.runId} --report -\` before a fix round.`,
    { run: target.runId },
  );
}

// `wiki/changes/**` relative to a repo, when the Weave root is inside it.
function repoExcludes(weaveRoot: string, repoPath: string): string[] {
  const weaveRel = path.relative(repoPath, weaveRoot);
  return weaveRel.startsWith("..") || path.isAbsolute(weaveRel) ? [] : excludedPathspecs(toPosix(weaveRel));
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function oneLine(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, " ").trim();
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
