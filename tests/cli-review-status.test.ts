import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewCommand } from "../src/commands/review.js";
import { createChange } from "../src/lib/changes.js";

const execFileAsync = promisify(execFile);
const testNow = new Date(2026, 10, 10, 10, 0, 0);
const originalCwd = process.cwd();
const originalSessionEnv = process.env.WEAVE_SESSION_PATH;

afterEach(() => {
  process.chdir(originalCwd);
  if (originalSessionEnv === undefined) {
    delete process.env.WEAVE_SESSION_PATH;
  } else {
    process.env.WEAVE_SESSION_PATH = originalSessionEnv;
  }
  process.exitCode = undefined;
});

function taskTable(statuses: string[]): string {
  return [
    "# Tasks",
    "",
    "## Active Task Index",
    "",
    "| ID | Status | Execution | Repos | Owner | Title | Blocked by |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...statuses.map((status, index) => `| T${index + 1} | ${status} | afk | root | | Task ${index + 1} | None |`),
    "",
  ].join("\n");
}

async function setup(options: { slices?: Record<string, string[]>; installed?: boolean } = {}): Promise<{ root: string; changePath: string }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-cli-review-status-")));
  await mkdir(path.join(root, ".weave"), { recursive: true });
  await writeFile(path.join(root, ".weave", "workspace.yml"), YAML.stringify({ version: 1, mode: "repo", name: "fixture", repos: {} }));
  if (options.installed !== false) {
    await writeFile(
      path.join(root, ".weave", "agents.yml"),
      YAML.stringify({ version: 1, installed: { claude: { skills: { "weave-review": { path: ".claude/skills/weave-review/SKILL.md" } } } } }),
    );
  }
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  const session = path.join(root, ".session.yml");
  const created = await createChange({ cwd: root, title: "Review status", now: testNow, randomId: () => "rs01", sessionPath: session });
  const changePath = path.join(root, "wiki", "changes", created.id);
  for (const [id, statuses] of Object.entries(options.slices ?? {})) {
    const slicePath = path.join(changePath, "task-slices", id);
    await mkdir(slicePath, { recursive: true });
    await writeFile(
      path.join(slicePath, "status.yml"),
      YAML.stringify({ version: 1, id, title: id, status: "pending", owner: "", repos: ["root"], depends_on: [], task_summary: { total: 0, done: 0, blocked: 0 } }),
    );
    await writeFile(path.join(slicePath, "tasks.md"), taskTable(statuses));
  }
  process.env.WEAVE_SESSION_PATH = session;
  process.chdir(root);
  return { root, changePath };
}

async function runReview(args: string[]): Promise<{ output: string; exitCode: number | undefined }> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  });
  try {
    const command = reviewCommand();
    command.exitOverride();
    await command.parseAsync(args, { from: "user" });
  } finally {
    spy.mockRestore();
  }
  return { output: chunks.join(""), exitCode: process.exitCode === undefined ? undefined : Number(process.exitCode) };
}

async function runJson(args: string[]): Promise<{ result: Record<string, unknown>; exitCode: number | undefined }> {
  const { output, exitCode } = await runReview([...args, "--json"]);
  return { result: JSON.parse(output) as Record<string, unknown>, exitCode };
}

const contractFields = ["status", "active", "skill_paths", "settings", "stored_state", "effective_state", "out_of_date_reasons", "ready_for_review", "counts"];

describe("weave review status", () => {
  it("returns every contract field for a ready slice and for a slice still in progress", async () => {
    const { root, changePath } = await setup({ slices: { "01-alpha": ["todo"], "02-beta": ["todo"] } });
    // Adopt while nothing is ready, so a slice finished later reads as not reviewed.
    await runJson(["status"]);
    await writeFile(path.join(changePath, "task-slices", "01-alpha", "tasks.md"), taskTable(["done", "not_tested"]));

    const ready = await runJson(["status", "--slice", "01-alpha"]);
    expect(ready.exitCode).toBeUndefined();
    for (const field of contractFields) {
      expect(ready.result).toHaveProperty(field);
    }
    expect(ready.result).toMatchObject({
      status: "ok",
      active: true,
      skill_paths: [path.join(root, ".claude", "skills", "weave-review", "SKILL.md")],
      settings: { slice_rounds: 2, models: {} },
      slice: "01-alpha",
      stored_state: null,
      effective_state: "not_reviewed",
      out_of_date_reasons: [],
      ready_for_review: true,
      counts: { open_rulings: 0, parked_minors: 0, human_checks: 0, untested_tasks: 1 },
    });

    // A leading number resolves the slice too.
    const inProgress = await runJson(["status", "--slice", "02"]);
    for (const field of contractFields) {
      expect(inProgress.result).toHaveProperty(field);
    }
    expect(inProgress.result).toMatchObject({
      slice: "02-beta",
      stored_state: null,
      effective_state: "not_ready_for_review",
      ready_for_review: false,
    });
  });

  it("returns the change block with adopted_at for --change", async () => {
    const { changePath } = await setup({ slices: { "01-alpha": ["done"], "02-beta": ["todo"] } });
    const { result, exitCode } = await runJson(["status", "--change"]);
    expect(exitCode).toBeUndefined();
    for (const field of contractFields) {
      expect(result).toHaveProperty(field);
    }
    expect(result).toMatchObject({ status: "ok", active: true, stored_state: null, effective_state: "not_started", ready_for_review: false });
    expect(typeof result.adopted_at).toBe("string");
    expect((result.review as Record<string, unknown>).adopted_at).toBe(result.adopted_at);

    // First contact stamped the slice that was already ready.
    const alpha = YAML.parse(await readFile(path.join(changePath, "task-slices", "01-alpha", "status.yml"), "utf8"));
    expect(alpha.review.state).toBe("predates_review");
    const beta = YAML.parse(await readFile(path.join(changePath, "task-slices", "02-beta", "status.yml"), "utf8"));
    expect(beta.review).toBeUndefined();
  });

  it("reports the change and every slice without a selector, and prints one line per slice", async () => {
    await setup({ slices: { "01-alpha": ["done"], "02-beta": ["todo"] } });
    const { result } = await runJson(["status"]);
    expect(result.change).toMatchObject({ effective_state: "not_started" });
    expect((result.slices as Array<Record<string, unknown>>).map((slice) => [slice.slice, slice.effective_state])).toEqual([
      ["01-alpha", "predates_review"],
      ["02-beta", "not_ready_for_review"],
    ]);

    const { output } = await runReview(["status"]);
    expect(output).toBe("active: yes\nchange: not started\n01-alpha: predates review\n02-beta: not ready for review\n");
  });

  it("is inactive and writes nothing without the review skill", async () => {
    const { changePath } = await setup({ slices: { "01-alpha": ["done"] }, installed: false });
    const before = await readFile(path.join(changePath, "status.yml"), "utf8");
    const { result } = await runJson(["status", "--slice", "01-alpha"]);
    // Inactive review never shows as `not_reviewed`: with only the skill missing, nothing is derived.
    expect(result).toMatchObject({ active: false, installed: false, inactive_cause: "skill_not_installed", skill_paths: [], effective_state: null, ready_for_review: true });
    expect(await readFile(path.join(changePath, "status.yml"), "utf8")).toBe(before);
  });

  it("fails with slice_not_found for an unknown slice", async () => {
    await setup({ slices: { "01-alpha": ["todo"] } });
    const { result, exitCode } = await runJson(["status", "--slice", "09-missing"]);
    expect(exitCode).toBe(1);
    expect(result).toMatchObject({ status: "error", code: "slice_not_found" });
    expect(typeof result.message).toBe("string");
  });

  it("fails with no_slices for --slice in flat mode", async () => {
    await setup();
    const { result, exitCode } = await runJson(["status", "--slice", "01"]);
    expect(exitCode).toBe(1);
    expect(result).toMatchObject({ status: "error", code: "no_slices" });
  });

  it("rejects --slice together with --change", async () => {
    await setup({ slices: { "01-alpha": ["todo"] } });
    const { result, exitCode } = await runJson(["status", "--slice", "01-alpha", "--change"]);
    expect(exitCode).toBe(1);
    expect(result).toMatchObject({ status: "error", code: "invalid_arguments" });
  });
});
