import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { buildCheckpoints, parseTaskRows, sliceCoverage } from "../src/lib/build-checkpoints.js";
import { createChange } from "../src/lib/changes.js";
import { rollupChange } from "../src/lib/sliceRollup.js";

const execFileAsync = promisify(execFile);
const testNow = new Date(2026, 10, 11, 9, 0, 0);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

interface Fixture {
  cwd: string;
  changePath: string;
  changeId: string;
  branch: string;
}

function tasksMd(rows: Array<[string, string, string]>): string {
  return [
    "# Tasks",
    "",
    "## Active Task Index",
    "",
    "| ID | Status | Execution | Repos | Owner | Title | Blocked by |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(([id, status, title]) => `| ${id} | ${status} | afk | root | | ${title} | None |`),
    "",
  ].join("\n");
}

async function writeSlice(fx: Fixture, id: string, title: string, rows: Array<[string, string, string]>): Promise<void> {
  const dir = path.join(fx.changePath, "task-slices", id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "slice.md"), `# ${title}\n\n## Outcome\n\nDelivers ${title.toLowerCase()}.\n\n## User flow\n\n1. Step.\n`);
  await writeFile(path.join(dir, "tasks.md"), tasksMd(rows));
  await writeFile(
    path.join(dir, "status.yml"),
    YAML.stringify({ version: 1, id, title, status: "pending", owner: "", repos: ["root"], depends_on: [], task_summary: { total: rows.length, done: 0, blocked: 0 }, updated_at: testNow.toISOString() }),
  );
  // Distinct modification times decide which slice finished last.
  await new Promise((resolve) => setTimeout(resolve, 15));
}

async function setup(): Promise<Fixture> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "weave-build-checkpoints-"));
  await git(cwd, "init", "-b", "main");
  await git(cwd, "config", "user.name", "Test Person");
  await git(cwd, "config", "user.email", "person@example.test");
  await mkdir(path.join(cwd, ".weave"), { recursive: true });
  await writeFile(path.join(cwd, ".weave", "workspace.yml"), YAML.stringify({ version: 1, mode: "repo", name: "fixture", repos: {} }));
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-m", "initial");
  const session = path.join(cwd, ".session.yml");
  const created = await createChange({ cwd, title: "Build", now: testNow, randomId: () => "bd01", sessionPath: session });
  const branch = `change/${created.id}`;
  if ((await git(cwd, "branch", "--show-current")) !== branch) await git(cwd, "checkout", "-b", branch);
  const fx = { cwd, changePath: path.join(cwd, "wiki", "changes", created.id), changeId: created.id, branch };
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-m", "planning");
  return fx;
}

async function rollupAndBuild(fx: Fixture, env?: NodeJS.ProcessEnv) {
  const rollup = await rollupChange({ changePath: fx.changePath, weaveRoot: fx.cwd });
  return buildCheckpoints({ weaveRoot: fx.cwd, changeId: fx.changeId, changePath: fx.changePath, branch: fx.branch, title: "Build", rollup, ...(env ? { env } : {}) });
}

describe("build checkpoints", () => {
  it("commits a finished slice once, with its purpose, tasks, and trailers, excluding other changes and guidelines", async () => {
    const fx = await setup();
    await writeSlice(fx, "01-alpha", "Alpha feature", [["T1", "done", "Build alpha"], ["T2", "done", "Verify alpha"]]);
    await writeSlice(fx, "02-beta", "Beta feature", [["T1", "todo", "Build beta"]]);
    await writeFile(path.join(fx.cwd, "alpha.ts"), "export const alpha = 1;\n");
    await mkdir(path.join(fx.cwd, "wiki", "changes", "other-change"), { recursive: true });
    await writeFile(path.join(fx.cwd, "wiki", "changes", "other-change", "prd.md"), "# other\n");
    await writeFile(path.join(fx.cwd, ".weave", "coding-guidelines.md"), "# mine\n");

    const outcomes = await rollupAndBuild(fx);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: "committed", kind: "build", slice: "01-alpha", repo: "root" });
    expect(outcomes[0]?.files).toContain("alpha.ts");
    expect(outcomes[0]?.files).not.toContain("wiki/changes/other-change/prd.md");
    expect(outcomes[0]?.files).not.toContain(".weave/coding-guidelines.md");
    const message = await git(fx.cwd, "log", "-1", "--format=%B");
    expect(message.split("\n")[0]).toBe("Alpha feature");
    expect(message).toContain("Delivers alpha feature.");
    expect(message).toContain("- T1: Build alpha");
    expect(message).toContain("Weave-Slice: 01-alpha");
    expect(message).toContain(`Weave-Coverage: ${sliceCoverage(parseTaskRows(tasksMd([["T1", "done", "Build alpha"], ["T2", "done", "Verify alpha"]])))}`);
    expect(message).toContain("Weave-Checkpoint: build");
    expect(await git(fx.cwd, "status", "--porcelain")).toContain("wiki/changes/other-change/");

    expect(await rollupAndBuild(fx)).toEqual([]);
  });

  it("commits not_tested readiness, and commits again when the slice is finished again", async () => {
    const fx = await setup();
    await writeSlice(fx, "01-alpha", "Alpha feature", [["T1", "not_tested", "Build alpha"]]);
    await writeFile(path.join(fx.cwd, "alpha.ts"), "1\n");
    expect((await rollupAndBuild(fx))[0]?.status).toBe("committed");

    await writeSlice(fx, "01-alpha", "Alpha feature", [["T1", "not_tested", "Build alpha"], ["T2", "in_progress", "More alpha"]]);
    await writeFile(path.join(fx.cwd, "alpha.ts"), "2\n");
    expect(await rollupAndBuild(fx)).toEqual([]);

    await writeSlice(fx, "01-alpha", "Alpha feature", [["T1", "done", "Build alpha"], ["T2", "done", "More alpha"]]);
    const again = await rollupAndBuild(fx);
    expect(again[0]).toMatchObject({ status: "committed", subject: "Alpha feature (additional work)" });
  });

  it("reports a hook rejection, retries at the next rollup, and lets a later slice carry the leftovers", async () => {
    const fx = await setup();
    const hook = path.join(fx.cwd, ".git", "hooks", "pre-commit");
    await mkdir(path.dirname(hook), { recursive: true });
    await writeFile(hook, "#!/bin/sh\necho 'lint failed' >&2\nexit 1\n");
    await chmod(hook, 0o755);
    await writeSlice(fx, "01-alpha", "Alpha feature", [["T1", "done", "Build alpha"]]);
    await writeSlice(fx, "02-beta", "Beta feature", [["T1", "todo", "Build beta"]]);
    await writeFile(path.join(fx.cwd, "alpha.ts"), "1\n");

    const failed = await rollupAndBuild(fx);
    expect(failed[0]).toMatchObject({ status: "failed", reason: "hooks_rejected" });
    expect(failed[0]?.detail).toContain("lint failed");

    // Retried while no other slice has started.
    expect((await rollupAndBuild(fx))[0]).toMatchObject({ status: "failed", slice: "01-alpha" });

    // Slice 02 starts: slice 01 is no longer retried on its own.
    await writeSlice(fx, "02-beta", "Beta feature", [["T1", "in_progress", "Build beta"]]);
    expect(await rollupAndBuild(fx)).toEqual([]);

    await rm(hook);
    await writeSlice(fx, "02-beta", "Beta feature", [["T1", "done", "Build beta"]]);
    await writeFile(path.join(fx.cwd, "beta.ts"), "2\n");
    const carried = await rollupAndBuild(fx);
    expect(carried[0]).toMatchObject({ status: "committed", slice: "02-beta", leftovers_from: "01-alpha" });
    expect(carried[0]?.files).toEqual(expect.arrayContaining(["alpha.ts", "beta.ts"]));
    expect(await git(fx.cwd, "log", "-1", "--format=%B")).toContain("Weave-Includes: 01-alpha:");
    expect(await rollupAndBuild(fx)).toEqual([]);
  });

  it("does not build-commit from unattended sessions", async () => {
    const fx = await setup();
    await writeSlice(fx, "01-alpha", "Alpha feature", [["T1", "done", "Build alpha"]]);
    const before = await git(fx.cwd, "rev-parse", "HEAD");
    const outcomes = await rollupAndBuild(fx, { ...process.env, WEAVE_UNATTENDED: "1" });
    expect(outcomes).toEqual([{ status: "skipped", kind: "build", slice: "01-alpha", reason: "unattended" }]);
    expect(await git(fx.cwd, "rev-parse", "HEAD")).toBe(before);
  });
});
