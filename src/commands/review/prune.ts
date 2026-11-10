// `weave review prune [--change <id>] [--json]`: deletes review snapshot refs and local review
// packages for changes that have fully landed or no longer exist (decision 261110-wdfo). It
// works from any checkout of the workspace and needs no active change.
import type { Command } from "commander";
import { ChangeCommandError } from "../../lib/changes.js";
import { pruneReviews, type PruneResult } from "../../lib/review/prune.js";
import { findWorkspaceMode } from "../../lib/workspace-mode.js";
import { runAction, writeResult } from "./shared.js";

interface ReviewPruneOptions {
  change?: string;
  json?: boolean;
}

export function registerReviewPrune(review: Command): void {
  review
    .command("prune")
    .description("Delete review snapshot refs and packages for changes that have landed or no longer exist.")
    .option("--change <id>", "only consider this change")
    .option("--json", "print machine-readable JSON")
    .action(async (options: ReviewPruneOptions) => {
      const json = options.json ?? false;
      await runAction(json, async () => {
        const result = await reviewPrune({ cwd: process.cwd(), change: options.change });
        writeResult(result, json, renderReviewPrune(result));
      });
    });
}

export async function reviewPrune(options: { cwd: string; change?: string }): Promise<PruneResult> {
  const workspace = await findWorkspaceMode(options.cwd);
  if (!workspace) {
    throw new ChangeCommandError("no_weave_context", "No Weave context found. Run `weave init` first.");
  }
  return pruneReviews(workspace.workspacePath, options.change ? { change: options.change } : {});
}

export function renderReviewPrune(result: PruneResult): string {
  const count = result.pruned.length;
  const lines = [count === 0 ? "Nothing to prune." : `Pruned review refs for ${count} change${count === 1 ? "" : "s"}.`];
  for (const item of result.pruned) {
    lines.push(`  ${item.change}  ${item.reason === "landed" ? "landed" : "no longer exists"}`);
  }
  for (const item of result.kept.filter((kept) => kept.reason === "error")) {
    lines.push(`  ${item.change}  couldn't delete refs in ${item.repo ?? "a repo"}: ${item.message ?? "unknown error"}`);
  }
  return lines.join("\n");
}
