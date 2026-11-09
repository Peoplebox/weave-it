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
  locateChange,
  setupChange,
} from "../lib/changes.js";
import { runLogPath } from "../lib/advance.js";
import { printRunLog } from "../lib/run-log.js";
import { joinOrRunRefresh, planBackgroundRefresh, readRemoteFacts, runRefresh, spawnBackgroundRefresh } from "../lib/change-refresh.js";
import { withNotices } from "../lib/with-notices.js";
import {
  currentChoices,
  formatOpenLines,
  openChange,
  parseOpenFlag,
  placeOpenLines,
  validateExplicitChoice,
  type ExplicitChoice,
  type OpenContext,
  type OpenResult,
} from "../lib/open-change.js";
import { findWorkspaceMode } from "../lib/workspace-mode.js";
import { mainCheckoutPath, workspaceCheckoutMode } from "../lib/worktrees.js";
import type { SetupCommand, SetupResult } from "../lib/worktrees.js";

// `--open <place[:agent]>` and `--no-open` share one commander attribute: a string, or false.
interface OpenFlags {
  open?: string | false;
  skill?: string;
  context?: string;
}

interface ChangeNewOptions extends OpenFlags {
  slug?: string;
  type?: ChangeType;
  autoAdvance?: boolean;
  repo?: string[];
  base?: string[];
  fetch?: boolean;
  json?: boolean;
}

interface ChangeOpenOptions {
  in?: string;
  agent?: string;
  skill?: string;
  context?: string;
  remember?: boolean;
  project?: boolean;
  choices?: boolean;
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
    .option("--skill <name>", "the skill the change should start with, e.g. weave-explore; used as the new session's first step")
    .option("--context <text>", "a one-line gist added to that first step")
    .option("--open <place>", "open this change in <place>[:<agent>] this time only, e.g. tmux:claude or cursor")
    .option("--no-open", "don't open this change, whatever your default says")
    .option("--json", "print machine-readable JSON")
    .action(async (title: string, options: ChangeNewOptions) => {
      const json = options.json ?? false;
      await runAction(json, async () => {
        const explicit = await openFlagsFromOptions(options);
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
          const opened = await openAfter({
            changeId: result.id,
            folder: result.folder,
            checkout: result.checkout,
            changePath: result.targets[0]?.changePath,
            stage: result.type === "feat" ? "exploration" : "started",
            message: result.message,
            explicit,
            options,
            json,
          });
          return { json: { ...result, message: opened.message, next_step: opened.next_step, open: opened.open }, text: opened.text };
        });
      });
    });

  command
    .command("list")
    .description("List changes, with each change's state and next step.")
    .option("--all", "include past changes whose work has landed")
    .option("--fetch", "wait for a fresh look at the remote before answering")
    .option("--json", "print machine-readable JSON")
    .action(async (options: ChangeTargetOptions & { all?: boolean; fetch?: boolean }) => {
      await runAction(options.json ?? false, async () => {
        const cwd = process.cwd();
        // Remote facts come from a background refresh in worktree mode only; in-place
        // checkouts list exactly as before.
        const worktreeMode = await usesChangeFolders(cwd);
        let finished: boolean | undefined;
        if (worktreeMode && options.fetch) {
          finished = await joinOrRunRefresh(cwd);
        }
        const plan = worktreeMode && !options.fetch ? await planBackgroundRefresh(cwd) : { refreshing: false, spawn: false };
        const refresh = worktreeMode
          ? { record: (await readRemoteFacts(cwd)).record, refreshing: plan.refreshing, ...(finished !== undefined ? { finished } : {}) }
          : undefined;
        const result = await listChanges({ cwd, all: options.all ?? false, ...(refresh ? { refresh } : {}) });
        writeResult(result, options.json ?? false);
        if (plan.spawn) {
          await spawnBackgroundRefresh(cwd);
        }
      });
    });

  command
    .command("refresh", { hidden: true })
    .description("Refresh remote facts for `weave change list` (started in the background by list).")
    .requiredOption("--root <path>", "the main checkout")
    .action(async (options: { root: string }) => {
      // Results are only recorded in refresh.json; this never fails loudly.
      try {
        await runRefresh(options.root, { throttle: false });
      } catch {
        // Nothing to report to: the next list shows the last recorded result.
      }
      process.exitCode = 0;
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
    .description("Switch to an existing change. With change folders, also opens it where you chose.")
    .argument("<change>", "change id, token, slug, or title substring")
    .option("--skill <name>", "the skill the new session should start with; replaces the stored first step")
    .option("--context <text>", "a one-line gist added to that step")
    .option("--open <place>", "open this change in <place>[:<agent>] this time only, e.g. tmux:claude or cursor")
    .option("--no-open", "don't open this change, whatever your default says")
    .option("--json", "print machine-readable JSON")
    .action(async (change: string, options: ChangeTargetOptions & OpenFlags) => {
      const json = options.json ?? false;
      await runAction(json, async () => {
        const explicit = await openFlagsFromOptions(options);
        const result = await switchChange({
          cwd: process.cwd(),
          change,
        });
        const opened = await openAfter({
          changeId: result.change.id,
          folder: result.folder,
          checkout: result.folder ? "worktree" : "in-place",
          changePath: result.change.changePath,
          stage: result.change.stage,
          message: result.message,
          explicit,
          options,
          json,
        });
        const merged = { ...result, message: opened.message, next_step: opened.next_step, open: opened.open };
        process.stdout.write(json ? `${JSON.stringify(merged, null, 2)}\n` : `${opened.text}\n`);
      });
    });

  command
    .command("open")
    .description("Worktree checkouts: open a change's folder in your chosen terminal or app. Never fetches or touches worktrees.")
    .argument("[change]", "change id, token, slug, or title substring; defaults to the active change")
    .option("--in <place>", "where to open it: herdr, tmux, iterm, terminal, vscode, cursor, claude-desktop, t3code, or none")
    .option("--agent <agent>", "terminals only: claude, codex, opencode, cursor-agent, one of your own agents, or shell")
    .option("--skill <name>", "the skill the new session should start with, e.g. weave-explore")
    .option("--context <text>", "a one-line gist added to the next step")
    .option("--remember", "save this choice as your default for every project")
    .option("--project", "save this choice for this project only")
    .option("--choices", "list the places and agents you can choose from, without opening anything")
    .option("--json", "print machine-readable JSON")
    .action(async (change: string | undefined, options: ChangeOpenOptions) => {
      const json = options.json ?? false;
      await runAction(json, async () => {
        if (options.agent && !options.in) {
          throw new ChangeCommandError("agent_needs_place", "--agent needs --in <terminal>.");
        }
        const explicit: ExplicitChoice | undefined = options.in ? { place: options.in, ...(options.agent ? { agent: options.agent } : {}) } : undefined;
        await validateExplicitChoice(explicit);
        const located = await locateChange({ cwd: process.cwd(), change });
        if (options.choices) {
          const choices = await currentChoices();
          writeOpenResult({ status: "ok", id: located.id, choices }, json, formatChoices(choices));
          return;
        }
        if (located.checkout === "worktree" && (!located.folder || !located.folderExists)) {
          throw new ChangeCommandError(
            "folder_missing",
            `The folder for ${located.id} isn't on this machine. Run \`weave change switch ${located.id}\` to recreate it.`,
          );
        }
        const folder = located.folder ?? located.changePath;
        const result = await openChange({
          ...openFlagsContext({ explicit, skill: options.skill, context: options.context, remember: options.project ? "project" : options.remember ? "default" : undefined, json }),
          changeId: located.id,
          folder,
          mainRoot: located.mainRoot,
          cwd: process.cwd(),
          inPlace: located.checkout !== "worktree",
          changePath: located.changePath,
          stage: located.stage,
        });
        writeOpenResult({ status: "ok", id: located.id, folder, ...result }, json, formatOpenLines(result, folder).join("\n"));
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

// Validated before anything is created or switched to.
async function openFlagsFromOptions(options: OpenFlags): Promise<ExplicitChoice | undefined> {
  const explicit = typeof options.open === "string" ? parseOpenFlag(options.open) : undefined;
  await validateExplicitChoice(explicit);
  return explicit;
}

// Opens a change that was just created or switched to, and puts the outcome where the
// summary's "Open <folder> in a new session" line was. Without a default and with nobody to
// ask, the output is exactly what it was before opening existed.
async function openAfter(input: {
  changeId: string;
  folder?: string;
  checkout: string;
  changePath?: string;
  stage: string;
  message: string;
  explicit?: ExplicitChoice;
  options: OpenFlags;
  json: boolean;
}): Promise<{ message: string; text: string; next_step: string; open: OpenResult["open"] }> {
  const folder = input.folder;
  const openLine = folder ? `Open ${folder} in a new session to work on this change.` : undefined;
  let summaryPrinted = false;
  const result = await openChange({
    ...openFlagsContext({ explicit: input.explicit, noOpen: input.options.open === false, skill: input.options.skill, context: input.options.context, json: input.json }),
    changeId: input.changeId,
    folder: folder ?? input.changePath ?? process.cwd(),
    mainRoot: await mainCheckoutPath(process.cwd()).catch(() => undefined),
    cwd: process.cwd(),
    inPlace: input.checkout !== "worktree" || !folder,
    ...(input.changePath ? { changePath: input.changePath } : {}),
    stage: input.stage,
    beforePrompt: () => {
      // The person sees what was created before choosing where to open it.
      const lines = input.message.split("\n").filter((line) => line !== openLine);
      process.stdout.write(`${lines.join("\n").trimEnd()}\n\n`);
      summaryPrinted = true;
    },
  });
  const outcome = folder ? formatOpenLines(result, folder) : [];
  const message = folder ? placeOpenLines(input.message, folder, result) : input.message;
  return {
    message,
    text: summaryPrinted ? outcome.join("\n") : message,
    next_step: result.next_step,
    open: result.open,
  };
}

function openFlagsContext(input: {
  explicit?: ExplicitChoice;
  noOpen?: boolean;
  skill?: string;
  context?: string;
  remember?: "default" | "project";
  json: boolean;
}): Pick<OpenContext, "explicit" | "noOpen" | "skill" | "context" | "remember" | "json" | "interactive"> {
  return {
    ...(input.explicit ? { explicit: input.explicit } : {}),
    ...(input.noOpen ? { noOpen: true } : {}),
    ...(input.skill ? { skill: input.skill } : {}),
    ...(input.context ? { context: input.context } : {}),
    ...(input.remember ? { remember: input.remember } : {}),
    json: input.json,
    interactive: interactiveTerminal(),
  };
}

function writeOpenResult(result: object, json: boolean, text: string): void {
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${text}\n`);
}

function formatChoices(choices: Awaited<ReturnType<typeof currentChoices>>): string {
  return choices
    .map((choice) => {
      const agents = choice.agents ? ` (${choice.agents.map((agent) => agent.id).join(", ")})` : "";
      return `${choice.place}  ${choice.label}${choice.hint ? ` — ${choice.hint}` : ""}${agents}`;
    })
    .join("\n");
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

async function usesChangeFolders(cwd: string): Promise<boolean> {
  const found = await findWorkspaceMode(cwd).catch(() => undefined);
  return found ? (await workspaceCheckoutMode(found.workspacePath)) === "worktree" : false;
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
  // Opening and settings errors (OpenArgumentError, SettingsError) carry their own code.
  const code = error instanceof Error ? (error as unknown as { code?: unknown }).code : undefined;
  if (error instanceof Error && typeof code === "string" && /^[a-z_]+$/.test(code)) {
    return { status: "error", code, message: error.message };
  }

  return {
    status: "error",
    code: "unknown_error",
    message: error instanceof Error ? error.message : String(error),
  };
}
