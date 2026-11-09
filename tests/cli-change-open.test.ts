import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createChange } from "../src/lib/changes.js";
import { openFixture, readSettings, runCli, tmuxCalls, writeSettings, type OpenFixture } from "./helpers/open-fixture.js";

async function withChange(): Promise<{ fixture: OpenFixture; id: string; folder: string }> {
  const fixture = await openFixture();
  process.env.WEAVE_NO_BACKGROUND_REFRESH = "1";
  const created = await createChange({ cwd: fixture.project, title: "Add export", randomId: () => "ab12", sessionPath: `${fixture.base}/session.yml` });
  return { fixture, id: created.id, folder: created.folder! };
}

describe("weave change open", () => {
  it("returns needs_choice with choices in --json when there is no default, and opens nothing", async () => {
    const { fixture, id } = await withChange();
    const result = await runCli(fixture, fixture.project, ["change", "open", id, "--json"], { inTmux: true });
    const json = JSON.parse(result.stdout);
    expect(json.open.status).toBe("needs_choice");
    expect(json.open.choices.map((choice: { place: string }) => choice.place)).toContain("tmux");
    expect(json.next_step).toBe(`use the weave-next skill for change ${id}`);
    expect(await tmuxCalls(fixture)).toEqual([]);
  });

  it("opens in tmux with --in, saves with --remember, and reuses the default", async () => {
    const { fixture, id, folder } = await withChange();
    const first = JSON.parse((await runCli(fixture, fixture.project, ["change", "open", id, "--in", "tmux", "--agent", "shell", "--remember", "--json"], { inTmux: true })).stdout);
    expect(first.open).toMatchObject({ status: "opened", place: "tmux", saved: "default" });
    expect((await readSettings(fixture)).open.default).toEqual({ place: "tmux", agent: "shell" });

    const second = await runCli(fixture, fixture.project, ["change", "open", id], { inTmux: true });
    expect(second.stdout).toContain(`Opened in tmux window ${id.split("-").slice(0, 2).join("-")}, continue there.`);
    expect(second.stdout).toContain("Change where changes open: weave settings open");
    // The saved default first looks for a window already in the folder, then opens one.
    const calls = (await tmuxCalls(fixture)).filter((call) => call[0] === "new-window");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.slice(0, 3)).toEqual(["new-window", "-c", folder]);
    expect(calls[1]).not.toContain("-d");
  });

  it("saves a per-project override keyed by the main checkout, the same from a change folder", async () => {
    const { fixture, id, folder } = await withChange();
    await runCli(fixture, folder, ["change", "open", id, "--in", "tmux", "--project", "--json"], { inTmux: true });
    const settings = await readSettings(fixture);
    expect(Object.keys(settings.open.projects)).toEqual([fixture.project]);
  });

  it("records don't-ask-again and then shows today's line", async () => {
    const { fixture, id, folder } = await withChange();
    await runCli(fixture, fixture.project, ["change", "open", id, "--in", "none", "--remember"]);
    const result = await runCli(fixture, fixture.project, ["change", "open", id], { inTmux: true });
    expect(result.stdout).toBe(`Open ${folder} in a new session to work on this change.\n`);
  });

  it("lists choices without opening anything", async () => {
    const { fixture, id } = await withChange();
    const json = JSON.parse((await runCli(fixture, fixture.project, ["change", "open", id, "--choices", "--json"], { inTmux: true })).stdout);
    expect(json.choices.at(-1)).toEqual({ place: "none", kind: "none", label: "Don't open" });
    expect(await tmuxCalls(fixture)).toEqual([]);
  });

  it("fails with folder_missing when the change has no folder here", async () => {
    const { fixture, id, folder } = await withChange();
    await rm(folder, { recursive: true, force: true });
    const result = await runCli(fixture, fixture.project, ["change", "open", id, "--json"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: "folder_missing" });
    expect(JSON.parse(result.stdout).message).toContain(`weave change switch ${id}`);
  });

  it("does not claim a folder is missing for a reference that just doesn't match", async () => {
    const { fixture, id } = await withChange();
    // A date-plus-token prefix is not a change reference; the folder still exists.
    const result = await runCli(fixture, fixture.project, ["change", "open", id.split("-").slice(0, 2).join("-"), "--json"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).code).toBe("change_not_found");
    const byToken = JSON.parse((await runCli(fixture, fixture.project, ["change", "open", id.split("-")[1]!, "--json"], { noOpen: true })).stdout);
    expect(byToken.id).toBe(id);
  });

  it("rejects bad flags with codes", async () => {
    const { fixture, id } = await withChange();
    for (const [args, code] of [
      [["--in", "warp"], "unknown_place"],
      [["--in", "cursor", "--agent", "claude"], "agent_not_for_app"],
      [["--in", "tmux", "--agent", "gemini"], "unknown_agent"],
      [["--agent", "claude"], "agent_needs_place"],
    ] as const) {
      const result = await runCli(fixture, fixture.project, ["change", "open", id, ...args, "--json"]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).code).toBe(code);
    }
  });

  it("never opens anything when WEAVE_NO_OPEN is set, even with a default", async () => {
    const { fixture, id } = await withChange();
    await writeSettings(fixture, { version: 1, open: { default: { place: "tmux", agent: "shell" } } });
    const json = JSON.parse((await runCli(fixture, fixture.project, ["change", "open", id, "--json"], { inTmux: true, noOpen: true })).stdout);
    expect(json.open).toMatchObject({ status: "not_attempted", reason: "disabled" });
    expect(await tmuxCalls(fixture)).toEqual([]);
  });
});
