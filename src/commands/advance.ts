import { Command, InvalidArgumentError, Option } from "commander";
import { advanceChange, type AdvanceLaunch, type AdvanceResult, finishAndAdvance, resumeAdvanceRun } from "../lib/advance.js";
import { agentLaunchers, type AgentLauncher, commandTemplateLauncher, customAgentName } from "../lib/agent-launchers.js";
import { ChangeCommandError } from "../lib/changes.js";
import { findWorkspaceMode } from "../lib/workspace-mode.js";
import { advanceLaunchSettings, readWorkspaceMetadata, type WorkspaceMetadata } from "../lib/workspace-repos.js";
import { runAction } from "./change.js";

interface AdvanceCommandOptions {
  transition?: string;
  dryRun?: boolean;
  detach?: boolean;
  launch?: AdvanceLaunch;
  once?: boolean;
  retryFailed?: boolean;
  agent?: string;
  permissionMode?: string;
  executeRun?: string;
  finishRun?: string;
  json?: boolean;
}

export function advanceCommand(): Command {
  return new Command("advance")
    .description(
      "Start the next lifecycle phase of the active change when its auto-advance transition is on and every condition holds. By default it hands the phase to the agent that ran it, to run as a fresh sub-agent.",
    )
    .option("--transition <transition>", "only consider this transition, e.g. questions_to_research")
    .option("--dry-run", "print each condition and the decision without starting anything")
    .option(
      "--launch <mode>",
      "handoff (default): return a brief for the calling agent to run as a fresh sub-agent; here, terminal, or background: Weave starts the session with the configured agent",
      parseLaunch,
    )
    .option("--detach", "same as --launch background, returning immediately")
    .option("--once", "start at most one phase instead of continuing while transitions keep firing")
    .option("--retry-failed", "allow a phase whose last run failed or ended incomplete to start again for the same upstream update")
    .option("--agent <agent>", `agent Weave starts for here, terminal, or background: ${Object.keys(agentLaunchers).join(", ")}; or set advance.command`)
    .option("--permission-mode <mode>", "permission mode passed to a session Weave starts")
    .addOption(new Option("--execute-run <run-id>", "run a phase already recorded by a detached advance").hideHelp())
    .addOption(new Option("--finish-run <run-id>", "record how a phase session ended, then keep advancing").hideHelp())
    .option("--json", "print machine-readable JSON")
    .action(async (options: AdvanceCommandOptions) => {
      const json = options.json ?? false;
      await runAction(json, async () => {
        const metadata = await workspaceMetadata();
        const launch = options.launch ?? (options.detach ? "background" : metadata?.advanceLaunch ?? "handoff");
        const agent = launch === "handoff" ? { agent: options.agent } : resolveAgent(options, metadata);

        if (options.executeRun) {
          writeAdvanceResult(
            await resumeAdvanceRun({
              cwd: process.cwd(),
              runId: options.executeRun,
              once: options.once,
              retryFailed: options.retryFailed,
              permissionMode: options.permissionMode,
              ...(agent.launchers ? { launchers: agent.launchers } : {}),
            }),
            json,
          );
          return;
        }

        const common = {
          cwd: process.cwd(),
          launch,
          once: options.once,
          retryFailed: options.retryFailed,
          permissionMode: options.permissionMode,
          ...(agent.agent ? { agent: agent.agent } : {}),
          ...(agent.launchers ? { launchers: agent.launchers } : {}),
        };
        if (options.finishRun) {
          writeAdvanceResult(await finishAndAdvance({ ...common, runId: options.finishRun }), json);
          return;
        }

        writeAdvanceResult(
          await advanceChange({
            ...common,
            transition: options.transition,
            dryRun: options.dryRun,
            detach: launch === "background" && (options.detach || !interactiveTerminal()),
          }),
          json,
        );
      });
    });
}

// Weave starts a session itself only with an agent someone chose: `--agent`, `advance.agent`,
// or an `advance.command` template. It never assumes one.
function resolveAgent(options: AdvanceCommandOptions, metadata: WorkspaceMetadata | undefined): { agent?: string; launchers?: Record<string, AgentLauncher> } {
  const name = options.agent ?? metadata?.advanceAgent;
  if (name) {
    if (!agentLaunchers[name]) {
      throw new ChangeCommandError(
        "unsupported_launch_agent",
        `weave advance cannot start ${name} sessions itself. Supported: ${Object.keys(agentLaunchers).join(", ")}. For any other agent, set advance.command in .weave/workspace.yml, e.g. pi "{prompt}".`,
      );
    }
    return { agent: name };
  }
  if (metadata?.advanceCommand) {
    return { agent: customAgentName, launchers: { [customAgentName]: commandTemplateLauncher(metadata.advanceCommand) } };
  }
  throw new ChangeCommandError(
    "missing_launch_agent",
    "Starting a session needs an agent: pass --agent, or set advance.agent or advance.command in .weave/workspace.yml. Without one, use the default --launch handoff.",
  );
}

async function workspaceMetadata(): Promise<WorkspaceMetadata | undefined> {
  const workspace = await findWorkspaceMode(process.cwd());
  return workspace ? readWorkspaceMetadata(workspace.workspacePath) : undefined;
}

function interactiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function parseLaunch(value: string): AdvanceLaunch {
  if ((advanceLaunchSettings as readonly string[]).includes(value)) {
    return value as AdvanceLaunch;
  }
  throw new InvalidArgumentError(`Unsupported launch mode: ${value}. Expected ${advanceLaunchSettings.join(", ")}`);
}

function writeAdvanceResult(result: AdvanceResult, json: boolean): void {
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${result.message}\n`);
}
