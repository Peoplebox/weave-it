// Review state stored in the `review:` blocks of slice and change `status.yml` files.
// Only `weave review` subcommands write these blocks, under the per-change lock, after re-reading
// the file, touching only the `review` key, and writing atomically. Rollup only carries them.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { loadAgentsManifest } from "../agent-skills.js";
import { ChangeCommandError } from "../change-error.js";
import type { ActiveChangeContext } from "../changes.js";
import { pathExists } from "../files.js";
import { withChangeLock, writeFileAtomic } from "../local-state.js";
import { parseSliceTasksMarkdown, type TaskStatus } from "../sliceRollup.js";
import { defaultReviewSettings, readWorkspaceMetadata, type ReviewModelLevels } from "../workspace-repos.js";
import {
  isChangeReviewState,
  isReadyForReview,
  isStoredSliceState,
  type ChangeReviewState,
  type StoredSliceState,
} from "./rules.js";

export const reviewSkillName = "weave-review";

// Where a change lives: the Weave root (holds `.weave/` and `wiki/`), its id, and its folder.
export interface ReviewContext {
  weaveRoot: string;
  changeId: string;
  changePath: string;
}

export interface SliceReviewCounts {
  open_rulings: number;
  parked_minors: number;
  human_checks: number;
  untested_tasks: number;
}

// Slice `status.yml` `review:` block (architecture/schema.md). Unknown keys are kept.
export interface SliceReviewBlock {
  state?: StoredSliceState;
  start_ref?: string;
  latest_run?: string;
  reviewed_task_total?: number;
  merge_base?: Record<string, string>;
  plan_basis?: Record<string, unknown>;
  fingerprint?: Record<string, Record<string, string>>;
  counts?: Partial<SliceReviewCounts>;
  independent?: boolean;
  partial?: boolean;
  updated_at?: string;
  [key: string]: unknown;
}

export interface ChangeReviewCounts {
  open_rulings: number;
  parked_items: number;
  plan_problems_open: number;
}

// Change `status.yml` `review:` block (architecture/schema.md). Unknown keys are kept.
export interface ChangeReviewBlock {
  state?: ChangeReviewState;
  adopted_at?: string;
  latest_run?: string;
  skipped?: { reason: string; at: string };
  fingerprint?: Record<string, Record<string, string>>;
  counts?: Partial<ChangeReviewCounts>;
  partial?: boolean;
  updated_at?: string;
  [key: string]: unknown;
}

export interface SliceLocation {
  id: string;
  path: string;
  statusPath: string;
  tasksPath: string;
}

export interface ReviewActivation {
  active: boolean;
  enabled: boolean;
  skipped: boolean;
  installed: boolean;
  skill_paths: string[];
  settings: { slice_rounds: number; models: Record<string, ReviewModelLevels> };
}

export interface AdoptChangeResult {
  adopted: boolean;
  reason?: "inactive" | "already_adopted" | "no_change_status";
  adopted_at?: string;
  stamped: string[];
}

type Mutator<T> = (current: T | undefined) => T | undefined | Promise<T | undefined>;

export function reviewContextFromActive(active: ActiveChangeContext): ReviewContext {
  return { weaveRoot: active.target.path, changeId: active.change.id, changePath: active.change.changePath };
}

// Derives the context from a change folder laid out as `<root>/wiki/changes/<id>`.
// Undefined for any other layout, such as a bare folder in a test.
export function reviewContextForChangePath(changePath: string): ReviewContext | undefined {
  const resolved = path.resolve(changePath);
  const changesDir = path.dirname(resolved);
  const wikiDir = path.dirname(changesDir);
  if (path.basename(changesDir) !== "changes" || path.basename(wikiDir) !== "wiki") {
    return undefined;
  }
  return { weaveRoot: path.dirname(wikiDir), changeId: path.basename(resolved), changePath: resolved };
}

// --- reading ---------------------------------------------------------------------------------

// The slice review block, or undefined when it is absent or malformed (not a mapping, or a
// `state` that is not a known stored state). Malformed blocks read as absent for derivation.
export async function readSliceReview(statusPath: string): Promise<SliceReviewBlock | undefined> {
  return sanitizeSliceReview((await readYamlRecord(statusPath))?.review);
}

export async function readChangeReview(changePath: string): Promise<ChangeReviewBlock | undefined> {
  return sanitizeChangeReview((await readYamlRecord(path.join(changePath, "status.yml")))?.review);
}

export function sanitizeSliceReview(value: unknown): SliceReviewBlock | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  if (value.state !== undefined && !isStoredSliceState(value.state)) {
    return undefined;
  }
  return value as SliceReviewBlock;
}

export function sanitizeChangeReview(value: unknown): ChangeReviewBlock | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  if (value.state !== undefined && !isChangeReviewState(value.state)) {
    return undefined;
  }
  return value as ChangeReviewBlock;
}

// Every slice folder of the change (a folder under `task-slices/` holding `status.yml` or
// `tasks.md`), sorted by id. Empty when the change has no `task-slices/` folder.
export async function listSlices(ctx: ReviewContext): Promise<SliceLocation[]> {
  const root = path.join(ctx.changePath, "task-slices");
  if (!(await pathExists(root))) {
    return [];
  }
  const slices: SliceLocation[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const location = sliceLocation(ctx, entry.name);
    if ((await pathExists(location.statusPath)) || (await pathExists(location.tasksPath))) {
      slices.push(location);
    }
  }
  return slices.sort((left, right) => left.id.localeCompare(right.id));
}

// Resolves a slice by its folder name, or by a unique leading number such as `02`.
export async function resolveSlice(ctx: ReviewContext, selector: string): Promise<SliceLocation> {
  if (!(await pathExists(path.join(ctx.changePath, "task-slices")))) {
    throw new ChangeCommandError("no_slices", `No task-slices/ folder found under ${ctx.changePath}`, {
      changePath: ctx.changePath,
    });
  }
  const slices = await listSlices(ctx);
  if (slices.length === 0) {
    throw new ChangeCommandError("no_slices", `No slice folders found under ${path.join(ctx.changePath, "task-slices")}`, {
      changePath: ctx.changePath,
    });
  }
  const wanted = path.basename(selector.trim());
  const exact = slices.find((slice) => slice.id === wanted);
  if (exact) {
    return exact;
  }
  const prefixed = slices.filter((slice) => slice.id.startsWith(`${wanted}-`));
  if (prefixed.length === 1) {
    return prefixed[0];
  }
  throw new ChangeCommandError("slice_not_found", `No matching slice folder: ${selector}`, {
    slicePath: selector,
    available: slices.map((slice) => slice.id),
  });
}

// Active task statuses from the slice's `tasks.md`; empty when it is missing or unparsed.
export async function readSliceTaskStatuses(slice: SliceLocation): Promise<TaskStatus[]> {
  if (!(await pathExists(slice.tasksPath))) {
    return [];
  }
  return parseSliceTasksMarkdown(await readFile(slice.tasksPath, "utf8")).statuses;
}

// The change folder seen as the location of change runs (`change/f<N>`): run files go under
// `<change>/review/`, the readable record is `<change>/review.md`, and the flat-mode tasks file is
// `<change>/tasks.md`. Its id is `_change`, the folder name change runs use for refs and packages.
export function changeRunLocation(ctx: ReviewContext): SliceLocation {
  return {
    id: "_change",
    path: ctx.changePath,
    statusPath: path.join(ctx.changePath, "status.yml"),
    tasksPath: path.join(ctx.changePath, "tasks.md"),
  };
}

// Every repo the change touches: `root`, the repos its checkout records, every slice's `repos:`,
// and, in flat mode, the `Repos:` of the change's tasks. `root` comes first; the rest are sorted.
export async function changeRepoIds(ctx: ReviewContext): Promise<string[]> {
  const ids = new Set<string>();
  const status = await readYamlRecord(path.join(ctx.changePath, "status.yml"));
  const checkout = isPlainRecord(status?.checkout) && isPlainRecord(status.checkout.repos) ? status.checkout.repos : {};
  for (const id of Object.keys(checkout)) ids.add(id);
  const slices = await listSlices(ctx);
  for (const slice of slices) {
    const sliceStatus = await readYamlRecord(slice.statusPath);
    for (const id of Array.isArray(sliceStatus?.repos) ? sliceStatus.repos : []) {
      if (typeof id === "string" && id.trim() !== "") ids.add(id.trim());
    }
  }
  if (slices.length === 0) {
    const flat = path.join(ctx.changePath, "tasks.md");
    if (await pathExists(flat)) {
      for (const match of (await readFile(flat, "utf8")).matchAll(/^Repos:\s*(.*)$/gm)) {
        for (const id of (match[1] ?? "").split(/[\s,]+/)) {
          if (id && id.toLowerCase() !== "none") ids.add(id);
        }
      }
    }
  }
  ids.delete("root");
  return ["root", ...[...ids].sort()];
}

// --- writing ---------------------------------------------------------------------------------

// Updates one slice's `review:` block under the per-change lock. `mutate` receives the current
// block (undefined when absent or malformed) and returns the next one, or undefined to remove it.
// Every other key in the file is left as it was. `updated_at` is stamped on every real change.
export async function updateSliceReview(
  ctx: ReviewContext,
  sliceId: string,
  mutate: Mutator<SliceReviewBlock>,
  options: { now?: Date } = {},
): Promise<SliceReviewBlock | undefined> {
  const location = sliceLocation(ctx, sliceId);
  if (!(await pathExists(location.statusPath))) {
    throw new ChangeCommandError("slice_not_found", `No status.yml for slice ${sliceId}`, { slicePath: location.path });
  }
  return withChangeLock(ctx.changePath, ctx.changeId, () =>
    mutateReviewKey(location.statusPath, sanitizeSliceReview, mutate, options.now ?? new Date()),
  );
}

// Like `updateSliceReview`, for a caller that already holds the change lock (inside another
// `updateSliceReview` or `updateChangeReview` mutate, which are not re-entrant). A missing
// `status.yml` is skipped.
export async function updateSliceReviewLocked(
  ctx: ReviewContext,
  sliceId: string,
  mutate: Mutator<SliceReviewBlock>,
  options: { now?: Date } = {},
): Promise<SliceReviewBlock | undefined> {
  const location = sliceLocation(ctx, sliceId);
  if (!(await pathExists(location.statusPath))) {
    return undefined;
  }
  return mutateReviewKey(location.statusPath, sanitizeSliceReview, mutate, options.now ?? new Date());
}

// Updates the change `review:` block under the per-change lock, like `updateSliceReview`.
export async function updateChangeReview(
  ctx: ReviewContext,
  mutate: Mutator<ChangeReviewBlock>,
  options: { now?: Date } = {},
): Promise<ChangeReviewBlock | undefined> {
  const statusPath = path.join(ctx.changePath, "status.yml");
  if (!(await pathExists(statusPath))) {
    throw new ChangeCommandError("change_status_missing", `No status.yml for change ${ctx.changeId}`, { changePath: ctx.changePath });
  }
  return withChangeLock(ctx.changePath, ctx.changeId, () =>
    mutateReviewKey(statusPath, sanitizeChangeReview, mutate, options.now ?? new Date()),
  );
}

// --- activation and adoption -----------------------------------------------------------------

// Review is active when the workspace has not switched it off, the change is not skipped, and at
// least one agent has the review skill installed.
export async function reviewActivation(ctx: ReviewContext): Promise<ReviewActivation> {
  const settings = (await readWorkspaceMetadata(ctx.weaveRoot))?.review ?? defaultReviewSettings();
  const changeReview = await readChangeReview(ctx.changePath);
  const skipped = isPlainRecord(changeReview?.skipped);
  const skillPaths = await installedReviewSkillPaths(ctx.weaveRoot);
  const installed = skillPaths.length > 0;
  return {
    active: settings.enabled && !skipped && installed,
    enabled: settings.enabled,
    skipped,
    installed,
    skill_paths: skillPaths,
    settings: { slice_rounds: settings.slice_rounds, models: settings.models },
  };
}

// Why review is inactive, or undefined while it is active. A per-change skip wins over the
// workspace switch, which wins over a missing skill.
export type InactiveReviewCause = "change_skipped" | "workspace_off" | "skill_not_installed";

export function inactiveReviewCause(activation: Pick<ReviewActivation, "active" | "enabled" | "skipped">): InactiveReviewCause | undefined {
  if (activation.active) return undefined;
  if (activation.skipped) return "change_skipped";
  if (!activation.enabled) return "workspace_off";
  return "skill_not_installed";
}

// While the change is skipped or the workspace has review off, every slice reads `skipped`
// instead of `not_reviewed`. A missing skill alone overlays nothing: slices carry no derived
// review state at all. The overlay is applied at read time and never written, so `unskip` or
// switching review back on restores the stored states.
export function skippedOverlayApplies(cause: InactiveReviewCause | undefined): boolean {
  return cause === "change_skipped" || cause === "workspace_off";
}

// `weave review skip --reason`: records `review.skipped: {reason, at}` on the change. Skipping an
// already-skipped change with the same reason keeps the original time.
export async function skipChangeReview(
  ctx: ReviewContext,
  reason: string | undefined,
  options: { now?: Date } = {},
): Promise<{ reason: string; at: string }> {
  const trimmed = reason?.trim() ?? "";
  if (!trimmed) {
    throw new ChangeCommandError("missing_reason", "Skipping review needs --reason explaining why.");
  }
  const now = options.now ?? new Date();
  const block = await updateChangeReview(
    ctx,
    (current) => {
      const existing = isPlainRecord(current?.skipped) && current.skipped.reason === trimmed ? current.skipped : undefined;
      return { ...(current ?? {}), skipped: existing ?? { reason: trimmed, at: now.toISOString() } };
    },
    { now },
  );
  return block!.skipped!;
}

// `weave review unskip`: removes `review.skipped`. A change that is not skipped is left as it is.
// When nothing else is left in the block, the block itself is removed.
export async function unskipChangeReview(ctx: ReviewContext, options: { now?: Date } = {}): Promise<{ changed: boolean }> {
  if (!isPlainRecord((await readChangeReview(ctx.changePath))?.skipped)) {
    return { changed: false };
  }
  await updateChangeReview(
    ctx,
    (current) => {
      if (!current) return current;
      const { skipped: _skipped, updated_at: _updated, ...rest } = current;
      return Object.keys(rest).length > 0 ? rest : undefined;
    },
    options,
  );
  return { changed: true };
}

// First contact with a change while review is active: stamps `review.adopted_at` on the change,
// and `state: predates_review` on every slice that is already ready for review and has no
// `review` block. Runs once; later calls write nothing. While review is inactive it writes
// nothing, so a project that upgrades Weave before installing the review skill is adopted only
// once the skill is installed.
export async function adoptChange(
  ctx: ReviewContext,
  options: { now?: Date; activation?: ReviewActivation } = {},
): Promise<AdoptChangeResult> {
  const activation = options.activation ?? (await reviewActivation(ctx));
  if (!activation.active) {
    return { adopted: false, reason: "inactive", stamped: [] };
  }
  const changeStatusPath = path.join(ctx.changePath, "status.yml");
  if (!(await pathExists(changeStatusPath))) {
    return { adopted: false, reason: "no_change_status", stamped: [] };
  }
  const existing = await readChangeReview(ctx.changePath);
  if (typeof existing?.adopted_at === "string") {
    return { adopted: false, reason: "already_adopted", adopted_at: existing.adopted_at, stamped: [] };
  }

  const now = options.now ?? new Date();
  return withChangeLock(ctx.changePath, ctx.changeId, async () => {
    // Re-read under the lock: another command may have adopted the change meanwhile.
    const current = await readChangeReview(ctx.changePath);
    if (typeof current?.adopted_at === "string") {
      return { adopted: false, reason: "already_adopted" as const, adopted_at: current.adopted_at, stamped: [] };
    }
    const stamped: string[] = [];
    for (const slice of await listSlices(ctx)) {
      if (!(await pathExists(slice.statusPath))) {
        continue;
      }
      const raw = await readYamlRecord(slice.statusPath);
      if (!raw || "review" in raw) {
        continue;
      }
      if (!isReadyForReview(await readSliceTaskStatuses(slice))) {
        continue;
      }
      await mutateReviewKey(slice.statusPath, sanitizeSliceReview, (): SliceReviewBlock => ({ state: "predates_review" }), now);
      stamped.push(slice.id);
    }
    const adoptedAt = now.toISOString();
    await mutateReviewKey(changeStatusPath, sanitizeChangeReview, (block) => ({ ...(block ?? {}), adopted_at: adoptedAt }), now);
    return { adopted: true, adopted_at: adoptedAt, stamped };
  });
}

// --- internals -------------------------------------------------------------------------------

function sliceLocation(ctx: ReviewContext, sliceId: string): SliceLocation {
  const slicePath = path.join(ctx.changePath, "task-slices", sliceId);
  return {
    id: sliceId,
    path: slicePath,
    statusPath: path.join(slicePath, "status.yml"),
    tasksPath: path.join(slicePath, "tasks.md"),
  };
}

async function installedReviewSkillPaths(weaveRoot: string): Promise<string[]> {
  try {
    const manifest = await loadAgentsManifest(weaveRoot);
    const paths: string[] = [];
    for (const buckets of Object.values(manifest.installed)) {
      const entry = buckets?.skills?.[reviewSkillName];
      if (entry) {
        paths.push(path.resolve(weaveRoot, entry.path || path.join(reviewSkillName, "SKILL.md")));
      }
    }
    return [...new Set(paths)];
  } catch {
    return [];
  }
}

// Caller must hold the change lock. Re-reads the file, replaces only the `review` key, and writes
// atomically. Comments and formatting elsewhere in the file are kept. No write when nothing changes.
async function mutateReviewKey<T extends { updated_at?: string }>(
  file: string,
  sanitize: (value: unknown) => T | undefined,
  mutate: Mutator<T>,
  now: Date,
): Promise<T | undefined> {
  const text = await readFile(file, "utf8");
  const doc = YAML.parseDocument(text);
  if (doc.errors.length > 0) {
    throw new ChangeCommandError("invalid_status_yml", `Cannot update ${file}: it is not valid YAML.`, {
      file,
      error: doc.errors[0]?.message,
    });
  }
  const raw = doc.toJS() as unknown;
  if (raw !== null && raw !== undefined && !isPlainRecord(raw)) {
    throw new ChangeCommandError("invalid_status_yml", `Cannot update ${file}: it is not a YAML mapping.`, { file });
  }
  const hadKey = isPlainRecord(raw) && "review" in raw;
  const current = sanitize(isPlainRecord(raw) ? raw.review : undefined);
  const next = await mutate(current === undefined ? undefined : structuredClone(current));

  if (next === undefined) {
    if (!hadKey) {
      return undefined;
    }
    doc.delete("review");
  } else {
    if (current !== undefined && sameContent(withoutUpdatedAt(current), withoutUpdatedAt(next))) {
      return current;
    }
    const stamped = { ...withoutUpdatedAt(next), updated_at: now.toISOString() } as T;
    doc.set("review", stamped);
    await writeFileAtomic(file, String(doc));
    return stamped;
  }
  await writeFileAtomic(file, String(doc));
  return undefined;
}

async function readYamlRecord(file: string): Promise<Record<string, unknown> | undefined> {
  if (!(await pathExists(file))) {
    return undefined;
  }
  try {
    const parsed = YAML.parse(await readFile(file, "utf8")) as unknown;
    return isPlainRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function withoutUpdatedAt<T extends { updated_at?: string }>(block: T): Omit<T, "updated_at"> {
  const { updated_at: _ignored, ...rest } = block;
  return rest;
}

function sameContent(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
