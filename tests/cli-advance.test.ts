import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { advanceCommand } from "../src/commands/advance.js";
import { changeCommand } from "../src/commands/change.js";
import { createChange } from "../src/lib/changes.js";

const execFileAsync = promisify(execFile);
const testNow = new Date(2026, 4, 22, 10, 0, 0);
const originalCwd = process.cwd();
const originalSessionEnv = process.env.WEAVE_SESSION_PATH;
const originalHomeEnv = process.env.WEAVE_USER_HOME;

afterEach(() => {
  process.chdir(originalCwd);
  restoreEnv("WEAVE_SESSION_PATH", originalSessionEnv);
  restoreEnv("WEAVE_USER_HOME", originalHomeEnv);
  process.exitCode = undefined;
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function setup(): Promise<{ cwd: string; changePath: string }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "weave-cli-advance-"));
  await mkdir(path.join(cwd, ".weave"), { recursive: true });
  await writeFile(
    path.join(cwd, ".weave", "workspace.yml"),
    YAML.stringify({ version: 1, mode: "repo", name: path.basename(cwd), repos: {} }),
  );
  await execFileAsync("git", ["init"], { cwd });
  const session = path.join(cwd, ".session.yml");
  const created = await createChange({ cwd, title: "Cli advance", now: testNow, randomId: () => "ca01", sessionPath: session });
  process.env.WEAVE_SESSION_PATH = session;
  process.env.WEAVE_USER_HOME = path.join(cwd, ".home");
  process.chdir(cwd);
  return { cwd, changePath: path.join(cwd, "wiki", "changes", created.id) };
}

async function run(command: () => ReturnType<typeof changeCommand>, args: string[]): Promise<Record<string, unknown>> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  });
  try {
    const program = command();
    program.exitOverride();
    await program.parseAsync(args, { from: "user" });
  } finally {
    spy.mockRestore();
  }
  return JSON.parse(chunks.join("")) as Record<string, unknown>;
}

describe("change auto-advance CLI", () => {
  it("sets a flag and refuses human-decision transitions", async () => {
    const { changePath } = await setup();

    const off = await run(changeCommand, ["auto-advance", "questions_to_research", "off", "--json"]);
    const refused = await run(changeCommand, ["auto-advance", "prd_to_architecture", "on", "--json"]);

    expect(off).toMatchObject({ status: "ok", updated: "questions_to_research" });
    expect(refused).toMatchObject({ status: "error", code: "transition_needs_human" });
    const status = YAML.parse(await readFile(path.join(changePath, "status.yml"), "utf8"));
    expect(status.auto_advance).toEqual({ questions_to_research: false, findings_to_questions: false });
  });

  it("records manual runs with start and finish", async () => {
    await setup();

    const started = await run(changeCommand, ["run", "start", "research", "--skill", "weave-research", "--agent", "claude", "--json"]);
    const runId = (started.run as { id: string }).id;
    const finished = await run(changeCommand, ["run", "finish", runId, "--result", "succeeded", "--json"]);
    const again = await run(changeCommand, ["run", "finish", runId, "--result", "failed", "--json"]);
    const listed = await run(changeCommand, ["runs", "--json"]);

    expect(started.run).toMatchObject({ lane: "research", trigger: "manual", result: "running", finished_at: null });
    expect(finished.run).toMatchObject({ id: runId, result: "succeeded" });
    expect(again).toMatchObject({ status: "error", code: "run_already_finished" });
    expect(listed.runs).toHaveLength(1);
  });
});

describe("advance CLI", () => {
  it("prints every condition and the decision on a dry run", async () => {
    const { changePath } = await setup();
    await writeFile(path.join(changePath, "questions.md"), "# Research Questions\n\n1. How does export work today?\n");
    await run(changeCommand, ["progress", "questions", "--source", "discussion", "--json"]);

    const result = await run(advanceCommand, ["--dry-run", "--json"]);

    expect(result).toMatchObject({ status: "ok", dry_run: true, fired: true });
    const [step] = result.steps as { evaluations: { transition: string; conditions: { id: string }[] }[]; decision: Record<string, unknown> }[];
    expect(step.evaluations.map((evaluation) => evaluation.transition)).toEqual(["questions_to_research", "findings_to_questions"]);
    expect(step.evaluations[0].conditions.map((condition) => condition.id)).toEqual([
      "flag",
      "progressed",
      "fresh",
      "artifact",
      "verdict",
      "not_started",
    ]);
    expect(step.decision).toMatchObject({ fire: true, skill: "weave-research", agent: "claude" });
  });

  it("reports an unknown transition as a JSON error", async () => {
    await setup();

    const result = await run(advanceCommand, ["--dry-run", "--transition", "nope", "--json"]);

    expect(result).toMatchObject({ status: "error", code: "unknown_transition" });
  });
});
