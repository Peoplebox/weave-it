import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { git, openFixture, readSettings, runCli, tmuxCalls, writeSettings, type OpenFixture } from "./helpers/open-fixture.js";

async function newChange(fixture: OpenFixture, args: string[], options: Parameters<typeof runCli>[3] = {}) {
  const result = await runCli(fixture, fixture.project, ["change", "new", ...args, "--json"], options);
  return { ...result, json: JSON.parse(result.stdout) };
}

async function changeBranches(fixture: OpenFixture): Promise<string[]> {
  return (await git(fixture.project, ["branch", "--list", "change/*"])).split("\n").filter(Boolean);
}

describe("change new opens the change", () => {
  it("keeps today's output with no default and nobody to ask", async () => {
    const fixture = await openFixture();
    const text = await runCli(fixture, fixture.project, ["change", "new", "Plain"], { inTmux: true });
    const lines = text.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^Created change: \d{6}-[a-z0-9]{4}-plain$/);
    expect(lines.at(-1)).toMatch(/^Open .*\.changes\/\d{6}-[a-z0-9]{4}-plain in a new session to work on this change\.$/);
    expect(text.stdout).not.toContain("Next step");
    const { json } = await newChange(fixture, ["Plain json"], { inTmux: true });
    expect(json.open.status).toBe("needs_choice");
    expect(json.message.split("\n").at(-1)).toBe(`Open ${json.folder} in a new session to work on this change.`);
    // A script inside tmux with no default never touches tmux.
    expect(await tmuxCalls(fixture)).toEqual([]);
  });

  it("opens with the default, puts the outcome where the Open line was, and stores the first step", async () => {
    const fixture = await openFixture();
    await writeSettings(fixture, { version: 1, open: { default: { place: "tmux", agent: "shell" } } });
    const result = await runCli(fixture, fixture.project, ["change", "new", "Add export", "--skill", "weave-explore", "--context", "CSV export for reports"], { inTmux: true });
    const id = /Created change: (\S+)/.exec(result.stdout)![1]!;
    expect(result.stdout).toContain("Opened in tmux window");
    expect(result.stdout).toContain(`Next step: use the weave-explore skill for change ${id}: CSV export for reports`);
    expect(result.stdout).not.toContain("in a new session to work on this change");
    const folder = /Folder: (\S+)/.exec(result.stdout)![1]!;
    const statusPath = path.join(folder, "wiki", "changes", id, "status.yml");
    expect(YAML.parse(await readFile(statusPath, "utf8")).next_step).toEqual({
      text: `use the weave-explore skill for change ${id}: CSV export for reports`,
      stage: "exploration",
    });

    // Reopening right after keeps the same step; once the stage moves on, weave-next.
    const reopen = JSON.parse((await runCli(fixture, fixture.project, ["change", "open", id, "--json"], { inTmux: true })).stdout);
    expect(reopen.next_step).toContain("weave-explore");
    const status = YAML.parse(await readFile(statusPath, "utf8"));
    await writeFile(statusPath, YAML.stringify({ ...status, stage: "prd" }));
    const later = JSON.parse((await runCli(fixture, fixture.project, ["change", "open", id, "--json"], { inTmux: true })).stdout);
    expect(later.next_step).toBe(`use the weave-next skill for change ${id}`);
  });

  it("fails bad open flags before anything is created", async () => {
    const fixture = await openFixture();
    for (const [flags, code] of [
      [["--open", "warp"], "unknown_place"],
      [["--open", "cursor:claude"], "agent_not_for_app"],
      [["--open", "tmux:gemini"], "unknown_agent"],
    ] as const) {
      const result = await newChange(fixture, ["Nope", ...flags]);
      expect(result.exitCode).toBe(1);
      expect(result.json.code).toBe(code);
    }
    expect(await changeBranches(fixture)).toEqual([]);
  });

  it("follows one-off flags without changing the default", async () => {
    const fixture = await openFixture();
    await writeSettings(fixture, { version: 1, open: { default: { place: "tmux", agent: "shell" } } });
    const skipped = await newChange(fixture, ["Skip it", "--no-open"], { inTmux: true });
    expect(skipped.json.open).toMatchObject({ status: "not_attempted", reason: "no_open_flag" });
    expect(await tmuxCalls(fixture)).toEqual([]);

    await rm(path.join(fixture.home, ".weave", "settings.yml"));
    const once = await newChange(fixture, ["Once", "--open", "tmux:shell"], { inTmux: true });
    expect(once.json.open).toMatchObject({ status: "opened", saved: null, used_default: false });
    await expect(readSettings(fixture)).rejects.toThrow();
  });
});

describe("change switch opens the change", () => {
  it("opens nothing from inside the change folder and shows the next step", async () => {
    const fixture = await openFixture();
    await writeSettings(fixture, { version: 1, open: { default: { place: "tmux", agent: "shell" } } });
    const created = await newChange(fixture, ["Inside", "--no-open"], { inTmux: true });
    const result = await runCli(fixture, created.json.folder, ["change", "switch", created.json.id], { inTmux: true });
    expect(result.stdout).toContain(`Next step: use the weave-next skill for change ${created.json.id}`);
    expect(result.stdout).not.toContain("Opened in");
    expect(await tmuxCalls(fixture)).toEqual([]);
  });

  it("brings forward a tmux window already in the folder", async () => {
    const fixture = await openFixture();
    await writeSettings(fixture, { version: 1, open: { default: { place: "tmux", agent: "shell" } } });
    const created = await newChange(fixture, ["Forward", "--no-open"], { inTmux: true });
    await writeFile(fixture.panes, `work\t@3\tforward\t${created.json.folder}\n`);
    const result = JSON.parse((await runCli(fixture, fixture.project, ["change", "switch", created.json.id, "--json"], { inTmux: true })).stdout);
    expect(result.open).toMatchObject({ status: "brought_forward", where: "tmux window forward" });
    const calls = (await tmuxCalls(fixture)).map((call) => call[0]);
    expect(calls).toEqual(["list-panes", "display-message", "select-window", "switch-client"]);
  });

  it("keeps today's switch output with no default", async () => {
    const fixture = await openFixture();
    const created = await newChange(fixture, ["Switch plain"]);
    const result = await runCli(fixture, fixture.project, ["change", "switch", created.json.id]);
    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe(`Open ${created.json.folder} in a new session to work on this change.`);
  });
});
