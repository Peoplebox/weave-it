// `weave review record --run <run> (--report - | --resolve <finding> --as <as> [...] | --finalize |
// --failed) [--independent false] [--json]`: records a reviewer report, a resolution, or the end of
// a slice review run. Exit 4 means the report was invalid (nothing written); exit 5 means a plan
// finding needs a person.
import type { Command } from "commander";
import { ChangeCommandError } from "../../lib/changes.js";
import {
  failRun,
  finalizeRun,
  recordExitCodes,
  recordReport,
  recordResolution,
  type FailRunResult,
  type ChangeFinalizeResult,
  type FinalizeResult,
  type RecordFixCheckResult,
  type RecordReportResult,
  type RecordResolutionResult,
} from "../../lib/review/record.js";
import { activeReviewContext, runAction, stateLabel, writeResult } from "./shared.js";

interface ReviewRecordOptions {
  run?: string;
  report?: string;
  resolve?: string;
  as?: string;
  agreed?: string;
  reason?: string;
  cost?: string;
  by?: string;
  round?: string;
  finalize?: boolean;
  failed?: boolean;
  independent?: string;
  json?: boolean;
}

export type ReviewRecordResult = RecordReportResult | RecordFixCheckResult | RecordResolutionResult | FinalizeResult | ChangeFinalizeResult | FailRunResult;

// Where `--report -` reads from. Tests replace `read`.
export const reportInput = {
  read: readStdin,
};

export function registerReviewRecord(review: Command): void {
  review
    .command("record")
    .description("Record a reviewer report, a finding's resolution, or the end of a review run.")
    .option("--run <run>", "the run, such as 02/r1 or change/f1")
    .option("--report <source>", "read the reviewer's or fix checker's response from stdin (-)")
    .option("--resolve <finding>", "the finding to resolve, such as 02/r1-F3")
    .option("--as <resolution>", "fixed (with --round), ruling, parked (Minors only), or dismissed (a person; the only way to resolve a plan finding)")
    .option("--agreed <bool>", "ruling: true when the finding is real but cannot be fixed here, false when you disagree")
    .option("--reason <text>", "ruling: the reasoning")
    .option("--cost <text>", "ruling: the cost if the ruling is wrong")
    .option("--by <person>", "dismissed: the person dismissing the finding")
    .option("--round <n>", "fixed: the fix round")
    .option("--finalize", "end the run as reviewed or reviewed with rulings")
    .option("--failed", "end the run as review failed after a second invalid report")
    .option("--independent <bool>", "false when the review ran inline instead of in a separate reviewer")
    .option("--json", "print machine-readable JSON")
    .action(async (options: ReviewRecordOptions) => {
      const json = options.json ?? false;
      let failure: string | undefined;
      await runAction(json, async () => {
        try {
          const result = await reviewRecord(options);
          writeResult(result, json, renderReviewRecordResult(result));
        } catch (error) {
          if (error instanceof ChangeCommandError) failure = error.code;
          throw error;
        }
      });
      const exitCode = failure === undefined ? undefined : recordExitCodes[failure];
      if (exitCode !== undefined) {
        process.exitCode = exitCode;
      }
    });
}

export async function reviewRecord(options: ReviewRecordOptions): Promise<ReviewRecordResult> {
  if (!options.run) {
    throw new ChangeCommandError("invalid_arguments", "Pass --run <slice>/r<N> or change/f<N>, such as 02/r1.");
  }
  const actions = [options.report !== undefined, options.resolve !== undefined, options.finalize === true, options.failed === true].filter(Boolean).length;
  if (actions !== 1) {
    throw new ChangeCommandError("invalid_arguments", "Pass exactly one of --report -, --resolve <finding> --as <resolution>, --finalize, or --failed.");
  }
  let independent: boolean | undefined;
  if (options.independent !== undefined) {
    const value = options.independent.trim().toLowerCase();
    if (value !== "true" && value !== "false") {
      throw new ChangeCommandError("invalid_arguments", `--independent takes true or false, not ${options.independent}.`);
    }
    independent = value === "true";
  }
  const recordOptions = independent === false ? { independent } : {};
  const ctx = await activeReviewContext();

  if (options.report !== undefined) {
    if (options.report !== "-") {
      throw new ChangeCommandError("invalid_arguments", "--report reads the reviewer response from stdin: pass --report - and pipe the response in.");
    }
    return recordReport(ctx, options.run, await reportInput.read(), recordOptions);
  }
  if (options.resolve !== undefined) {
    if (!options.as) {
      throw new ChangeCommandError("invalid_resolution", "Pass --as fixed, ruling, parked, or dismissed.");
    }
    return recordResolution(
      ctx,
      options.run,
      {
        finding: options.resolve,
        as: options.as,
        ...(options.agreed !== undefined ? { agreed: options.agreed } : {}),
        ...(options.reason !== undefined ? { reason: options.reason } : {}),
        ...(options.cost !== undefined ? { cost: options.cost } : {}),
        ...(options.by !== undefined ? { by: options.by } : {}),
        ...(options.round !== undefined ? { round: options.round } : {}),
      },
      recordOptions,
    );
  }
  if (options.finalize) {
    return finalizeRun(ctx, options.run, recordOptions);
  }
  return failRun(ctx, options.run, recordOptions);
}

export function renderReviewRecordResult(result: ReviewRecordResult): string {
  if ("check_path" in result) {
    const lines = [
      `${result.run} round ${result.round}: ${result.addressed.length} addressed, ${result.not_addressed.length} not addressed, ${result.new_findings.length} new findings; ${scopeWord(result.run)} ${stateLabel(result.state)}`,
    ];
    if (result.not_addressed.length > 0) lines.push(`  still open: ${result.not_addressed.join(", ")}`);
    if (result.new_findings.length > 0) lines.push(`  new: ${result.new_findings.join(", ")}`);
    if (result.plan_findings_open.length > 0) lines.push(`  plan problems waiting on a person: ${result.plan_findings_open.join(", ")}`);
    lines.push(`  record: ${result.review_path}`);
    return lines.join("\n");
  }
  if ("report_path" in result) {
    const lines = [`${result.run}: ${result.findings} findings (${result.new_findings} new); ${scopeWord(result.run)} ${stateLabel(result.state)}`];
    if (result.plan_findings_open.length > 0) lines.push(`  plan problems waiting on a person: ${result.plan_findings_open.join(", ")}`);
    lines.push(`  record: ${result.review_path}`);
    return lines.join("\n");
  }
  if ("resolution" in result) {
    const fix = result.resolution.as === "fixed" ? ` in round ${result.resolution.round}${result.resolution.needs_your_check ? " (needs your check)" : ""}` : "";
    return `${result.finding}: ${result.resolution.as}${fix}; ${scopeWord(result.run)} ${stateLabel(result.state)}`;
  }
  if ("verdict" in result) {
    const counts = result.counts;
    const parked = result.verdict === "ready_with_parked_items" ? ` (${counts.parked_items})` : "";
    const lines = [`${result.run}: verdict ${stateLabel(result.verdict)}${parked}; ${counts.open_rulings} rulings, ${counts.plan_problems_open} plan problems open${result.partial ? "; partial" : ""}`];
    if (result.released_from.length > 0) lines.push(`  took over files from: ${result.released_from.join(", ")}`);
    if (result.warnings.length > 0) lines.push(`  warnings: ${result.warnings.join(", ")}`);
    return lines.join("\n");
  }
  if ("fingerprint_files" in result) {
    const counts = result.counts;
    return `${result.run}: ${stateLabel(result.state)} (${counts.open_rulings} rulings, ${counts.parked_minors} parked Minors, ${result.fingerprint_files} files fingerprinted)`;
  }
  return `${result.run}: ${stateLabel(result.state)}`;
}

// "change" for a change run (`change/f1`), "slice" otherwise.
function scopeWord(run: string): string {
  return run.startsWith("change/") ? "change" : "slice";
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new ChangeCommandError("invalid_arguments", "--report - reads the reviewer response from stdin; pipe it in.");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}
