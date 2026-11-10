// Cleanup of review snapshot refs and local review packages (decision 261110-wdfo). Refs under
// `refs/weave/reviews/<change>/` and packages under `<checkout>/.weave/tmp/reviews/<change>/`
// are deleted only for changes that have fully landed (decision 261108-kl3n: the landed result
// is exactly `landed`) or that no longer exist anywhere on this machine. Closing a change never
// prunes, because closed changes can be reopened. Nothing outside `refs/weave/reviews/` and the
// package folders is touched.
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { ChangeCommandError } from "../changes.js";
import { gatherFacts, repoSources, resolveMainRoot, type GatherResult } from "../change-facts.js";
import { readRemoteFacts } from "../change-refresh.js";
import type { ChangeFacts } from "../change-states.js";
import { pathExists } from "../files.js";
import { resolveCommit, runGit, weaveRemoteRefPrefix } from "../git.js";
import type { LandedResult } from "../landed.js";
import { localStateDir } from "../local-state.js";
import { readWorkspaceMetadata } from "../workspace-repos.js";
import { listLocalChangeIds } from "../worktrees.js";
import { reviewRefPrefix } from "./boundary.js";

export type PruneReason = "landed" | "missing";
// Why a change's refs were kept: its landed result (anything short of exactly `landed`),
// `unchecked` when Weave cannot tell, or `error` when deleting failed in one repo.
export type KeepReason = Exclude<LandedResult, "landed"> | "error";

export interface PrunedChange {
  change: string;
  reason: PruneReason;
  // Refs deleted per repo id; repos without refs for the change are left out.
  refs_deleted: Record<string, number>;
  packages_deleted: boolean;
}

export interface KeptChange {
  change: string;
  reason: KeepReason;
  // Set for `error`: the repo whose refs could not be listed or deleted, and git's message.
  repo?: string;
  message?: string;
}

export interface PruneResult {
  status: "ok";
  pruned: PrunedChange[];
  kept: KeptChange[];
}

export interface PruneOptions {
  // Limits pruning to this change; the same landed-or-missing rule still applies.
  change?: string;
  // Facts the background refresh already gathered, reused instead of recomputing landed results.
  facts?: GatherResult;
}

interface RepoRefs {
  id: string;
  path: string;
}

// The change id a review ref belongs to: `refs/weave/reviews/<change>/...`.
function refChangeId(ref: string): string | undefined {
  const prefix = `${reviewRefPrefix}/`;
  if (!ref.startsWith(prefix)) return undefined;
  const id = ref.slice(prefix.length).split("/")[0];
  return id ? id : undefined;
}

// The change-level landed result, the same way `weave change list` decides it: repos with no
// commits are ignored, and the least-finished repo with commits decides. Only every such repo
// being exactly `landed` counts as landed.
export function changeLandedResult(facts: ChangeFacts): LandedResult {
  const results = facts.repos
    .filter((repo) => repo.hasTip)
    .map((repo) => repo.landed?.result ?? "unchecked")
    .filter((result) => result !== "no_commits");
  if (results.length === 0) return "no_commits";
  if (results.every((result) => result === "landed")) return "landed";
  if (results.includes("unchecked")) return "unchecked";
  if (results.includes("not_landed")) return "not_landed";
  return "landed_with_newer_commits";
}

// A change no longer exists when this machine has no local state for it, the main checkout has
// no `wiki/changes/<id>/`, and no registered repo has its branch, locally or in Weave's copy of
// origin.
async function changeMissing(id: string, mainRoot: string, localIds: Set<string>, repos: RepoRefs[]): Promise<boolean> {
  if (localIds.has(id)) return false;
  if (await pathExists(path.join(mainRoot, "wiki", "changes", id))) return false;
  for (const repo of repos) {
    for (const ref of [`refs/heads/change/${id}`, `${weaveRemoteRefPrefix}change/${id}`]) {
      if (await resolveCommit(repo.path, ref)) return false;
    }
  }
  return true;
}

// Deletes one change's review refs in one repo, in a single `update-ref --stdin` transaction so a
// repo is either fully pruned or untouched. Every ref is checked to sit under the change's own
// prefix first, so nothing else in `refs/weave/` can be removed.
async function deleteChangeRefs(repoPath: string, id: string, refs: string[]): Promise<{ deleted: number; error?: string }> {
  const prefix = `${reviewRefPrefix}/${id}/`;
  const owned = refs.filter((ref) => ref.startsWith(prefix));
  if (owned.length === 0) return { deleted: 0 };
  const outcome = await gitWithInput(repoPath, ["update-ref", "--stdin"], owned.map((ref) => `delete ${ref}\n`).join(""));
  return outcome.ok ? { deleted: owned.length } : { deleted: 0, error: outcome.stderr || "git update-ref --stdin failed" };
}

function gitWithInput(cwd: string, args: string[], input: string): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ ok: false, stderr: error.message }));
    child.on("close", (code) => resolve({ ok: code === 0, stderr: stderr.trim() }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

// The folders a change's packages can live in: its change folder, and the main checkout for
// changes reviewed in place.
function packageDirs(id: string, mainRoot: string, facts: ChangeFacts | undefined): string[] {
  const checkouts = new Set<string>([mainRoot]);
  if (facts?.folder && facts.folderExists) checkouts.add(facts.folder);
  return [...checkouts].map((checkout) => path.join(checkout, ".weave", "tmp", "reviews", id));
}

async function deletePackages(dirs: string[]): Promise<boolean> {
  let deleted = false;
  for (const dir of dirs) {
    if (!(await pathExists(dir))) continue;
    await rm(dir, { recursive: true, force: true });
    deleted = true;
  }
  return deleted;
}

export async function pruneReviews(rootPath: string, options: PruneOptions = {}): Promise<PruneResult> {
  const mainRoot = await resolveMainRoot(rootPath);
  const metadata = (await readWorkspaceMetadata(mainRoot)) ?? (await readWorkspaceMetadata(rootPath));
  if (!metadata) {
    throw new ChangeCommandError("no_weave_context", "No Weave context found. Run `weave init` first.");
  }
  const result: PruneResult = { status: "ok", pruned: [], kept: [] };

  // 1. Candidates: change ids with review refs in any registered repo.
  const sources = await repoSources(mainRoot, metadata);
  const repos: RepoRefs[] = [];
  for (const source of sources) {
    if (await pathExists(path.join(source.source, ".git"))) repos.push({ id: source.id, path: source.source });
  }
  const scope = options.change ? `${reviewRefPrefix}/${options.change}/` : `${reviewRefPrefix}/`;
  const refsByChange = new Map<string, Map<string, string[]>>();
  for (const repo of repos) {
    const listed = await runGit(["for-each-ref", "--format=%(refname)", scope], repo.path);
    if (!listed.ok) {
      result.kept.push({ change: options.change ?? "*", reason: "error", repo: repo.id, message: listed.stderr || "git for-each-ref failed" });
      continue;
    }
    for (const ref of listed.stdout.split("\n").filter(Boolean)) {
      const id = refChangeId(ref);
      if (!id || (options.change && id !== options.change)) continue;
      const perRepo = refsByChange.get(id) ?? new Map<string, string[]>();
      perRepo.set(repo.id, [...(perRepo.get(repo.id) ?? []), ref]);
      refsByChange.set(id, perRepo);
    }
  }
  if (refsByChange.size === 0) return result;

  // 2. Classify each candidate: landed, missing, or kept with its landed result.
  const gathered = options.facts ?? (await gatherFacts(mainRoot, { remote: (await readRemoteFacts(mainRoot)).facts }));
  const factsById = new Map(gathered.changes.map((change) => [change.facts.id, change.facts]));
  const localIds = new Set(await listLocalChangeIds(await localStateDir(mainRoot)));
  const repoPaths = new Map(repos.map((repo) => [repo.id, repo.path]));

  for (const id of [...refsByChange.keys()].sort()) {
    const facts = factsById.get(id);
    const landed = facts ? changeLandedResult(facts) : undefined;
    let reason: PruneReason;
    if (landed === "landed") {
      reason = "landed";
    } else if (await changeMissing(id, mainRoot, localIds, repos)) {
      reason = "missing";
    } else {
      // Without facts the change still exists here but has nothing Weave can measure.
      result.kept.push({ change: id, reason: landed ?? "unchecked" });
      continue;
    }

    // 3. Delete refs per repo, continuing past a repo that fails, then the packages.
    const refsDeleted: Record<string, number> = {};
    let failed = false;
    for (const [repoId, refs] of refsByChange.get(id)!) {
      const outcome = await deleteChangeRefs(repoPaths.get(repoId)!, id, refs);
      if (outcome.deleted > 0) refsDeleted[repoId] = outcome.deleted;
      if (outcome.error) {
        failed = true;
        result.kept.push({ change: id, reason: "error", repo: repoId, message: outcome.error });
      }
    }
    // Packages go only once every ref is gone, so a partly pruned change keeps its packages.
    const packagesDeleted = failed ? false : await deletePackages(packageDirs(id, mainRoot, facts));
    if (Object.keys(refsDeleted).length > 0 || packagesDeleted) {
      result.pruned.push({ change: id, reason, refs_deleted: refsDeleted, packages_deleted: packagesDeleted });
    }
  }
  return result;
}
