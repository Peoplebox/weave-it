import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { pathExists } from "./files.js";
import { runGit } from "./git.js";
import { localStateDir, withStateLock, writeFileAtomic } from "./local-state.js";

// Where a change's starting branch came from:
// - created: Weave recorded it when it made the branch (or read it from the folder's status.yml)
// - reflog: recovered from the branch's creation entry in the reflog
// - unknown: no usable starting branch; the landed check falls back to the default branch
export type BaseSource = "created" | "reflog" | "unknown";

export interface BaseRepoRecord {
  base: string | null;
  base_commit: string | null;
  source: BaseSource;
}

export interface BaseRecord {
  version: 1;
  change: string;
  recorded_at: string;
  repos: Record<string, BaseRepoRecord>;
}

// `.git/weave/bases/<id>.yml` is durable: unlike `changes/<id>.yml`, Weave never deletes it,
// so closed changes are still measured against the branch they started from.
function basesFile(stateDir: string, changeId: string): string {
  return path.join(stateDir, "bases", `${changeId}.yml`);
}

export async function readBases(stateDir: string, changeId: string): Promise<BaseRecord | undefined> {
  const file = basesFile(stateDir, changeId);
  if (!(await pathExists(file))) return undefined;
  try {
    const parsed = YAML.parse(await readFile(file, "utf8")) as Partial<BaseRecord> | null;
    if (!parsed || typeof parsed.repos !== "object" || parsed.repos === null) return undefined;
    return { version: 1, change: changeId, recorded_at: parsed.recorded_at ?? "", repos: parsed.repos as Record<string, BaseRepoRecord> };
  } catch {
    return undefined;
  }
}

export async function listBaseChangeIds(stateDir: string): Promise<string[]> {
  const entries = await readdir(path.join(stateDir, "bases")).catch(() => [] as string[]);
  return entries.filter((name) => name.endsWith(".yml")).map((name) => name.slice(0, -".yml".length));
}

// Merges per-repo records into the change's bases file. A `created` record always wins;
// a recovered one never replaces an existing known record.
export async function recordBases(
  mainRoot: string,
  changeId: string,
  repos: Record<string, BaseRepoRecord>,
  now: Date = new Date(),
): Promise<void> {
  if (Object.keys(repos).length === 0) return;
  await withStateLock(mainRoot, async (stateDir) => {
    const existing = await readBases(stateDir, changeId);
    const merged: Record<string, BaseRepoRecord> = { ...(existing?.repos ?? {}) };
    for (const [repoId, record] of Object.entries(repos)) {
      const current = merged[repoId];
      if (!current || record.source === "created" || current.source === "unknown") {
        merged[repoId] = record;
      }
    }
    const next: BaseRecord = { version: 1, change: changeId, recorded_at: existing?.recorded_at || now.toISOString(), repos: merged };
    await writeFileAtomic(basesFile(stateDir, changeId), YAML.stringify(next));
  });
}

const shaPattern = /^[0-9a-f]{7,64}$/i;

// Values in a reflog "Created from <x>" entry that do not name a starting branch:
// `add_new` passes a commit sha, `checkout -b` logs HEAD, and `add_tracking` logs the
// change's own remote branch, which would measure the change against itself.
export function rejectReflogBase(value: string, changeId: string): "sha" | "head" | "self" | undefined {
  if (shaPattern.test(value)) return "sha";
  if (value === "HEAD") return "head";
  const branch = `change/${changeId}`;
  const normalized = value.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "");
  if (normalized === branch || normalized === `origin/${branch}`) return "self";
  return undefined;
}

export interface RecoverBaseOptions {
  repoPath: string;
  repoId: string;
  changeId: string;
  // The change folder's status.yml, when the folder exists.
  statusPath?: string;
}

// Recovers a starting branch for a change Weave has no record of, in order: the folder's
// status.yml checkout block, the branch's creation reflog entry, then unknown.
export async function recoverBase(options: RecoverBaseOptions): Promise<BaseRepoRecord> {
  const fromStatus = options.statusPath ? await baseFromStatus(options.statusPath, options.repoId) : undefined;
  if (fromStatus) return fromStatus;

  const reflog = await runGit(["reflog", "show", "--format=%H %gs", `refs/heads/change/${options.changeId}`], options.repoPath);
  const oldest = reflog.ok ? reflog.stdout.split("\n").filter(Boolean).at(-1) : undefined;
  const match = oldest ? /^([0-9a-f]+) branch: Created from (.+)$/.exec(oldest) : null;
  if (!match) {
    return { base: null, base_commit: null, source: "unknown" };
  }
  const [, commit, from] = match as unknown as [string, string, string];
  const rejected = rejectReflogBase(from.trim(), options.changeId);
  if (!rejected) {
    return { base: from.trim(), base_commit: commit, source: "reflog" };
  }
  // A sha or HEAD still pins the fork point, which the "no commits yet" test needs; the
  // change's own remote branch does not, since a teammate's commits come before it.
  return { base: null, base_commit: rejected === "self" ? null : commit, source: "unknown" };
}

async function baseFromStatus(statusPath: string, repoId: string): Promise<BaseRepoRecord | undefined> {
  if (!(await pathExists(statusPath))) return undefined;
  try {
    const raw = YAML.parse(await readFile(statusPath, "utf8")) as { checkout?: { repos?: Record<string, { base?: unknown; base_commit?: unknown }> } } | null;
    const entry = raw?.checkout?.repos?.[repoId];
    if (entry && typeof entry.base === "string" && entry.base) {
      return { base: entry.base, base_commit: typeof entry.base_commit === "string" ? entry.base_commit : null, source: "created" };
    }
  } catch {
    // An unreadable status.yml just means there is nothing to recover from it.
  }
  return undefined;
}

// Returns the remembered starting branch for one repo of a change, recovering and
// recording it the first time. An `unknown` record is retried only from status.yml.
export async function resolveChangeBase(options: RecoverBaseOptions & { mainRoot: string; now?: Date }): Promise<BaseRepoRecord> {
  const stateDir = await localStateDir(options.mainRoot);
  const existing = (await readBases(stateDir, options.changeId))?.repos[options.repoId];
  if (existing && existing.source !== "unknown") return existing;
  if (existing) {
    const fromStatus = options.statusPath ? await baseFromStatus(options.statusPath, options.repoId) : undefined;
    if (!fromStatus) return existing;
    await recordBases(options.mainRoot, options.changeId, { [options.repoId]: fromStatus }, options.now);
    return fromStatus;
  }
  const recovered = await recoverBase(options);
  await recordBases(options.mainRoot, options.changeId, { [options.repoId]: recovered }, options.now);
  return recovered;
}
