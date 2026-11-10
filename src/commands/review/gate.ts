// `weave review gate --change [--json]`: whether the final review may start. Exit 0 whether or not
// it passes; `pass` carries the answer and `blocking` lists each slice in the way, with its reason.
import type { Command } from "commander";
import { ChangeCommandError } from "../../lib/changes.js";
import { describeBlocking, evaluateGate, type GateResult } from "../../lib/review/gate.js";
import { activeReviewContext, runAction, writeResult } from "./shared.js";
import { inactiveCauseLabel } from "./status.js";

export function registerReviewGate(review: Command): void {
  review
    .command("gate")
    .description("Say whether the final review of the change may start, and which slices block it.")
    .option("--change", "the change's final-review gate")
    .option("--json", "print machine-readable JSON")
    .action(async (options: { change?: boolean; json?: boolean }) => {
      const json = options.json ?? false;
      await runAction(json, async () => {
        if (!options.change) {
          throw new ChangeCommandError("invalid_arguments", "Pass --change: the gate is the change's final-review gate.");
        }
        const result = await evaluateGate(await activeReviewContext());
        writeResult(result, json, renderGate(result));
      });
    });
}

export function renderGate(result: GateResult): string {
  if (result.pass && result.reason === "inactive") {
    return `gate: pass (${inactiveCauseLabel(result.inactive_cause)}, so nothing waits for review)`;
  }
  if (result.pass) {
    return result.flat ? "gate: pass (flat change: no slices to wait for)" : "gate: pass (every slice is reviewed and current)";
  }
  return ["gate: blocked", ...result.blocking.map((slice) => `  ${describeBlocking(slice)}`)].join("\n");
}
