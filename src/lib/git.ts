import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
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

function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    GIT_AUTHOR_NAME: base.GIT_AUTHOR_NAME ?? "Weave",
    GIT_AUTHOR_EMAIL: base.GIT_AUTHOR_EMAIL ?? "weave@example.invalid",
    GIT_COMMITTER_NAME: base.GIT_COMMITTER_NAME ?? "Weave",
    GIT_COMMITTER_EMAIL: base.GIT_COMMITTER_EMAIL ?? "weave@example.invalid",
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
  // Marked in git to be kept even when its folder is gone (`git worktree lock`).
  locked: boolean;
  // Git would clear this entry on `git worktree prune`, usually because its folder is gone.
  prunable: boolean;
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
      current = { path: line.slice("worktree ".length), detached: false, bare: false, locked: false, prunable: false };
      entries.push(current);
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (current && line === "detached") {
      current.detached = true;
    } else if (current && line === "bare") {
      current.bare = true;
    } else if (current && (line === "locked" || line.startsWith("locked "))) {
      current.locked = true;
    } else if (current && (line === "prunable" || line.startsWith("prunable "))) {
      current.prunable = true;
    }
  }
  return entries;
}

// `git worktree list --porcelain` reports `locked` only from git 2.31; older git keeps the
// marker as a file in the worktree's admin directory.
export async function worktreeLockedOnDisk(cwd: string, worktreePath: string): Promise<boolean> {
  const admin = await runGit(["rev-parse", "--git-common-dir"], cwd);
  if (!admin.ok || !admin.stdout) return false;
  const worktreesDir = path.join(path.resolve(cwd, admin.stdout), "worktrees");
  const names = await readdir(worktreesDir).catch(() => [] as string[]);
  for (const name of names) {
    const gitdir = await readFile(path.join(worktreesDir, name, "gitdir"), "utf8").catch(() => "");
    if (gitdir && path.dirname(gitdir.trim()) === path.resolve(worktreePath)) {
      return access(path.join(worktreesDir, name, "locked")).then(
        () => true,
        () => false,
      );
    }
  }
  return false;
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

// ── Landed-check primitives ──────────────────────────────────────────────────

type GitExit = { code: number | null; stdout: string; stderr: string };

async function runGitExit(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<GitExit> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, env: env ?? gitEnv(), maxBuffer: 32 * 1024 * 1024 });
    return { code: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : null,
      stdout: (failure.stdout ?? "").trim(),
      stderr: (failure.stderr ?? failure.message ?? "").trim(),
    };
  }
}

// `true`/`false` for a clean answer, `undefined` when git could not answer.
export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean | undefined> {
  const result = await runGitExit(["merge-base", "--is-ancestor", ancestor, descendant], cwd);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  return undefined;
}

export async function mergeBase(cwd: string, a: string, b: string): Promise<string | undefined> {
  const result = await runGit(["merge-base", a, b], cwd);
  return result.ok && result.stdout ? result.stdout : undefined;
}

export async function revCount(cwd: string, range: string): Promise<number | undefined> {
  const result = await runGit(["rev-list", "--count", range], cwd);
  if (!result.ok) return undefined;
  const value = Number.parseInt(result.stdout, 10);
  return Number.isFinite(value) ? value : undefined;
}

// Commits on the first-parent line of `range`, newest first.
export async function firstParentCommits(cwd: string, range: string, limit: number): Promise<string[] | undefined> {
  const result = await runGit(["rev-list", "--first-parent", `--max-count=${limit}`, range], cwd);
  if (!result.ok) return undefined;
  return result.stdout ? result.stdout.split("\n") : [];
}

// `git cherry <upstream> <head>` lines as "+"/"-" marks, one per commit of head not in upstream.
export async function cherryMarks(cwd: string, upstream: string, head: string): Promise<Array<"+" | "-"> | undefined> {
  const result = await runGit(["cherry", upstream, head], cwd);
  if (!result.ok) return undefined;
  return result.stdout ? result.stdout.split("\n").map((line) => (line.startsWith("-") ? "-" : "+")) : [];
}

// Whether `tip` sits on the first-parent line of `target` (a fast-forward, or a branch
// that never left it), as opposed to arriving through a merge commit's side parent.
export async function onFirstParentLine(cwd: string, tip: string, target: string): Promise<boolean | undefined> {
  if (tip === target) return true;
  const result = await runGit(["rev-list", "--first-parent", "--parents", `${tip}..${target}`], cwd);
  if (!result.ok) return undefined;
  return result.stdout.split("\n").some((line) => line.split(" ")[1] === tip);
}

export async function treeOf(cwd: string, commit: string): Promise<string | undefined> {
  const result = await runGit(["rev-parse", "--verify", "--quiet", `${commit}^{tree}`], cwd);
  return result.ok && result.stdout ? result.stdout : undefined;
}

// Runs `git merge-tree --write-tree` against a throwaway object directory, with the
// repo's real store as an alternate, so the check never writes into the user's repo.
export async function mergeTreeWrite(cwd: string, target: string, tip: string): Promise<{ tree?: string; error?: string }> {
  const objects = await runGit(["rev-parse", "--git-path", "objects"], cwd);
  if (!objects.ok || !objects.stdout) return { error: "could not find the object store" };
  const realObjects = path.resolve(cwd, objects.stdout);
  const scratch = await mkdtemp(path.join(os.tmpdir(), "weave-merge-tree-"));
  try {
    const env = {
      ...gitEnv(),
      GIT_OBJECT_DIRECTORY: scratch,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: [realObjects, process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES].filter(Boolean).join(path.delimiter),
    };
    const result = await runGitExit(["merge-tree", "--write-tree", "--no-messages", target, tip], cwd, env);
    // Exit 1 means conflicts; the first line is still the (conflicted) tree.
    if (result.code === 0 || result.code === 1) {
      const tree = result.stdout.split("\n")[0]?.trim();
      return tree ? { tree } : { error: "merge-tree printed no tree" };
    }
    return { error: firstLine(result.stderr) || "merge-tree failed" };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export interface GitCaps {
  version: string;
  noWriteFetchHead: boolean; // git 2.29
  worktreePorcelainFlags: boolean; // git 2.31: `prunable`/`locked` in `worktree list --porcelain`
  mergeTreeWrite: boolean; // git 2.38
}

let versionPromise: Promise<{ text: string; major: number; minor: number }> | undefined;

// The git version is probed once per process; the test override is read on every call.
export async function gitVersionCaps(): Promise<GitCaps> {
  versionPromise ??= runGit(["--version"], process.cwd()).then((result) => {
    const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(result.stdout);
    return { text: match ? match[0] : "unknown", major: match ? Number(match[1]) : 0, minor: match ? Number(match[2]) : 0 };
  });
  const { text, major, minor } = await versionPromise;
  const atLeast = (wantMajor: number, wantMinor: number) => major > wantMajor || (major === wantMajor && minor >= wantMinor);
  return {
    version: text,
    noWriteFetchHead: atLeast(2, 29),
    worktreePorcelainFlags: atLeast(2, 31),
    mergeTreeWrite: atLeast(2, 38) && process.env.WEAVE_TEST_GIT_NO_MERGE_TREE !== "1",
  };
}

// A short key for cached results that depend on git's capabilities.
export function gitCapsKey(caps: GitCaps): string {
  return `mt${caps.mergeTreeWrite ? 1 : 0}`;
}

// ── Fetching remote state without prompting (ADR 261108-4ko1) ──────────────────

export type FetchResultKind = "ok" | "timeout" | "auth" | "unreachable" | "no_remote" | "error";

export interface FetchOutcome {
  result: FetchResultKind;
  message: string | null;
}

// Settings that keep a background fetch from touching anything but Weave's refs: no tags,
// no auto-gc or maintenance, no commit-graph writes, and no submodule recursion.
const quietFetchConfig = [
  "-c", "fetch.pruneTags=false",
  "-c", "gc.auto=0",
  "-c", "maintenance.auto=false",
  "-c", "fetch.writeCommitGraph=false",
  "-c", "fetch.recurseSubmodules=false",
  "-c", "credential.interactive=false",
];

// An environment in which git, ssh, and credential helpers can't ask anyone anything.
export async function noPromptEnv(cwd: string, base: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {
    ...gitEnv(base),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "false",
    SSH_ASKPASS: "false",
    SSH_ASKPASS_REQUIRE: "never",
    GCM_INTERACTIVE: "never",
  };
  const configuredSsh = await runGit(["config", "--get", "core.sshCommand"], cwd);
  if (!base.GIT_SSH_COMMAND && !base.GIT_SSH && !(configuredSsh.ok && configuredSsh.stdout)) {
    env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  }
  return env;
}

export function classifyFetchFailure(stderr: string): FetchResultKind {
  if (/authentication failed|could not read (username|password)|terminal prompts disabled|permission denied \(publickey|host key verification failed|invalid username or password|returned error: 40[13]/i.test(stderr)) {
    return "auth";
  }
  if (/could not resolve host|connection refused|connection timed out|network is unreachable|failed to connect|no route to host|could not read from remote repository|does not appear to be a git repository|unable to access/i.test(stderr)) {
    return "unreachable";
  }
  return "error";
}

// Runs git in its own session with no terminal and stdin closed, and kills the whole
// process group when the time limit passes.
function runGitNoPrompt(args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || error.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim(), timedOut });
    });
  });
}

export async function hasOrigin(cwd: string): Promise<boolean> {
  return (await runGit(["remote", "get-url", "origin"], cwd)).ok;
}

// Branch names on origin (without `refs/heads/`).
export async function lsRemoteHeads(cwd: string, options: { timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<{ heads: Set<string> } | FetchOutcome> {
  if (!(await hasOrigin(cwd))) return { result: "no_remote", message: null };
  const env = options.env ?? (await noPromptEnv(cwd));
  const run = await runGitNoPrompt([...quietFetchConfig, "ls-remote", "--heads", "origin"], cwd, env, options.timeoutMs);
  if (run.timedOut) return { result: "timeout", message: null };
  if (run.code !== 0) return { result: classifyFetchFailure(run.stderr), message: firstLine(run.stderr) || null };
  const heads = new Set<string>();
  for (const line of run.stdout.split("\n")) {
    const ref = line.split("\t")[1];
    if (ref?.startsWith("refs/heads/")) heads.add(ref.slice("refs/heads/".length));
  }
  return { heads };
}

export const weaveRemoteRefPrefix = "refs/weave/remotes/origin/";

// Fetches the named branches from origin into Weave's own namespace. The user's
// `refs/remotes/*`, FETCH_HEAD, and tags are never written.
export async function fetchNoPrompt(cwd: string, options: { branches: string[]; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<FetchOutcome> {
  if (options.branches.length === 0) return { result: "ok", message: null };
  const env = options.env ?? (await noPromptEnv(cwd));
  const caps = await gitVersionCaps();
  const refspecs = options.branches.map((branch) => `+refs/heads/${branch}:${weaveRemoteRefPrefix}${branch}`);
  const args = [
    ...quietFetchConfig,
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-recurse-submodules",
    // Without an empty refmap, git also "opportunistically" moves the user's
    // `refs/remotes/origin/<branch>` for every branch named on the command line.
    "--refmap=",
    ...(caps.noWriteFetchHead ? ["--no-write-fetch-head"] : []),
    "origin",
    ...refspecs,
  ];
  const run = await runGitNoPrompt(args, cwd, env, options.timeoutMs);
  if (run.timedOut) return { result: "timeout", message: null };
  if (run.code !== 0) return { result: classifyFetchFailure(run.stderr), message: firstLine(run.stderr) || null };
  return { result: "ok", message: null };
}

export async function deleteRef(cwd: string, ref: string): Promise<void> {
  await runGit(["update-ref", "-d", ref], cwd);
}
