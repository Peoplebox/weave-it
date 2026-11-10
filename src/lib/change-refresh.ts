// The background refresh of remote facts (ADR 261108-4ko1). `weave change list` answers
// from what is already known, then starts at most one detached `weave change refresh`,
// which fetches each repo into `refs/weave/remotes/origin/*`, records what it saw in
// `.git/weave/refresh.json`, rewrites the attention snapshot for `weave status`, and prunes
// review snapshot refs of changes that have landed or no longer exist.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeAttention } from "./change-attention.js";
import { listBaseChangeIds, readBases } from "./change-bases.js";
import { gatherFacts, repoSources, resolveMainRoot, type GatherResult, type RemoteFacts } from "./change-facts.js";
import { attentionCounts, deriveState, type RefreshResult } from "./change-states.js";
import { pathExists } from "./files.js";
import { deleteRef, fetchNoPrompt, hasOrigin, lsRemoteHeads, resolveDefaultBase, runGit, weaveRemoteRefPrefix } from "./git.js";
import { targetBranchName } from "./landed.js";
import { localStateDir, withStateLock, writeFileAtomic } from "./local-state.js";
import { pruneReviews } from "./review/prune.js";
import { readWorkspaceMetadata } from "./workspace-repos.js";

export const refreshTimeoutPerRepoMs = 30_000;
export const refreshThrottleMs = 60_000;
const ageSlackMs = 10_000;

export interface RepoRefreshRecord {
  last_attempt_at: string;
  last_success_at: string | null;
  result: RefreshResult;
  message: string | null;
  // Known change branches seen on origin at some successful refresh.
  seen: string[];
  // Known change and target branches absent on origin at the last successful refresh.
  absent: string[];
}

export interface RefreshRecord {
  version: 1;
  running: { pid: number; started_at: string; repos: number } | null;
  last_started_at: string | null;
  repos: Record<string, RepoRefreshRecord>;
}

export interface RefreshOptions {
  now?: () => Date;
  timeoutPerRepoMs?: number;
  env?: NodeJS.ProcessEnv;
}

function refreshFile(stateDir: string): string {
  return path.join(stateDir, "refresh.json");
}

const emptyRecord = (): RefreshRecord => ({ version: 1, running: null, last_started_at: null, repos: {} });

export async function readRefresh(stateDir: string): Promise<RefreshRecord> {
  const file = refreshFile(stateDir);
  if (!(await pathExists(file))) return emptyRecord();
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<RefreshRecord>;
    return { ...emptyRecord(), ...parsed, version: 1, repos: parsed.repos ?? {} };
  } catch {
    return emptyRecord();
  }
}

async function writeRefresh(stateDir: string, record: RefreshRecord): Promise<void> {
  await writeFileAtomic(refreshFile(stateDir), JSON.stringify(record, null, 2));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// A run is alive only while its process exists and it is younger than its time limit, so a
// crashed or hung refresh never blocks the next one.
export function runAlive(record: RefreshRecord, now: Date, timeoutPerRepoMs = refreshTimeoutPerRepoMs): boolean {
  const running = record.running;
  if (!running) return false;
  const age = now.getTime() - Date.parse(running.started_at);
  return processAlive(running.pid) && age < timeoutPerRepoMs * Math.max(1, running.repos) + ageSlackMs;
}

export type ClaimOutcome = "claimed" | "running" | "throttled";

async function claimRun(mainRoot: string, repoCount: number, options: { throttle: boolean; now: Date; timeoutPerRepoMs: number }): Promise<ClaimOutcome> {
  return withStateLock(mainRoot, async (stateDir) => {
    const record = await readRefresh(stateDir);
    if (runAlive(record, options.now, options.timeoutPerRepoMs)) return "running";
    if (options.throttle && record.last_started_at && options.now.getTime() - Date.parse(record.last_started_at) < refreshThrottleMs) {
      return "throttled";
    }
    record.running = { pid: process.pid, started_at: options.now.toISOString(), repos: repoCount };
    record.last_started_at = options.now.toISOString();
    await writeRefresh(stateDir, record);
    return "claimed";
  });
}

// The branches this machine cares about in one repo: its local change branches, and the
// target branches (starting branches and the default branch) they are measured against.
async function knownBranches(repoPath: string, repoId: string, stateDir: string): Promise<{ changes: string[]; targets: string[] }> {
  const local = await runGit(["for-each-ref", "--format=%(refname:strip=2)", "refs/heads/change/"], repoPath);
  const changes = local.ok && local.stdout ? local.stdout.split("\n").filter(Boolean) : [];
  const targets = new Set<string>();
  const defaultBranch = (await resolveDefaultBase(repoPath, { fetch: false }))?.branch;
  if (defaultBranch) targets.add(defaultBranch);
  for (const id of await listBaseChangeIds(stateDir)) {
    const base = (await readBases(stateDir, id))?.repos[repoId]?.base;
    if (base) targets.add(targetBranchName(base));
  }
  return { changes, targets: [...targets].filter((branch) => !changes.includes(branch)) };
}

async function refreshRepo(
  repoId: string,
  repoPath: string,
  stateDir: string,
  previous: RepoRefreshRecord | undefined,
  options: { now: () => Date; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<RepoRefreshRecord> {
  const attemptAt = options.now().toISOString();
  const keep = { last_success_at: previous?.last_success_at ?? null, seen: previous?.seen ?? [], absent: previous?.absent ?? [] };
  if (!(await hasOrigin(repoPath))) {
    return { last_attempt_at: attemptAt, result: "no_remote", message: null, ...keep };
  }
  const deadline = Date.now() + options.timeoutMs;
  const listed = await lsRemoteHeads(repoPath, { timeoutMs: options.timeoutMs, ...(options.env ? { env: options.env } : {}) });
  if (!("heads" in listed)) {
    return { last_attempt_at: attemptAt, result: listed.result, message: listed.message, ...keep };
  }

  const known = await knownBranches(repoPath, repoId, stateDir);
  const wanted = [...known.changes, ...known.targets];
  const present = wanted.filter((branch) => listed.heads.has(branch));
  const absent = wanted.filter((branch) => !listed.heads.has(branch));
  const fetched = await fetchNoPrompt(repoPath, {
    branches: present,
    timeoutMs: Math.max(1, deadline - Date.now()),
    ...(options.env ? { env: options.env } : {}),
  });
  if (fetched.result !== "ok") {
    return { last_attempt_at: attemptAt, result: fetched.result, message: fetched.message, ...keep };
  }
  // A known branch deleted on origin: drop Weave's copy instead of `--prune`, which would
  // touch every ref under the namespace.
  for (const branch of absent) {
    await deleteRef(repoPath, `${weaveRemoteRefPrefix}${branch}`);
  }
  const localChanges = new Set(known.changes);
  const seen = [...new Set([...keep.seen, ...present.filter((branch) => localChanges.has(branch))])].filter((branch) => localChanges.has(branch));
  return { last_attempt_at: attemptAt, last_success_at: options.now().toISOString(), result: "ok", message: null, seen, absent };
}

export interface RefreshRunResult {
  outcome: ClaimOutcome;
  record: RefreshRecord;
}

// Runs one refresh of every repo, unless one is already running (or, with `throttle`, one
// started less than a minute ago). Never throws for git problems: they're recorded.
export async function runRefresh(rootPath: string, options: RefreshOptions & { throttle?: boolean } = {}): Promise<RefreshRunResult> {
  const now = options.now ?? (() => new Date());
  const timeoutPerRepoMs = options.timeoutPerRepoMs ?? refreshTimeoutPerRepoMs;
  const mainRoot = await resolveMainRoot(rootPath);
  const metadata = (await readWorkspaceMetadata(mainRoot)) ?? (await readWorkspaceMetadata(rootPath));
  const stateDir = await localStateDir(mainRoot);
  if (!metadata) return { outcome: "claimed", record: await readRefresh(stateDir) };
  const sources = await repoSources(mainRoot, metadata);

  const outcome = await claimRun(mainRoot, sources.length, { throttle: options.throttle ?? false, now: now(), timeoutPerRepoMs });
  if (outcome !== "claimed") return { outcome, record: await readRefresh(stateDir) };

  const previous = await readRefresh(stateDir);
  const results = await Promise.all(
    sources.map(async (source) => [
      source.id,
      await refreshRepo(source.id, source.source, stateDir, previous.repos[source.id], {
        now,
        timeoutMs: timeoutPerRepoMs,
        ...(options.env ? { env: options.env } : {}),
      }),
    ] as const),
  );

  const record = await withStateLock(mainRoot, async () => {
    const latest = await readRefresh(stateDir);
    latest.repos = { ...latest.repos, ...Object.fromEntries(results) };
    if (latest.running?.pid === process.pid) latest.running = null;
    await writeRefresh(stateDir, latest);
    return latest;
  });

  let gathered: GatherResult | undefined;
  try {
    gathered = await gatherFacts(mainRoot, { remote: remoteFacts(record) });
    const counts = attentionCounts(gathered.changes.map((change) => deriveState(change.facts)));
    await writeAttention(mainRoot, { ...counts, factsAt: gathered.factsAt });
  } catch {
    // The snapshot is a convenience; the next list writes it again.
  }
  if (gathered) {
    try {
      // Review snapshot refs and packages of landed or vanished changes, reusing the landed
      // results just gathered. Local git only: no network, no prompts.
      await pruneReviews(mainRoot, { facts: gathered });
    } catch {
      // Cleanup is best effort; the next refresh tries again.
    }
  }
  return { outcome, record };
}

// What the last refresh learned, in the shape fact gathering takes.
export function remoteFacts(record: RefreshRecord): RemoteFacts {
  const goneTargets = new Map<string, Set<string>>();
  const goneChangeBranches = new Map<string, Set<string>>();
  const repos = new Map<string, { asOf: string | null; refresh: RefreshResult | null; message: string | null }>();
  for (const [repoId, repo] of Object.entries(record.repos)) {
    const absent = new Set(repo.absent);
    // Any known branch missing on origin is gone as a target (a deleted stacked parent).
    goneTargets.set(repoId, absent);
    goneChangeBranches.set(repoId, new Set(repo.seen.filter((branch) => absent.has(branch))));
    repos.set(repoId, { asOf: repo.result === "no_remote" ? null : repo.last_success_at, refresh: repo.result, message: repo.message });
  }
  return { goneTargets, goneChangeBranches, repos };
}

export async function readRemoteFacts(rootPath: string): Promise<{ facts: RemoteFacts; record: RefreshRecord; stateDir: string; mainRoot: string }> {
  const mainRoot = await resolveMainRoot(rootPath);
  const stateDir = await localStateDir(mainRoot);
  const record = await readRefresh(stateDir);
  return { facts: remoteFacts(record), record, stateDir, mainRoot };
}

export interface SpawnDecision {
  // A refresh is running or about to start, so the list says "refreshing now".
  refreshing: boolean;
  spawn: boolean;
}

// Decides, before the list prints, whether a refresh is running or will be started.
export async function planBackgroundRefresh(rootPath: string, now: Date = new Date()): Promise<SpawnDecision> {
  if (process.env.WEAVE_NO_BACKGROUND_REFRESH === "1") return { refreshing: false, spawn: false };
  const { record } = await readRemoteFacts(rootPath);
  if (runAlive(record, now)) return { refreshing: true, spawn: false };
  if (record.last_started_at && now.getTime() - Date.parse(record.last_started_at) < refreshThrottleMs) {
    return { refreshing: false, spawn: false };
  }
  // Repos without a remote are compared locally; refreshing them is silent.
  const repos = Object.values(record.repos);
  const allLocal = repos.length > 0 && repos.every((repo) => repo.result === "no_remote");
  return { refreshing: !allLocal, spawn: true };
}

// Starts `weave change refresh` detached and unref'd, the way `weave advance --detach`
// does, so the list returns at once. The child claims the run itself, so two lists racing
// here still start at most one refresh.
export async function spawnBackgroundRefresh(rootPath: string): Promise<void> {
  const mainRoot = await resolveMainRoot(rootPath);
  const entry = process.argv[1];
  if (!entry) return;
  const child = spawn(process.execPath, [...process.execArgv, entry, "change", "refresh", "--root", mainRoot], {
    cwd: mainRoot,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, WEAVE_NO_NOTICES: "1" },
  });
  child.unref();
}

// `--fetch`: joins a running refresh, or runs one in-process, and waits at most the time
// limit. Returns whether a refresh finished.
export async function joinOrRunRefresh(rootPath: string, options: RefreshOptions & { pollMs?: number } = {}): Promise<boolean> {
  const now = options.now ?? (() => new Date());
  const timeoutPerRepoMs = options.timeoutPerRepoMs ?? refreshTimeoutPerRepoMs;
  const { record, stateDir } = await readRemoteFacts(rootPath);
  if (runAlive(record, now(), timeoutPerRepoMs)) {
    const startedAt = record.running!.started_at;
    const limit = Date.now() + timeoutPerRepoMs * Math.max(1, record.running!.repos) + ageSlackMs;
    while (Date.now() < limit) {
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 200));
      const latest = await readRefresh(stateDir);
      if (!latest.running || latest.running.started_at !== startedAt) return true;
      if (!runAlive(latest, now(), timeoutPerRepoMs)) return false;
    }
    return false;
  }
  const result = await runRefresh(rootPath, { ...options, throttle: false });
  return result.outcome === "claimed";
}
