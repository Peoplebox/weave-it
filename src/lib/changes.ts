import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { architectureMarkdownPaths, hasSubstantiveMarkdown, resolveArchitectureArtifact } from "./architecture-artifact.js";
import { artifactFrontmatter } from "./artifact-metadata.js";
import { writeAttention } from "./change-attention.js";
import { ChangeCommandError } from "./change-error.js";
import { gatherFacts, resolveMainRoot, type GatheredChange, type RemoteFacts } from "./change-facts.js";
import { remoteFacts, type RefreshRecord } from "./change-refresh.js";
import type { ChangeStatusReviewView } from "./review/summary.js";
import { attentionCounts, deriveState, nextLine, stateLine, type ChangeView } from "./change-states.js";
import { planningCheckpoint, renderCheckpointLine, type CheckpointOutcome, type PlanningMoment } from "./checkpoints.js";
import { pathExists } from "./files.js";
import { findGitRoot, listGitWorktrees } from "./git.js";
import { slugify, titleFromSlug } from "./ids.js";
import { localStateDir } from "./local-state.js";
import {
  autoAdvanceDefaults,
  autoAdvanceTransitions,
  type AutoAdvanceFlags,
  isLifecycleTransitionId,
  lifecycleTransition,
  lifecycleTransitionIds,
  type LifecycleTransitionId,
  normalizeAutoAdvanceFlags,
} from "./lifecycle-transitions.js";
import { defaultSessionPath, type SessionCurrentChange } from "./session-state.js";
import { ensureWeaveScaffold } from "./weave-scaffold.js";
import { resolveChangeContext, type WorkspaceModeKind } from "./workspace-mode.js";
import type { CheckoutMode } from "./workspace-repos.js";
import {
  changeFolderPath,
  ensureChangeWorktrees,
  readLocalChangeInfo,
  mainCheckoutPath,
  recordCheckoutInStatus,
  listLocalChangeIds,
  readLocalState,
  removeChangeWorktrees,
  runChangeSetup,
  workspaceCheckoutMode,
  type RemoveWorktreesResult,
  type SetupCommand,
  type SetupResult,
  type WorktreeRepoResult,
} from "./worktrees.js";

export { ChangeCommandError };

const execFileAsync = promisify(execFile);
const idChars = "abcdefghijklmnopqrstuvwxyz0123456789";

export type BranchStatus = "created" | "checked_out" | "already_active" | "skipped_not_git";
export type ChangeType = "feat" | "fix" | "refactor" | "docs" | "test" | "ci" | "chore";
export type BranchMatch = "match" | "mismatch" | "not_git" | "unknown";
export type CurrentSource = "branch" | "none";
export type ActiveChangeResolutionState = "branch_active" | "no_active_change" | "invalid_active_branch" | "non_git_no_active_change";
export type ChangeStage = (typeof changeStages)[number];
export type StoredChangeStage = (typeof storedStages)[number];
export type ArtifactSourceId = (typeof artifactSourceIds)[number];
export type KnowledgeStatus = (typeof knowledgeStatuses)[number];
export type KnowledgeInvalidationSource = ChangeStage | ArtifactSourceId;
export type StaleChangeLanes = Partial<Record<ChangeStage, StaleChangeLaneMetadata>>;
export type ChangeArtifactsMetadata = Partial<Record<ChangeStage, ChangeArtifactMetadata>>;

export const changeTypes: ChangeType[] = ["feat", "fix", "refactor", "docs", "test", "ci", "chore"];
export const changeStages = ["questions", "research", "exploration", "prd", "findings", "architecture", "slices"] as const;
export const legacyChangeStageAliases: Record<string, ChangeStage> = { issues: "slices" };
// `questions` and `research` are current-state evidence lanes. They take part in
// artifact metadata and stale propagation like any other lane, but progressing them
// never moves the change's `stage`, which tracks the furthest product/engineering lane.
export const evidenceStages = ["questions", "research"] as const satisfies readonly ChangeStage[];
// `started` is a stored stage but NOT an artifact lane: non-feature changes begin at
// `started` before any durable artifact lane has been reached. It never appears in
// `changeStages`, so staleness/dependency logic operates only on the real lanes.
export const storedStages = ["started", ...changeStages] as const;
export const artifactSourceIds = [
  "questions",
  "research",
  "exploration",
  "prd",
  "architecture",
  "discussion",
  "sessions",
  "codebase",
] as const;
export const knowledgeStatuses = ["pending", "stale", "updated", "none"] as const;
// Shapes that `weave-stress-test` can judge, and the verdicts it can record.
export const stressTestLanes = ["exploration", "architecture"] as const satisfies readonly ChangeStage[];
export const stressTestVerdicts = ["holds", "holds-with-changes", "needs-reshaping", "waived"] as const;
export type StressTestLane = (typeof stressTestLanes)[number];
export type StressTestVerdict = (typeof stressTestVerdicts)[number];

export interface StressTestRecord {
  verdict: StressTestVerdict;
  judged_at: string;
  // `artifacts.<lane>.updated_at` when the verdict was recorded; a later lane update makes it outdated.
  artifact_updated_at: string | null;
  session?: string;
  reason?: string;
  outdated: boolean;
}

export type StressTestRecords = Partial<Record<StressTestLane, StressTestRecord>>;

// Phase runs: one entry per skill session started for a lane, written by `weave advance`
// or `weave change run start`. `upstream_updated_at` pins the upstream progress that
// triggered an auto-advance run so the same update never starts the phase twice.
export const runResults = ["running", "succeeded", "incomplete", "failed"] as const;
export const runTriggers = ["auto-advance", "manual"] as const;
export type RunResult = (typeof runResults)[number];
export const runLaunches = ["handoff", "here", "terminal", "background"] as const;
export type RunLaunch = (typeof runLaunches)[number];
export type RunTrigger = (typeof runTriggers)[number];
export type FinishedRunResult = Exclude<RunResult, "running">;

export interface PhaseRun {
  id: string;
  lane: ChangeStage;
  skill: string;
  agent: string;
  session_id?: string;
  trigger: RunTrigger;
  transition?: LifecycleTransitionId;
  upstream_updated_at?: string;
  // How the session was started: handed to the person's own agent as a fresh sub-agent
  // (`handoff`), in the terminal that ran `weave advance` (`here`), in a new visible
  // terminal (`terminal`, with `where` naming it), or headless (`background`).
  launch?: RunLaunch;
  where?: string;
  started_at: string;
  finished_at: string | null;
  result: RunResult;
}

export interface StaleChangeLaneMetadata {
  invalidated_by: ChangeStage;
  invalidated_at: string;
}

export interface StaleHistoryEntry {
  lane: ChangeStage;
  invalidated_by: ChangeStage | null;
  invalidated_at: string | null;
  cleared_at: string;
  reason: string | null;
}

export interface ChangeArtifactMetadata {
  sources: ArtifactSourceId[];
  updated_at: string;
}

export interface KnowledgeMetadata {
  status: KnowledgeStatus;
  updated_at: string;
  domains: string[];
  shared: string[];
  files: string[];
  delta?: string;
  reason?: string;
  invalidated_by?: KnowledgeInvalidationSource;
  invalidated_at?: string;
}

export interface ChangeTargetResult {
  path: string;
  changePath: string;
  branch: string;
  branchStatus: BranchStatus;
  current: boolean;
}

export interface ChangeOperationResult {
  status: "ok";
  id: string;
  slug: string;
  title: string;
  type: ChangeType;
  branch: string;
  auto_advance: Record<string, boolean>;
  checkout: CheckoutMode;
  // Worktree checkouts only: the change folder to open, its slot, and each repo's worktree.
  folder?: string;
  slot?: number;
  repos?: WorktreeRepoResult[];
  copied?: string[];
  warnings?: string[];
  targets: ChangeTargetResult[];
  message: string;
}

export interface ChangeSummary {
  id: string;
  slug: string;
  title: string;
  type: ChangeType;
  stage: StoredChangeStage;
  stale: StaleChangeLanes;
  stale_history: StaleHistoryEntry[];
  artifacts: ChangeArtifactsMetadata;
  stress_tests: StressTestRecords;
  auto_advance: AutoAdvanceFlags;
  runs: PhaseRun[];
  knowledge?: KnowledgeMetadata;
  branch: string;
  path: string;
  changePath: string;
  // Worktree checkouts only: the change folder on this machine and its slot.
  folder?: string;
  slot?: number;
  created_at?: string;
  updated_at?: string;
  active: boolean;
  // `weave change status` only: the code-review summary, absent when there is none to show.
  review?: ChangeStatusReviewView;
}

// What `weave change list` reports per change in worktree mode: today's fields, plus the
// change's state. Fields whose source (the planning files) is unavailable are left empty.
export interface ListedChangeExtras {
  planning: { available: true } | { available: false; reason: "folder missing" | "no folder" };
  missing_folder?: string;
  state: ChangeView["state"];
  labels: ChangeView["labels"];
  landed_check: ChangeView["landed_check"];
  repos: ChangeView["repos"];
}

export type ListedChange = Omit<ChangeSummary, "type" | "stage"> & {
  type: ChangeType | "";
  stage: StoredChangeStage | "";
} & Partial<ListedChangeExtras>;

export interface ChangeListFreshness {
  // A background refresh is running or was just started.
  refreshing: boolean;
  // The oldest last-successful fetch among repos with a remote.
  as_of: string | null;
  // With `--fetch`: whether the refresh finished in time.
  refresh_finished?: boolean;
}

export interface ChangeTargetSummary {
  id?: string;
  name?: string;
  path: string;
  freshness?: ChangeListFreshness;
  unavailable?: { path: string };
  changes: ListedChange[];
}

export interface ChangeListResult {
  status: "ok";
  targets: ChangeTargetSummary[];
  message: string;
}

export interface CurrentChangeTargetResult {
  id?: string;
  name?: string;
  path: string;
  source: CurrentSource;
  resolution: ActiveChangeResolutionState;
  saved: boolean;
  current?: ChangeSummary;
  branch?: string;
  branchMatch: BranchMatch;
  mismatch?: ChangeMismatch;
}

export interface CurrentChangeResult {
  status: "ok";
  targets: CurrentChangeTargetResult[];
  message: string;
}

export interface ChangeMismatch {
  session: SessionCurrentChange;
  branch: ChangeSummary;
}

export interface StatusChangeTargetResult {
  id?: string;
  name?: string;
  path: string;
  active: boolean;
  source: CurrentSource | "explicit";
  resolution: ActiveChangeResolutionState | "explicit";
  saved: boolean;
  change?: ChangeSummary;
  branch?: string;
  branchMatch: BranchMatch;
  mismatch?: ChangeMismatch;
}

export interface StatusChangeResult {
  status: "ok";
  targets: StatusChangeTargetResult[];
  message: string;
}

export interface ActiveChangeContext {
  target: {
    id?: string;
    name?: string;
    path: string;
  };
  change: ChangeSummary;
  mode: WorkspaceModeKind;
  branch?: string;
  branchMatch: BranchMatch;
}

export interface SwitchChangeResult {
  status: "ok";
  change: ChangeSummary;
  branchStatus: BranchStatus;
  folder?: string;
  repos?: WorktreeRepoResult[];
  // A recreated folder whose old slot was taken got a new one.
  slot_changed?: { from: number; to: number };
  // Repos whose folder was recreated; their setup counts as not run.
  setup_reset?: string[];
  target: {
    id?: string;
    name?: string;
    path: string;
  };
  message: string;
}

export interface CreateChangeOptions {
  cwd: string;
  title: string;
  type?: ChangeType;
  slug?: string;
  // `false` starts the change with every auto-advance transition off instead of the type defaults.
  autoAdvance?: boolean;
  // Worktree checkouts: limit which registered repos get a worktree, override the
  // starting ref, or skip fetching it first.
  repos?: string[];
  // Also lets an in-place checkout start a change on top of another change branch.
  base?: string;
  // Per-repo starting refs, keyed by repo id (`root` for the workspace root); these win over `base`.
  repoBases?: Record<string, string>;
  fetch?: boolean;
  now?: Date;
  randomId?: () => string;
  sessionPath?: string;
}

export interface ListChangesOptions {
  cwd: string;
  sessionPath?: string;
  // Include past changes (done).
  all?: boolean;
  now?: Date;
  // What the last refresh recorded, whether one is running now, and, with `--fetch`,
  // whether the one this list waited for finished.
  refresh?: { record: RefreshRecord; refreshing: boolean; finished?: boolean };
}

export interface CurrentChangeOptions {
  cwd: string;
  now?: Date;
  sessionPath?: string;
}

export interface StatusChangeOptions {
  cwd: string;
  change?: string;
  now?: Date;
  sessionPath?: string;
}

export interface CheckpointMessageOptions {
  // One-line gist for the checkpoint commit subject (decision 261111-htho).
  summary?: string;
  // A full commit message, used verbatim; Weave appends its trailers.
  commitMessage?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ProgressChangeOptions extends CheckpointMessageOptions {
  cwd: string;
  stage: ChangeStage;
  sources?: readonly string[];
  now?: Date;
  sessionPath?: string;
  noInvalidate?: boolean;
  invalidateOnly?: readonly ChangeStage[];
}

export interface KnowledgeChangeOptions extends CheckpointMessageOptions {
  cwd: string;
  status: KnowledgeStatus;
  domains?: readonly string[];
  shared?: readonly string[];
  files?: readonly string[];
  delta?: string;
  reason?: string;
  invalidatedBy?: string;
  now?: Date;
  sessionPath?: string;
}

export interface ProgressChangeResult {
  status: "ok";
  target: {
    id?: string;
    name?: string;
    path: string;
  };
  change: ChangeSummary;
  progressed: ChangeStage;
  sources: ArtifactSourceId[];
  note?: string;
  checkpoint?: CheckpointOutcome;
  message: string;
}

export interface KnowledgeChangeResult {
  status: "ok";
  target: {
    id?: string;
    name?: string;
    path: string;
  };
  change: ChangeSummary;
  knowledge: KnowledgeMetadata;
  checkpoint?: CheckpointOutcome;
  message: string;
}

export interface SwitchChangeOptions {
  cwd: string;
  change: string;
  now?: Date;
  sessionPath?: string;
}

interface ChangeTarget {
  id?: string;
  name?: string;
  path: string;
}

interface ExistingChangeMetadata {
  id: string;
  slug: string;
  title: string;
  type: ChangeType;
  branch: string;
}

interface ChangeStatusMetadata extends ExistingChangeMetadata {
  stage: StoredChangeStage;
  stale: StaleChangeLanes;
  stale_history: StaleHistoryEntry[];
  artifacts: ChangeArtifactsMetadata;
  stress_tests: StressTestRecords;
  auto_advance: AutoAdvanceFlags;
  runs: PhaseRun[];
  knowledge?: KnowledgeMetadata;
  created_at?: string;
  updated_at?: string;
}

export async function createChange(options: CreateChangeOptions): Promise<ChangeOperationResult> {
  const now = options.now ?? new Date();
  const title = options.title.trim();
  if (!title) {
    throw new ChangeCommandError("missing_title", "Change title is required");
  }

  const targets = [await resolveTarget(options.cwd, options.sessionPath)];
  const type = options.type ?? "feat";
  const slug = normalizeChangeSlug(options.slug ?? title);
  const autoAdvance = options.autoAdvance === false ? {} : autoAdvanceDefaults[type];

  await assertGitTargets(targets);
  const checkout = await workspaceCheckoutMode(targets[0]!.path);
  const id = await generateChangeId(targets, slug, now, options.randomId ?? randomChangeIdPart, checkout);
  const branch = changeBranch(id);
  await assertChangeMissing(targets, id);

  if (checkout === "worktree") {
    const worktrees = await ensureChangeWorktrees({
      rootPath: targets[0]!.path,
      changeId: id,
      branch,
      repos: options.repos,
      base: options.base,
      repoBases: options.repoBases,
      fetch: options.fetch,
      now,
    });
    const changePath = await writeChangeFiles(worktrees.folder, { id, slug, title, type, branch, autoAdvance, now });
    await recordCheckoutInStatus(changePath, worktrees.repos);
    return summarizeChangeOperation({
      id,
      slug,
      title,
      type,
      branch,
      autoAdvance,
      checkout,
      worktrees,
      targets: [{ path: worktrees.folder, changePath, branch, branchStatus: "created", current: true }],
      verb: "Created",
    });
  }

  // In-place checkouts only switch the root here; registered repos follow at prepare.
  const base = options.repoBases?.root ?? options.base;
  const results: ChangeTargetResult[] = [];
  for (const target of targets) {
    const current = await currentBranch(target.path);
    if (!base && current?.startsWith("change/")) {
      throw new ChangeCommandError(
        "stacked_change",
        `You are on ${current}, so the new change would include that change's work. Switch to your main branch first, or pass --base <ref> to start from a specific ref on purpose.`,
        { branch: current },
      );
    }
    const branchStatus = await ensureChangeBranch(target.path, branch, base);
    const changePath = await writeChangeFiles(target.path, { id, slug, title, type, branch, autoAdvance, now });
    results.push({ path: target.path, changePath, branch, branchStatus, current: true });
  }

  return summarizeChangeOperation({ id, slug, title, type, branch, autoAdvance, checkout, targets: results, verb: "Created" });
}

async function writeChangeFiles(
  root: string,
  input: { id: string; slug: string; title: string; type: ChangeType; branch: string; autoAdvance: AutoAdvanceFlags; now: Date },
): Promise<string> {
  await ensureWeaveScaffold({ folder: { path: root } });
  const changePath = changeDir(root, input.id);
  await mkdir(changePath, { recursive: false });
  await mkdir(path.join(changePath, "sessions"));
  await writeFile(path.join(changePath, "status.yml"), statusTemplate(input));
  // Feature changes scaffold exploration.md and start at `stage: exploration`. Non-feature
  // changes start at `stage: started` with no exploration artifact; their first real artifact
  // is created later by the fitting skill (weave-architect, weave-issues, or weave-prd).
  if (input.type === "feat") {
    await writeFile(path.join(changePath, "exploration.md"), explorationTemplate(input.title, input.title, input.now));
  }
  return changePath;
}

export async function listChanges(options: ListChangesOptions): Promise<ChangeListResult> {
  const targets = [await resolveTarget(options.cwd, options.sessionPath)];
  if ((await workspaceCheckoutMode(targets[0]!.path)) === "worktree") {
    return listWorktreeChanges(targets[0]!, options);
  }
  const summaries: ChangeTargetSummary[] = [];

  for (const target of targets) {
    const activeId = await branchChangeIdForTarget(target.path);
    const changes = await readChangesWithWorktrees(target.path, activeId);
    summaries.push({ id: target.id, name: target.name, path: target.path, changes });
  }

  return {
    status: "ok",
    targets: summaries,
    message: formatListMessage(summaries),
  };
}

// Worktree mode: every change of this repo or workspace gets one state, worked out from
// live local facts (and the last refresh's remote facts), the same from any folder.
async function listWorktreeChanges(target: ChangeTarget, options: ListChangesOptions): Promise<ChangeListResult> {
  const now = options.now ?? new Date();
  const activeId = await branchChangeIdForTarget(target.path);
  const remote: RemoteFacts | undefined = options.refresh ? remoteFacts(options.refresh.record) : undefined;
  const gathered = await gatherFacts(target.path, { now, ...(remote ? { remote } : {}) });
  const views = gathered.changes.map((change) => deriveState(change.facts));
  const counts = attentionCounts(views);
  await writeAttention(gathered.mainRoot, { ...counts, factsAt: gathered.factsAt }, now).catch(() => false);

  const listed: Array<{ change: ListedChange; gathered: GatheredChange; view: ChangeView }> = [];
  for (const [index, change] of gathered.changes.entries()) {
    const view = views[index]!;
    if (view.state.id === "done" && !options.all) continue;
    listed.push({ change: await listedChange(change, view, activeId), gathered: change, view });
  }
  listed.sort((left, right) => compareChangesNewestFirst(left.change as ChangeSummary, right.change as ChangeSummary));

  const unavailable = gathered.unavailableRoot && views.some((view) => view.state.id === "folder_unavailable") ? { path: gathered.unavailableRoot } : undefined;
  const freshness = describeFreshness(options.refresh, listed.map((item) => item.gathered), now);
  const summary: ChangeTargetSummary = {
    id: target.id,
    name: target.name,
    path: target.path,
    freshness: freshness.json,
    ...(unavailable ? { unavailable } : {}),
    changes: listed.map((item) => item.change),
  };
  return {
    status: "ok",
    targets: [summary],
    message: formatWorktreeListMessage(summary, listed, gathered.gitTooOld, freshness.lines),
  };
}

const refreshProblems: Record<string, (message: string | null) => string> = {
  auth: () => "couldn't refresh: origin needs a login",
  unreachable: () => "couldn't reach origin",
  timeout: () => "last refresh timed out",
  error: (message) => `couldn't refresh: ${message ?? "unknown error"}`,
};

export function formatAge(iso: string | null, now: Date): string {
  if (!iso) return "never fetched";
  const seconds = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

// The age of remote facts: one shared line at the end, plus a line under a change only
// when its repos' ages differ or one failed to refresh. A fresh `--fetch` shows no age.
function describeFreshness(
  refresh: ListChangesOptions["refresh"],
  changes: GatheredChange[],
  now: Date,
): { json: ChangeListFreshness; lines: { perChange: Map<string, string>; footer?: string } } {
  const perChange = new Map<string, string>();
  if (!refresh) return { json: { refreshing: false, as_of: null }, lines: { perChange } };
  const remotes = Object.entries(refresh.record.repos).filter(([, repo]) => repo.result !== "no_remote");
  const successes = remotes.map(([, repo]) => repo.last_success_at);
  const asOf = successes.length === 0 || successes.some((value) => !value) ? null : [...(successes as string[])].sort()[0]!;
  const json: ChangeListFreshness = {
    refreshing: refresh.refreshing,
    as_of: asOf,
    ...(refresh.finished !== undefined ? { refresh_finished: refresh.finished } : {}),
  };

  const problemOf = (repo: (typeof remotes)[number][1]) => (repo.result === "ok" ? undefined : refreshProblems[repo.result]?.(repo.message));
  for (const change of changes) {
    const repos = change.facts.repos
      .map((repo) => [repo.id, refresh.record.repos[repo.id]] as const)
      .filter((entry): entry is readonly [string, NonNullable<(typeof entry)[1]>] => Boolean(entry[1]) && entry[1]!.result !== "no_remote");
    const ages = new Set(repos.map(([, repo]) => formatAge(repo.last_success_at, now)));
    if (repos.length > 1 && (ages.size > 1 || repos.some(([, repo]) => repo.result !== "ok"))) {
      perChange.set(
        change.facts.id,
        `as of last fetch: ${repos.map(([id, repo]) => `${id} ${formatAge(repo.last_success_at, now)}${problemOf(repo) ? ` (${problemOf(repo)})` : ""}`).join(" · ")}`,
      );
    }
  }

  const refreshingNote = refresh.refreshing ? " · refreshing now, run again in a few seconds for the latest" : "";
  let footer: string | undefined;
  if (refresh.finished === true) {
    footer = undefined;
  } else if (remotes.length === 0) {
    footer = refresh.refreshing ? `fetching remote state for the first time${refreshingNote}` : undefined;
  } else {
    const problems = [...new Set(remotes.map(([, repo]) => problemOf(repo)).filter(Boolean))];
    const didntFinish = refresh.finished === false ? " · the refresh didn't finish in time" : "";
    footer = `as of last fetch, ${formatAge(asOf, now)}${problems.length > 0 ? ` (${problems.join("; ")})` : ""}${didntFinish}${refreshingNote}`;
  }
  return { json, lines: { perChange, ...(footer ? { footer } : {}) } };
}

async function listedChange(gathered: GatheredChange, view: ChangeView, activeId: string | undefined): Promise<ListedChange> {
  const { facts, planning } = gathered;
  const id = facts.id;
  const slug = id.split("-").slice(2).join("-");
  const extras: ListedChangeExtras = {
    planning:
      planning.kind === "folder" || planning.kind === "main"
        ? { available: true }
        : { available: false, reason: facts.hasFolderRecord ? "folder missing" : "no folder" },
    ...(view.missing_folder ? { missing_folder: view.missing_folder } : {}),
    state: view.state,
    labels: view.labels,
    landed_check: view.landed_check,
    repos: view.repos,
  };
  const located = {
    ...(facts.folderExists && facts.folder ? { folder: facts.folder } : {}),
    ...(facts.slot !== undefined ? { slot: facts.slot } : {}),
  };

  if (planning.kind === "folder" || planning.kind === "main") {
    const metadata = await readChangeMetadata(planning.changePath, id);
    return {
      ...metadata,
      path: path.join("wiki", "changes", metadata.id),
      changePath: planning.changePath,
      ...located,
      active: metadata.id === activeId,
      ...extras,
    };
  }

  // No planning files here: never invent values. The branch's committed status.yml, when
  // there is one, still names the change.
  const fromBranch = planning.kind === "branch" ? metadataFromParsed(parseYamlRecord(planning.statusYaml), id) : undefined;
  return {
    id,
    slug,
    title: fromBranch?.title ?? "",
    type: fromBranch?.type ?? "",
    stage: fromBranch?.stage ?? "",
    stale: {},
    stale_history: [],
    artifacts: {} as ChangeArtifactsMetadata,
    stress_tests: {},
    auto_advance: {} as AutoAdvanceFlags,
    runs: [],
    branch: changeBranch(id),
    path: path.join("wiki", "changes", id),
    changePath: "",
    ...located,
    active: id === activeId,
    ...extras,
  };
}

function parseYamlRecord(content: string): Record<string, unknown> {
  try {
    const parsed = YAML.parse(content);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function formatWorktreeListMessage(
  target: ChangeTargetSummary,
  listed: Array<{ change: ListedChange; gathered: GatheredChange; view: ChangeView }>,
  gitTooOld: boolean,
  freshness?: { perChange: Map<string, string>; footer?: string },
): string {
  const lines = [`Changes in ${target.name ?? target.path}`];
  if (target.unavailable) {
    lines.push(`  change folders unavailable at ${target.unavailable.path} (drive not mounted?)`, "");
  }
  if (listed.length === 0) {
    lines.push("  No changes found.");
  }
  for (const { change, gathered, view } of listed) {
    const title = change.title || "(title unknown)";
    lines.push(`${change.active ? "*" : " "} ${[change.id, change.type, change.stage, title].filter(Boolean).join("  ")}`);
    lines.push(`    ${stateLine(view, gathered.facts)}`);
    const next = nextLine(view);
    if (next) lines.push(`    ${next}`);
    const slot = gathered.facts.slot !== undefined ? `  (slot ${gathered.facts.slot})` : "";
    if (gathered.facts.hasFolderRecord && gathered.facts.folder && view.state.id !== "folder_unavailable") {
      lines.push(gathered.facts.folderExists ? `    folder: ${gathered.facts.folder}${slot}` : `    folder not found at ${gathered.facts.folder}${slot}`);
    }
    const age = freshness?.perChange.get(change.id);
    if (age) lines.push(`    ${age}`);
  }
  if (gitTooOld) {
    lines.push("", "git 2.38+ is needed to detect squash merges; some changes show as in progress until you upgrade git.");
  }
  if (freshness?.footer) {
    lines.push("", freshness.footer);
  }
  return lines.join("\n");
}

export async function currentChange(options: CurrentChangeOptions): Promise<CurrentChangeResult> {
  const sessionPath = options.sessionPath ?? defaultSessionPath();
  const targets = [await resolveTarget(options.cwd, sessionPath)];
  const results: CurrentChangeTargetResult[] = [];

  for (const target of targets) {
    const context = await currentContextForTarget(target);
    results.push(context);
  }

  return {
    status: "ok",
    targets: results,
    message: formatCurrentMessage(results),
  };
}

export async function statusChange(options: StatusChangeOptions): Promise<StatusChangeResult> {
  const sessionPath = options.sessionPath ?? defaultSessionPath();
  const targets = [await resolveTarget(options.cwd, sessionPath)];
  const results: StatusChangeTargetResult[] = [];

  for (const target of targets) {
    if (options.change) {
      const changes = await readChangesWithWorktrees(target.path, await branchChangeIdForTarget(target.path));
      const change = await resolveOrExplainMissing(target.path, changes, options.change);
      const branch = await currentBranch(target.path);
      results.push({
        id: target.id,
        name: target.name,
        path: target.path,
        active: change.active,
        source: "explicit",
        resolution: "explicit",
        saved: false,
        change,
        branch,
        branchMatch: branchMatch(branch, change.branch, await findGitRoot(target.path)),
      });
      continue;
    }

    const context = await currentContextForTarget(target);
    results.push({
      id: context.id,
      name: context.name,
      path: context.path,
      active: Boolean(context.current),
      source: context.source,
      resolution: context.resolution,
      saved: context.saved,
      change: context.current,
      branch: context.branch,
      branchMatch: context.branchMatch,
      mismatch: context.mismatch,
    });
  }

  // Loaded on demand: the review modules import back into this one.
  const { changeStatusReview, renderChangeReviewLines } = await import("./review/summary.js");
  const { reviewContextForChangePath } = await import("./review/state.js");
  const reviewLines = new Map<StatusChangeTargetResult, string[]>();
  for (const result of results) {
    if (result.change) {
      const review = await changeStatusReview(
        reviewContextForChangePath(result.change.changePath) ?? { weaveRoot: result.path, changeId: result.change.id, changePath: result.change.changePath },
      );
      if (review) result.change.review = review;
      reviewLines.set(result, renderChangeReviewLines(review));
    }
  }

  return {
    status: "ok",
    targets: results,
    message: formatStatusMessage(results, reviewLines),
  };
}

export async function activeChangeContext(options: CurrentChangeOptions): Promise<ActiveChangeContext> {
  const sessionPath = options.sessionPath ?? defaultSessionPath();
  const context = await resolveChangeContext(options.cwd, sessionPath);
  if (!context) {
    throw new ChangeCommandError("no_weave_context", "No Weave context found. Run `weave init` first.");
  }

  const target: ChangeTarget = {
    id: context.folderId,
    name: context.folderName,
    path: context.rootPath,
  };
  const current = await currentContextForTarget(target);
  if (!current.current) {
    if ((await workspaceCheckoutMode(target.path)) === "worktree") {
      throw new ChangeCommandError(
        "no_current_change",
        "No active Weave change here. This workspace keeps each change in its own folder: run `weave change list` and open the change's folder, or run `weave change new` to start one.",
      );
    }
    throw new ChangeCommandError("no_current_change", "No active Weave change found. Run `weave change new` or `weave change switch` first.");
  }

  return {
    target: { id: target.id, name: target.name, path: target.path },
    change: current.current,
    mode: context.mode,
    branch: current.branch,
    branchMatch: current.branchMatch,
  };
}

export async function switchChange(options: SwitchChangeOptions): Promise<SwitchChangeResult> {
  const target = await resolveTarget(options.cwd, options.sessionPath);
  if ((await workspaceCheckoutMode(target.path)) === "worktree") {
    return openChangeFolder(target, options.change);
  }
  await assertCleanGitTargets([target]);

  const changes = await readChanges(target.path, await branchChangeIdForTarget(target.path));
  const change = resolveChangeReference(changes, options.change);
  const branchStatus = await ensureChangeBranch(target.path, change.branch);

  return {
    status: "ok",
    change: { ...change, active: true },
    branchStatus,
    target: { id: target.id, name: target.name, path: target.path },
    message: [
      `Switched change: ${change.id}`,
      "",
      `Title: ${change.title}`,
      `Type: ${change.type}`,
      `Stage: ${change.stage}`,
      `Branch: ${change.branch} (${formatBranchStatus(branchStatus)})`,
      `Path: ${change.path}`,
      "Current: yes",
    ].join("\n"),
  };
}

// Worktree checkouts never switch branches: "switching" makes sure the change's folder
// and worktrees exist on this machine and says where to open it.
async function openChangeFolder(target: ChangeTarget, reference: string): Promise<SwitchChangeResult> {
  const changes = await readChangesWithWorktrees(target.path, await branchChangeIdForTarget(target.path));
  let found: { id: string; branch: string };
  try {
    found = resolveChangeReference(changes, reference);
  } catch (error) {
    if (!(error instanceof ChangeCommandError) || error.code !== "change_not_found") {
      throw error;
    }
    // Not open on this machine: look for the change branch itself, such as a teammate's
    // pushed change or one closed here earlier.
    found = await findChangeBranch(target.path, reference, changes);
  }

  const worktrees = await ensureChangeWorktrees({ rootPath: target.path, changeId: found.id, branch: found.branch, fetchBranch: true });
  const changePath = changeDir(worktrees.folder, found.id);
  if (await pathExists(path.join(changePath, "status.yml"))) {
    await recordCheckoutInStatus(changePath, worktrees.repos);
  }
  const change: ChangeSummary = {
    ...(await readChangeMetadata(changePath, found.id)),
    path: path.join("wiki", "changes", found.id),
    changePath,
    active: true,
  };
  const created = worktrees.repos.some((repo) => repo.status === "created");
  if (created) await refreshAttention(target.path);
  const recreatedLines = [
    ...(worktrees.slot_changed ? [`Slot changed: ${worktrees.slot_changed.from} was taken, so this folder now uses slot ${worktrees.slot_changed.to}.`] : []),
    ...(worktrees.setup_reset ? [`Setup reset for: ${worktrees.setup_reset.join(", ")}. Run \`weave change setup\` before working here.`] : []),
  ];

  return {
    status: "ok",
    change: { ...change, changePath, folder: worktrees.folder, slot: worktrees.slot, active: true },
    branchStatus: created ? "created" : "already_active",
    folder: worktrees.folder,
    repos: worktrees.repos,
    ...(worktrees.slot_changed ? { slot_changed: worktrees.slot_changed } : {}),
    ...(worktrees.setup_reset ? { setup_reset: worktrees.setup_reset } : {}),
    target: { id: target.id, name: target.name, path: target.path },
    message: [
      `Change: ${change.id}`,
      "",
      `Title: ${change.title}`,
      `Stage: ${change.stage}`,
      `Branch: ${change.branch}`,
      "",
      ...formatWorktreeLines(worktrees),
      ...(recreatedLines.length > 0 ? ["", ...recreatedLines] : []),
    ].join("\n"),
  };
}

// Matches a reference against `change/<id>` branches in the workspace root, local and on
// origin, the same way change references match ids, tokens, and slugs.
async function findChangeBranch(root: string, reference: string, known: ChangeSummary[]): Promise<{ id: string; branch: string }> {
  const ref = reference.trim().toLowerCase();
  const local = (await git(["for-each-ref", "--format=%(refname:short)", "refs/heads/change/"], root))?.split("\n") ?? [];
  const hasOrigin = Boolean(await git(["remote", "get-url", "origin"], root));
  const remote = hasOrigin
    ? ((await git(["ls-remote", "--heads", "origin", "refs/heads/change/*"], root))?.split("\n") ?? []).map((line) =>
        line.split("\t")[1]?.replace(/^refs\/heads\//, ""),
      )
    : [];
  const knownIds = new Set(known.map((change) => change.id));
  const ids = [...new Set([...local, ...remote].filter((name): name is string => Boolean(name?.startsWith("change/"))).map((name) => name.slice("change/".length)))]
    .filter((id) => !knownIds.has(id));
  const matches = ids.filter((id) => {
    const [, token, ...slug] = id.split("-");
    return id.toLowerCase() === ref || token === ref || slug.join("-").toLowerCase().includes(ref);
  });

  if (matches.length === 0) {
    throw new ChangeCommandError(
      "change_not_found",
      `No matching change found: ${reference}. Also looked for change branches here${hasOrigin ? " and on origin" : ""}.`,
    );
  }
  if (matches.length > 1) {
    throw new ChangeCommandError(
      "ambiguous_change",
      `Ambiguous change reference: ${reference}\n${matches.map((id) => `  ${id}`).join("\n")}`,
      { candidates: matches.map((id) => ({ id })) },
    );
  }

  const id = matches[0]!;
  const branch = changeBranch(id);
  const localRef = local.includes(branch) ? branch : `origin/${branch}`;
  if (localRef !== branch) {
    await git(["fetch", "--quiet", "origin", branch], root);
  }
  if (!(await git(["cat-file", "-t", `${localRef}:${path.posix.join("wiki", "changes", id, "status.yml")}`], root))) {
    throw new ChangeCommandError(
      "not_a_change_branch",
      `${branch} has no Weave change files (wiki/changes/${id}/status.yml)${localRef === branch ? "" : " on origin"}, so there is nothing to open. Commit and push the change files on that branch first.`,
      { branch },
    );
  }
  return { id, branch };
}

export interface SetupChangeOptions {
  cwd: string;
  approve?: boolean;
  confirm?: (commands: SetupCommand[]) => Promise<boolean>;
  sessionPath?: string;
  now?: Date;
}

export async function setupChange(options: SetupChangeOptions): Promise<SetupResult> {
  const context = await activeChangeContext({ cwd: options.cwd, sessionPath: options.sessionPath });
  if ((await workspaceCheckoutMode(context.target.path)) !== "worktree") {
    throw new ChangeCommandError(
      "not_worktree_checkout",
      "`weave change setup` prepares change worktrees, and this workspace switches branches in place (`checkout: in-place`), so there is nothing to set up.",
    );
  }
  return runChangeSetup({
    folder: context.target.path,
    changeId: context.change.id,
    branch: context.change.branch,
    approve: options.approve,
    confirm: options.confirm,
    now: options.now,
  });
}

export interface CloseChangeOptions {
  cwd: string;
  change?: string;
  sessionPath?: string;
}

export interface CloseChangeResult extends RemoveWorktreesResult {
  status: "ok";
  change: string;
  message: string;
}

export async function closeChange(options: CloseChangeOptions): Promise<CloseChangeResult> {
  const target = await resolveTarget(options.cwd, options.sessionPath);
  if ((await workspaceCheckoutMode(target.path)) !== "worktree") {
    throw new ChangeCommandError(
      "not_worktree_checkout",
      "`weave change close` removes change worktrees, and this workspace switches branches in place (`checkout: in-place`).",
    );
  }

  const activeId = await branchChangeIdForTarget(target.path);
  const changes = [...(await readChangesWithWorktrees(target.path, activeId))];
  for (const missing of await missingFolderChanges(target.path)) {
    if (!changes.some((change) => change.id === missing.id)) changes.push(missing);
  }
  const reference = options.change ?? activeId;
  if (!reference) {
    throw new ChangeCommandError("missing_change", "Name the change to close: `weave change close <change>`.");
  }
  const change = resolveChangeReference(changes, reference);
  const removed = await removeChangeWorktrees({ rootPath: target.path, changeId: change.id, branch: change.branch, cwd: options.cwd });
  await refreshAttention(target.path);

  return {
    status: "ok",
    change: change.id,
    ...removed,
    message: [
      `Closed change: ${change.id}`,
      `Removed: ${removed.removed.length > 0 ? removed.removed.join(", ") : "nothing (git had already cleared its record)"}`,
      ...removed.warnings.map((warning) => `Warning: ${warning}`),
      "",
      "Branches kept:",
      ...removed.branches.map((branch) => `  ${branch.repo}  ${branch.branch}${branch.pushed ? "" : "  (not on origin)"}`),
    ].join("\n"),
  };
}

// Changes Weave or git still records a folder for, whose folder no longer exists. Their
// planning files are gone, so they're named from their id (or the branch's status.yml).
async function missingFolderChanges(root: string): Promise<ChangeSummary[]> {
  const mainRoot = await resolveMainRoot(root);
  const stateDir = await localStateDir(mainRoot);
  const ids = new Set(await listLocalChangeIds(stateDir));
  for (const entry of await listGitWorktrees(mainRoot)) {
    if (entry.branch?.startsWith("change/") && !(await pathExists(entry.path))) ids.add(entry.branch.slice("change/".length));
  }
  const missing: ChangeSummary[] = [];
  for (const id of ids) {
    const state = await readLocalState(stateDir, id);
    if (state && (await pathExists(state.folder))) continue;
    const shown = await git(["show", `${changeBranch(id)}:wiki/changes/${id}/status.yml`], mainRoot);
    const metadata = metadataFromParsed(shown ? parseYamlRecord(shown) : {}, id);
    missing.push({ ...metadata, path: path.join("wiki", "changes", id), changePath: "", active: false });
  }
  return missing;
}

// Resolves a change reference, saying "folder missing" rather than "not found" for a
// change whose folder disappeared.
async function resolveOrExplainMissing(root: string, changes: ChangeSummary[], reference: string): Promise<ChangeSummary> {
  try {
    return resolveChangeReference(changes, reference);
  } catch (error) {
    if (!(error instanceof ChangeCommandError) || error.code !== "change_not_found") throw error;
    const missing = await missingFolderChanges(root);
    const match = (() => {
      try {
        return resolveChangeReference(missing, reference);
      } catch {
        return undefined;
      }
    })();
    if (!match) throw error;
    throw new ChangeCommandError("folder_missing", `${match.id}: folder missing; run \`weave change list\`.`, { change: match.id });
  }
}

// Recomputes `weave status`'s snapshot after a command changed which changes need attention.
async function refreshAttention(root: string): Promise<void> {
  try {
    const gathered = await gatherFacts(root);
    const counts = attentionCounts(gathered.changes.map((change) => deriveState(change.facts)));
    await writeAttention(gathered.mainRoot, { ...counts, factsAt: gathered.factsAt });
  } catch {
    // The snapshot is a convenience; the next list writes it again.
  }
}

export async function progressChange(options: ProgressChangeOptions): Promise<ProgressChangeResult> {
  const now = options.now ?? new Date();
  const context = await activeChangeContext(options);
  const target = context.target;

  const statusPath = path.join(context.change.changePath, "status.yml");
  const raw = await readStatusFile(statusPath);
  const existing = await readChangeMetadata(context.change.changePath, context.change.id);
  const sourceResolution = await resolveProgressSources(options, context.change.changePath);

  const nextStage = isEvidenceStage(options.stage) ? existing.stage : maxStage([existing.stage, options.stage]);
  const artifacts: ChangeArtifactsMetadata = {
    ...existing.artifacts,
    [options.stage]: {
      sources: sourceResolution.sources,
      updated_at: now.toISOString(),
    },
  };
  const stale: StaleChangeLanes = { ...existing.stale };
  delete stale[options.stage];

  const invalidatedAt = now.toISOString();
  const computedDependents = transitiveDependents(options.stage, artifacts);
  const propagationTargets = resolveStalePropagationTargets({
    computed: computedDependents,
    noInvalidate: options.noInvalidate ?? false,
    invalidateOnly: options.invalidateOnly,
  });
  for (const stage of propagationTargets) {
    stale[stage] = {
      invalidated_by: options.stage,
      invalidated_at: invalidatedAt,
    };
  }

  const nextStatus = {
    ...raw,
    stage: nextStage,
    artifacts,
    updated_at: invalidatedAt,
  };
  if (Object.keys(stale).length > 0) {
    Object.assign(nextStatus, { stale });
  } else {
    delete (nextStatus as { stale?: StaleChangeLanes }).stale;
  }
  const knowledge = staleKnowledgeFromProgress(raw.knowledge, existing.knowledge, options.stage, invalidatedAt);
  if (knowledge) {
    Object.assign(nextStatus, { knowledge });
  }
  // Recording a lane's progress is what finishes its running phase, so a run started in an
  // interactive session is marked done even while that session stays open.
  if (existing.runs.some((run) => run.lane === options.stage && run.result === "running")) {
    Object.assign(nextStatus, {
      runs: existing.runs.map((run) =>
        run.lane === options.stage && run.result === "running" ? { ...run, finished_at: invalidatedAt, result: "succeeded" } : run,
      ),
    });
  }

  await writeFile(statusPath, YAML.stringify(nextStatus));
  const updated = await readChangeMetadata(context.change.changePath, context.change.id);
  const change: ChangeSummary = {
    ...updated,
    path: context.change.path,
    changePath: context.change.changePath,
    active: true,
  };

  const checkpoint = await recordPlanningCheckpoint(
    context,
    { kind: "progress", lane: options.stage, staleLanes: propagationTargets },
    options,
  );
  const runsFinished = existing.runs.filter((run) => run.lane === options.stage && run.result === "running").map((run) => run.id);
  if (checkpoint.status === "failed" && runsFinished.length > 0) {
    await recordRunCheckpointFailure(statusPath, runsFinished, checkpoint);
  }

  return {
    status: "ok",
    target,
    change,
    progressed: options.stage,
    sources: sourceResolution.sources,
    note: sourceResolution.note,
    checkpoint,
    message: withCheckpointLine(formatProgressMessage(target, change, options.stage, sourceResolution.note), checkpoint),
  };
}

export interface ClearChangeStalenessOptions extends CheckpointMessageOptions {
  cwd: string;
  lane: ChangeStage;
  reason?: string;
  now?: Date;
  sessionPath?: string;
}

export interface ClearChangeStalenessResult {
  status: "ok";
  target: {
    id?: string;
    name?: string;
    path: string;
  };
  change: ChangeSummary;
  cleared: ChangeStage;
  history_entry: StaleHistoryEntry;
  checkpoint?: CheckpointOutcome;
  message: string;
}

export async function clearChangeStaleness(
  options: ClearChangeStalenessOptions,
): Promise<ClearChangeStalenessResult> {
  const now = options.now ?? new Date();
  const context = await activeChangeContext(options);
  const target = context.target;

  const statusPath = path.join(context.change.changePath, "status.yml");
  const raw = await readStatusFile(statusPath);
  const existing = await readChangeMetadata(context.change.changePath, context.change.id);

  const currentStale = existing.stale[options.lane];
  if (!currentStale) {
    throw new ChangeCommandError(
      "lane_not_stale",
      `Lane "${options.lane}" is not currently marked stale; nothing to clear.`,
      { lane: options.lane },
    );
  }

  const nextStale: StaleChangeLanes = { ...existing.stale };
  delete nextStale[options.lane];

  const historyEntry: StaleHistoryEntry = {
    lane: options.lane,
    invalidated_by: currentStale.invalidated_by,
    invalidated_at: currentStale.invalidated_at,
    cleared_at: now.toISOString(),
    reason: options.reason && options.reason.trim().length > 0 ? options.reason.trim() : null,
  };
  const nextHistory: StaleHistoryEntry[] = [...existing.stale_history, historyEntry];

  const nextStatus = {
    ...raw,
    updated_at: now.toISOString(),
    stale_history: nextHistory,
  } as Record<string, unknown>;
  if (Object.keys(nextStale).length > 0) {
    nextStatus.stale = nextStale;
  } else {
    delete (nextStatus as { stale?: StaleChangeLanes }).stale;
  }

  await writeFile(statusPath, YAML.stringify(nextStatus));
  const updated = await readChangeMetadata(context.change.changePath, context.change.id);
  const change: ChangeSummary = {
    ...updated,
    path: context.change.path,
    changePath: context.change.changePath,
    active: true,
  };

  const checkpoint = await recordPlanningCheckpoint(context, { kind: "clear-stale", lane: options.lane }, options);

  return {
    status: "ok",
    target,
    change,
    cleared: options.lane,
    history_entry: historyEntry,
    checkpoint,
    message: withCheckpointLine(
      `Cleared stale flag for ${options.lane} (was invalidated by ${currentStale.invalidated_by}).${historyEntry.reason ? ` Reason: ${historyEntry.reason}` : ""}`,
      checkpoint,
    ),
  };
}

export interface VerdictChangeOptions extends CheckpointMessageOptions {
  cwd: string;
  lane: StressTestLane;
  verdict: StressTestVerdict;
  reason?: string;
  session?: string;
  now?: Date;
  sessionPath?: string;
}

export interface VerdictChangeResult {
  status: "ok";
  target: ChangeTarget;
  change: ChangeSummary;
  lane: StressTestLane;
  stress_test: StressTestRecord;
  checkpoint?: CheckpointOutcome;
  message: string;
}

export async function verdictChange(options: VerdictChangeOptions): Promise<VerdictChangeResult> {
  const now = options.now ?? new Date();
  const reason = options.reason?.trim() || undefined;
  if (options.verdict === "waived" && !reason) {
    throw new ChangeCommandError("missing_reason", "A waived stress test needs --reason explaining why it was skipped.");
  }

  const context = await activeChangeContext(options);
  const target = context.target;
  const statusPath = path.join(context.change.changePath, "status.yml");
  const raw = await readStatusFile(statusPath);
  const existing = await readChangeMetadata(context.change.changePath, context.change.id);

  const record: Omit<StressTestRecord, "outdated"> = {
    verdict: options.verdict,
    judged_at: now.toISOString(),
    artifact_updated_at: existing.artifacts[options.lane]?.updated_at ?? null,
    ...(options.session ? { session: options.session } : {}),
    ...(reason ? { reason } : {}),
  };
  const stressTests = isRecord(raw.stress_tests) ? raw.stress_tests : {};
  const nextStatus = {
    ...raw,
    stress_tests: { ...stressTests, [options.lane]: record },
    updated_at: now.toISOString(),
  };
  await writeFile(statusPath, YAML.stringify(nextStatus));

  const updated = await readChangeMetadata(context.change.changePath, context.change.id);
  const change: ChangeSummary = {
    ...updated,
    path: context.change.path,
    changePath: context.change.changePath,
    active: true,
  };
  const stressTest = change.stress_tests[options.lane];
  if (!stressTest) {
    throw new ChangeCommandError("invalid_stress_test", "Stress test verdict could not be recorded");
  }

  const checkpoint = await recordPlanningCheckpoint(
    context,
    { kind: "verdict", lane: options.lane, verdict: options.verdict, ...(options.session ? { session: options.session } : {}) },
    options,
  );

  return {
    status: "ok",
    target,
    change,
    lane: options.lane,
    stress_test: stressTest,
    checkpoint,
    message: withCheckpointLine(`Recorded ${options.lane} stress test verdict: ${options.verdict}${reason ? ` (${reason})` : ""}.`, checkpoint),
  };
}

export interface AutoAdvanceChangeOptions {
  cwd: string;
  // Omit both to read every flag; give a transition alone to read one.
  transition?: string;
  enabled?: boolean;
  now?: Date;
  sessionPath?: string;
}

export interface AutoAdvanceTransitionState {
  transition: LifecycleTransitionId;
  from: ChangeStage;
  to: ChangeStage;
  skill: string;
  enabled: boolean;
  allowed: boolean;
  human_decision?: string;
}

export interface AutoAdvanceChangeResult {
  status: "ok";
  target: ChangeTarget;
  change: ChangeSummary;
  updated?: LifecycleTransitionId;
  transitions: AutoAdvanceTransitionState[];
  message: string;
}

export async function autoAdvanceChange(options: AutoAdvanceChangeOptions): Promise<AutoAdvanceChangeResult> {
  const transitionId = options.transition === undefined ? undefined : parseTransitionId(options.transition);
  if (transitionId && options.enabled === true && lifecycleTransition(transitionId).humanDecision) {
    throw new ChangeCommandError(
      "transition_needs_human",
      `${transitionId} cannot auto-advance: ${lifecycleTransition(transitionId).humanDecision}.`,
      { transition: transitionId },
    );
  }

  const context = await activeChangeContext(options);
  let change = context.change;
  if (transitionId && options.enabled !== undefined && !lifecycleTransition(transitionId).humanDecision) {
    const now = options.now ?? new Date();
    const statusPath = path.join(context.change.changePath, "status.yml");
    const raw = await readStatusFile(statusPath);
    const flags = { ...context.change.auto_advance, [transitionId]: options.enabled };
    await writeFile(statusPath, YAML.stringify({ ...raw, auto_advance: normalizeAutoAdvanceFlags(flags), updated_at: now.toISOString() }));
    change = await activeChangeSummary(context);
  }

  const transitions = lifecycleTransitionIds
    .filter((id) => !transitionId || id === transitionId)
    .map((id) => autoAdvanceTransitionState(id, change.auto_advance));
  const updated = transitionId && options.enabled !== undefined ? transitionId : undefined;

  return {
    status: "ok",
    target: context.target,
    change,
    ...(updated ? { updated } : {}),
    transitions,
    message: formatAutoAdvanceMessage(change, transitions, updated),
  };
}

export interface StartChangeRunOptions {
  cwd: string;
  lane: ChangeStage;
  skill: string;
  agent: string;
  sessionId?: string;
  trigger?: RunTrigger;
  transition?: LifecycleTransitionId;
  upstreamUpdatedAt?: string;
  launch?: RunLaunch;
  where?: string;
  // Lets the caller hand the id to a session before the run is recorded.
  id?: string;
  now?: Date;
  randomId?: () => string;
  sessionPath?: string;
}

export interface ChangeRunResult {
  status: "ok";
  target: ChangeTarget;
  change: ChangeSummary;
  run: PhaseRun;
  message: string;
}

export async function startChangeRun(options: StartChangeRunOptions): Promise<ChangeRunResult> {
  const now = options.now ?? new Date();
  const context = await activeChangeContext(options);

  const run: PhaseRun = {
    id: options.id ?? newRunId(options.lane, now, options.randomId),
    lane: options.lane,
    skill: options.skill,
    agent: options.agent,
    ...(options.sessionId ? { session_id: options.sessionId } : {}),
    trigger: options.trigger ?? "manual",
    ...(options.transition ? { transition: options.transition } : {}),
    ...(options.upstreamUpdatedAt ? { upstream_updated_at: options.upstreamUpdatedAt } : {}),
    ...(options.launch ? { launch: options.launch } : {}),
    ...(options.where ? { where: options.where } : {}),
    started_at: now.toISOString(),
    finished_at: null,
    result: "running",
  };
  const statusPath = path.join(context.change.changePath, "status.yml");
  const raw = await readStatusFile(statusPath);
  await writeFile(statusPath, YAML.stringify({ ...raw, runs: [...context.change.runs, run], updated_at: now.toISOString() }));
  const change = await activeChangeSummary(context);

  return {
    status: "ok",
    target: context.target,
    change,
    run,
    message: `Started run ${run.id}: ${run.skill} for ${run.lane} (${run.agent}).`,
  };
}

export function newRunId(lane: ChangeStage, now: Date, randomId?: () => string): string {
  return `${lane}-${formatRunTimestamp(now)}-${(randomId ?? randomChangeIdPart)()}`;
}

export interface FinishChangeRunOptions {
  cwd: string;
  runId: string;
  result: FinishedRunResult;
  sessionId?: string;
  now?: Date;
  sessionPath?: string;
}

export async function finishChangeRun(options: FinishChangeRunOptions): Promise<ChangeRunResult> {
  const now = options.now ?? new Date();
  const context = await activeChangeContext(options);
  const existing = context.change.runs.find((run) => run.id === options.runId);
  if (!existing) {
    throw new ChangeCommandError("run_not_found", `No run ${options.runId} recorded for ${context.change.id}.`, { run: options.runId });
  }
  if (existing.result !== "running") {
    throw new ChangeCommandError("run_already_finished", `Run ${options.runId} already finished as ${existing.result}.`, { run: existing });
  }

  const run: PhaseRun = {
    ...existing,
    ...(options.sessionId ? { session_id: options.sessionId } : {}),
    finished_at: now.toISOString(),
    result: options.result,
  };
  const statusPath = path.join(context.change.changePath, "status.yml");
  const raw = await readStatusFile(statusPath);
  const runs = context.change.runs.map((candidate) => (candidate.id === run.id ? run : candidate));
  await writeFile(statusPath, YAML.stringify({ ...raw, runs, updated_at: now.toISOString() }));
  const change = await activeChangeSummary(context);

  return {
    status: "ok",
    target: context.target,
    change,
    run,
    message: `Finished run ${run.id}: ${run.result}.`,
  };
}

export interface ListChangeRunsResult {
  status: "ok";
  target: ChangeTarget;
  change_id: string;
  runs: PhaseRun[];
  message: string;
}

export async function listChangeRuns(options: CurrentChangeOptions): Promise<ListChangeRunsResult> {
  const context = await activeChangeContext(options);
  const runs = context.change.runs;
  return {
    status: "ok",
    target: context.target,
    change_id: context.change.id,
    runs,
    message:
      runs.length === 0
        ? `No runs recorded for ${context.change.id}.`
        : [
            `Runs for ${context.change.id}:`,
            ...runs.map(
              (run) =>
                `  ${run.id}  ${run.skill}  ${run.agent}  ${run.result}  ${run.started_at}${run.finished_at ? ` -> ${run.finished_at}` : ""}${
                  run.result === "running" ? runningHint(run) : ""
                }`,
            ),
          ].join("\n"),
  };
}

function runningHint(run: PhaseRun): string {
  if (run.launch === "terminal") return `\n    open in ${run.where ?? "a terminal"}`;
  if (run.launch === "here") return "\n    open in the terminal that ran weave advance";
  if (run.launch === "handoff") return "\n    handed to a sub-agent of the session that ran weave advance";
  return `\n    watch: weave change run log ${run.id} --follow`;
}

async function activeChangeSummary(context: ActiveChangeContext): Promise<ChangeSummary> {
  const updated = await readChangeMetadata(context.change.changePath, context.change.id);
  return {
    ...updated,
    path: context.change.path,
    changePath: context.change.changePath,
    active: true,
  };
}

function parseTransitionId(value: string): LifecycleTransitionId {
  if (isLifecycleTransitionId(value)) {
    return value;
  }
  throw new ChangeCommandError(
    "unknown_transition",
    `Unknown transition: ${value}. Expected ${lifecycleTransitionIds.join(", ")}`,
    { transition: value, supported: lifecycleTransitionIds },
  );
}

function autoAdvanceTransitionState(id: LifecycleTransitionId, flags: AutoAdvanceFlags): AutoAdvanceTransitionState {
  const transition = lifecycleTransition(id);
  return {
    transition: id,
    from: transition.from,
    to: transition.to,
    skill: transition.skill,
    enabled: !transition.humanDecision && flags[id] === true,
    allowed: !transition.humanDecision,
    ...(transition.humanDecision ? { human_decision: transition.humanDecision } : {}),
  };
}

function formatAutoAdvanceMessage(
  change: ChangeSummary,
  transitions: AutoAdvanceTransitionState[],
  updated?: LifecycleTransitionId,
): string {
  const width = Math.max(...transitions.map((state) => state.transition.length));
  return [
    updated ? `Auto-advance ${updated} is now ${change.auto_advance[updated] ? "on" : "off"} for ${change.id}.` : `Auto-advance for ${change.id}:`,
    ...transitions.map((state) =>
      state.allowed
        ? `  ${state.transition.padEnd(width)}  ${(state.enabled ? "on" : "off").padEnd(5)}  ${state.from} -> ${state.to} (${state.skill})`
        : `  ${state.transition.padEnd(width)}  never  ${state.from} -> ${state.to}: ${state.human_decision}`,
    ),
  ].join("\n");
}

function formatRunTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
}

export async function knowledgeChange(options: KnowledgeChangeOptions): Promise<KnowledgeChangeResult> {
  const now = options.now ?? new Date();
  const context = await activeChangeContext(options);
  const target = context.target;

  const invalidatedBy = options.invalidatedBy ? normalizeKnowledgeInvalidationSource(options.invalidatedBy) : undefined;
  const statusPath = path.join(context.change.changePath, "status.yml");
  const raw = await readStatusFile(statusPath);
  const existing = await readChangeMetadata(context.change.changePath, context.change.id);
  const knowledge = mergeKnowledgeMetadata(raw.knowledge, existing.knowledge, {
    status: options.status,
    updatedAt: now.toISOString(),
    domains: options.domains,
    shared: options.shared,
    files: options.files,
    delta: options.delta,
    reason: options.reason,
    invalidatedBy,
  });

  const nextStatus = {
    ...raw,
    knowledge,
    updated_at: now.toISOString(),
  };
  await writeFile(statusPath, YAML.stringify(nextStatus));
  const updated = await readChangeMetadata(context.change.changePath, context.change.id);
  const change: ChangeSummary = {
    ...updated,
    path: context.change.path,
    changePath: context.change.changePath,
    active: true,
  };

  const checkpoint = await recordPlanningCheckpoint(context, { kind: "knowledge", status: options.status }, options);

  if (!change.knowledge) {
    throw new ChangeCommandError("invalid_knowledge_status", "Knowledge status could not be recorded");
  }

  return {
    status: "ok",
    target,
    change,
    knowledge: change.knowledge,
    checkpoint,
    message: withCheckpointLine(formatKnowledgeMessage(target, change), checkpoint),
  };
}

function normalizeChangeSlug(value: string): string {
  const slug = slugify(value, "change");
  return slug.split("-").filter(Boolean).slice(0, 6).join("-") || "change";
}

async function generateChangeId(
  targets: ChangeTarget[],
  slug: string,
  now: Date,
  randomId: () => string,
  checkout: CheckoutMode = "in-place",
): Promise<string> {
  const date = formatDatePrefix(now);
  for (let index = 0; index < 20; index += 1) {
    const id = `${date}-${randomId()}-${slug}`;
    const exists = await Promise.all(
      targets.map(async (target) =>
        (await pathExists(changeDir(target.path, id))) ||
        Boolean(await git(["rev-parse", "--verify", "--quiet", `refs/heads/${changeBranch(id)}`], target.path)) ||
        (checkout === "worktree" && (await pathExists(await changeFolderPath(target.path, id)))),
      ),
    );
    if (!exists.some(Boolean)) {
      return id;
    }
  }

  throw new ChangeCommandError("id_collision", "Could not generate a unique change id");
}

export function formatDatePrefix(now: Date): string {
  const year = String(now.getFullYear()).slice(-2);
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

export function randomChangeIdPart(): string {
  const bytes = randomBytes(4);
  return Array.from(bytes, (byte) => idChars[byte % idChars.length]).join("");
}

function changeBranch(changeId: string): string {
  return `change/${changeId}`;
}

function changeDir(root: string, changeId: string): string {
  return path.join(root, "wiki", "changes", changeId);
}

async function assertChangeMissing(targets: ChangeTarget[], changeId: string): Promise<void> {
  const existing: string[] = [];
  for (const target of targets) {
    const targetChangePath = changeDir(target.path, changeId);
    if (await pathExists(targetChangePath)) {
      existing.push(targetChangePath);
    }
  }

  if (existing.length > 0) {
    throw new ChangeCommandError(
      "change_exists",
      `Change already exists:\n${existing.map((item) => `  ${item}`).join("\n")}`,
      { existing },
    );
  }
}

async function assertGitTargets(targets: ChangeTarget[]): Promise<void> {
  const nonGit: string[] = [];
  for (const target of targets) {
    if (!(await findGitRoot(target.path))) {
      nonGit.push(target.path);
    }
  }

  if (nonGit.length > 0) {
    throw new ChangeCommandError(
      "not_git",
      `Cannot create a change outside a git repository:\n${nonGit.map((item) => `  ${item}`).join("\n")}`,
      { paths: nonGit },
    );
  }
}

async function branchChangeIdForTarget(root: string): Promise<string | undefined> {
  const branch = await currentBranch(root);
  return branch?.startsWith("change/") ? branch.slice("change/".length) : undefined;
}

async function resolveTarget(cwd: string, sessionPath?: string): Promise<ChangeTarget> {
  const context = await resolveChangeContext(cwd, sessionPath ?? defaultSessionPath());
  if (!context) {
    throw new ChangeCommandError("no_weave_context", "No Weave context found. Run `weave init` first.");
  }

  return {
    id: context.folderId,
    name: context.folderName,
    path: context.rootPath,
  };
}

async function readChanges(root: string, activeId?: string): Promise<ChangeSummary[]> {
  const changesRoot = path.join(root, "wiki", "changes");
  const entries = await readdir(changesRoot, { withFileTypes: true }).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  });

  const changes = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const changePath = path.join(changesRoot, entry.name);
        const metadata = await readChangeMetadata(changePath, entry.name);
        return {
          ...metadata,
          path: path.join("wiki", "changes", metadata.id),
          changePath,
          active: metadata.id === activeId,
        };
      }),
  );

  return changes.sort(compareChangesNewestFirst);
}

// With worktree checkouts each change's files live in its own folder, so the main checkout
// does not see them. Read them from every worktree on a change branch as well.
async function readChangesWithWorktrees(root: string, activeId?: string): Promise<ChangeSummary[]> {
  const local = await readChanges(root, activeId);
  if ((await workspaceCheckoutMode(root)) !== "worktree") {
    return local;
  }

  const byId = new Map(local.map((change) => [change.id, change]));
  for (const worktree of await listGitWorktrees(root)) {
    const id = worktree.branch?.startsWith("change/") ? worktree.branch.slice("change/".length) : undefined;
    const changePath = id ? changeDir(worktree.path, id) : undefined;
    if (!id || !changePath || !(await pathExists(path.join(changePath, "status.yml")))) {
      continue;
    }
    const metadata = await readChangeMetadata(changePath, id);
    const info = await readLocalChangeInfo(root, id);
    byId.set(id, {
      ...metadata,
      path: path.join("wiki", "changes", metadata.id),
      changePath,
      folder: worktree.path,
      ...(info ? { slot: info.slot } : {}),
      active: metadata.id === activeId,
    });
  }
  return [...byId.values()].sort(compareChangesNewestFirst);
}

async function readChangeMetadata(changePath: string, fallbackId: string): Promise<ChangeStatusMetadata> {
  const statusPath = path.join(changePath, "status.yml");
  const parsed = (await pathExists(statusPath)) ? await readStatusFile(statusPath) : {};
  return metadataFromParsed(parsed, fallbackId);
}

function metadataFromParsed(parsed: Record<string, unknown> | undefined, fallbackId: string): ChangeStatusMetadata {
  const id = typeof parsed?.id === "string" ? parsed.id : fallbackId;
  const slug = typeof parsed?.slug === "string" ? parsed.slug : id.split("-").slice(2).join("-");
  const title = typeof parsed?.title === "string" ? parsed.title : titleFromSlug(slug);
  const type = isChangeType(parsed?.type) ? parsed.type : "feat";
  const branch = typeof parsed?.branch === "string" ? parsed.branch : changeBranch(id);
  const stage = normalizeStoredStage(parsed?.stage);
  return {
    id,
    slug,
    title,
    type,
    stage,
    stale: parseStaleLanes(parsed?.stale),
    stale_history: parseStaleHistory(parsed?.stale_history),
    artifacts: parseArtifactsMetadata(parsed?.artifacts),
    stress_tests: parseStressTests(parsed?.stress_tests, parseArtifactsMetadata(parsed?.artifacts)),
    auto_advance: parseAutoAdvanceFlags(parsed?.auto_advance),
    runs: parseRuns(parsed?.runs),
    knowledge: parseKnowledgeMetadata(parsed?.knowledge),
    branch,
    created_at: typeof parsed?.created_at === "string" ? parsed.created_at : undefined,
    updated_at: typeof parsed?.updated_at === "string" ? parsed.updated_at : undefined,
  };
}

async function readStatusFile(statusPath: string): Promise<Record<string, unknown>> {
  const parsed = YAML.parse(await readFile(statusPath, "utf8"));
  return isRecord(parsed) ? parsed : {};
}

function parseStaleHistory(value: unknown): StaleHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const out: StaleHistoryEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const lane = entry.lane;
    const clearedAt = entry.cleared_at;
    const normalizedLane = typeof lane === "string" ? normalizeChangeStage(lane) : undefined;
    if (!normalizedLane || typeof clearedAt !== "string") continue;
    const normalizedInvalidatedBy =
      typeof entry.invalidated_by === "string" ? normalizeChangeStage(entry.invalidated_by) : undefined;
    out.push({
      lane: normalizedLane,
      invalidated_by: normalizedInvalidatedBy ?? null,
      invalidated_at: typeof entry.invalidated_at === "string" ? entry.invalidated_at : null,
      cleared_at: clearedAt,
      reason: typeof entry.reason === "string" ? entry.reason : null,
    });
  }
  return out;
}

function parseStaleLanes(value: unknown): StaleChangeLanes {
  if (!isRecord(value)) {
    return {};
  }

  const stale: StaleChangeLanes = {};
  for (const [lane, metadata] of Object.entries(value)) {
    const normalizedLane = normalizeChangeStage(lane);
    if (!normalizedLane || !isRecord(metadata)) {
      continue;
    }
    const invalidatedBy = metadata.invalidated_by;
    const invalidatedAt = metadata.invalidated_at;
    const normalizedInvalidatedBy =
      typeof invalidatedBy === "string" ? normalizeChangeStage(invalidatedBy) : undefined;
    if (!normalizedInvalidatedBy || typeof invalidatedAt !== "string") {
      continue;
    }
    stale[normalizedLane] = {
      invalidated_by: normalizedInvalidatedBy,
      invalidated_at: invalidatedAt,
    };
  }
  return stale;
}

function parseArtifactsMetadata(value: unknown): ChangeArtifactsMetadata {
  if (!isRecord(value)) {
    return {};
  }

  const artifacts: ChangeArtifactsMetadata = {};
  for (const [lane, metadata] of Object.entries(value)) {
    const normalizedLane = normalizeChangeStage(lane);
    if (!normalizedLane || !isRecord(metadata)) {
      continue;
    }
    const updatedAt = metadata.updated_at;
    if (typeof updatedAt !== "string") {
      continue;
    }
    artifacts[normalizedLane] = {
      sources: parseArtifactSources(metadata.sources),
      updated_at: updatedAt,
    };
  }
  return artifacts;
}

function parseArtifactSources(value: unknown): ArtifactSourceId[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return dedupeSources(value.filter(isArtifactSourceId));
}

function parseStressTests(value: unknown, artifacts: ChangeArtifactsMetadata): StressTestRecords {
  if (!isRecord(value)) {
    return {};
  }

  const records: StressTestRecords = {};
  for (const lane of stressTestLanes) {
    const entry = value[lane];
    if (!isRecord(entry) || !isStressTestVerdict(entry.verdict) || typeof entry.judged_at !== "string") {
      continue;
    }
    const artifactUpdatedAt = typeof entry.artifact_updated_at === "string" ? entry.artifact_updated_at : null;
    const laneUpdatedAt = artifacts[lane]?.updated_at;
    records[lane] = {
      verdict: entry.verdict,
      judged_at: entry.judged_at,
      artifact_updated_at: artifactUpdatedAt,
      ...(typeof entry.session === "string" ? { session: entry.session } : {}),
      ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
      outdated: Boolean(laneUpdatedAt && (!artifactUpdatedAt || laneUpdatedAt > artifactUpdatedAt)),
    };
  }

  return records;
}

// Missing or unknown flags read as off, and transitions that need a human decision can
// never read as on, even if status.yml was edited by hand.
function parseAutoAdvanceFlags(value: unknown): AutoAdvanceFlags {
  if (!isRecord(value)) {
    return {};
  }

  const flags: AutoAdvanceFlags = {};
  for (const transition of autoAdvanceTransitions) {
    if (typeof value[transition.id] === "boolean") {
      flags[transition.id] = value[transition.id] as boolean;
    }
  }
  return flags;
}

function parseRuns(value: unknown): PhaseRun[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const runs: PhaseRun[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const lane = typeof entry.lane === "string" ? normalizeChangeStage(entry.lane) : undefined;
    if (
      typeof entry.id !== "string" ||
      !lane ||
      typeof entry.skill !== "string" ||
      typeof entry.agent !== "string" ||
      typeof entry.started_at !== "string" ||
      !isRunResult(entry.result)
    ) {
      continue;
    }
    runs.push({
      id: entry.id,
      lane,
      skill: entry.skill,
      agent: entry.agent,
      ...(typeof entry.session_id === "string" ? { session_id: entry.session_id } : {}),
      trigger: isRunTrigger(entry.trigger) ? entry.trigger : "manual",
      ...(isLifecycleTransitionId(entry.transition) ? { transition: entry.transition } : {}),
      ...(typeof entry.upstream_updated_at === "string" ? { upstream_updated_at: entry.upstream_updated_at } : {}),
      ...((runLaunches as readonly unknown[]).includes(entry.launch) ? { launch: entry.launch as RunLaunch } : {}),
      ...(typeof entry.where === "string" ? { where: entry.where } : {}),
      started_at: entry.started_at,
      finished_at: typeof entry.finished_at === "string" ? entry.finished_at : null,
      result: entry.result,
    });
  }
  return runs;
}

function parseKnowledgeMetadata(value: unknown): KnowledgeMetadata | undefined {
  if (!isRecord(value) || !isKnowledgeStatus(value.status) || typeof value.updated_at !== "string") {
    return undefined;
  }

  const invalidatedBy = value.invalidated_by;
  const invalidatedAt = value.invalidated_at;
  const knowledge: KnowledgeMetadata = {
    status: value.status,
    updated_at: value.updated_at,
    domains: parseStringList(value.domains),
    shared: parseStringList(value.shared),
    files: parseStringList(value.files),
  };

  if (typeof value.delta === "string") {
    knowledge.delta = value.delta;
  }
  if (typeof value.reason === "string") {
    knowledge.reason = value.reason;
  }
  if (isKnowledgeInvalidationSource(invalidatedBy) && typeof invalidatedAt === "string") {
    knowledge.invalidated_by = invalidatedBy;
    knowledge.invalidated_at = invalidatedAt;
  }

  return knowledge;
}

function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return dedupeStrings(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0));
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function mergeKnowledgeMetadata(
  rawKnowledge: unknown,
  existing: KnowledgeMetadata | undefined,
  update: {
    status: KnowledgeStatus;
    updatedAt: string;
    domains?: readonly string[];
    shared?: readonly string[];
    files?: readonly string[];
    delta?: string;
    reason?: string;
    invalidatedBy?: KnowledgeInvalidationSource;
  },
): KnowledgeMetadata {
  const base = isRecord(rawKnowledge) ? { ...rawKnowledge } : {};
  const currentDomains = existing?.domains ?? parseStringList(base.domains);
  const currentShared = existing?.shared ?? parseStringList(base.shared);
  const currentFiles = existing?.files ?? parseStringList(base.files);
  const next = {
    ...base,
    status: update.status,
    updated_at: update.updatedAt,
    domains: update.domains ? dedupeStrings(update.domains) : currentDomains,
    shared: update.shared ? dedupeStrings(update.shared) : currentShared,
    files: update.files ? dedupeStrings(update.files) : currentFiles,
  };

  if (update.delta !== undefined) {
    Object.assign(next, { delta: update.delta });
  } else if (existing?.delta) {
    Object.assign(next, { delta: existing.delta });
  }

  if (update.reason !== undefined) {
    Object.assign(next, { reason: update.reason });
  } else if (existing?.reason) {
    Object.assign(next, { reason: existing.reason });
  }

  if (update.status === "stale") {
    Object.assign(next, { invalidated_at: update.updatedAt });
    if (update.invalidatedBy) {
      Object.assign(next, { invalidated_by: update.invalidatedBy });
    } else if (existing?.invalidated_by) {
      Object.assign(next, { invalidated_by: existing.invalidated_by });
    }
  } else {
    delete (next as { invalidated_by?: KnowledgeInvalidationSource }).invalidated_by;
    delete (next as { invalidated_at?: string }).invalidated_at;
  }

  return parseKnowledgeMetadata(next) ?? {
    status: update.status,
    updated_at: update.updatedAt,
    domains: update.domains ? dedupeStrings(update.domains) : currentDomains,
    shared: update.shared ? dedupeStrings(update.shared) : currentShared,
    files: update.files ? dedupeStrings(update.files) : currentFiles,
  };
}

function staleKnowledgeFromProgress(
  rawKnowledge: unknown,
  existing: KnowledgeMetadata | undefined,
  invalidatedBy: ChangeStage,
  invalidatedAt: string,
): KnowledgeMetadata | undefined {
  if (!existing || (existing.status !== "updated" && existing.status !== "none")) {
    return existing;
  }

  return mergeKnowledgeMetadata(rawKnowledge, existing, {
    status: "stale",
    updatedAt: invalidatedAt,
    invalidatedBy,
    reason: `${invalidatedBy} changed after knowledge was marked ${existing.status}.`,
  });
}

async function resolveProgressSources(
  options: ProgressChangeOptions,
  changePath: string,
): Promise<{ sources: ArtifactSourceId[]; note?: string }> {
  const requested = options.sources ?? [];
  const sources = dedupeSources(requested.map((source) => normalizeArtifactSourceId(source)));
  if (sources.length > 0) {
    return { sources };
  }

  if (options.stage === "research" && (await hasSubstantiveMarkdown(path.join(changePath, "questions.md")))) {
    return { sources: ["questions"] };
  }

  if (options.stage === "findings" && (await hasSubstantiveMarkdown(path.join(changePath, "findings.md")))) {
    return { sources: ["discussion"] };
  }

  if (options.stage === "slices" && (await resolveArchitectureArtifact(changePath)).substantive) {
    return { sources: ["architecture"] };
  }

  return {
    sources,
    note: `No sources recorded for ${options.stage}; downstream stale invalidation will only use explicitly recorded dependencies.`,
  };
}

function normalizeArtifactSourceId(value: string): ArtifactSourceId {
  if (isArtifactSourceId(value)) {
    return value;
  }

  throw new ChangeCommandError(
    "unsupported_source",
    `Unsupported artifact source: ${value}. Expected ${artifactSourceIds.join(", ")}`,
    { source: value, supported: artifactSourceIds },
  );
}

function dedupeSources(sources: ArtifactSourceId[]): ArtifactSourceId[] {
  return [...new Set(sources)];
}

function resolveStalePropagationTargets(input: {
  computed: ChangeStage[];
  noInvalidate: boolean;
  invalidateOnly?: readonly ChangeStage[];
}): ChangeStage[] {
  if (input.noInvalidate && input.invalidateOnly && input.invalidateOnly.length > 0) {
    throw new ChangeCommandError(
      "conflicting_stale_flags",
      "Use either --no-invalidate or --invalidate=<list>, not both.",
    );
  }
  if (input.noInvalidate) {
    return [];
  }
  if (input.invalidateOnly && input.invalidateOnly.length > 0) {
    const computed = new Set(input.computed);
    const intersection: ChangeStage[] = [];
    const unknown: ChangeStage[] = [];
    for (const candidate of input.invalidateOnly) {
      if (computed.has(candidate)) {
        intersection.push(candidate);
      } else {
        unknown.push(candidate);
      }
    }
    if (unknown.length > 0) {
      throw new ChangeCommandError(
        "invalid_invalidate_target",
        `Cannot invalidate lanes that are not transitive dependents of the progressed lane: ${unknown.join(", ")}`,
        { unknown, computedDependents: input.computed },
      );
    }
    return intersection;
  }
  return input.computed;
}

function transitiveDependents(source: ChangeStage, artifacts: ChangeArtifactsMetadata): ChangeStage[] {
  const dependents = new Set<ChangeStage>();
  const queue: ChangeStage[] = [source];

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const candidate of changeStages) {
      if (candidate === source || dependents.has(candidate)) {
        continue;
      }
      const candidateSources = artifacts[candidate]?.sources ?? [];
      if (candidateSources.some((candidateSource) => candidateSource === current)) {
        dependents.add(candidate);
        queue.push(candidate);
      }
    }
  }

  return changeStages.filter((stage) => dependents.has(stage));
}

async function hasIssueEvidence(changePath: string): Promise<boolean> {
  const tasksPath = path.join(changePath, "tasks.md");
  if (await hasSubstantiveMarkdown(tasksPath)) {
    return true;
  }

  const architecture = await resolveArchitectureArtifact(changePath);
  const evidencePaths = [
    path.join(changePath, "exploration.md"),
    path.join(changePath, "prd.md"),
    ...architectureMarkdownPaths(architecture),
  ];

  for (const filePath of evidencePaths) {
    if (!(await pathExists(filePath))) {
      continue;
    }
    const content = await readFile(filePath, "utf8");
    if (/(https?:\/\/\S+\/issues\/\d+|(^|\s)#\d+\b)/m.test(content)) {
      return true;
    }
  }

  return false;
}

function compareChangesNewestFirst(left: ChangeSummary, right: ChangeSummary): number {
  const leftTime = left.created_at ?? left.id;
  const rightTime = right.created_at ?? right.id;
  return rightTime.localeCompare(leftTime);
}

function resolveChangeReference(changes: ChangeSummary[], value: string): ChangeSummary {
  const ref = value.trim().toLowerCase();
  const matches = changes.filter((change) => {
    const token = change.id.split("-")[1];
    return (
      change.id.toLowerCase() === ref ||
      token === ref ||
      change.slug.toLowerCase().includes(ref) ||
      change.title.toLowerCase().includes(ref)
    );
  });

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length === 0) {
    throw new ChangeCommandError("change_not_found", `No matching change found: ${value}`);
  }

  throw new ChangeCommandError(
    "ambiguous_change",
    `Ambiguous change reference: ${value}\n${matches.map((change) => `  ${change.id} - ${change.title}`).join("\n")}`,
    { candidates: matches.map((change) => ({ id: change.id, title: change.title, type: change.type, stage: change.stage })) },
  );
}

async function currentContextForTarget(target: ChangeTarget): Promise<CurrentChangeTargetResult> {
  const branch = await currentBranch(target.path);
  const gitRoot = await findGitRoot(target.path);
  const activeId = branch?.startsWith("change/") ? branch.slice("change/".length) : undefined;
  const changes = await readChanges(target.path, activeId);
  const inferred = branch ? inferChangeFromBranch(changes, branch) : undefined;

  if (inferred) {
    const info = (await workspaceCheckoutMode(target.path)) === "worktree" ? await readLocalChangeInfo(target.path, inferred.id) : undefined;
    return {
      id: target.id,
      name: target.name,
      path: target.path,
      source: "branch",
      resolution: "branch_active",
      saved: false,
      current: { ...inferred, ...(info ? { folder: target.path, slot: info.slot } : {}), active: true },
      branch,
      branchMatch: "match",
    };
  }

  if (!gitRoot) {
    return {
      id: target.id,
      name: target.name,
      path: target.path,
      source: "none",
      resolution: "non_git_no_active_change",
      saved: false,
      branch,
      branchMatch: "not_git",
    };
  }

  return {
    id: target.id,
    name: target.name,
    path: target.path,
    source: "none",
    resolution: activeId ? "invalid_active_branch" : "no_active_change",
    saved: false,
    branch,
    branchMatch: "unknown",
  };
}

function inferChangeFromBranch(changes: ChangeSummary[], branch: string): ChangeSummary | undefined {
  if (!branch.startsWith("change/")) {
    return undefined;
  }

  const id = branch.slice("change/".length);
  return changes.find((change) => change.id === id);
}

function statusTemplate(input: {
  id: string;
  slug: string;
  title: string;
  type: ChangeType;
  branch: string;
  autoAdvance: AutoAdvanceFlags;
  now: Date;
}): string {
  return YAML.stringify({
    version: 1,
    id: input.id,
    slug: input.slug,
    title: input.title,
    type: input.type,
    stage: input.type === "feat" ? "exploration" : "started",
    branch: input.branch,
    auto_advance: normalizeAutoAdvanceFlags(input.autoAdvance),
    created_at: input.now.toISOString(),
    updated_at: input.now.toISOString(),
  });
}

function explorationTemplate(title: string, topic: string, now: Date): string {
  return `${artifactFrontmatter({ artifact: "exploration", now })}# ${titleFromSlug(slugify(title, "change")) || title}

## Topic

${topic}

## Problem

## Existing Behavior

## Options Considered

## Chosen Direction

## Scenarios

## Decisions

## Assumptions

## Open Questions

## PRD Readiness

Not ready
`;
}

async function ensureChangeBranch(cwd: string, branch: string, base?: string): Promise<BranchStatus> {
  const gitRoot = await findGitRoot(cwd);
  if (!gitRoot) {
    return "skipped_not_git";
  }

  const current = await git(["branch", "--show-current"], gitRoot);
  if (current === branch) {
    return "already_active";
  }

  const exists = await git(["rev-parse", "--verify", `refs/heads/${branch}`], gitRoot);
  if (exists) {
    await gitRequired(["checkout", branch], gitRoot);
    return "checked_out";
  }

  await gitRequired(["checkout", "-b", branch, ...(base ? [base] : [])], gitRoot);
  return "created";
}

async function assertCleanGitTargets(targets: ChangeTarget[]): Promise<void> {
  for (const target of targets) {
    const gitRoot = await findGitRoot(target.path);
    if (!gitRoot) {
      continue;
    }

    const dirty = await git(["status", "--porcelain"], gitRoot);
    if (dirty) {
      throw new ChangeCommandError("dirty_worktree", `Uncommitted changes in ${target.path}. Commit, stash, or clean them before switching change context.`, {
        path: target.path,
      });
    }
  }
}

async function currentBranch(cwd: string): Promise<string | undefined> {
  const gitRoot = await findGitRoot(cwd);
  if (!gitRoot) {
    return undefined;
  }

  return git(["branch", "--show-current"], gitRoot);
}

function branchMatch(branch: string | undefined, expected: string, gitRoot: string | undefined): BranchMatch {
  if (!gitRoot) {
    return "not_git";
  }
  if (!branch) {
    return "unknown";
  }
  return branch === expected ? "match" : "mismatch";
}

async function git(args: string[], cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    const value = stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

async function gitRequired(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function summarizeChangeOperation(input: {
  id: string;
  slug: string;
  title: string;
  type: ChangeType;
  branch: string;
  autoAdvance: AutoAdvanceFlags;
  checkout: CheckoutMode;
  worktrees?: Awaited<ReturnType<typeof ensureChangeWorktrees>>;
  targets: ChangeTargetResult[];
  verb: string;
}): ChangeOperationResult {
  const lines = [
    `${input.verb} change: ${input.id}`,
    "",
    `Title: ${input.title}`,
    `Type: ${input.type}`,
    `Branch: ${input.branch}`,
    ...formatAutoAdvanceLines(input.autoAdvance),
    "",
  ];
  if (input.worktrees) {
    lines.push(...formatWorktreeLines(input.worktrees));
  } else {
    lines.push("Targets:", ...input.targets.map((target) => `  ${target.path} (${formatBranchStatus(target.branchStatus)}, current)`));
  }

  return {
    status: "ok",
    id: input.id,
    slug: input.slug,
    title: input.title,
    type: input.type,
    branch: input.branch,
    auto_advance: normalizeAutoAdvanceFlags(input.autoAdvance),
    checkout: input.checkout,
    ...(input.worktrees
      ? {
          folder: input.worktrees.folder,
          slot: input.worktrees.slot,
          repos: input.worktrees.repos,
          copied: input.worktrees.copied,
          warnings: input.worktrees.warnings,
        }
      : {}),
    targets: input.targets,
    message: lines.join("\n"),
  };
}

function formatWorktreeLines(worktrees: Awaited<ReturnType<typeof ensureChangeWorktrees>>): string[] {
  return [
    `Folder: ${worktrees.folder}`,
    `Slot: ${worktrees.slot}`,
    "",
    "Worktrees:",
    ...worktrees.repos.map((repo) => {
      const detail = repo.status === "skipped_not_git" ? `skipped: ${repo.reason ?? "not a git repo"}` : repo.status;
      return `  ${repo.id}  ${repo.path}  ${detail}${repo.base ? ` from ${repo.base}` : ""}`;
    }),
    ...(worktrees.copied.length > 0 ? ["", "Copied:", ...worktrees.copied.map((file) => `  ${file}`)] : []),
    ...(worktrees.warnings.length > 0 ? ["", "Warnings:", ...worktrees.warnings.map((warning) => `  ${warning}`)] : []),
    "",
    `Open ${worktrees.folder} in a new session to work on this change.`,
  ];
}

function formatListMessage(targets: ChangeTargetSummary[]): string {
  if (targets.length === 0) {
    return "No workspace folders found.";
  }

  return targets
    .map((target) => {
      const lines = [`Changes in ${target.name ?? target.path}`];
      if (target.changes.length === 0) {
        lines.push("  No changes found.");
      } else {
        lines.push(
          ...target.changes.flatMap((change) => [
            `${change.active ? "*" : " "} ${change.id}  ${change.type}  ${change.stage}  ${change.title}`,
            ...(change.folder ? [`    folder: ${change.folder}${change.slot ? `  (slot ${change.slot})` : ""}`] : []),
          ]),
        );
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function formatCurrentMessage(targets: CurrentChangeTargetResult[]): string {
  if (targets.length === 0) {
    return "No workspace folders found.";
  }

  return targets.map(formatCurrentTarget).join("\n\n");
}

function formatCurrentTarget(target: CurrentChangeTargetResult): string {
  const heading = target.name ? `${target.name} (${target.path})` : target.path;
  if (!target.current) {
    if (target.mismatch) {
      return [
        `Current change in ${heading}: mismatch`,
        `Session: ${target.mismatch.session.id}`,
        `Branch: ${target.mismatch.branch.id}`,
        `Resolve with: weave change switch ${target.mismatch.branch.id}`,
      ].join("\n");
    }
    return `Current change in ${heading}: none`;
  }

  return [
    `Current change in ${heading}: ${target.current.id}`,
    `Title: ${target.current.title}`,
    `Type: ${target.current.type}`,
    `Stage: ${target.current.stage}`,
    ...formatStaleLines(target.current.stale),
    ...formatKnowledgeLines(target.current.knowledge),
    `Branch: ${target.current.branch}`,
    `Path: ${target.current.path}`,
    `Source: ${formatCurrentSource(target.source)}`,
  ].join("\n");
}

function formatStatusMessage(targets: StatusChangeTargetResult[], reviewLines: Map<StatusChangeTargetResult, string[]> = new Map()): string {
  if (targets.length === 0) {
    return "No workspace folders found.";
  }

  return targets.map((target) => formatStatusTarget(target, reviewLines.get(target) ?? [])).join("\n\n");
}

function formatStatusTarget(target: StatusChangeTargetResult, reviewLines: string[] = []): string {
  const heading = target.name ? `${target.name} (${target.path})` : target.path;
  if (target.mismatch) {
    return [
      `Status in ${heading}: mismatch`,
      `Session: ${target.mismatch.session.id}`,
      `Branch: ${target.mismatch.branch.id}`,
      `Resolve with: weave change switch ${target.mismatch.branch.id}`,
    ].join("\n");
  }

  if (!target.change) {
    return `Status in ${heading}: no active change`;
  }

  return [
    `Status in ${heading}: ${target.change.id}`,
    `Title: ${target.change.title}`,
    `Type: ${target.change.type}`,
    `Stage: ${target.change.stage}`,
    ...formatStaleLines(target.change.stale),
    ...formatStressTestLines(target.change.stress_tests),
    ...reviewLines,
    ...formatAutoAdvanceLines(target.change.auto_advance),
    ...formatRunLines(target.change.runs),
    ...formatKnowledgeLines(target.change.knowledge),
    `Branch: ${target.change.branch}`,
    `Path: ${target.change.path}`,
    `Active: ${target.active ? "yes" : "no"}`,
    `Branch match: ${target.branchMatch}`,
    `Source: ${formatCurrentSource(target.source)}`,
  ].join("\n");
}

function formatProgressMessage(target: ChangeTarget, change: ChangeSummary, progressed: ChangeStage, note?: string): string {
  const heading = target.name ? `${target.name} (${target.path})` : target.path;
  return [
    `Progressed change in ${heading}: ${change.id}`,
    `Progressed lane: ${progressed}`,
    `Stage: ${change.stage}`,
    ...formatStaleLines(change.stale),
    ...formatKnowledgeLines(change.knowledge),
    ...(note ? [`Note: ${note}`] : []),
    `Path: ${change.path}`,
  ].join("\n");
}

function formatKnowledgeMessage(target: ChangeTarget, change: ChangeSummary): string {
  const heading = target.name ? `${target.name} (${target.path})` : target.path;
  return [
    `Updated knowledge status in ${heading}: ${change.id}`,
    ...formatKnowledgeLines(change.knowledge),
    `Stage: ${change.stage}`,
    `Path: ${change.path}`,
  ].join("\n");
}

function formatStaleLines(stale: StaleChangeLanes): string[] {
  const entries = changeStages
    .filter((stage) => stale[stage])
    .map((stage) => {
      const metadata = stale[stage]!;
      return `${stage} (invalidated by ${metadata.invalidated_by})`;
    });
  return entries.length > 0 ? [`Stale: ${entries.join(", ")}`] : [];
}

function formatStressTestLines(stressTests: StressTestRecords): string[] {
  return stressTestLanes.flatMap((lane) => {
    const record = stressTests[lane];
    return record ? [`Stress test (${lane}): ${record.verdict}${record.outdated ? " (outdated: shape changed since)" : ""}`] : [];
  });
}

function formatAutoAdvanceLines(flags: AutoAdvanceFlags): string[] {
  const enabled = autoAdvanceTransitions.filter((transition) => flags[transition.id]).map((transition) => transition.id);
  return [`Auto-advance: ${enabled.length > 0 ? `${enabled.join(", ")} on` : "off"}`];
}

function formatRunLines(runs: PhaseRun[]): string[] {
  const latest = runs.at(-1);
  if (!latest) {
    return [];
  }
  return [`Last run: ${latest.skill} (${latest.lane}) ${latest.result}, started ${latest.started_at}`];
}

function formatKnowledgeLines(knowledge: KnowledgeMetadata | undefined): string[] {
  if (!knowledge) {
    return [];
  }

  const suffix =
    knowledge.status === "stale" && knowledge.invalidated_by
      ? ` (invalidated by ${knowledge.invalidated_by})`
      : "";
  return [`Knowledge: ${knowledge.status}${suffix}`];
}

function formatCurrentSource(source: CurrentSource | "explicit"): string {
  switch (source) {
    case "branch":
      return "branch";
    case "explicit":
      return "explicit";
    case "none":
      return "none";
  }
}

function formatBranchStatus(status: BranchStatus): string {
  switch (status) {
    case "already_active":
      return "branch already active";
    case "checked_out":
      return "branch checked out";
    case "created":
      return "branch created";
    case "skipped_not_git":
      return "branch skipped: not a git repo";
  }
}

function isChangeType(value: unknown): value is ChangeType {
  return typeof value === "string" && (changeTypes as string[]).includes(value);
}

export function isChangeStage(value: unknown): value is ChangeStage {
  if (typeof value !== "string") {
    return false;
  }
  if ((changeStages as readonly string[]).includes(value)) {
    return true;
  }
  return value in legacyChangeStageAliases;
}

function normalizeChangeStage(value: string): ChangeStage | undefined {
  if ((changeStages as readonly string[]).includes(value)) {
    return value as ChangeStage;
  }
  return legacyChangeStageAliases[value];
}

function normalizeStoredStage(value: unknown): StoredChangeStage {
  if (typeof value === "string" && value === "started") {
    return "started";
  }
  if (typeof value === "string") {
    const normalized = normalizeChangeStage(value);
    if (normalized) {
      return normalized;
    }
  }
  return "exploration";
}

export function isStoredChangeStage(value: unknown): value is StoredChangeStage {
  return typeof value === "string" && (storedStages as readonly string[]).includes(value);
}

export function isArtifactSourceId(value: unknown): value is ArtifactSourceId {
  return typeof value === "string" && (artifactSourceIds as readonly string[]).includes(value);
}

export function isStressTestLane(value: unknown): value is StressTestLane {
  return typeof value === "string" && (stressTestLanes as readonly string[]).includes(value);
}

export function isStressTestVerdict(value: unknown): value is StressTestVerdict {
  return typeof value === "string" && (stressTestVerdicts as readonly string[]).includes(value);
}

export function isRunResult(value: unknown): value is RunResult {
  return typeof value === "string" && (runResults as readonly string[]).includes(value);
}

export function isRunTrigger(value: unknown): value is RunTrigger {
  return typeof value === "string" && (runTriggers as readonly string[]).includes(value);
}

export function isKnowledgeStatus(value: unknown): value is KnowledgeStatus {
  return typeof value === "string" && (knowledgeStatuses as readonly string[]).includes(value);
}

export function isKnowledgeInvalidationSource(value: unknown): value is KnowledgeInvalidationSource {
  return isChangeStage(value) || isArtifactSourceId(value);
}

function normalizeKnowledgeInvalidationSource(value: string): KnowledgeInvalidationSource {
  if (isKnowledgeInvalidationSource(value)) {
    return value;
  }

  const supported = dedupeStrings([...changeStages, ...artifactSourceIds]);
  throw new ChangeCommandError(
    "unsupported_knowledge_invalidation_source",
    `Unsupported knowledge invalidation source: ${value}. Expected ${supported.join(", ")}`,
    { source: value, supported },
  );
}

export function isEvidenceStage(stage: StoredChangeStage): boolean {
  return (evidenceStages as readonly string[]).includes(stage);
}

function maxStage(stages: StoredChangeStage[]): ChangeStage {
  // `started` has index -1 (not a real lane), so any progressed lane wins and the
  // "exploration" seed keeps the result at the highest reached artifact lane.
  const highest = stages.reduce<StoredChangeStage>(
    (acc, stage) => (stageIndex(stage) > stageIndex(acc) ? stage : acc),
    "exploration",
  );
  return isChangeStage(highest) ? highest : "exploration";
}

function stageIndex(stage: StoredChangeStage): number {
  return (changeStages as readonly string[]).indexOf(stage);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export interface LocatedChange {
  id: string;
  title: string;
  stage: StoredChangeStage;
  checkout: CheckoutMode;
  changePath: string;
  // Worktree checkouts: the change folder recorded on this machine, if any.
  folder?: string;
  folderExists: boolean;
  // The main checkout's real path, the key for per-project settings.
  mainRoot: string;
}

// Finds a change and its folder without touching git state: no fetch, no worktree changes.
// Used by `weave change open`.
export async function locateChange(options: { cwd: string; change?: string; sessionPath?: string }): Promise<LocatedChange> {
  const target = await resolveTarget(options.cwd, options.sessionPath);
  const checkout = await workspaceCheckoutMode(target.path);
  let change: ChangeSummary | undefined;
  if (options.change) {
    const changes = await readChangesWithWorktrees(target.path, await branchChangeIdForTarget(target.path));
    try {
      change = resolveChangeReference(changes, options.change);
    } catch (error) {
      // A change folder recorded on this machine but deleted: say so, and how to get it back.
      if (error instanceof ChangeCommandError && error.code === "change_not_found" && checkout === "worktree") {
        // Same matching as change references: full id, token, or slug fragment.
        const ref = options.change.trim().toLowerCase();
        const mainRoot = await mainCheckoutPath(target.path);
        const ids = await listLocalChangeIds(await localStateDir(mainRoot));
        const matches = ids.filter((id) => id === ref || id.split("-")[1] === ref || id.split("-").slice(2).join("-").includes(ref));
        const id = matches.length === 1 ? matches[0]! : undefined;
        const recorded = id ? (await readLocalChangeInfo(target.path, id))?.folder : undefined;
        if (id && (!recorded || !(await pathExists(recorded)))) {
          throw new ChangeCommandError("folder_missing", `The folder for ${id} isn't on this machine. Run \`weave change switch ${id}\` to recreate it.`, { id });
        }
      }
      throw error;
    }
  } else {
    change = (await currentContextForTarget(target)).current;
    if (!change) {
      throw new ChangeCommandError("no_active_change", "No active change. Pass a change, or run `weave change switch <change>` first.");
    }
  }
  const folder = change.folder ?? (checkout === "worktree" ? (await readLocalChangeInfo(target.path, change.id))?.folder : undefined);
  return {
    id: change.id,
    title: change.title,
    stage: change.stage,
    checkout,
    changePath: change.changePath,
    ...(folder ? { folder } : {}),
    folderExists: folder ? await pathExists(folder) : false,
    mainRoot: await mainCheckoutPath(target.path),
  };
}

// Commits what a status write recorded (decision 261111-htho). Never throws; the outcome goes into
// the command result.
export async function recordPlanningCheckpoint(
  context: ActiveChangeContext,
  moment: PlanningMoment,
  options: CheckpointMessageOptions,
): Promise<CheckpointOutcome> {
  return planningCheckpoint({
    weaveRoot: context.target.path,
    changeId: context.change.id,
    changePath: context.change.changePath,
    branch: context.change.branch,
    title: context.change.title,
    moment,
    ...(options.summary ? { summary: options.summary } : {}),
    ...(options.commitMessage ? { message: options.commitMessage } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
}

export function withCheckpointLine(message: string, checkpoint: CheckpointOutcome | undefined): string {
  const line = renderCheckpointLine(checkpoint);
  return line ? `${message}\n${line}` : message;
}

export interface SkipCommitsResult {
  status: "ok";
  change: string;
  skipped?: { reason: string; at: string };
  message: string;
}

// `weave change skip-commits --reason` / `unskip-commits`: the per-change switch
// (`commits.skipped` in the change's status.yml; decision 261111-htho).
export async function setChangeCommitsSkipped(options: {
  cwd: string;
  skip: boolean;
  reason?: string;
  now?: Date;
  sessionPath?: string;
}): Promise<SkipCommitsResult> {
  const context = await activeChangeContext(options);
  const statusPath = path.join(context.change.changePath, "status.yml");
  const raw = await readStatusFile(statusPath);
  const commits = isRecord(raw.commits) ? { ...raw.commits } : {};
  if (options.skip) {
    const reason = options.reason?.trim();
    if (!reason) throw new ChangeCommandError("missing_reason", "Pass --reason saying why this change skips checkpoint commits.");
    const skipped = { reason, at: (options.now ?? new Date()).toISOString() };
    await writeFile(statusPath, YAML.stringify({ ...raw, commits: { ...commits, skipped } }));
    return { status: "ok", change: context.change.id, skipped, message: `Checkpoint commits skipped for ${context.change.id} (${reason}).` };
  }
  delete (commits as Record<string, unknown>).skipped;
  const next: Record<string, unknown> = { ...raw };
  if (Object.keys(commits).length > 0) next.commits = commits;
  else delete next.commits;
  await writeFile(statusPath, YAML.stringify(next));
  return { status: "ok", change: context.change.id, message: `Checkpoint commits resume for ${context.change.id}.` };
}

// A phase whose planning commit failed keeps that on its run, so the next person sees it.
async function recordRunCheckpointFailure(statusPath: string, runIds: string[], checkpoint: CheckpointOutcome): Promise<void> {
  try {
    const raw = await readStatusFile(statusPath);
    if (!Array.isArray(raw.runs)) return;
    const runs = raw.runs.map((run: unknown) =>
      isRecord(run) && typeof run.id === "string" && runIds.includes(run.id)
        ? { ...run, checkpoint: { status: checkpoint.status, reason: checkpoint.reason, ...(checkpoint.detail ? { detail: checkpoint.detail } : {}) } }
        : run,
    );
    await writeFile(statusPath, YAML.stringify({ ...raw, runs }));
  } catch {
    // Best-effort.
  }
}
