// Checkpoint commits (decision 261111-htho): Weave commits a change's work on the change's own
// branch at fixed moments. Planning commits run inside the commands that record change status
// (progress, verdict, clear-stale, knowledge, review results); code commits run when a slice
// finishes building and when review fixes are packaged.
//
// Everything here is best-effort. A checkpoint never throws and never blocks the command that
// called it: it returns an outcome (`committed`, `skipped`, or `failed` with a reason) that the
// command adds to its result. Commits use the person's own git identity (nothing is substituted),
// never push, never amend, and are made only on the change's branch.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { pathExists } from "./files.js";
import { localStateDir } from "./local-state.js";
import { loadUserSettings, type UserSettings } from "./user-settings.js";
import { mainCheckoutPath } from "./worktrees.js";

export type CheckpointKind = "planning" | "catch-up" | "build" | "fix" | "final-fix";
export type CheckpointStatus = "committed" | "skipped" | "failed";

export type CheckpointSkipReason =
  | "commits_off_project"
  | "commits_off_personal"
  | "change_skipped"
  | "flat_change"
  | "unattended"
  | "not_a_git_repo"
  | "build_not_committed"
  | "nothing_to_commit"
  | "wrong_branch"
  | "detached_head"
  | "operation_in_progress";

export type CheckpointFailReason = "hooks_rejected" | "index_locked" | "identity_missing" | "timeout" | "git_error";

export type CheckpointReason = CheckpointSkipReason | CheckpointFailReason;

export interface CheckpointOutcome {
  status: CheckpointStatus;
  kind: CheckpointKind;
  repo?: string;
  slice?: string;
  sha?: string;
  subject?: string;
  files?: string[];
  reason?: CheckpointReason;
  detail?: string;
  catch_up?: CheckpointOutcome;
  leftovers_from?: string;
  includes_rounds?: number[];
  notice?: "commits_enabled";
  warnings?: string[];
}

// What a planning commit records. Each moment owns some paths; anything else that changed in the
// change's planning scope goes into a catch-up commit made just before it.
export type PlanningMoment =
  | { kind: "progress"; lane: string; staleLanes?: string[] }
  | { kind: "verdict"; lane: string; verdict: string; session?: string }
  | { kind: "clear-stale"; lane: string }
  | { kind: "knowledge"; status: string }
  | { kind: "review"; slice?: string; run: string; result: string };

export interface CheckpointChange {
  // The Weave root: the repo or workspace root (the change folder in worktree mode).
  weaveRoot: string;
  changeId: string;
  changePath: string;
  branch: string;
  title?: string;
}

export interface PlanningCheckpointInput extends CheckpointChange {
  moment: PlanningMoment;
  // One-line gist the skill wrote, used in the subject.
  summary?: string;
  // A full message (used verbatim; trailers are appended).
  message?: string;
  env?: NodeJS.ProcessEnv;
}

export const planningTimeoutMs = 60_000;
export const defaultCodeTimeoutSeconds = 300;
const detailLimit = 500;
const maxBuffer = 64 * 1024 * 1024;

// --- git runner ---------------------------------------------------------------------------------

export interface CheckpointGitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// Runs git with the environment passed through untouched (no identity substitution, unlike the
// helpers in git.ts), never prompting, and with a timeout that sends SIGTERM so git can remove its
// own lock files.
export async function checkpointGit(
  args: string[],
  cwd: string,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CheckpointGitResult> {
  const env = { ...(options.env ?? process.env), GIT_TERMINAL_PROMPT: "0" };
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, env, maxBuffer, encoding: "utf8", timeout: options.timeoutMs ?? 0, killSignal: "SIGTERM" },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, stdout, stderr, timedOut: false });
          return;
        }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
        resolve({
          ok: false,
          stdout: stdout ?? "",
          stderr: (stderr || failure.message || "").toString(),
          timedOut: Boolean(failure.killed) && failure.signal === "SIGTERM",
        });
      },
    );
  });
}

function firstLines(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > detailLimit ? `${trimmed.slice(0, detailLimit - 1)}…` : trimmed;
}

export function classifyCommitFailure(result: CheckpointGitResult, hooksRan: boolean): { reason: CheckpointFailReason; detail: string } {
  const detail = firstLines(result.stderr || result.stdout);
  if (result.timedOut) return { reason: "timeout", detail };
  if (/index\.lock/.test(result.stderr)) return { reason: "index_locked", detail };
  if (/tell me who you are|empty ident|unable to auto-detect email|no email was given/i.test(result.stderr)) {
    return { reason: "identity_missing", detail };
  }
  return { reason: hooksRan ? "hooks_rejected" : "git_error", detail };
}

// --- settings -----------------------------------------------------------------------------------

export type SubjectTemplate = string | Partial<Record<CheckpointKind, string>>;

export interface CommitSettings {
  enabled: boolean;
  offReason?: "commits_off_project" | "commits_off_personal" | "change_skipped";
  subjectTemplate?: SubjectTemplate;
  codeTimeoutSeconds: number;
  warnings: string[];
}

interface ProjectCommitConfig {
  enabled?: boolean;
  subject_template?: SubjectTemplate;
  code_timeout_seconds?: number;
}

async function readProjectCommitConfig(root: string | undefined): Promise<ProjectCommitConfig | undefined> {
  if (!root) return undefined;
  const file = path.join(root, ".weave", "workspace.yml");
  if (!(await pathExists(file))) return undefined;
  try {
    const parsed = YAML.parse(await readFile(file, "utf8")) as Record<string, unknown> | null;
    const commits = parsed && typeof parsed === "object" ? parsed.commits : undefined;
    if (!commits || typeof commits !== "object" || Array.isArray(commits)) return {};
    const record = commits as Record<string, unknown>;
    const config: ProjectCommitConfig = {};
    if (typeof record.enabled === "boolean") config.enabled = record.enabled;
    if (typeof record.code_timeout_seconds === "number" && record.code_timeout_seconds > 0) {
      config.code_timeout_seconds = record.code_timeout_seconds;
    }
    const template = record.subject_template;
    if (typeof template === "string") {
      config.subject_template = template;
    } else if (template && typeof template === "object" && !Array.isArray(template)) {
      const map: Partial<Record<CheckpointKind, string>> = {};
      for (const kind of ["planning", "catch-up", "build", "fix", "final-fix"] as const) {
        const value = (template as Record<string, unknown>)[kind];
        if (typeof value === "string") map[kind] = value;
      }
      config.subject_template = map;
    }
    return config;
  } catch {
    return {};
  }
}

// The personal switch: `commits.projects.<key>.enabled` beats `commits.default.enabled`.
export function personalCommitsEnabled(settings: UserSettings, projectKey: string | undefined): boolean | undefined {
  const commits = settings.commits;
  if (!commits) return undefined;
  if (projectKey) {
    const project = commits.projects?.[projectKey]?.enabled;
    if (typeof project === "boolean") return project;
  }
  const fallback = commits.default?.enabled;
  return typeof fallback === "boolean" ? fallback : undefined;
}

async function changeSkipped(changePath: string): Promise<boolean> {
  try {
    const parsed = YAML.parse(await readFile(path.join(changePath, "status.yml"), "utf8")) as Record<string, unknown> | null;
    const commits = parsed?.commits as Record<string, unknown> | undefined;
    return Boolean(commits && typeof commits === "object" && commits.skipped && typeof commits.skipped === "object");
  } catch {
    return false;
  }
}

// The main checkout of the repo holding `root`, or undefined outside git.
async function mainCheckout(root: string, env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  const listed = await checkpointGit(["worktree", "list", "--porcelain"], root, { env });
  if (!listed.ok) return undefined;
  const first = listed.stdout.split("\n").find((line) => line.startsWith("worktree "));
  return first ? first.slice("worktree ".length).trim() : undefined;
}

// Project off (in the main checkout or this folder) wins, then a personal off, then a per-change
// skip. The project key for personal settings is the main checkout's path, as for open choices.
export async function resolveCommitSettings(change: Pick<CheckpointChange, "weaveRoot" | "changePath">, env: NodeJS.ProcessEnv = process.env): Promise<CommitSettings> {
  const warnings: string[] = [];
  const main = await mainCheckout(change.weaveRoot, env);
  const local = await readProjectCommitConfig(change.weaveRoot);
  const fromMain = main && path.resolve(main) !== path.resolve(change.weaveRoot) ? await readProjectCommitConfig(main) : undefined;
  const subjectTemplate = local?.subject_template ?? fromMain?.subject_template;
  const codeTimeoutSeconds = local?.code_timeout_seconds ?? fromMain?.code_timeout_seconds ?? defaultCodeTimeoutSeconds;
  const base = { subjectTemplate, codeTimeoutSeconds, warnings };
  if (local?.enabled === false || fromMain?.enabled === false) {
    return { ...base, enabled: false, offReason: "commits_off_project" };
  }
  const loaded = await loadUserSettings(env);
  if (loaded.state === "ok") {
    const key = await mainCheckoutPath(change.weaveRoot).catch(() => undefined);
    const personal = personalCommitsEnabled(loaded.settings, key);
    if (personal === false) {
      return { ...base, enabled: false, offReason: "commits_off_personal" };
    }
  } else if (loaded.state !== "missing") {
    warnings.push("settings_unreadable");
  }
  if (await changeSkipped(change.changePath)) {
    return { ...base, enabled: false, offReason: "change_skipped" };
  }
  return { ...base, enabled: true };
}

// --- repo guard ---------------------------------------------------------------------------------

export interface RepoGuard {
  ok: boolean;
  gitRoot?: string;
  reason?: CheckpointSkipReason;
  detail?: string;
}

export async function guardRepo(cwd: string, branch: string, env?: NodeJS.ProcessEnv): Promise<RepoGuard> {
  const top = await checkpointGit(["rev-parse", "--show-toplevel"], cwd, { env });
  if (!top.ok) return { ok: false, reason: "not_a_git_repo" };
  const gitRoot = top.stdout.trim();
  const head = await checkpointGit(["symbolic-ref", "-q", "HEAD"], gitRoot, { env });
  if (!head.ok) return { ok: false, gitRoot, reason: "detached_head" };
  const current = head.stdout.trim().replace(/^refs\/heads\//, "");
  if (current !== branch) {
    return { ok: false, gitRoot, reason: "wrong_branch", detail: `on ${current}, expected ${branch}` };
  }
  const gitDir = await checkpointGit(["rev-parse", "--absolute-git-dir"], gitRoot, { env });
  if (gitDir.ok) {
    const dir = gitDir.stdout.trim();
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
      if (await pathExists(path.join(dir, marker))) {
        return { ok: false, gitRoot, reason: "operation_in_progress", detail: marker };
      }
    }
  }
  return { ok: true, gitRoot };
}

// --- planning scope and ownership ---------------------------------------------------------------

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function rel(gitRoot: string, absolute: string): string {
  return toPosix(path.relative(gitRoot, absolute));
}

async function frontmatter(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const content = await readFile(file, "utf8");
    const match = /^---\n([\s\S]*?)\n---/.exec(content);
    if (!match) return undefined;
    const parsed = YAML.parse(match[1] ?? "") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// Decision files this change owns: the ones it created, the ones they supersede (their
// `superseded_by` names one of them), and the decisions index.
export async function changeDecisionFiles(weaveRoot: string, changeId: string): Promise<string[]> {
  const dir = path.join(weaveRoot, "wiki", "decisions");
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".md"));
  } catch {
    return [];
  }
  const own = new Set<string>();
  const metas = new Map<string, Record<string, unknown>>();
  for (const name of names) {
    if (name === "index.md") continue;
    const meta = await frontmatter(path.join(dir, name));
    if (!meta) continue;
    metas.set(name, meta);
    if (meta.change === changeId && typeof meta.id === "string") own.add(meta.id);
  }
  const files: string[] = [];
  for (const [name, meta] of metas) {
    const ownsIt = meta.change === changeId;
    const supersededByOwn = typeof meta.superseded_by === "string" && own.has(meta.superseded_by);
    if (ownsIt || supersededByOwn) files.push(path.join(dir, name));
  }
  if (files.length > 0 && (await pathExists(path.join(dir, "index.md")))) files.push(path.join(dir, "index.md"));
  return files;
}

// Knowledge paths this change lists in its status (`knowledge.files`, `domains`, `shared`), plus
// the knowledge index files.
export async function changeKnowledgePaths(weaveRoot: string, changePath: string): Promise<string[]> {
  let knowledge: Record<string, unknown> | undefined;
  try {
    const parsed = YAML.parse(await readFile(path.join(changePath, "status.yml"), "utf8")) as Record<string, unknown> | null;
    knowledge = parsed?.knowledge && typeof parsed.knowledge === "object" ? (parsed.knowledge as Record<string, unknown>) : undefined;
  } catch {
    knowledge = undefined;
  }
  if (!knowledge) return [];
  const root = path.join(weaveRoot, "wiki", "knowledge");
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  const resolveEntry = (entry: string, folder: string): string => {
    if (entry.startsWith("wiki/")) return path.join(weaveRoot, entry);
    if (entry.includes("/")) return path.join(root, entry);
    return path.join(root, folder, entry);
  };
  const paths = [
    ...strings(knowledge.files).map((entry) => (entry.startsWith("wiki/") ? path.join(weaveRoot, entry) : path.join(root, entry))),
    ...strings(knowledge.domains).map((entry) => resolveEntry(entry, "domains")),
    ...strings(knowledge.shared).map((entry) => resolveEntry(entry, "shared")),
  ];
  for (const index of ["index.md", path.join("domains", "README.md"), path.join("shared", "README.md")]) {
    paths.push(path.join(root, index));
  }
  return paths;
}

const laneArtifacts: Record<string, string[]> = {
  questions: ["questions.md"],
  research: ["research.md"],
  exploration: ["exploration.md"],
  prd: ["prd.md"],
  findings: ["findings.md"],
  architecture: ["architecture.md", "architecture/"],
  slices: ["task-slices/", "tasks.md"],
  issues: ["task-slices/", "tasks.md"],
};

function matchesPrefix(relPath: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => (prefix.endsWith("/") ? relPath.startsWith(prefix) : relPath === prefix));
}

const sessionNote = /^sessions\/\d{8}-\d{6}-[a-z0-9]+-(.+)\.md$/;

// Whether a path (relative to the change folder) belongs to the moment being recorded.
export function ownedByMoment(changeRelPath: string, moment: PlanningMoment): boolean {
  if (changeRelPath === "status.yml" || /^task-slices\/[^/]+\/status\.yml$/.test(changeRelPath) || changeRelPath === "task-slices/dependency-graph.md") {
    return true;
  }
  switch (moment.kind) {
    case "progress": {
      if (matchesPrefix(changeRelPath, laneArtifacts[moment.lane] ?? [])) return true;
      const note = sessionNote.exec(changeRelPath);
      return Boolean(note && (note[1] === moment.lane || note[1]?.startsWith(`${moment.lane}-`)));
    }
    case "verdict": {
      const note = sessionNote.exec(changeRelPath);
      if (moment.session && toPosix(moment.session).endsWith(changeRelPath)) return true;
      return Boolean(note && note[1] === `${moment.lane}-stress-test`);
    }
    case "knowledge":
      return changeRelPath === "knowledge-delta.md";
    case "review":
      return (
        changeRelPath === "review.md" ||
        changeRelPath.startsWith("review/") ||
        (moment.slice ? changeRelPath.startsWith(`task-slices/${moment.slice}/review/`) : /^task-slices\/[^/]+\/review\//.test(changeRelPath))
      );
    case "clear-stale":
      return false;
  }
}

function momentOwnsDecisions(moment: PlanningMoment): boolean {
  return (moment.kind === "progress" && moment.lane === "architecture") || moment.kind === "verdict";
}

// Paths with changes (staged, unstaged, or untracked) under the given pathspecs, relative to the
// git root.
export async function changedPaths(gitRoot: string, pathspecs: string[], env?: NodeJS.ProcessEnv): Promise<string[]> {
  if (pathspecs.length === 0) return [];
  const status = await checkpointGit(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", ...pathspecs], gitRoot, { env });
  if (!status.ok) return [];
  const files: string[] = [];
  for (const entry of status.stdout.split("\0")) {
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
  }
  return [...new Set(files)];
}

// --- messages -----------------------------------------------------------------------------------

const stageNames: Record<string, string> = {
  questions: "Questions",
  research: "Research",
  exploration: "Product shape",
  prd: "PRD",
  findings: "Findings",
  architecture: "Architecture",
  slices: "Slices",
  issues: "Slices",
};

export function stageName(lane: string): string {
  return stageNames[lane] ?? lane.charAt(0).toUpperCase() + lane.slice(1);
}

export function applySubjectTemplate(
  template: SubjectTemplate | undefined,
  kind: CheckpointKind,
  values: { subject: string; stage?: string; slice?: string; change: string },
): string {
  const chosen = typeof template === "string" ? template : template?.[kind];
  if (!chosen) return values.subject;
  return chosen.replace(/\{(subject|stage|slice|change)\}/g, (_match, key: string) => {
    const value = values[key as keyof typeof values];
    return value ?? "";
  });
}

export function wrap(text: string, width = 72): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.length <= width || line.includes("://")) return line;
      const words = line.split(" ");
      const lines: string[] = [];
      let current = "";
      for (const word of words) {
        if (current.length > 0 && current.length + 1 + word.length > width) {
          lines.push(current);
          current = word;
        } else {
          current = current.length > 0 ? `${current} ${word}` : word;
        }
      }
      if (current.length > 0) lines.push(current);
      return lines.join("\n");
    })
    .join("\n");
}

export function composeMessage(subject: string, body: string[], trailers: Array<[string, string]>): string {
  const parts = [subject.trim()];
  const bodyText = body.filter((line) => line.trim().length > 0).join("\n\n");
  if (bodyText) parts.push(wrap(bodyText));
  parts.push(trailers.map(([key, value]) => `${key}: ${value}`).join("\n"));
  return `${parts.join("\n\n")}\n`;
}

async function artifactTitle(changePath: string, moment: PlanningMoment): Promise<string | undefined> {
  if (moment.kind !== "progress") return undefined;
  const files = (laneArtifacts[moment.lane] ?? []).filter((entry) => entry.endsWith(".md"));
  const candidates = moment.lane === "architecture" ? ["architecture/index.md", "architecture.md"] : files;
  for (const file of candidates) {
    try {
      const content = await readFile(path.join(changePath, file), "utf8");
      const heading = /^#\s+(.+)$/m.exec(content.replace(/^---\n[\s\S]*?\n---\n/, ""));
      if (heading?.[1]) return heading[1].trim();
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

async function planningSubject(input: PlanningCheckpointInput): Promise<{ subject: string; stage: string }> {
  const { moment } = input;
  const summary = input.summary?.trim();
  switch (moment.kind) {
    case "progress": {
      const stage = stageName(moment.lane);
      const gist = summary || (await artifactTitle(input.changePath, moment)) || input.title || input.changeId;
      return { subject: `${stage}: ${gist}`, stage: moment.lane };
    }
    case "verdict":
      return {
        subject: `Stress test (${moment.lane}): ${moment.verdict.replace(/-/g, " ")}${summary ? ` — ${summary}` : ""}`,
        stage: "verdict",
      };
    case "clear-stale":
      return { subject: `${stageName(moment.lane)}: back in line${summary ? ` — ${summary}` : ""}`, stage: "clear-stale" };
    case "knowledge":
      return { subject: `Knowledge: ${summary || moment.status}`, stage: "knowledge" };
    case "review":
      return {
        subject: `${moment.slice ? `Slice ${moment.slice}` : "Final"} review: ${summary || moment.result.replace(/_/g, " ")}`,
        stage: "review",
      };
  }
}

// --- planning checkpoint ------------------------------------------------------------------------

async function withEmptyHooksDir<T>(action: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "weave-no-hooks-"));
  try {
    return await action(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function commitWithMessage(
  gitRoot: string,
  message: string,
  extraArgs: string[],
  options: { hooksDir?: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<CheckpointGitResult & { sha?: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "weave-commit-msg-"));
  const file = path.join(dir, "MESSAGE");
  try {
    await writeFile(file, message);
    const config = options.hooksDir ? ["-c", `core.hooksPath=${options.hooksDir}`] : [];
    const result = await checkpointGit([...config, "commit", "--no-edit", "-F", file, ...extraArgs], gitRoot, {
      env: options.env,
      timeoutMs: options.timeoutMs,
    });
    if (!result.ok) return result;
    const head = await checkpointGit(["rev-parse", "HEAD"], gitRoot, { env: options.env });
    return { ...result, ...(head.ok ? { sha: head.stdout.trim() } : {}) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function stagedAnything(gitRoot: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  const diff = await checkpointGit(["diff", "--cached", "--quiet"], gitRoot, { env });
  return !diff.ok;
}

// Records a planning moment in git. Call it after the status write. Never throws.
export async function planningCheckpoint(input: PlanningCheckpointInput): Promise<CheckpointOutcome> {
  try {
    return await runPlanningCheckpoint(input);
  } catch (error) {
    return { status: "failed", kind: "planning", reason: "git_error", detail: firstLines((error as Error).message ?? String(error)) };
  }
}

async function runPlanningCheckpoint(input: PlanningCheckpointInput): Promise<CheckpointOutcome> {
  const env = input.env ?? process.env;
  const settings = await resolveCommitSettings(input, env);
  const warnings = settings.warnings.length > 0 ? { warnings: settings.warnings } : {};
  if (!settings.enabled) {
    return { status: "skipped", kind: "planning", reason: settings.offReason, ...warnings };
  }
  const guard = await guardRepo(input.weaveRoot, input.branch, env);
  if (!guard.ok || !guard.gitRoot) {
    return { status: "skipped", kind: "planning", reason: guard.reason, ...(guard.detail ? { detail: guard.detail } : {}), ...warnings };
  }
  const gitRoot = guard.gitRoot;
  const changeRel = rel(gitRoot, input.changePath);
  const decisions = await changeDecisionFiles(input.weaveRoot, input.changeId);
  const knowledge = await changeKnowledgePaths(input.weaveRoot, input.changePath);
  const scope = [changeRel, ...decisions.map((file) => rel(gitRoot, file)), ...knowledge.map((file) => rel(gitRoot, file))].filter(
    (entry) => entry.length > 0 && !entry.startsWith(".."),
  );
  const dirty = await changedPaths(gitRoot, scope, env);
  const decisionSet = new Set(decisions.map((file) => rel(gitRoot, file)));
  const knowledgeRoots = knowledge.map((file) => rel(gitRoot, file));
  const owned: string[] = [];
  const leftovers: string[] = [];
  for (const file of dirty) {
    const inChange = file === changeRel || file.startsWith(`${changeRel}/`);
    let ownsIt: boolean;
    if (inChange) {
      ownsIt = ownedByMoment(file.slice(changeRel.length + 1), input.moment);
    } else if (decisionSet.has(file)) {
      ownsIt = momentOwnsDecisions(input.moment);
    } else {
      ownsIt = input.moment.kind === "knowledge" && knowledgeRoots.some((root) => file === root || file.startsWith(`${root}/`));
    }
    (ownsIt ? owned : leftovers).push(file);
  }

  return withEmptyHooksDir(async (hooksDir) => {
    let catchUp: CheckpointOutcome | undefined;
    if (leftovers.length > 0) {
      catchUp = await catchUpCommit(gitRoot, leftovers, input, settings, hooksDir, env);
    }
    const notice = await noticeFor(gitRoot, env);
    if (owned.length > 0) {
      const added = await checkpointGit(["add", "-A", "--", ...owned], gitRoot, { env, timeoutMs: planningTimeoutMs });
      if (!added.ok) {
        const failure = classifyCommitFailure(added, false);
        return withCatchUp({ status: "failed", kind: "planning", reason: failure.reason, detail: failure.detail, ...warnings }, catchUp);
      }
    }
    if (!(await stagedAnything(gitRoot, env))) {
      return withCatchUp({ status: "skipped", kind: "planning", reason: "nothing_to_commit", ...warnings }, catchUp);
    }
    const files = await stagedFiles(gitRoot, env);
    const { subject, stage } = await planningSubject(input);
    const message = input.message?.trim()
      ? composeMessage(input.message.trim(), [], planningTrailers(input.changeId, "planning", stage))
      : composeMessage(
          applySubjectTemplate(settings.subjectTemplate, "planning", { subject, stage, change: input.changeId }),
          planningBody(input),
          planningTrailers(input.changeId, "planning", stage),
        );
    const committed = await commitWithMessage(gitRoot, message, [], { hooksDir, env, timeoutMs: planningTimeoutMs });
    if (!committed.ok) {
      const failure = classifyCommitFailure(committed, false);
      return withCatchUp({ status: "failed", kind: "planning", reason: failure.reason, detail: failure.detail, files, ...warnings }, catchUp);
    }
    await markAnnounced(gitRoot, notice, env);
    return withCatchUp(
      {
        status: "committed",
        kind: "planning",
        sha: committed.sha,
        subject: message.split("\n")[0],
        files,
        ...(notice ? { notice } : {}),
        ...warnings,
      },
      catchUp,
    );
  });
}

function withCatchUp(outcome: CheckpointOutcome, catchUp: CheckpointOutcome | undefined): CheckpointOutcome {
  return catchUp ? { ...outcome, catch_up: catchUp } : outcome;
}

function planningBody(input: PlanningCheckpointInput): string[] {
  const body: string[] = [];
  if (input.summary?.trim()) body.push(input.summary.trim());
  if (input.moment.kind === "progress" && input.moment.staleLanes && input.moment.staleLanes.length > 0) {
    body.push(`Now out of date: ${input.moment.staleLanes.map(stageName).join(", ")}.`);
  }
  return body;
}

function planningTrailers(changeId: string, kind: CheckpointKind, stage?: string): Array<[string, string]> {
  return [["Weave-Change", changeId], ["Weave-Checkpoint", kind], ...(stage ? ([["Weave-Stage", stage]] as Array<[string, string]>) : [])];
}

async function stagedFiles(gitRoot: string, env?: NodeJS.ProcessEnv): Promise<string[]> {
  const names = await checkpointGit(["diff", "--cached", "--name-only", "-z", "--no-renames"], gitRoot, { env });
  return names.ok ? names.stdout.split("\0").filter(Boolean) : [];
}

async function catchUpCommit(
  gitRoot: string,
  files: string[],
  input: PlanningCheckpointInput,
  settings: CommitSettings,
  hooksDir: string,
  env: NodeJS.ProcessEnv,
): Promise<CheckpointOutcome> {
  // Untracked files must be known to git before `commit --only` can take them. `--intent-to-add`
  // records them without staging their content, so nothing the person staged is disturbed.
  const untracked = await checkpointGit(["ls-files", "--others", "--exclude-standard", "-z", "--", ...files], gitRoot, { env });
  const newFiles = untracked.ok ? untracked.stdout.split("\0").filter(Boolean) : [];
  if (newFiles.length > 0) {
    const intent = await checkpointGit(["add", "--intent-to-add", "--", ...newFiles], gitRoot, { env, timeoutMs: planningTimeoutMs });
    if (!intent.ok) {
      const failure = classifyCommitFailure(intent, false);
      return { status: "failed", kind: "catch-up", reason: failure.reason, detail: failure.detail, files };
    }
  }
  const subject = applySubjectTemplate(settings.subjectTemplate, "catch-up", {
    subject: `Planning notes for ${input.title || input.changeId}`,
    change: input.changeId,
  });
  const message = composeMessage(subject, [files.map((file) => `- ${file}`).join("\n")], planningTrailers(input.changeId, "catch-up"));
  const committed = await commitWithMessage(gitRoot, message, ["--only", "--", ...files], { hooksDir, env, timeoutMs: planningTimeoutMs });
  if (!committed.ok) {
    if (/nothing to commit|no changes added/i.test(committed.stdout + committed.stderr)) {
      return { status: "skipped", kind: "catch-up", reason: "nothing_to_commit" };
    }
    const failure = classifyCommitFailure(committed, false);
    return { status: "failed", kind: "catch-up", reason: failure.reason, detail: failure.detail, files };
  }
  return { status: "committed", kind: "catch-up", sha: committed.sha, subject, files };
}

// --- first-commit notice ------------------------------------------------------------------------

export function isUnattended(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WEAVE_UNATTENDED === "1";
}

async function noticeStatePath(gitRoot: string): Promise<string | undefined> {
  try {
    return path.join(await localStateDir(gitRoot), "checkpoints.json");
  } catch {
    return undefined;
  }
}

async function noticeFor(gitRoot: string, _env: NodeJS.ProcessEnv): Promise<"commits_enabled" | undefined> {
  const file = await noticeStatePath(gitRoot);
  if (!file) return undefined;
  try {
    const state = JSON.parse(await readFile(file, "utf8")) as { announced?: boolean };
    return state.announced ? undefined : "commits_enabled";
  } catch {
    return "commits_enabled";
  }
}

// The notice counts as delivered only when an attended command showed it.
async function markAnnounced(gitRoot: string, notice: string | undefined, env: NodeJS.ProcessEnv): Promise<void> {
  if (!notice || isUnattended(env)) return;
  const file = await noticeStatePath(gitRoot);
  if (!file) return;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ announced: true })}\n`);
  } catch {
    // Best-effort: the notice shows again next time.
  }
}

// --- rendering ----------------------------------------------------------------------------------

export function renderCheckpointLine(outcome: CheckpointOutcome | undefined): string | undefined {
  if (!outcome) return undefined;
  const lines: string[] = [];
  if (outcome.catch_up) {
    const line = renderCheckpointLine(outcome.catch_up);
    if (line) lines.push(line);
  }
  if (outcome.status === "committed") {
    const count = outcome.files?.length ?? 0;
    const where = outcome.repo && outcome.kind !== "planning" && outcome.kind !== "catch-up" ? ` in ${outcome.repo}` : "";
    lines.push(`Committed ${outcome.sha?.slice(0, 7) ?? ""}${where} "${outcome.subject ?? ""}" (${count} file${count === 1 ? "" : "s"})`);
    if (outcome.kind === "build" || outcome.kind === "fix" || outcome.kind === "final-fix") {
      for (const file of outcome.files ?? []) lines.push(`  ${file}`);
    }
    if (outcome.leftovers_from) lines.push(`  includes uncommitted work from ${outcome.leftovers_from}`);
  } else if (outcome.status === "failed" || (outcome.reason && outcome.reason !== "nothing_to_commit" && !outcome.reason.startsWith("commits_off") && outcome.reason !== "change_skipped")) {
    lines.push(`Did not commit: ${outcome.reason ?? "unknown"}${outcome.detail ? ` — ${outcome.detail}` : ""}`);
  }
  if (outcome.notice === "commits_enabled") {
    lines.push(
      "Weave now commits each recorded stage and finished slice on the change branch. Turn it off with `weave settings commits off`, `weave change skip-commits`, or `commits.enabled: false` in .weave/workspace.yml.",
    );
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

// --- code checkpoints ---------------------------------------------------------------------------

export interface CodeCommitInput {
  repoId: string;
  repoPath: string;
  branch: string;
  kind: Extract<CheckpointKind, "build" | "fix" | "final-fix">;
  message: string;
  subject: string;
  // Extra pathspecs, such as `:(exclude)wiki/changes/<other>`.
  excludes: string[];
  timeoutMs: number;
  slice?: string;
  env?: NodeJS.ProcessEnv;
}

// Stages everything in the repo except `excludes` and commits it with the project's hooks. Never
// throws.
export async function codeCommit(input: CodeCommitInput): Promise<CheckpointOutcome> {
  const base: CheckpointOutcome = { status: "skipped", kind: input.kind, repo: input.repoId, ...(input.slice ? { slice: input.slice } : {}) };
  try {
    const env = input.env ?? process.env;
    const guard = await guardRepo(input.repoPath, input.branch, env);
    if (!guard.ok || !guard.gitRoot) {
      return { ...base, reason: guard.reason, ...(guard.detail ? { detail: guard.detail } : {}) };
    }
    const gitRoot = guard.gitRoot;
    const added = await checkpointGit(["add", "-A", "--", ".", ...input.excludes], gitRoot, { env, timeoutMs: planningTimeoutMs });
    if (!added.ok) {
      const failure = classifyCommitFailure(added, false);
      return { ...base, status: "failed", reason: failure.reason, detail: failure.detail };
    }
    if (!(await stagedAnything(gitRoot, env))) {
      return { ...base, reason: "nothing_to_commit" };
    }
    const files = await stagedFiles(gitRoot, env);
    const committed = await commitWithMessage(gitRoot, input.message, [], { env, timeoutMs: input.timeoutMs });
    if (!committed.ok) {
      const failure = classifyCommitFailure(committed, true);
      return { ...base, status: "failed", reason: failure.reason, detail: failure.detail, files };
    }
    return { ...base, status: "committed", sha: committed.sha, subject: input.subject, files };
  } catch (error) {
    return { ...base, status: "failed", reason: "git_error", detail: firstLines((error as Error).message ?? String(error)) };
  }
}

// Pathspecs that keep other changes' planning folders and the person's coding guidelines out of
// code commits.
export async function codeExcludes(repoPath: string, changeId: string): Promise<string[]> {
  const excludes = [":(exclude,glob)**/.weave/coding-guidelines*.md"];
  try {
    for (const name of await readdir(path.join(repoPath, "wiki", "changes"))) {
      if (name !== changeId) excludes.push(`:(exclude)wiki/changes/${name}`);
    }
  } catch {
    // No changes folder in this repo.
  }
  return excludes;
}

export interface CommittedCoverage {
  // Slice id → coverage hashes recorded by build commits (directly or as included leftovers).
  slices: Map<string, Set<string>>;
}

// Reads the build-commit trailers of this change on HEAD's first-parent line (at most 500 commits).
export async function committedCoverage(repoPath: string, changeId: string, env?: NodeJS.ProcessEnv): Promise<CommittedCoverage> {
  const slices = new Map<string, Set<string>>();
  const log = await checkpointGit(["log", "--first-parent", "-n", "500", "--format=%x1e%B", "HEAD"], repoPath, { env });
  if (!log.ok) return { slices };
  for (const message of log.stdout.split("\x1e")) {
    const trailers = parseTrailers(message);
    if (trailers.get("Weave-Change")?.[0] !== changeId) continue;
    const add = (slice: string, coverage: string): void => {
      const set = slices.get(slice) ?? new Set<string>();
      set.add(coverage);
      slices.set(slice, set);
    };
    const slice = trailers.get("Weave-Slice")?.[0];
    const coverage = trailers.get("Weave-Coverage")?.[0];
    if (slice && coverage) add(slice, coverage);
    for (const included of trailers.get("Weave-Includes") ?? []) {
      const [id, cov] = included.split(":");
      if (id && cov) add(id, cov);
    }
  }
  return { slices };
}

export function parseTrailers(message: string): Map<string, string[]> {
  const trailers = new Map<string, string[]>();
  for (const line of message.split("\n")) {
    const match = /^(Weave-[A-Za-z-]+):\s*(.+)$/.exec(line.trim());
    if (!match?.[1] || !match[2]) continue;
    const values = trailers.get(match[1]) ?? [];
    values.push(match[2].trim());
    trailers.set(match[1], values);
  }
  return trailers;
}
