import { execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { appleScriptString, shellQuote } from "./terminal-launch.js";

// The fixed list of places a change can open in, and the agents a terminal can start
// (decisions 261109-mn61, 261109-bv3c). Each entry is checked only at its known command
// name and usual install paths: Weave never scans or guesses. PATH only helps to find a
// tool; only a missing absolute install path proves a tool is gone. These openers are
// separate from `weave advance`'s terminal openers on purpose.

export type PlaceKind = "terminal" | "app";
export type DraftSupport = "unsent" | "none";
export type CheckState = "available" | "unavailable_now" | "missing";

export interface CheckResult {
  state: CheckState;
  executable?: string;
  // One human line for unavailable_now / missing.
  detail?: string;
}

export interface RunOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
}

export interface OpenRuntime {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  // Extra absolute install paths from personal settings, by listed id.
  locations: Record<string, string>;
  exists(file: string): Promise<boolean>;
  run(file: string, args: string[], options: RunOptions): Promise<{ stdout: string }>;
  // Starts an app without waiting for it.
  spawnDetached(file: string, args: string[], options: RunOptions): Promise<void>;
}

export interface TerminalLaunch {
  folder: string;
  title: string;
  // The shell line to run in the new terminal; already ends in a login shell.
  line: string;
  // Only passed when the place (or agent) can hold an unsent first message.
  draft?: string;
}

export interface AppLaunch {
  folder: string;
  draft?: string;
}

interface PlaceBase {
  id: string;
  label: string;
  platforms: NodeJS.Platform[];
  // False: skipped over SSH, because it would appear on a screen the person can't see.
  remoteOk: boolean;
  hint?: string;
  draft: DraftSupport;
  check(runtime: OpenRuntime): Promise<CheckResult>;
}

export interface TerminalPlace extends PlaceBase {
  kind: "terminal";
  open(executable: string | undefined, launch: TerminalLaunch, runtime: OpenRuntime): Promise<{ where: string }>;
  // Brings forward a tab or window already sitting in the folder (a real path), if this
  // place can recognise one. Returns undefined when there is none.
  bringForward?(folder: string, runtime: OpenRuntime): Promise<{ where: string } | undefined>;
}

export interface AppPlace extends PlaceBase {
  kind: "app";
  open(executable: string, launch: AppLaunch, runtime: OpenRuntime): Promise<{ where: string }>;
}

export type Place = TerminalPlace | AppPlace;

export interface AgentEntry {
  id: string;
  label: string;
  draft: DraftSupport;
  own?: boolean;
  // Finds the executable; undefined when it can't be found.
  find(runtime: OpenRuntime): Promise<string | undefined>;
  // The shell line that starts the agent in the folder (without the login-shell tail).
  line(executable: string | undefined, folder: string, draft?: string): string;
}

export interface Registry {
  places: Place[];
  agents: AgentEntry[];
}

export const shellAgentId = "shell";
export const loginShellTail = 'exec "${SHELL:-/bin/sh}" -l';

// ---- lookup helpers ----

export async function findOnPath(name: string, runtime: OpenRuntime): Promise<string | undefined> {
  for (const dir of (runtime.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    if (await runtime.exists(candidate)) return candidate;
  }
  return undefined;
}

async function firstExisting(paths: string[], runtime: OpenRuntime): Promise<string | undefined> {
  for (const candidate of paths) {
    if (await runtime.exists(candidate)) return candidate;
  }
  return undefined;
}

function homePath(runtime: OpenRuntime, ...parts: string[]): string {
  return path.join(runtime.home, ...parts);
}

// A tool with known absolute install paths is `missing` only when none of them (nor a
// custom location) exist. A tool with no known paths can't be proven gone.
async function locateTool(
  id: string,
  runtime: OpenRuntime,
  options: { command?: string; knownPaths: string[] },
): Promise<{ executable?: string; provablyMissing: boolean }> {
  const absolute = [...(runtime.locations[id] ? [runtime.locations[id]!] : []), ...options.knownPaths];
  const known = await firstExisting(absolute, runtime);
  if (known) return { executable: known, provablyMissing: false };
  const onPath = options.command ? await findOnPath(options.command, runtime) : undefined;
  if (onPath) return { executable: onPath, provablyMissing: false };
  return { provablyMissing: absolute.length > 0 };
}

function terminalCommand(launch: TerminalLaunch): string {
  return `cd ${shellQuote(launch.folder)} && ${launch.line}`;
}

// ---- terminals ----

const herdrPlace: TerminalPlace = {
  id: "herdr",
  kind: "terminal",
  label: "herdr tab",
  platforms: ["darwin", "linux"],
  remoteOk: true,
  draft: "none",
  async check(runtime) {
    const found = await locateTool("herdr", runtime, {
      command: "herdr-app",
      knownPaths:
        runtime.platform === "darwin"
          ? [homePath(runtime, "Applications", "Herdr.app", "Contents", "MacOS", "Herdr"), "/Applications/Herdr.app/Contents/MacOS/Herdr", homePath(runtime, ".local", "bin", "herdr-app")]
          : [homePath(runtime, ".local", "bin", "herdr-app"), "/usr/local/bin/herdr-app", "/usr/bin/herdr-app"],
    });
    if (!found.executable) return { state: found.provablyMissing ? "missing" : "unavailable_now", detail: "herdr isn't installed" };
    if (!runtime.env.HC_TERMINAL_ID) return { state: "unavailable_now", executable: found.executable, detail: "you aren't working inside herdr" };
    return { state: "available", executable: found.executable };
  },
  // herdr-core's `hc ls --json` lists live terminals with their folder (cwd); focusing the
  // pane that shows one brings its tab forward. Checked with herdr 0.1.14, 2026-11-09.
  async bringForward(folder, runtime) {
    if (!runtime.env.HC_TERMINAL_ID) return undefined;
    const hc = (await findOnPath("hc", runtime)) ?? (await firstExisting([homePath(runtime, ".local", "bin", "hc"), homePath(runtime, ".local", "share", "herdr-core", "current", "Contents", "MacOS", "herdr-core")], runtime));
    const app = (await this.check(runtime)).executable;
    if (!hc || !app) return undefined;
    const { stdout } = await runtime.run(hc, ["ls", "--json"], { env: runtime.env });
    const listed = JSON.parse(stdout) as { terminals?: Array<{ address?: string; cwd?: string; state?: string; where?: string }> };
    const match = (listed.terminals ?? []).find(
      (terminal) =>
        terminal.state === "live" &&
        terminal.address !== runtime.env.HC_TERMINAL_ID &&
        typeof terminal.cwd === "string" &&
        (terminal.cwd === folder || terminal.cwd.startsWith(`${folder}${path.sep}`)),
    );
    if (!match?.address) return undefined;
    await runtime.run(app, ["do", "pane.focus", JSON.stringify({ terminal: match.address })], { env: runtime.env });
    return { where: match.where ? `the herdr tab "${match.where}"` : "the herdr tab already in the folder" };
  },
  async open(executable, launch, runtime) {
    const payload: Record<string, unknown> = { name: launch.title, folder: launch.folder, argv: ["/bin/sh", "-c", launch.line] };
    if (launch.draft) payload.task = launch.draft;
    await runtime.run(executable!, ["do", "tab.new", JSON.stringify(payload)], { env: runtime.env });
    return { where: `a new herdr tab named "${launch.title}"` };
  },
};

const tmuxPlace: TerminalPlace = {
  id: "tmux",
  kind: "terminal",
  label: "tmux window",
  platforms: ["darwin", "linux"],
  remoteOk: true,
  draft: "none",
  async check(runtime) {
    // tmux has no single install path, so it can never be proven gone.
    const found = await locateTool("tmux", runtime, { command: "tmux", knownPaths: [] });
    const executable =
      found.executable ?? (await firstExisting(["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"], runtime));
    if (!executable) return { state: "unavailable_now", detail: "tmux isn't installed" };
    if (!runtime.env.TMUX) return { state: "unavailable_now", executable, detail: "you aren't working inside tmux" };
    return { state: "available", executable };
  },
  async open(executable, launch, runtime) {
    const name = launch.title.replace(/[^\w-]+/g, "-");
    // Not detached: the new window becomes the current one, so the person is taken there.
    await runtime.run(executable!, ["new-window", "-c", launch.folder, "-n", name, "/bin/sh", "-c", launch.line], { env: runtime.env });
    return { where: `tmux window ${name}` };
  },
  async bringForward(folder, runtime) {
    if (!runtime.env.TMUX) return undefined;
    const executable = (await findOnPath("tmux", runtime)) ?? (await firstExisting(["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"], runtime));
    if (!executable) return undefined;
    const { stdout } = await runtime.run(executable, ["list-panes", "-a", "-F", "#{session_name}\t#{window_id}\t#{window_name}\t#{pane_current_path}"], { env: runtime.env });
    for (const row of stdout.split("\n")) {
      const [session, windowId, windowName, panePath] = row.split("\t");
      if (!session || !windowId || !panePath) continue;
      if (panePath !== folder && !panePath.startsWith(`${folder}${path.sep}`)) continue;
      const current = (await runtime.run(executable, ["display-message", "-p", "#{session_name}"], { env: runtime.env })).stdout.trim();
      await runtime.run(executable, ["select-window", "-t", windowId], { env: runtime.env });
      // select-window only changes what a client sees when it is in that session.
      if (current !== session) await runtime.run(executable, ["switch-client", "-t", session], { env: runtime.env });
      return { where: `tmux window ${windowName ?? windowId}` };
    }
    return undefined;
  },
};

const itermPlace: TerminalPlace = {
  id: "iterm",
  kind: "terminal",
  label: "iTerm window",
  platforms: ["darwin"],
  remoteOk: false,
  draft: "none",
  async check(runtime) {
    const app = await firstExisting([...(runtime.locations.iterm ? [runtime.locations.iterm] : []), "/Applications/iTerm.app", homePath(runtime, "Applications", "iTerm.app")], runtime);
    return app ? { state: "available", executable: app } : { state: "missing", detail: "iTerm isn't installed" };
  },
  async open(_executable, launch, runtime) {
    const command = `/bin/sh -c ${shellQuote(terminalCommand(launch))}`;
    const script = ['tell application "iTerm"', `  create window with default profile command ${appleScriptString(command)}`, "  activate", "end tell"].join("\n");
    await runtime.run("osascript", ["-e", script], { env: runtime.env });
    return { where: "a new iTerm window" };
  },
};

const terminalAppPlace: TerminalPlace = {
  id: "terminal",
  kind: "terminal",
  label: "Terminal window",
  platforms: ["darwin"],
  remoteOk: false,
  draft: "none",
  async check() {
    // Ships with macOS.
    return { state: "available" };
  },
  async open(_executable, launch, runtime) {
    const script = ['tell application "Terminal"', "  activate", `  do script ${appleScriptString(terminalCommand(launch))}`, "end tell"].join("\n");
    await runtime.run("osascript", ["-e", script], { env: runtime.env });
    return { where: "a new Terminal window" };
  },
};

// ---- apps ----

function macApp(runtime: OpenRuntime, names: string[], inner = ""): string[] {
  return names.flatMap((name) => [path.join("/Applications", name, inner), homePath(runtime, "Applications", name, inner)]);
}

const vscodePlace: AppPlace = {
  id: "vscode",
  kind: "app",
  label: "VS Code",
  platforms: ["darwin", "linux"],
  remoteOk: false,
  draft: "none",
  async check(runtime) {
    // Only VS Code's own install paths: Cursor can take over the shared `code` command.
    const known =
      runtime.platform === "darwin"
        ? macApp(runtime, ["Visual Studio Code.app"], "Contents/Resources/app/bin/code")
        : ["/usr/share/code/bin/code", "/snap/code/current/usr/share/code/bin/code", "/usr/lib/code/bin/code", "/opt/visual-studio-code/bin/code"];
    const found = await locateTool("vscode", runtime, { knownPaths: known });
    return found.executable ? { state: "available", executable: found.executable } : { state: "missing", detail: "VS Code isn't installed" };
  },
  async open(executable, launch, runtime) {
    await runtime.spawnDetached(executable, ["-n", launch.folder], { env: runtime.env });
    return { where: "a new VS Code window" };
  },
};

const cursorPlace: AppPlace = {
  id: "cursor",
  kind: "app",
  label: "Cursor",
  platforms: ["darwin", "linux"],
  remoteOk: false,
  draft: "none",
  async check(runtime) {
    const known =
      runtime.platform === "darwin"
        ? macApp(runtime, ["Cursor.app"], "Contents/Resources/app/bin/cursor")
        : ["/usr/share/cursor/bin/cursor", "/opt/Cursor/resources/app/bin/cursor", "/opt/cursor/bin/cursor"];
    const found = await locateTool("cursor", runtime, { command: "cursor", knownPaths: known });
    return found.executable ? { state: "available", executable: found.executable } : { state: "missing", detail: "Cursor isn't installed" };
  },
  async open(executable, launch, runtime) {
    // `-n` forces a new editor window, not the Agents Window or the last window.
    await runtime.spawnDetached(executable, ["-n", launch.folder], { env: runtime.env });
    return { where: "a new Cursor window" };
  },
};

// The Claude desktop app's own "New Claude Code Session Here" Finder service opens
// `claude://code/new?folder=<path>`; `q` carries a first message. The app asks the person to
// confirm the folder each time.
export function claudeDesktopUrl(folder: string, draft?: string): string {
  const params = new URLSearchParams();
  params.append("folder", folder);
  if (draft) params.set("q", draft);
  params.set("source", "weave");
  return `claude://code/new?${params.toString()}`;
}

const claudeDesktopPlace: AppPlace = {
  id: "claude-desktop",
  kind: "app",
  label: "Claude desktop app",
  platforms: ["darwin"],
  remoteOk: false,
  // Checked by hand 2026-11-10: `q=` lands in the composer unsent.
  draft: "unsent",
  async check(runtime) {
    const app = await firstExisting([...(runtime.locations["claude-desktop"] ? [runtime.locations["claude-desktop"]] : []), ...macApp(runtime, ["Claude.app"])], runtime);
    return app ? { state: "available", executable: app } : { state: "missing", detail: "the Claude desktop app isn't installed" };
  },
  async open(_executable, launch, runtime) {
    await runtime.run("open", [claudeDesktopUrl(launch.folder, launch.draft)], { env: runtime.env });
    return { where: "the Claude desktop app (confirm the folder there)" };
  },
};

// T3 Code (checked at 0.1.7, 2026-11-09) has no outside way to open a folder: its
// `t3code://` links only handle device pairing and it accepts only web pages as files. It
// stays on the list so the person's choice is honoured, and reports why it couldn't open.
const t3codePlace: AppPlace = {
  id: "t3code",
  kind: "app",
  label: "T3 Code",
  platforms: ["darwin", "linux"],
  remoteOk: false,
  hint: "add the folder as a project there",
  draft: "none",
  async check(runtime) {
    const known =
      runtime.platform === "darwin"
        ? macApp(runtime, ["T3 Code.app", "T3 Code (Beta).app"])
        : [homePath(runtime, ".local", "bin", "t3code"), "/usr/bin/t3code", "/opt/T3 Code/t3code"];
    const found = await locateTool("t3code", runtime, { knownPaths: known });
    return found.executable ? { state: "available", executable: found.executable } : { state: "missing", detail: "T3 Code isn't installed" };
  },
  async open(executable, _launch, runtime) {
    if (runtime.platform === "darwin") await runtime.run("open", ["-a", executable], { env: runtime.env });
    else await runtime.spawnDetached(executable, [], { env: runtime.env });
    throw new Error("T3 Code can't be told to open a folder yet, so it was brought up; add the folder as a project there");
  },
};

// ---- agents ----

function listedAgent(
  id: string,
  label: string,
  command: string,
  knownPaths: (runtime: OpenRuntime) => string[],
  argv: (executable: string, folder: string) => string[],
  options: { onPath?: boolean } = {},
): AgentEntry {
  return {
    id,
    label,
    draft: "none",
    async find(runtime) {
      const known = await firstExisting([...(runtime.locations[id] ? [runtime.locations[id]!] : []), ...knownPaths(runtime)], runtime);
      if (known) return known;
      return options.onPath === false ? undefined : findOnPath(command, runtime);
    },
    line(executable, folder) {
      return argv(executable!, folder).map(shellQuote).join(" ");
    },
  };
}

// Usual install locations, from each tool's install docs (checked 2026-11-09): Claude Code's
// native installer (~/.local/bin, ~/.claude/local), Homebrew (/opt/homebrew/bin on Apple
// silicon, /usr/local/bin on Intel), opencode's installer (~/.opencode/bin), and Cursor's
// agent installer (~/.local/bin/cursor-agent). npm global installs vary by Node manager, so
// those are found through PATH only.
const commonBins = (runtime: OpenRuntime, name: string): string[] => [
  homePath(runtime, ".local", "bin", name),
  "/opt/homebrew/bin/" + name,
  "/usr/local/bin/" + name,
  "/usr/bin/" + name,
];

const claudeAgent = listedAgent(
  "claude",
  "Claude",
  "claude",
  (runtime) => [homePath(runtime, ".claude", "local", "claude"), ...commonBins(runtime, "claude")],
  (executable) => [executable],
);

const codexAgent = listedAgent("codex", "Codex", "codex", (runtime) => commonBins(runtime, "codex"), (executable, folder) => [executable, "-C", folder]);

const opencodeAgent = listedAgent(
  "opencode",
  "opencode",
  "opencode",
  (runtime) => [homePath(runtime, ".opencode", "bin", "opencode"), ...commonBins(runtime, "opencode")],
  (executable, folder) => [executable, folder],
);

// Cursor's installer puts `cursor-agent` (and an `agent` alias) in ~/.local/bin. The bare
// `agent` name is shared with other tools, so only `cursor-agent` is looked up on PATH.
const cursorAgent = listedAgent(
  "cursor-agent",
  "Cursor's agent",
  "cursor-agent",
  (runtime) => commonBins(runtime, "cursor-agent"),
  (executable, folder) => [executable, "--workspace", folder],
);

const shellAgent: AgentEntry = {
  id: shellAgentId,
  label: "Just a shell",
  draft: "none",
  async find() {
    return "shell";
  },
  line() {
    return "";
  },
};

export function ownAgentEntry(name: string, command: string, label?: string): AgentEntry {
  return {
    id: name,
    label: label ?? name,
    draft: "none",
    own: true,
    async find() {
      // Not checked: the person wrote the command.
      return "own";
    },
    line() {
      return command;
    },
  };
}

export const defaultRegistry: Registry = {
  places: [herdrPlace, tmuxPlace, itermPlace, terminalAppPlace, vscodePlace, cursorPlace, claudeDesktopPlace, t3codePlace],
  agents: [claudeAgent, codexAgent, opencodeAgent, cursorAgent, shellAgent],
};

// The full shell line for a terminal: the agent, then the person's login shell, so the
// tab stays open in the folder after the agent exits.
export function terminalLine(agentLine: string): string {
  return agentLine ? `${agentLine}; ${loginShellTail}` : loginShellTail;
}

// ---- default runtime ----

export function defaultRuntime(env: NodeJS.ProcessEnv, home: string, locations: Record<string, string>): OpenRuntime {
  return {
    env,
    platform: process.platform,
    home,
    locations,
    async exists(file) {
      try {
        await access(file);
        return true;
      } catch {
        return false;
      }
    },
    run(file, args, options) {
      return new Promise((resolve, reject) => {
        execFile(file, args, { cwd: options.cwd, env: options.env }, (error, stdout) => {
          if (error) reject(error);
          else resolve({ stdout: String(stdout) });
        });
      });
    },
    async spawnDetached(file, args, options) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(file, args, { cwd: options.cwd, env: options.env, detached: true, stdio: "ignore" });
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      });
    },
  };
}
