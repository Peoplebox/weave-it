import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewCommand } from "../src/commands/review.js";
import { createChange } from "../src/lib/changes.js";
import { rollupChange } from "../src/lib/sliceRollup.js";

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

interface Fixture {
  root: string;
  changePath: string;
  changeStatus: string;
}

// A repo-mode Weave root in a temporary git repo: `01-alpha` is done (stored `reviewed`
// unless `alphaReview` says otherwise), `02-beta` is done with no review, and `03-gamma`
// depends on `02-beta` and is still open.
async function setup(options: { installed?: boolean; enabled?: boolean; alphaReview?: Record<string, unknown> | null } = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-cli-review-skip-")));
  await mkdir(path.join(root, ".weave"), { recursive: true });
  await writeFile(
    path.join(root, ".weave", "workspace.yml"),
    YAML.stringify({ version: 1, mode: "repo", name: "fixture", repos: {}, ...(options.enabled === false ? { review: { enabled: false } } : {}) }),
  );
  if (options.installed !== false) {
    await writeFile(
      path.join(root, ".weave", "agents.yml"),
      YAML.stringify({ version: 1, installed: { claude: { skills: { "weave-review": { path: ".claude/skills/weave-review/SKILL.md" } } } } }),
    );
  }
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  const session = path.join(root, ".session.yml");
  const created = await createChange({ cwd: root, title: "Review skip", now: testNow, randomId: () => "sk09", sessionPath: session });
  const changePath = path.join(root, "wiki", "changes", created.id);
  const changeStatus = path.join(changePath, "status.yml");
  // Adopted before any slice existed, so a finished slice without a review reads `not_reviewed`.
  const status = YAML.parse(await readFile(changeStatus, "utf8")) as Record<string, unknown>;
  await writeFile(changeStatus, YAML.stringify({ ...status, review: { adopted_at: testNow.toISOString() } }));
  const slices: Array<[string, string[], string[], Record<string, unknown> | undefined]> = [
    ["01-alpha", ["done"], [], options.alphaReview === null ? undefined : (options.alphaReview ?? { state: "reviewed" })],
    ["02-beta", ["done"], [], undefined],
    ["03-gamma", ["todo"], ["02-beta"], undefined],
  ];
  for (const [id, statuses, dependsOn, review] of slices) {
    const slicePath = path.join(changePath, "task-slices", id);
    await mkdir(slicePath, { recursive: true });
    await writeFile(
      path.join(slicePath, "status.yml"),
      YAML.stringify({
        version: 1,
        id,
        title: id,
        status: "pending",
        owner: "",
        repos: ["root"],
        depends_on: dependsOn,
        task_summary: { total: 0, done: 0, blocked: 0 },
        ...(review ? { review } : {}),
      }),
    );
    await writeFile(path.join(slicePath, "tasks.md"), taskTable(statuses));
  }
  process.env.WEAVE_SESSION_PATH = session;
  process.chdir(root);
  return { root, changePath, changeStatus };
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
  const exitCode = process.exitCode === undefined ? undefined : Number(process.exitCode);
  process.exitCode = undefined;
  return { output: chunks.join(""), exitCode };
}

async function runJson(args: string[]): Promise<{ result: Record<string, any>; exitCode: number | undefined }> {
  const { output, exitCode } = await runReview([...args, "--json"]);
  return { result: JSON.parse(output) as Record<string, any>, exitCode };
}

function sliceStates(result: Record<string, any>): Array<[string, unknown]> {
  return (result.slices as Array<Record<string, unknown>>).map((slice) => [slice.slice as string, slice.effective_state]);
}

describe("weave review skip and unskip", () => {
  it("refuses skip without a reason, with missing_reason and no write", async () => {
    const fixture = await setup();
    const before = await readFile(fixture.changeStatus, "utf8");
    for (const args of [["skip"], ["skip", "--reason", "   "]]) {
      const { result, exitCode } = await runJson(args);
      expect(exitCode).toBe(1);
      expect(result).toMatchObject({ status: "error", code: "missing_reason" });
    }
    expect(await readFile(fixture.changeStatus, "utf8")).toBe(before);
  });

  it("records the skip, turns every slice skipped, passes the gate, and unskip restores the states", async () => {
    const fixture = await setup();
    const before = await runJson(["status"]);
    expect(before.result.active).toBe(true);
    expect(sliceStates(before.result)).toEqual([
      ["01-alpha", "reviewed"],
      ["02-beta", "not_reviewed"],
      ["03-gamma", "not_ready_for_review"],
    ]);
    expect((await runJson(["gate", "--change"])).result).toMatchObject({ pass: false, inactive_cause: null });

    const skipped = await runJson(["skip", "--reason", "docs only"]);
    expect(skipped.exitCode).toBeUndefined();
    expect(skipped.result).toEqual({ status: "ok", change: expect.any(String), skipped: { reason: "docs only", at: expect.any(String) } });
    const stored = YAML.parse(await readFile(fixture.changeStatus, "utf8")) as Record<string, any>;
    expect(stored.review).toMatchObject({ adopted_at: testNow.toISOString(), skipped: { reason: "docs only" } });

    const during = await runJson(["status"]);
    expect(during.result).toMatchObject({ active: false, inactive_cause: "change_skipped", change: { effective_state: "skipped", skipped: true } });
    expect(sliceStates(during.result)).toEqual([
      ["01-alpha", "skipped"],
      ["02-beta", "skipped"],
      ["03-gamma", "skipped"],
    ]);
    // The stored state is kept underneath the overlay.
    expect(during.result.slices[0]).toMatchObject({ stored_state: "reviewed", out_of_date: false });
    expect((await runReview(["status"])).output).toContain("active: no (review skipped for this change)");

    const gate = await runJson(["gate", "--change"]);
    expect(gate.result).toMatchObject({ pass: true, reason: "inactive", inactive_cause: "change_skipped", blocking: [], change_skipped: true });
    expect((await runReview(["gate", "--change"])).output).toContain("gate: pass (review skipped for this change");

    // Skipping again with the same reason keeps the original record.
    const again = await runJson(["skip", "--reason", "docs only"]);
    expect(again.result.skipped).toEqual(skipped.result.skipped);

    const cleared = await runJson(["unskip"]);
    expect(cleared.result).toMatchObject({ status: "ok", skipped: null, changed: true });
    const after = YAML.parse(await readFile(fixture.changeStatus, "utf8")) as Record<string, any>;
    expect(after.review.skipped).toBeUndefined();
    expect(after.review.adopted_at).toBe(testNow.toISOString());
    expect(sliceStates((await runJson(["status"])).result)).toEqual(sliceStates(before.result));
  });

  it("unskip on a change that is not skipped is ok and writes nothing", async () => {
    const fixture = await setup();
    const before = await readFile(fixture.changeStatus, "utf8");
    const { result, exitCode } = await runJson(["unskip"]);
    expect(exitCode).toBeUndefined();
    expect(result).toMatchObject({ status: "ok", skipped: null, changed: false });
    expect(await readFile(fixture.changeStatus, "utf8")).toBe(before);
  });

  it("removes the whole review block on unskip when the skip was all it held", async () => {
    const fixture = await setup({ installed: false });
    const status = YAML.parse(await readFile(fixture.changeStatus, "utf8")) as Record<string, unknown>;
    delete status.review;
    await writeFile(fixture.changeStatus, YAML.stringify(status));
    await runJson(["skip", "--reason", "spike"]);
    expect((YAML.parse(await readFile(fixture.changeStatus, "utf8")) as Record<string, any>).review.skipped.reason).toBe("spike");
    await runJson(["unskip"]);
    expect((YAML.parse(await readFile(fixture.changeStatus, "utf8")) as Record<string, any>).review).toBeUndefined();
  });

  it("with the workspace switch off, slices read skipped, the change is not skipped, and the gate passes as inactive", async () => {
    await setup({ enabled: false });
    const status = await runJson(["status"]);
    expect(status.result).toMatchObject({ active: false, enabled: false, inactive_cause: "workspace_off", change: { skipped: false } });
    expect(status.result.change.effective_state).not.toBe("skipped");
    expect(sliceStates(status.result).map(([, state]) => state)).toEqual(["skipped", "skipped", "skipped"]);
    expect((await runJson(["gate", "--change"])).result).toMatchObject({ pass: true, reason: "inactive", inactive_cause: "workspace_off", blocking: [] });
  });

  it("without the review skill installed, slices carry no derived review state and the gate passes as inactive", async () => {
    await setup({ installed: false });
    const status = await runJson(["status"]);
    expect(status.result).toMatchObject({ active: false, installed: false, inactive_cause: "skill_not_installed", change: { effective_state: null } });
    // A stored state is still reported; nothing is derived for the others.
    expect(sliceStates(status.result)).toEqual([
      ["01-alpha", "reviewed"],
      ["02-beta", null],
      ["03-gamma", null],
    ]);
    expect((await runReview(["status", "--slice", "02"])).output).toContain("02-beta: no review state (review inactive)");
    expect((await runJson(["gate", "--change"])).result).toMatchObject({ pass: true, reason: "inactive", inactive_cause: "skill_not_installed", blocking: [] });
  });

  it("falls back to rollup done for dependency readiness for every inactive cause", async () => {
    const active = await setup();
    expect((await rollupChange({ changePath: active.changePath })).ready_slices).toEqual([]);

    const skipped = await setup();
    await runJson(["skip", "--reason", "docs only"]);
    expect((await rollupChange({ changePath: skipped.changePath })).ready_slices).toEqual(["03-gamma"]);

    const off = await setup({ enabled: false });
    expect((await rollupChange({ changePath: off.changePath })).ready_slices).toEqual(["03-gamma"]);

    const missing = await setup({ installed: false });
    expect((await rollupChange({ changePath: missing.changePath })).ready_slices).toEqual(["03-gamma"]);
  });
});
