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
  // Headless session for background runs.
  plan(request: Omit<AgentLaunchRequest, "logPath">): AgentLaunchPlan;
  // Normal interactive session, for a terminal the person can see.
  interactive(request: Omit<AgentLaunchRequest, "logPath">): AgentLaunchPlan;
  launch(request: AgentLaunchRequest): Promise<AgentLaunchResult>;
}

// A background session has nobody to approve tool use, so it gets file edits inside the
// change folder, web lookups, and the commands a Weave phase needs.
export const backgroundAllowedTools = [
  "WebSearch",
  "WebFetch",
  "Bash(weave *)",
  "Bash(git log *)",
  "Bash(git show *)",
  "Bash(git diff *)",
  "Bash(git status *)",
  "Bash(git ls-files *)",
  "Bash(ls *)",
];

// Sessions Weave starts itself carry this marker; checkpoint code commits refuse under it and the
// first-commit notice is not marked delivered (decision 261111-7orw).
export const unattendedEnv = { WEAVE_UNATTENDED: "1" } as const;

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
        "--permission-mode",
        request.permissionMode ?? "acceptEdits",
        // Stream every event to the log as it happens, so `weave change run log` can show progress.
        "--output-format",
        "stream-json",
        "--verbose",
        "--allowedTools",
        ...backgroundAllowedTools,
      ],
    };
  },
  interactive(request) {
    return {
      command: "claude",
      args: [
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
    const env: NodeJS.ProcessEnv = { ...process.env, ...unattendedEnv };
    delete env.CLAUDECODE;
    const exitCode = await runToLog(plan, request.cwd, request.logPath, env);
    return { exitCode, sessionId: request.sessionId };
  },
};

export const agentLaunchers: Record<string, AgentLauncher> = {
  claude: claudeLauncher,
};

// Library default for callers that pass no agent. The CLI never relies on it: it hands phases
// to the calling agent unless an agent or command is configured.
export const defaultLaunchAgent = "claude";

export const customAgentName = "custom";

// Any agent CLI, from `advance.command` in .weave/workspace.yml, for example `pi "{prompt}"`.
// The prompt replaces `{prompt}`, shell-quoted. The same command serves every launch mode.
export function commandTemplateLauncher(template: string): AgentLauncher {
  const plan = (request: Omit<AgentLaunchRequest, "logPath">): AgentLaunchPlan => ({
    command: "/bin/sh",
    args: ["-c", template.split("{prompt}").join(shellQuote(request.prompt))],
  });
  return {
    agent: customAgentName,
    acceptsSessionId: false,
    plan,
    interactive: plan,
    async launch(request) {
      return { exitCode: await runToLog(plan(request), request.cwd, request.logPath, { ...process.env, ...unattendedEnv }) };
    },
  };
}

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

export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
