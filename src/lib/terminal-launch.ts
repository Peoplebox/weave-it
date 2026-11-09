import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Opens a new terminal the person can see and runs a command in it. `weave advance` uses
// this so an auto-advanced phase runs as a normal, visible agent session. Each opener only
// uses tools that are already there; none of them is a Weave dependency.
export interface TerminalOpenRequest {
  cwd: string;
  // Short label for the tab or window, e.g. `weave-research 4oq6`.
  title: string;
  // A complete shell command line to run in the new terminal.
  command: string;
}

export interface OpenedTerminal {
  kind: string;
  // Where the person finds it, e.g. "a new herdr tab" or "tmux window weave-research-4oq6".
  where: string;
}

export interface TerminalOpener {
  kind: string;
  available(env: NodeJS.ProcessEnv): Promise<boolean>;
  open(request: TerminalOpenRequest, env: NodeJS.ProcessEnv): Promise<OpenedTerminal>;
}

const herdrOpener: TerminalOpener = {
  kind: "herdr",
  // Every herdr terminal sets HC_TERMINAL_ID; the app opens tabs through `herdr-app do`.
  async available(env) {
    return Boolean(env.HC_TERMINAL_ID) && Boolean(await findExecutable("herdr-app", env));
  },
  async open(request, env) {
    const payload = JSON.stringify({ name: request.title, folder: request.cwd, argv: ["/bin/sh", "-c", request.command] });
    await execFileAsync((await findExecutable("herdr-app", env))!, ["do", "tab.new", payload], { env });
    return { kind: "herdr", where: `a new herdr tab named "${request.title}"` };
  },
};

const tmuxOpener: TerminalOpener = {
  kind: "tmux",
  async available(env) {
    return Boolean(env.TMUX) && Boolean(await findExecutable("tmux", env));
  },
  async open(request, env) {
    const name = request.title.replace(/[^\w-]+/g, "-");
    await execFileAsync("tmux", ["new-window", "-d", "-c", request.cwd, "-n", name, request.command], { env });
    return { kind: "tmux", where: `tmux window ${name}` };
  },
};

const itermOpener: TerminalOpener = {
  kind: "iterm",
  async available(env) {
    return process.platform === "darwin" && env.TERM_PROGRAM === "iTerm.app";
  },
  async open(request, env) {
    const script = [
      'tell application "iTerm2"',
      `  set newWindow to (create window with default profile command ${appleScriptString(`/bin/sh -c ${shellQuote(`cd ${shellQuote(request.cwd)} && ${request.command}`)}`)})`,
      "end tell",
    ].join("\n");
    await execFileAsync("osascript", ["-e", script], { env });
    return { kind: "iterm", where: "a new iTerm2 window" };
  },
};

// Terminal.app ships with macOS, so it is the fallback when no other terminal is detected.
const terminalAppOpener: TerminalOpener = {
  kind: "terminal-app",
  async available() {
    return process.platform === "darwin";
  },
  async open(request, env) {
    const script = `tell application "Terminal"\n  activate\n  do script ${appleScriptString(`cd ${shellQuote(request.cwd)} && ${request.command}`)}\nend tell`;
    await execFileAsync("osascript", ["-e", script], { env });
    return { kind: "terminal-app", where: "a new Terminal window" };
  },
};

export const terminalOpeners: TerminalOpener[] = [herdrOpener, tmuxOpener, itermOpener, terminalAppOpener];

export async function findTerminalOpener(env: NodeJS.ProcessEnv, openers: TerminalOpener[] = terminalOpeners): Promise<TerminalOpener | undefined> {
  for (const opener of openers) {
    if (await opener.available(env)) {
      return opener;
    }
  }
  return undefined;
}

export async function findExecutable(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    try {
      await access(candidate, 1);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
