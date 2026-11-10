import { Command } from "commander";
import { registerReviewGate } from "./review/gate.js";
import { registerReviewGuidelines } from "./review/guidelines.js";
import { registerReviewPackage } from "./review/package.js";
import { registerReviewPrune } from "./review/prune.js";
import { registerReviewRecord } from "./review/record.js";
import { registerReviewSkip } from "./review/skip.js";
import { registerReviewSnapshot } from "./review/snapshot.js";
import { registerReviewStatus } from "./review/status.js";

// `weave review`: the mechanical steps of code review. Each subcommand lives in its own module
// under `./review/` and registers itself here.
export function reviewCommand(): Command {
  const command = new Command("review").description("Code review mechanics for the active change.");

  registerReviewStatus(command);
  registerReviewGuidelines(command);
  registerReviewSnapshot(command);
  registerReviewPackage(command);
  registerReviewPrune(command);
  registerReviewRecord(command);
  registerReviewGate(command);
  registerReviewSkip(command);

  return command;
}
