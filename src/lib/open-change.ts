import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { pathExists } from "./files.js";
import {
  defaultRegistry,
  defaultRuntime,
  ownAgentEntry,
  shellAgentId,
  terminalLine,
  type AgentEntry,
  type CheckResult,
  type OpenRuntime,
  type Place,
  type Registry,
} from "./open-places.js";
import { getUserHome } from "./user-paths.js";
import {
  clearOpenChoice,
  customLocations,
  loadUserSettings,
  ownAgents,
  resolveSavedChoice,
  saveOpenChoice,
  type OpenChoice,
  type SettingsScope,
  type UserSettings,
} from "./user-settings.js";

// Opening a change folder in the place the person chose (decision 261109-mn61). One entry
// point for `change new`, `change switch`, and `change open`. It never throws for an
// opening failure and never changes the create or switch result.

export type OpenStatus = "opened" | "brought_forward" | "skipped" | "failed" | "not_attempted" | "needs_choice";

export type OpenReason =
  | "disabled"
  | "in_place"
  | "already_inside"
  | "no_open_flag"
  | "dont_ask"
  | "no_choice"
  | "unknown_saved_value"
  | "ssh"
  | "no_display"
  | "unavailable_now"
  | "default_missing"
  | "agent_not_found"
  | "open_failed"
  | "timeout";

export interface OpenChoiceAgent {
  id: string;
  label: string;
  own?: true;
}

export interface OpenMenuChoice {
  place: string;
  kind: "terminal" | "app" | "none";
  label: string;
  hint?: string;
  agents?: OpenChoiceAgent[];
}

export interface OpenOutcome {
  status: OpenStatus;
  place?: string;
  agent?: string;
  where?: string;
  draft: "unsent" | "shown";
  used_default: boolean;
  saved: SettingsScope | null;
  reason?: OpenReason;
  detail?: string;
  choices?: OpenMenuChoice[];
}

export interface OpenResult {
  next_step: string;
  // True when the step came from --skill/--context (now or stored), not the fallback.
  step_given: boolean;
  open: OpenOutcome;
}

export type ExplicitChoice = { place: string; agent?: string };

// `remember`: the person chose "make it my default" rather than "just this once".
export type MenuAnswer = { place: string; agent?: string; remember?: boolean } | { place: "none"; dontAsk: boolean };

export type MenuPrompt = (choices: OpenMenuChoice[], current?: OpenChoice, options?: { askRemember?: boolean }) => Promise<MenuAnswer | undefined>;

export interface OpenContext {
  changeId: string;
  folder: string;
  // The main checkout's real path: the key for per-project overrides.
  mainRoot?: string;
  cwd: string;
  inPlace?: boolean;
  // Stored next step lives in the change's status.yml.
  changePath?: string;
  stage?: string;
  explicit?: ExplicitChoice;
  noOpen?: boolean;
  skill?: string;
  context?: string;
  // Save the choice that is used: as the default, or as this project's override.
  remember?: SettingsScope;
  json: boolean;
  interactive: boolean;
  env?: NodeJS.ProcessEnv;
  registry?: Registry;
  runtime?: OpenRuntime;
  prompt?: MenuPrompt;
  // Called right before the menu shows, so the summary is printed first.
  beforePrompt?: () => void;
  timeouts?: Partial<Timeouts>;
}

interface Timeouts {
  check: number;
  open: number;
  bringForward: number;
}

const defaultTimeouts: Timeouts = { check: 2_000, open: 10_000, bringForward: 2_000 };

const agentMarkers = ["CLAUDECODE", "CURSOR_AGENT", "OPENCODE", "CODEX_SANDBOX", "CODEX_THREAD_ID", "WEAVE_NO_PROMPT"];

export const contextLimit = 500;

// The terminal menu shows only for text output at a real terminal with no agent around.
export function canPrompt(options: { json: boolean; interactive: boolean; env: NodeJS.ProcessEnv }): boolean {
  if (options.json || !options.interactive) return false;
  return !agentMarkers.some((name) => Boolean(options.env[name]));
}

export function isOverSsh(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_TTY);
}

export function sanitizeContext(context: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = context.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > contextLimit ? cleaned.slice(0, contextLimit).trimEnd() : cleaned;
}

export function composeNextStep(changeId: string, skill?: string, context?: string): string {
  const name = skill?.trim() || "weave-next";
  const gist = context ? sanitizeContext(context) : "";
  return `use the ${name} skill for change ${changeId}${gist ? `: ${gist}` : ""}`;
}

export interface StoredNextStep {
  text: string;
  stage: string;
}

export async function readStoredNextStep(changePath: string): Promise<StoredNextStep | undefined> {
  const statusPath = path.join(changePath, "status.yml");
  if (!(await pathExists(statusPath))) return undefined;
  const raw = YAML.parse(await readFile(statusPath, "utf8")) as Record<string, unknown> | null;
  const step = raw?.next_step;
  if (step && typeof step === "object" && typeof (step as StoredNextStep).text === "string" && typeof (step as StoredNextStep).stage === "string") {
    return { text: (step as StoredNextStep).text, stage: (step as StoredNextStep).stage };
  }
  return undefined;
}

export async function storeNextStep(changePath: string, step: StoredNextStep): Promise<void> {
  const statusPath = path.join(changePath, "status.yml");
  const raw = ((YAML.parse(await readFile(statusPath, "utf8")) as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
  raw.next_step = { text: step.text, stage: step.stage };
  await writeFile(statusPath, YAML.stringify(raw));
}

// A step from this call (stored for later), else the stored step while the change is still
// at the stage it was made for, else the weave-next fallback.
export async function resolveNextStep(context: Pick<OpenContext, "changeId" | "changePath" | "stage" | "skill" | "context">): Promise<{ text: string; given: boolean }> {
  if (context.skill || context.context) {
    const text = composeNextStep(context.changeId, context.skill, context.context);
    if (context.changePath && context.stage && (await pathExists(path.join(context.changePath, "status.yml")))) {
      await storeNextStep(context.changePath, { text, stage: context.stage });
    }
    return { text, given: true };
  }
  if (context.changePath && context.stage) {
    const stored = await readStoredNextStep(context.changePath);
    if (stored && stored.stage === context.stage) return { text: stored.text, given: true };
  }
  return { text: composeNextStep(context.changeId), given: false };
}

// Argument errors are raised before a change is created or switched to.
export class OpenArgumentError extends Error {
  constructor(
    readonly code: "unknown_place" | "unknown_agent" | "agent_not_for_app" | "conflicting_open_flags",
    message: string,
  ) {
    super(message);
    this.name = "OpenArgumentError";
  }
}

export async function validateExplicitChoice(choice: ExplicitChoice | undefined, options: { env?: NodeJS.ProcessEnv; registry?: Registry } = {}): Promise<void> {
  if (!choice) return;
  const registry = options.registry ?? defaultRegistry;
  if (choice.place === "none") {
    if (choice.agent) throw new OpenArgumentError("agent_not_for_app", "An agent can't be given with place none.");
    return;
  }
  const place = registry.places.find((candidate) => candidate.id === choice.place);
  if (!place) {
    throw new OpenArgumentError("unknown_place", `Unknown place: ${choice.place}. Expected one of: ${[...registry.places.map((p) => p.id), "none"].join(", ")}.`);
  }
  if (!choice.agent) return;
  if (place.kind === "app") {
    throw new OpenArgumentError("agent_not_for_app", `${place.label} brings its own agent or editor, so --agent can't be used with it.`);
  }
  const settings = (await loadUserSettings(options.env ?? process.env)).settings;
  if (!agentEntryFor(choice.agent, registry, settings)) {
    throw new OpenArgumentError("unknown_agent", `Unknown agent: ${choice.agent}. Expected one of: ${allAgentIds(registry, settings).join(", ")}.`);
  }
}

// `--open herdr:claude`
export function parseOpenFlag(value: string): ExplicitChoice {
  const [place, agent] = value.split(":", 2);
  return { place: place!.trim(), ...(agent?.trim() ? { agent: agent.trim() } : {}) };
}

export async function openChange(ctx: OpenContext): Promise<OpenResult> {
  const env = ctx.env ?? process.env;
  const step = await resolveNextStep(ctx);
  const result = (open: OpenOutcome): OpenResult => ({ next_step: step.text, step_given: step.given, open });
  const notAttempted = (reason: OpenReason, detail?: string): OpenResult =>
    result({ status: "not_attempted", reason, draft: "shown", used_default: false, saved: null, ...(detail ? { detail } : {}) });

  if (env.WEAVE_NO_OPEN) return notAttempted("disabled");
  if (ctx.inPlace) return notAttempted("in_place");
  if (ctx.noOpen) return notAttempted("no_open_flag");

  const registry = ctx.registry ?? defaultRegistry;
  const loaded = await loadUserSettings(env);
  const settings = loaded.settings;
  const baseRuntime = ctx.runtime ?? defaultRuntime(env, getUserHome(env), {});
  const runtime: OpenRuntime = { ...baseRuntime, locations: { ...customLocations(settings), ...baseRuntime.locations } };
  const timeouts = { ...defaultTimeouts, ...ctx.timeouts };

  try {
    // 1. A one-off choice from the flags.
    if (ctx.explicit) {
      if (ctx.explicit.place === "none") {
        if (ctx.remember) {
          await saveOpenChoice(env, ctx.remember, { place: "none" }, ctx.mainRoot);
          return result({ status: "not_attempted", reason: "dont_ask", draft: "shown", used_default: false, saved: ctx.remember });
        }
        return notAttempted("no_open_flag");
      }
      const outcome = await openAt(ctx.explicit, { ctx, registry, runtime, settings, env, timeouts, usedDefault: false, step: step.text });
      if (ctx.remember) {
        await saveOpenChoice(env, ctx.remember, ctx.explicit, ctx.mainRoot);
        outcome.saved = ctx.remember;
      }
      return result(outcome);
    }

    // 2. Already inside the change folder.
    if (await isInside(ctx.cwd, ctx.folder)) return notAttempted("already_inside");

    // 3. A saved choice.
    if (loaded.state === "unreadable") {
      return result({ status: "failed", reason: "open_failed", detail: "settings.yml could not be read", draft: "shown", used_default: false, saved: null });
    }
    if (loaded.state === "newer") {
      return notAttempted("unknown_saved_value", "your settings were saved by a newer Weave; update Weave");
    }
    let missingNote: string | undefined;
    const saved = resolveSavedChoice(settings, ctx.mainRoot);
    if (saved) {
      const { choice } = saved;
      if (choice.place === "none") {
        if (choice.ask === false) return notAttempted("dont_ask");
      } else {
        const place = registry.places.find((candidate) => candidate.id === choice.place);
        if (!place) return notAttempted("unknown_saved_value", `your default place "${choice.place}" isn't known to this Weave version; update Weave or run \`weave settings open\``);
        if (choice.agent && place.kind === "terminal" && !agentEntryFor(choice.agent, registry, settings)) {
          return notAttempted(
            "unknown_saved_value",
            `your default agent "${choice.agent}" isn't known here; add it under agents: in your settings, update Weave, or run \`weave settings open\``,
          );
        }
        const check = place.platforms.includes(runtime.platform) ? await withTimeout(place.check(runtime), timeouts.check).catch(() => undefined) : undefined;
        if (check?.state === "missing") {
          await clearOpenChoice(env, saved.scope, ctx.mainRoot);
          missingNote = `${place.label} isn't installed any more, so your ${saved.scope === "project" ? "setting for this project" : "default"} was cleared`;
        } else {
          const forward = await bringForward(ctx.folder, registry, runtime, timeouts.bringForward);
          if (forward) return result({ ...forward, used_default: true });
          return result(await openAt(choice, { ctx, registry, runtime, settings, env, timeouts, usedDefault: true, step: step.text, check }));
        }
      }
    }

    // 5. No choice yet: ask at a real terminal, otherwise hand the choices back.
    const choices = await listChoices({ registry, runtime, settings, env });
    if (!canPrompt({ json: ctx.json, interactive: ctx.interactive, env })) {
      return result({
        status: "needs_choice",
        reason: missingNote ? "default_missing" : "no_choice",
        ...(missingNote ? { detail: missingNote } : {}),
        draft: "shown",
        used_default: false,
        saved: null,
        choices,
      });
    }
    ctx.beforePrompt?.();
    if (missingNote) process.stdout.write(`${missingNote}.\n`);
    const answer = await (ctx.prompt ?? clackMenu)(choices, undefined, { askRemember: true });
    if (!answer || (answer.place === "none" && !("dontAsk" in answer && answer.dontAsk))) {
      return notAttempted("no_choice");
    }
    const scope = ctx.remember ?? "default";
    if (answer.place === "none") {
      await saveOpenChoice(env, scope, { place: "none" }, ctx.mainRoot);
      return result({ status: "not_attempted", reason: "dont_ask", draft: "shown", used_default: false, saved: scope });
    }
    const chosen: ExplicitChoice = { place: answer.place, ...("agent" in answer && answer.agent ? { agent: answer.agent } : {}) };
    // "Just this once" opens without saving, so the person is asked again next time.
    const keep = Boolean(ctx.remember) || ("remember" in answer && answer.remember === true);
    if (keep) await saveOpenChoice(env, scope, chosen, ctx.mainRoot);
    const forward = await bringForward(ctx.folder, registry, runtime, timeouts.bringForward);
    const outcome = forward ?? (await openAt(chosen, { ctx, registry, runtime, settings, env, timeouts, usedDefault: false, step: step.text }));
    outcome.saved = keep ? scope : null;
    return result(outcome);
  } catch (error) {
    return result({ status: "failed", reason: "open_failed", detail: oneLine(error), draft: "shown", used_default: false, saved: null });
  }
}

interface OpenAtOptions {
  ctx: OpenContext;
  registry: Registry;
  runtime: OpenRuntime;
  settings: UserSettings;
  env: NodeJS.ProcessEnv;
  timeouts: Timeouts;
  usedDefault: boolean;
  step: string;
  check?: CheckResult;
}

// 6. Open at a resolved place. A failure here never clears a saved default.
async function openAt(choice: ExplicitChoice, options: OpenAtOptions): Promise<OpenOutcome> {
  const { ctx, registry, runtime, settings, env, timeouts, usedDefault } = options;
  const base = { place: choice.place, ...(choice.agent ? { agent: choice.agent } : {}), draft: "shown" as const, used_default: usedDefault, saved: null };
  const place = registry.places.find((candidate) => candidate.id === choice.place);
  if (!place) return { ...base, status: "failed", reason: "open_failed", detail: `unknown place ${choice.place}` };

  if (isOverSsh(env) && !place.remoteOk) {
    return { ...base, status: "skipped", reason: "ssh", detail: `connected over SSH, so ${place.label} would open on a screen you can't see` };
  }
  if (!place.platforms.includes(runtime.platform)) {
    return { ...base, status: "skipped", reason: "unavailable_now", detail: `${place.label} isn't available on this system` };
  }
  if (place.kind === "app" && runtime.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return { ...base, status: "skipped", reason: "no_display", detail: `there's no display here for ${place.label}` };
  }

  let check: CheckResult;
  try {
    check = options.check ?? (await withTimeout(place.check(runtime), timeouts.check));
  } catch (error) {
    return { ...base, status: "failed", reason: error instanceof TimeoutError ? "timeout" : "open_failed", detail: `couldn't check ${place.label}: ${oneLine(error)}` };
  }
  if (check.state === "unavailable_now") return { ...base, status: "skipped", reason: "unavailable_now", detail: check.detail ?? `${place.label} isn't available right now` };
  if (check.state === "missing") return { ...base, status: "failed", reason: "open_failed", detail: check.detail ?? `${place.label} isn't installed` };

  try {
    if (place.kind === "app") {
      const draft = place.draft === "unsent" ? options.step : undefined;
      if (draft) {
        // A draft is a convenience: if opening with it fails, open without it.
        try {
          const opened = await withTimeout(place.open(check.executable!, { folder: ctx.folder, draft }, runtime), timeouts.open);
          return { ...base, status: "opened", where: opened.where, draft: "unsent" };
        } catch {
          // fall through to opening without the draft
        }
      }
      const opened = await withTimeout(place.open(check.executable!, { folder: ctx.folder }, runtime), timeouts.open);
      return { ...base, status: "opened", where: opened.where, draft: "shown" };
    }
    const agentId = choice.agent ?? shellAgentId;
    const agent = agentEntryFor(agentId, registry, settings);
    if (!agent) return { ...base, agent: agentId, status: "failed", reason: "agent_not_found", detail: `${agentId} isn't a known agent` };
    const executable = await agent.find(runtime);
    if (!executable) return { ...base, agent: agentId, status: "failed", reason: "agent_not_found", detail: `${agent.label} isn't installed or can't be found` };
    // An unsent draft goes through the place (herdr's first message) or the agent, never both,
    // and never to the person's own agents.
    const draftViaPlace = !agent.own && place.draft === "unsent";
    const draftViaAgent = !agent.own && !draftViaPlace && agent.draft === "unsent";
    const draft = draftViaPlace || draftViaAgent ? options.step : undefined;
    const line = terminalLine(agent.line(executable, ctx.folder, draftViaAgent ? draft : undefined));
    const opened = await withTimeout(
      place.open(check.executable, { folder: ctx.folder, title: tabTitle(ctx.changeId), line, ...(draftViaPlace ? { draft } : {}) }, runtime),
      timeouts.open,
    );
    return { ...base, agent: agentId, status: "opened", where: `${opened.where}${agentId === shellAgentId ? "" : ` with ${agent.label}`}`, draft: draft ? "unsent" : "shown" };
  } catch (error) {
    if (error instanceof TimeoutError) {
      const hint = runtime.platform === "darwin" ? " If macOS asked to allow control of another app, check System Settings › Privacy & Security › Automation." : "";
      return { ...base, status: "failed", reason: "timeout", detail: `${place.label} didn't respond in time.${hint}` };
    }
    return { ...base, status: "failed", reason: "open_failed", detail: `${place.label} couldn't be opened: ${oneLine(error)}` };
  }
}

// 4. A tab or window already in the change folder is brought forward instead of opening
// another. Runs only once a non-"none" choice has resolved; any error just means "none".
async function bringForward(folder: string, registry: Registry, runtime: OpenRuntime, ms: number): Promise<OpenOutcome | undefined> {
  const real = await realpath(folder).catch(() => folder);
  for (const place of registry.places) {
    if (place.kind !== "terminal" || !place.bringForward) continue;
    const found = await withTimeout(place.bringForward(real, runtime), ms).catch(() => undefined);
    if (found) return { status: "brought_forward", place: place.id, where: found.where, draft: "shown", used_default: false, saved: null };
  }
  return undefined;
}

export async function listChoices(options: { registry?: Registry; runtime: OpenRuntime; settings: UserSettings; env: NodeJS.ProcessEnv }): Promise<OpenMenuChoice[]> {
  const registry = options.registry ?? defaultRegistry;
  const { runtime, settings, env } = options;
  const agents: OpenChoiceAgent[] = [];
  for (const agent of registry.agents) {
    if (agent.id === shellAgentId) continue;
    if (await agent.find(runtime).catch(() => undefined)) agents.push({ id: agent.id, label: agent.label });
  }
  for (const [name, own] of Object.entries(ownAgents(settings))) agents.push({ id: name, label: own.label ?? name, own: true });
  agents.push({ id: shellAgentId, label: "Just a shell" });

  const choices: OpenMenuChoice[] = [];
  for (const place of registry.places) {
    if (!place.platforms.includes(runtime.platform)) continue;
    if (isOverSsh(env) && !place.remoteOk) continue;
    if (place.kind === "app" && runtime.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) continue;
    const check = await withTimeout(place.check(runtime), defaultTimeouts.check).catch(() => undefined);
    if (check?.state !== "available") continue;
    choices.push({
      place: place.id,
      kind: place.kind,
      label: place.label,
      ...(place.hint ? { hint: place.hint } : {}),
      ...(place.kind === "terminal" ? { agents } : {}),
    });
  }
  choices.push({ place: "none", kind: "none", label: "Don't open" });
  return choices;
}

export function agentEntryFor(id: string, registry: Registry, settings: UserSettings): AgentEntry | undefined {
  const listed = registry.agents.find((agent) => agent.id === id);
  if (listed) return listed;
  const own = ownAgents(settings)[id];
  return own ? ownAgentEntry(id, own.command, own.label) : undefined;
}

function allAgentIds(registry: Registry, settings: UserSettings): string[] {
  return [...registry.agents.map((agent) => agent.id), ...Object.keys(ownAgents(settings))];
}

// What the original session prints after an opening attempt.
export function formatOpenLines(result: OpenResult, folder: string): string[] {
  const { open, next_step: step } = result;
  switch (open.status) {
    case "opened":
      return [
        `Opened in ${open.where}, continue there.`,
        `Next step: ${step}${open.draft === "unsent" ? " (filled in, not sent)" : ""}`,
        `If it didn't start: open ${folder} and run the step there.`,
        ...(open.used_default ? ["Change where changes open: weave settings open"] : []),
      ];
    case "brought_forward":
      return [`Brought forward ${open.where}.`, `Next step: ${step}`];
    case "skipped":
    case "failed":
      return [`Didn't open: ${open.detail ?? "opening failed"}.`, `Open ${folder} in a new session and run: ${step}`];
    case "not_attempted":
      if (open.reason === "already_inside") return [`Next step: ${step}`];
      return [
        ...(open.reason === "unknown_saved_value" && open.detail ? [`Didn't open: ${open.detail}.`] : []),
        `Open ${folder} in a new session to work on this change.`,
        ...(result.step_given || open.reason === "unknown_saved_value" ? [`Next step there: ${step}`] : []),
      ];
    case "needs_choice":
      return [
        ...(open.detail ? [`${open.detail}.`] : []),
        `Open ${folder} in a new session to work on this change.`,
        ...(result.step_given ? [`Next step there: ${step}`] : []),
      ];
  }
}

// True when the create/switch summary's "Open <folder> in a new session" line should be
// replaced: only when something happened, so scripts without a default see today's output.
export function replacesOpenLine(result: OpenResult): boolean {
  const { status, reason } = result.open;
  if (status === "not_attempted" || status === "needs_choice") {
    return reason === "already_inside" || reason === "unknown_saved_value" || Boolean(result.open.detail) || result.step_given;
  }
  return true;
}

// Puts the outcome lines where the create/switch summary's "Open <folder> in a new
// session" line is, keeping every other line (such as "Slot changed") where it was.
export function placeOpenLines(message: string, folder: string, result: OpenResult): string {
  if (!replacesOpenLine(result)) return message;
  const openLine = `Open ${folder} in a new session to work on this change.`;
  const lines = message.split("\n");
  const index = lines.indexOf(openLine);
  const replacement = formatOpenLines(result, folder);
  if (index === -1) return [...lines, "", ...replacement].join("\n");
  return [...lines.slice(0, index), ...replacement, ...lines.slice(index + 1)].join("\n");
}

function tabTitle(changeId: string): string {
  return changeId.split("-").slice(0, 2).join("-");
}

async function isInside(cwd: string, folder: string): Promise<boolean> {
  try {
    const [here, target] = await Promise.all([realpath(cwd), realpath(folder)]);
    return here === target || here.startsWith(`${target}${path.sep}`);
  } catch {
    return false;
  }
}

export class TimeoutError extends Error {
  constructor() {
    super("timed out");
    this.name = "TimeoutError";
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError()), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function oneLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n").map((part) => part.trim()).find(Boolean) ?? "unknown error";
}

// The two-step menu at a real terminal: where, then (for terminals) what to start.
async function clackMenu(choices: OpenMenuChoice[], current?: OpenChoice, options: { askRemember?: boolean } = {}): Promise<MenuAnswer | undefined> {
  const { select, confirm, isCancel } = await import("@clack/prompts");
  const place = await select({
    message: "Where should changes open?",
    options: choices.map((choice) => ({ value: choice.place, label: choice.label, ...(choice.hint ? { hint: choice.hint } : {}) })),
    ...(current ? { initialValue: current.place } : {}),
  });
  if (isCancel(place)) return undefined;
  const chosen = choices.find((choice) => choice.place === place)!;
  if (chosen.kind === "none") {
    const dontAsk = await confirm({ message: "Don't ask again? (You can change this later with `weave settings open`.)", initialValue: false });
    if (isCancel(dontAsk)) return undefined;
    return { place: "none", dontAsk: dontAsk === true };
  }
  let agent: string | undefined;
  if (chosen.kind === "terminal") {
    const picked = await select({
      message: `What should start in the ${chosen.label}?`,
      options: (chosen.agents ?? []).map((item) => ({ value: item.id, label: item.label, ...(item.own ? { hint: "your agent" } : {}) })),
      ...(current?.agent ? { initialValue: current.agent } : {}),
    });
    if (isCancel(picked)) return undefined;
    agent = String(picked);
  }
  let remember = true;
  if (options.askRemember) {
    const keep = await select({
      message: "Just this once, or make it your default?",
      options: [
        { value: "once", label: "Just this once", hint: "you'll be asked again next time" },
        { value: "default", label: "Make it my default", hint: "change it later with `weave settings open`" },
      ],
    });
    if (isCancel(keep)) return undefined;
    remember = keep === "default";
  }
  return { place: chosen.place, ...(agent ? { agent } : {}), remember };
}

export { clackMenu as defaultMenuPrompt };

// The menu's choices on this machine right now, for `--choices` and `weave settings open`.
export async function currentChoices(options: { env?: NodeJS.ProcessEnv; registry?: Registry; runtime?: OpenRuntime } = {}): Promise<OpenMenuChoice[]> {
  const env = options.env ?? process.env;
  const settings = (await loadUserSettings(env)).settings;
  const baseRuntime = options.runtime ?? defaultRuntime(env, getUserHome(env), {});
  const runtime: OpenRuntime = { ...baseRuntime, locations: { ...customLocations(settings), ...baseRuntime.locations } };
  return listChoices({ registry: options.registry, runtime, settings, env });
}
