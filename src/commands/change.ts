import { Command, InvalidArgumentError } from "commander";
import {
  ChangeCommandError,
  changeStages,
  knowledgeStatuses,
  changeTypes,
  type ChangeStage,
  type KnowledgeStatus,
  clearChangeStaleness,
  type ClearChangeStalenessResult,
  createChange,
  currentChange,
  listChanges,
  type ChangeListResult,
  type ChangeOperationResult,
  type ChangeType,
  progressChange,
  type ProgressChangeResult,
  knowledgeChange,
  type KnowledgeChangeResult,
  statusChange,
  switchChange,
  type CurrentChangeResult,
  type StatusChangeResult,
  type SwitchChangeResult,
  isChangeStage,
  isKnowledgeStatus,
  isStressTestLane,
  isStressTestVerdict,
  stressTestLanes,
  stressTestVerdicts,
  type StressTestLane,
  type StressTestVerdict,
  verdictChange,
  type VerdictChangeResult,
  autoAdvanceChange,
  type AutoAdvanceChangeResult,
  type ChangeRunResult,
  finishChangeRun,
  isRunResult,
  isRunTrigger,
  listChangeRuns,
  type ListChangeRunsResult,
  runResults,
  runTriggers,
  type FinishedRunResult,
  type RunTrigger,
  startChangeRun,
  closeChange,
  type CloseChangeResult,
  setupChange,
} from "../lib/changes.js";
import { runLogPath } from "../lib/advance.js";
import { printRunLog } from "../lib/run-log.js";
import { withNotices } from "../lib/with-notices.js";
import type { SetupCommand, SetupResult } from "../lib/worktrees.js";

interface ChangeNewOptions {
  slug?: string;
  type?: ChangeType;
  autoAdvance?: boolean;
  repo?: string[];
  base?: string[];
  fetch?: boolean;
  json?: boolean;
}

interface ChangeSetupOptions {
  approve?: boolean;
  json?: boolean;
}

interface ChangeTargetOptions {
  json?: boolean;
}

interface ChangeStatusOptions {
  json?: boolean;
}

interface ChangeProgressOptions extends ChangeStatusOptions {
  source?: string[];
  // Commander merges the negatable `--no-invalidate` and the value `--invalidate <lanes>`
  // onto this single attribute: `true` by default, `false` for `--no-invalidate`, or the
  // comma-separated lane string for `--invalidate <lanes>`.
  invalidate?: string | boolean;
}

interface ChangeClearStaleOptions extends ChangeStatusOptions {
  reason?: string;
}

interface ChangeKnowledgeOptions extends ChangeStatusOptions {
  domain?: string[];
  shared?: string[];
  file?: string[];
  delta?: string;
  reason?: string;
  invalidatedBy?: string;
}

interface ChangeRunStartOptions extends ChangeStatusOptions {
  skill: string;
  agent: string;
  session?: string;
  trigger?: RunTrigger;
}

interface ChangeRunFinishOptions extends ChangeStatusOptions {
  result: FinishedRunResult;
  session?: string;
}

interface ChangeVerdictOptions extends ChangeStatusOptions {
  reason?: string;
  session?: string;
}

export function changeCommand(): Command {
  const command = new Command("change").description("Create and inspect Weave change artifacts.");

  command
    .command("new")
    .description("Create a change exploration.")
    .argument("<title>", "change title")
    .option("--type <type>", "change type: feat, fix, refactor, docs, test, ci, or chore", parseChangeType, "feat")
    .option("--slug <slug>", "change slug override")
    .option("--no-auto-advance", "start with every auto-advance transition off instead of the type defaults")
    .option("--repo <id>", "worktree checkouts: only create worktrees for this registered repo (repeatable)", collectValues, [])
    .option(
      "--base <ref>",
      "ref the change branch starts from, or <repo>=<ref> for one repo (`root` is the workspace root); repeatable; defaults to the remote default branch",
      collectValues,
      [],
    )
    .option("--no-fetch", "worktree checkouts: do not fetch the base branch first")
    .option("--json", "print machine-readable JSON")
    .action(async (title: string, options: ChangeNewOptions) => {
      const json = options.json ?? false;
      await runAction(json, async () => {
        await withNotices({ commandName: "change-new", json }, async () => {
          const result = await createChange({
            cwd: process.cwd(),
            title,
            type: options.type,
            slug: options.slug,
            autoAdvance: options.autoAdvance,
            repos: options.repo,
            ...parseBases(options.base ?? []),
            fetch: options.fetch,
          });
          return { json: result, text: result.message };
        });
      });
    });

  command
    .command("list")
    .description("List changes.")
    .option("--json", "print machine-readable JSON")
    .action(async (options: ChangeTargetOptions) => {
      await runAction(options.json ?? false, async () => {
        const result = await listChanges({
          cwd: process.cwd(),
        });
        writeResult(result, options.json ?? false);
      });
    });

  command
    .command("current")
    .description("Show the current active change.")
    .option("--json", "print machine-readable JSON")
    .action(async (options: ChangeTargetOptions) => {
      const json = options.json ?? false;
      await runAction(json, async () => {
        await withNotices({ commandName: "change-current", json }, async () => {
          const result = await currentChange({ cwd: process.cwd() });
          return { json: result, text: result.message };
        });
      });
    });

  command
    .command("status")
    .description("Show active change status and branch alignment.")
    .argument("[change]", "change reference to inspect without switching")
    .option("--json", "print machine-readable JSON")
    .action(async (change: string | undefined, options: ChangeStatusOptions) => {
      const json = options.json ?? false;
      await runAction(json, async () => {
        await withNotices({ commandName: "change-status", json }, async () => {
          const result = await statusChange({
            cwd: process.cwd(),
            change,
          });
          return { json: result, text: result.message };
        });
      });
    });

  command
    .command("progress")
    .description("Record lifecycle progress for the active change.")
    .argument("<lane>", "lane: questions, research, exploration, prd, findings, architecture, or slices", parseChangeStage)
    .option("--source <source>", "source dependency: questions, research, exploration, prd, architecture, discussion, sessions, or codebase", collectValues, [])
    .option("--no-invalidate", "suppress all downstream stale propagation")
    .option(
      "--invalidate <lanes>",
      "mark only this comma-separated subset of dependent lanes stale (e.g. issues,prd)",
    )
    .option("--json", "print machine-readable JSON")
    .action(async (stage: ChangeStage, options: ChangeProgressOptions) => {
      await runAction(options.json ?? false, async () => {
        const invalidate = options.invalidate;
        const result = await progressChange({
          cwd: process.cwd(),
          stage,
          sources: options.source,
          noInvalidate: invalidate === false,
          invalidateOnly: typeof invalidate === "string" ? parseInvalidateList(invalidate) : undefined,
        });
        writeResult(result, options.json ?? false);
      });
    });

  command
    .command("clear-stale")
    .description("Explicitly clear a stale lane flag after content-sync verification.")
    .argument("<lane>", "lane: questions, research, exploration, prd, findings, architecture, or slices", parseChangeStage)
    .option("--reason <reason>", "one-sentence verification rationale recorded in stale_history")
    .option("--json", "print machine-readable JSON")
    .action(async (lane: ChangeStage, options: ChangeClearStaleOptions) => {
      await runAction(options.json ?? false, async () => {
        const result = await clearChangeStaleness({
          cwd: process.cwd(),
          lane,
          reason: options.reason,
        });
        writeResult(result, options.json ?? false);
      });
    });

  command
    .command("verdict")
    .description("Record the stress test verdict for a lane's shape.")
    .argument("<lane>", `lane: ${stressTestLanes.join(" or ")}`, parseStressTestLane)
    .argument("<verdict>", `verdict: ${stressTestVerdicts.join(", ")}`, parseStressTestVerdict)
    .option("--reason <reason>", "why this verdict was given (required for waived)")
    .option("--session <path>", "stress test session note that holds the questions and answers")
    .option("--json", "print machine-readable JSON")
    .action(async (lane: StressTestLane, verdict: StressTestVerdict, options: ChangeVerdictOptions) => {
      await runAction(options.json ?? false, async () => {
        const result = await verdictChange({
          cwd: process.cwd(),
          lane,
          verdict,
          reason: options.reason,
          session: options.session,
        });
        writeResult(result, options.json ?? false);
      });
    });

  command
    .command("auto-advance")
    .description("Show or set which lifecycle transitions `weave advance` may start on its own.")
    .argument("[transition]", "transition id, e.g. questions_to_research")
    .argument("[state]", "on or off", parseOnOff)
    .option("--json", "print machine-readable JSON")
    .action(async (transition: string | undefined, state: boolean | undefined, options: ChangeStatusOptions) => {
      await runAction(options.json ?? false, async () => {
        const result = await autoAdvanceChange({
          cwd: process.cwd(),
          transition,
          enabled: state,
        });
        writeResult(result, options.json ?? false);
      });
    });

  command
    .command("runs")
    .description("List the phase runs recorded for the active change.")
    .option("--json", "print machine-readable JSON")
    .action(async (options: ChangeStatusOptions) => {
      await runAction(options.json ?? false, async () => {
        writeResult(await listChangeRuns({ cwd: process.cwd() }), options.json ?? false);
      });
    });

  const run = command.command("run").description("Record phase runs for the active change.");

  run
    .command("start")
    .description("Record that a skill session started for a lane.")
    .argument("<lane>", "lane the session works on", parseChangeStage)
    .requiredOption("--skill <skill>", "skill the session runs, e.g. weave-research")
    .requiredOption("--agent <agent>", "agent running the session, e.g. claude")
    .option("--session <id>", "agent session id, when known")
    .option("--trigger <trigger>", `what started the session: ${runTriggers.join(" or ")}`, parseRunTrigger, "manual")
    .option("--json", "print machine-readable JSON")
    .action(async (lane: ChangeStage, options: ChangeRunStartOptions) => {
      await runAction(options.json ?? false, async () => {
        const result = await startChangeRun({
          cwd: process.cwd(),
          lane,
          skill: options.skill,
          agent: options.agent,
          sessionId: options.session,
          trigger: options.trigger,
        });
        writeResult(result, options.json ?? false);
      });
    });

  run
    .command("finish")
    .description("Record how a phase run ended.")
    .argument("<run-id>", "run id from `weave change run start` or `weave change runs`")
    .requiredOption("--result <result>", `result: ${finishedRunResults().join(", ")}`, parseFinishedRunResult)
    .option("--session <id>", "agent session id, when it was not known at start")
    .option("--json", "print machine-readable JSON")
    .action(async (runId: string, options: ChangeRunFinishOptions) => {
      await runAction(options.json ?? false, async () => {
        const result = await finishChangeRun({
          cwd: process.cwd(),
          runId,
          result: options.result,
          sessionId: options.session,
        });
        writeResult(result, options.json ?? false);
      });
    });

  run
    .command("log")
    .description("Show what a background phase run is doing, as readable lines.")
    .argument("[run-id]", "run id from `weave change runs`; defaults to the latest run")
    .option("--follow", "keep printing new lines until the run finishes")
    .action(async (runId: string | undefined, options: { follow?: boolean }) => {
      await runAction(false, async () => {
        const listed = await listChangeRuns({ cwd: process.cwd() });
        const chosen = runId ? listed.runs.find((candidate) => candidate.id === runId) : listed.runs.at(-1);
        if (!chosen) {
          throw new ChangeCommandError("run_not_found", runId ? `No run ${runId} recorded for ${listed.change_id}.` : `No runs recorded for ${listed.change_id}.`);
        }
        if (chosen.launch === "terminal" || chosen.launch === "here") {
          process.stdout.write(`Run ${chosen.id} is an interactive session${chosen.where ? ` in ${chosen.where}` : ""}; watch it there.\n`);
          return;
        }
        await printRunLog({
          logPath: runLogPath(listed.change_id, chosen.id),
          follow: options.follow ?? false,
          write: (line) => process.stdout.write(`${line}\n`),
          stillRunning: async () =>
            (await listChangeRuns({ cwd: process.cwd() })).runs.find((candidate) => candidate.id === chosen.id)?.result === "running",
        });
      });
    });

  command
    .command("knowledge")
    .description("Record knowledge freshness for the active change.")
    .argument("<status>", "knowledge status: pending, stale, updated, or none", parseKnowledgeStatus)
    .option("--domain <domain>", "affected knowledge domain", collectValues)
    .option("--shared <shared>", "affected shared behavior area", collectValues)
    .option("--file <file>", "touched or authoritative knowledge file", collectValues)
    .option("--delta <delta>", "change-local knowledge delta file")
    .option("--reason <reason>", "reason for the knowledge status")
    .option("--invalidated-by <source>", "source that invalidated knowledge freshness")
    .option("--json", "print machine-readable JSON")
    .action(async (status: KnowledgeStatus, options: ChangeKnowledgeOptions) => {
      await runAction(options.json ?? false, async () => {
        const result = await knowledgeChange({
          cwd: process.cwd(),
          status,
          domains: options.domain,
          shared: options.shared,
          files: options.file,
          delta: options.delta,
          reason: options.reason,
          invalidatedBy: options.invalidatedBy,
        });
        writeResult(result, options.json ?? false);
      });
    });

  command
    .command("switch")
    .description("Switch to an existing change.")
    .argument("<change>", "change id, token, slug, or title substring")
    .option("--json", "print machine-readable JSON")
    .action(async (change: string, options: ChangeTargetOptions) => {
      await runAction(options.json ?? false, async () => {
        const result = await switchChange({
          cwd: process.cwd(),
          change,
        });
        writeResult(result, options.json ?? false);
      });
    });

  command
    .command("setup")
    .description("Worktree checkouts: run each worktree's setup command once, after a person approves it.")
    .option("--approve", "review and approve new setup commands (needs a person at a terminal)")
    .option("--json", "print machine-readable JSON")
    .action(async (options: ChangeSetupOptions) => {
      await runAction(options.json ?? false, async () => {
        const result = await setupChange({
          cwd: process.cwd(),
          approve: options.approve,
          confirm: interactiveTerminal() ? confirmSetupCommands : undefined,
        });
        writeResult(result, options.json ?? false);
        if (result.status !== "ok" && result.status !== "nothing_to_run") {
          process.exitCode = 1;
        }
      });
    });

  command
    .command("close")
    .description("Worktree checkouts: remove a change's worktrees. Refuses uncommitted work and keeps every branch.")
    .argument("[change]", "change id, token, slug, or title substring; defaults to the active change")
    .option("--json", "print machine-readable JSON")
    .action(async (change: string | undefined, options: ChangeTargetOptions) => {
      await runAction(options.json ?? false, async () => {
        writeResult(await closeChange({ cwd: process.cwd(), change }), options.json ?? false);
      });
    });

  return command;
}

// `--base feature/x` sets every repo's starting point; `--base api=feature/x` sets one repo's.
function parseBases(values: string[]): { base?: string; repoBases?: Record<string, string> } {
  const repoBases: Record<string, string> = {};
  let base: string | undefined;
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator > 0) {
      const repo = value.slice(0, separator).trim();
      const ref = value.slice(separator + 1).trim();
      if (!ref) {
        throw new InvalidArgumentError(`--base ${value} is missing a ref after "=".`);
      }
      repoBases[repo] = ref;
    } else if (base !== undefined && base !== value) {
      throw new InvalidArgumentError(`--base was given twice (${base} and ${value}). Use --base <repo>=<ref> for repos that start somewhere else.`);
    } else {
      base = value.trim();
    }
  }
  return { ...(base ? { base } : {}), ...(Object.keys(repoBases).length > 0 ? { repoBases } : {}) };
}

function interactiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function confirmSetupCommands(commands: SetupCommand[]): Promise<boolean> {
  const { confirm, isCancel } = await import("@clack/prompts");
  process.stdout.write(
    ["These setup commands will run in the change's worktrees:", ...commands.map((item) => `  ${item.repo} (${item.path}): ${item.command}`), ""].join("\n"),
  );
  const answer = await confirm({ message: "Approve and run them? Approval is remembered on this machine for these exact commands." });
  return !isCancel(answer) && answer === true;
}

function parseOnOff(value: string): boolean {
  if (value === "on") return true;
  if (value === "off") return false;
  throw new InvalidArgumentError(`Expected on or off, got: ${value}`);
}

function parseRunTrigger(value: string): RunTrigger {
  if (isRunTrigger(value)) {
    return value;
  }
  throw new InvalidArgumentError(`Unsupported trigger: ${value}. Expected ${runTriggers.join(" or ")}`);
}

function finishedRunResults(): FinishedRunResult[] {
  return runResults.filter((result): result is FinishedRunResult => result !== "running");
}

function parseFinishedRunResult(value: string): FinishedRunResult {
  if (isRunResult(value) && value !== "running") {
    return value;
  }
  throw new InvalidArgumentError(`Unsupported result: ${value}. Expected ${finishedRunResults().join(", ")}`);
}

function parseKnowledgeStatus(value: string): KnowledgeStatus {
  if (isKnowledgeStatus(value)) {
    return value;
  }

  throw new InvalidArgumentError(`Unsupported knowledge status: ${value}. Expected ${knowledgeStatuses.join(", ")}`);
}

function parseStressTestLane(value: string): StressTestLane {
  if (isStressTestLane(value)) {
    return value;
  }

  throw new InvalidArgumentError(`Unsupported stress test lane: ${value}. Expected ${stressTestLanes.join(" or ")}`);
}

function parseStressTestVerdict(value: string): StressTestVerdict {
  if (isStressTestVerdict(value)) {
    return value;
  }

  throw new InvalidArgumentError(`Unsupported verdict: ${value}. Expected ${stressTestVerdicts.join(", ")}`);
}

function parseChangeStage(value: string): ChangeStage {
  if ((changeStages as readonly string[]).includes(value)) {
    return value as ChangeStage;
  }
  if (value === "issues") {
    return "slices";
  }

  throw new InvalidArgumentError(`Unsupported change stage: ${value}. Expected ${changeStages.join(", ")} (issues is accepted as an alias for slices)`);
}

function parseInvalidateList(raw: string | undefined): ChangeStage[] | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  const parts = trimmed.split(",").map((part) => part.trim()).filter(Boolean);
  const normalized: ChangeStage[] = [];
  for (const part of parts) {
    const lane = part === "issues" ? "slices" : (changeStages as readonly string[]).includes(part) ? (part as ChangeStage) : undefined;
    if (!lane) {
      throw new InvalidArgumentError(
        `Unsupported lane in --invalidate: ${part}. Expected ${changeStages.join(", ")}`,
      );
    }
    normalized.push(lane);
  }
  return normalized;
}

function parseChangeType(value: string): ChangeType {
  if ((changeTypes as string[]).includes(value)) {
    return value as ChangeType;
  }

  throw new InvalidArgumentError(`Unsupported change type: ${value}`);
}

function collectValues(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function writeResult(
  result:
    | ChangeOperationResult
    | ChangeListResult
    | CurrentChangeResult
    | StatusChangeResult
    | SwitchChangeResult
    | ProgressChangeResult
    | KnowledgeChangeResult
    | ClearChangeStalenessResult
    | VerdictChangeResult
    | AutoAdvanceChangeResult
    | ChangeRunResult
    | ListChangeRunsResult
    | SetupResult
    | CloseChangeResult,
  json: boolean,
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${result.message}\n`);
}

export async function runAction(json: boolean, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (json) {
      process.stdout.write(`${JSON.stringify(errorResult(error), null, 2)}\n`);
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  }
}

function errorResult(error: unknown): { status: "error"; code: string; message: string; details?: unknown } {
  if (error instanceof ChangeCommandError) {
    return {
      status: "error",
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  return {
    status: "error",
    code: "unknown_error",
    message: error instanceof Error ? error.message : String(error),
  };
}
