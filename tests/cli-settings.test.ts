import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { settingsOpen } from "../src/commands/settings.js";
import { openFixture, readSettings, runCli, tmuxCalls, writeSettings } from "./helpers/open-fixture.js";

describe("weave settings open", () => {
  it("saves and clears the default and a project override without a terminal, opening nothing", async () => {
    const fixture = await openFixture();
    const saved = JSON.parse((await runCli(fixture, fixture.project, ["settings", "open", "--in", "tmux", "--agent", "codex", "--json"], { inTmux: true })).stdout);
    expect(saved).toMatchObject({ status: "ok", scope: "default", saved: { place: "tmux", agent: "codex" } });
    await runCli(fixture, fixture.project, ["settings", "open", "--in", "cursor", "--project"]);
    let settings = await readSettings(fixture);
    expect(settings.open.default).toEqual({ place: "tmux", agent: "codex" });
    expect(settings.open.projects[fixture.project]).toEqual({ place: "cursor" });

    const cleared = await runCli(fixture, fixture.project, ["settings", "open", "--clear", "--project"]);
    expect(cleared.stdout).toContain("Cleared where changes open for this project");
    settings = await readSettings(fixture);
    expect(settings.open.default).toEqual({ place: "tmux", agent: "codex" });
    expect(settings.open.projects).toBeUndefined();

    await runCli(fixture, fixture.project, ["settings", "open", "--clear"]);
    expect((await readSettings(fixture)).open.default).toBeUndefined();
    expect(await tmuxCalls(fixture)).toEqual([]);
  });

  it("saves don't-ask-again for --in none", async () => {
    const fixture = await openFixture();
    await runCli(fixture, fixture.project, ["settings", "open", "--in", "none"]);
    expect((await readSettings(fixture)).open.default).toEqual({ place: "none", ask: false });
  });

  it("lists the current settings and choices with --json or without a terminal", async () => {
    const fixture = await openFixture();
    await writeSettings(fixture, { version: 1, open: { default: { place: "tmux", agent: "shell" } }, keep: "me" });
    const json = JSON.parse((await runCli(fixture, fixture.project, ["settings", "open", "--json"], { inTmux: true })).stdout);
    expect(json.current.default).toEqual({ place: "tmux", agent: "shell" });
    expect(json.choices.map((choice: { place: string }) => choice.place)).toContain("tmux");
    const text = await runCli(fixture, fixture.project, ["settings", "open"], { inTmux: true });
    expect(text.stdout).toContain("Default for every project: tmux with shell");
    expect((await readSettings(fixture)).keep).toBe("me");
  });

  it("rejects invalid ids and conflicting flags, leaving settings unchanged", async () => {
    const fixture = await openFixture();
    await writeSettings(fixture, { version: 1, open: { default: { place: "tmux" } } });
    for (const [args, code] of [
      [["--in", "warp"], "unknown_place"],
      [["--in", "vscode", "--agent", "claude"], "agent_not_for_app"],
      [["--in", "tmux", "--clear"], "conflicting_flags"],
      [["--agent", "claude"], "agent_needs_place"],
    ] as const) {
      const result = await runCli(fixture, fixture.project, ["settings", "open", ...args, "--json"]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).code).toBe(code);
    }
    expect((await readSettings(fixture)).open.default).toEqual({ place: "tmux" });
  });

  it("shows the menu at a real terminal with the current choice and saves the answer", async () => {
    const fixture = await openFixture();
    const env = { WEAVE_USER_HOME: fixture.home, PATH: `${fixture.bin}:/usr/bin:/bin`, TMUX: "/tmp/x,1,0" };
    await mkdir(path.join(fixture.home, ".weave"), { recursive: true });
    await writeFile(path.join(fixture.home, ".weave", "settings.yml"), YAML.stringify({ version: 1, open: { default: { place: "tmux", agent: "shell" } } }));
    let seenCurrent: unknown;
    const result = await settingsOpen({}, {
      interactive: true,
      cwd: fixture.project,
      env,
      prompt: async (_choices, current) => {
        seenCurrent = current;
        return { place: "tmux", agent: "claude" };
      },
    });
    expect(seenCurrent).toEqual({ place: "tmux", agent: "shell" });
    expect(result.saved).toEqual({ place: "tmux", agent: "claude" });
    expect((await readSettings(fixture)).open.default).toEqual({ place: "tmux", agent: "claude" });
  });
});
