// Read-side review views shared by `weave review status`, `weave change status`, and `weave status`.
// Out of date and the inactive overlays are derived here, at read time, and never written.
// While review is inactive, slices read `skipped` (change skipped or workspace off) or carry no
// derived state at all (skill not installed), so inactive review never shows as `not_reviewed`.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../files.js";
import { parseSliceTasksMarkdown } from "../sliceRollup.js";
import { evaluateChangeOutOfDate, evaluateOutOfDate } from "./fingerprint.js";
import {
  effectiveState,
  isReadyForReview,
  type ChangeReviewState,
  type ChangeVerdict,
  type EffectiveSliceState,
  type OutOfDateReason,
  type StoredSliceState,
} from "./rules.js";
import {
  inactiveReviewCause,
  listSlices,
  readChangeReview,
  readSliceReview,
  readSliceTaskStatuses,
  reviewActivation,
  skippedOverlayApplies,
  type ChangeReviewBlock,
  type ChangeReviewCounts,
  type InactiveReviewCause,
  type ReviewActivation,
  type ReviewContext,
  type SliceLocation,
  type SliceReviewBlock,
  type SliceReviewCounts,
} from "./state.js";

// A slice's state as status reports it: `out_of_date` when the stored `reviewed` or
// `reviewed_with_rulings` review no longer describes the slice (`stored_state` keeps which), and
// null when review is inactive only because the skill is not installed and nothing is stored.
export type ReportedSliceState = EffectiveSliceState | "out_of_date" | null;

export interface SliceReviewStatus {
  slice: string;
  stored_state: StoredSliceState | null;
  effective_state: ReportedSliceState;
  out_of_date: boolean;
  out_of_date_reasons: OutOfDateReason[];
  ready_for_review: boolean;
  counts: SliceReviewCounts;
  review: SliceReviewBlock | null;
  // `repo_missing:<repo>` when a fingerprinted repo is not checked out here.
  warnings: string[];
}

export interface ChangeReviewStatus {
  change: string;
  stored_state: ChangeReviewState | null;
  // `skipped` for a per-change skip; null while review is inactive for another reason and the
  // change stores no state.
  effective_state: ChangeReviewState | null;
  out_of_date: boolean;
  out_of_date_reasons: OutOfDateReason[];
  ready_for_review: boolean;
  adopted_at: string | null;
  skipped: boolean;
  counts: ChangeReviewCounts;
  review: ChangeReviewBlock | null;
  // `repo_missing:<repo>` when a fingerprinted repo is not checked out here.
  warnings: string[];
}

export interface SliceStatusOptions {
  // Read-only callers that do not adopt the change: a ready slice with no block reads as
  // `predates_review`, which is what adoption would stamp on it.
  projectAdoption?: boolean;
}

export async function sliceReviewStatus(
  ctx: ReviewContext,
  slice: SliceLocation,
  activation: ReviewActivation,
  options: SliceStatusOptions & { adopted?: boolean } = {},
): Promise<SliceReviewStatus> {
  const statuses = await readSliceTaskStatuses(slice);
  const ready = isReadyForReview(statuses);
  const stored = (await pathExists(slice.statusPath)) ? await readSliceReview(slice.statusPath) : undefined;
  const cause = inactiveReviewCause(activation);
  const counts: SliceReviewCounts = {
    open_rulings: 0,
    parked_minors: 0,
    human_checks: 0,
    untested_tasks: statuses.filter((status) => status === "not_tested").length,
    ...numericCounts(stored?.counts),
  };
  const base = { slice: slice.id, stored_state: stored?.state ?? null, ready_for_review: ready, counts, review: stored ?? null };

  if (skippedOverlayApplies(cause)) {
    return { ...base, effective_state: "skipped", out_of_date: false, out_of_date_reasons: [], warnings: [] };
  }

  const evaluation = await evaluateOutOfDate(ctx, slice, { block: stored ?? null });
  let effective = effectiveState(stored, { readyForReview: ready, outOfDateReasons: evaluation.reasons });
  if (options.projectAdoption && activation.active && !options.adopted && stored === undefined && ready) {
    effective = { state: "predates_review", outOfDate: false, reasons: [] };
  }
  const derivedOnly = !stored?.state && (effective.state === "not_reviewed" || effective.state === "not_ready_for_review");
  const reported: ReportedSliceState =
    cause === "skill_not_installed" && derivedOnly ? null : effective.outOfDate ? "out_of_date" : effective.state;
  return {
    ...base,
    effective_state: reported,
    out_of_date: effective.outOfDate,
    out_of_date_reasons: reported === null ? [] : effective.reasons,
    warnings: evaluation.warnings,
  };
}

// The change review. A verdict whose covered code, plan, or tasks changed since the final review is
// "verdict out of date": `out_of_date` with its reasons. The stored verdict stays in
// `effective_state`, so reverting the edit makes it current again.
export async function changeReviewStatus(ctx: ReviewContext, activation: ReviewActivation): Promise<ChangeReviewStatus> {
  const stored = await readChangeReview(ctx.changePath);
  const cause = inactiveReviewCause(activation);
  const evaluation =
    cause === "change_skipped" ? { reasons: [] as OutOfDateReason[], warnings: [] as string[] } : await evaluateChangeOutOfDate(ctx, { block: stored ?? null });
  const effective: ChangeReviewState | null =
    cause === "change_skipped" ? "skipped" : (stored?.state ?? (cause ? null : "not_started"));
  return {
    change: ctx.changeId,
    stored_state: stored?.state ?? null,
    effective_state: effective,
    out_of_date: evaluation.reasons.length > 0,
    out_of_date_reasons: evaluation.reasons,
    ready_for_review: await changeReadyForReview(ctx),
    adopted_at: typeof stored?.adopted_at === "string" ? stored.adopted_at : null,
    skipped: activation.skipped,
    counts: { open_rulings: 0, parked_items: 0, plan_problems_open: 0, ...numericCounts(stored?.counts) },
    review: stored ?? null,
    warnings: evaluation.warnings,
  };
}

// Every slice is ready for review (slice mode), or every task in the change's `tasks.md` (flat mode).
export async function changeReadyForReview(ctx: ReviewContext): Promise<boolean> {
  const slices = await listSlices(ctx);
  if (slices.length > 0) {
    for (const slice of slices) {
      if (!isReadyForReview(await readSliceTaskStatuses(slice))) {
        return false;
      }
    }
    return true;
  }
  const flatTasks = path.join(ctx.changePath, "tasks.md");
  if (!(await pathExists(flatTasks))) {
    return false;
  }
  return isReadyForReview(parseSliceTasksMarkdown(await readFile(flatTasks, "utf8")).statuses);
}

// --- the summary `weave change status` and `weave status` show --------------------------------

export interface ChangeStatusReviewSlice {
  id: string;
  stored_state: StoredSliceState | null;
  effective_state: ReportedSliceState;
  out_of_date_reasons: OutOfDateReason[];
  counts: SliceReviewCounts;
}

export interface ChangeStatusReviewFinal {
  state: ChangeReviewState | null;
  verdict: ChangeVerdict | null;
  out_of_date: boolean;
  out_of_date_reasons: OutOfDateReason[];
  counts: ChangeReviewCounts;
  latest_run: string | null;
  partial: boolean;
}

export interface ChangeStatusReview {
  active: boolean;
  inactive_cause: InactiveReviewCause | null;
  skipped: { reason: string; at: string } | null;
  slices: ChangeStatusReviewSlice[];
  final: ChangeStatusReviewFinal;
}

export interface UnreadableChangeReview {
  unreadable: true;
  error: string;
}

export type ChangeStatusReviewView = ChangeStatusReview | UnreadableChangeReview;

const verdicts: readonly ChangeReviewState[] = ["ready_to_merge", "ready_with_parked_items", "not_ready"];

// The review summary for a change, read-only (it never adopts or writes). Undefined when there is
// nothing to show: review is inactive and neither the change nor any slice stores a review state or
// a skip. That keeps status output unchanged for projects that never installed the review skill.
// A failure to read review data gives `{unreadable: true}` instead of an error.
export async function changeStatusReview(ctx: ReviewContext): Promise<ChangeStatusReviewView | undefined> {
  try {
    if (!(await pathExists(ctx.changePath))) {
      return undefined;
    }
    const activation = await reviewActivation(ctx);
    const cause = inactiveReviewCause(activation);
    const changeBlock = await readChangeReview(ctx.changePath);
    const sliceLocations = await listSlices(ctx);
    const sliceBlocks = await Promise.all(
      sliceLocations.map(async (slice) => ((await pathExists(slice.statusPath)) ? readSliceReview(slice.statusPath) : undefined)),
    );
    const hasData = Boolean(changeBlock?.state) || activation.skipped || sliceBlocks.some((block) => Boolean(block?.state));
    if (!activation.active && !hasData) {
      return undefined;
    }

    const adopted = typeof changeBlock?.adopted_at === "string";
    const slices: ChangeStatusReviewSlice[] = [];
    for (const location of sliceLocations) {
      const status = await sliceReviewStatus(ctx, location, activation, { projectAdoption: true, adopted });
      slices.push({
        id: status.slice,
        stored_state: status.stored_state,
        effective_state: status.effective_state,
        out_of_date_reasons: status.out_of_date_reasons,
        counts: status.counts,
      });
    }
    const change = await changeReviewStatus(ctx, activation);
    const skipped = changeBlock?.skipped;
    return {
      active: activation.active,
      inactive_cause: cause ?? null,
      skipped:
        activation.skipped && skipped && typeof skipped === "object"
          ? { reason: String(skipped.reason ?? ""), at: String(skipped.at ?? "") }
          : null,
      slices,
      final: {
        state: change.effective_state,
        verdict: change.effective_state && verdicts.includes(change.effective_state) ? (change.effective_state as ChangeVerdict) : null,
        out_of_date: change.out_of_date,
        out_of_date_reasons: change.out_of_date_reasons,
        counts: change.counts,
        latest_run: typeof changeBlock?.latest_run === "string" ? changeBlock.latest_run : null,
        partial: changeBlock?.partial === true,
      },
    };
  } catch (error) {
    return { unreadable: true, error: error instanceof Error ? error.message : String(error) };
  }
}

export function isUnreadableReview(view: ChangeStatusReviewView): view is UnreadableChangeReview {
  return "unreadable" in view && view.unreadable === true;
}

const words = (value: string): string => value.replace(/_/g, " ");

// `02-snapshot-boundaries` -> `slice 02`; an id without a leading number is shown whole.
function sliceName(id: string): string {
  const match = /^(\d+)-/.exec(id);
  return `slice ${match ? match[1] : id}`;
}

function rulingsSuffix(count: number): string {
  return count === 1 ? "1 ruling" : `${count} rulings`;
}

// PRD wording for one slice, or undefined when it carries no review state.
export function sliceReviewPhrase(slice: ChangeStatusReviewSlice): string | undefined {
  const reasons = slice.out_of_date_reasons.map(words).join(", ");
  switch (slice.effective_state) {
    case null:
      return undefined;
    case "out_of_date":
      return `reviewed, out of date (${reasons})`;
    case "not_reviewed":
      return `tasks done, not reviewed${reasons ? ` (${reasons})` : ""}`;
    case "not_ready_for_review":
      return "tasks open";
    case "reviewed_with_rulings":
      return slice.counts.open_rulings > 0 ? `reviewed (${rulingsSuffix(slice.counts.open_rulings)})` : "reviewed with rulings";
    case "waiting_on_person":
      return "waiting on you: plan problem";
    case "skipped":
      return "review skipped";
    default:
      return words(slice.effective_state);
  }
}

function finalPhrase(final: ChangeStatusReviewFinal): string {
  if (final.verdict) return "done";
  return final.state ? words(final.state) : "not started";
}

// `ready with parked items (4)`, `ready to merge`, `not ready: waiting on you`, `not ready: partial review`.
export function verdictPhrase(final: ChangeStatusReviewFinal): string | undefined {
  if (!final.verdict) return undefined;
  let text: string;
  if (final.verdict === "ready_with_parked_items") {
    text = `ready with parked items (${final.counts.parked_items})`;
  } else if (final.verdict === "not_ready") {
    const why = final.counts.plan_problems_open > 0 ? "waiting on you" : final.partial ? "partial review" : "open findings";
    text = `not ready: ${why}`;
  } else {
    text = "ready to merge";
  }
  if (final.out_of_date) {
    text += `, out of date${final.out_of_date_reasons.length > 0 ? ` (${final.out_of_date_reasons.map(words).join(", ")})` : ""}`;
  }
  if (final.counts.open_rulings > 0) {
    text += ` · ${rulingsSuffix(final.counts.open_rulings)}`;
  }
  return text;
}

function skippedPhrase(view: ChangeStatusReview): string | undefined {
  if (view.inactive_cause === "change_skipped") return `skipped (${view.skipped?.reason || "no reason recorded"})`;
  if (view.inactive_cause === "workspace_off") return "skipped (review is off for this workspace)";
  return undefined;
}

// The `weave change status` lines: `Review: ...` and, after the final review, `Verdict: ...`.
export function renderChangeReviewLines(view: ChangeStatusReviewView | undefined): string[] {
  if (!view) return [];
  if (isUnreadableReview(view)) return ["Review: unreadable"];
  const skipped = skippedPhrase(view);
  if (skipped) return [`Review: ${skipped}`];
  const parts = view.slices.flatMap((slice) => {
    const phrase = sliceReviewPhrase(slice);
    return phrase ? [`${sliceName(slice.id)} ${phrase}`] : [];
  });
  if (view.final.state !== null || view.active) parts.push(`final: ${finalPhrase(view.final)}`);
  const lines = parts.length > 0 ? [`Review: ${parts.join(" · ")}`] : [];
  const verdict = verdictPhrase(view.final);
  if (verdict) lines.push(`Verdict: ${verdict}`);
  return lines;
}

// One short line for `weave status`: the verdict once there is one, otherwise slice counts by state
// and the final review state.
export function shortChangeReviewLine(view: ChangeStatusReviewView): string {
  if (isUnreadableReview(view)) return "unreadable";
  const skipped = skippedPhrase(view);
  if (skipped) return skipped;
  const verdict = verdictPhrase(view.final);
  if (verdict) return `verdict: ${verdict}`;
  const tally = new Map<string, number>();
  for (const slice of view.slices) {
    const phrase = slice.effective_state === "out_of_date" ? "out of date" : sliceReviewPhrase({ ...slice, counts: { ...slice.counts, open_rulings: 0 } });
    if (phrase) tally.set(phrase, (tally.get(phrase) ?? 0) + 1);
  }
  const parts = [...tally].map(([phrase, count]) => `${count} ${phrase}`);
  parts.push(`final: ${finalPhrase(view.final)}`);
  return parts.join(" · ");
}

function numericCounts(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
}
