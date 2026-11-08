// Gathers the live local facts `weave change list` needs about every change of a repo or
// workspace: folders, git's worktree records, uncommitted files, branches, starting
// branches, and the landed check. All I/O lives here; `change-states.ts` stays pure.
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { listBaseChangeIds, resolveChangeBase } from "./change-bases.js";
import { squashNeedsNewGit, stillChecking, type ChangeFacts, type RepoFacts, type RepoLandedFact } from "./change-states.js";
import { pathExists } from "./files.js";
import { gitVersionCaps, listGitWorktrees, mainWorktreePath, resolveCommit, runGit, worktreeLockedOnDisk, type GitWorktreeEntry } from "./git.js";
import { checkLanded, LandedCache, landedRepoInfo, type LandedRepoInfo } from "./landed.js";
import { localStateDir } from "./local-state.js";
import { readWorkspaceMetadata, type WorkspaceMetadata } from "./workspace-repos.js";
import { changesRoot as changesRootFor, listLocalChangeIds, readLocalState, rootRepoId, type LocalChangeState } from "./worktrees.js";

// `YYMMDD-xxxx-slug`, as `weave change new` makes them.
export const changeIdPattern = /^\d{6}-[a-z0-9]{4}(?:-[a-z0-9][a-z0-9-]*)?$/;

export const defaultInlineBudgetMs = 2_000;

export type PlanningSource =
  | { kind: "folder"; changePath: string }
  | { kind: "main"; changePath: string }
  | { kind: "branch"; statusYaml: string }
  | { kind: "none" };

export interface GatheredChange {
  facts: ChangeFacts;
  planning: PlanningSource;
}

export interface GatherResult {
  mainRoot: string;
  stateDir: string;
  changesRoot: string;
  // Set when the location of change folders is missing (an unmounted drive, say).
  unavailableRoot?: string;
  changes: GatheredChange[];
  // Some change needed squash detection that this git can't do.
  gitTooOld: boolean;
  // When fact gathering started; snapshots only replace older ones.
  factsAt: string;
}

export interface RemoteFacts {
  // Target branches a successful refresh found deleted on origin, per repo.
  goneTargets?: Map<string, Set<string>>;
  // Change branches seen on origin before and absent at the last successful refresh.
  goneChangeBranches?: Map<string, Set<string>>;
  repos?: Map<string, { asOf: string | null; refresh: RepoFacts["refresh"]; message: string | null }>;
}

export interface GatherOptions {
  now?: Date;
  inlineBudgetMs?: number;
  remote?: RemoteFacts;
}

interface RepoSource {
  id: string;
  // Relative to the main checkout, and to each change folder.
  rel: string;
  source: string;
  worktrees: GitWorktreeEntry[];
  info?: Promise<LandedRepoInfo>;
}

const gatherConcurrency = 8;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function resolveMainRoot(rootPath: string): Promise<string> {
  return realpath((await mainWorktreePath(rootPath)) ?? rootPath).catch(() => rootPath);
}

export async function repoSources(mainRoot: string, metadata: WorkspaceMetadata): Promise<RepoSource[]> {
  const sources: RepoSource[] = [{ id: rootRepoId, rel: ".", source: mainRoot, worktrees: await listGitWorktrees(mainRoot) }];
  for (const [id, entry] of Object.entries(metadata.repos)) {
    const source = path.join(mainRoot, entry.path);
    if (!(await pathExists(path.join(source, ".git")))) continue;
    sources.push({ id, rel: entry.path, source, worktrees: await listGitWorktrees(source) });
  }
  return sources;
}

// A missing changes root counts as unavailable (drive not mounted) only when its parent is
// gone too, or it's a symlink to nowhere. Otherwise someone deleted it, and its changes get
// ordinary folder-missing states so `close` can clean up.
export async function changesRootUnavailable(root: string): Promise<boolean> {
  if (await pathExists(root)) return false;
  const link = await lstat(root).catch(() => undefined);
  if (link?.isSymbolicLink()) return true;
  return !(await stat(path.dirname(root)).then(
    () => true,
    () => false,
  ));
}

async function localChangeBranches(mainRoot: string): Promise<string[]> {
  const result = await runGit(["for-each-ref", "--format=%(refname:strip=2)", "refs/heads/change/"], mainRoot);
  if (!result.ok || !result.stdout) return [];
  return result.stdout
    .split("\n")
    .map((branch) => branch.replace(/^change\//, ""))
    .filter(Boolean);
}

async function mainChangeIds(mainRoot: string): Promise<string[]> {
  const entries = await readdir(path.join(mainRoot, "wiki", "changes"), { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function uncommittedCount(folder: string): Promise<number> {
  const status = await runGit(["status", "--porcelain"], folder);
  return status.ok && status.stdout ? status.stdout.split("\n").length : 0;
}

function changeStatusPath(changeRoot: string, changeId: string): string {
  return path.join(changeRoot, "wiki", "changes", changeId, "status.yml");
}

export async function gatherFacts(rootPath: string, options: GatherOptions = {}): Promise<GatherResult> {
  const factsAt = (options.now ?? new Date()).toISOString();
  const mainRoot = await resolveMainRoot(rootPath);
  const metadata = (await readWorkspaceMetadata(mainRoot)) ?? (await readWorkspaceMetadata(rootPath));
  if (!metadata) {
    throw new Error(`No Weave workspace metadata found at ${mainRoot}.`);
  }
  const stateDir = await localStateDir(mainRoot);
  const changesRoot = changesRootFor(mainRoot, metadata);
  const unavailable = await changesRootUnavailable(changesRoot);
  const sources = await repoSources(mainRoot, metadata);
  const root = sources[0]!;
  const caps = await gitVersionCaps();
  const cache = await LandedCache.load(stateDir, caps);
  const budget = options.inlineBudgetMs ?? budgetFromEnv() ?? defaultInlineBudgetMs;
  const deadline = Date.now() + budget;

  const stateIds = await listLocalChangeIds(stateDir);
  const baseIds = new Set(await listBaseChangeIds(stateDir));
  const branchIds = new Set(await localChangeBranches(mainRoot));
  const onMain = new Set(await mainChangeIds(mainRoot));
  const entryIds = root.worktrees
    .map((entry) => (entry.branch?.startsWith("change/") && path.resolve(entry.path) !== path.resolve(mainRoot) ? entry.branch.slice("change/".length) : undefined))
    .filter((id): id is string => Boolean(id));
  // Changes with folders are checked first, newest first, so the inline budget is spent on
  // the work people are doing now rather than on old closed branches.
  const withFolders = new Set([...entryIds, ...stateIds]);
  const candidates = [...new Set([...onMain, ...entryIds, ...stateIds, ...baseIds, ...branchIds])].sort(
    (left, right) => Number(withFolders.has(right)) - Number(withFolders.has(left)) || right.localeCompare(left),
  );

  const states = new Map(await Promise.all(candidates.map(async (id) => [id, await readLocalState(stateDir, id)] as const)));
  const all = await mapLimit(candidates, gatherConcurrency, async (id) =>
    gatherOne({
      id,
      mainRoot,
      stateDir,
      changesRoot,
      unavailable,
      sources,
      cache,
      deadline,
      state: states.get(id),
      hasBaseRecord: baseIds.has(id),
      planningOnMain: onMain.has(id) && (await pathExists(changeStatusPath(mainRoot, id))),
      remote: options.remote,
    }),
  );
  const changes = all.filter((gathered): gathered is GatheredChange => Boolean(gathered));
  const gitTooOld = changes.some((gathered) => gathered.facts.repos.some((repo) => repo.landed?.reason === squashNeedsNewGit));
  await cache.save().catch(() => undefined);

  return {
    mainRoot,
    stateDir,
    changesRoot,
    ...(unavailable ? { unavailableRoot: changesRoot } : {}),
    changes,
    gitTooOld,
    factsAt,
  };
}

function budgetFromEnv(): number | undefined {
  const raw = process.env.WEAVE_TEST_LANDED_BUDGET_MS;
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

interface GatherOneInput {
  id: string;
  mainRoot: string;
  stateDir: string;
  changesRoot: string;
  unavailable: boolean;
  sources: RepoSource[];
  cache: LandedCache;
  deadline: number;
  state?: LocalChangeState;
  hasBaseRecord: boolean;
  planningOnMain: boolean;
  remote?: RemoteFacts;
}

async function gatherOne(input: GatherOneInput): Promise<GatheredChange | undefined> {
  const { id, mainRoot, sources, state } = input;
  const branch = `change/${id}`;
  const root = sources[0]!;
  const entryFor = (source: RepoSource) =>
    source.worktrees.find((entry) => entry.branch === branch && path.resolve(entry.path) !== path.resolve(source.source));
  const rootEntry = entryFor(root);
  const hasFolderRecord = Boolean(state || rootEntry);
  const folder = state?.folder ?? rootEntry?.path ?? (hasFolderRecord ? path.join(input.changesRoot, id) : undefined);
  const folderExists = folder ? await pathExists(folder) : false;

  const rootTip = await resolveCommit(mainRoot, `refs/heads/${branch}`);
  const statusOnBranch = rootTip
    ? (await runGit(["cat-file", "-e", `${branch}:wiki/changes/${id}/status.yml`], mainRoot)).ok
    : false;

  // A branch by itself counts only when it looks like a Weave change and Weave knows it.
  if (!hasFolderRecord && !input.planningOnMain) {
    if (!rootTip || !changeIdPattern.test(id)) return undefined;
    if (!input.hasBaseRecord && !statusOnBranch) return undefined;
  }

  // The repos this change has: root, repos with a worktree entry, and repos Weave recorded.
  // A closed change has no entries, so its repos are the ones that still have its branch.
  const recorded = new Set(state?.repos ?? []);
  const members: RepoSource[] = [];
  for (const source of sources) {
    if (source.id === rootRepoId) {
      members.push(source);
    } else if (entryFor(source) || recorded.has(source.id)) {
      members.push(source);
    } else if (!hasFolderRecord && (await resolveCommit(source.source, `refs/heads/${branch}`))) {
      members.push(source);
    }
  }

  const caps = await gitVersionCaps();
  const repos: RepoFacts[] = [];
  for (const source of members) {
    const entry = entryFor(source);
    const repoHasRecord = Boolean(entry) || (source.id === rootRepoId ? hasFolderRecord : recorded.has(source.id));
    const expected = entry?.path ?? (folder ? path.join(folder, source.rel) : undefined);
    const exists = repoHasRecord && expected ? await pathExists(expected) : false;
    const locked = entry ? entry.locked || (!caps.worktreePorcelainFlags && (await worktreeLockedOnDisk(source.source, entry.path))) : false;
    const tip = source.id === rootRepoId ? rootTip : await resolveCommit(source.source, `refs/heads/${branch}`);
    // Without a branch there is nothing to measure, so no starting branch is needed.
    const base = tip
      ? await resolveChangeBase({
          mainRoot,
          repoPath: source.source,
          repoId: source.id,
          changeId: id,
          ...(folderExists && folder ? { statusPath: changeStatusPath(folder, id) } : {}),
        })
      : { base: null, base_commit: null, source: "unknown" as const };

    let landed: RepoLandedFact | undefined;
    if (tip) {
      source.info ??= landedRepoInfo(source.source);
      if (Date.now() > input.deadline) {
        landed = { ...emptyLanded, result: "unchecked", reason: stillChecking };
      } else {
        const outcome = await checkLanded(
          { repoPath: source.source, repoId: source.id, changeId: id, tip, base, goneTargets: input.remote?.goneTargets?.get(source.id) },
          { cache: input.cache, caps, repoInfo: await source.info },
        );
        landed = {
          result: outcome.result,
          method: outcome.method,
          reason: outcome.reason,
          targetBranch: outcome.target?.branch ?? null,
          targetRef: outcome.target?.ref ?? null,
          targetSha: outcome.target?.sha ?? null,
          defaultBranch: outcome.defaultBranch,
          fellBack: outcome.fellBack,
          localViewOlder: outcome.localViewOlder,
        };
      }
    }

    const remote = input.remote?.repos?.get(source.id);
    const mayHaveLanded = Boolean(input.remote?.goneChangeBranches?.get(source.id)?.has(branch)) && landed?.result === "not_landed";
    repos.push({
      id: source.id,
      path: source.rel,
      hasFolderRecord: repoHasRecord,
      folderExists: exists,
      locked,
      uncommitted: exists && expected ? await uncommittedCount(expected) : 0,
      hasTip: Boolean(tip),
      ...(landed ? { landed } : {}),
      baseKnown: Boolean(base.base),
      baseSource: base.source,
      ...(mayHaveLanded ? { mayHaveLanded } : {}),
      ...(remote ? { asOf: remote.asOf, refresh: remote.refresh, refreshMessage: remote.message } : {}),
    });
  }

  const branchExists = repos.some((repo) => repo.hasTip);
  const facts: ChangeFacts = {
    id,
    ...(folder ? { folder } : {}),
    hasFolderRecord,
    folderExists,
    ...(state ? { slot: state.slot } : {}),
    unavailable: input.unavailable && Boolean(folder && isInside(folder, input.changesRoot)),
    changesRoot: input.changesRoot,
    branchExists,
    statusOnBranch,
    planningOnMain: input.planningOnMain,
    repos,
  };

  let planning: PlanningSource = { kind: "none" };
  if (folderExists && folder && (await pathExists(changeStatusPath(folder, id)))) {
    planning = { kind: "folder", changePath: path.dirname(changeStatusPath(folder, id)) };
  } else if (input.planningOnMain) {
    planning = { kind: "main", changePath: path.dirname(changeStatusPath(mainRoot, id)) };
  } else if (statusOnBranch) {
    const shown = await runGit(["show", `${branch}:wiki/changes/${id}/status.yml`], mainRoot);
    if (shown.ok) planning = { kind: "branch", statusYaml: shown.stdout };
  }
  return { facts, planning };
}

const emptyLanded: RepoLandedFact = {
  result: "unchecked",
  method: null,
  reason: null,
  targetBranch: null,
  targetRef: null,
  targetSha: null,
  defaultBranch: null,
  fellBack: false,
  localViewOlder: false,
};

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
