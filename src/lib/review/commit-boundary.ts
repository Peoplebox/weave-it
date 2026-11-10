// Commit-backed review boundaries (decision 261111-kx9x). End boundaries point at the change
// branch's build or fix commit when one describes the tree being reviewed; start boundaries and
// every fallback stay snapshots (`SnapshotBoundary`). Fix-round ends and the final fix-end make the
// fix commit first.
//
// The ref names and the `ReviewBoundary` interface are unchanged, so packages, fingerprints,
// round patches, and prune work the same over either kind.
import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { parseTaskRows, sliceCoverage } from "../build-checkpoints.js";
import {
  applySubjectTemplate,
  checkpointGit,
  codeCommit,
  codeExcludes,
  committedCoverage,
  composeMessage,
  isUnattended,
  parseTrailers,
  resolveCommitSettings,
  type CheckpointOutcome,
  type CommitSettings,
} from "../checkpoints.js";
import { pathExists } from "../files.js";
import { rootRepoId } from "../worktrees.js";
import {
  SnapshotBoundary,
  type BoundaryCreateInput,
  type BoundaryCreateResult,
  type BoundaryDiffOptions,
  type BoundaryDiffStat,
  type ReviewBoundary,
} from "./boundary.js";
import type { ReviewContext } from "./state.js";

export type BoundaryKind = "commit" | "snapshot";

export interface BoundaryRecord {
  repoPath: string;
  ref: string;
  kind: BoundaryKind;
  // Why a snapshot was used instead of a commit.
  reason?: string;
}

export interface FixContext {
  run: string;
  round: number;
  scope: "slice" | "change";
  findings: Array<{ id: string; detail?: string }>;
}

export interface CommitBoundaryOptions {
  changeId: string;
  branch: string;
  settings: CommitSettings;
  sliceId?: string;
  sliceTitle?: string;
  // The slice's build commit exists for its current coverage (always true for change runs).
  buildCommitted: boolean;
  repoIds?: Map<string, string>;
  env?: NodeJS.ProcessEnv;
}

type Point = "start" | "end" | "round-start" | "round-end" | "fix-start" | "fix-end";

function refPoint(ref: string): Point {
  if (ref.endsWith("/start")) return "start";
  if (/\/round\d+-start$/.test(ref)) return "round-start";
  if (/\/round\d+-end$/.test(ref)) return "round-end";
  if (ref.endsWith("/fix-start")) return "fix-start";
  if (ref.endsWith("/fix-end")) return "fix-end";
  return "end";
}

export class CommitBoundary implements ReviewBoundary {
  readonly records: BoundaryRecord[] = [];
  readonly checkpoints: CheckpointOutcome[] = [];
  private readonly snapshot = new SnapshotBoundary();
  private fix?: FixContext;

  constructor(private readonly options: CommitBoundaryOptions) {}

  // The fix round being packaged, so its commit can name the findings it targets.
  setFixContext(fix: FixContext): void {
    this.fix = fix;
  }

  async create(input: BoundaryCreateInput): Promise<BoundaryCreateResult> {
    const point = refPoint(input.ref);
    if (point === "start" || point === "round-start" || point === "fix-start") {
      return this.fallback(input);
    }
    if (isUnattended(this.options.env)) return this.fallback(input, "unattended");
    if (!this.options.buildCommitted) return this.fallback(input, "build_not_committed");

    if (point === "round-end" || point === "fix-end") {
      const outcome = await this.fixCommit(input, point === "fix-end" ? "final-fix" : "fix");
      if (outcome.status === "failed") return this.fallback(input, outcome.reason ?? "commit_failed");
    }
    const head = await this.headCheckpoint(input.repoPath);
    if (!head) return this.fallback(input, "head_not_checkpoint");
    if (input.mergeBase && head.mergeBase !== input.mergeBase) return this.fallback(input, "merge_base_moved");
    if (!(await this.clean(input.repoPath))) return this.fallback(input, "uncommitted_changes");
    const updated = await checkpointGit(["update-ref", input.ref, head.sha], input.repoPath, { env: this.options.env });
    if (!updated.ok) return this.fallback(input, "ref_failed");
    this.records.push({ repoPath: input.repoPath, ref: input.ref, kind: "commit" });
    return { ref: input.ref, sha: head.sha, ...(head.mergeBase ? { mergeBase: head.mergeBase } : {}), created: true };
  }

  read(repoPath: string, ref: string): Promise<{ sha: string; mergeBase?: string } | undefined> {
    return this.snapshot.read(repoPath, ref);
  }

  diff(repoPath: string, from: string, to: string, opts: BoundaryDiffOptions): Promise<string> {
    return this.snapshot.diff(repoPath, from, to, opts);
  }

  diffStat(repoPath: string, from: string, to: string, opts: BoundaryDiffOptions): Promise<BoundaryDiffStat> {
    return this.snapshot.diffStat(repoPath, from, to, opts);
  }

  patch(repoPath: string, from: string, to: string, opts: BoundaryDiffOptions): Promise<string> {
    return this.snapshot.patch(repoPath, from, to, opts);
  }

  private async fallback(input: BoundaryCreateInput, reason?: string): Promise<BoundaryCreateResult> {
    const result = await this.snapshot.create(input);
    this.records.push({ repoPath: input.repoPath, ref: input.ref, kind: "snapshot", ...(reason ? { reason } : {}) });
    return result;
  }

  // HEAD when it is one of this change's code checkpoints (build, fix, final fix) that carries a
  // merge-base, or a planning commit directly on top of one (planning commits change only
  // wiki/changes, which reviews never diff).
  private async headCheckpoint(repoPath: string): Promise<{ sha: string; mergeBase?: string } | undefined> {
    const log = await checkpointGit(["log", "--first-parent", "-n", "50", "--format=%x1e%H%x1f%B", "HEAD"], repoPath, { env: this.options.env });
    if (!log.ok) return undefined;
    const head = log.stdout.split("\x1e").find(Boolean);
    const headSha = head?.split("\x1f")[0]?.trim();
    for (const entry of log.stdout.split("\x1e").filter(Boolean)) {
      const [sha, message = ""] = entry.split("\x1f");
      const trailers = parseTrailers(message);
      if (trailers.get("Weave-Change")?.[0] !== this.options.changeId) return undefined;
      const kind = trailers.get("Weave-Checkpoint")?.[0];
      if (kind === "build" || kind === "fix" || kind === "final-fix") {
        if (!headSha) return undefined;
        const mergeBase = trailers.get("Weave-Merge-Base")?.[0];
        return { sha: headSha, ...(mergeBase ? { mergeBase } : {}) };
      }
      if (kind !== "planning" && kind !== "catch-up") return undefined;
      if (!sha) return undefined;
    }
    return undefined;
  }

  private async clean(repoPath: string): Promise<boolean> {
    const excludes = await codeExcludes(repoPath, this.options.changeId);
    const status = await checkpointGit(
      ["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude)wiki/changes", ...excludes],
      repoPath,
      { env: this.options.env },
    );
    return status.ok && status.stdout.trim().length === 0;
  }

  private async fixCommit(input: BoundaryCreateInput, kind: "fix" | "final-fix"): Promise<CheckpointOutcome> {
    const repoId = this.options.repoIds?.get(path.resolve(input.repoPath)) ?? rootRepoId;
    const fix = this.fix;
    const continued = fix ? await this.roundAlreadyCommitted(input.repoPath, fix) : false;
    const base =
      kind === "final-fix"
        ? "Final review fixes"
        : `${this.options.sliceTitle ?? this.options.sliceId ?? "Slice"}: review fixes, round ${fix?.round ?? 1}`;
    const subjectText = `${base}${continued ? " (continued)" : ""}`;
    const subject = applySubjectTemplate(this.options.settings.subjectTemplate, kind, {
      subject: subjectText,
      ...(this.options.sliceId ? { slice: this.options.sliceId } : {}),
      change: this.options.changeId,
    });
    const findings = fix?.findings ?? [];
    const body = [
      findings.length > 0
        ? `Fixes:\n${findings.map((finding) => `- ${finding.id}${finding.detail ? `: ${firstSentence(finding.detail)}` : ""}`).join("\n")}`
        : "",
    ];
    const trailers: Array<[string, string]> = [
      ["Weave-Change", this.options.changeId],
      ...(this.options.sliceId ? ([["Weave-Slice", this.options.sliceId]] as Array<[string, string]>) : []),
      ...(fix ? ([["Weave-Run", fix.run], ["Weave-Round", String(fix.round)]] as Array<[string, string]>) : []),
      ...(input.mergeBase ? ([["Weave-Merge-Base", input.mergeBase]] as Array<[string, string]>) : []),
      ["Weave-Checkpoint", kind],
    ];
    const outcome = await codeCommit({
      repoId,
      repoPath: input.repoPath,
      branch: this.options.branch,
      kind,
      ...(this.options.sliceId ? { slice: this.options.sliceId } : {}),
      subject,
      message: composeMessage(subject, body, trailers),
      excludes: await codeExcludes(input.repoPath, this.options.changeId),
      timeoutMs: this.options.settings.codeTimeoutSeconds * 1000,
      ...(this.options.env ? { env: this.options.env } : {}),
    });
    this.checkpoints.push(outcome);
    return outcome;
  }

  private async roundAlreadyCommitted(repoPath: string, fix: FixContext): Promise<boolean> {
    const log = await checkpointGit(["log", "--first-parent", "-n", "50", "--format=%x1e%B", "HEAD"], repoPath, { env: this.options.env });
    if (!log.ok) return false;
    return log.stdout.split("\x1e").some((message) => {
      const trailers = parseTrailers(message);
      return trailers.get("Weave-Change")?.[0] === this.options.changeId && trailers.get("Weave-Run")?.[0] === fix.run && trailers.get("Weave-Round")?.[0] === String(fix.round);
    });
  }
}

function firstSentence(text: string): string {
  const line = text.split("\n")[0]?.trim() ?? "";
  const sentence = /^(.+?[.!?])(\s|$)/.exec(line)?.[1] ?? line;
  return sentence.length > 100 ? `${sentence.slice(0, 99)}…` : sentence;
}

async function readYaml(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = YAML.parse(await readFile(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// The boundary a review command should use: commit-backed while checkpoint commits are on for a
// sliced change, snapshots otherwise (commits off, flat change, or not on the change branch).
export async function reviewBoundaryFor(
  ctx: ReviewContext,
  scope: { sliceId?: string; change?: boolean; repos?: Array<{ id: string; path?: string }> },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReviewBoundary> {
  try {
    if (!(await pathExists(path.join(ctx.changePath, "task-slices")))) return new SnapshotBoundary();
    const settings = await resolveCommitSettings(ctx, env);
    if (!settings.enabled) return new SnapshotBoundary();
    const status = await readYaml(path.join(ctx.changePath, "status.yml"));
    const branch = typeof status?.branch === "string" ? status.branch : `change/${ctx.changeId}`;
    const repoIds = new Map<string, string>();
    for (const repo of scope.repos ?? []) if (repo.path) repoIds.set(path.resolve(repo.path), repo.id);
    let buildCommitted = true;
    let sliceTitle: string | undefined;
    if (scope.sliceId) {
      const sliceDir = path.join(ctx.changePath, "task-slices", scope.sliceId);
      const tasks = (await pathExists(path.join(sliceDir, "tasks.md"))) ? await readFile(path.join(sliceDir, "tasks.md"), "utf8") : "";
      const coverage = sliceCoverage(parseTaskRows(tasks));
      const sliceStatus = await readYaml(path.join(sliceDir, "status.yml"));
      sliceTitle = typeof sliceStatus?.title === "string" ? sliceStatus.title : undefined;
      const paths = [...repoIds.keys()];
      const lookups = paths.length > 0 ? paths : [ctx.weaveRoot];
      buildCommitted = false;
      for (const repoPath of lookups) {
        const committed = await committedCoverage(repoPath, ctx.changeId, env);
        if (committed.slices.get(scope.sliceId)?.has(coverage)) buildCommitted = true;
      }
    }
    return new CommitBoundary({
      changeId: ctx.changeId,
      branch,
      settings,
      ...(scope.sliceId ? { sliceId: scope.sliceId } : {}),
      ...(sliceTitle ? { sliceTitle } : {}),
      buildCommitted,
      repoIds,
      env,
    });
  } catch {
    return new SnapshotBoundary();
  }
}

// `boundary` for review command output: per repo id, the kind of each end boundary taken.
export function boundaryReport(boundary: ReviewBoundary, repos: Array<{ id: string; path?: string }>): Record<string, { kind: BoundaryKind; reason?: string }> | undefined {
  if (!(boundary instanceof CommitBoundary)) return undefined;
  const report: Record<string, { kind: BoundaryKind; reason?: string }> = {};
  for (const record of boundary.records) {
    if (/\/(start|round\d+-start|fix-start)$/.test(record.ref)) continue;
    const repo = repos.find((entry) => entry.path && path.resolve(entry.path) === path.resolve(record.repoPath))?.id ?? rootRepoId;
    report[repo] = { kind: record.kind, ...(record.reason ? { reason: record.reason } : {}) };
  }
  return Object.keys(report).length > 0 ? report : undefined;
}

// The kind of a recorded boundary ref: snapshots are parentless commits, checkpoint commits sit on
// the change branch.
export async function boundaryKindOf(repoPath: string, ref: string): Promise<BoundaryKind | undefined> {
  const parents = await checkpointGit(["rev-list", "--parents", "-n", "1", ref], repoPath);
  if (!parents.ok) return undefined;
  return parents.stdout.trim().split(" ").length > 1 ? "commit" : "snapshot";
}
