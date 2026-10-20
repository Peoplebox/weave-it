import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { architectureMarkdownPaths, hasSubstantiveMarkdown, resolveArchitectureArtifact } from "./architecture-artifact.js";
import { artifactFrontmatter } from "./artifact-metadata.js";
import { pathExists } from "./files.js";
import { findGitRoot } from "./git.js";
import { slugify, titleFromSlug } from "./ids.js";
import { defaultSessionPath, type SessionCurrentChange } from "./session-state.js";
import { ensureWeaveScaffold } from "./weave-scaffold.js";
import { resolveChangeContext, type WorkspaceModeKind } from "./workspace-mode.js";

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

export class ChangeCommandError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
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
  knowledge?: KnowledgeMetadata;
  branch: string;
  path: string;
  changePath: string;
  created_at?: string;
  updated_at?: string;
  active: boolean;
}

export interface ChangeTargetSummary {
  id?: string;
  name?: string;
  path: string;
  changes: ChangeSummary[];
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
  now?: Date;
  randomId?: () => string;
  sessionPath?: string;
}

export interface ListChangesOptions {
  cwd: string;
  sessionPath?: string;
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

export interface ProgressChangeOptions {
  cwd: string;
  stage: ChangeStage;
  sources?: readonly string[];
  now?: Date;
  sessionPath?: string;
  noInvalidate?: boolean;
  invalidateOnly?: readonly ChangeStage[];
}

export interface KnowledgeChangeOptions {
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
  const id = await generateChangeId(targets, slug, now, options.randomId ?? randomChangeIdPart);
  const branch = changeBranch(id);

  await assertGitTargets(targets);
  await assertChangeMissing(targets, id);

  const results: ChangeTargetResult[] = [];
  for (const target of targets) {
    const branchStatus = await ensureChangeBranch(target.path, branch);
    await ensureWeaveScaffold({ folder: { path: target.path } });
    const changePath = changeDir(target.path, id);
    await mkdir(changePath, { recursive: false });
    await mkdir(path.join(changePath, "sessions"));
    await writeFile(path.join(changePath, "status.yml"), statusTemplate({ id, slug, title, type, branch, now }));
    // Feature changes scaffold exploration.md and start at `stage: exploration`. Non-feature
    // changes start at `stage: started` with no exploration artifact; their first real artifact
    // is created later by the fitting skill (weave-architect, weave-issues, or weave-prd).
    if (type === "feat") {
      await writeFile(path.join(changePath, "exploration.md"), explorationTemplate(title, title, now));
    }
    results.push({ path: target.path, changePath, branch, branchStatus, current: true });
  }

  return summarizeChangeOperation({ id, slug, title, type, branch, targets: results, verb: "Created" });
}

export async function listChanges(options: ListChangesOptions): Promise<ChangeListResult> {
  const targets = [await resolveTarget(options.cwd, options.sessionPath)];
  const summaries: ChangeTargetSummary[] = [];

  for (const target of targets) {
    const activeId = await branchChangeIdForTarget(target.path);
    const changes = await readChanges(target.path, activeId);
    summaries.push({ id: target.id, name: target.name, path: target.path, changes });
  }

  return {
    status: "ok",
    targets: summaries,
    message: formatListMessage(summaries),
  };
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
      const changes = await readChanges(target.path, await branchChangeIdForTarget(target.path));
      const change = resolveChangeReference(changes, options.change);
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

  return {
    status: "ok",
    targets: results,
    message: formatStatusMessage(results),
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

  await writeFile(statusPath, YAML.stringify(nextStatus));
  const updated = await readChangeMetadata(context.change.changePath, context.change.id);
  const change: ChangeSummary = {
    ...updated,
    path: context.change.path,
    changePath: context.change.changePath,
    active: true,
  };

  return {
    status: "ok",
    target,
    change,
    progressed: options.stage,
    sources: sourceResolution.sources,
    note: sourceResolution.note,
    message: formatProgressMessage(target, change, options.stage, sourceResolution.note),
  };
}

export interface ClearChangeStalenessOptions {
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

  return {
    status: "ok",
    target,
    change,
    cleared: options.lane,
    history_entry: historyEntry,
    message: `Cleared stale flag for ${options.lane} (was invalidated by ${currentStale.invalidated_by}).${historyEntry.reason ? ` Reason: ${historyEntry.reason}` : ""}`,
  };
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

  if (!change.knowledge) {
    throw new ChangeCommandError("invalid_knowledge_status", "Knowledge status could not be recorded");
  }

  return {
    status: "ok",
    target,
    change,
    knowledge: change.knowledge,
    message: formatKnowledgeMessage(target, change),
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
): Promise<string> {
  const date = formatDatePrefix(now);
  for (let index = 0; index < 20; index += 1) {
    const id = `${date}-${randomId()}-${slug}`;
    const exists = await Promise.all(targets.map((target) => pathExists(changeDir(target.path, id))));
    if (!exists.some(Boolean)) {
      return id;
    }
  }

  throw new ChangeCommandError("id_collision", "Could not generate a unique change id");
}

function formatDatePrefix(now: Date): string {
  const year = String(now.getFullYear()).slice(-2);
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function randomChangeIdPart(): string {
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

async function readChangeMetadata(changePath: string, fallbackId: string): Promise<ChangeStatusMetadata> {
  const statusPath = path.join(changePath, "status.yml");
  const parsed = (await pathExists(statusPath)) ? await readStatusFile(statusPath) : {};
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
    return {
      id: target.id,
      name: target.name,
      path: target.path,
      source: "branch",
      resolution: "branch_active",
      saved: false,
      current: { ...inferred, active: true },
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

function statusTemplate(input: { id: string; slug: string; title: string; type: ChangeType; branch: string; now: Date }): string {
  return YAML.stringify({
    version: 1,
    id: input.id,
    slug: input.slug,
    title: input.title,
    type: input.type,
    stage: input.type === "feat" ? "exploration" : "started",
    branch: input.branch,
    created_at: input.now.toISOString(),
    updated_at: input.now.toISOString(),
  });
}

function explorationTemplate(title: string, topic: string, now: Date): string {
  return `${artifactFrontmatter({ artifact: "exploration", now })}# ${titleFromSlug(slugify(title, "change")) || title}

## Topic

${topic}

## Current Understanding

## Open Questions

## Decisions

## Scenarios

## Existing Behavior

## PRD Readiness

Not ready
`;
}

async function ensureChangeBranch(cwd: string, branch: string): Promise<BranchStatus> {
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

  await gitRequired(["checkout", "-b", branch], gitRoot);
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
  targets: ChangeTargetResult[];
  verb: string;
}): ChangeOperationResult {
  const lines = [
    `${input.verb} change: ${input.id}`,
    "",
    `Title: ${input.title}`,
    `Type: ${input.type}`,
    `Branch: ${input.branch}`,
    "",
    "Targets:",
    ...input.targets.map((target) => `  ${target.path} (${formatBranchStatus(target.branchStatus)}, current)`),
  ];

  return {
    status: "ok",
    id: input.id,
    slug: input.slug,
    title: input.title,
    type: input.type,
    branch: input.branch,
    targets: input.targets,
    message: lines.join("\n"),
  };
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
          ...target.changes.map((change) => `${change.active ? "*" : " "} ${change.id}  ${change.type}  ${change.stage}  ${change.title}`),
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

function formatStatusMessage(targets: StatusChangeTargetResult[]): string {
  if (targets.length === 0) {
    return "No workspace folders found.";
  }

  return targets.map(formatStatusTarget).join("\n\n");
}

function formatStatusTarget(target: StatusChangeTargetResult): string {
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
