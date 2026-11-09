import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { recordBases, type BaseRepoRecord } from "./change-bases.js";
import { ChangeCommandError } from "./change-error.js";
import { pathExists } from "./files.js";
import {
  currentBranch,
  listGitWorktrees,
  mainWorktreePath,
  probeGitRoot,
  resolveCommit,
  resolveDefaultBase,
  runGit,
  worktreeLockedOnDisk,
} from "./git.js";
import { localStateDir, withStateLock } from "./local-state.js";
import { readWorkspaceMetadata, type CheckoutMode, type WorkspaceMetadata } from "./workspace-repos.js";

export const rootRepoId = "root";

export type WorktreeRepoStatus = "created" | "reused" | "skipped_not_git";

export interface WorktreeRepoResult {
  id: string;
  // Relative to the change folder; "." is the workspace root (or the repo in repo mode).
  path: string;
  branch: string;
  status: WorktreeRepoStatus;
  base?: string;
  base_commit?: string;
  reason?: string;
}

export interface WorktreeBlocker {
  target: string;
  reason: string;
}

export interface EnsureWorktreesResult {
  folder: string;
  slot: number;
  repos: WorktreeRepoResult[];
  copied: string[];
  warnings: string[];
  // A recreated folder whose old slot was taken got a new one.
  slot_changed?: { from: number; to: number };
  // Repos whose folder was recreated, so their setup counts as not run.
  setup_reset?: string[];
}

export interface EnsureWorktreesOptions {
  // Any checkout of the workspace: the main one or a change folder.
  rootPath: string;
  changeId: string;
  branch: string;
  // Limit registered repos to these ids. The workspace root is always included.
  repos?: string[];
  // Starting refs, most specific first: `repoBases[id]`, then `base`, then the repo's
  // configured `base`, then the remote default branch.
  base?: string;
  repoBases?: Record<string, string>;
  fetch?: boolean;
  // Opening an existing change: fetch each repo's change branch from origin first, so a
  // teammate's pushed work is used instead of starting that repo fresh.
  fetchBranch?: boolean;
  now?: Date;
}

interface RepoTarget {
  id: string;
  relativePath: string;
  sourcePath: string;
  worktreePath: string;
  base?: string;
  copy: string[];
}

type RepoPlan =
  | (RepoTarget & { action: "reuse" })
  | (RepoTarget & { action: "skip"; reason: string })
  // `staleEntry`: git's leftover record of this branch at a folder that no longer exists,
  // removed in the apply phase so the branch can be checked out again.
  | (RepoTarget & { action: "add_existing"; ref: string; staleEntry?: string })
  | (RepoTarget & { action: "add_tracking"; ref: string })
  | (RepoTarget & { action: "add_new"; base: string; baseCommit: string });

export interface LocalChangeState {
  version: 1;
  change: string;
  folder: string;
  slot: number;
  created_at: string;
  // The repos this change was checked out in; absent in files from older Weave versions.
  repos?: string[];
  setup?: Record<string, { hash: string; completed_at: string }>;
}

export async function workspaceCheckoutMode(rootPath: string): Promise<CheckoutMode> {
  return (await readWorkspaceMetadata(rootPath))?.checkout ?? "in-place";
}

// Every change lives in `<changes root>/<change id>`, next to the main checkout by default.
export async function changeFolderPath(rootPath: string, changeId: string): Promise<string> {
  const { mainRoot, metadata } = await workspaceLayout(rootPath);
  return path.join(changesRoot(mainRoot, metadata), changeId);
}

export async function ensureChangeWorktrees(options: EnsureWorktreesOptions): Promise<EnsureWorktreesResult> {
  const now = options.now ?? new Date();
  const { mainRoot, metadata } = await workspaceLayout(options.rootPath);
  const folder = path.join(changesRoot(mainRoot, metadata), options.changeId);
  const warnings: string[] = [];
  const blockers: WorktreeBlocker[] = [];

  const targets = selectTargets(mainRoot, folder, metadata, options.repos, options.repoBases, blockers);
  const plans: RepoPlan[] = [];
  for (const target of targets) {
    const plan = await planTarget(target, options, warnings, blockers);
    if (plan) {
      plans.push(plan);
    }
  }
  if (blockers.length > 0) {
    throw blockedError(blockers);
  }

  // A failed `git worktree add` (a failing checkout hook, say) can still leave the
  // worktree behind, so every attempted plan is rolled back, not just the finished ones.
  const created: RepoPlan[] = [];
  const results: WorktreeRepoResult[] = [];
  try {
    await mkdir(path.dirname(folder), { recursive: true });
    for (const plan of plans) {
      if (plan.action !== "reuse" && plan.action !== "skip") {
        created.push(plan);
      }
      results.push(await applyPlan(plan, options.branch));
    }
  } catch (error) {
    await rollback(created, options.branch);
    throw new ChangeCommandError(
      "worktree_failed",
      `Could not create the change worktrees; removed the ones this run created.\n  ${errorText(error)}`,
      { folder },
    );
  }

  const copied: string[] = [];
  for (const plan of created) {
    copied.push(...(await copyIgnoredFiles(plan, warnings)));
  }

  const recreated = results.filter((repo) => repo.status === "created").map((repo) => repo.id);
  let slotChanged: { from: number; to: number } | undefined;
  let setupReset: string[] | undefined;
  const state = await withStateLock(mainRoot, async (stateDir) => {
    const existing = await readLocalState(stateDir, options.changeId);
    const next: LocalChangeState = existing ?? {
      version: 1,
      change: options.changeId,
      folder,
      slot: await nextFreeSlot(stateDir),
      created_at: now.toISOString(),
    };
    if (existing && recreated.length > 0) {
      // A recreated folder keeps its slot only while no other open folder holds it.
      if (await slotHeldByOther(stateDir, options.changeId, existing.slot)) {
        const to = await nextFreeSlot(stateDir, { exclude: options.changeId, avoid: existing.slot });
        slotChanged = { from: existing.slot, to };
        next.slot = to;
      }
      // Its setup ran in a folder that no longer exists, so it counts as not run.
      setupReset = recreated;
      if (next.setup) {
        next.setup = Object.fromEntries(Object.entries(next.setup).filter(([repo]) => !recreated.includes(repo)));
      }
    }
    const repos = [...new Set([...(next.repos ?? []), ...results.filter((repo) => repo.status !== "skipped_not_git").map((repo) => repo.id)])];
    await writeLocalState(stateDir, { ...next, folder, repos });
    return next;
  });

  // The starting branch is remembered outside the folder so it survives close.
  const bases: Record<string, BaseRepoRecord> = {};
  for (const result of results) {
    if (result.base && result.base_commit) {
      bases[result.id] = { base: result.base, base_commit: result.base_commit, source: "created" };
    }
  }
  await recordBases(mainRoot, options.changeId, bases, now);

  return {
    folder,
    slot: state.slot,
    repos: results,
    copied,
    warnings,
    ...(slotChanged ? { slot_changed: slotChanged } : {}),
    ...(setupReset ? { setup_reset: setupReset } : {}),
  };
}

export interface RemoveWorktreesResult {
  folder: string;
  removed: string[];
  branches: Array<{ repo: string; branch: string; pushed: boolean }>;
  warnings: string[];
}

export const movedFolderWarning = "if you moved this folder, move it back first; closing stops tracking it";

// Removes a change's worktrees but keeps every branch, so closing never deletes commits.
// It also clears what a hand-deleted folder leaves behind: git's record of it (this
// change's entries only, never `git worktree prune`) and Weave's own record. The
// remembered starting branch is kept.
export async function removeChangeWorktrees(options: {
  rootPath: string;
  changeId: string;
  branch: string;
  cwd: string;
}): Promise<RemoveWorktreesResult> {
  const { mainRoot, metadata } = await workspaceLayout(options.rootPath);
  const stateDir = await localStateDir(mainRoot);
  const state = await readLocalState(stateDir, options.changeId);
  const root = changesRoot(mainRoot, metadata);
  const folder = state?.folder ?? path.join(root, options.changeId);

  if (!(await pathExists(folder)) && isInside(folder, root) && (await changesRootMissingParent(root))) {
    throw new ChangeCommandError(
      "changes_unavailable",
      `Change folders are unavailable at ${root}; reconnect the drive or folder first.`,
      { path: root },
    );
  }

  const sources = [
    { id: rootRepoId, sourcePath: mainRoot },
    ...Object.entries(metadata.repos).map(([id, entry]) => ({ id, sourcePath: path.join(mainRoot, entry.path) })),
  ];
  const found: Array<{ id: string; path: string; exists: boolean; locked: boolean }> = [];
  for (const source of sources) {
    if (!(await pathExists(source.sourcePath))) continue;
    const entry = (await listGitWorktrees(source.sourcePath)).find((worktree) => worktree.branch === options.branch);
    if (entry && path.resolve(entry.path) !== path.resolve(source.sourcePath)) {
      const locked = entry.locked || (await worktreeLockedOnDisk(source.sourcePath, entry.path));
      found.push({ id: source.id, path: entry.path, exists: await pathExists(entry.path), locked });
    }
  }
  if (found.length === 0 && !state) {
    throw new ChangeCommandError("no_worktrees", `No worktrees found for ${options.branch}.`, { folder });
  }

  const locked = found.find((worktree) => worktree.locked);
  if (locked) {
    throw new ChangeCommandError("worktree_locked", `${locked.path} is locked; unlock with \`git worktree unlock ${locked.path}\` first.`, {
      path: locked.path,
    });
  }

  const blockers: WorktreeBlocker[] = [];
  const cwd = await realpath(options.cwd).catch(() => path.resolve(options.cwd));
  if (isInside(cwd, folder)) {
    blockers.push({ target: folder, reason: "This command is running inside the change folder. Run it from your main checkout." });
  }
  for (const worktree of found.filter((item) => item.exists)) {
    const status = await runGit(["status", "--porcelain"], worktree.path);
    if (!status.ok) {
      blockers.push({ target: worktree.id, reason: `Could not read git status: ${status.stderr}` });
    } else if (status.stdout) {
      const count = status.stdout.split("\n").length;
      blockers.push({ target: worktree.id, reason: `${worktree.path} has ${count} uncommitted change${count === 1 ? "" : "s"}. Commit or remove them first.` });
    }
  }
  if (blockers.length > 0) {
    throw blockedError(blockers);
  }

  // Nested repo worktrees go first; the workspace root holds them.
  const ordered = [...found.filter((worktree) => worktree.id !== rootRepoId), ...found.filter((worktree) => worktree.id === rootRepoId)];
  const removed: string[] = [];
  for (const worktree of ordered) {
    const result = await runGit(["worktree", "remove", worktree.path], sourceFor(sources, worktree.id));
    if (!result.ok) {
      throw new ChangeCommandError(
        "worktree_remove_failed",
        `Removed ${removed.length} of ${ordered.length} worktrees, then git refused ${worktree.path}: ${result.stderr}`,
        { removed },
      );
    }
    removed.push(worktree.id);
  }

  await rmdir(folder).catch(() => undefined);
  await rm(path.join(stateDir, "changes", `${options.changeId}.yml`), { force: true });

  const missing = found.some((worktree) => !worktree.exists) || (found.length === 0 && !(await pathExists(folder)));
  const branches = [];
  for (const source of sources) {
    if (!(await pathExists(source.sourcePath))) continue;
    if (!found.some((worktree) => worktree.id === source.id) && source.id !== rootRepoId) continue;
    if (!(await resolveCommit(source.sourcePath, `refs/heads/${options.branch}`))) continue;
    branches.push({
      repo: source.id,
      branch: options.branch,
      pushed: Boolean(await resolveCommit(source.sourcePath, `refs/remotes/origin/${options.branch}`)),
    });
  }
  return { folder, removed, branches, warnings: missing ? [movedFolderWarning] : [] };
}

async function changesRootMissingParent(root: string): Promise<boolean> {
  if (await pathExists(root)) return false;
  const link = await lstat(root).catch(() => undefined);
  if (link?.isSymbolicLink()) return true;
  return !(await pathExists(path.dirname(root)));
}

export interface LocalChangeInfo {
  folder: string;
  slot: number;
}

export async function readLocalChangeInfo(rootPath: string, changeId: string): Promise<LocalChangeInfo | undefined> {
  const mainRoot = (await mainWorktreePath(rootPath)) ?? rootPath;
  const state = await readLocalState(await localStateDir(mainRoot), changeId);
  return state ? { folder: state.folder, slot: state.slot } : undefined;
}

// Merges each repo's starting point into status.yml so reviews and diffs use the right base.
export async function recordCheckoutInStatus(changePath: string, repos: WorktreeRepoResult[]): Promise<void> {
  const statusPath = path.join(changePath, "status.yml");
  const raw = (YAML.parse(await readFile(statusPath, "utf8")) as Record<string, unknown> | null) ?? {};
  const checkout = isRecord(raw.checkout) ? raw.checkout : {};
  const existingRepos = isRecord(checkout.repos) ? checkout.repos : {};
  const nextRepos: Record<string, unknown> = { ...existingRepos };
  for (const repo of repos) {
    if (repo.status === "skipped_not_git") continue;
    const existing = isRecord(nextRepos[repo.id]) ? (nextRepos[repo.id] as Record<string, unknown>) : {};
    nextRepos[repo.id] = {
      ...existing,
      path: repo.path,
      ...(repo.base ? { base: repo.base } : {}),
      ...(repo.base_commit ? { base_commit: repo.base_commit } : {}),
    };
  }
  raw.checkout = { mode: "worktree", repos: nextRepos };
  await writeFile(statusPath, YAML.stringify(raw));
}

export type SetupStatus = "ok" | "nothing_to_run" | "needs_approval" | "declined" | "failed";

export interface SetupCommand {
  repo: string;
  path: string;
  command: string;
}

export interface SetupResult {
  status: SetupStatus;
  change: string;
  folder: string;
  slot: number;
  ran: SetupCommand[];
  already_done: SetupCommand[];
  pending_approval: SetupCommand[];
  failure?: SetupCommand & { exit_code: number | null; log: string; output_tail: string };
  message: string;
}

export interface RunSetupOptions {
  folder: string;
  changeId: string;
  branch: string;
  approve?: boolean;
  // Asks a person to approve commands. Absent when nobody is at a terminal.
  confirm?: (commands: SetupCommand[]) => Promise<boolean>;
  now?: Date;
}

// Runs each worktree's setup command once. A command runs only after a person approved
// that exact command on this machine, so agents and auto-advance never run new commands.
export async function runChangeSetup(options: RunSetupOptions): Promise<SetupResult> {
  const now = options.now ?? new Date();
  const metadata = await requireMetadata(options.folder);
  const mainRoot = (await mainWorktreePath(options.folder)) ?? options.folder;
  const stateDir = await localStateDir(mainRoot);
  const state = await readLocalState(stateDir, options.changeId);
  const slot = state?.slot ?? 0;

  const commands: SetupCommand[] = [];
  if (metadata.worktrees.setup) {
    commands.push({ repo: rootRepoId, path: ".", command: metadata.worktrees.setup });
  }
  for (const [id, entry] of Object.entries(metadata.repos)) {
    if (!entry.setup) continue;
    const worktree = path.join(options.folder, entry.path);
    if ((await currentBranch(worktree)) === options.branch) {
      commands.push({ repo: id, path: entry.path, command: entry.setup });
    }
  }

  const done = state?.setup ?? {};
  const alreadyDone = commands.filter((item) => done[item.repo]?.hash === setupHash(item));
  const toRun = commands.filter((item) => done[item.repo]?.hash !== setupHash(item));
  const base = { change: options.changeId, folder: options.folder, slot, already_done: alreadyDone };

  if (toRun.length === 0) {
    return { ...base, status: "nothing_to_run", ran: [], pending_approval: [], message: setupMessage("nothing_to_run", base, [], []) };
  }

  const approved = await readApprovals(stateDir);
  const pending = toRun.filter((item) => !approved.has(setupHash(item)));
  if (pending.length > 0) {
    if (!options.approve) {
      return { ...base, status: "needs_approval", ran: [], pending_approval: pending, message: setupMessage("needs_approval", base, [], pending) };
    }
    if (!options.confirm) {
      throw new ChangeCommandError(
        "approval_needs_terminal",
        "Approving setup commands needs a person at an interactive terminal. Run `weave change setup --approve` yourself.",
        { pending },
      );
    }
    if (!(await options.confirm(pending))) {
      return { ...base, status: "declined", ran: [], pending_approval: pending, message: setupMessage("declined", base, [], pending) };
    }
    for (const item of pending) approved.add(setupHash(item));
    await writeApprovals(stateDir, approved);
  }

  const ran: SetupCommand[] = [];
  for (const item of toRun) {
    const log = path.join(stateDir, "logs", `${options.changeId}-${item.repo}-setup.log`);
    const exitCode = await runShell(item.command, path.join(options.folder, item.path), log, {
      WEAVE_CHANGE_ID: options.changeId,
      WEAVE_CHANGE_DIR: options.folder,
      WEAVE_REPO_ID: item.repo,
      WEAVE_SLOT: String(slot),
      WEAVE_SOURCE_DIR: item.repo === rootRepoId ? mainRoot : path.join(mainRoot, item.path),
    });
    if (exitCode !== 0) {
      const failure = { ...item, exit_code: exitCode, log, output_tail: await tail(log, 20) };
      return { ...base, status: "failed", ran, pending_approval: [], failure, message: setupMessage("failed", base, ran, [], failure) };
    }
    ran.push(item);
    await withStateLock(mainRoot, async () => {
      const latest = await readLocalState(stateDir, options.changeId);
      if (latest) {
        latest.setup = { ...(latest.setup ?? {}), [item.repo]: { hash: setupHash(item), completed_at: now.toISOString() } };
        await writeLocalState(stateDir, latest);
      }
    });
  }

  return { ...base, status: "ok", ran, pending_approval: [], message: setupMessage("ok", base, ran, []) };
}

async function workspaceLayout(rootPath: string): Promise<{ mainRoot: string; metadata: WorkspaceMetadata }> {
  const mainRoot = await mainCheckoutPath(rootPath);
  return { mainRoot, metadata: await requireMetadata(rootPath) };
}

// The main checkout's real path, the same from the main checkout or any change folder.
export async function mainCheckoutPath(rootPath: string): Promise<string> {
  return realpath((await mainWorktreePath(rootPath)) ?? rootPath);
}

async function requireMetadata(rootPath: string): Promise<WorkspaceMetadata> {
  const metadata = await readWorkspaceMetadata(rootPath);
  if (!metadata) {
    throw new ChangeCommandError("no_weave_context", "No Weave context found. Run `weave init` first.");
  }
  return metadata;
}

export function changesRoot(mainRoot: string, metadata: WorkspaceMetadata): string {
  return metadata.worktrees.root
    ? path.resolve(mainRoot, metadata.worktrees.root)
    : path.join(path.dirname(mainRoot), `${path.basename(mainRoot)}.changes`);
}

function selectTargets(
  mainRoot: string,
  folder: string,
  metadata: WorkspaceMetadata,
  requested: string[] | undefined,
  repoBases: Record<string, string> | undefined,
  blockers: WorktreeBlocker[],
): RepoTarget[] {
  const wanted = requested && requested.length > 0 ? new Set(requested) : undefined;
  for (const id of wanted ?? []) {
    if (!metadata.repos[id]) {
      blockers.push({ target: id, reason: `Repo is not registered in the workspace: ${id}` });
    }
  }
  for (const id of Object.keys(repoBases ?? {})) {
    if (id !== rootRepoId && !metadata.repos[id]) {
      blockers.push({ target: id, reason: `--base names a repo that is not registered in the workspace: ${id}` });
    } else if (id !== rootRepoId && wanted && !wanted.has(id)) {
      blockers.push({ target: id, reason: `--base names ${id}, but --repo leaves it out.` });
    }
  }

  const targets: RepoTarget[] = [
    { id: rootRepoId, relativePath: ".", sourcePath: mainRoot, worktreePath: folder, base: metadata.worktrees.base, copy: metadata.worktrees.copy },
  ];
  for (const [id, entry] of Object.entries(metadata.repos)) {
    if (wanted && !wanted.has(id)) continue;
    targets.push({
      id,
      relativePath: entry.path,
      sourcePath: path.join(mainRoot, entry.path),
      worktreePath: path.join(folder, entry.path),
      base: entry.base,
      copy: entry.copy ?? [],
    });
  }
  return targets;
}

async function planTarget(
  target: RepoTarget,
  options: EnsureWorktreesOptions,
  warnings: string[],
  blockers: WorktreeBlocker[],
): Promise<RepoPlan | undefined> {
  if (!(await pathExists(target.sourcePath))) {
    blockers.push({ target: target.id, reason: `Registered repo path does not exist: ${target.sourcePath}` });
    return undefined;
  }

  const probe = await probeGitRoot(target.sourcePath);
  if (probe.kind === "error") {
    blockers.push({ target: target.id, reason: `git could not read ${target.sourcePath}: ${probe.message}` });
    return undefined;
  }
  const source = await realpath(target.sourcePath);
  if (probe.kind === "not_git" || probe.root !== source) {
    if (target.id === rootRepoId) {
      blockers.push({ target: target.id, reason: `${target.sourcePath} is not the root of a git repository.` });
      return undefined;
    }
    // A plain folder inside the workspace repo travels with the root worktree.
    return { ...target, action: "skip", reason: "not a separate git repository" };
  }

  const existing = (await listGitWorktrees(source)).find((worktree) => worktree.branch === options.branch);
  let staleEntry: string | undefined;
  if (existing) {
    const onDisk = await pathExists(existing.path);
    if (onDisk && path.resolve(existing.path) === path.resolve(target.worktreePath)) {
      return { ...target, action: "reuse" };
    }
    if (onDisk) {
      blockers.push({ target: target.id, reason: `${options.branch} is already checked out at ${existing.path}.` });
      return undefined;
    }
    // The folder is gone (deleted, or moved). Nothing is removed while planning: the
    // leftover record is cleared in the apply phase, once every repo has passed.
    if (existing.locked || (await worktreeLockedOnDisk(source, existing.path))) {
      blockers.push({ target: target.id, reason: `${existing.path} is locked; unlock it with \`git worktree unlock ${existing.path}\` first.` });
      return undefined;
    }
    staleEntry = existing.path;
  }
  if (await pathExists(target.worktreePath)) {
    blockers.push({ target: target.id, reason: `${target.worktreePath} already exists and is not this change's worktree.` });
    return undefined;
  }

  if (await resolveCommit(source, `refs/heads/${options.branch}`)) {
    return { ...target, action: "add_existing", ref: options.branch, ...(staleEntry ? { staleEntry } : {}) };
  }
  if (options.fetchBranch && (await runGit(["remote", "get-url", "origin"], source)).ok) {
    // Fails quietly when the repo has no such branch on origin; it then starts from its base.
    await runGit(["fetch", "--quiet", "origin", options.branch], source);
  }
  if (await resolveCommit(source, `refs/remotes/origin/${options.branch}`)) {
    return { ...target, action: "add_tracking", ref: `origin/${options.branch}` };
  }

  const requested = options.repoBases?.[target.id] ?? options.base ?? target.base;
  const base = await resolveBaseRef(source, requested, options.fetch ?? true, warnings, target.id);
  if (!base) {
    blockers.push({
      target: target.id,
      reason: requested
        ? `${requested} was not found in ${target.id}, locally or on origin.${options.base && !options.repoBases?.[target.id] ? ` If only some repos have it, pass --base <repo>=${requested} for those repos instead.` : ""}`
        : "Could not find a default branch to start from. Pass --base <ref>.",
    });
    return undefined;
  }
  const baseCommit = await resolveCommit(source, base);
  if (!baseCommit) {
    blockers.push({ target: target.id, reason: `Base ref ${base} does not exist.` });
    return undefined;
  }
  if (target.id === rootRepoId && !(await runGit(["cat-file", "-e", `${baseCommit}:.weave/workspace.yml`], source)).ok) {
    blockers.push({
      target: target.id,
      reason: `.weave/workspace.yml is not committed on ${base}, so a worktree from it would not be a Weave workspace. Commit (and push) the Weave setup first.`,
    });
    return undefined;
  }
  return { ...target, action: "add_new", base, baseCommit };
}

async function resolveBaseRef(
  source: string,
  explicit: string | undefined,
  fetch: boolean,
  warnings: string[],
  repoId: string,
): Promise<string | undefined> {
  if (explicit) {
    // An `origin/` ref is fetched first. A plain name means the local branch or ref when
    // there is one, and otherwise the branch of that name on origin.
    if (explicit.startsWith("origin/")) {
      if (fetch) {
        const fetched = await runGit(["fetch", "--quiet", "origin", explicit.slice("origin/".length)], source);
        if (!fetched.ok && (await resolveCommit(source, explicit))) {
          warnings.push(`${repoId}: could not fetch ${explicit}; using the last fetched copy.`);
        }
      }
      return (await resolveCommit(source, explicit)) ? explicit : undefined;
    }
    if (await resolveCommit(source, explicit)) {
      return explicit;
    }
    if (fetch && (await runGit(["remote", "get-url", "origin"], source)).ok) {
      await runGit(["fetch", "--quiet", "origin", explicit], source);
    }
    return (await resolveCommit(source, `refs/remotes/origin/${explicit}`)) ? `origin/${explicit}` : undefined;
  }
  const resolved = await resolveDefaultBase(source, { fetch });
  if (resolved?.warning) warnings.push(`${repoId}: ${resolved.warning}`);
  return resolved?.ref;
}

async function applyPlan(plan: RepoPlan, branch: string): Promise<WorktreeRepoResult> {
  const common = { id: plan.id, path: plan.relativePath, branch };
  switch (plan.action) {
    case "reuse":
      return { ...common, status: "reused" };
    case "skip":
      return { ...common, status: "skipped_not_git", reason: plan.reason };
    case "add_existing":
      if (plan.staleEntry) {
        await gitOrThrow(["worktree", "remove", plan.staleEntry], plan.sourcePath);
      }
      await gitOrThrow(["worktree", "add", plan.worktreePath, plan.ref], plan.sourcePath);
      return { ...common, status: "created" };
    case "add_tracking":
      await gitOrThrow(["worktree", "add", "--track", "-b", branch, plan.worktreePath, plan.ref], plan.sourcePath);
      return { ...common, status: "created" };
    case "add_new":
      await gitOrThrow(["worktree", "add", "--no-track", "-b", branch, plan.worktreePath, plan.baseCommit], plan.sourcePath);
      return { ...common, status: "created", base: plan.base, base_commit: plan.baseCommit };
  }
}

async function rollback(created: RepoPlan[], branch: string): Promise<void> {
  for (const plan of [...created].reverse()) {
    await runGit(["worktree", "remove", "--force", plan.worktreePath], plan.sourcePath);
    await runGit(["worktree", "prune"], plan.sourcePath);
    if (plan.action === "add_new" || plan.action === "add_tracking") {
      await runGit(["branch", "-D", branch], plan.sourcePath);
    }
  }
  const root = created.find((plan) => plan.id === rootRepoId);
  if (root) {
    await rm(root.worktreePath, { recursive: true, force: true });
  }
}

async function gitOrThrow(args: string[], cwd: string): Promise<void> {
  const result = await runGit(args, cwd);
  if (!result.ok) {
    throw new Error(`git ${args.slice(0, 2).join(" ")} failed in ${cwd}: ${result.stderr}`);
  }
}

async function copyIgnoredFiles(plan: RepoPlan, warnings: string[]): Promise<string[]> {
  const copied: string[] = [];
  for (const entry of plan.copy) {
    const normalized = path.normalize(entry);
    if (path.isAbsolute(normalized) || normalized.startsWith("..")) {
      warnings.push(`${plan.id}: skipped copy entry ${entry}; it must be a path inside the repo.`);
      continue;
    }
    const from = path.join(plan.sourcePath, normalized);
    const to = path.join(plan.worktreePath, normalized);
    if (!(await pathExists(from))) {
      warnings.push(`${plan.id}: ${entry} does not exist in ${plan.sourcePath}, so it was not copied.`);
      continue;
    }
    if ((await runGit(["ls-files", "--error-unmatch", "--", normalized], plan.sourcePath)).ok || (await pathExists(to))) {
      continue;
    }
    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to, { recursive: true, errorOnExist: false, force: false });
    copied.push(path.join(plan.relativePath, normalized));
  }
  return copied;
}

export async function listLocalChangeIds(stateDir: string): Promise<string[]> {
  const entries = await readdir(path.join(stateDir, "changes")).catch(() => [] as string[]);
  return entries.filter((name) => name.endsWith(".yml")).map((name) => name.slice(0, -".yml".length));
}

export async function readLocalState(stateDir: string, changeId: string): Promise<LocalChangeState | undefined> {
  const file = path.join(stateDir, "changes", `${changeId}.yml`);
  if (!(await pathExists(file))) return undefined;
  const parsed = YAML.parse(await readFile(file, "utf8")) as LocalChangeState | null;
  return parsed && typeof parsed.slot === "number" ? parsed : undefined;
}

async function writeLocalState(stateDir: string, state: LocalChangeState): Promise<void> {
  await mkdir(path.join(stateDir, "changes"), { recursive: true });
  await writeFile(path.join(stateDir, "changes", `${state.change}.yml`), YAML.stringify(state));
}

// Slots are small numbers projects can turn into ports. A slot frees up when its change
// folder is closed or deleted.
async function nextFreeSlot(stateDir: string, options: { exclude?: string; avoid?: number } = {}): Promise<number> {
  const used = new Set<number>(options.avoid !== undefined ? [options.avoid] : []);
  for (const id of await listLocalChangeIds(stateDir)) {
    if (id === options.exclude) continue;
    const state = await readLocalState(stateDir, id);
    if (state && (await pathExists(state.folder))) used.add(state.slot);
  }
  let slot = 1;
  while (used.has(slot)) slot += 1;
  return slot;
}

async function slotHeldByOther(stateDir: string, changeId: string, slot: number): Promise<boolean> {
  for (const id of await listLocalChangeIds(stateDir)) {
    if (id === changeId) continue;
    const state = await readLocalState(stateDir, id);
    if (state && state.slot === slot && (await pathExists(state.folder))) return true;
  }
  return false;
}

function setupHash(item: SetupCommand): string {
  return createHash("sha256").update(`${item.repo}\n${item.command}`).digest("hex");
}

async function readApprovals(stateDir: string): Promise<Set<string>> {
  const file = path.join(stateDir, "approved-setup.yml");
  if (!(await pathExists(file))) return new Set();
  const parsed = YAML.parse(await readFile(file, "utf8")) as { approved?: unknown } | null;
  return new Set(Array.isArray(parsed?.approved) ? parsed.approved.filter((item): item is string => typeof item === "string") : []);
}

async function writeApprovals(stateDir: string, approved: Set<string>): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "approved-setup.yml"), YAML.stringify({ approved: [...approved].sort() }));
}

async function runShell(command: string, cwd: string, logPath: string, env: Record<string, string>): Promise<number | null> {
  await mkdir(path.dirname(logPath), { recursive: true });
  const log = await open(logPath, "w");
  try {
    return await new Promise<number | null>((resolve) => {
      const child = spawn("/bin/sh", ["-c", command], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", log.fd, log.fd] });
      child.on("error", () => resolve(null));
      child.on("close", (code) => resolve(code));
    });
  } finally {
    await log.close();
  }
}

async function tail(file: string, lines: number): Promise<string> {
  const content = await readFile(file, "utf8").catch(() => "");
  return content.trimEnd().split("\n").slice(-lines).join("\n");
}

function setupMessage(
  status: SetupStatus,
  base: { change: string; folder: string; slot: number; already_done: SetupCommand[] },
  ran: SetupCommand[],
  pending: SetupCommand[],
  failure?: SetupCommand & { exit_code: number | null; log: string; output_tail: string },
): string {
  const lines = [`Setup: ${base.change}`, `Folder: ${base.folder}`, `Slot: ${base.slot}`, `Status: ${status}`];
  const list = (items: SetupCommand[]) => items.map((item) => `  ${item.repo} (${item.path}): ${item.command}`);
  if (ran.length > 0) lines.push("", "Ran:", ...list(ran));
  if (base.already_done.length > 0) lines.push("", "Already done:", ...list(base.already_done));
  if (pending.length > 0) {
    lines.push("", "Needs approval:", ...list(pending));
    if (status === "needs_approval") lines.push("", "Run `weave change setup --approve` in a terminal to review and approve them.");
  }
  if (failure) {
    lines.push("", `Failed: ${failure.repo} (exit ${failure.exit_code ?? "unknown"})`, `Log: ${failure.log}`, failure.output_tail);
  }
  return lines.join("\n");
}

function blockedError(blockers: WorktreeBlocker[]): ChangeCommandError {
  return new ChangeCommandError(
    "worktree_blocked",
    ["Nothing was changed:", ...blockers.map((blocker) => `  ${blocker.target}: ${blocker.reason}`)].join("\n"),
    { blockers },
  );
}

function sourceFor(sources: Array<{ id: string; sourcePath: string }>, id: string): string {
  return sources.find((source) => source.id === id)?.sourcePath ?? sources[0]!.sourcePath;
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
