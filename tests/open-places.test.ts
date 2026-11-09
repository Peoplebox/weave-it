import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { claudeDesktopUrl, defaultRegistry, defaultRuntime, loginShellTail, ownAgentEntry, terminalLine, type OpenRuntime, type Place } from "../src/lib/open-places.js";

const execFileAsync = promisify(execFile);

interface Recorded {
  run: Array<{ file: string; args: string[] }>;
  spawned: Array<{ file: string; args: string[] }>;
}

function runtime(options: { files?: string[]; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; locations?: Record<string, string> } = {}): OpenRuntime & { recorded: Recorded } {
  const files = new Set(options.files ?? []);
  const recorded: Recorded = { run: [], spawned: [] };
  return {
    env: { PATH: "/usr/bin:/bin", ...options.env },
    platform: options.platform ?? "darwin",
    home: "/Users/pat",
    locations: options.locations ?? {},
    recorded,
    async exists(file) {
      return files.has(file);
    },
    async run(file, args) {
      recorded.run.push({ file, args });
      return { stdout: "" };
    },
    async spawnDetached(file, args) {
      recorded.spawned.push({ file, args });
    },
  };
}

function place(id: string): Place {
  return defaultRegistry.places.find((candidate) => candidate.id === id)!;
}

function agent(id: string) {
  return defaultRegistry.agents.find((candidate) => candidate.id === id)!;
}

const hostileFolder = "/tmp/it's a $(touch pwned) `x` \"folder\"";

describe("place checks", () => {
  it("herdr: found on PATH or a known path, missing only when no absolute path exists", async () => {
    const inside = { HC_TERMINAL_ID: "t1" };
    expect((await place("herdr").check(runtime({ env: { ...inside, PATH: "/opt/x" }, files: ["/opt/x/herdr-app"] }))).state).toBe("available");
    const known = "/Users/pat/Applications/Herdr.app/Contents/MacOS/Herdr";
    // A short PATH (cron, GUI agent) still finds the known install path.
    expect(await place("herdr").check(runtime({ env: { ...inside, PATH: "" }, files: [known] }))).toEqual({ state: "available", executable: known });
    expect((await place("herdr").check(runtime({ env: inside, locations: { herdr: "/srv/herdr" }, files: ["/srv/herdr"] }))).executable).toBe("/srv/herdr");
    expect((await place("herdr").check(runtime({ env: inside }))).state).toBe("missing");
    expect((await place("herdr").check(runtime({ files: [known] }))).state).toBe("unavailable_now");
  });

  it("tmux: never provably missing, unavailable outside tmux", async () => {
    expect((await place("tmux").check(runtime())).state).toBe("unavailable_now");
    expect((await place("tmux").check(runtime({ files: ["/opt/homebrew/bin/tmux"] }))).state).toBe("unavailable_now");
    expect((await place("tmux").check(runtime({ env: { TMUX: "/tmp/s,1,0" }, files: ["/opt/homebrew/bin/tmux"] }))).state).toBe("available");
  });

  it("VS Code is never found through a `code` on PATH", async () => {
    const onlyPathCode = runtime({ env: { PATH: "/usr/local/bin" }, files: ["/usr/local/bin/code"] });
    expect((await place("vscode").check(onlyPathCode)).state).toBe("missing");
    const own = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
    expect((await place("vscode").check(runtime({ files: [own] }))).executable).toBe(own);
  });

  it("iTerm, Terminal, and the Claude desktop app are Mac places that are skipped over SSH", () => {
    for (const id of ["iterm", "terminal", "claude-desktop"]) {
      expect(place(id).platforms).toEqual(["darwin"]);
      expect(place(id).remoteOk).toBe(false);
    }
    for (const id of ["vscode", "cursor", "t3code"]) expect(place(id).remoteOk).toBe(false);
    for (const id of ["herdr", "tmux"]) expect(place(id).remoteOk).toBe(true);
    expect(place("t3code").hint).toBe("add the folder as a project there");
  });
});

describe("agents", () => {
  it("finds agents at known paths even when PATH is short", async () => {
    const rt = runtime({ env: { PATH: "" }, files: ["/Users/pat/.local/bin/claude"] });
    expect(await agent("claude").find(rt)).toBe("/Users/pat/.local/bin/claude");
    expect(await agent("codex").find(rt)).toBeUndefined();
  });

  it("does not take another tool's bare `agent` command for Cursor's agent", async () => {
    const rt = runtime({ env: { PATH: "/Users/pat/.grok/bin" }, files: ["/Users/pat/.grok/bin/agent"] });
    expect(await agent("cursor-agent").find(rt)).toBeUndefined();
  });

  it("builds each agent's command for the folder", () => {
    expect(agent("codex").line("/bin/codex", "/w/c")).toBe("/bin/codex -C /w/c");
    expect(agent("opencode").line("/bin/opencode", "/w/c")).toBe("/bin/opencode /w/c");
    expect(agent("cursor-agent").line("/bin/cursor-agent", "/w/c")).toBe("/bin/cursor-agent --workspace /w/c");
    expect(agent("claude").line("/bin/claude", "/w/c")).toBe("/bin/claude");
    expect(terminalLine(agent("shell").line(undefined, "/w/c"))).toBe(loginShellTail);
    expect(terminalLine(ownAgentEntry("pi", "pi --tui").line(undefined, "/w/c"))).toBe(`pi --tui; ${loginShellTail}`);
  });

  it("keeps hostile folder names literal when the line runs in a shell", async () => {
    const line = agent("codex").line("/bin/echo", hostileFolder);
    const { stdout } = await execFileAsync("/bin/sh", ["-c", line]);
    expect(stdout).toBe(`-C ${hostileFolder}\n`);
  });
});

describe("opening", () => {
  it("herdr opens a tab with the resolved executable, folder, and argv", async () => {
    const rt = runtime({ env: { HC_TERMINAL_ID: "t1" } });
    const herdr = place("herdr");
    if (herdr.kind !== "terminal") throw new Error("terminal expected");
    const result = await herdr.open("/x/Herdr", { folder: "/w/c", title: "261109-479a", line: terminalLine("claude") }, rt);
    expect(result.where).toBe('a new herdr tab named "261109-479a"');
    const call = rt.recorded.run[0]!;
    expect(call.file).toBe("/x/Herdr");
    expect(call.args.slice(0, 2)).toEqual(["do", "tab.new"]);
    expect(JSON.parse(call.args[2]!)).toEqual({ name: "261109-479a", folder: "/w/c", argv: ["/bin/sh", "-c", `claude; ${loginShellTail}`] });
  });

  it("tmux opens a window in the foreground (no -d)", async () => {
    const rt = runtime({ env: { TMUX: "s" } });
    const tmux = place("tmux");
    if (tmux.kind !== "terminal") throw new Error("terminal expected");
    await tmux.open("/bin/tmux", { folder: "/w/c", title: "261109 479a", line: loginShellTail }, rt);
    expect(rt.recorded.run[0]).toEqual({ file: "/bin/tmux", args: ["new-window", "-c", "/w/c", "-n", "261109-479a", "/bin/sh", "-c", loginShellTail] });
  });

  it("Terminal and iTerm scripts keep the folder literal", async () => {
    for (const id of ["terminal", "iterm"]) {
      const rt = runtime();
      const terminal = place(id);
      if (terminal.kind !== "terminal") throw new Error("terminal expected");
      await terminal.open(undefined, { folder: hostileFolder, title: "t", line: "pwd" }, rt);
      const script = rt.recorded.run[0]!.args[1]!;
      expect(rt.recorded.run[0]!.file).toBe("osascript");
      // The folder only ever appears shell-quoted inside an AppleScript string.
      expect(script).not.toContain("$(touch pwned) `x`'");
      expect(script).toContain("touch pwned");
      if (id === "terminal") {
        // Undo the AppleScript string escaping and run the command with `cd` swapped for printf.
        const quoted = /do script "((?:[^"\\]|\\.)*)"/.exec(script)![1]!.replace(/\\(.)/g, "$1");
        const { stdout } = await execFileAsync("/bin/sh", ["-c", quoted.replace(/^cd /, "printf %s ").replace(/ && pwd$/, "")]);
        expect(stdout).toBe(hostileFolder);
      }
    }
  });

  it("apps start detached with the folder as one argument", async () => {
    const rt = runtime();
    const cursor = place("cursor");
    if (cursor.kind !== "app") throw new Error("app expected");
    await cursor.open("/Applications/Cursor.app/Contents/Resources/app/bin/cursor", { folder: hostileFolder }, rt);
    expect(rt.recorded.spawned[0]).toEqual({ file: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor", args: ["-n", hostileFolder] });
  });
});

describe("apps", () => {
  it("opens the Claude desktop app through its code/new link with the folder", async () => {
    const rt = runtime();
    const claude = place("claude-desktop");
    if (claude.kind !== "app") throw new Error("app expected");
    await claude.open("/Applications/Claude.app", { folder: "/w/a b" }, rt);
    expect(rt.recorded.run[0]).toEqual({ file: "open", args: ["claude://code/new?folder=%2Fw%2Fa+b&source=weave"] });
    expect(claudeDesktopUrl("/w", "use x")).toBe("claude://code/new?folder=%2Fw&q=use+x&source=weave");
  });

  it("brings T3 Code up but reports that it couldn't open the folder", async () => {
    const rt = runtime();
    const t3 = place("t3code");
    if (t3.kind !== "app") throw new Error("app expected");
    await expect(t3.open("/Applications/T3 Code (Beta).app", { folder: "/w" }, rt)).rejects.toThrow("add the folder as a project there");
    expect(rt.recorded.run[0]).toEqual({ file: "open", args: ["-a", "/Applications/T3 Code (Beta).app"] });
    expect((await t3.check(runtime({ files: ["/Applications/T3 Code (Beta).app"] }))).state).toBe("available");
  });

  it("starts apps detached without waiting for them", async () => {
    const rt = defaultRuntime({ PATH: "/usr/bin:/bin" }, "/tmp", {});
    await expect(rt.spawnDetached("/usr/bin/true", [], { env: {} })).resolves.toBeUndefined();
    await expect(rt.spawnDetached("/nonexistent/app", [], { env: {} })).rejects.toThrow();
  });
});

