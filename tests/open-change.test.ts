import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it, vi } from "vitest";
import {
  canPrompt,
  placeOpenLines,
  readStoredNextStep,
  resolveNextStep,
  composeNextStep,
  formatOpenLines,
  openChange,
  replacesOpenLine,
  sanitizeContext,
  validateExplicitChoice,
  type OpenContext,
} from "../src/lib/open-change.js";
import type { OpenRuntime } from "../src/lib/open-places.js";
import { userSettingsPath } from "../src/lib/user-settings.js";

const herdrApp = "/Users/pat/Applications/Herdr.app/Contents/MacOS/Herdr";
const tmuxBin = "/opt/homebrew/bin/tmux";
const claudeBin = "/Users/pat/.local/bin/claude";

interface Fake extends OpenRuntime {
  calls: Array<{ file: string; args: string[] }>;
}

function fakeRuntime(options: { files?: string[]; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; hang?: boolean; fail?: string; panes?: string; session?: string; herdrTerminals?: string } = {}): Fake {
  const files = new Set(options.files ?? [herdrApp, tmuxBin, claudeBin]);
  const calls: Fake["calls"] = [];
  return {
    env: { PATH: "", ...options.env },
    platform: options.platform ?? "darwin",
    home: "/Users/pat",
    locations: {},
    calls,
    async exists(file) {
      return files.has(file);
    },
    async run(file, args) {
      calls.push({ file, args });
      if (args[0] === "list-panes") return { stdout: options.panes ?? "" };
      if (args[0] === "ls" && args[1] === "--json") return { stdout: options.herdrTerminals ?? '{"terminals":[]}' };
      if (args[0] === "display-message") return { stdout: `${options.session ?? "main"}\n` };
      if (options.hang) return new Promise(() => undefined);
      if (options.fail) throw new Error(options.fail);
      return { stdout: "" };
    },
    async spawnDetached(file, args) {
      calls.push({ file, args });
    },
  };
}

async function setup(settings?: unknown): Promise<{ env: NodeJS.ProcessEnv; folder: string; cwd: string }> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-open-")));
  const env: NodeJS.ProcessEnv = { WEAVE_USER_HOME: path.join(base, "home") };
  if (settings !== undefined) {
    await mkdir(path.dirname(userSettingsPath(env)), { recursive: true });
    await writeFile(userSettingsPath(env), typeof settings === "string" ? settings : YAML.stringify(settings));
  }
  const folder = path.join(base, "acme.changes", "261109-ab12-thing");
  const cwd = path.join(base, "acme");
  await mkdir(folder, { recursive: true });
  await mkdir(cwd, { recursive: true });
  return { env, folder, cwd };
}

function context(s: { env: NodeJS.ProcessEnv; folder: string; cwd: string }, runtime: Fake, extra: Partial<OpenContext> = {}): OpenContext {
  return {
    changeId: "261109-ab12-thing",
    folder: s.folder,
    cwd: s.cwd,
    mainRoot: s.cwd,
    json: true,
    interactive: false,
    env: { ...s.env, ...runtime.env },
    runtime,
    ...extra,
  };
}

async function savedSettings(env: NodeJS.ProcessEnv): Promise<Record<string, any>> {
  return YAML.parse(await readFile(userSettingsPath(env), "utf8"));
}

const insideTmux = { TMUX: "/tmp/tmux,1,0" };
const insideHerdr = { HC_TERMINAL_ID: "t1" };

describe("openChange resolution", () => {
  it("does nothing when disabled, in place, or --no-open", async () => {
    const s = await setup({ version: 1, open: { default: { place: "tmux", agent: "claude" } } });
    const rt = fakeRuntime({ env: insideTmux });
    expect((await openChange({ ...context(s, rt), env: { ...s.env, WEAVE_NO_OPEN: "1" } })).open.reason).toBe("disabled");
    expect((await openChange(context(s, rt, { inPlace: true }))).open.reason).toBe("in_place");
    expect((await openChange(context(s, rt, { noOpen: true }))).open).toMatchObject({ status: "not_attempted", reason: "no_open_flag" });
    expect(rt.calls).toEqual([]);
  });

  it("opens a one-off choice without saving it, and saves it with remember", async () => {
    const s = await setup();
    const rt = fakeRuntime({ env: insideTmux });
    const once = await openChange(context(s, rt, { explicit: { place: "tmux", agent: "claude" } }));
    expect(once.open).toMatchObject({ status: "opened", place: "tmux", agent: "claude", saved: null, used_default: false, draft: "shown" });
    expect(once.open.where).toBe("tmux window 261109-ab12 with Claude");
    expect(rt.calls[0]!.args).toEqual(["new-window", "-c", s.folder, "-n", "261109-ab12", "/bin/sh", "-c", `/Users/pat/.local/bin/claude; exec "\${SHELL:-/bin/sh}" -l`]);

    const saved = await openChange(context(s, rt, { explicit: { place: "tmux", agent: "claude" }, remember: "default" }));
    expect(saved.open.saved).toBe("default");
    expect((await savedSettings(s.env)).open.default).toEqual({ place: "tmux", agent: "claude" });

    await openChange(context(s, rt, { explicit: { place: "tmux", agent: "shell" }, remember: "project" }));
    expect((await savedSettings(s.env)).open.projects[s.cwd]).toEqual({ place: "tmux", agent: "shell" });
  });

  it("records don't-ask-again for --in none --remember and honours it afterwards", async () => {
    const s = await setup();
    const rt = fakeRuntime({ env: insideTmux });
    expect((await openChange(context(s, rt, { explicit: { place: "none" }, remember: "default" }))).open).toMatchObject({ reason: "dont_ask", saved: "default" });
    expect((await openChange(context(s, rt))).open).toMatchObject({ status: "not_attempted", reason: "dont_ask" });
    expect(rt.calls).toEqual([]);
  });

  it("uses a saved default without asking, and a project override first", async () => {
    const s = await setup({ version: 1, open: { default: { place: "herdr", agent: "claude" } } });
    const rt = fakeRuntime({ env: { ...insideTmux, ...insideHerdr } });
    const result = await openChange(context(s, rt));
    expect(result.open).toMatchObject({ status: "opened", place: "herdr", used_default: true });
    expect(rt.calls.at(-1)!.file).toBe(herdrApp);

    const s2 = await setup({ version: 1, open: { default: { place: "herdr", agent: "claude" } } });
    const projectKey = s2.cwd;
    await writeFile(userSettingsPath(s2.env), YAML.stringify({ version: 1, open: { default: { place: "herdr" }, projects: { [projectKey]: { place: "tmux", agent: "shell" } } } }));
    const rt2 = fakeRuntime({ env: { ...insideTmux, ...insideHerdr } });
    expect((await openChange(context(s2, rt2))).open).toMatchObject({ place: "tmux", used_default: true });
  });

  it("keeps a default found at its install path even when PATH is empty", async () => {
    const s = await setup({ version: 1, open: { default: { place: "herdr", agent: "claude" } } });
    const rt = fakeRuntime({ env: { ...insideHerdr, PATH: "" } });
    expect((await openChange(context(s, rt))).open.status).toBe("opened");
    expect((await savedSettings(s.env)).open.default).toEqual({ place: "herdr", agent: "claude" });
  });

  it("clears a default whose tool is gone from every install path, then asks", async () => {
    const s = await setup({ version: 1, open: { default: { place: "herdr", agent: "claude" } }, other: true });
    const rt = fakeRuntime({ env: insideHerdr, files: [claudeBin] });
    const result = await openChange(context(s, rt));
    expect(result.open).toMatchObject({ status: "needs_choice", reason: "default_missing" });
    expect(result.open.detail).toContain("isn't installed any more");
    const after = await savedSettings(s.env);
    expect(after.open?.default).toBeUndefined();
    expect(after.other).toBe(true);
  });

  it("keeps the default when the place is unavailable now, the agent is missing, or opening fails", async () => {
    for (const [runtime, status, reason] of [
      [fakeRuntime({ env: {} }), "skipped", "unavailable_now"],
      // tmux has no install path to prove it gone, so a PATH miss is never "missing".
      [fakeRuntime({ env: insideTmux, files: [claudeBin] }), "skipped", "unavailable_now"],
      [fakeRuntime({ env: insideTmux, files: [tmuxBin] }), "failed", "agent_not_found"],
      [fakeRuntime({ env: insideTmux, fail: "boom\nmore" }), "failed", "open_failed"],
    ] as const) {
      const s = await setup({ version: 1, open: { default: { place: "tmux", agent: "claude" } } });
      const result = await openChange(context(s, runtime));
      expect(result.open).toMatchObject({ status, reason });
      expect((await savedSettings(s.env)).open.default).toEqual({ place: "tmux", agent: "claude" });
    }
  });

  it("times out a hanging opener and keeps the default", async () => {
    const s = await setup({ version: 1, open: { default: { place: "tmux", agent: "claude" } } });
    const result = await openChange(context(s, fakeRuntime({ env: insideTmux, hang: true }), { timeouts: { open: 20 } }));
    expect(result.open).toMatchObject({ status: "failed", reason: "timeout" });
    expect(result.open.detail).toContain("Automation");
    expect((await savedSettings(s.env)).open.default).toEqual({ place: "tmux", agent: "claude" });
  });

  it("never touches saved values this Weave doesn't recognise", async () => {
    for (const settings of [
      { version: 1, open: { default: { place: "warp" } } },
      { version: 1, open: { default: { place: "tmux", agent: "gemini" } } },
      { version: 2, open: { default: { place: "tmux" } } },
    ]) {
      const s = await setup(settings);
      const before = await readFile(userSettingsPath(s.env), "utf8");
      const result = await openChange(context(s, fakeRuntime({ env: insideTmux })));
      expect(result.open).toMatchObject({ status: "not_attempted", reason: "unknown_saved_value" });
      expect(await readFile(userSettingsPath(s.env), "utf8")).toBe(before);
    }
  });

  it("reports an unreadable settings file without overwriting it", async () => {
    const s = await setup("open: [broken");
    const result = await openChange(context(s, fakeRuntime({ env: insideTmux })));
    expect(result.open).toMatchObject({ status: "failed", detail: "settings.yml could not be read" });
    expect(await readFile(userSettingsPath(s.env), "utf8")).toBe("open: [broken");
  });

  it("hands the choices back when nobody can be asked", async () => {
    const s = await setup();
    const result = await openChange(context(s, fakeRuntime({ env: insideTmux })));
    expect(result.open.status).toBe("needs_choice");
    const places = result.open.choices!.map((choice) => choice.place);
    // herdr is installed but we aren't inside it; Terminal ships with macOS.
    expect(places).toEqual(["tmux", "terminal", "none"]);
    expect(result.open.choices![0]!.agents).toEqual([
      { id: "claude", label: "Claude" },
      { id: "shell", label: "Just a shell" },
    ]);
  });

  it("asks at a real terminal after printing the summary, and saves the answer", async () => {
    const s = await setup();
    const order: string[] = [];
    const prompt = vi.fn(async () => {
      order.push("prompt");
      return { place: "tmux", agent: "shell", remember: true };
    });
    const result = await openChange(
      context(s, fakeRuntime({ env: insideTmux }), { json: false, interactive: true, prompt, beforePrompt: () => order.push("summary") }),
    );
    expect(order).toEqual(["summary", "prompt"]);
    expect(result.open).toMatchObject({ status: "opened", saved: "default" });
    expect((await savedSettings(s.env)).open.default).toEqual({ place: "tmux", agent: "shell" });
  });

  it("opens just this once without saving when the person doesn't make it their default", async () => {
    const s = await setup();
    const rt = fakeRuntime({ env: insideTmux });
    let asked: unknown;
    const once = await openChange(
      context(s, rt, {
        json: false,
        interactive: true,
        prompt: async (_choices, _current, options) => {
          asked = options;
          return { place: "tmux", agent: "shell", remember: false };
        },
      }),
    );
    expect(asked).toEqual({ askRemember: true });
    expect(once.open).toMatchObject({ status: "opened", saved: null });
    await expect(readFile(userSettingsPath(s.env), "utf8")).rejects.toThrow();
  });

  it("does not save a plain don't-open answer, but saves don't-ask-again", async () => {
    const s = await setup();
    const rt = fakeRuntime({ env: insideTmux });
    const plain = await openChange(context(s, rt, { json: false, interactive: true, prompt: async () => ({ place: "none", dontAsk: false }) }));
    expect(plain.open.reason).toBe("no_choice");
    await expect(readFile(userSettingsPath(s.env), "utf8")).rejects.toThrow();
    await openChange(context(s, rt, { json: false, interactive: true, prompt: async () => ({ place: "none", dontAsk: true }) }));
    expect((await savedSettings(s.env)).open.default).toEqual({ place: "none", ask: false });
  });

  it("opens nothing from inside the change folder unless a place is named", async () => {
    const s = await setup({ version: 1, open: { default: { place: "tmux", agent: "claude" } } });
    const rt = fakeRuntime({ env: insideTmux });
    expect((await openChange(context(s, rt, { cwd: path.join(s.folder) }))).open.reason).toBe("already_inside");
    expect(rt.calls).toEqual([]);
    expect((await openChange(context(s, rt, { cwd: s.folder, explicit: { place: "tmux" } }))).open.status).toBe("opened");
  });

  it("skips Mac windows over SSH but still opens tmux", async () => {
    const s = await setup({ version: 1, open: { default: { place: "terminal", agent: "claude" } } });
    const ssh = { SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" };
    const result = await openChange(context(s, fakeRuntime({ env: ssh })));
    expect(result.open).toMatchObject({ status: "skipped", reason: "ssh" });
    expect((await savedSettings(s.env)).open.default.place).toBe("terminal");
    expect((await openChange(context(s, fakeRuntime({ env: { ...ssh, ...insideTmux } }), { explicit: { place: "tmux" } }))).open.status).toBe("opened");
  });
});

describe("helpers", () => {
  it("shows the menu only for text output at a terminal with no agent marker", () => {
    expect(canPrompt({ json: false, interactive: true, env: {} })).toBe(true);
    expect(canPrompt({ json: true, interactive: true, env: {} })).toBe(false);
    expect(canPrompt({ json: false, interactive: false, env: {} })).toBe(false);
    for (const marker of ["CLAUDECODE", "CURSOR_AGENT", "OPENCODE", "CODEX_SANDBOX", "CODEX_THREAD_ID", "WEAVE_NO_PROMPT"]) {
      expect(canPrompt({ json: false, interactive: true, env: { [marker]: "1" } })).toBe(false);
    }
  });

  it("composes the next step and sanitises context", () => {
    expect(composeNextStep("261109-ab12-x")).toBe("use the weave-next skill for change 261109-ab12-x");
    expect(composeNextStep("261109-ab12-x", "weave-explore", "CSV\nexport \u001b[31mfor\u0007 reports")).toBe(
      "use the weave-explore skill for change 261109-ab12-x: CSV export for reports",
    );
    expect(sanitizeContext("x".repeat(2000))).toHaveLength(500);
  });

  it("validates flags before anything is created", async () => {
    await expect(validateExplicitChoice({ place: "warp" })).rejects.toMatchObject({ code: "unknown_place" });
    await expect(validateExplicitChoice({ place: "cursor", agent: "claude" })).rejects.toMatchObject({ code: "agent_not_for_app" });
    await expect(validateExplicitChoice({ place: "tmux", agent: "gemini" })).rejects.toMatchObject({ code: "unknown_agent" });
    await expect(validateExplicitChoice({ place: "tmux", agent: "codex" })).resolves.toBeUndefined();
  });

  it("formats outcome lines and only replaces the Open line when something happened", () => {
    const opened = { next_step: "use x", step_given: false, open: { status: "opened" as const, where: "a new herdr tab", draft: "shown" as const, used_default: true, saved: null } };
    expect(formatOpenLines(opened, "/f")).toEqual([
      "Opened in a new herdr tab, continue there.",
      "Next step: use x",
      "If it didn't start: open /f and run the step there.",
      "Change where changes open: weave settings open",
    ]);
    expect(replacesOpenLine(opened)).toBe(true);
    const none = { next_step: "use x", step_given: false, open: { status: "needs_choice" as const, reason: "no_choice" as const, draft: "shown" as const, used_default: false, saved: null } };
    expect(formatOpenLines(none, "/f")).toEqual(["Open /f in a new session to work on this change."]);
    expect(replacesOpenLine(none)).toBe(false);
  });
});

describe("bring forward", () => {
  const pane = (folder: string, session = "main") => `${session}\t@7\tthing\t${folder}/src\n`;

  it("brings forward a tmux pane already in the folder once a default resolves", async () => {
    const s = await setup({ version: 1, open: { default: { place: "cursor" } } });
    const cursorApp = "/Applications/Cursor.app/Contents/Resources/app/bin/cursor";
    const rt = fakeRuntime({ env: insideTmux, panes: pane(s.folder, "work"), session: "main", files: [tmuxBin, cursorApp] });
    const result = await openChange(context(s, rt));
    expect(result.open).toMatchObject({ status: "brought_forward", place: "tmux", where: "tmux window thing", used_default: true });
    expect(rt.calls.map((call) => call.args[0])).toEqual(["list-panes", "display-message", "select-window", "switch-client"]);
  });

  it("stays in the same session without switch-client", async () => {
    const s = await setup({ version: 1, open: { default: { place: "tmux", agent: "claude" } } });
    const rt = fakeRuntime({ env: insideTmux, panes: pane(s.folder, "main") });
    await openChange(context(s, rt));
    expect(rt.calls.map((call) => call.args[0])).toEqual(["list-panes", "display-message", "select-window"]);
  });

  it("never runs for no choice, don't ask, --no-open, or an explicit place", async () => {
    for (const [settings, extra] of [
      [undefined, {}],
      [{ version: 1, open: { default: { place: "none", ask: false } } }, {}],
      [{ version: 1, open: { default: { place: "tmux" } } }, { noOpen: true }],
      [{ version: 1, open: { default: { place: "tmux" } } }, { explicit: { place: "tmux", agent: "shell" } }],
    ] as const) {
      const s = await setup(settings);
      const rt = fakeRuntime({ env: insideTmux, panes: pane(s.folder) });
      await openChange(context(s, rt, extra as Partial<OpenContext>));
      expect(rt.calls.map((call) => call.args[0])).not.toContain("list-panes");
    }
  });

  it("opens normally when listing panes fails or times out", async () => {
    const s = await setup({ version: 1, open: { default: { place: "tmux", agent: "claude" } } });
    const rt = fakeRuntime({ env: insideTmux, panes: "garbage" });
    expect((await openChange(context(s, rt))).open.status).toBe("opened");
  });
});

describe("next step", () => {
  it("stores a given step and reuses it until the stage moves on", async () => {
    const s = await setup();
    const changePath = path.join(s.folder, "wiki", "changes", "261109-ab12-thing");
    await mkdir(changePath, { recursive: true });
    await writeFile(path.join(changePath, "status.yml"), YAML.stringify({ id: "261109-ab12-thing", stage: "exploration" }));
    const base = { changeId: "261109-ab12-thing", changePath, stage: "exploration" };
    expect(await resolveNextStep({ ...base, skill: "weave-explore", context: "CSV export" })).toEqual({
      text: "use the weave-explore skill for change 261109-ab12-thing: CSV export",
      given: true,
    });
    expect(await readStoredNextStep(changePath)).toEqual({ text: "use the weave-explore skill for change 261109-ab12-thing: CSV export", stage: "exploration" });
    expect((await resolveNextStep(base)).text).toContain("weave-explore");
    expect(await resolveNextStep({ ...base, stage: "prd" })).toEqual({ text: "use the weave-next skill for change 261109-ab12-thing", given: false });
    // Stale entries are ignored, not deleted.
    expect(await readStoredNextStep(changePath)).toBeDefined();
    expect((await resolveNextStep({ ...base, stage: "prd", skill: "weave-architect" })).text).toContain("weave-architect");
    expect((await readStoredNextStep(changePath))!.stage).toBe("prd");
  });
});

describe("placing the outcome", () => {
  it("replaces the Open line in place and keeps later lines after it", () => {
    const folder = "/w/acme.changes/x";
    const message = ["Change: x", "", `Folder: ${folder}`, "", `Open ${folder} in a new session to work on this change.`, "", "Slot changed: 1 was taken, so this folder now uses slot 2."].join("\n");
    const opened = { next_step: "use y", step_given: false, open: { status: "opened" as const, where: "tmux window x", draft: "shown" as const, used_default: false, saved: null } };
    expect(placeOpenLines(message, folder, opened).split("\n")).toEqual([
      "Change: x",
      "",
      `Folder: ${folder}`,
      "",
      "Opened in tmux window x, continue there.",
      "Next step: use y",
      `If it didn't start: open ${folder} and run the step there.`,
      "",
      "Slot changed: 1 was taken, so this folder now uses slot 2.",
    ]);
    const untouched = { ...opened, open: { ...opened.open, status: "needs_choice" as const, reason: "no_choice" as const } };
    expect(placeOpenLines(message, folder, untouched)).toBe(message);
  });
});

describe("terminals and agents", () => {
  it("offers only Linux places on Linux and drops Mac windows and apps over SSH", async () => {
    const s = await setup();
    const linux = await openChange(context(s, fakeRuntime({ env: { ...insideTmux, DISPLAY: ":0" }, platform: "linux" })));
    expect(linux.open.choices!.map((choice) => choice.place)).toEqual(["tmux", "none"]);
    const ssh = await openChange(context(s, fakeRuntime({ env: { ...insideTmux, SSH_TTY: "/dev/ttys001" }, files: [tmuxBin, claudeBin, "/Applications/iTerm.app"] })));
    expect(ssh.open.choices!.map((choice) => choice.place)).toEqual(["tmux", "none"]);
  });

  it("lists the person's own agents and opens them with their command, without a draft", async () => {
    const s = await setup({ version: 1, agents: { pi: { command: "pi --tui", label: "pi" } } });
    const rt = fakeRuntime({ env: insideTmux });
    const choices = (await openChange(context(s, rt))).open.choices!;
    expect(choices[0]!.agents).toContainEqual({ id: "pi", label: "pi", own: true });
    const opened = await openChange(context(s, rt, { explicit: { place: "tmux", agent: "pi" } }));
    expect(opened.open).toMatchObject({ status: "opened", agent: "pi", draft: "shown" });
    expect(rt.calls.at(-1)!.args.at(-1)).toBe('pi --tui; exec "${SHELL:-/bin/sh}" -l');
  });

  it("opens Terminal with Codex on a Mac", async () => {
    const s = await setup();
    const rt = fakeRuntime({ files: ["/opt/homebrew/bin/codex"] });
    const result = await openChange(context(s, rt, { explicit: { place: "terminal", agent: "codex" } }));
    expect(result.open).toMatchObject({ status: "opened", where: "a new Terminal window with Codex" });
    expect(rt.calls[0]!.file).toBe("osascript");
    expect(rt.calls[0]!.args[1]).toContain(`/opt/homebrew/bin/codex -C ${s.folder}`);
  });

  it("uses a custom install location for a listed tool", async () => {
    const s = await setup({ version: 1, locations: { iterm: "/Volumes/Apps/iTerm.app" } });
    const result = await openChange(context(s, fakeRuntime({ files: ["/Volumes/Apps/iTerm.app"] }), { explicit: { place: "iterm" } }));
    expect(result.open.status).toBe("opened");
  });
});

describe("apps", () => {
  const linuxCursor = "/usr/share/cursor/bin/cursor";

  it("skips apps over SSH on Linux and with no display, keeping the default", async () => {
    for (const [env, reason] of [
      [{ SSH_CONNECTION: "a b c d", DISPLAY: ":0" }, "ssh"],
      [{}, "no_display"],
    ] as const) {
      const s = await setup({ version: 1, open: { default: { place: "cursor" } } });
      const result = await openChange(context(s, fakeRuntime({ env, platform: "linux", files: [linuxCursor] })));
      expect(result.open).toMatchObject({ status: "skipped", reason });
      expect((await savedSettings(s.env)).open.default).toEqual({ place: "cursor" });
    }
  });

  it("opens Cursor on Linux with a display", async () => {
    const s = await setup({ version: 1, open: { default: { place: "cursor" } } });
    const rt = fakeRuntime({ env: { WAYLAND_DISPLAY: "wayland-0" }, platform: "linux", files: [linuxCursor] });
    const result = await openChange(context(s, rt));
    expect(result.open).toMatchObject({ status: "opened", where: "a new Cursor window", draft: "shown" });
    expect(rt.calls.at(-1)).toEqual({ file: linuxCursor, args: ["-n", s.folder] });
  });

  it("reports T3 Code's limit as a failure that keeps the default", async () => {
    const s = await setup({ version: 1, open: { default: { place: "t3code" } } });
    const result = await openChange(context(s, fakeRuntime({ files: ["/Applications/T3 Code (Beta).app"] })));
    expect(result.open).toMatchObject({ status: "failed", reason: "open_failed" });
    expect(result.open.detail).toContain("add the folder as a project there");
    expect((await savedSettings(s.env)).open.default).toEqual({ place: "t3code" });
  });
});

describe("herdr bring forward", () => {
  const hcBin = "/Users/pat/.local/bin/hc";

  it("focuses a live herdr terminal already in the folder", async () => {
    const s = await setup({ version: 1, open: { default: { place: "herdr", agent: "claude" } } });
    const terminals = JSON.stringify({
      terminals: [
        { address: "t1", cwd: s.folder, state: "live", where: "me / 1" },
        { address: "t7", cwd: `${s.folder}/src`, state: "live", where: "thing / 2" },
      ],
    });
    const rt = fakeRuntime({ env: insideHerdr, files: [herdrApp, hcBin, claudeBin], herdrTerminals: terminals });
    const result = await openChange(context(s, rt));
    expect(result.open).toMatchObject({ status: "brought_forward", place: "herdr", where: 'the herdr tab "thing / 2"', used_default: true });
    expect(rt.calls.at(-1)).toEqual({ file: herdrApp, args: ["do", "pane.focus", '{"terminal":"t7"}'] });
  });

  it("opens a new tab when no herdr terminal is in the folder or hc is missing", async () => {
    const s = await setup({ version: 1, open: { default: { place: "herdr", agent: "claude" } } });
    const elsewhere = JSON.stringify({ terminals: [{ address: "t7", cwd: "/somewhere/else", state: "live" }] });
    const rt = fakeRuntime({ env: insideHerdr, files: [herdrApp, hcBin, claudeBin], herdrTerminals: elsewhere });
    expect((await openChange(context(s, rt))).open.status).toBe("opened");
    const noHc = fakeRuntime({ env: insideHerdr, files: [herdrApp, claudeBin] });
    expect((await openChange(context(s, noHc))).open.status).toBe("opened");
  });
});

describe("unsent drafts", () => {
  const claudeApp = "/Applications/Claude.app";

  it("fills in the Claude desktop app's first message without sending it", async () => {
    const s = await setup({ version: 1, open: { default: { place: "claude-desktop" } } });
    const rt = fakeRuntime({ files: [claudeApp] });
    const result = await openChange(context(s, rt, { skill: "weave-explore", context: `it's "quoted" $(rm -rf /) \n here` }));
    expect(result.open).toMatchObject({ status: "opened", draft: "unsent" });
    const url = new URL(rt.calls.at(-1)!.args[0]!);
    expect(url.searchParams.getAll("folder")).toEqual([s.folder]);
    expect(url.searchParams.get("q")).toBe(result.next_step);
    expect(result.next_step).toContain(`$(rm -rf /)`);
    expect(formatOpenLines(result, s.folder)[1]).toBe(`Next step: ${result.next_step} (filled in, not sent)`);
  });

  it("keeps every other place and agent at shown", async () => {
    const s = await setup();
    const rt = fakeRuntime({ env: { ...insideTmux, ...insideHerdr } });
    for (const explicit of [{ place: "herdr", agent: "claude" }, { place: "tmux", agent: "claude" }]) {
      const result = await openChange(context(s, rt, { explicit, skill: "weave-explore" }));
      expect(result.open).toMatchObject({ status: "opened", draft: "shown" });
    }
    const herdrCall = rt.calls.find((call) => call.args[1] === "tab.new")!;
    expect(JSON.parse(herdrCall.args[2]!).task).toBeUndefined();
  });

  it("opens without the draft when opening with it fails", async () => {
    const s = await setup({ version: 1, open: { default: { place: "claude-desktop" } } });
    let calls = 0;
    const rt = fakeRuntime({ files: [claudeApp] });
    const flaky: typeof rt = {
      ...rt,
      async run(file, args, options) {
        calls += 1;
        if (args[0]?.includes("q=")) throw new Error("link too long");
        return rt.run(file, args, options);
      },
    };
    const result = await openChange(context(s, flaky, { skill: "weave-explore" }));
    expect(calls).toBe(2);
    expect(result.open).toMatchObject({ status: "opened", draft: "shown" });
    expect(formatOpenLines(result, s.folder)[1]).toBe(`Next step: ${result.next_step}`);
  });
});

