import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { ChangeCommandError } from "./changes.js";

// Starts one skill in a fresh, non-interactive agent session. `weave advance` talks to
// agents only through this interface, so supporting another agent means adding a
// launcher to `agentLaunchers` without touching the runner.
export interface AgentLaunchRequest {
  cwd: string;
  prompt: string;
  // Session id chosen by Weave before launch, when the agent accepts one.
  sessionId?: string;
  permissionMode?: string;
  // File that receives the session's stdout and stderr.
  logPath: string;
}

export interface AgentLaunchPlan {
  command: string;
  args: string[];
}

export interface AgentLaunchResult {
  exitCode: number;
  sessionId?: string;
}

export interface AgentLauncher {
  agent: string;
  acceptsSessionId: boolean;
  plan(request: Omit<AgentLaunchRequest, "logPath">): AgentLaunchPlan;
  launch(request: AgentLaunchRequest): Promise<AgentLaunchResult>;
}

export const claudeLauncher: AgentLauncher = {
  agent: "claude",
  acceptsSessionId: true,
  plan(request) {
    return {
      command: "claude",
      args: [
        "-p",
        request.prompt,
        ...(request.sessionId ? ["--session-id", request.sessionId] : []),
        ...(request.permissionMode ? ["--permission-mode", request.permissionMode] : []),
      ],
    };
  },
  async launch(request) {
    const plan = this.plan(request);
    // The child must start its own session rather than attach to the one that ran
    // `weave advance`, so the parent's session marker is not passed down.
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const exitCode = await runToLog(plan, request.cwd, request.logPath, env);
    return { exitCode, sessionId: request.sessionId };
  },
};

export const agentLaunchers: Record<string, AgentLauncher> = {
  claude: claudeLauncher,
};

export const defaultLaunchAgent = "claude";

export function formatLaunchPlan(plan: AgentLaunchPlan): string {
  return [plan.command, ...plan.args.map(shellQuote)].join(" ");
}

async function runToLog(plan: AgentLaunchPlan, cwd: string, logPath: string, env: NodeJS.ProcessEnv): Promise<number> {
  await mkdir(path.dirname(logPath), { recursive: true });
  const log = await open(logPath, "a");
  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(plan.command, plan.args, { cwd, env, stdio: ["ignore", log.fd, log.fd] });
      child.once("error", (error) => {
        reject(
          new ChangeCommandError("agent_launch_failed", `Could not start ${plan.command}: ${error.message}`, {
            command: plan.command,
          }),
        );
      });
      child.once("close", (code) => resolve(code ?? 1));
    });
  } finally {
    await log.close();
  }
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
