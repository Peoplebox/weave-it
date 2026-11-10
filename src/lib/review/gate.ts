// The final-review gate (architecture § Final review; PRD FR6): the final review may start only once
// every slice is reviewed and none is out of date. Read-only, apart from first-contact adoption, so
// slices that were finished before the change adopted review pass as `predates_review`.
import { pathExists } from "../files.js";
import { evaluateOutOfDate } from "./fingerprint.js";
import { effectiveState, isReadyForReview, type EffectiveSliceState, type OutOfDateReason } from "./rules.js";
import {
  adoptChange,
  inactiveReviewCause,
  listSlices,
  readSliceReview,
  readSliceTaskStatuses,
  reviewActivation,
  type InactiveReviewCause,
  type ReviewContext,
} from "./state.js";

// Effective states that pass the gate. `skipped` passes only when the change itself is skipped.
export const gatePassingStates: readonly EffectiveSliceState[] = ["reviewed", "reviewed_with_rulings", "predates_review"];

export interface GateBlockingSlice {
  slice: string;
  // The slice's effective state, `out_of_date` when its review no longer describes it.
  effective_state: EffectiveSliceState | "out_of_date";
  // Why it blocks: the out-of-date reasons (`code_changed`, `plan_changed`, `tasks_added`), or the
  // state itself (`not_reviewed`, `in_review`, `waiting_on_person`, ...).
  reasons: Array<OutOfDateReason | EffectiveSliceState | "skipped_while_change_reviewed">;
}

export interface GateResult {
  status: "ok";
  pass: boolean;
  // Present only when review is inactive for the change: the gate then passes with nothing
  // blocking, and dependency readiness falls back to rollup's `done`.
  reason?: "inactive";
  // Why review is inactive (`change_skipped`, `workspace_off`, `skill_not_installed`); null while active.
  inactive_cause: InactiveReviewCause | null;
  blocking: GateBlockingSlice[];
  // True in flat mode: there are no slices, so nothing blocks.
  flat: boolean;
  change_skipped: boolean;
  // `repo_missing:<repo>` and similar, from the out-of-date checks.
  warnings: string[];
}

export interface GateOptions {
  now?: Date;
  // Evaluate the slices even while review is inactive. An explicit on-demand final review
  // (`package --change --force` with the workspace switch off) uses this, so unreviewed slices
  // still make its run partial.
  evaluateWhenInactive?: boolean;
}

export async function evaluateGate(ctx: ReviewContext, options: GateOptions = {}): Promise<GateResult> {
  const activation = await reviewActivation(ctx);
  const cause = inactiveReviewCause(activation) ?? null;
  const slices = await listSlices(ctx);
  if (cause && !options.evaluateWhenInactive) {
    return { status: "ok", pass: true, reason: "inactive", inactive_cause: cause, blocking: [], flat: slices.length === 0, change_skipped: activation.skipped, warnings: [] };
  }
  await adoptChange(ctx, { activation, ...(options.now ? { now: options.now } : {}) });
  const blocking: GateBlockingSlice[] = [];
  const warnings: string[] = [];

  for (const slice of slices) {
    const statuses = await readSliceTaskStatuses(slice);
    const stored = (await pathExists(slice.statusPath)) ? await readSliceReview(slice.statusPath) : undefined;
    const evaluation = await evaluateOutOfDate(ctx, slice, { block: stored ?? null });
    for (const warning of evaluation.warnings) if (!warnings.includes(warning)) warnings.push(warning);
    const effective = effectiveState(stored, { readyForReview: isReadyForReview(statuses), outOfDateReasons: evaluation.reasons });

    if (effective.outOfDate) {
      blocking.push({ slice: slice.id, effective_state: "out_of_date", reasons: effective.reasons });
    } else if (effective.state === "skipped") {
      if (!activation.skipped) blocking.push({ slice: slice.id, effective_state: "skipped", reasons: ["skipped_while_change_reviewed"] });
    } else if (!gatePassingStates.includes(effective.state)) {
      blocking.push({ slice: slice.id, effective_state: effective.state, reasons: effective.reasons.length > 0 ? effective.reasons : [effective.state] });
    }
  }

  return { status: "ok", pass: blocking.length === 0, inactive_cause: cause, blocking, flat: slices.length === 0, change_skipped: activation.skipped, warnings };
}

// One line per blocking slice: `02-work: waiting on person`, `03-api: reviewed, out of date (code changed)`.
export function describeBlocking(slice: GateBlockingSlice): string {
  const words = (value: string): string => value.replace(/_/g, " ");
  if (slice.effective_state === "out_of_date") {
    return `${slice.slice}: out of date (${slice.reasons.map(words).join(", ")})`;
  }
  if (slice.effective_state === "skipped") {
    return `${slice.slice}: skipped, but the change is not`;
  }
  const extra = slice.reasons.filter((reason) => reason !== slice.effective_state);
  return `${slice.slice}: ${words(slice.effective_state)}${extra.length > 0 ? ` (${extra.map(words).join(", ")})` : ""}`;
}
