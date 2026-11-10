// Build commits (decisions 261111-htho, 261111-kx9x): when a slice is ready for review and its
// coverage (active task ids and statuses) differs from every build commit recorded for it, the
// next `weave slice rollup` commits everything in the slice's repos with the project's hooks.
//
// Build state lives in git, as commit trailers (`Weave-Slice`, `Weave-Coverage`, `Weave-Includes`),
// never in slice status.yml. A slice whose build commit failed is retried at each rollup until
// another slice starts building; then that slice's build commit carries the leftovers.
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { pathExists } from "./files.js";
import {
  applySubjectTemplate,
  codeCommit,
  codeExcludes,
  committedCoverage,
  composeMessage,
  isUnattended,
  resolveCommitSettings,
  type CheckpointChange,
  type CheckpointOutcome,
} from "./checkpoints.js";
import { resolveDiffBase } from "./review/base.js";
import type { RollupChangeResult } from "./sliceRollup.js";
import { readWorkspaceMetadata } from "./workspace-repos.js";
import { mainCheckoutPath, rootRepoId } from "./worktrees.js";

export interface SliceTaskRow {
  id: string;
  status: string;
  title: string;
}

export function parseTaskRows(tasksMd: string): SliceTaskRow[] {
  const rows: SliceTaskRow[] = [];
  for (const match of tasksMd.matchAll(/^\| (T\d+) \|([^\n]*)$/gm)) {
    const cells = (match[2] ?? "").split("|").map((cell) => cell.trim());
    // | ID | Status | Execution | Repos | Owner | Title | Blocked by |
    rows.push({ id: match[1] ?? "", status: cells[0] ?? "", title: cells[4] ?? "" });
  }
  return rows;
}

// A short hash of the slice's active tasks and their statuses.
export function sliceCoverage(rows: SliceTaskRow[]): string {
  const active = rows.filter((row) => row.status !== "invalid").map((row) => `${row.id}:${row.status}`).sort();
  return createHash("sha256").update(active.join("\n")).digest("hex").slice(0, 12);
}

interface SliceFacts {
  id: string;
  path: string;
  title: string;
  status: string;
  ready: boolean;
  repos: string[];
  rows: SliceTaskRow[];
  coverage: string;
  goal?: string;
  tasksMtime: number;
}

async function sliceFacts(rollup: RollupChangeResult): Promise<SliceFacts[]> {
  const facts: SliceFacts[] = [];
  for (const slice of rollup.slices) {
    const tasksPath = path.join(slice.slicePath, "tasks.md");
    const tasksMd = (await pathExists(tasksPath)) ? await readFile(tasksPath, "utf8") : "";
    const rows = parseTaskRows(tasksMd);
    const sliceMd = path.join(slice.slicePath, "slice.md");
    const sliceText = (await pathExists(sliceMd)) ? await readFile(sliceMd, "utf8") : "";
    const heading = /^#\s+(.+)$/m.exec(sliceText)?.[1]?.trim();
    const goal = /^## Outcome\s*\n+([\s\S]*?)(?:\n## |\s*$)/m.exec(sliceText)?.[1]?.trim();
    facts.push({
      id: slice.sliceId,
      path: slice.slicePath,
      title: slice.metadata.title && slice.metadata.title !== slice.sliceId ? slice.metadata.title : heading ?? slice.sliceId,
      status: slice.metadata.status,
      ready: slice.ready_for_review,
      repos: slice.metadata.repos.length > 0 ? slice.metadata.repos : [rootRepoId],
      rows,
      coverage: sliceCoverage(rows),
      ...(goal ? { goal } : {}),
      tasksMtime: (await stat(tasksPath).catch(() => undefined))?.mtimeMs ?? 0,
    });
  }
  return facts;
}

async function repoPaths(weaveRoot: string, ids: string[]): Promise<Array<{ id: string; path?: string }>> {
  const metadata = await readWorkspaceMetadata(weaveRoot);
  return ids.map((id) => {
    const entry = metadata?.repos[id];
    const candidate = id === rootRepoId ? weaveRoot : entry ? path.join(weaveRoot, entry.path) : undefined;
    return { id, ...(candidate ? { path: candidate } : {}) };
  });
}

async function changeStatus(changePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = YAML.parse(await readFile(path.join(changePath, "status.yml"), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export interface BuildCheckpointInput extends CheckpointChange {
  rollup: RollupChangeResult;
  env?: NodeJS.ProcessEnv;
}

// Makes the build commit that is due, if any. Returns one outcome per repo committed to (empty
// when nothing is due or commits are off).
export async function buildCheckpoints(input: BuildCheckpointInput): Promise<CheckpointOutcome[]> {
  const env = input.env ?? process.env;
  const settings = await resolveCommitSettings(input, env);
  if (!settings.enabled) return [];
  const slices = await sliceFacts(input.rollup);
  const allRepos = await repoPaths(input.weaveRoot, [...new Set(slices.flatMap((slice) => slice.repos))]);
  const committed = new Map<string, Set<string>>();
  for (const repo of allRepos) {
    if (!repo.path) continue;
    for (const [slice, coverages] of (await committedCoverage(repo.path, input.changeId, env)).slices) {
      const set = committed.get(slice) ?? new Set<string>();
      for (const coverage of coverages) set.add(coverage);
      committed.set(slice, set);
    }
  }
  const due = slices.filter((slice) => slice.ready && !(committed.get(slice.id)?.has(slice.coverage) ?? false));
  if (due.length === 0) return [];
  // Another slice is being built: the due slices' leftovers go into its build commit later.
  if (slices.some((slice) => !slice.ready && slice.status === "in_progress" && !due.includes(slice))) return [];
  if (isUnattended(env)) {
    return due.map((slice) => ({ status: "skipped", kind: "build", slice: slice.id, reason: "unattended" }));
  }
  // The most recently finished slice owns the commit; any others are its leftovers.
  const [primary, ...included] = [...due].sort((a, b) => b.tasksMtime - a.tasksMtime);
  if (!primary) return [];
  const refinish = (committed.get(primary.id)?.size ?? 0) > 0;
  const repoIds = [...new Set([primary, ...included].flatMap((slice) => slice.repos))];
  const repos = await repoPaths(input.weaveRoot, repoIds);
  const mainRoot = await mainCheckoutPath(input.weaveRoot).catch(() => input.weaveRoot);
  const status = await changeStatus(input.changePath);

  const subjectText = `${primary.title}${refinish ? " (additional work)" : ""}`;
  const subject = applySubjectTemplate(settings.subjectTemplate, "build", { subject: subjectText, slice: primary.id, change: input.changeId });
  const finishedTasks = primary.rows.filter((row) => row.status === "done" || row.status === "not_tested");
  const body = [
    primary.goal ?? "",
    finishedTasks.length > 0 ? `Tasks:\n${finishedTasks.map((row) => `- ${row.id}: ${row.title}${row.status === "not_tested" ? " (not tested)" : ""}`).join("\n")}` : "",
    included.length > 0 ? `Also includes uncommitted work from ${included.map((slice) => `slice ${slice.id}`).join(", ")}.` : "",
  ];
  const outcomes: CheckpointOutcome[] = [];
  for (const repo of repos) {
    if (!repo.path) {
      outcomes.push({ status: "skipped", kind: "build", repo: repo.id, slice: primary.id, reason: "not_a_git_repo" });
      continue;
    }
    const base = await resolveDiffBase({ repoPath: repo.path, repoId: repo.id, changeStatus: status, mainRoot }).catch(() => undefined);
    const trailers: Array<[string, string]> = [
      ["Weave-Change", input.changeId],
      ["Weave-Slice", primary.id],
      ["Weave-Coverage", primary.coverage],
      ...included.map((slice): [string, string] => ["Weave-Includes", `${slice.id}:${slice.coverage}`]),
      ...(base?.sha ? ([["Weave-Merge-Base", base.sha]] as Array<[string, string]>) : []),
      ["Weave-Checkpoint", "build"],
    ];
    const outcome = await codeCommit({
      repoId: repo.id,
      repoPath: repo.path,
      branch: input.branch,
      kind: "build",
      slice: primary.id,
      subject,
      message: composeMessage(subject, body, trailers),
      excludes: await codeExcludes(repo.path, input.changeId),
      timeoutMs: settings.codeTimeoutSeconds * 1000,
      env,
    });
    outcomes.push(included.length > 0 ? { ...outcome, leftovers_from: included.map((slice) => slice.id).join(", ") } : outcome);
  }
  return outcomes;
}
