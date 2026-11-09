import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import {
  clearOpenChoice,
  customLocations,
  loadUserSettings,
  ownAgents,
  resolveSavedChoice,
  saveOpenChoice,
  SettingsError,
  userSettingsPath,
  type UserSettings,
} from "../src/lib/user-settings.js";

async function home(contents?: string): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "weave-settings-"));
  const env = { WEAVE_USER_HOME: dir };
  if (contents !== undefined) {
    await mkdir(path.join(dir, ".weave"), { recursive: true });
    await writeFile(userSettingsPath(env), contents);
  }
  return env;
}

describe("user settings", () => {
  it("lives in ~/.weave/settings.yml under WEAVE_USER_HOME", async () => {
    const env = await home();
    expect(userSettingsPath(env)).toBe(path.join(env.WEAVE_USER_HOME!, ".weave", "settings.yml"));
    expect((await loadUserSettings(env)).state).toBe("missing");
  });

  it("saves a default and a project override, keeping unknown keys", async () => {
    const env = await home(YAML.stringify({ version: 1, future: { keep: true }, open: { extra: 1 } }));
    await saveOpenChoice(env, "default", { place: "herdr", agent: "claude" });
    await saveOpenChoice(env, "project", { place: "cursor" }, "/work/acme");
    const raw = YAML.parse(await readFile(userSettingsPath(env), "utf8"));
    expect(raw.future).toEqual({ keep: true });
    expect(raw.open.extra).toBe(1);
    expect(raw.open.default).toEqual({ place: "herdr", agent: "claude" });
    expect(raw.open.projects["/work/acme"]).toEqual({ place: "cursor" });
  });

  it("saves don't-ask-again as place none with ask false", async () => {
    const env = await home();
    await saveOpenChoice(env, "default", { place: "none" });
    expect((await loadUserSettings(env)).settings.open?.default).toEqual({ place: "none", ask: false });
  });

  it("prefers the project override over the default", async () => {
    const settings = { version: 1, open: { default: { place: "herdr", agent: "claude" }, projects: { "/work/acme": { place: "cursor" } } } };
    expect(resolveSavedChoice(settings, "/work/acme")).toEqual({ choice: { place: "cursor" }, scope: "project" });
    expect(resolveSavedChoice(settings, "/work/other")).toEqual({ choice: { place: "herdr", agent: "claude" }, scope: "default" });
    expect(resolveSavedChoice({ version: 1 }, "/work/acme")).toBeUndefined();
  });

  it("clears only the named scope", async () => {
    const env = await home();
    await saveOpenChoice(env, "default", { place: "tmux", agent: "shell" });
    await saveOpenChoice(env, "project", { place: "cursor" }, "/work/acme");
    expect(await clearOpenChoice(env, "project", "/work/acme")).toBe(true);
    const after = (await loadUserSettings(env)).settings;
    expect(after.open?.default).toEqual({ place: "tmux", agent: "shell" });
    expect(after.open?.projects).toBeUndefined();
    expect(await clearOpenChoice(env, "project", "/work/acme")).toBe(false);
  });

  it("never overwrites an unreadable file or one from a newer Weave", async () => {
    const broken = await home("open: [unterminated");
    expect((await loadUserSettings(broken)).state).toBe("unreadable");
    await expect(saveOpenChoice(broken, "default", { place: "tmux" })).rejects.toBeInstanceOf(SettingsError);
    expect(await readFile(userSettingsPath(broken), "utf8")).toBe("open: [unterminated");

    const newer = await home(YAML.stringify({ version: 2, open: { default: { place: "warp" } } }));
    expect((await loadUserSettings(newer)).state).toBe("newer");
    await expect(saveOpenChoice(newer, "default", { place: "tmux" })).rejects.toBeInstanceOf(SettingsError);
  });

  it("reads own agents and absolute custom locations only", () => {
    const settings = {
      version: 1,
      agents: { pi: { command: "pi --tui", label: "pi" }, bad: { label: "x" } } as unknown as UserSettings["agents"],
      locations: { cursor: "/opt/cursor/bin/cursor", vscode: "relative/code" },
    };
    expect(ownAgents(settings)).toEqual({ pi: { command: "pi --tui", label: "pi" } });
    expect(customLocations(settings)).toEqual({ cursor: "/opt/cursor/bin/cursor" });
  });
});
