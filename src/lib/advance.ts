import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import path from "node:path";
import {
  agentLaunchers as defaultAgentLaunchers,
  type AgentLauncher,
  defaultLaunchAgent,
  formatLaunchPlan,
} from "./agent-launchers.js";
import { hasSubstantiveMarkdown, resolveArchitectureArtifact } from "./architecture-artifact.js";
import {
  activeChangeContext,
  type ChangeStage,
  type ChangeSummary,
  ChangeCommandError,
  finishChangeRun,
  type PhaseRun,
  type RunResult,
  startChangeRun,
  type StressTestVerdict,
} from "./changes.js";
import { pathExists } from "./files.js";
import {
  autoAdvanceTransitions,
  isLifecycleTransitionId,
  type LifecycleTransition,
  lifecycleTransition,
  lifecycleTransitionIds,
  type LifecycleTransitionId,
} from "./lifecycle-transitions.js";
import { getUserWeaveDir } from "./user-paths.js";

// Verdicts that let the next phase build on a stress-tested shape.
const passingVerdicts: readonly StressTestVerdict[] = ["holds", "holds-with-changes", "waived"];
// A lock older than this is left over from a crashed runner and is taken over.
const staleLockMs = 10 * 60 * 1000;

export type AdvanceConditionId = "flag" | "progressed" | "fresh" | "artifact" | "verdict" | "not_started";

export interface AdvanceCondition {
  id: AdvanceConditionId;
  ok: boolean;
  detail: string;
}

export interface TransitionEvaluation {
  transition: LifecycleTransitionId;
  from: ChangeStage;
  to: ChangeStage;
  skill: string;
  fire: boolean;
  upstream_updated_at?: string;
  conditions: AdvanceCondition[];
}

export interface AdvanceDecision {
  fire: boolean;
  transition?: LifecycleTransitionId;
  skill?: string;
  lane?: ChangeStage;
  agent: string;
  command?: string;
  reason: string;
}

export interface AdvanceStep {
  evaluations: TransitionEvaluation[];
  decision: AdvanceDecision;
  run?: PhaseRun;
  log?: string;
  detached?: boolean;
}

export interface AdvanceResult {
  status: "ok";
  change_id: string;
  dry_run: boolean;
  fired: boolean;
  steps: AdvanceStep[];
  message: string;
}

export interface DetachedAdvanceRequest {
  cwd: string;
  args: string[];
  logPath: string;
}

export interface AdvanceOptions {
  cwd: string;
  transition?: string;
  dryRun?: boolean;
  detach?: boolean;
  once?: boolean;
  retryFailed?: boolean;
  agent?: string;
  permissionMode?: string;
  launchers?: Record<string, AgentLauncher>;
  spawnDetached?: (request: DetachedAdvanceRequest) => void;
  clock?: () => Date;
  randomId?: () => string;
  sessionIdFactory?: () => string;
  sessionPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ExecuteRunOptions extends Omit<AdvanceOptions, "transition" | "dryRun" | "detach" | "agent"> {
  runId: string;
}

export async function advanceChange(options: AdvanceOptions): Promise<AdvanceResult> {
  const steps: AdvanceStep[] = [];
  const maxSteps = options.once || options.dryRun || options.detach ? 1 : autoAdvanceTransitions.length;
  let changeId = "";

  for (let index = 0; index < maxSteps; index += 1) {
    const { step, change } = await advanceStep(options);
    changeId = change.id;
    steps.push(step);
    if (!step.decision.fire || !step.run || step.run.result !== "succeeded") {
      break;
    }
  }

  return advanceResult(changeId, options.dryRun ?? false, steps);
}

// Runs a phase recorded by a detached `weave advance`, then keeps advancing unless `once` is set.
export async function resumeAdvanceRun(options: ExecuteRunOptions): Promise<AdvanceResult> {
  const { step, change } = await executeRun(options);
  const steps = [step];
  if (!options.once && step.run?.result === "succeeded") {
    const next = await advanceChange({ ...options, detach: false });
    steps.push(...next.steps);
  }
  return advanceResult(change.id, false, steps);
}

export async function evaluateTransitions(
  change: ChangeSummary,
  options: { transition?: string; retryFailed?: boolean } = {},
): Promise<TransitionEvaluation[]> {
  const candidates = options.transition ? [requestedTransition(options.transition)] : autoAdvanceTransitions;
  const evaluations: TransitionEvaluation[] = [];
  for (const transition of candidates) {
    evaluations.push(await evaluateTransition(change, transition, options.retryFailed ?? false));
  }
  return evaluations;
}

export function advancePrompt(skill: string, changeId: string): string {
  return `use the ${skill} skill for change ${changeId}`;
}

export function runLogPath(changeId: string, runId: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getUserWeaveDir(env), "runs", changeId, `${runId}.log`);
}

async function advanceStep(options: AdvanceOptions): Promise<{ step: AdvanceStep; change: ChangeSummary }> {
  const launchers = options.launchers ?? defaultAgentLaunchers;
  const agent = options.agent ?? defaultLaunchAgent;
  const launcher = launchers[agent];
  const context = await activeChangeContext({ cwd: options.cwd, sessionPath: options.sessionPath });

  if (options.dryRun) {
    const evaluations = await evaluateTransitions(context.change, options);
    return { step: { evaluations, decision: decide(evaluations, context.change, agent, launcher) }, change: context.change };
  }

  if (!launcher) {
    throw unsupportedAgent(agent, launchers);
  }

  // Evaluate and record the run under one lock so two runners never start the same phase.
  const release = await acquireAdvanceLock(context.change.id, options);
  let step: AdvanceStep;
  let change: ChangeSummary;
  try {
    const fresh = await activeChangeContext({ cwd: options.cwd, sessionPath: options.sessionPath });
    change = fresh.change;
    const evaluations = await evaluateTransitions(change, options);
    const decision = decide(evaluations, change, agent, launcher);
    step = { evaluations, decision };
    if (!decision.fire) {
      return { step, change };
    }

    const chosen = evaluations.find((evaluation) => evaluation.transition === decision.transition)!;
    const started = await startChangeRun({
      cwd: options.cwd,
      lane: chosen.to,
      skill: chosen.skill,
      agent,
      sessionId: launcher.acceptsSessionId ? (options.sessionIdFactory ?? randomUUID)() : undefined,
      trigger: "auto-advance",
      transition: chosen.transition,
      upstreamUpdatedAt: chosen.upstream_updated_at,
      now: now(options),
      randomId: options.randomId,
      sessionPath: options.sessionPath,
    });
    step.run = started.run;
    change = started.change;
  } finally {
    await release();
  }

  const run = step.run!;
  if (options.detach) {
    const logPath = runLogPath(change.id, run.id, options.env);
    (options.spawnDetached ?? spawnDetachedAdvance)({
      cwd: options.cwd,
      args: [
        "advance",
        "--execute-run",
        run.id,
        ...(options.once ? ["--once"] : []),
        ...(options.retryFailed ? ["--retry-failed"] : []),
        ...(options.permissionMode ? ["--permission-mode", options.permissionMode] : []),
      ],
      logPath,
    });
    return { step: { ...step, log: logPath, detached: true }, change };
  }

  const executed = await executeRun({ ...options, runId: run.id });
  return { step: { ...step, run: executed.step.run, log: executed.step.log }, change: executed.change };
}

async function executeRun(options: ExecuteRunOptions): Promise<{ step: AdvanceStep; change: ChangeSummary }> {
  const launchers = options.launchers ?? defaultAgentLaunchers;
  const context = await activeChangeContext({ cwd: options.cwd, sessionPath: options.sessionPath });
  const run = context.change.runs.find((candidate) => candidate.id === options.runId);
  if (!run) {
    throw new ChangeCommandError("run_not_found", `No run ${options.runId} recorded for ${context.change.id}.`, { run: options.runId });
  }
  if (run.result !== "running") {
    throw new ChangeCommandError("run_already_finished", `Run ${run.id} already finished as ${run.result}.`, { run });
  }

  const launcher = launchers[run.agent];
  const prompt = advancePrompt(run.skill, context.change.id);
  const logPath = runLogPath(context.change.id, run.id, options.env);
  const request = { cwd: options.cwd, prompt, sessionId: run.session_id, permissionMode: options.permissionMode, logPath };
  const decision: AdvanceDecision = {
    fire: true,
    ...(run.transition ? { transition: run.transition } : {}),
    skill: run.skill,
    lane: run.lane,
    agent: run.agent,
    ...(launcher ? { command: formatLaunchPlan(launcher.plan(request)) } : {}),
    reason: `started ${run.skill} for ${run.lane}`,
  };

  let result: Exclude<RunResult, "running">;
  let launchError: unknown;
  try {
    if (!launcher) {
      throw unsupportedAgent(run.agent, launchers);
    }
    const launched = await launcher.launch(request);
    const after = await activeChangeContext({ cwd: options.cwd, sessionPath: options.sessionPath });
    const lane = after.change.artifacts[run.lane];
    // Proof the phase finished: the session exited cleanly and recorded progress for its lane.
    result = launched.exitCode !== 0 ? "failed" : lane && lane.updated_at >= run.started_at ? "succeeded" : "incomplete";
  } catch (error) {
    result = "failed";
    launchError = error;
  }

  const finished = await finishChangeRun({
    cwd: options.cwd,
    runId: run.id,
    result,
    now: now(options),
    sessionPath: options.sessionPath,
  });
  if (launchError) {
    throw launchError;
  }

  return { step: { evaluations: [], decision, run: finished.run, log: logPath }, change: finished.change };
}

async function evaluateTransition(
  change: ChangeSummary,
  transition: LifecycleTransition,
  retryFailed: boolean,
): Promise<TransitionEvaluation> {
  const conditions: AdvanceCondition[] = [];
  const upstream = change.artifacts[transition.from];

  if (transition.humanDecision) {
    conditions.push({ id: "flag", ok: false, detail: `${transition.id} never auto-advances: ${transition.humanDecision}` });
  } else {
    const on = change.auto_advance[transition.id] === true;
    conditions.push({ id: "flag", ok: on, detail: `auto_advance.${transition.id} is ${on ? "on" : "off"}` });
  }

  conditions.push(
    upstream
      ? { id: "progressed", ok: true, detail: `${transition.from} was progressed at ${upstream.updated_at}` }
      : { id: "progressed", ok: false, detail: `${transition.from} has not been recorded with \`weave change progress ${transition.from}\`` },
  );

  const stale = change.stale[transition.from];
  conditions.push(
    stale
      ? { id: "fresh", ok: false, detail: `${transition.from} is stale (invalidated by ${stale.invalidated_by})` }
      : { id: "fresh", ok: true, detail: `${transition.from} is not stale` },
  );

  const artifact = await laneArtifact(change.changePath, transition.from);
  conditions.push({
    id: "artifact",
    ok: artifact.substantive,
    detail: `${artifact.label} ${artifact.substantive ? "has substantive content" : "is missing or scaffold-only"}`,
  });

  conditions.push(verdictCondition(change, transition));
  conditions.push(notStartedCondition(change, transition, upstream?.updated_at, retryFailed));

  return {
    transition: transition.id,
    from: transition.from,
    to: transition.to,
    skill: transition.skill,
    fire: conditions.every((condition) => condition.ok),
    ...(upstream ? { upstream_updated_at: upstream.updated_at } : {}),
    conditions,
  };
}

function verdictCondition(change: ChangeSummary, transition: LifecycleTransition): AdvanceCondition {
  const required = transition.requiresVerdict;
  if (!required || !required.types.includes(change.type)) {
    return { id: "verdict", ok: true, detail: "no stress test verdict required" };
  }

  const record = change.stress_tests[required.lane];
  if (!record) {
    return { id: "verdict", ok: false, detail: `no ${required.lane} stress test verdict recorded` };
  }
  if (record.outdated) {
    return { id: "verdict", ok: false, detail: `${required.lane} verdict ${record.verdict} is outdated (shape changed since)` };
  }
  if (!passingVerdicts.includes(record.verdict)) {
    return { id: "verdict", ok: false, detail: `${required.lane} verdict is ${record.verdict}` };
  }
  return { id: "verdict", ok: true, detail: `${required.lane} verdict ${record.verdict} is current` };
}

function notStartedCondition(
  change: ChangeSummary,
  transition: LifecycleTransition,
  upstreamUpdatedAt: string | undefined,
  retryFailed: boolean,
): AdvanceCondition {
  const running = change.runs.find((run) => run.lane === transition.to && run.result === "running");
  if (running) {
    return { id: "not_started", ok: false, detail: `${transition.to} run ${running.id} is still running` };
  }
  if (!upstreamUpdatedAt) {
    return { id: "not_started", ok: false, detail: `waiting for ${transition.from} progress` };
  }

  const since = change.runs.find(
    (run) => run.lane === transition.to && run.started_at >= upstreamUpdatedAt && !(retryFailed && run.result === "failed"),
  );
  if (since) {
    return {
      id: "not_started",
      ok: false,
      detail: `${transition.to} run ${since.id} (${since.result}) already started after ${transition.from} was progressed`,
    };
  }

  const downstream = change.artifacts[transition.to];
  if (downstream && downstream.updated_at > upstreamUpdatedAt) {
    return {
      id: "not_started",
      ok: false,
      detail: `${transition.to} was already progressed at ${downstream.updated_at}, after ${transition.from}`,
    };
  }

  return { id: "not_started", ok: true, detail: `no ${transition.to} run since ${transition.from} was progressed` };
}

function decide(
  evaluations: TransitionEvaluation[],
  change: ChangeSummary,
  agent: string,
  launcher: AgentLauncher | undefined,
): AdvanceDecision {
  const firing = evaluations
    .filter((evaluation) => evaluation.fire)
    .sort((left, right) => (right.upstream_updated_at ?? "").localeCompare(left.upstream_updated_at ?? ""));
  const chosen = firing[0];
  if (!chosen) {
    return { fire: false, agent, reason: noFireReason(evaluations) };
  }

  const plan = launcher?.plan({
    cwd: change.changePath,
    prompt: advancePrompt(chosen.skill, change.id),
    sessionId: launcher.acceptsSessionId ? "<new-session-id>" : undefined,
  });
  return {
    fire: true,
    transition: chosen.transition,
    skill: chosen.skill,
    lane: chosen.to,
    agent,
    ...(plan ? { command: formatLaunchPlan(plan) } : {}),
    reason: `${chosen.transition}: every condition holds`,
  };
}

function noFireReason(evaluations: TransitionEvaluation[]): string {
  const enabled = evaluations.filter((evaluation) => evaluation.conditions[0]?.ok);
  if (enabled.length === 0) {
    return "no auto-advance transition is on";
  }
  return enabled
    .map((evaluation) => `${evaluation.transition}: ${evaluation.conditions.find((condition) => !condition.ok)?.detail}`)
    .join("; ");
}

async function laneArtifact(changePath: string, lane: ChangeStage): Promise<{ label: string; substantive: boolean }> {
  switch (lane) {
    case "architecture":
      return { label: "architecture", substantive: (await resolveArchitectureArtifact(changePath)).substantive };
    case "slices":
      return {
        label: "task-slices/ or tasks.md",
        substantive: (await pathExists(path.join(changePath, "task-slices"))) || (await hasSubstantiveMarkdown(path.join(changePath, "tasks.md"))),
      };
    default:
      return { label: `${lane}.md`, substantive: await hasSubstantiveMarkdown(path.join(changePath, `${lane}.md`)) };
  }
}

function requestedTransition(value: string): LifecycleTransition {
  if (!isLifecycleTransitionId(value)) {
    throw new ChangeCommandError(
      "unknown_transition",
      `Unknown transition: ${value}. Expected ${lifecycleTransitionIds.join(", ")}`,
      { transition: value, supported: lifecycleTransitionIds },
    );
  }
  return lifecycleTransition(value);
}

function unsupportedAgent(agent: string, launchers: Record<string, AgentLauncher>): ChangeCommandError {
  return new ChangeCommandError(
    "unsupported_launch_agent",
    `weave advance cannot start ${agent} sessions yet. Supported agents: ${Object.keys(launchers).join(", ")}.`,
    { agent, supported: Object.keys(launchers) },
  );
}

async function acquireAdvanceLock(changeId: string, options: AdvanceOptions): Promise<() => Promise<void>> {
  const lockPath = path.join(getUserWeaveDir(options.env), "runs", changeId, "advance.lock");
  await mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.close();
      return async () => {
        await unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      const age = Date.now() - (await stat(lockPath)).mtimeMs;
      if (age < staleLockMs) {
        throw new ChangeCommandError("advance_locked", `Another weave advance is deciding the next phase for ${changeId}. Try again shortly.`, {
          lock: lockPath,
        });
      }
      await unlink(lockPath).catch(() => undefined);
    }
  }
  throw new ChangeCommandError("advance_locked", `Could not take the advance lock for ${changeId}.`, { lock: lockPath });
}

function spawnDetachedAdvance(request: DetachedAdvanceRequest): void {
  mkdirSync(path.dirname(request.logPath), { recursive: true });
  const log = openSync(request.logPath, "a");
  try {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1], ...request.args], {
      cwd: request.cwd,
      detached: true,
      stdio: ["ignore", log, log],
    });
    child.unref();
  } finally {
    closeSync(log);
  }
}

function now(options: { clock?: () => Date }): Date {
  return options.clock ? options.clock() : new Date();
}

function advanceResult(changeId: string, dryRun: boolean, steps: AdvanceStep[]): AdvanceResult {
  return {
    status: "ok",
    change_id: changeId,
    dry_run: dryRun,
    fired: steps.some((step) => step.decision.fire),
    steps,
    message: formatAdvanceMessage(changeId, dryRun, steps),
  };
}

function formatAdvanceMessage(changeId: string, dryRun: boolean, steps: AdvanceStep[]): string {
  const lines: string[] = [`Auto-advance for ${changeId}${dryRun ? " (dry run)" : ""}`];
  for (const step of steps) {
    for (const evaluation of step.evaluations) {
      lines.push("", `${evaluation.transition}: ${evaluation.from} -> ${evaluation.to} (${evaluation.skill})`);
      for (const condition of evaluation.conditions) {
        lines.push(`  ${condition.ok ? "pass" : "fail"}  ${condition.id}: ${condition.detail}`);
      }
      lines.push(`  decision: ${evaluation.fire ? "fire" : "no fire"}`);
    }

    const { decision, run } = step;
    lines.push("");
    if (!decision.fire) {
      lines.push(`Decision: no fire (${decision.reason})`);
      continue;
    }
    if (dryRun) {
      lines.push(`Decision: fire. Would start ${decision.skill} in a fresh ${decision.agent} session:`, `  ${decision.command ?? "(no launcher)"}`);
      continue;
    }
    if (run && step.detached) {
      lines.push(`Started ${run.skill} in a fresh background ${run.agent} session (run ${run.id}).`, `Log: ${step.log}`);
      continue;
    }
    if (run) {
      lines.push(`Ran ${run.skill} in a fresh ${run.agent} session (run ${run.id}): ${run.result}.`, ...(step.log ? [`Log: ${step.log}`] : []));
    }
  }
  return lines.join("\n");
}
