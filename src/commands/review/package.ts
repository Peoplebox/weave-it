// `weave review package --slice <id> [--partial] [--force] [--out <path>] [--json]`: allocates the
// run, takes the end snapshot, writes the review package, and marks the slice `in_review`.
// `--change` does the same for the whole change (run `change/f<N>`, the final review): it needs the
// final-review gate to pass, or `--partial`.
// `--run <run> --fix-round <n>` ends a fix round: round end snapshot, saved round patch, and the
// fix checker's package. `--run <run>` alone returns the round a resumable run continues at.
import type { Command } from "commander";
import { ChangeCommandError } from "../../lib/changes.js";
import { buildChangePackage, buildSlicePackage, type ChangePackageResult, type PackageResult } from "../../lib/review/package.js";
import { buildFixRoundPackage, resumeRun, type FixRoundPackageResult, type ResumeRunResult } from "../../lib/review/rounds.js";
import { activeReviewContext, runAction, writeResult } from "./shared.js";

interface ReviewPackageOptions {
  slice?: string;
  change?: boolean;
  run?: string;
  fixRound?: string;
  partial?: boolean;
  force?: boolean;
  out?: string;
  json?: boolean;
}

export function registerReviewPackage(review: Command): void {
  review
    .command("package")
    .description("Write a review package for a slice or the whole change: the diff plus the context a reviewer needs.")
    .option("--slice <id>", "the slice, by folder name or leading number")
    .option("--change", "the whole change, for the final review (needs the gate to pass, or --partial)")
    .option("--run <run>", "an existing run, such as 02/r1: with --fix-round, end that fix round; alone, resume a run paused on a dismissed plan problem")
    .option("--fix-round <n>", "with --run: snapshot the round end, save the round patch, and write the fix checker's package")
    .option("--partial", "package a slice whose tasks are not all done or not_tested, or the change while the gate fails")
    .option("--force", "package even when review is switched off for the workspace")
    .option("--out <path>", "write the package here instead of .weave/tmp/reviews/")
    .option("--json", "print machine-readable JSON")
    .action(async (options: ReviewPackageOptions) => {
      const json = options.json ?? false;
      await runAction(json, async () => {
        if (options.run !== undefined || options.fixRound !== undefined) {
          if (options.slice !== undefined || options.change || options.run === undefined) {
            throw new ChangeCommandError("invalid_arguments", "Pass one of --slice <id>, --change, or --run <run> [--fix-round <n>].");
          }
          const ctx = await activeReviewContext();
          if (options.fixRound === undefined) {
            const result = await resumeRun(ctx, options.run);
            writeResult(result, json, renderResume(result));
            return;
          }
          const result = await buildFixRoundPackage(ctx, options.run, options.fixRound, options.out ? { out: options.out } : {});
          writeResult(result, json, renderFixRoundPackageResult(result));
          return;
        }
        if (options.change) {
          if (options.slice !== undefined) {
            throw new ChangeCommandError("invalid_arguments", "Pass either --slice <id> or --change, not both.");
          }
          const result = await buildChangePackage(await activeReviewContext(), {
            ...(options.partial ? { partial: true } : {}),
            ...(options.force ? { force: true } : {}),
            ...(options.out ? { out: options.out } : {}),
          });
          writeResult(result, json, renderChangePackageResult(result));
          return;
        }
        if (options.slice === undefined) {
          throw new ChangeCommandError("invalid_arguments", "Pass --slice <id>, --change, or --run <run> [--fix-round <n>].");
        }
        const result = await buildSlicePackage(await activeReviewContext(), options.slice, {
          ...(options.partial ? { partial: true } : {}),
          ...(options.force ? { force: true } : {}),
          ...(options.out ? { out: options.out } : {}),
        });
        writeResult(result, json, renderReviewPackage(result));
      });
    });
}

export function renderReviewPackage(result: PackageResult): string {
  const lines = [
    `${result.run_id}: ${result.package_path}`,
    `  ${result.size_hint.files} files, ${result.size_hint.lines} changed lines, ${result.foreign_files} possibly another slice's; model level ${result.model_level}`,
  ];
  if (result.fallback_base) lines.push(`  fallback base: ${result.fallback_base.replace(/_/g, " ")}`);
  if (result.partial) lines.push(`  partial: ${result.partial_reasons.join("; ")}`);
  if (result.warnings.length > 0) lines.push(`  warnings: ${result.warnings.join(", ")}`);
  return lines.join("\n");
}

export function renderChangePackageResult(result: ChangePackageResult): string {
  const lines = [
    `${result.run_id}: ${result.package_path}`,
    `  ${result.size_hint.files} files (${result.plan_and_docs_files} plan and docs edits), ${result.size_hint.lines} changed lines; ${result.saved_minors} saved Minors to sort; model level ${result.model_level}`,
  ];
  if (result.partial) lines.push(`  partial: ${result.partial_reasons.join("; ")}`);
  if (result.warnings.length > 0) lines.push(`  warnings: ${result.warnings.join(", ")}`);
  return lines.join("\n");
}

export function renderFixRoundPackageResult(result: FixRoundPackageResult): string {
  const lines = [
    `${result.run_id} round ${result.round}: ${result.package_path}`,
    `  ${result.size_hint.files} files, ${result.size_hint.lines} changed lines; ${result.targets.length} findings to check; model level ${result.model_level}`,
    `  patch: ${result.patch_path}`,
    `  undo from the Weave root: ${result.undo}`,
  ];
  if (result.warnings.length > 0) lines.push(`  warnings: ${result.warnings.join(", ")}`);
  return lines.join("\n");
}

function renderResume(result: ResumeRunResult): string {
  return `${result.run_id}: resume at fix round ${result.resume_round} (${result.open.length} open code findings)`;
}
