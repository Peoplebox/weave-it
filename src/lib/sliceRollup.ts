import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { ChangeCommandError } from "./changes.js";
import { pathExists } from "./files.js";
import { findGitRoot } from "./git.js";
import { withChangeLock, writeFileAtomic } from "./local-state.js";
import { isReadyForReview, satisfiesDependents, type StoredSliceState } from "./review/rules.js";
import { adoptChange, reviewActivation, reviewContextForChangePath, sanitizeSliceReview } from "./review/state.js";

const execFileAsync = promisify(execFile);

export type SliceStatus = "pending" | "in_progress" | "done";
export type TaskStatus = "todo" | "in_progress" | "done" | "not_tested" | "blocked" | "invalid";

export interface ParsedSliceTasks {
  total: number;
  done: number;
  blocked: number;
  statuses: TaskStatus[];
  repos: string[];
  parsed: boolean;
}

export interface SliceMetadata {
  id: string;
  title: string;
  status: SliceStatus;
  owner: string;
  repos: string[];
  depends_on: string[];
  task_summary: { total: number; done: number; blocked: number };
  created_at?: string;
  updated_at: string;
  version: number;
  // The slice's `review:` block, carried through unchanged. Only `weave review` writes it.
  review?: unknown;
}

export interface RollupSliceResult {
  sliceId: string;
  slicePath: string;
  statusPath: string;
  changed: boolean;
  metadata: SliceMetadata;
  // Every active task is `done` or `not_tested`, even while `status` stays `in_progress`.
  ready_for_review: boolean;
}

export interface RollupChangeResult {
  status: "ok" | "check_failed";
  changePath: string;
  slices: RollupSliceResult[];
  dependencyGraphPath?: string;
  dependencyGraphChanged: boolean;
  cycleWarning?: string;
  // Pending slices whose dependencies all let dependents start (reviewed too, when review is active).
  ready_slices: string[];
  message: string;
}

export interface DependencyGraphOptions {
  // Ids of slices that let their dependents start. Defaults to the slices whose status is `done`.
  satisfied?: ReadonlySet<string>;
  // Adds a line explaining that dependencies must also be reviewed.
  reviewActive?: boolean;
}

export function parseSliceTasksMarkdown(content: string): ParsedSliceTasks {
  const indexRows = [...content.matchAll(/^\| (T\d+) \| ([^|]+) \|/gm)];
  const detailStatuses = [...content.matchAll(/^Status:\s*(\S+)/gm)];

  if (indexRows.length === 0 && detailStatuses.length === 0) {
    return { total: 0, done: 0, blocked: 0, statuses: [], repos: [], parsed: false };
  }

  const indexStatuses = indexRows
    .map((row) => normalizeTaskStatus(row[2].trim()))
    .filter((status): status is TaskStatus => status !== null);

  const statuses =
    indexStatuses.length > 0
      ? indexStatuses
      : detailStatuses
          .map((row) => normalizeTaskStatus(row[1].trim()))
          .filter((status): status is TaskStatus => status !== null);

  if (statuses.length === 0) {
    return { total: 0, done: 0, blocked: 0, statuses: [], repos: [], parsed: false };
  }

  const activeStatuses = statuses.filter((status) => status !== "invalid");
  const repos = parseReposFromTasks(content);

  return {
    total: activeStatuses.length,
    done: activeStatuses.filter((status) => status === "done").length,
    blocked: activeStatuses.filter((status) => status === "blocked").length,
    statuses: activeStatuses,
    repos,
    parsed: true,
  };
}

export function deriveSliceStatus(statuses: TaskStatus[]): SliceStatus {
  const active = statuses.filter((status) => status !== "invalid");
  if (active.length === 0) {
    return "pending";
  }
  if (active.every((status) => status === "done")) {
    return "done";
  }
  if (active.some((status) => status === "in_progress" || status === "done")) {
    return "in_progress";
  }
  return "pending";
}

export function detectDependencyCycles(slices: SliceMetadata[]): string[] | null {
  const graph = new Map<string, string[]>();
  for (const slice of slices) {
    graph.set(slice.id, slice.depends_on ?? []);
  }

  const visited = new Set<string>();
  const stack = new Set<string>();
  const cycles: string[][] = [];

  function dfs(node: string, pathNodes: string[]): void {
    if (stack.has(node)) {
      const cycleStart = pathNodes.indexOf(node);
      if (cycleStart >= 0) {
        cycles.push([...pathNodes.slice(cycleStart), node]);
      }
      return;
    }
    if (visited.has(node)) {
      return;
    }
    visited.add(node);
    stack.add(node);
    const deps = graph.get(node) ?? [];
    for (const dep of deps) {
      dfs(dep, [...pathNodes, node]);
    }
    stack.delete(node);
  }

  for (const id of graph.keys()) {
    dfs(id, []);
  }

  if (cycles.length === 0) {
    return null;
  }

  return cycles.map((cycle) => cycle.join(" → "));
}

export function renderDependencyGraph(slices: SliceMetadata[], generatedAt: Date, options: DependencyGraphOptions = {}): string {
  const satisfied = options.satisfied ?? doneSliceIds(slices);
  const lines: string[] = [
    `<!-- AUTO-GENERATED by weave slice rollup. Do not edit by hand.`,
    `     Source of truth: per-slice status.yml.`,
    `     Generated at: ${generatedAt.toISOString()} -->`,
    "",
    "# Dependency Graph",
    "",
    "## Purpose",
    "",
    "Execution order of vertical slices for this change. A slice can start only when",
    "all slices listed in its `depends_on` are `done`.",
    ...(options.reviewActive ? ["With code review on, each of those slices must also be reviewed."] : []),
    "",
    "## Graph",
    "",
    "```text",
    ...renderAsciiGraph(slices),
    "```",
    "",
    "## Slice dependencies",
    "",
    "| Slice | Depends on | Status | Owner |",
    "| --- | --- | --- | --- |",
    ...slices.map((slice) => {
      const deps = slice.depends_on.length > 0 ? slice.depends_on.join(", ") : "none";
      const displayStatus = renderSliceDisplayStatus(slice, satisfied);
      const owner = slice.owner?.trim() || "";
      return `| ${slice.id} | ${deps} | ${displayStatus} | ${owner} |`;
    }),
    "",
    "## Ready to work now",
    "",
    ...renderReadySlices(slices, satisfied),
    "",
    "## Blocked slices",
    "",
    ...renderBlockedSlices(slices, satisfied),
    "",
    "## Critical path",
    "",
    renderCriticalPath(slices),
    "",
    "## Parallel work",
    "",
    renderParallelWork(slices, satisfied),
    "",
  ];

  return lines.join("\n");
}

export function renderCycleWarning(cycles: string[], generatedAt: Date): string {
  return [
    `<!-- AUTO-GENERATED by weave slice rollup. Do not edit by hand.`,
    `     Source of truth: per-slice status.yml.`,
    `     Generated at: ${generatedAt.toISOString()} -->`,
    "",
    "# Dependency Graph",
    "",
    "## WARNING: dependency cycle detected",
    "",
    "The following slices form a dependency cycle. Resolve before the graph can be regenerated:",
    "",
    ...cycles.map((cycle) => `- ${cycle}`),
    "",
  ].join("\n");
}

export async function rollupSlice(
  slicePath: string,
  now: Date = new Date(),
  options: { check?: boolean } = {},
): Promise<RollupSliceResult> {
  const tasksPath = path.join(slicePath, "tasks.md");
  const statusPath = path.join(slicePath, "status.yml");

  if (!(await pathExists(tasksPath)) || !(await pathExists(statusPath))) {
    throw new ChangeCommandError("slice_missing_files", `Slice folder missing tasks.md or status.yml: ${slicePath}`, {
      slicePath,
    });
  }

  const roll = async (): Promise<RollupSliceResult> => {
    // Read inside the lock so a concurrent review write is never overwritten.
    const existing = await readSliceStatus(statusPath);
    const tasksContent = await readFile(tasksPath, "utf8");
    const parsed = parseSliceTasksMarkdown(tasksContent);

    const next: SliceMetadata = {
      ...existing,
      id: existing.id || path.basename(slicePath),
      title: existing.title || path.basename(slicePath),
      owner: existing.owner ?? "",
      depends_on: existing.depends_on ?? [],
      version: existing.version ?? 1,
      updated_at: now.toISOString(),
      status: existing.status,
      repos: existing.repos ?? [],
      task_summary: existing.task_summary ?? { total: 0, done: 0, blocked: 0 },
    };

    if (parsed.parsed) {
      next.task_summary = { total: parsed.total, done: parsed.done, blocked: parsed.blocked };
      next.status = deriveSliceStatus(parsed.statuses);
      if (parsed.repos.length > 0) {
        next.repos = uniqueStrings([...next.repos, ...parsed.repos]);
      }
    }

    // `updated_at` moves only when something else changed, so an unchanged slice is not rewritten.
    const previousYaml = await readFile(statusPath, "utf8");
    const changed = normalizeYaml(previousYaml, ["updated_at"]) !== normalizeYaml(YAML.stringify(next), ["updated_at"]);
    if (!changed) {
      next.updated_at = existing.updated_at;
    }

    if (changed && !options.check) {
      await writeFileAtomic(statusPath, YAML.stringify(next));
    }

    return {
      sliceId: next.id,
      slicePath,
      statusPath,
      changed,
      metadata: next,
      ready_for_review: isReadyForReview(effectiveTaskStatuses(parsed, next)),
    };
  };

  if (options.check) {
    return roll();
  }
  const changePath = path.dirname(path.dirname(slicePath));
  return withChangeLock(changePath, path.basename(changePath), roll);
}

export async function rollupChange(options: {
  changePath: string;
  slicePath?: string;
  check?: boolean;
  now?: Date;
  // The Weave root holding `.weave/`. Derived from a `<root>/wiki/changes/<id>` change path when absent.
  weaveRoot?: string;
}): Promise<RollupChangeResult> {
  const now = options.now ?? new Date();
  const taskSlicesRoot = path.join(options.changePath, "task-slices");

  if (!(await pathExists(taskSlicesRoot))) {
    throw new ChangeCommandError("task_slices_missing", `No task-slices/ folder found under ${options.changePath}`, {
      changePath: options.changePath,
    });
  }

  const sliceDirs = await listSliceDirs(taskSlicesRoot);
  if (sliceDirs.length === 0) {
    throw new ChangeCommandError("no_slices", `No slice folders found under ${taskSlicesRoot}`, {
      changePath: options.changePath,
    });
  }

  const targets = options.slicePath
    ? sliceDirs.filter((dir) => dir === options.slicePath || path.basename(dir) === options.slicePath)
    : sliceDirs;

  if (targets.length === 0) {
    throw new ChangeCommandError("slice_not_found", `No matching slice folder: ${options.slicePath}`, {
      slicePath: options.slicePath,
      available: sliceDirs.map((dir) => path.basename(dir)),
    });
  }

  // Review gating applies only when review is active for this change. The first rollup with
  // review active adopts the change (the only review write rollup triggers); a check never writes.
  const reviewContext = options.weaveRoot
    ? { weaveRoot: options.weaveRoot, changeId: path.basename(options.changePath), changePath: options.changePath }
    : reviewContextForChangePath(options.changePath);
  const activation = reviewContext ? await reviewActivation(reviewContext) : undefined;
  const reviewActive = activation?.active ?? false;
  if (reviewContext && activation && reviewActive && !options.check) {
    await adoptChange(reviewContext, { now, activation });
  }

  const sliceResults: RollupSliceResult[] = [];
  for (const sliceDir of targets) {
    sliceResults.push(await rollupSlice(sliceDir, now, { check: options.check }));
  }

  const views = await readSliceViews(sliceDirs, sliceResults);
  const satisfied = new Set(
    views
      .filter((view) =>
        satisfiesDependents(
          { statuses: view.statuses, sliceStatus: view.metadata.status, reviewState: view.reviewState },
          reviewActive,
        ),
      )
      .map((view) => view.metadata.id),
  );
  const readySlices = views
    .filter((view) => renderSliceDisplayStatus(view.metadata, satisfied) === "ready")
    .map((view) => view.metadata.id);

  let dependencyGraphPath: string | undefined;
  let dependencyGraphChanged = false;
  let cycleWarning: string | undefined;

  if (!options.slicePath && sliceDirs.length >= 2) {
    const allMetadata = views.map((view) => view.metadata);

    dependencyGraphPath = path.join(taskSlicesRoot, "dependency-graph.md");
    const cycles = detectDependencyCycles(allMetadata);
    const nextGraph = cycles
      ? renderCycleWarning(cycles, now)
      : renderDependencyGraph(allMetadata, now, { satisfied, reviewActive });

    if (cycles) {
      cycleWarning = cycles.join("; ");
    }

    const previousGraph = (await pathExists(dependencyGraphPath))
      ? await readFile(dependencyGraphPath, "utf8")
      : "";
    // The generation time alone is not a change.
    dependencyGraphChanged = withoutGeneratedAt(previousGraph) !== withoutGeneratedAt(nextGraph);

    if (!options.check && dependencyGraphChanged) {
      await writeFileAtomic(dependencyGraphPath, nextGraph);
    }
  }

  const anyChanged = sliceResults.some((result) => result.changed) || dependencyGraphChanged;

  if (!options.check && anyChanged) {
    const gitRoot = await findGitRoot(options.changePath);
    if (gitRoot) {
      const filesToStage = [
        ...sliceResults.filter((result) => result.changed).map((result) => result.statusPath),
        ...(dependencyGraphChanged && dependencyGraphPath ? [dependencyGraphPath] : []),
      ];
      await stageFiles(gitRoot, filesToStage);
    }
  }

  return {
    status: options.check && anyChanged ? "check_failed" : "ok",
    changePath: options.changePath,
    slices: sliceResults,
    dependencyGraphPath,
    dependencyGraphChanged,
    cycleWarning,
    ready_slices: readySlices,
    message: options.check && anyChanged
      ? "Derived slice state is stale; run `weave slice rollup` to update."
      : `Rolled up ${sliceResults.length} slice(s).`,
  };
}

async function readSliceStatus(statusPath: string): Promise<SliceMetadata> {
  const parsed = YAML.parse(await readFile(statusPath, "utf8")) as Record<string, unknown>;
  return {
    version: typeof parsed.version === "number" ? parsed.version : 1,
    id: typeof parsed.id === "string" ? parsed.id : "",
    title: typeof parsed.title === "string" ? parsed.title : "",
    status: isSliceStatus(parsed.status) ? parsed.status : "pending",
    owner: typeof parsed.owner === "string" ? parsed.owner : "",
    repos: Array.isArray(parsed.repos) ? parsed.repos.filter((v): v is string => typeof v === "string") : [],
    depends_on: Array.isArray(parsed.depends_on)
      ? parsed.depends_on.filter((v): v is string => typeof v === "string")
      : [],
    task_summary: parseTaskSummary(parsed.task_summary),
    created_at: typeof parsed.created_at === "string" ? parsed.created_at : undefined,
    updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : new Date().toISOString(),
    ...("review" in parsed ? { review: parsed.review } : {}),
  };
}

interface SliceView {
  metadata: SliceMetadata;
  statuses: TaskStatus[];
  reviewState?: StoredSliceState;
}

// Every slice with a status.yml, using the freshly rolled metadata where there is one.
async function readSliceViews(sliceDirs: string[], rolled: RollupSliceResult[]): Promise<SliceView[]> {
  const views: SliceView[] = [];
  for (const sliceDir of sliceDirs) {
    const statusPath = path.join(sliceDir, "status.yml");
    const fresh = rolled.find((result) => result.slicePath === sliceDir);
    if (!fresh && !(await pathExists(statusPath))) {
      continue;
    }
    const metadata = fresh?.metadata ?? (await readSliceStatus(statusPath));
    const tasksPath = path.join(sliceDir, "tasks.md");
    const parsed = (await pathExists(tasksPath))
      ? parseSliceTasksMarkdown(await readFile(tasksPath, "utf8"))
      : parseSliceTasksMarkdown("");
    views.push({
      metadata,
      statuses: effectiveTaskStatuses(parsed, metadata),
      reviewState: sanitizeSliceReview(metadata.review)?.state,
    });
  }
  return views;
}

// Task statuses for readiness. When tasks.md does not parse, the stored slice status stands in:
// a `done` slice counts as ready for review, anything else as not ready.
function effectiveTaskStatuses(parsed: ParsedSliceTasks, metadata: SliceMetadata): TaskStatus[] {
  if (parsed.parsed) {
    return parsed.statuses;
  }
  return metadata.status === "done" ? ["done"] : [];
}

function parseTaskSummary(value: unknown): { total: number; done: number; blocked: number } {
  if (!value || typeof value !== "object") {
    return { total: 0, done: 0, blocked: 0 };
  }
  const summary = value as Record<string, unknown>;
  return {
    total: typeof summary.total === "number" ? summary.total : 0,
    done: typeof summary.done === "number" ? summary.done : 0,
    blocked: typeof summary.blocked === "number" ? summary.blocked : 0,
  };
}

async function listSliceDirs(taskSlicesRoot: string): Promise<string[]> {
  const entries = await readdir(taskSlicesRoot, { withFileTypes: true });
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const slicePath = path.join(taskSlicesRoot, entry.name);
    if ((await pathExists(path.join(slicePath, "status.yml"))) || (await pathExists(path.join(slicePath, "tasks.md")))) {
      dirs.push(slicePath);
    }
  }
  return dirs.sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
}

function normalizeTaskStatus(value: string): TaskStatus | null {
  const normalized = value.toLowerCase();
  if (
    normalized === "todo" ||
    normalized === "in_progress" ||
    normalized === "done" ||
    normalized === "not_tested" ||
    normalized === "blocked" ||
    normalized === "invalid"
  ) {
    return normalized;
  }
  return null;
}

function isSliceStatus(value: unknown): value is SliceStatus {
  return value === "pending" || value === "in_progress" || value === "done";
}

function parseReposFromTasks(content: string): string[] {
  const repos: string[] = [];
  for (const match of content.matchAll(/^Repos:\s*(.+)$/gm)) {
    repos.push(
      ...match[1]
        .split(",")
        .map((part) => part.trim().replace(/^`+|`+$/g, ""))
        .filter((part) => part.length > 0 && part.toLowerCase() !== "none"),
    );
  }
  return uniqueStrings(repos);
}

function doneSliceIds(slices: SliceMetadata[]): Set<string> {
  return new Set(slices.filter((slice) => slice.status === "done").map((slice) => slice.id));
}

function renderSliceDisplayStatus(slice: SliceMetadata, satisfied: ReadonlySet<string>): string {
  if (slice.status !== "pending") {
    return slice.status;
  }
  const deps = slice.depends_on ?? [];
  if (deps.length === 0) {
    return "ready";
  }
  return deps.every((dep) => satisfied.has(dep)) ? "ready" : "blocked";
}

function renderReadySlices(slices: SliceMetadata[], satisfied: ReadonlySet<string>): string[] {
  const ready = slices.filter((slice) => renderSliceDisplayStatus(slice, satisfied) === "ready");
  if (ready.length === 0) {
    return ["None."];
  }
  return ready.map((slice) => `- ${slice.id}`);
}

function renderBlockedSlices(slices: SliceMetadata[], satisfied: ReadonlySet<string>): string[] {
  const blocked = slices.filter((slice) => renderSliceDisplayStatus(slice, satisfied) === "blocked");
  if (blocked.length === 0) {
    return ["None."];
  }
  const lines: string[] = [];
  for (const slice of blocked) {
    lines.push(`### ${slice.id}`, "", "Blocked by:", "");
    for (const dep of slice.depends_on) {
      if (!satisfied.has(dep)) {
        lines.push(`- ${dep}`);
      }
    }
    lines.push("");
  }
  return lines;
}

function renderCriticalPath(slices: SliceMetadata[]): string {
  const byId = new Map(slices.map((slice) => [slice.id, slice]));
  let longest: string[] = [];

  function walk(id: string, pathNodes: string[], visited: Set<string>): void {
    if (visited.has(id)) {
      return;
    }
    const nextPath = [...pathNodes, id];
    const slice = byId.get(id);
    const deps = slice?.depends_on ?? [];
    if (deps.length === 0) {
      if (nextPath.length > longest.length) {
        longest = nextPath;
      }
      return;
    }
    const nextVisited = new Set(visited);
    nextVisited.add(id);
    for (const dep of deps) {
      walk(dep, nextPath, nextVisited);
    }
  }

  for (const slice of slices) {
    walk(slice.id, [], new Set());
  }

  if (longest.length === 0) {
    return "None.";
  }
  return longest.join(" → ");
}

function renderParallelWork(slices: SliceMetadata[], satisfied: ReadonlySet<string>): string {
  const ready = slices.filter((slice) => renderSliceDisplayStatus(slice, satisfied) === "ready");
  if (ready.length >= 2) {
    return [
      "These slices can be worked in parallel:",
      "",
      ...ready.map((slice) => `- ${slice.id}`),
    ].join("\n");
  }
  return "No parallel work identified from current slice states.";
}

function renderAsciiGraph(slices: SliceMetadata[]): string[] {
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  const ids = new Set(slices.map((slice) => slice.id));

  for (const slice of slices) {
    const deps = (slice.depends_on ?? []).filter((dep) => ids.has(dep));
    if (deps.length === 0) {
      roots.push(slice.id);
      continue;
    }
    for (const dep of deps) {
      const list = children.get(dep) ?? [];
      list.push(slice.id);
      children.set(dep, list);
    }
  }

  const lines: string[] = [];
  const visited = new Set<string>();

  function renderNode(id: string, prefix: string, isLast: boolean): void {
    const connector = prefix.length === 0 ? "" : isLast ? "└── " : "├── ";
    lines.push(`${prefix}${connector}${id}`);
    const nextPrefix = prefix.length === 0 ? "" : `${prefix}${isLast ? "    " : "│   "}`;
    const kids = (children.get(id) ?? []).filter((child) => !visited.has(`${id}->${child}`));
    kids.forEach((child, index) => {
      visited.add(`${id}->${child}`);
      renderNode(child, nextPrefix, index === kids.length - 1);
    });
  }

  roots.sort().forEach((root, index) => renderNode(root, "", index === roots.length - 1));
  if (lines.length === 0) {
    return slices.map((slice) => slice.id);
  }
  return lines;
}

async function stageFiles(gitRoot: string, absolutePaths: string[]): Promise<void> {
  const relativePaths = absolutePaths.map((filePath) => path.relative(gitRoot, filePath)).filter((p) => p.length > 0);
  if (relativePaths.length === 0) {
    return;
  }
  try {
    await execFileAsync("git", ["add", ...relativePaths], { cwd: gitRoot });
  } catch {
    // Best-effort staging; rollup still succeeds if git is unavailable.
  }
}

function normalizeYaml(content: string, ignoredKeys: string[] = []): string {
  const parsed = YAML.parse(content) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && ignoredKeys.length > 0) {
    const copy = { ...(parsed as Record<string, unknown>) };
    for (const key of ignoredKeys) {
      delete copy[key];
    }
    return YAML.stringify(copy);
  }
  return YAML.stringify(parsed);
}

function withoutGeneratedAt(graph: string): string {
  return graph.replace(/^ {5}Generated at: .*$/m, "");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
