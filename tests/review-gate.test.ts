import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewCommand } from "../src/commands/review.js";
import { createChange } from "../src/lib/changes.js";
import { evaluateGate } from "../src/lib/review/gate.js";
import type { ReviewContext } from "../src/lib/review/state.js";

const execFileAsync = promisify(execFile);
const testNow = new Date(2026, 10, 10, 10, 0, 0);
const originalCwd = process.cwd();
const originalSessionEnv = process.env.WEAVE_SESSION_PATH;
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Weave Test",
  GIT_AUTHOR_EMAIL: "weave@example.com",
  GIT_COMMITTER_NAME: "Weave Test",
  GIT_COMMITTER_EMAIL: "weave@example.com",
};

afterEach(() => {
  process.chdir(originalCwd);
  if (originalSessionEnv === undefined) {
    delete process.env.WEAVE_SESSION_PATH;
  } else {
    process.env.WEAVE_SESSION_PATH = originalSessionEnv;
  }
  process.exitCode = undefined;
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv });
  return stdout.trim();
}

async function write(root: string, file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
}

function tasksMarkdown(status: string): string {
  return [
    "# Tasks",
    "",
    "## Active Task Index",
    "",
    "| ID | Status | Execution | Repos | Owner | Title | Blocked by |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    `| T1 | ${status} | afk | root | | Task T1 | None |`,
    "",
    "### T1: Task T1",
    "",
    `Status: ${status}`,
    "Repos: root",
    "Files:",
    "- `src/a.ts` (M)",
    "",
  ].join("\n");
}

// A repo-mode Weave root with review installed and a change that already adopted review, so a
// finished slice without a review reads `not_reviewed`.
async function setup(options: { skipped?: boolean } = {}): Promise<ReviewContext> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-review-gate-")));
  await write(root, ".weave/workspace.yml", YAML.stringify({ version: 1, mode: "repo", name: "fixture", repos: {} }));
  await write(root, ".weave/agents.yml", YAML.stringify({ version: 1, installed: { claude: { skills: { "weave-review": { path: ".claude/skills/weave-review/SKILL.md" } } } } }));
  await write(root, ".gitignore", "/.session.yml\n");
  await write(root, "src/a.ts", "export const a = 1;\n");
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "initial"]);
  const session = path.join(root, ".session.yml");
  const created = await createChange({ cwd: root, title: "Gate", now: testNow, randomId: () => "gt08", sessionPath: session });
  const changePath = path.join(root, "wiki", "changes", created.id);
  const statusPath = path.join(changePath, "status.yml");
  const status = YAML.parse(await readFile(statusPath, "utf8")) as Record<string, unknown>;
  status.review = { adopted_at: testNow.toISOString(), ...(options.skipped ? { skipped: { reason: "docs only", at: testNow.toISOString() } } : {}) };
  await writeFile(statusPath, YAML.stringify(status));
  process.env.WEAVE_SESSION_PATH = session;
  process.chdir(root);
  return { weaveRoot: root, changeId: created.id, changePath };
}

async function addSlice(ctx: ReviewContext, id: string, options: { tasks?: string; review?: Record<string, unknown> } = {}): Promise<void> {
  const slicePath = path.join(ctx.changePath, "task-slices", id);
  await write(
    slicePath,
    "status.yml",
    YAML.stringify({
      version: 1,
      id,
      title: id,
      status: "done",
      owner: "",
      repos: ["root"],
      depends_on: [],
      task_summary: { total: 1, done: 1, blocked: 0 },
      ...(options.review ? { review: options.review } : {}),
    }),
  );
  await write(slicePath, "slice.md", `# ${id}\n`);
  await write(slicePath, "tasks.md", tasksMarkdown(options.tasks ?? "done"));
}

async function runGate(): Promise<{ result: Record<string, any>; text: string; exitCode: number | undefined }> {
  const capture = async (json: boolean): Promise<string> => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      chunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    try {
      const command = reviewCommand();
      command.exitOverride();
      await command.parseAsync(["gate", "--change", ...(json ? ["--json"] : [])], { from: "user" });
    } finally {
      spy.mockRestore();
    }
    return chunks.join("");
  };
  const json = await capture(true);
  const text = await capture(false);
  const exitCode = process.exitCode === undefined ? undefined : Number(process.exitCode);
  process.exitCode = undefined;
  return { result: JSON.parse(json) as Record<string, any>, text, exitCode };
}

describe("evaluateGate", () => {
  it("passes when every slice is reviewed, reviewed with rulings, or predates review", async () => {
    const ctx = await setup();
    await addSlice(ctx, "01-a", { review: { state: "reviewed" } });
    await addSlice(ctx, "02-b", { review: { state: "reviewed_with_rulings" } });
    await addSlice(ctx, "03-c", { review: { state: "predates_review" } });

    const gate = await evaluateGate(ctx);
    expect(gate).toMatchObject({ status: "ok", pass: true, blocking: [], flat: false });

    const cli = await runGate();
    expect(cli.exitCode).toBeUndefined();
    expect(cli.result).toMatchObject({ status: "ok", pass: true, blocking: [] });
    expect(cli.text).toContain("gate: pass");
  });

  it("blocks on not reviewed, in review, waiting on a person, and review failed, each with its reason", async () => {
    const ctx = await setup();
    await addSlice(ctx, "01-ok", { review: { state: "reviewed" } });
    await addSlice(ctx, "02-none");
    await addSlice(ctx, "03-in", { review: { state: "in_review", latest_run: "r1" } });
    await addSlice(ctx, "04-wait", { review: { state: "waiting_on_person", latest_run: "r1" } });
    await addSlice(ctx, "05-failed", { review: { state: "review_failed", latest_run: "r1" } });
    await addSlice(ctx, "06-open", { tasks: "in_progress" });

    const gate = await evaluateGate(ctx);
    expect(gate.pass).toBe(false);
    expect(gate.blocking).toEqual([
      { slice: "02-none", effective_state: "not_reviewed", reasons: ["not_reviewed"] },
      { slice: "03-in", effective_state: "in_review", reasons: ["in_review"] },
      { slice: "04-wait", effective_state: "waiting_on_person", reasons: ["waiting_on_person"] },
      { slice: "05-failed", effective_state: "review_failed", reasons: ["review_failed"] },
      { slice: "06-open", effective_state: "not_ready_for_review", reasons: ["not_ready_for_review"] },
    ]);

    // The gate's answer is in `pass`: the command still exits 0.
    const cli = await runGate();
    expect(cli.exitCode).toBeUndefined();
    expect(cli.result.pass).toBe(false);
    expect(cli.text).toContain("gate: blocked");
    expect(cli.text).toContain("04-wait: waiting on person");
  });

  it("blocks on a reviewed slice that is out of date, naming the reasons", async () => {
    const ctx = await setup();
    await addSlice(ctx, "01-stale", {
      review: { state: "reviewed", fingerprint: { root: { "src/a.ts": "0000000000000000000000000000000000000000" } }, reviewed_task_total: 1 },
    });
    const gate = await evaluateGate(ctx);
    expect(gate.pass).toBe(false);
    expect(gate.blocking).toEqual([{ slice: "01-stale", effective_state: "out_of_date", reasons: ["code_changed"] }]);
    expect((await runGate()).text).toContain("01-stale: out of date (code changed)");
  });

  it("lets skipped slices pass only when the change itself is skipped", async () => {
    const reviewed = await setup();
    await addSlice(reviewed, "01-skip", { review: { state: "skipped" } });
    const blocked = await evaluateGate(reviewed);
    expect(blocked.pass).toBe(false);
    expect(blocked.blocking).toEqual([{ slice: "01-skip", effective_state: "skipped", reasons: ["skipped_while_change_reviewed"] }]);

    const skipped = await setup({ skipped: true });
    await addSlice(skipped, "01-skip", { review: { state: "skipped" } });
    const passed = await evaluateGate(skipped);
    expect(passed).toMatchObject({ pass: true, blocking: [], change_skipped: true });
  });

  it("passes a flat change, which has no slices to wait for", async () => {
    const ctx = await setup();
    await write(ctx.changePath, "tasks.md", tasksMarkdown("done"));
    expect(await evaluateGate(ctx)).toMatchObject({ pass: true, blocking: [], flat: true });
    expect((await runGate()).text).toContain("flat change");
  });

  it("stamps slices finished before adoption as predates review, so they pass", async () => {
    const ctx = await setup();
    const statusPath = path.join(ctx.changePath, "status.yml");
    const status = YAML.parse(await readFile(statusPath, "utf8")) as Record<string, unknown>;
    delete status.review;
    await writeFile(statusPath, YAML.stringify(status));
    await addSlice(ctx, "01-old");
    const gate = await evaluateGate(ctx);
    expect(gate.pass).toBe(true);
    const slice = YAML.parse(await readFile(path.join(ctx.changePath, "task-slices", "01-old", "status.yml"), "utf8")) as Record<string, any>;
    expect(slice.review.state).toBe("predates_review");
  });

  it("rejects gate without --change", async () => {
    await setup();
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      const command = reviewCommand();
      command.exitOverride();
      await command.parseAsync(["gate", "--json"], { from: "user" });
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(chunks.join(""))).toMatchObject({ status: "error", code: "invalid_arguments" });
    expect(process.exitCode).toBe(1);
  });
});
