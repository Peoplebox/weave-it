import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv() });
    const value = stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Weave",
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "weave@example.invalid",
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Weave",
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "weave@example.invalid",
  };
}

export async function findGitRoot(cwd: string): Promise<string | undefined> {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

export async function currentBranch(cwd: string): Promise<string | undefined> {
  const gitRoot = await findGitRoot(cwd);
  if (!gitRoot) {
    return undefined;
  }

  return git(["branch", "--show-current"], gitRoot);
}

export async function isWorktreeDirty(cwd: string): Promise<boolean> {
  const gitRoot = await findGitRoot(cwd);
  if (!gitRoot) {
    return false;
  }

  return Boolean(await git(["status", "--porcelain"], gitRoot));
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  const gitRoot = await findGitRoot(cwd);
  if (!gitRoot) {
    return false;
  }

  return Boolean(await git(["rev-parse", "--verify", `refs/heads/${branch}`], gitRoot));
}

export async function checkoutBranch(cwd: string, branch: string): Promise<void> {
  const gitRoot = await findGitRoot(cwd);
  await runGitRequired(["checkout", branch], gitRoot ?? cwd);
}

export async function createBranch(cwd: string, branch: string): Promise<void> {
  const gitRoot = await findGitRoot(cwd);
  await runGitRequired(["checkout", "-b", branch], gitRoot ?? cwd);
}

export async function currentHead(cwd: string): Promise<string | undefined> {
  const gitRoot = await findGitRoot(cwd);
  if (!gitRoot) {
    return undefined;
  }

  return git(["rev-parse", "HEAD"], gitRoot);
}

export async function getGitRemote(cwd: string): Promise<string | undefined> {
  return git(["config", "--get", "remote.origin.url"], cwd);
}

export async function runGitRequired(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd, env: gitEnv() });
}

export async function cloneRepo(url: string, destinationDir: string, cwd: string): Promise<void> {
  await runGitRequired(["clone", "--", url, destinationDir], cwd);
}

export type GitRunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
};

// Runs git without throwing, so callers can tell a failed command from a missing repo.
export async function runGit(args: string[], cwd: string): Promise<GitRunResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, env: gitEnv(), maxBuffer: 32 * 1024 * 1024 });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: (failure.stdout ?? "").trim(),
      stderr: (failure.stderr ?? failure.message ?? "").trim(),
    };
  }
}

export type GitRootProbe =
  | { kind: "repo"; root: string }
  | { kind: "not_git" }
  | { kind: "error"; message: string };

// `findGitRoot` treats every failure as "not a repo". This keeps real git errors
// (unreadable config, ownership checks) visible instead of silently skipping the repo.
export async function probeGitRoot(cwd: string): Promise<GitRootProbe> {
  const result = await runGit(["rev-parse", "--show-toplevel"], cwd);
  if (result.ok && result.stdout) {
    return { kind: "repo", root: await realpath(result.stdout) };
  }
  if (/not a git repository/i.test(result.stderr)) {
    return { kind: "not_git" };
  }
  return { kind: "error", message: firstLine(result.stderr) || "git rev-parse failed" };
}

export async function gitCommonDir(cwd: string): Promise<string | undefined> {
  const result = await runGit(["rev-parse", "--git-common-dir"], cwd);
  if (!result.ok || !result.stdout) {
    return undefined;
  }
  return path.resolve(cwd, result.stdout);
}

export type GitWorktreeEntry = {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
};

export async function listGitWorktrees(cwd: string): Promise<GitWorktreeEntry[]> {
  const result = await runGit(["worktree", "list", "--porcelain"], cwd);
  if (!result.ok) {
    return [];
  }

  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | undefined;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), detached: false, bare: false };
      entries.push(current);
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (current && line === "detached") {
      current.detached = true;
    } else if (current && line === "bare") {
      current.bare = true;
    }
  }
  return entries;
}

// The first entry of `git worktree list` is always the main checkout.
export async function mainWorktreePath(cwd: string): Promise<string | undefined> {
  const [main] = await listGitWorktrees(cwd);
  return main && !main.bare ? main.path : undefined;
}

export type DefaultBase = {
  ref: string;
  branch: string;
  remote: boolean;
  fetched: boolean;
  warning?: string;
};

// Resolves the branch new work should start from: the remote default branch when the
// repo has an `origin`, after fetching it, and the local default branch otherwise.
export async function resolveDefaultBase(cwd: string, options: { fetch: boolean }): Promise<DefaultBase | undefined> {
  const hasOrigin = (await runGit(["remote", "get-url", "origin"], cwd)).ok;
  if (!hasOrigin) {
    const branch = await localDefaultBranch(cwd);
    return branch ? { ref: branch, branch, remote: false, fetched: false } : undefined;
  }

  let branch = await originHeadBranch(cwd);
  if (!branch && options.fetch) {
    await runGit(["remote", "set-head", "origin", "--auto"], cwd);
    branch = await originHeadBranch(cwd);
  }
  branch ??= (await firstExistingRef(cwd, ["origin/main", "origin/master"]))?.replace(/^origin\//, "");
  if (!branch) {
    const local = await localDefaultBranch(cwd);
    return local ? { ref: local, branch: local, remote: false, fetched: false, warning: "Could not find origin's default branch; using the local one." } : undefined;
  }

  if (!options.fetch) {
    return { ref: `origin/${branch}`, branch, remote: true, fetched: false };
  }
  const fetched = await runGit(["fetch", "--quiet", "origin", branch], cwd);
  return {
    ref: `origin/${branch}`,
    branch,
    remote: true,
    fetched: fetched.ok,
    ...(fetched.ok ? {} : { warning: `Could not fetch origin/${branch} (${firstLine(fetched.stderr)}); using the last fetched copy.` }),
  };
}

export async function resolveCommit(cwd: string, ref: string): Promise<string | undefined> {
  const result = await runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
  return result.ok && result.stdout ? result.stdout : undefined;
}

async function originHeadBranch(cwd: string): Promise<string | undefined> {
  const result = await runGit(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], cwd);
  return result.ok && result.stdout.startsWith("origin/") ? result.stdout.slice("origin/".length) : undefined;
}

async function localDefaultBranch(cwd: string): Promise<string | undefined> {
  const configured = await runGit(["config", "--get", "init.defaultBranch"], cwd);
  const candidates = [...(configured.ok && configured.stdout ? [configured.stdout] : []), "main", "master"];
  return firstExistingRef(cwd, candidates.map((name) => `refs/heads/${name}`)).then((ref) => ref?.replace(/^refs\/heads\//, ""));
}

async function firstExistingRef(cwd: string, refs: string[]): Promise<string | undefined> {
  for (const ref of refs) {
    if (await resolveCommit(cwd, ref)) {
      return ref;
    }
  }
  return undefined;
}

function firstLine(value: string): string {
  return value.split("\n").find((line) => line.trim().length > 0)?.replace(/^fatal:\s*/, "").trim() ?? "";
}
