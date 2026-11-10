// `weave review status [--slice <id> | --change] [--json]`: review activation and per-slice and
// change review state. Its only write is first-contact adoption (`adoptChange`).
import type { Command } from "commander";
import { ChangeCommandError } from "../../lib/changes.js";
import {
  adoptChange,
  inactiveReviewCause,
  listSlices,
  readSliceReview,
  resolveSlice,
  reviewActivation,
  type SliceLocation,
  type InactiveReviewCause,
  type ReviewActivation,
  type ReviewContext,
} from "../../lib/review/state.js";
import { repairSliceReviews, type RepairedSlice } from "../../lib/review/record.js";
import {
  changeReviewStatus,
  sliceReviewStatus,
  type ChangeReviewStatus,
  type SliceReviewStatus,
} from "../../lib/review/summary.js";
import { boundaryKindOf, type BoundaryKind } from "../../lib/review/commit-boundary.js";
import { sliceRunEndRef } from "../../lib/review/package.js";
import { activeReviewContext, runAction, stateLabel, writeResult } from "./shared.js";
import { sliceRepoCheckouts } from "./snapshot.js";

export type { ChangeReviewStatus, ReportedSliceState, SliceReviewStatus } from "../../lib/review/summary.js";

interface ReviewStatusOptions {
  slice?: string;
  change?: boolean;
  repair?: boolean;
  json?: boolean;
}

type ActivationFields = Pick<ReviewActivation, "active" | "skill_paths" | "settings"> & {
  enabled: boolean;
  installed: boolean;
  // Why review is inactive (`change_skipped`, `workspace_off`, `skill_not_installed`); null while active.
  inactive_cause: InactiveReviewCause | null;
  // Present with --repair: the slices whose `review:` block was rebuilt from review/*.findings.json.
  repaired?: RepairedSlice[];
};

export type ReviewStatusResult =
  | ({ status: "ok"; scope: "slice" } & ActivationFields & SliceReviewStatus)
  | ({ status: "ok"; scope: "change" } & ActivationFields & ChangeReviewStatus)
  | ({ status: "ok"; scope: "all" } & ActivationFields & { change: ChangeReviewStatus; slices: SliceReviewStatus[] });

export function registerReviewStatus(review: Command): void {
  review
    .command("status")
    .description("Show whether review is active and each slice's review state.")
    .option("--slice <id>", "one slice, by folder name or leading number")
    .option("--change", "the change-level review only")
    .option("--repair", "rebuild slice review blocks from review/*.findings.json")
    .option("--json", "print machine-readable JSON")
    .action(async (options: ReviewStatusOptions) => {
      const json = options.json ?? false;
      await runAction(json, async () => {
        const result = await reviewStatus(await activeReviewContext(), options);
        writeResult(result, json, renderReviewStatus(result));
      });
    });
}

export async function reviewStatus(ctx: ReviewContext, options: { slice?: string; change?: boolean; repair?: boolean }): Promise<ReviewStatusResult> {
  if (options.slice !== undefined && options.change) {
    throw new ChangeCommandError("invalid_arguments", "Pass either --slice <id> or --change, not both.");
  }
  // Resolve the slice before writing anything, so a bad id fails without side effects.
  const selected = options.slice !== undefined ? await resolveSlice(ctx, options.slice) : undefined;
  // Repair runs before adoption, so a slice whose block an older CLI dropped is not stamped
  // `predates_review` instead of getting its recorded state back.
  const repaired = options.repair ? await repairSliceReviews(ctx, selected ? { slice: selected } : {}) : undefined;

  const activation = await reviewActivation(ctx);
  await adoptChange(ctx, { activation });
  const fields: ActivationFields = {
    active: activation.active,
    enabled: activation.enabled,
    installed: activation.installed,
    inactive_cause: inactiveReviewCause(activation) ?? null,
    skill_paths: activation.skill_paths,
    settings: activation.settings,
    ...(repaired ? { repaired } : {}),
  };

  if (selected) {
    const sliceStatus = await sliceReviewStatus(ctx, selected, activation);
    const boundary = await latestEndBoundary(ctx, selected);
    return { status: "ok", scope: "slice", ...fields, ...sliceStatus, ...(boundary ? { boundary } : {}) };
  }
  const change = await changeReviewStatus(ctx, activation);
  if (options.change) {
    return { status: "ok", scope: "change", ...fields, ...change };
  }
  const slices: SliceReviewStatus[] = [];
  for (const slice of await listSlices(ctx)) {
    slices.push(await sliceReviewStatus(ctx, slice, activation));
  }
  return { status: "ok", scope: "all", ...fields, change, slices };
}

function sliceLine(slice: SliceReviewStatus): string {
  const reasons = slice.out_of_date_reasons.map(stateLabel).join(", ");
  if (slice.out_of_date) {
    return `${slice.slice}: ${stateLabel(slice.stored_state ?? "reviewed")}, out of date (${reasons})`;
  }
  if (slice.effective_state === null) {
    return `${slice.slice}: no review state (review inactive)`;
  }
  return `${slice.slice}: ${stateLabel(slice.effective_state)}${reasons ? ` (${reasons})` : ""}`;
}

function changeLine(change: ChangeReviewStatus): string {
  const parked = change.effective_state === "ready_with_parked_items" ? ` (${change.counts.parked_items})` : "";
  const stale = change.out_of_date ? `, verdict out of date (${change.out_of_date_reasons.map(stateLabel).join(", ")})` : "";
  return `change: ${change.effective_state === null ? "no review state (review inactive)" : stateLabel(change.effective_state)}${parked}${stale}`;
}

export function renderReviewStatus(result: ReviewStatusResult): string {
  const lines = [`active: ${result.active ? "yes" : `no (${inactiveCauseLabel(result.inactive_cause)})`}`];
  for (const repaired of result.repaired ?? []) {
    const recomputed = repaired.recomputed.length > 0 ? `; recomputed ${repaired.recomputed.join(", ")} from the current tree` : "";
    lines.push(`repaired ${repaired.slice}: ${stateLabel(repaired.state)} from ${repaired.run}${repaired.written ? "" : " (already up to date)"}${recomputed}`);
  }
  if (result.scope === "slice") {
    lines.push(sliceLine(result));
  } else if (result.scope === "change") {
    lines.push(changeLine(result));
  } else {
    lines.push(changeLine(result.change));
    lines.push(...result.slices.map(sliceLine));
  }
  return lines.join("\n");
}

export function inactiveCauseLabel(cause: InactiveReviewCause | null): string {
  switch (cause) {
    case "change_skipped":
      return "review skipped for this change";
    case "workspace_off":
      return "review is off for this workspace";
    case "skill_not_installed":
      return "the weave-review skill is not installed";
    default:
      return "inactive";
  }
}

// Which kind of end boundary the slice's latest run measured to, per repo (decision 261111-kx9x).
async function latestEndBoundary(ctx: ReviewContext, slice: SliceLocation): Promise<Record<string, { kind: BoundaryKind }> | undefined> {
  const review = await readSliceReview(slice.statusPath);
  const run = typeof review?.latest_run === "string" ? review.latest_run : undefined;
  if (!run) return undefined;
  const report: Record<string, { kind: BoundaryKind }> = {};
  for (const repo of await sliceRepoCheckouts(ctx, slice)) {
    if (!repo.path) continue;
    const kind = await boundaryKindOf(repo.path, sliceRunEndRef(ctx.changeId, slice.id, run));
    if (kind) report[repo.id] = { kind };
  }
  return Object.keys(report).length > 0 ? report : undefined;
}
