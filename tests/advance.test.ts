import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { describe, expect, it, vi } from "vitest";
import { advanceChange, type AdvanceOptions, evaluateTransitions, resumeAdvanceRun, runLogPath } from "../src/lib/advance.js";
import { type AgentLauncher, type AgentLaunchRequest, claudeLauncher, formatLaunchPlan } from "../src/lib/agent-launchers.js";
import {
  autoAdvanceChange,
  createChange,
  type ChangeType,
  progressChange,
  statusChange,
  verdictChange,
} from "../src/lib/changes.js";

const execFileAsync = promisify(execFile);
const changeId = "260522-aa01-invoice-export";

function at(minute: number): Date {
  return new Date(2026, 4, 22, 10, minute, 0);
}

interface Fixture {
  cwd: string;
  session: string;
  changePath: string;
  env: NodeJS.ProcessEnv;
}

async function setup(type: ChangeType = "feat", autoAdvance?: boolean): Promise<Fixture> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "weave-advance-"));
  await mkdir(path.join(cwd, ".weave"), { recursive: true });
  await writeFile(
    path.join(cwd, ".weave", "workspace.yml"),
    YAML.stringify({ version: 1, mode: "repo", name: path.basename(cwd), repos: {} }),
  );
  await execFileAsync("git", ["init"], { cwd });
  const session = path.join(cwd, ".session.yml");
  await createChange({ cwd, title: "Invoice export", type, autoAdvance, now: at(0), randomId: () => "aa01", sessionPath: session });
  return {
    cwd,
    session,
    changePath: path.join(cwd, "wiki", "changes", changeId),
    env: { WEAVE_USER_HOME: path.join(cwd, ".home") },
  };
}

async function writeQuestionsAndProgress(fixture: Fixture, minute: number): Promise<void> {
  await writeFile(
    path.join(fixture.changePath, "questions.md"),
    "# Research Questions\n\n## Questions\n\n1. How are invoices exported today?\n",
  );
  await progressChange({ cwd: fixture.cwd, stage: "questions", sources: ["discussion"], now: at(minute), sessionPath: fixture.session });
}

async function readStatus(fixture: Fixture): Promise<Record<string, unknown>> {
  return YAML.parse(await readFile(path.join(fixture.changePath, "status.yml"), "utf8")) as Record<string, unknown>;
}

// Stands in for an agent session: records each launch and optionally progresses the lane
// the way the launched skill would.
function mockLauncher(
  fixture: Fixture,
  behaviour: { exitCode?: number; progress?: "research" | "questions"; minute?: number } = {},
): AgentLauncher & { launches: AgentLaunchRequest[] } {
  const launches: AgentLaunchRequest[] = [];
  return {
    agent: "claude",
    acceptsSessionId: true,
    launches,
    plan: (request) => ({ command: "agent", args: ["-p", request.prompt, ...(request.sessionId ? ["--session-id", request.sessionId] : [])] }),
    launch: vi.fn(async (request: AgentLaunchRequest) => {
      launches.push(request);
      if (behaviour.progress === "research") {
        await writeFile(path.join(fixture.changePath, "research.md"), "# Research\n\nInvoices are exported by the billing job.\n");
        await progressChange({
          cwd: fixture.cwd,
          stage: "research",
          sources: ["questions", "codebase"],
          now: at(behaviour.minute ?? 30),
          sessionPath: fixture.session,
        });
      }
      return { exitCode: behaviour.exitCode ?? 0, sessionId: request.sessionId };
    }),
  };
}

function advanceOptions(fixture: Fixture, launcher: AgentLauncher, overrides: Partial<AdvanceOptions> = {}): AdvanceOptions {
  return {
    cwd: fixture.cwd,
    sessionPath: fixture.session,
    env: fixture.env,
    launchers: { claude: launcher },
    clock: () => at(20),
    randomId: () => "rn01",
    sessionIdFactory: () => "11111111-2222-4333-8444-555555555555",
    ...overrides,
  };
}

function conditionsOf(result: Awaited<ReturnType<typeof advanceChange>>, transition = "questions_to_research") {
  const evaluation = result.steps[0].evaluations.find((candidate) => candidate.transition === transition);
  return Object.fromEntries((evaluation?.conditions ?? []).map((condition) => [condition.id, condition.ok]));
}

describe("auto-advance flags", () => {
  it("proposes per-type defaults at change creation with questions_to_research on", async () => {
    const fixture = await setup("fix");

    const status = await readStatus(fixture);

    expect(status.auto_advance).toEqual({ questions_to_research: true, findings_to_questions: false });
  });

  it("starts with every flag off when created without auto-advance", async () => {
    const fixture = await setup("feat", false);

    const status = await readStatus(fixture);

    expect(status.auto_advance).toEqual({ questions_to_research: false, findings_to_questions: false });
  });

  it("reads changes without auto_advance in status.yml as all off", async () => {
    const fixture = await setup();
    const status = await readStatus(fixture);
    delete status.auto_advance;
    await writeFile(path.join(fixture.changePath, "status.yml"), YAML.stringify(status));

    const result = await autoAdvanceChange({ cwd: fixture.cwd, sessionPath: fixture.session });

    expect(result.transitions.filter((state) => state.enabled)).toEqual([]);
  });

  it("sets a flag and lists human-decision transitions as never", async () => {
    const fixture = await setup();

    const result = await autoAdvanceChange({ cwd: fixture.cwd, transition: "findings_to_questions", enabled: true, sessionPath: fixture.session });
    const listed = await autoAdvanceChange({ cwd: fixture.cwd, sessionPath: fixture.session });

    expect(result.updated).toBe("findings_to_questions");
    expect((await readStatus(fixture)).auto_advance).toMatchObject({ findings_to_questions: true });
    expect(listed.transitions.find((state) => state.transition === "prd_to_architecture")).toMatchObject({ allowed: false, enabled: false });
  });

  it("refuses to turn on transitions that need a human decision", async () => {
    const fixture = await setup();

    for (const transition of ["research_to_exploration", "research_to_architecture", "exploration_to_prd", "prd_to_architecture", "architecture_to_slices"]) {
      await expect(
        autoAdvanceChange({ cwd: fixture.cwd, transition, enabled: true, sessionPath: fixture.session }),
      ).rejects.toMatchObject({ code: "transition_needs_human" });
    }
    await expect(autoAdvanceChange({ cwd: fixture.cwd, transition: "nope", enabled: true, sessionPath: fixture.session })).rejects.toMatchObject({
      code: "unknown_transition",
    });
  });

  it("ignores a hand-edited flag on a human-decision transition", async () => {
    const fixture = await setup();
    const status = await readStatus(fixture);
    await writeFile(
      path.join(fixture.changePath, "status.yml"),
      YAML.stringify({ ...status, auto_advance: { questions_to_research: true, prd_to_architecture: true } }),
    );

    const change = (await statusChange({ cwd: fixture.cwd, sessionPath: fixture.session })).targets[0].change!;

    expect(change.auto_advance).toEqual({ questions_to_research: true });
  });
});

describe("weave advance decisions for questions -> research", () => {
  it("does not fire before questions are recorded", async () => {
    const fixture = await setup();
    const launcher = mockLauncher(fixture);

    const result = await advanceChange(advanceOptions(fixture, launcher, { dryRun: true }));

    expect(result.fired).toBe(false);
    expect(conditionsOf(result)).toMatchObject({ flag: true, progressed: false, artifact: false });
    expect(launcher.launches).toHaveLength(0);
  });

  it("fires on a dry run once questions are progressed, without launching or recording a run", async () => {
    const fixture = await setup();
    await writeQuestionsAndProgress(fixture, 10);
    const launcher = mockLauncher(fixture);

    const result = await advanceChange(advanceOptions(fixture, launcher, { dryRun: true }));

    expect(result.fired).toBe(true);
    expect(result.steps[0].decision).toMatchObject({ fire: true, transition: "questions_to_research", skill: "weave-research", lane: "research" });
    expect(result.steps[0].decision.command).toContain(`use the weave-research skill for change ${changeId}`);
    expect(Object.values(conditionsOf(result)).every(Boolean)).toBe(true);
    expect(result.message).toContain("Would start weave-research");
    expect(launcher.launches).toHaveLength(0);
    expect((await readStatus(fixture)).runs).toBeUndefined();
  });

  it("does not fire when the flag is off", async () => {
    const fixture = await setup();
    await writeQuestionsAndProgress(fixture, 10);
    await autoAdvanceChange({ cwd: fixture.cwd, transition: "questions_to_research", enabled: false, sessionPath: fixture.session });

    const result = await advanceChange(advanceOptions(fixture, mockLauncher(fixture), { dryRun: true }));

    expect(result.fired).toBe(false);
    expect(result.steps[0].decision.reason).toBe("no auto-advance transition is on");
  });

  it("does not fire when questions are stale", async () => {
    const fixture = await setup();
    await writeFile(path.join(fixture.changePath, "questions.md"), "# Research Questions\n\n1. How are invoices exported?\n");
    await progressChange({ cwd: fixture.cwd, stage: "questions", sources: ["exploration"], now: at(10), sessionPath: fixture.session });
    await progressChange({ cwd: fixture.cwd, stage: "exploration", sources: ["discussion"], now: at(11), sessionPath: fixture.session });

    const result = await advanceChange(advanceOptions(fixture, mockLauncher(fixture), { dryRun: true }));

    expect(result.fired).toBe(false);
    expect(conditionsOf(result)).toMatchObject({ progressed: true, fresh: false });
  });

  it("does not fire when questions.md is scaffold-only", async () => {
    const fixture = await setup();
    await writeFile(path.join(fixture.changePath, "questions.md"), "# Research Questions\n\n## Questions\n");
    await progressChange({ cwd: fixture.cwd, stage: "questions", sources: ["discussion"], now: at(10), sessionPath: fixture.session });

    const result = await advanceChange(advanceOptions(fixture, mockLauncher(fixture), { dryRun: true }));

    expect(result.fired).toBe(false);
    expect(conditionsOf(result)).toMatchObject({ progressed: true, artifact: false });
  });

  it("launches weave-research in a fresh session, records the run, and never starts it twice", async () => {
    const fixture = await setup();
    await writeQuestionsAndProgress(fixture, 10);
    const launcher = mockLauncher(fixture, { progress: "research" });
    const options = advanceOptions(fixture, launcher);

    const first = await advanceChange(options);
    const second = await advanceChange(options);

    expect(launcher.launches).toEqual([
      expect.objectContaining({
        cwd: fixture.cwd,
        prompt: `use the weave-research skill for change ${changeId}`,
        sessionId: "11111111-2222-4333-8444-555555555555",
        logPath: runLogPath(changeId, first.steps[0].run!.id, fixture.env),
      }),
    ]);
    expect(first.fired).toBe(true);
    expect(first.steps[0].run).toMatchObject({ lane: "research", skill: "weave-research", result: "succeeded" });
    expect(second.fired).toBe(false);
    expect(conditionsOf(second)).toMatchObject({ not_started: false });
    const runs = (await readStatus(fixture)).runs as Record<string, unknown>[];
    expect(runs).toEqual([
      expect.objectContaining({
        lane: "research",
        skill: "weave-research",
        agent: "claude",
        session_id: "11111111-2222-4333-8444-555555555555",
        trigger: "auto-advance",
        transition: "questions_to_research",
        upstream_updated_at: at(10).toISOString(),
        started_at: at(20).toISOString(),
        finished_at: at(20).toISOString(),
        result: "succeeded",
      }),
    ]);
  });

  it("fires again after questions are progressed again", async () => {
    const fixture = await setup();
    await writeQuestionsAndProgress(fixture, 10);
    const launcher = mockLauncher(fixture, { progress: "research", minute: 30 });
    await advanceChange(advanceOptions(fixture, launcher));
    await writeQuestionsAndProgress(fixture, 40);

    const result = await advanceChange(advanceOptions(fixture, launcher, { clock: () => at(45), dryRun: true }));

    expect(result.fired).toBe(true);
  });

  it("does not fire when research was already progressed after the questions", async () => {
    const fixture = await setup();
    await writeQuestionsAndProgress(fixture, 10);
    await writeFile(path.join(fixture.changePath, "research.md"), "# Research\n\nDone by hand.\n");
    await progressChange({ cwd: fixture.cwd, stage: "research", sources: ["questions"], now: at(15), sessionPath: fixture.session });

    const result = await advanceChange(advanceOptions(fixture, mockLauncher(fixture), { dryRun: true }));

    expect(result.fired).toBe(false);
    expect(result.steps[0].decision.reason).toContain("research was already progressed");
  });

  it("records an incomplete run when the session exits without progress, and does not retry it", async () => {
    const fixture = await setup();
    await writeQuestionsAndProgress(fixture, 10);
    const launcher = mockLauncher(fixture);

    const first = await advanceChange(advanceOptions(fixture, launcher));
    const second = await advanceChange(advanceOptions(fixture, launcher, { retryFailed: true }));

    expect(first.steps[0].run?.result).toBe("incomplete");
    expect(second.fired).toBe(false);
    expect(launcher.launches).toHaveLength(1);
  });

  it("retries a failed run only with retryFailed", async () => {
    const fixture = await setup();
    await writeQuestionsAndProgress(fixture, 10);
    const failing = mockLauncher(fixture, { exitCode: 1 });

    const first = await advanceChange(advanceOptions(fixture, failing));
    const blocked = await advanceChange(advanceOptions(fixture, failing, { dryRun: true }));
    const retried = await advanceChange(advanceOptions(fixture, failing, { dryRun: true, retryFailed: true }));

    expect(first.steps[0].run?.result).toBe("failed");
    expect(blocked.fired).toBe(false);
    expect(retried.fired).toBe(true);
  });

  it("detaches into a background runner that a second advance does not duplicate", async () => {
    const fixture = await setup();
    await writeQuestionsAndProgress(fixture, 10);
    const spawnDetached = vi.fn();
    const launcher = mockLauncher(fixture, { progress: "research" });

    const detached = await advanceChange(advanceOptions(fixture, launcher, { detach: true, spawnDetached }));
    const runId = detached.steps[0].run!.id;
    const duplicate = await advanceChange(advanceOptions(fixture, launcher, { dryRun: true }));
    const resumed = await resumeAdvanceRun({ ...advanceOptions(fixture, launcher), runId, once: true });

    expect(spawnDetached).toHaveBeenCalledWith({
      cwd: fixture.cwd,
      args: ["advance", "--execute-run", runId],
      logPath: runLogPath(changeId, runId, fixture.env),
    });
    expect(detached.steps[0]).toMatchObject({ detached: true, run: { result: "running" } });
    expect(launcher.launches).toHaveLength(1);
    expect(duplicate.fired).toBe(false);
    expect(conditionsOf(duplicate)).toMatchObject({ not_started: false });
    expect(resumed.steps[0].run).toMatchObject({ id: runId, result: "succeeded" });
  });

  it("refuses to start while another runner holds the advance lock", async () => {
    const fixture = await setup();
    await writeQuestionsAndProgress(fixture, 10);
    const lockPath = path.join(fixture.env.WEAVE_USER_HOME!, ".weave", "runs", changeId, "advance.lock");
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "");

    await expect(advanceChange(advanceOptions(fixture, mockLauncher(fixture)))).rejects.toMatchObject({ code: "advance_locked" });
  });

  it("rejects agents without a launcher before recording a run", async () => {
    const fixture = await setup();
    await writeQuestionsAndProgress(fixture, 10);

    await expect(advanceChange(advanceOptions(fixture, mockLauncher(fixture), { agent: "other" }))).rejects.toMatchObject({
      code: "unsupported_launch_agent",
    });
    expect((await readStatus(fixture)).runs).toBeUndefined();
  });
});

describe("stress test verdict condition", () => {
  it("requires a current passing exploration verdict for feat before weave-prd", async () => {
    const fixture = await setup();
    await writeFile(path.join(fixture.changePath, "exploration.md"), "# Shape\n\nExport invoices as CSV.\n");
    await progressChange({ cwd: fixture.cwd, stage: "exploration", sources: ["discussion"], now: at(10), sessionPath: fixture.session });
    const verdictOf = async () => {
      const change = (await statusChange({ cwd: fixture.cwd, sessionPath: fixture.session })).targets[0].change!;
      const [evaluation] = await evaluateTransitions(change, { transition: "exploration_to_prd" });
      return evaluation.conditions.find((condition) => condition.id === "verdict")!;
    };

    const missing = await verdictOf();
    await verdictChange({ cwd: fixture.cwd, lane: "exploration", verdict: "needs-reshaping", now: at(11), sessionPath: fixture.session });
    const reshaping = await verdictOf();
    await verdictChange({ cwd: fixture.cwd, lane: "exploration", verdict: "holds", now: at(12), sessionPath: fixture.session });
    const holds = await verdictOf();
    await progressChange({ cwd: fixture.cwd, stage: "exploration", sources: ["discussion"], now: at(13), sessionPath: fixture.session });
    const outdated = await verdictOf();

    expect(missing).toMatchObject({ ok: false, detail: "no exploration stress test verdict recorded" });
    expect(reshaping).toMatchObject({ ok: false });
    expect(holds).toMatchObject({ ok: true });
    expect(outdated).toMatchObject({ ok: false });
    expect(outdated.detail).toContain("outdated");
  });

  it("never fires a human-decision transition even when every other condition holds", async () => {
    const fixture = await setup("fix");
    await writeFile(path.join(fixture.changePath, "research.md"), "# Research\n\nBilling job exports invoices.\n");
    await progressChange({ cwd: fixture.cwd, stage: "research", sources: ["codebase"], now: at(10), sessionPath: fixture.session });

    const result = await advanceChange(
      advanceOptions(fixture, mockLauncher(fixture), { dryRun: true, transition: "research_to_architecture" }),
    );

    expect(result.fired).toBe(false);
    expect(conditionsOf(result, "research_to_architecture")).toMatchObject({ flag: false, progressed: true, artifact: true, not_started: true });
  });
});

describe("agent launchers", () => {
  it("plans a fresh non-interactive session with a Weave-chosen session id", () => {
    const plan = claudeLauncher.plan({
      cwd: "/repo",
      prompt: `use the weave-research skill for change ${changeId}`,
      sessionId: "11111111-2222-4333-8444-555555555555",
      permissionMode: "acceptEdits",
    });

    expect(plan).toEqual({
      command: "claude",
      args: [
        "-p",
        `use the weave-research skill for change ${changeId}`,
        "--session-id",
        "11111111-2222-4333-8444-555555555555",
        "--permission-mode",
        "acceptEdits",
      ],
    });
    expect(formatLaunchPlan(plan)).toContain(`-p 'use the weave-research skill for change ${changeId}'`);
  });
});
