import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { ensureDir, pathExists, writeFileAtomic } from "./files.js";
import { getUserWeaveDir } from "./user-paths.js";

// Personal settings: personal to the person and their machine, never written into a
// project (decision 261109-a8k5). The only reader and writer of ~/.weave/settings.yml.

export const settingsVersion = 1;

export interface OpenChoice {
  place: string;
  agent?: string;
  // Only with place "none": false means "don't open, don't ask again".
  ask?: boolean;
}

export interface CommitsChoice {
  enabled: boolean;
}

export interface OwnAgent {
  command: string;
  label?: string;
}

export interface UserSettings {
  version: number;
  open?: {
    default?: OpenChoice;
    projects?: Record<string, OpenChoice>;
  };
  agents?: Record<string, OwnAgent>;
  locations?: Record<string, string>;
  // Checkpoint commits (decision 261111-htho): a personal off switch, for every project or one.
  commits?: {
    default?: CommitsChoice;
    projects?: Record<string, CommitsChoice>;
  };
  // Anything else is kept as is on write.
  [key: string]: unknown;
}

export type SettingsLoad =
  | { state: "missing"; settings: UserSettings }
  | { state: "ok"; settings: UserSettings }
  // A newer version or unreadable YAML: never written while in this state.
  | { state: "unreadable"; settings: UserSettings; reason: string }
  | { state: "newer"; settings: UserSettings; version: number };

export type SettingsScope = "default" | "project";

export interface ResolvedChoice {
  choice: OpenChoice;
  scope: SettingsScope;
}

export function userSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getUserWeaveDir(env), "settings.yml");
}

export async function loadUserSettings(env: NodeJS.ProcessEnv = process.env): Promise<SettingsLoad> {
  const file = userSettingsPath(env);
  if (!(await pathExists(file))) {
    return { state: "missing", settings: { version: settingsVersion } };
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(await readFile(file, "utf8"));
  } catch (error) {
    return { state: "unreadable", settings: { version: settingsVersion }, reason: error instanceof Error ? error.message : String(error) };
  }
  if (parsed === null || parsed === undefined) {
    return { state: "ok", settings: { version: settingsVersion } };
  }
  if (!isRecord(parsed)) {
    return { state: "unreadable", settings: { version: settingsVersion }, reason: "settings.yml is not a mapping" };
  }
  const version = typeof parsed.version === "number" ? parsed.version : settingsVersion;
  if (version > settingsVersion) {
    return { state: "newer", settings: parsed as UserSettings, version };
  }
  return { state: "ok", settings: { ...parsed, version } as UserSettings };
}

// Read-modify-write. Refuses to touch a file it could not read or one from a newer Weave.
export async function updateUserSettings(
  env: NodeJS.ProcessEnv,
  update: (settings: UserSettings) => UserSettings,
): Promise<UserSettings> {
  const loaded = await loadUserSettings(env);
  if (loaded.state === "unreadable") {
    throw new SettingsError("invalid_settings", `${userSettingsPath(env)} could not be read (${loaded.reason}); fix or remove it first.`);
  }
  if (loaded.state === "newer") {
    throw new SettingsError("invalid_settings", `${userSettingsPath(env)} was written by a newer Weave (version ${loaded.version}); update Weave to change it.`);
  }
  const next = update(structuredClone(loaded.settings));
  const file = userSettingsPath(env);
  await ensureDir(path.dirname(file));
  await writeFileAtomic(file, YAML.stringify(next));
  return next;
}

export async function saveOpenChoice(
  env: NodeJS.ProcessEnv,
  scope: SettingsScope,
  choice: OpenChoice,
  projectKey?: string,
): Promise<void> {
  await updateUserSettings(env, (settings) => {
    const open = { ...(settings.open ?? {}) };
    const value = cleanChoice(choice);
    if (scope === "project") {
      if (!projectKey) throw new SettingsError("no_weave_context", "A per-project setting needs a Weave project.");
      open.projects = { ...(open.projects ?? {}), [projectKey]: value };
    } else {
      open.default = value;
    }
    return { ...settings, open };
  });
}

export async function clearOpenChoice(env: NodeJS.ProcessEnv, scope: SettingsScope, projectKey?: string): Promise<boolean> {
  const loaded = await loadUserSettings(env);
  const present = scope === "project" ? Boolean(projectKey && loaded.settings.open?.projects?.[projectKey]) : Boolean(loaded.settings.open?.default);
  if (!present) return false;
  await updateUserSettings(env, (settings) => {
    const open = { ...(settings.open ?? {}) };
    if (scope === "project") {
      const projects = { ...(open.projects ?? {}) };
      delete projects[projectKey!];
      open.projects = projects;
      if (Object.keys(projects).length === 0) delete open.projects;
    } else {
      delete open.default;
    }
    return { ...settings, open };
  });
  return true;
}

// Project override first, then the personal default.
export function resolveSavedChoice(settings: UserSettings, projectKey?: string): ResolvedChoice | undefined {
  const project = projectKey ? settings.open?.projects?.[projectKey] : undefined;
  if (isChoice(project)) return { choice: project, scope: "project" };
  const fallback = settings.open?.default;
  if (isChoice(fallback)) return { choice: fallback, scope: "default" };
  return undefined;
}

export function ownAgents(settings: UserSettings): Record<string, OwnAgent> {
  const result: Record<string, OwnAgent> = {};
  for (const [name, value] of Object.entries(settings.agents ?? {})) {
    if (isRecord(value) && typeof value.command === "string" && value.command.trim()) {
      result[name] = { command: value.command, ...(typeof value.label === "string" ? { label: value.label } : {}) };
    }
  }
  return result;
}

export function customLocations(settings: UserSettings): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [id, value] of Object.entries(settings.locations ?? {})) {
    if (typeof value === "string" && path.isAbsolute(value)) result[id] = value;
  }
  return result;
}

export class SettingsError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SettingsError";
  }
}

function cleanChoice(choice: OpenChoice): OpenChoice {
  if (choice.place === "none") return { place: "none", ask: false };
  return { place: choice.place, ...(choice.agent ? { agent: choice.agent } : {}) };
}

function isChoice(value: unknown): value is OpenChoice {
  return isRecord(value) && typeof value.place === "string" && value.place.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
