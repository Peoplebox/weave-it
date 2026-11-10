// Review rules shared by every review consumer: rollup, `weave review`, and the gate.
// Pure functions only, with no file or git access, so the rules cannot drift between callers.
import type { SliceStatus, TaskStatus } from "../sliceRollup.js";
import YAML from "yaml";
import { hashDocument } from "../sync.js";

// States a slice `review:` block may store.
export const storedSliceStates = [
  "in_review",
  "reviewed",
  "reviewed_with_rulings",
  "waiting_on_person",
  "skipped",
  "review_failed",
  "predates_review",
] as const;
export type StoredSliceState = (typeof storedSliceStates)[number];

// States that are only ever derived, never stored: `not_reviewed` for a slice that is ready for
// review but has no review yet, and `not_ready_for_review` for a slice whose tasks are still open.
export type DerivedSliceState = "not_reviewed" | "not_ready_for_review";
export type EffectiveSliceState = StoredSliceState | DerivedSliceState;

export type OutOfDateReason = "code_changed" | "plan_changed" | "tasks_added";

export const changeReviewStates = [
  "not_started",
  "in_progress",
  "ready_to_merge",
  "ready_with_parked_items",
  "not_ready",
  "skipped",
] as const;
export type ChangeReviewState = (typeof changeReviewStates)[number];

export type ChangeVerdict = "ready_to_merge" | "ready_with_parked_items" | "not_ready";

// Stored states that let dependent slices start while review is active.
export const dependentSatisfyingStates: readonly StoredSliceState[] = [
  "reviewed",
  "reviewed_with_rulings",
  "skipped",
  "predates_review",
];

// Stored states that can be overlaid with "out of date".
const outOfDateCapableStates: readonly StoredSliceState[] = ["reviewed", "reviewed_with_rulings"];

export function isStoredSliceState(value: unknown): value is StoredSliceState {
  return typeof value === "string" && (storedSliceStates as readonly string[]).includes(value);
}

export function isChangeReviewState(value: unknown): value is ChangeReviewState {
  return typeof value === "string" && (changeReviewStates as readonly string[]).includes(value);
}

// A slice is ready for review when it has at least one active task and every active
// (non-`invalid`) task is `done` or `not_tested`. This is independent of rollup's `done`,
// which needs every task `done`.
export function isReadyForReview(statuses: TaskStatus[]): boolean {
  const active = statuses.filter((status) => status !== "invalid");
  return active.length > 0 && active.every((status) => status === "done" || status === "not_tested");
}

// Whether a slice lets the slices that depend on it start. Uses the stored review state only,
// never the out-of-date overlay, so rollup output stays deterministic.
export function satisfiesDependents(
  slice: { statuses: TaskStatus[]; sliceStatus: SliceStatus; reviewState?: StoredSliceState | null },
  reviewActive: boolean,
): boolean {
  if (!reviewActive) {
    return slice.sliceStatus === "done";
  }
  return (
    isReadyForReview(slice.statuses) &&
    slice.reviewState !== undefined &&
    slice.reviewState !== null &&
    dependentSatisfyingStates.includes(slice.reviewState)
  );
}

export interface EffectiveSliceReview {
  state: EffectiveSliceState;
  outOfDate: boolean;
  reasons: OutOfDateReason[];
}

// The state a reader should show: the stored state, overlaid with out of date when reasons were
// found. A missing block, a block holding only `start_ref`, or a malformed state reads as
// `not_reviewed` once the slice is ready for review. A `waiting_on_person` slice whose plan
// changed reads `not_reviewed` with reason `plan_changed`: the plan change answered its plan
// problem, and the next review is a fresh run.
export function effectiveState(
  stored: { state?: unknown } | null | undefined,
  ctx: { readyForReview: boolean; outOfDateReasons: OutOfDateReason[] },
): EffectiveSliceReview {
  const storedState = stored && isStoredSliceState(stored.state) ? stored.state : undefined;
  if (!storedState) {
    return { state: ctx.readyForReview ? "not_reviewed" : "not_ready_for_review", outOfDate: false, reasons: [] };
  }
  if (storedState === "waiting_on_person" && ctx.outOfDateReasons.includes("plan_changed")) {
    return { state: "not_reviewed", outOfDate: false, reasons: ["plan_changed"] };
  }
  const outOfDate = ctx.outOfDateReasons.length > 0 && outOfDateCapableStates.includes(storedState);
  return { state: storedState, outOfDate, reasons: outOfDate ? [...new Set(ctx.outOfDateReasons)] : [] };
}

export interface VerdictInputs {
  planProblemsOpen: number;
  partial: boolean;
  agreedCriticalRulings: number;
  canWaitMinors: number;
  disagreedRulings: number;
  humanChecks: number;
  otherOpen: number;
}

// The change verdict from what is still open after the final review.
// - not_ready: an open plan problem, a partial review, a Critical ruling the agent agreed was real,
//   or any other finding still open.
// - ready_with_parked_items: only can-wait Minors, rulings with `agreed: false`, or human checks.
// - ready_to_merge: nothing open.
export function deriveVerdict(items: VerdictInputs): ChangeVerdict {
  if (items.planProblemsOpen > 0 || items.partial || items.agreedCriticalRulings > 0 || items.otherOpen > 0) {
    return "not_ready";
  }
  if (items.canWaitMinors > 0 || items.disagreedRulings > 0 || items.humanChecks > 0) {
    return "ready_with_parked_items";
  }
  return "ready_to_merge";
}

// Pathspecs that keep a change's own planning files out of diffs, patches, and fingerprints.
// `weaveRootRelative` is the Weave root relative to the repo root ("" when they are the same).
export function excludedPathspecs(weaveRootRelative: string): string[] {
  const normalized = weaveRootRelative.split("\\").join("/").replace(/^\.\/?/, "").replace(/^\/+|\/+$/g, "");
  const prefix = normalized ? `${normalized}/` : "";
  return [`:(exclude)${prefix}wiki/changes/**`];
}

// Edits a change package lists under "plan and docs edits". They are never fingerprinted for slices.
export const planAndDocsPaths: readonly string[] = ["wiki/knowledge/**", "wiki/decisions/**", ".weave/coding-guidelines.md"];

// Hash of a document's body with its YAML frontmatter stripped, so lifecycle-only frontmatter
// edits (a PRD's `updated_at`, a decision's status) do not count as a change. Decisions use
// `decisionHash`, which also covers `superseded_by`.
export function bodyHash(contents: string): string {
  return hashDocument(stripFrontmatter(contents));
}

export function stripFrontmatter(contents: string): string {
  const match = /^---\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(contents);
  return match ? contents.slice(match[0].length) : contents;
}

// Hash of a decision record for `plan_basis` and ruling bases: the frontmatter-stripped body plus
// its `superseded_by` value. Superseding a decision (`weave adr new --supersedes`) therefore counts
// as a plan change and reopens rulings that cite it, while other lifecycle edits, such as
// `status: proposed` -> `accepted`, do not. A decision that is not superseded hashes exactly like
// `bodyHash`, so hashes stored before this rule stay valid.
export function decisionHash(contents: string): string {
  const supersededBy = frontmatterSupersededBy(contents);
  const body = stripFrontmatter(contents);
  return supersededBy ? hashDocument(`${body}\n\u0000superseded_by: ${supersededBy}\n`) : hashDocument(body);
}

function frontmatterSupersededBy(contents: string): string | undefined {
  const match = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(contents);
  if (!match) return undefined;
  try {
    const parsed = YAML.parse(match[1] ?? "") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const value = (parsed as Record<string, unknown>).superseded_by;
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}
