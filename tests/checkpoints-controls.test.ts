import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { settingsCommits } from "../src/commands/settings.js";
import { createChange, progressChange, setChangeCommitsSkipped } from "../src/lib/changes.js";
import { resolveCommitSettings } from "../src/lib/checkpoints.js";

const execFileAsync = promisify(execFile);
const testNow = new Date(2026, 10, 11, 9, 0, 0);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function setup(): Promise<{ cwd: string; session: string; changePath: string; changeId: string; home: string }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "weave-checkpoint-controls-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "weave-checkpoint-home-"));
  await git(cwd, "init", "-b", "main");
  await git(cwd, "config", "user.name", "Test Person");
  await git(cwd, "config", "user.email", "person@example.test");
  await mkdir(path.join(cwd, ".weave"), { recursive: true });
  await writeFile(path.join(cwd, ".weave", "workspace.yml"), YAML.stringify({ version: 1, mode: "repo", name: "fixture", repos: {} }));
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-m", "initial");
  const session = path.join(cwd, ".session.yml");
  const created = await createChange({ cwd, title: "Controls", now: testNow, randomId: () => "ct01", sessionPath: session });
  const branch = `change/${created.id}`;
  if ((await git(cwd, "branch", "--show-current")) !== branch) await git(cwd, "checkout", "-b", branch);
  return { cwd, session, changePath: path.join(cwd, "wiki", "changes", created.id), changeId: created.id, home };
}

describe("checkpoint switches", () => {
  it("a personal off switch stops commits, for every project or this one", async () => {
    const fx = await setup();
    const env = { ...process.env, WEAVE_USER_HOME: fx.home };
    const off = await settingsCommits("off", { project: true }, { cwd: fx.cwd, env });
    expect(off).toMatchObject({ scope: "project", enabled: false });
    const settings = YAML.parse(await readFile(path.join(fx.home, ".weave", "settings.yml"), "utf8")) as Record<string, any>;
    expect(Object.values(settings.commits.projects)).toEqual([{ enabled: false }]);
    const before = await git(fx.cwd, "rev-parse", "HEAD");
    const result = await progressChange({ cwd: fx.cwd, stage: "exploration", sessionPath: fx.session, env });
    expect(result.checkpoint).toMatchObject({ status: "skipped", reason: "commits_off_personal" });
    expect(await git(fx.cwd, "rev-parse", "HEAD")).toBe(before);

    await settingsCommits("on", { project: true }, { cwd: fx.cwd, env });
    await settingsCommits("off", {}, { cwd: fx.cwd, env });
    // The project-scoped "on" beats the default "off".
    expect((await resolveCommitSettings({ weaveRoot: fx.cwd, changePath: fx.changePath }, env)).enabled).toBe(true);
    await expect(settingsCommits("maybe", {}, { cwd: fx.cwd, env })).rejects.toThrow(/on or off/);
  });

  it("a per-change skip stops commits until unskipped", async () => {
    const fx = await setup();
    const skipped = await setChangeCommitsSkipped({ cwd: fx.cwd, skip: true, reason: "hand-made history", sessionPath: fx.session });
    expect(skipped.skipped?.reason).toBe("hand-made history");
    const result = await progressChange({ cwd: fx.cwd, stage: "exploration", sessionPath: fx.session });
    expect(result.checkpoint).toMatchObject({ status: "skipped", reason: "change_skipped" });
    await setChangeCommitsSkipped({ cwd: fx.cwd, skip: false, sessionPath: fx.session });
    const resumed = await progressChange({ cwd: fx.cwd, stage: "exploration", sessionPath: fx.session });
    expect(resumed.checkpoint?.status).toBe("committed");
    await expect(setChangeCommitsSkipped({ cwd: fx.cwd, skip: true, sessionPath: fx.session })).rejects.toThrow(/--reason/);
  });

  it("a project off switch in the main checkout reaches change folders", async () => {
    const fx = await setup();
    await git(fx.cwd, "add", "-A");
    await git(fx.cwd, "commit", "-m", "planning");
    await git(fx.cwd, "checkout", "main");
    const folder = await mkdtemp(path.join(os.tmpdir(), "weave-checkpoint-folder-"));
    await git(fx.cwd, "worktree", "add", path.join(folder, "wt"), `change/${fx.changeId}`);
    const worktree = path.join(folder, "wt");
    const changePath = path.join(worktree, "wiki", "changes", fx.changeId);
    expect((await resolveCommitSettings({ weaveRoot: worktree, changePath })).enabled).toBe(true);
    await writeFile(path.join(fx.cwd, ".weave", "workspace.yml"), YAML.stringify({ version: 1, mode: "repo", name: "fixture", repos: {}, commits: { enabled: false } }));
    expect(await resolveCommitSettings({ weaveRoot: worktree, changePath })).toMatchObject({ enabled: false, offReason: "commits_off_project" });
  });

  it("an unreadable personal settings file is a warning, not a blocker", async () => {
    const fx = await setup();
    await mkdir(path.join(fx.home, ".weave"), { recursive: true });
    await writeFile(path.join(fx.home, ".weave", "settings.yml"), "commits: [unclosed\n");
    const settings = await resolveCommitSettings({ weaveRoot: fx.cwd, changePath: fx.changePath }, { ...process.env, WEAVE_USER_HOME: fx.home });
    expect(settings).toMatchObject({ enabled: true, warnings: ["settings_unreadable"] });
  });
});

describe("first-commit notice and runs", () => {
  it("shows the notice once, and only an attended command marks it delivered", async () => {
    const fx = await setup();
    const unattended = await progressChange({ cwd: fx.cwd, stage: "exploration", sessionPath: fx.session, env: { ...process.env, WEAVE_UNATTENDED: "1" } });
    expect(unattended.checkpoint?.notice).toBe("commits_enabled");
    const first = await progressChange({ cwd: fx.cwd, stage: "exploration", sessionPath: fx.session });
    expect(first.checkpoint?.notice).toBe("commits_enabled");
    expect(first.message).toContain("weave settings commits off");
    const second = await progressChange({ cwd: fx.cwd, stage: "exploration", sessionPath: fx.session });
    expect(second.checkpoint?.notice).toBeUndefined();
  });

  it("records a failed planning commit on the run it finishes", async () => {
    const { startChangeRun } = await import("../src/lib/changes.js");
    const fx = await setup();
    const run = await startChangeRun({ cwd: fx.cwd, lane: "research", skill: "weave-research", agent: "test", sessionPath: fx.session });
    await writeFile(path.join(fx.cwd, ".git", "index.lock"), "");
    await writeFile(path.join(fx.changePath, "research.md"), "# Research\n");
    const result = await progressChange({ cwd: fx.cwd, stage: "research", sessionPath: fx.session });
    expect(result.checkpoint).toMatchObject({ status: "failed", reason: "index_locked" });
    const status = YAML.parse(await readFile(path.join(fx.changePath, "status.yml"), "utf8")) as { runs: Array<Record<string, any>> };
    const recorded = status.runs.find((entry) => entry.id === run.run.id);
    expect(recorded).toMatchObject({ result: "succeeded", checkpoint: { status: "failed", reason: "index_locked" } });
  });
});
