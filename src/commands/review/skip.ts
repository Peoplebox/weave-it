// `weave review skip --reason <text>` and `weave review unskip`: record or clear a per-change skip
// (`review.skipped: {reason, at}` on the change `status.yml`). While skipped, review is inactive:
// every slice reads `skipped` and the gate passes.
import type { Command } from "commander";
import { skipChangeReview, unskipChangeReview } from "../../lib/review/state.js";
import { activeReviewContext, runAction, writeResult } from "./shared.js";

export function registerReviewSkip(review: Command): void {
  review
    .command("skip")
    .description("Skip code review for the active change, recording why.")
    .option("--reason <text>", "why review is skipped, for example \"docs only\"")
    .option("--json", "print machine-readable JSON")
    .action(async (options: { reason?: string; json?: boolean }) => {
      const json = options.json ?? false;
      await runAction(json, async () => {
        const ctx = await activeReviewContext();
        const skipped = await skipChangeReview(ctx, options.reason);
        writeResult({ status: "ok", change: ctx.changeId, skipped }, json, `Review skipped for ${ctx.changeId} (${skipped.reason}).`);
      });
    });

  review
    .command("unskip")
    .description("Clear a recorded review skip for the active change.")
    .option("--json", "print machine-readable JSON")
    .action(async (options: { json?: boolean }) => {
      const json = options.json ?? false;
      await runAction(json, async () => {
        const ctx = await activeReviewContext();
        const { changed } = await unskipChangeReview(ctx);
        writeResult(
          { status: "ok", change: ctx.changeId, skipped: null, changed },
          json,
          changed ? `Review is no longer skipped for ${ctx.changeId}.` : `Review was not skipped for ${ctx.changeId}; nothing to clear.`,
        );
      });
    });
}
