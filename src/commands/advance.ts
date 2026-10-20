import { Command, Option } from "commander";
import { advanceChange, type AdvanceResult, resumeAdvanceRun } from "../lib/advance.js";
import { defaultLaunchAgent } from "../lib/agent-launchers.js";
import { runAction } from "./change.js";

interface AdvanceCommandOptions {
  transition?: string;
  dryRun?: boolean;
  detach?: boolean;
  once?: boolean;
  retryFailed?: boolean;
  agent: string;
  permissionMode?: string;
  executeRun?: string;
  json?: boolean;
}

export function advanceCommand(): Command {
  return new Command("advance")
    .description(
      "Start the next lifecycle phase of the active change in a fresh agent session when its auto-advance transition is on and every condition holds.",
    )
    .option("--transition <transition>", "only consider this transition, e.g. questions_to_research")
    .option("--dry-run", "print each condition and the decision without starting anything")
    .option("--detach", "start the session in the background and return immediately")
    .option("--once", "start at most one phase instead of continuing while transitions keep firing")
    .option("--retry-failed", "allow a phase whose last run failed to start again for the same upstream update")
    .option("--agent <agent>", "agent that runs the session", defaultLaunchAgent)
    .option("--permission-mode <mode>", "permission mode passed to the agent session")
    .addOption(new Option("--execute-run <run-id>", "run a phase already recorded by a detached advance").hideHelp())
    .option("--json", "print machine-readable JSON")
    .action(async (options: AdvanceCommandOptions) => {
      const json = options.json ?? false;
      await runAction(json, async () => {
        const result = options.executeRun
          ? await resumeAdvanceRun({
              cwd: process.cwd(),
              runId: options.executeRun,
              once: options.once,
              retryFailed: options.retryFailed,
              permissionMode: options.permissionMode,
            })
          : await advanceChange({
              cwd: process.cwd(),
              transition: options.transition,
              dryRun: options.dryRun,
              detach: options.detach,
              once: options.once,
              retryFailed: options.retryFailed,
              agent: options.agent,
              permissionMode: options.permissionMode,
            });
        writeAdvanceResult(result, json);
      });
    });
}

function writeAdvanceResult(result: AdvanceResult, json: boolean): void {
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${result.message}\n`);
}
