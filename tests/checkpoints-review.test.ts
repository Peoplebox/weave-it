import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { buildCheckpoints } from "../src/lib/build-checkpoints.js";
import { createChange } from "../src/lib/changes.js";
import { SnapshotBoundary } from "../src/lib/review/boundary.js";
import { boundaryKindOf, boundaryReport, CommitBoundary, reviewBoundaryFor } from "../src/lib/review/commit-boundary.js";
import { rollupChange } from "../src/lib/sliceRollup.js";

const execFileAsync = promisify(execFile);
const testNow = new Date(2026, 10, 11, 9, 0, 0);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function setup(options: { commits?: Record<string, unknown>; buildCommit?: boolean } = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "weave-review-checkpoints-"));
  await git(cwd, "init", "-b", "main");
  await git(cwd, "config", "user.name", "Test Person");
  await git(cwd, "config", "user.email", "person@example.test");
  await mkdir(path.join(cwd, ".weave"), { recursive: true });
  await writeFile(
    path.join(cwd, ".weave", "workspace.yml"),
    YAML.stringify({ version: 1, mode: "repo", name: "fixture", repos: {}, ...(options.commits ? { commits: options.commits } : {}) }),
  );
  await writeFile(path.join(cwd, "app.ts"), "export const v = 0;\n");
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-m", "initial");
  const session = path.join(cwd, ".session.yml");
  const created = await createChange({ cwd, title: "Review", now: testNow, randomId: () => "rv01", sessionPath: session });
  const branch = `change/${created.id}`;
  if ((await git(cwd, "branch", "--show-current")) !== branch) await git(cwd, "checkout", "-b", branch);
  const changePath = path.join(cwd, "wiki", "changes", created.id);
  const sliceDir = path.join(changePath, "task-slices", "01-alpha");
  await mkdir(sliceDir, { recursive: true });
  await writeFile(path.join(sliceDir, "slice.md"), "# Alpha feature\n\n## Outcome\n\nAlpha.\n");
  await writeFile(
    path.join(sliceDir, "tasks.md"),
    "| ID | Status | Execution | Repos | Owner | Title | Blocked by |\n| --- | --- | --- | --- | --- | --- | --- |\n| T1 | done | afk | root | | Build alpha | None |\n",
  );
  await writeFile(path.join(sliceDir, "status.yml"), YAML.stringify({ version: 1, id: "01-alpha", title: "Alpha feature", status: "pending", owner: "", repos: ["root"], depends_on: [], task_summary: { total: 1, done: 0, blocked: 0 }, updated_at: testNow.toISOString() }));
  await writeFile(path.join(cwd, "app.ts"), "export const v = 1;\n");
  const ctx = { weaveRoot: cwd, changeId: created.id, changePath };
  if (options.buildCommit !== false) {
    const rollup = await rollupChange({ changePath, weaveRoot: cwd });
    const built = await buildCheckpoints({ ...ctx, branch, title: "Review", rollup });
    expect(built[0]?.status).toBe(options.commits?.enabled === false ? undefined : "committed");
  }
  const mergeBase = /Weave-Merge-Base: (\w+)/.exec(await git(cwd, "log", "-1", "--format=%B"))?.[1];
  return { cwd, ctx, branch, mergeBase };
}

const repos = (cwd: string) => [{ id: "root", path: cwd }];

describe("commit-backed review boundaries", () => {
  it("points a clean slice end at the build commit and falls back to a snapshot when the tree is dirty", async () => {
    const fx = await setup();
    const boundary = await reviewBoundaryFor(fx.ctx, { sliceId: "01-alpha", repos: repos(fx.cwd) });
    expect(boundary).toBeInstanceOf(CommitBoundary);
    const head = await git(fx.cwd, "rev-parse", "HEAD");
    const end = await boundary.create({ repoPath: fx.cwd, ref: `refs/weave/reviews/${fx.ctx.changeId}/01-alpha/r1/end`, mergeBase: fx.mergeBase, force: true });
    expect(end.sha).toBe(head);
    expect(end.mergeBase).toBe(fx.mergeBase);
    expect(await boundaryKindOf(fx.cwd, `refs/weave/reviews/${fx.ctx.changeId}/01-alpha/r1/end`)).toBe("commit");
    expect(boundaryReport(boundary, repos(fx.cwd))).toEqual({ root: { kind: "commit" } });

    await writeFile(path.join(fx.cwd, "app.ts"), "export const v = 2;\n");
    const dirty = await boundary.create({ repoPath: fx.cwd, ref: `refs/weave/reviews/${fx.ctx.changeId}/01-alpha/r2/end`, mergeBase: fx.mergeBase, force: true });
    expect(dirty.sha).not.toBe(head);
    expect(await boundaryKindOf(fx.cwd, `refs/weave/reviews/${fx.ctx.changeId}/01-alpha/r2/end`)).toBe("snapshot");
    expect(boundaryReport(boundary, repos(fx.cwd))).toEqual({ root: { kind: "snapshot", reason: "uncommitted_changes" } });
  });

  it("makes a fix commit per round, continues a re-packaged round, and keeps the round patch reversible", async () => {
    const fx = await setup();
    const boundary = (await reviewBoundaryFor(fx.ctx, { sliceId: "01-alpha", repos: repos(fx.cwd) })) as CommitBoundary;
    const prefix = `refs/weave/reviews/${fx.ctx.changeId}/01-alpha/r1`;
    const start = await boundary.create({ repoPath: fx.cwd, ref: `${prefix}/round1-start`, mergeBase: fx.mergeBase, force: true });
    await writeFile(path.join(fx.cwd, "app.ts"), "export const v = 3;\n");
    boundary.setFixContext({ run: "01-alpha/r1", round: 1, scope: "slice", findings: [{ id: "01-alpha/r1-F1", detail: "Value is wrong. Use 3." }] });
    const end = await boundary.create({ repoPath: fx.cwd, ref: `${prefix}/round1-end`, mergeBase: fx.mergeBase, force: true });
    expect(end.sha).toBe(await git(fx.cwd, "rev-parse", "HEAD"));
    const message = await git(fx.cwd, "log", "-1", "--format=%B");
    expect(message.split("\n")[0]).toBe("Alpha feature: review fixes, round 1");
    expect(message).toContain("- 01-alpha/r1-F1: Value is wrong.");
    expect(message).toContain("Weave-Checkpoint: fix");
    expect(message).toContain("Weave-Round: 1");
    const patch = await boundary.patch(fx.cwd, start.sha, `${prefix}/round1-end`, { context: 3, exclude: [] });
    const patchFile = path.join(fx.cwd, "..", `round-${Date.now()}.patch`);
    await writeFile(patchFile, patch);
    await git(fx.cwd, "apply", "-R", "--check", patchFile);

    await writeFile(path.join(fx.cwd, "app.ts"), "export const v = 4;\n");
    await boundary.create({ repoPath: fx.cwd, ref: `${prefix}/round1-end`, mergeBase: fx.mergeBase, force: true });
    expect(await git(fx.cwd, "log", "-1", "--format=%s")).toBe("Alpha feature: review fixes, round 1 (continued)");
    expect(boundary.checkpoints.map((checkpoint) => checkpoint.status)).toEqual(["committed", "committed"]);
  });

  it("skips fix commits while the slice's build commit is missing", async () => {
    const fx = await setup({ buildCommit: false });
    const boundary = await reviewBoundaryFor(fx.ctx, { sliceId: "01-alpha", repos: repos(fx.cwd) });
    const before = await git(fx.cwd, "rev-parse", "HEAD");
    await boundary.create({ repoPath: fx.cwd, ref: `refs/weave/reviews/${fx.ctx.changeId}/01-alpha/r1/round1-end`, force: true });
    expect(await git(fx.cwd, "rev-parse", "HEAD")).toBe(before);
    expect(boundaryReport(boundary, repos(fx.cwd))).toEqual({ root: { kind: "snapshot", reason: "build_not_committed" } });
  });

  it("makes the final review's fix batch its own commit", async () => {
    const fx = await setup();
    const boundary = (await reviewBoundaryFor(fx.ctx, { change: true, repos: repos(fx.cwd) })) as CommitBoundary;
    await writeFile(path.join(fx.cwd, "app.ts"), "export const v = 5;\n");
    boundary.setFixContext({ run: "change/f1", round: 1, scope: "change", findings: [] });
    await boundary.create({ repoPath: fx.cwd, ref: `refs/weave/reviews/${fx.ctx.changeId}/_change/f1/fix-end`, mergeBase: fx.mergeBase, force: true });
    const message = await git(fx.cwd, "log", "-1", "--format=%B");
    expect(message.split("\n")[0]).toBe("Final review fixes");
    expect(message).toContain("Weave-Checkpoint: final-fix");
  });

  it("uses snapshots when commits are off", async () => {
    const fx = await setup({ commits: { enabled: false }, buildCommit: false });
    expect(await reviewBoundaryFor(fx.ctx, { sliceId: "01-alpha", repos: repos(fx.cwd) })).toBeInstanceOf(SnapshotBoundary);
  });
});
