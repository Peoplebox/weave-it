// Recording a slice review (architecture/api-contract.md `weave review record`, schema.md Finding
// record and Readable records). A reviewer's response is untrusted model output: it is parsed only
// as data, validated against the report schema by hand, and its paths are normalised and checked
// against the known repos. Findings are stored with run-scoped ids and frozen `kind` and
// `severity`; resolutions are recorded by the build agent, except plan findings, which only a
// person can dismiss. Every write runs under the per-change lock, re-reads the files, and writes
// atomically. The readable `review.md` is regenerated from the findings files on every write.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { changeRepoCheckouts, sliceRepoCheckouts, type SliceRepoCheckout } from "../../commands/review/snapshot.js";
import { ChangeCommandError } from "../change-error.js";
import { pathExists } from "../files.js";
import { writeFileAtomic } from "../local-state.js";
import { readWorkspaceMetadata } from "../workspace-repos.js";
import { changeRunRef, type ReviewBoundary } from "./boundary.js";
import {
  absentHash,
  changeCoveredFiles,
  classifyRulings,
  computeChangePlanBasis,
  computeFingerprint,
  computePlanBasis,
  computeRulingBasis,
  decisionHashes,
  planDecisionIds,
  releaseOwnership,
  runCoveredFiles,
  type Ruling,
  type RulingBasis,
} from "./fingerprint.js";
import { guidelineRepos, resolveGuidelines } from "./guidelines.js";
import { labelForeignFiles, parseFileAnchors, parseTaskEvidence, parseTaskSections, slicePackageDir, sliceRunEndRef } from "./package.js";
import { deriveVerdict, type ChangeReviewState, type ChangeVerdict, type StoredSliceState, type VerdictInputs } from "./rules.js";
import {
  changeRunLocation,
  listSlices,
  readChangeReview,
  readSliceReview,
  resolveSlice,
  reviewContextForChangePath,
  updateChangeReview,
  updateSliceReview,
  type ChangeReviewBlock,
  type ChangeReviewCounts,
  type ReviewContext,
  type SliceLocation,
  type SliceReviewBlock,
  type SliceReviewCounts,
} from "./state.js";

// --- report schema ---------------------------------------------------------------------------

export const severities = ["critical", "important", "minor"] as const;
export type Severity = (typeof severities)[number];
export const findingKinds = ["code", "plan"] as const;
export type FindingKind = (typeof findingKinds)[number];
export const failsTypes = ["acceptance", "prd", "architecture", "decision", "guideline", "knowledge", "correctness"] as const;
export type FailsType = (typeof failsTypes)[number];
export const reportVerdicts = ["ready", "with_fixes", "not_ready"] as const;
export type ReportVerdict = (typeof reportVerdicts)[number];
export const minorSortClasses = ["must_fix", "can_wait"] as const;
export type MinorSortClass = (typeof minorSortClasses)[number];
export const fixCheckResults = ["addressed", "not_addressed"] as const;
export type FixCheckResult = (typeof fixCheckResults)[number];

// Process exit codes for `weave review record`. No other command uses 4 or 5.
export const recordExitCodes: Readonly<Record<string, number>> = {
  report_invalid: 4,
  plan_finding_requires_person: 5,
};

export interface FindingLocation {
  repo: string;
  // Relative to the repo root, normalised, never absolute and never with `..`.
  path: string;
  line?: number;
}

export interface ReportFinding {
  // `F<n>` as the reviewer wrote it.
  id: string;
  severity: Severity;
  kind: FindingKind;
  location: FindingLocation;
  fails: { type: FailsType; ref: string };
  detail: string;
  fix_hint?: string;
}

export interface ValidatedReport {
  strengths: string[];
  findings: ReportFinding[];
  declined: Array<{ behavior: string; reason: string }>;
  verdict: ReportVerdict;
  final_only?: { minor_sort: Array<{ finding: string; class: MinorSortClass }> };
}

export type Resolution =
  | { as: "ruling"; agreed: boolean; reason: string; cost_if_wrong: string; basis: RulingBasis; reopened?: boolean; at?: string }
  // `by_sort`: parked because the final reviewer sorted the Minor as can-wait.
  | { as: "parked"; at?: string; by_sort?: boolean }
  | { as: "dismissed"; by: string; at?: string }
  | { as: "fixed"; round: number; patch?: string; files?: string[]; needs_your_check?: boolean; at?: string };

export interface StoredFinding extends Omit<ReportFinding, "id"> {
  // `<slice>/r<N>-F<n>`.
  id: string;
  foreign_file: boolean;
  resolution: Resolution | null;
  // `fix_check`: a fix checker raised it in `round`. `minor_sort`: a slice run's Minor that a change
  // run's `final_only.minor_sort` named, copied into the change run's findings with its slice id
  // (`origin_run` is that slice run); the slice's own files are never rewritten.
  source?: "fix_check" | "minor_sort";
  round?: number;
  // The final reviewer's sort of a Minor (change runs only).
  final_sort?: MinorSortClass;
  origin_run?: string;
}

// A fix-check report (api-contract.md): the checker's verdict on each finding the round set out to
// fix, plus any new findings the round's diff introduced.
export interface ValidatedFixCheck {
  checks: Array<{ finding: string; result: FixCheckResult }>;
  new_findings: ReportFinding[];
}

// One fix round of a run, kept in the run's findings file under `rounds[]`. Rounds are numbered
// from 1. A round is started by `snapshot --at round-start`, ended by `package --fix-round`, and
// checked by a fix-check report.
export interface RunRound {
  round: number;
  // The round-start ref, the same name in every repo of the slice.
  start_ref: string;
  started_at: string;
  end_ref?: string;
  ended_at?: string;
  // Relative to the slice folder: `review/r1-round1.patch`.
  patch?: string;
  // The command that reverses the round, run from the Weave root.
  undo?: string;
  // Files the round's patch touched (`<repo>:<path>` in workspace mode).
  files?: string[];
  // The open Critical and Important findings the round set out to fix.
  targets?: string[];
  check?: {
    // Relative to the slice's `review/` folder: `r1-round1.check.md`.
    report: string;
    checks: ValidatedFixCheck["checks"];
    // Ids given to the findings the checker raised.
    new_findings: string[];
    recorded_at: string;
  };
}

export interface RunTasks {
  // Active (non-`invalid`) tasks when the run was last written.
  total: number;
  untested: Array<{ id: string; title: string }>;
  human_checks: Array<{ task: string; step: string }>;
}

export interface RunOutcome {
  // A slice run ends `reviewed` or `reviewed_with_rulings`; a change run ends with its verdict.
  // Either can end `review_failed`.
  state: "reviewed" | "reviewed_with_rulings" | "review_failed" | ChangeVerdict;
  at: string;
  reviewed_task_total?: number;
  // Change runs: the counts behind the verdict.
  counts?: ChangeReviewCounts;
}

export type RunScope = { kind: "slice"; slice: string } | { kind: "change" };

// `task-slices/<slice>/review/r<N>.findings.json`, or `<change>/review/f<N>.findings.json` for a
// change run.
export interface RunRecord {
  run: string;
  scope: RunScope;
  independent: boolean;
  partial: boolean;
  model_level: string | null;
  start_ref: string | null;
  end_ref: string;
  // Verbatim report files of this run, relative to the slice's `review/` folder.
  reports: string[];
  strengths: string[];
  findings: StoredFinding[];
  declined: Array<{ behavior: string; reason: string }>;
  verdict: ReportVerdict | null;
  final_only?: ValidatedReport["final_only"];
  tasks: RunTasks;
  // Fix rounds, oldest first. Absent until the first round starts.
  rounds?: RunRound[];
  outcome?: RunOutcome;
  recorded_at: string;
  updated_at: string;
}

export type ValidationResult = { ok: true; report: ValidatedReport } | { ok: false; errors: string[] };

// The last fenced `json` block of a reviewer response, parsed. Throws `report_invalid` when there
// is no block or it is not valid JSON.
export function extractReport(text: string): unknown {
  const fence = /^[ \t]*(`{3,}|~{3,})[ \t]*json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1[ \t]*$/gim;
  let last: string | undefined;
  for (const match of text.matchAll(fence)) {
    last = match[2];
  }
  if (last === undefined) {
    throw reportInvalid(["no fenced ```json block found in the report"]);
  }
  try {
    return JSON.parse(last) as unknown;
  } catch (error) {
    throw reportInvalid([`the last json block is not valid JSON: ${error instanceof Error ? error.message : String(error)}`]);
  }
}

// Checks a parsed report against the slice report schema. Unknown fields are dropped, missing
// required fields are errors, and `location` paths must be relative, without `..`, inside one of
// `repos` (when given).
export function validateReport(json: unknown, options: { repos?: string[] } = {}): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(json)) {
    return { ok: false, errors: ["the report must be a JSON object"] };
  }
  if ("checks" in json && !("findings" in json)) {
    return { ok: false, errors: ["this is a fix-check report (`checks`); a slice report needs `findings` and `verdict`"] };
  }

  const strengths: string[] = [];
  if (json.strengths !== undefined) {
    if (!Array.isArray(json.strengths)) {
      errors.push("strengths: must be an array of strings");
    } else {
      json.strengths.forEach((value, index) => {
        if (typeof value === "string") strengths.push(value);
        else errors.push(`strengths[${index}]: must be a string`);
      });
    }
  }

  const findings: ReportFinding[] = [];
  if (!Array.isArray(json.findings)) {
    errors.push(json.findings === undefined ? "findings: required" : "findings: must be an array");
  } else {
    const seen = new Set<string>();
    json.findings.forEach((value, index) => {
      const finding = validateFinding(value, `findings[${index}]`, errors, options.repos);
      if (!finding) return;
      if (seen.has(finding.id)) {
        errors.push(`findings[${index}].id: duplicate id ${finding.id}`);
        return;
      }
      seen.add(finding.id);
      findings.push(finding);
    });
  }

  const declined: ValidatedReport["declined"] = [];
  if (json.declined !== undefined) {
    if (!Array.isArray(json.declined)) {
      errors.push("declined: must be an array");
    } else {
      json.declined.forEach((value, index) => {
        const where = `declined[${index}]`;
        if (!isRecord(value)) {
          errors.push(`${where}: must be an object`);
          return;
        }
        const behavior = requiredString(value.behavior, `${where}.behavior`, errors);
        const reason = requiredString(value.reason, `${where}.reason`, errors);
        if (behavior !== undefined && reason !== undefined) declined.push({ behavior, reason });
      });
    }
  }

  const verdict = enumValue(json.verdict, reportVerdicts, "verdict", errors, true);

  let finalOnly: ValidatedReport["final_only"];
  if (json.final_only !== undefined) {
    if (!isRecord(json.final_only)) {
      errors.push("final_only: must be an object");
    } else {
      const sort: Array<{ finding: string; class: MinorSortClass }> = [];
      const raw = json.final_only.minor_sort;
      if (raw !== undefined && !Array.isArray(raw)) {
        errors.push("final_only.minor_sort: must be an array");
      } else {
        (raw ?? []).forEach((value: unknown, index: number) => {
          const where = `final_only.minor_sort[${index}]`;
          if (!isRecord(value)) {
            errors.push(`${where}: must be an object`);
            return;
          }
          const finding = requiredString(value.finding, `${where}.finding`, errors);
          const sortClass = enumValue(value.class, minorSortClasses, `${where}.class`, errors, true);
          if (finding !== undefined && sortClass !== undefined) sort.push({ finding, class: sortClass });
        });
      }
      finalOnly = { minor_sort: sort };
    }
  }

  if (errors.length > 0 || verdict === undefined) {
    return { ok: false, errors };
  }
  return { ok: true, report: { strengths, findings, declined, verdict, ...(finalOnly ? { final_only: finalOnly } : {}) } };
}

// Whether a parsed report has the fix-check shape (`checks` and no `findings`).
export function isFixCheckReport(json: unknown): boolean {
  return isRecord(json) && "checks" in json && !("findings" in json);
}

// Checks a parsed fix-check report: `checks[]` of `{finding, result: addressed | not_addressed}`
// and optional `new_findings[]` in the slice report's finding shape. A new finding's id is ignored
// (it gets a fresh run-scoped id when stored), so any id, or none, is accepted. Whether each
// checked id belongs to the run is checked when the report is recorded.
export function validateFixCheckReport(json: unknown, options: { repos?: string[] } = {}): { ok: true; report: ValidatedFixCheck } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(json)) {
    return { ok: false, errors: ["the report must be a JSON object"] };
  }
  const checks: ValidatedFixCheck["checks"] = [];
  if (!Array.isArray(json.checks)) {
    errors.push("checks: must be an array");
  } else {
    const seen = new Set<string>();
    json.checks.forEach((value, index) => {
      const where = `checks[${index}]`;
      if (!isRecord(value)) {
        errors.push(`${where}: must be an object`);
        return;
      }
      const finding = requiredString(value.finding, `${where}.finding`, errors)?.trim();
      const result = enumValue(value.result, fixCheckResults, `${where}.result`, errors, true);
      if (finding === undefined || result === undefined) return;
      if (seen.has(finding)) {
        errors.push(`${where}.finding: ${finding} is checked twice`);
        return;
      }
      seen.add(finding);
      checks.push({ finding, result });
    });
  }

  const newFindings: ReportFinding[] = [];
  if (json.new_findings !== undefined && json.new_findings !== null) {
    if (!Array.isArray(json.new_findings)) {
      errors.push("new_findings: must be an array");
    } else {
      json.new_findings.forEach((value, index) => {
        const labelled = isRecord(value) ? { ...value, id: `F${index + 1}` } : value;
        const finding = validateFinding(labelled, `new_findings[${index}]`, errors, options.repos);
        if (finding) newFindings.push(finding);
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, report: { checks, new_findings: newFindings } };
}

// A location path made safe: `\` becomes `/`, `.` and empty segments are dropped; absolute paths
// and `..` segments are rejected (undefined).
export function normalizeLocationPath(value: string): string | undefined {
  const slashed = value.trim().replace(/\\/g, "/");
  if (!slashed || slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed)) {
    return undefined;
  }
  const segments = slashed.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) {
    return undefined;
  }
  return segments.join("/");
}

// `02-work/r1` + `F3` -> `02-work/r1-F3`.
export function scopeFindingId(runId: string, id: string): string {
  return `${runId}-${id}`;
}

// --- findings and resolutions ----------------------------------------------------------------

// Folds a report into a run's findings. A finding id already stored keeps its `kind`, `severity`,
// and `resolution`; only its wording and location are refreshed. New ids are added unresolved.
export function mergeFindings(
  existing: StoredFinding[],
  incoming: ReportFinding[],
  runId: string,
  isForeign: (location: FindingLocation) => boolean,
): StoredFinding[] {
  const merged = existing.map((finding) => ({ ...finding }));
  for (const finding of incoming) {
    const id = scopeFindingId(runId, finding.id);
    const stored = merged.find((candidate) => candidate.id === id);
    const fields = {
      location: finding.location,
      fails: finding.fails,
      detail: finding.detail,
      ...(finding.fix_hint !== undefined ? { fix_hint: finding.fix_hint } : {}),
      foreign_file: isForeign(finding.location),
    };
    if (stored) {
      const { fix_hint: _dropped, ...rest } = stored;
      merged[merged.indexOf(stored)] = { ...rest, ...fields, id, kind: stored.kind, severity: stored.severity, resolution: stored.resolution };
    } else {
      merged.push({ id, severity: finding.severity, kind: finding.kind, ...fields, resolution: null });
    }
  }
  return merged;
}

// Sets one finding's resolution. A plan finding can only be dismissed by a person
// (`plan_finding_requires_person`), and only Minors can be parked (`invalid_resolution`).
export function applyResolution(findings: StoredFinding[], id: string, resolution: Resolution): StoredFinding[] {
  const index = findings.findIndex((finding) => finding.id === id);
  if (index === -1) {
    throw new ChangeCommandError("finding_not_found", `No finding ${id} in this run.`, {
      finding: id,
      available: findings.map((finding) => finding.id),
    });
  }
  const finding = findings[index];
  if (finding.kind === "plan" && resolution.as !== "dismissed") {
    throw new ChangeCommandError(
      "plan_finding_requires_person",
      `${id} is a plan problem: only a person can resolve it, with --as dismissed --by <name>, or by changing the plan.`,
      { finding: id, state: "waiting_on_person" },
    );
  }
  if (resolution.as === "parked" && finding.severity !== "minor") {
    throw new ChangeCommandError("invalid_resolution", `Only Minor findings can be parked; ${id} is ${finding.severity}.`, {
      finding: id,
      severity: finding.severity,
    });
  }
  const next = findings.map((candidate) => ({ ...candidate }));
  next[index] = { ...finding, resolution };
  return next;
}

export interface DerivedRunState {
  state: StoredSliceState | "finalize_blocked";
  // Finding ids still without a resolution.
  open: string[];
}

// The slice state a run's findings give.
// - Any unresolved plan finding: `waiting_on_person`.
// - Otherwise, while the run is going: `in_review`.
// - At finalize: `reviewed` when nothing is unresolved and no ruling was recorded,
//   `reviewed_with_rulings` when every remaining finding has a ruling (Minors may be parked), and
//   `finalize_blocked` when any finding is still unresolved.
export function deriveSliceState(findings: StoredFinding[], options: { finalize?: boolean } = {}): DerivedRunState {
  const open = findings.filter((finding) => finding.resolution === null).map((finding) => finding.id);
  if (findings.some((finding) => finding.kind === "plan" && finding.resolution === null)) {
    return { state: options.finalize ? "finalize_blocked" : "waiting_on_person", open };
  }
  if (!options.finalize) {
    return { state: "in_review", open };
  }
  if (open.length > 0) {
    return { state: "finalize_blocked", open };
  }
  // A person's dismissal of a plan problem is their own ruling (FR27), so it counts like an agent ruling.
  return { state: findings.some((finding) => isRulingResolution(finding)) ? "reviewed_with_rulings" : "reviewed", open };
}

function isRulingResolution(finding: StoredFinding): boolean {
  return finding.resolution?.as === "ruling" || finding.resolution?.as === "dismissed";
}

// `human_checks` counts the slice's `Human check:` steps plus every fix marked "needs your check".
export function sliceCounts(findings: StoredFinding[], tasks: RunTasks): SliceReviewCounts {
  return {
    open_rulings: findings.filter((finding) => isRulingResolution(finding)).length,
    parked_minors: findings.filter((finding) => finding.resolution?.as === "parked").length,
    human_checks: tasks.human_checks.length + fixesNeedingCheck(findings).length,
    untested_tasks: tasks.untested.length,
  };
}

// Findings fixed in a round of a slice whose tasks carry a `Human check:` step.
export function fixesNeedingCheck(findings: StoredFinding[]): StoredFinding[] {
  return findings.filter((finding) => finding.resolution?.as === "fixed" && finding.resolution.needs_your_check === true);
}

// --- review.md -------------------------------------------------------------------------------

// The readable slice review record: one section per run, newest first. `reopened` holds the ids of
// rulings whose basis changed since they were recorded (derived by `classifyRulings`, never stored).
export function renderReviewRecord(runs: RunRecord[], options: { reopened?: ReadonlySet<string> } = {}): string {
  const ordered = [...runs].sort((left, right) => runNumber(right.run) - runNumber(left.run));
  const first = ordered[0]?.scope;
  const slice = first?.kind === "slice" ? first.slice : "";
  const out: string[] = [`# Review record: ${slice}`, ""];
  out.push("Written by `weave review record` from `review/*.findings.json`. Do not edit by hand. Newest run first.", "");
  if (ordered.length === 0) {
    out.push("No review runs recorded yet.", "");
  }
  const reopened = options.reopened ?? new Set<string>();
  for (const run of ordered) {
    out.push(...renderRun(run, reopened));
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function renderRun(run: RunRecord, reopened: ReadonlySet<string>): string[] {
  const out: string[] = [`## Run ${run.run}`, ""];
  const change = run.scope.kind === "change";
  const state = run.outcome?.state ?? (change ? (openPlanFindings(run.findings).length > 0 ? "not_ready" : "in_progress") : deriveSliceState(run.findings).state);
  out.push(`- Scope: ${run.scope.kind === "slice" ? `slice \`${run.scope.slice}\`` : "the whole change"}`);
  out.push(`- State: ${label(state)}${run.outcome ? ` (${run.outcome.at})` : ""}`);
  out.push(`- Verdict: ${run.verdict ? label(run.verdict) : "none recorded"}`);
  out.push(`- Model level: ${run.model_level ?? "unknown"}`);
  out.push(`- Independent: ${run.independent ? "yes" : "no (less independent: the review ran inline in the building session, not in a separate reviewer)"}`);
  out.push(`- Partial: ${run.partial ? "yes" : "no"}`);
  out.push(`- Start: ${run.start_ref ? `\`${run.start_ref}\`` : change ? "the diff base of each repo (merge-base with the target branch, or the recorded base commit)" : "no start snapshot (fallback base)"}`);
  out.push(`- End: \`${run.end_ref}\``);
  out.push(`- Reports: ${run.reports.length > 0 ? run.reports.map((file) => `\`review/${file}\``).join(", ") : "none"}`);
  out.push("");

  out.push("### Strengths", "");
  out.push(...(run.strengths.length > 0 ? run.strengths.map((value) => `- ${oneLine(value)}`) : ["None recorded."]), "");

  out.push("### Findings", "");
  if (run.findings.length === 0) {
    out.push("None.", "");
  } else {
    out.push("| ID | Severity | Kind | Location | Fails | Status |", "| --- | --- | --- | --- | --- | --- |");
    for (const finding of run.findings) {
      const location = `${finding.location.repo}:${finding.location.path}${finding.location.line ? `:${finding.location.line}` : ""}${finding.foreign_file ? " (foreign)" : ""}`;
      const fails = `${finding.fails.type}${finding.fails.ref ? `: ${finding.fails.ref}` : ""}`;
      out.push(`| ${cell(finding.id)} | ${finding.severity} | ${finding.kind} | ${cell(location)} | ${cell(fails)} | ${cell(findingStatus(finding, reopened.has(finding.id)))} |`);
    }
    out.push("");
    for (const finding of run.findings) {
      out.push(`- \`${finding.id}\`: ${oneLine(finding.detail)}${finding.fix_hint ? ` Fix hint: ${oneLine(finding.fix_hint)}` : ""}`);
    }
    out.push("");
  }

  out.push(...renderFixes(run));

  out.push("### Rulings", "");
  const rulings = run.findings.filter((finding) => finding.resolution?.as === "ruling");
  if (rulings.length === 0) {
    out.push("None.", "");
  } else {
    for (const finding of rulings) {
      const ruling = finding.resolution as Extract<Resolution, { as: "ruling" }>;
      out.push(`- \`${finding.id}\` (${finding.severity}, ${ruling.agreed ? "agreed the finding is real" : "disagreed"}): ${oneLine(ruling.reason)}`);
      out.push(`  - Cost if wrong: ${oneLine(ruling.cost_if_wrong)}`);
      out.push(`  - Basis: ${renderBasis(ruling.basis)}`);
      out.push(`  - Reopened: ${ruling.reopened || reopened.has(finding.id) ? "yes (its basis changed since the ruling)" : "no"}`);
    }
    out.push("");
  }

  out.push("### Declined to judge", "");
  out.push(...(run.declined.length > 0 ? run.declined.map((item) => `- ${oneLine(item.behavior)}: ${oneLine(item.reason)}`) : ["None."]), "");

  if (change) {
    out.push("### Minor sort", "");
    const sorted = run.findings.filter((finding) => finding.final_sort !== undefined);
    const lines = sorted.map((finding) => `- \`${finding.id}\`: ${finding.final_sort === "must_fix" ? "must fix" : "can wait"}${finding.origin_run ? ` (from slice run \`${finding.origin_run}\`)` : ""}`);
    // Slice rulings sorted can-wait are not copied into the run's findings: they stay parked.
    const copied = new Set(run.findings.map((finding) => finding.id));
    for (const entry of run.final_only?.minor_sort ?? []) {
      if (!copied.has(entry.finding) && entry.class === "can_wait") lines.push(`- \`${entry.finding}\`: can wait (the slice review's ruling stays parked)`);
    }
    out.push(...(lines.length > 0 ? lines : ["None recorded."]), "");
  }

  out.push("### Saved Minors", "");
  const parked = run.findings.filter((finding) => finding.resolution?.as === "parked");
  out.push(...(parked.length > 0 ? parked.map((finding) => `- \`${finding.id}\` (${finding.location.repo}:${finding.location.path}): ${oneLine(finding.detail)}`) : ["None."]), "");

  out.push("### Untested tasks", "");
  out.push(...(run.tasks.untested.length > 0 ? run.tasks.untested.map((task) => `- ${task.id}: ${oneLine(task.title)}`) : ["None."]), "");

  out.push("### Human checks (needs your check)", "");
  const humanChecks = [
    ...run.tasks.human_checks.map((check) => `- ${check.task}: ${oneLine(check.step)}`),
    ...fixesNeedingCheck(run.findings).map((finding) => {
      const fix = finding.resolution as Extract<Resolution, { as: "fixed" }>;
      return `- \`${finding.id}\`: fixed in ${change ? "the fix batch" : `round ${fix.round}`}; repeat the ${change ? "change's" : "slice's"} human checks against the fix`;
    }),
  ];
  out.push(...(humanChecks.length > 0 ? humanChecks : ["None."]), "");
  return out;
}

// The Fixes table (one row per fixed finding) and, per fix round, its patch, how to undo it, and
// what its fix check found.
function renderFixes(run: RunRecord): string[] {
  const out: string[] = ["### Fixes", ""];
  const fixes = run.findings.filter((finding) => finding.resolution?.as === "fixed");
  const rounds = run.rounds ?? [];
  if (fixes.length === 0 && rounds.length === 0) {
    return [...out, "None.", ""];
  }
  if (fixes.length === 0) {
    out.push("No finding is marked fixed yet.", "");
  } else {
    out.push("| Finding | Round | Patch | Files | Needs your check |", "| --- | --- | --- | --- | --- |");
    for (const finding of fixes) {
      const fix = finding.resolution as Extract<Resolution, { as: "fixed" }>;
      const files = fix.files && fix.files.length > 0 ? fix.files.map((file) => `\`${file}\``).join(", ") : "none";
      out.push(`| ${cell(finding.id)} | ${fix.round} | ${fix.patch ? cell(`\`${fix.patch}\``) : "none"} | ${cell(files)} | ${fix.needs_your_check ? "yes" : "no"} |`);
    }
    out.push("");
  }
  if (rounds.length > 0) {
    out.push("Fix rounds:", "");
    for (const round of [...rounds].sort((left, right) => left.round - right.round)) {
      out.push(`- Round ${round.round}: ${renderRoundSummary(round)}`);
      if (round.undo) out.push(`  - Undo from the Weave root: \`${round.undo}\``);
    }
    out.push("");
  }
  return out;
}

function renderRoundSummary(round: RunRound): string {
  if (!round.patch) {
    return "started, not yet packaged";
  }
  const parts = [`patch \`${round.patch}\` (${round.files?.length ?? 0} files)`];
  if (!round.check) {
    parts.push("fix check not recorded yet");
  } else {
    const addressed = round.check.checks.filter((check) => check.result === "addressed").length;
    const missed = round.check.checks.length - addressed;
    const raised = round.check.new_findings.length;
    parts.push(
      `fix check \`review/${round.check.report}\`: ${addressed} addressed, ${missed} not addressed, ${raised === 0 ? "no new findings" : `new: ${round.check.new_findings.map((id) => `\`${id}\``).join(", ")}`}`,
    );
  }
  return parts.join("; ");
}

function findingStatus(finding: StoredFinding, reopened = false): string {
  const resolution = finding.resolution;
  if (!resolution) return finding.kind === "plan" ? "waiting on person" : finding.final_sort === "must_fix" ? "open (must fix)" : "open";
  switch (resolution.as) {
    case "fixed":
      return `fixed in round ${resolution.round}`;
    case "ruling":
      return resolution.reopened || reopened ? "ruling (reopened)" : `ruling (${resolution.agreed ? "agreed" : "disagreed"})`;
    case "parked":
      return resolution.by_sort ? "parked (can wait)" : "parked";
    case "dismissed":
      return `dismissed by ${resolution.by}`;
  }
}

function renderBasis(basis: RulingBasis): string {
  const parts: string[] = [];
  const add = (kind: string, entries: Record<string, string>): void => {
    for (const [key, value] of Object.entries(entries)) parts.push(`${kind} \`${key}\` (${shortHash(value)})`);
  };
  add("code", basis.code ?? {});
  add("guideline", basis.guidelines ?? {});
  add("document", basis.documents ?? {});
  add("decision", basis.decisions ?? {});
  return parts.length > 0 ? parts.join(", ") : "none";
}

// --- run files -------------------------------------------------------------------------------

export interface ResolvedRun {
  // `slice` for `<slice>/r<N>`, `change` for `change/f<N>`.
  scope: "slice" | "change";
  // The slice folder; for a change run, the change folder (`changeRunLocation`, id `_change`).
  slice: SliceLocation;
  // `r<N>` or `f<N>`.
  run: string;
  // `<slice>/r<N>` or `change/f<N>`.
  runId: string;
}

// `02/r1` or `02-work/r1` -> the slice folder and the run. The slice part accepts a unique leading
// number, like `--slice`. `change/f1` -> the change run f1.
export async function resolveRun(ctx: ReviewContext, runId: string): Promise<ResolvedRun> {
  const change = /^change\/(f\d+)$/i.exec(runId.trim());
  if (change) {
    const run = change[1].toLowerCase().replace(/^f0*(\d)/, "f$1");
    return { scope: "change", slice: changeRunLocation(ctx), run, runId: `change/${run}` };
  }
  const match = /^(.+)\/(r\d+)$/.exec(runId.trim());
  if (!match) {
    throw new ChangeCommandError("invalid_arguments", `--run takes <slice>/r<N>, such as 02/r1, or change/f<N>, not ${runId}.`, { run: runId });
  }
  let slice: SliceLocation;
  try {
    slice = await resolveSlice(ctx, match[1]);
  } catch (error) {
    if (error instanceof ChangeCommandError && error.code === "slice_not_found") {
      throw new ChangeCommandError("run_not_found", `No slice matches run ${runId}.`, { run: runId, ...(isRecord(error.details) ? error.details : {}) });
    }
    throw error;
  }
  const run = match[2].replace(/^r0*(\d)/, "r$1");
  return { scope: "slice", slice, run, runId: `${slice.id}/${run}` };
}

export function runFindingsPath(slice: SliceLocation, run: string): string {
  return path.join(slice.path, "review", `${run}.findings.json`);
}

export function reviewRecordPath(slice: SliceLocation): string {
  return path.join(slice.path, "review.md");
}

export async function readRunRecord(slice: SliceLocation, run: string): Promise<RunRecord | undefined> {
  const file = runFindingsPath(slice, run);
  if (!(await pathExists(file))) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.findings)) throw new Error("not a findings record");
    return parsed as unknown as RunRecord;
  } catch (error) {
    throw new ChangeCommandError("invalid_review_record", `Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`, { file });
  }
}

// Every run record of a slice, newest first.
export async function readRunRecords(slice: SliceLocation): Promise<RunRecord[]> {
  let names: string[];
  try {
    names = await readdir(path.join(slice.path, "review"));
  } catch {
    return [];
  }
  const runs = names.flatMap((name) => {
    const match = /^([rf]\d+)\.findings\.json$/.exec(name);
    return match ? [match[1]] : [];
  });
  const records: RunRecord[] = [];
  for (const run of runs) {
    const record = await readRunRecord(slice, run);
    if (record) records.push(record);
  }
  return records.sort((left, right) => runNumber(right.run) - runNumber(left.run));
}

// --- recording -------------------------------------------------------------------------------

export interface RecordOptions {
  // False when the client ran the review inline instead of in a separate reviewer.
  independent?: boolean;
  now?: Date;
}

// The state a run's scope is in after a write: a slice state for slice runs, the change review
// state for change runs.
export type RunScopeState = StoredSliceState | ChangeReviewState;

export interface RecordReportResult {
  status: "ok";
  run: string;
  state: RunScopeState;
  findings: number;
  new_findings: number;
  open: string[];
  plan_findings_open: string[];
  report_path: string;
  findings_path: string;
  review_path: string;
}

// `record --report -`: validates the report, then stores it verbatim, folds its findings into the
// run's findings file, regenerates `review.md`, and moves the slice to `in_review`, or
// `waiting_on_person` while a plan finding is open. An invalid report writes nothing. A report with
// the fix-check shape (`checks`, no `findings`) is recorded against the run's fix round instead
// (`recordFixCheck`).
export async function recordReport(
  ctx: ReviewContext,
  runId: string,
  text: string,
  options: RecordOptions = {},
): Promise<RecordReportResult | RecordFixCheckResult> {
  const target = await resolveRun(ctx, runId);
  await assertRunWritable(target, await readRunBlock(ctx, target), await readRunRecord(target.slice, target.run));

  const metadata = await readWorkspaceMetadata(ctx.weaveRoot);
  const knownRepos = ["root", ...Object.keys(metadata?.repos ?? {})];
  const parsed = extractReport(text);
  if (isFixCheckReport(parsed)) {
    return recordFixCheck(ctx, target, text, parsed, knownRepos, options);
  }
  const validation = validateReport(parsed, { repos: knownRepos });
  if (!validation.ok) {
    throw reportInvalid(validation.errors);
  }
  const report = validation.report;
  const tasks = await runTasksFor(ctx, target);
  const isForeign = await foreignTestFor(ctx, target);
  // A change run's `final_only.minor_sort` must name Minors of this change; checked before writing.
  const sort = target.scope === "change" ? await resolveMinorSort(ctx, target, report, await readRunRecord(target.slice, target.run)) : [];
  const modelLevel = await packageModelLevel(ctx, target);
  const now = options.now ?? new Date();

  let result: RecordReportResult | undefined;
  await updateRunBlock(
    ctx,
    target,
    async (block) => {
      const existing = await readRunRecord(target.slice, target.run);
      await assertRunWritable(target, block, existing);
      const record = existing ?? newRunRecord(ctx, target, block, modelLevel, now);
      const before = new Set(record.findings.map((finding) => finding.id));
      const reportFile = record.reports.length === 0 ? `${target.run}.report.md` : `${target.run}.report-${record.reports.length + 1}.md`;

      record.findings = mergeFindings(record.findings, report.findings, target.runId, isForeign);
      if (target.scope === "change") record.findings = applyMinorSort(record.findings, sort, now);
      record.strengths = report.strengths;
      record.declined = report.declined;
      record.verdict = report.verdict;
      // A change run keeps the sort with every id resolved, so slice rulings left parked (never
      // copied into its findings) still show in its record.
      if (report.final_only) record.final_only = target.scope === "change" ? { minor_sort: sort.map((entry) => ({ finding: entry.id, class: entry.class })) } : report.final_only;
      else delete record.final_only;
      record.reports = [...record.reports, reportFile];
      record.tasks = tasks;
      if (options.independent === false) record.independent = false;
      record.updated_at = now.toISOString();

      await writeFileAtomic(path.join(target.slice.path, "review", reportFile), text);
      await writeRunRecord(target.slice, record);
      const next = await blockAfterWrite(ctx, target, block, record);
      const state = next.state;
      result = {
        status: "ok",
        run: target.runId,
        state,
        findings: record.findings.length,
        new_findings: record.findings.filter((finding) => !before.has(finding.id)).length,
        open: openFindingIds(record.findings),
        plan_findings_open: openPlanFindings(record.findings),
        report_path: path.join(target.slice.path, "review", reportFile),
        findings_path: runFindingsPath(target.slice, target.run),
        review_path: reviewRecordPath(target.slice),
      };
      return next.block;
    },
    { now },
  );
  return result as RecordReportResult;
}

export interface RecordFixCheckResult {
  status: "ok";
  run: string;
  kind: "fix_check";
  round: number;
  addressed: string[];
  not_addressed: string[];
  // Ids given to the findings the checker raised.
  new_findings: string[];
  state: RunScopeState;
  open: string[];
  plan_findings_open: string[];
  check_path: string;
  findings_path: string;
  review_path: string;
}

// A fix-check report for the run's latest fix round that has a package and no check yet: stored
// verbatim as `r<N>-round<n>.check.md`, its checks kept on the round, and its new findings added
// to the run with fresh ids, `source: fix_check`, and the round. A `not_addressed` check leaves the
// finding open; an `addressed` one does not resolve it either (that is `--as fixed`). Checks that
// name a finding outside the run make the report invalid (exit 4), and nothing is written.
async function recordFixCheck(
  ctx: ReviewContext,
  target: ResolvedRun,
  text: string,
  parsed: unknown,
  knownRepos: string[],
  options: RecordOptions,
): Promise<RecordFixCheckResult> {
  const validation = validateFixCheckReport(parsed, { repos: knownRepos });
  if (!validation.ok) {
    throw reportInvalid(validation.errors);
  }
  const report = validation.report;
  const initial = await readRunRecord(target.slice, target.run);
  if (!initial) {
    throw new ChangeCommandError("round_not_found", `Run ${target.runId} has no recorded report, so it has no fix round to check.`, { run: target.runId });
  }
  roundAwaitingCheck(target, initial);
  resolveCheckedFindings(target, initial, report);

  const tasks = await runTasksFor(ctx, target);
  const isForeign = await foreignTestFor(ctx, target);
  const now = options.now ?? new Date();

  let result: RecordFixCheckResult | undefined;
  await updateRunBlock(
    ctx,
    target,
    async (block) => {
      const record = await readRunRecord(target.slice, target.run);
      await assertRunWritable(target, block, record);
      if (!record) {
        throw new ChangeCommandError("round_not_found", `Run ${target.runId} has no recorded report.`, { run: target.runId });
      }
      const round = roundAwaitingCheck(target, record);
      const checks = resolveCheckedFindings(target, record, report);
      let number = nextFindingNumber(record.findings);
      const raised: StoredFinding[] = report.new_findings.map((finding) => ({
        id: scopeFindingId(target.runId, `F${number++}`),
        severity: finding.severity,
        kind: finding.kind,
        location: finding.location,
        fails: finding.fails,
        detail: finding.detail,
        ...(finding.fix_hint !== undefined ? { fix_hint: finding.fix_hint } : {}),
        foreign_file: isForeign(finding.location),
        resolution: null,
        source: "fix_check",
        round: round.round,
      }));
      const checkFile = `${runRoundStem(target, round.round)}.check.md`;
      round.check = { report: checkFile, checks, new_findings: raised.map((finding) => finding.id), recorded_at: now.toISOString() };
      record.findings = [...record.findings, ...raised];
      record.tasks = tasks;
      if (options.independent === false) record.independent = false;
      record.updated_at = now.toISOString();

      await writeFileAtomic(path.join(target.slice.path, "review", checkFile), text);
      await writeRunRecord(target.slice, record);
      const next = await blockAfterWrite(ctx, target, block, record);
      const state = next.state;
      result = {
        status: "ok",
        run: target.runId,
        kind: "fix_check",
        round: round.round,
        addressed: checks.filter((check) => check.result === "addressed").map((check) => check.finding),
        not_addressed: checks.filter((check) => check.result === "not_addressed").map((check) => check.finding),
        new_findings: raised.map((finding) => finding.id),
        state,
        open: openFindingIds(record.findings),
        plan_findings_open: openPlanFindings(record.findings),
        check_path: path.join(target.slice.path, "review", checkFile),
        findings_path: runFindingsPath(target.slice, target.run),
        review_path: reviewRecordPath(target.slice),
      };
      return next.block;
    },
    { now },
  );
  return result as RecordFixCheckResult;
}

// The run's latest round that has a package and no check, or `round_not_found`.
function roundAwaitingCheck(target: ResolvedRun, record: RunRecord): RunRound {
  const waiting = (record.rounds ?? []).filter((round) => round.patch !== undefined && round.check === undefined);
  const round = waiting.sort((left, right) => right.round - left.round)[0];
  if (!round) {
    throw new ChangeCommandError(
      "round_not_found",
      `Run ${target.runId} has no packaged fix round waiting for a check. Run \`weave review package --run ${target.runId} --fix-round <n>\` first.`,
      { run: target.runId, rounds: (record.rounds ?? []).map((entry) => ({ round: entry.round, packaged: entry.patch !== undefined, checked: entry.check !== undefined })) },
    );
  }
  return round;
}

// The report's checks with each finding id scoped to the run. An id that is not a finding of the
// run makes the report invalid.
function resolveCheckedFindings(target: ResolvedRun, record: RunRecord, report: ValidatedFixCheck): ValidatedFixCheck["checks"] {
  const known = new Set(record.findings.map((finding) => finding.id));
  const errors: string[] = [];
  const checks = report.checks.flatMap((check, index) => {
    let id: string | undefined;
    try {
      id = normalizeFindingId(target, check.finding, known);
    } catch {
      id = undefined;
    }
    if (id === undefined || !known.has(id)) {
      errors.push(`checks[${index}].finding: ${check.finding} is not a finding of run ${target.runId}`);
      return [];
    }
    return [{ finding: id, result: check.result }];
  });
  if (errors.length > 0) {
    throw reportInvalid(errors);
  }
  return checks;
}

// One more than the highest `F<n>` among a run's findings.
function nextFindingNumber(findings: StoredFinding[]): number {
  return findings.reduce((highest, finding) => Math.max(highest, Number.parseInt(/-F(\d+)$/.exec(finding.id)?.[1] ?? "0", 10)), 0) + 1;
}

export interface ResolutionInput {
  finding: string;
  as: string;
  agreed?: string | boolean;
  reason?: string;
  cost?: string;
  by?: string;
  round?: string | number;
}

export interface RecordResolutionResult {
  status: "ok";
  run: string;
  finding: string;
  resolution: Resolution;
  state: RunScopeState;
  open: string[];
  plan_findings_open: string[];
}

// `record --resolve <finding> --as ruling|parked|dismissed`. A plan finding resolved any other way
// than `dismissed` sets the slice to `waiting_on_person`, writes nothing else, and throws
// `plan_finding_requires_person` (exit 5).
export async function recordResolution(ctx: ReviewContext, runId: string, input: ResolutionInput, options: RecordOptions = {}): Promise<RecordResolutionResult> {
  const target = await resolveRun(ctx, runId);
  const initial = await readRunRecord(target.slice, target.run);
  await assertRunWritable(target, await readRunBlock(ctx, target), initial);
  if (!initial) {
    throw new ChangeCommandError("finding_not_found", `Run ${target.runId} has no recorded report, so it has no findings yet.`, { run: target.runId });
  }
  const findingId = normalizeFindingId(target, input.finding, new Set(initial.findings.map((finding) => finding.id)));
  const as = input.as;
  if (!["ruling", "parked", "dismissed", "fixed"].includes(as)) {
    throw new ChangeCommandError("invalid_resolution", `--as takes fixed, ruling, parked, or dismissed, not ${as || "nothing"}.`, { as });
  }

  // Inputs a ruling basis needs that do not depend on the finding, read before taking the lock.
  const metadata = await readWorkspaceMetadata(ctx.weaveRoot);
  const checkouts = await runRepoCheckouts(ctx, target);
  const guidelines = await resolveGuidelines({
    checkoutRoot: ctx.weaveRoot,
    mode: metadata?.mode === "workspace" ? "workspace" : "repo",
    repos: guidelineRepos(metadata, checkouts.map((repo) => repo.id)),
  });
  const now = options.now ?? new Date();

  let refused: ChangeCommandError | undefined;
  let result: RecordResolutionResult | undefined;
  await updateRunBlock(
    ctx,
    target,
    async (block) => {
      const record = await readRunRecord(target.slice, target.run);
      await assertRunWritable(target, block, record);
      if (!record) {
        throw new ChangeCommandError("finding_not_found", `Run ${target.runId} has no recorded report.`, { run: target.runId });
      }
      const finding = record.findings.find((candidate) => candidate.id === findingId);
      if (!finding) {
        throw new ChangeCommandError("finding_not_found", `No finding ${findingId} in run ${target.runId}.`, {
          finding: findingId,
          available: record.findings.map((candidate) => candidate.id),
        });
      }
      if (finding.kind === "plan" && as !== "dismissed") {
        refused = new ChangeCommandError(
          "plan_finding_requires_person",
          `${findingId} is a plan problem. Only a person can resolve it: \`weave review record --run ${target.runId} --resolve ${findingId} --as dismissed --by <name>\`, or by changing the plan.`,
          { finding: findingId, state: "waiting_on_person" },
        );
        return { ...(block ?? {}), state: target.scope === "change" ? "not_ready" : "waiting_on_person", latest_run: target.run };
      }

      const tasks = await runTasksFor(ctx, target);
      const resolution =
        as === "fixed"
          ? fixedResolution(target, record, input, tasks, now)
          : await buildResolution(as, input, finding, now, async () =>
              computeRulingBasis(finding, guidelines.files, ctx.changePath, {
                repos: checkouts,
                ...(target.scope === "slice" ? { sliceId: target.slice.id } : {}),
                weaveRoot: ctx.weaveRoot,
              }),
            );
      record.findings = applyResolution(record.findings, findingId, resolution);
      if (options.independent === false) record.independent = false;
      record.tasks = tasks;
      record.updated_at = now.toISOString();
      await writeRunRecord(target.slice, record);
      const next = await blockAfterWrite(ctx, target, block, record);
      result = {
        status: "ok",
        run: target.runId,
        finding: findingId,
        resolution,
        state: next.state,
        open: openFindingIds(record.findings),
        plan_findings_open: openPlanFindings(record.findings),
      };
      return next.block;
    },
    { now },
  );
  if (refused) throw refused;
  return result as RecordResolutionResult;
}

export interface FinalizeResult {
  status: "ok";
  run: string;
  state: "reviewed" | "reviewed_with_rulings";
  counts: SliceReviewCounts;
  fingerprint_files: number;
  reviewed_task_total: number;
  // Slices whose fingerprint lost files this run now owns.
  released_from: string[];
  // Per repo: files a rebase brought in from main, left out of the fingerprint.
  from_main: Record<string, string[]>;
  warnings: string[];
}

// `record --finalize`: ends the run as `reviewed` or `reviewed_with_rulings` and stores what later
// out-of-date checks compare against: the fingerprint of the slice-owned files the run covered,
// `plan_basis`, the end snapshot's merge-base, and the active task total. Refuses with
// `finalize_blocked` while any finding is unresolved or a plan finding is open.
export async function finalizeRun(
  ctx: ReviewContext,
  runId: string,
  options: RecordOptions & { boundary?: ReviewBoundary } = {},
): Promise<FinalizeResult | ChangeFinalizeResult> {
  const target = await resolveRun(ctx, runId);
  if (target.scope === "change") {
    return finalizeChangeRun(ctx, target, options);
  }
  const initialBlock = await readSliceReview(target.slice.statusPath);
  const initial = await readRunRecord(target.slice, target.run);
  await assertRunWritable(target, initialBlock, initial);
  if (!initial) {
    throw new ChangeCommandError("finalize_blocked", `Run ${target.runId} has no recorded report to finalize.`, { run: target.runId, open: [] });
  }
  assertFinalizable(target, initial);

  // Hashing reads the working tree and the snapshot refs; done before taking the lock.
  const checkouts = await sliceRepoCheckouts(ctx, target.slice);
  const covered = await runCoveredFiles(ctx, target.slice, target.run, {
    ...(typeof initialBlock?.start_ref === "string" ? { startRef: initialBlock.start_ref } : {}),
    ...(options.boundary ? { boundary: options.boundary } : {}),
  });
  const fingerprint = await computeFingerprint(checkouts, covered.files);
  const now = options.now ?? new Date();

  let result: FinalizeResult | undefined;
  await updateSliceReview(
    ctx,
    target.slice.id,
    async (block) => {
      const record = await readRunRecord(target.slice, target.run);
      await assertRunWritable(target, block, record);
      if (!record) {
        throw new ChangeCommandError("finalize_blocked", `Run ${target.runId} has no recorded report to finalize.`, { run: target.runId, open: [] });
      }
      const state = assertFinalizable(target, record);
      const decisionIds = await planDecisionIds(ctx.weaveRoot, covered.weavePaths, record.findings);
      const planBasis = await computePlanBasis(ctx.changePath, target.slice.id, decisionIds, { weaveRoot: ctx.weaveRoot });
      const tasks = runTasks(await readTasks(target.slice));
      const counts = sliceCounts(record.findings, tasks);
      if (options.independent === false) record.independent = false;
      record.tasks = tasks;
      record.outcome = { state, at: now.toISOString(), reviewed_task_total: tasks.total };
      record.updated_at = now.toISOString();
      await writeRunRecord(target.slice, record);
      // The latest review that covered a file owns it: earlier slices stop fingerprinting it.
      const released = await releaseOwnership(ctx, covered.files, target.slice.id, { now });
      result = {
        status: "ok",
        run: target.runId,
        state,
        counts,
        fingerprint_files: Object.values(fingerprint).reduce((sum, files) => sum + Object.keys(files).length, 0),
        reviewed_task_total: tasks.total,
        released_from: released,
        from_main: covered.fromMain,
        warnings: covered.warnings,
      };
      return {
        ...(block ?? {}),
        state,
        latest_run: target.run,
        reviewed_task_total: tasks.total,
        merge_base: covered.mergeBase,
        plan_basis: planBasis,
        fingerprint,
        counts,
        independent: record.independent,
        partial: record.partial || block?.partial === true,
      };
    },
    { now },
  );
  return result as FinalizeResult;
}

export interface FailRunResult {
  status: "ok";
  run: string;
  state: "review_failed";
}

// A failed change run leaves the change review `not_started`: no final review has finished. A new
// run starts with `package --change`.

// `record --failed`: the reviewer twice returned an invalid report. The run is closed as
// `review_failed`; a new review starts with `package --slice` again.
export async function failRun(ctx: ReviewContext, runId: string, options: RecordOptions = {}): Promise<FailRunResult> {
  const target = await resolveRun(ctx, runId);
  await assertRunWritable(target, await readRunBlock(ctx, target), await readRunRecord(target.slice, target.run));
  const modelLevel = await packageModelLevel(ctx, target);
  const tasks = await runTasksFor(ctx, target);
  const now = options.now ?? new Date();
  await updateRunBlock(
    ctx,
    target,
    async (block) => {
      const existing = await readRunRecord(target.slice, target.run);
      await assertRunWritable(target, block, existing);
      const record = existing ?? newRunRecord(ctx, target, block, modelLevel, now);
      if (options.independent === false) record.independent = false;
      record.tasks = tasks;
      record.outcome = { state: "review_failed", at: now.toISOString() };
      record.updated_at = now.toISOString();
      await writeRunRecord(target.slice, record);
      if (target.scope === "change") {
        return { ...(block ?? {}), state: "not_started", latest_run: target.run };
      }
      return { ...(block ?? {}), state: "review_failed", latest_run: target.run, independent: record.independent };
    },
    { now },
  );
  return { status: "ok", run: target.runId, state: "review_failed" };
}

// --- change runs -----------------------------------------------------------------------------

// One `final_only.minor_sort` entry, resolved: a Minor of this change run (`own`), or a slice run's
// Minor or ruling (`slice`, copied into the change run's findings; `ruling` when it names a slice
// review's ruling).
export interface ResolvedMinorSort {
  id: string;
  class: MinorSortClass;
  slice?: StoredFinding & { origin_run: string };
  ruling?: boolean;
}

// Checks a change report's `final_only.minor_sort` against the change (PRD FR12: the final
// reviewer sorts the saved Minors and the slice reviews' rulings). Each entry must name either a
// Minor this report (or an earlier report of the run) raised, by `F<n>`, `f<N>-F<n>`, or
// `change/f<N>-F<n>`, or a Minor or ruling a slice run recorded, by its full id (`02/r1-F4`; the
// slice part may be a unique leading number). A slice ruling may have any severity. Anything else
// makes the report invalid (exit 4).
export async function resolveMinorSort(
  ctx: ReviewContext,
  target: ResolvedRun,
  report: ValidatedReport,
  existing: RunRecord | undefined,
): Promise<ResolvedMinorSort[]> {
  const entries = report.final_only?.minor_sort ?? [];
  if (entries.length === 0) return [];
  const own = new Map<string, Severity>();
  for (const finding of existing?.findings ?? []) if (finding.source !== "minor_sort") own.set(finding.id, finding.severity);
  for (const finding of report.findings) own.set(scopeFindingId(target.runId, finding.id), finding.severity);

  const sliceFindings = new Map<string, StoredFinding & { origin_run: string }>();
  const slices = await listSlices(ctx);
  for (const slice of slices) {
    for (const record of await readRunRecords(slice).catch(() => [] as RunRecord[])) {
      for (const finding of record.findings) {
        if (finding.source === "minor_sort") continue;
        sliceFindings.set(finding.id, { ...finding, origin_run: record.run });
      }
    }
  }

  const errors: string[] = [];
  const seen = new Set<string>();
  const resolved: ResolvedMinorSort[] = [];
  entries.forEach((entry, index) => {
    const where = `final_only.minor_sort[${index}].finding`;
    const value = entry.finding.trim();
    let id: string | undefined;
    let severity: Severity | undefined;
    let slice: (StoredFinding & { origin_run: string }) | undefined;
    const ownMatch = /^(?:change\/)?(?:(f\d+)-)?(F\d+)$/i.exec(value);
    if (ownMatch && (ownMatch[1] === undefined || ownMatch[1].toLowerCase() === target.run)) {
      id = scopeFindingId(target.runId, ownMatch[2].toUpperCase());
      severity = own.get(id);
    } else {
      const sliceMatch = /^(.+)\/(r\d+)-(F\d+)$/i.exec(value);
      if (sliceMatch) {
        const candidates = slices.filter((candidate) => candidate.id === sliceMatch[1] || candidate.id.startsWith(`${sliceMatch[1]}-`));
        const sliceId = candidates.find((candidate) => candidate.id === sliceMatch[1])?.id ?? (candidates.length === 1 ? candidates[0].id : undefined);
        if (sliceId) {
          id = `${sliceId}/${sliceMatch[2].toLowerCase()}-${sliceMatch[3].toUpperCase()}`;
          slice = sliceFindings.get(id);
          severity = slice?.severity;
        }
      }
    }
    if (!id || !severity) {
      errors.push(`${where}: ${value} is not a finding of this change`);
      return;
    }
    const ruling = slice?.resolution?.as === "ruling";
    if (severity !== "minor" && !ruling) {
      errors.push(`${where}: ${value} is ${severity}, not Minor; only Minor findings and slice review rulings are sorted`);
      return;
    }
    if (seen.has(id)) {
      errors.push(`${where}: ${value} is sorted twice`);
      return;
    }
    seen.add(id);
    resolved.push({ id, class: entry.class, ...(slice ? { slice } : {}), ...(ruling ? { ruling: true } : {}) });
  });
  if (errors.length > 0) {
    throw reportInvalid(errors);
  }
  return resolved;
}

// Applies the final reviewer's sort to a change run's findings. A slice Minor is copied in under
// its slice id (`source: minor_sort`). `can_wait` parks an unresolved Minor (`by_sort`); `must_fix`
// leaves it open for the fix batch, undoing an earlier sort's parking. A Minor the agent already
// fixed or ruled on keeps its resolution.
// A slice ruling sorted `must_fix` is reopened: copied in the same way, unresolved, so it joins the
// fix batch. Sorted `can_wait`, it stays parked as the slice's ruling and is not copied; an
// unresolved copy left by an earlier `must_fix` sort of the run is dropped. The slice's own files
// are never rewritten.
export function applyMinorSort(findings: StoredFinding[], sort: ResolvedMinorSort[], now: Date): StoredFinding[] {
  let next = findings.map((finding) => ({ ...finding }));
  for (const entry of sort) {
    let index = next.findIndex((finding) => finding.id === entry.id);
    if (entry.ruling && entry.class === "can_wait") {
      if (index !== -1 && next[index].resolution === null) next = next.filter((_, position) => position !== index);
      else if (index !== -1) next[index] = { ...next[index], final_sort: entry.class };
      continue;
    }
    if (index === -1) {
      if (!entry.slice) continue;
      const { round: _round, source: _source, origin_run, ...rest } = entry.slice;
      next.push({ ...rest, id: entry.id, foreign_file: false, resolution: null, source: "minor_sort", origin_run });
      index = next.length - 1;
    }
    const finding = next[index];
    const parkedBySort = finding.resolution?.as === "parked" && finding.resolution.by_sort === true;
    let resolution = finding.resolution;
    if (entry.class === "can_wait" && resolution === null) {
      resolution = { as: "parked", by_sort: true, at: now.toISOString() };
    } else if (entry.class === "must_fix" && parkedBySort) {
      resolution = null;
    }
    next[index] = { ...finding, final_sort: entry.class, resolution };
  }
  return next;
}

export interface ChangeVerdictSummary {
  inputs: VerdictInputs;
  counts: ChangeReviewCounts;
  verdict: ChangeVerdict;
}

// What is still open across the change after (or during) its final review, as verdict inputs and
// change counts. Read from each slice's latest run and from the change run `record`:
// - an unresolved plan finding in any of them: a plan problem
// - a ruling: an agreed Critical ruling (not ready) or a parked ruling; a plan finding a person
//   dismissed is their own ruling, so it is a parked ruling
// - a parked Minor: can wait (slice Minors the final reviewer sorted are counted once, from the
//   change run, so a must-fix one stays open until it is fixed or ruled on)
// - human checks: every task's `Human check:` step plus every fix marked "needs your check"
// - any other unresolved finding
export async function changeVerdictSummary(ctx: ReviewContext, record: RunRecord | undefined, options: { partial: boolean }): Promise<ChangeVerdictSummary> {
  const copied = new Set((record?.findings ?? []).filter((finding) => finding.source === "minor_sort").map((finding) => finding.id));
  const tally = { plan: 0, agreedCritical: 0, parkedRulings: 0, canWait: 0, human: 0, other: 0 };
  const count = (findings: StoredFinding[], fromSlice: boolean): void => {
    for (const finding of findings) {
      if (fromSlice && copied.has(finding.id)) continue;
      const resolution = finding.resolution;
      if (resolution === null) {
        if (finding.kind === "plan") tally.plan += 1;
        else tally.other += 1;
      } else if (resolution.as === "ruling") {
        if (resolution.agreed && finding.severity === "critical") tally.agreedCritical += 1;
        else tally.parkedRulings += 1;
      } else if (resolution.as === "parked") {
        tally.canWait += 1;
      } else if (resolution.as === "dismissed") {
        // A person's dismissal is their own ruling (FR27), never an agreed Critical one: parked.
        tally.parkedRulings += 1;
      }
    }
    tally.human += fixesNeedingCheck(findings).length;
  };
  for (const slice of await listSlices(ctx)) {
    const latest = (await readRunRecords(slice).catch(() => [] as RunRecord[]))[0];
    if (latest) count(latest.findings, true);
  }
  if (record) count(record.findings, false);
  tally.human += (record?.tasks ?? (await changeRunTasks(ctx))).human_checks.length;

  const inputs: VerdictInputs = {
    planProblemsOpen: tally.plan,
    partial: options.partial,
    agreedCriticalRulings: tally.agreedCritical,
    canWaitMinors: tally.canWait,
    // Every ruling other than an agreed Critical one is a parked item (PRD § Verdicts).
    disagreedRulings: tally.parkedRulings,
    humanChecks: tally.human,
    otherOpen: tally.other,
  };
  return {
    inputs,
    verdict: deriveVerdict(inputs),
    counts: {
      open_rulings: tally.agreedCritical + tally.parkedRulings,
      parked_items: tally.canWait + tally.parkedRulings + tally.human,
      plan_problems_open: tally.plan,
    },
  };
}

export interface ChangeFinalizeResult {
  status: "ok";
  run: string;
  scope: "change";
  state: ChangeVerdict;
  verdict: ChangeVerdict;
  counts: ChangeReviewCounts;
  partial: boolean;
  fingerprint_files: number;
  reviewed_task_total: number;
  // Slices whose fingerprint lost files the change review now owns.
  released_from: string[];
  warnings: string[];
}

// `record --run change/f<N> --finalize`: derives the verdict (`deriveVerdict` over
// `changeVerdictSummary`), stores it on the change with the counts, and takes ownership of every
// file the change run covered: they leave every slice fingerprint and enter the change fingerprint,
// computed now, after the fix batch, so the batch is part of the baseline. A missing repo or an
// unknown diff base makes the run partial (verdict at best `not_ready`). Unlike a slice run, open
// findings do not block: they make the verdict `not_ready`. A fix batch that started but was never
// packaged gives `round_not_ended`.
async function finalizeChangeRun(ctx: ReviewContext, target: ResolvedRun, options: RecordOptions & { boundary?: ReviewBoundary }): Promise<ChangeFinalizeResult> {
  const initial = await readRunRecord(target.slice, target.run);
  await assertRunWritable(target, await readChangeReview(ctx.changePath), initial);
  if (!initial) {
    throw new ChangeCommandError("finalize_blocked", `Run ${target.runId} has no recorded report to finalize.`, { run: target.runId, open: [] });
  }
  assertFixBatchEnded(target, initial);

  // Hashing reads the working tree and the snapshot refs; done before taking the lock.
  const checkouts = await changeRepoCheckouts(ctx);
  const covered = await changeCoveredFiles(ctx, target.run, options.boundary ? { boundary: options.boundary } : {});
  const fingerprint = await computeFingerprint(checkouts, covered.files);
  const coverageGap = covered.warnings.some((warning) => /^(repo_missing|end_ref_missing|base_unknown):/.test(warning));
  const now = options.now ?? new Date();

  let result: ChangeFinalizeResult | undefined;
  await updateChangeReview(
    ctx,
    async (block) => {
      const record = await readRunRecord(target.slice, target.run);
      await assertRunWritable(target, block, record);
      if (!record) {
        throw new ChangeCommandError("finalize_blocked", `Run ${target.runId} has no recorded report to finalize.`, { run: target.runId, open: [] });
      }
      assertFixBatchEnded(target, record);
      const decisionIds = await planDecisionIds(ctx.weaveRoot, covered.weavePaths, record.findings);
      const planBasis = await computeChangePlanBasis(ctx.changePath, decisionIds, { weaveRoot: ctx.weaveRoot });
      const tasks = await changeRunTasks(ctx);
      const partial = record.partial || block?.partial === true || coverageGap;
      if (options.independent === false) record.independent = false;
      record.tasks = tasks;
      record.partial = partial;
      const summary = await changeVerdictSummary(ctx, record, { partial });
      record.outcome = { state: summary.verdict, at: now.toISOString(), reviewed_task_total: tasks.total, counts: summary.counts };
      record.updated_at = now.toISOString();
      await writeRunRecord(target.slice, record);
      // The change review is the latest review of every file it covered: no slice fingerprints them.
      const released = await releaseOwnership(ctx, covered.files, undefined, { now });
      result = {
        status: "ok",
        run: target.runId,
        scope: "change",
        state: summary.verdict,
        verdict: summary.verdict,
        counts: summary.counts,
        partial,
        fingerprint_files: Object.values(fingerprint).reduce((sum, files) => sum + Object.keys(files).length, 0),
        reviewed_task_total: tasks.total,
        released_from: released,
        warnings: covered.warnings,
      };
      return {
        ...(block ?? {}),
        state: summary.verdict,
        latest_run: target.run,
        fingerprint,
        plan_basis: planBasis,
        merge_base: covered.mergeBase,
        reviewed_task_total: tasks.total,
        counts: summary.counts,
        partial,
      };
    },
    { now },
  );
  return result as ChangeFinalizeResult;
}

function assertFixBatchEnded(target: ResolvedRun, record: RunRecord): void {
  const open = (record.rounds ?? []).find((round) => round.patch === undefined);
  if (open) {
    throw new ChangeCommandError(
      "round_not_ended",
      `The fix batch of run ${target.runId} started but was never packaged. Run \`weave review package --run ${target.runId} --fix-round ${open.round}\` before finalizing.`,
      { run: target.runId, round: open.round },
    );
  }
}

// A plan finding a person resolved with `--as dismissed --by <name>`: the person's own ruling
// (PRD FR27). It has no basis, so it never reopens.
export interface Dismissal {
  finding: string;
  run: string;
  // The slice of a slice run; null for a change run.
  slice: string | null;
  severity: string;
  kind: string;
  detail: string;
  by: string;
  at?: string;
}

// Every dismissed finding of every slice run and change run of the change.
export async function collectDismissals(ctx: ReviewContext): Promise<Dismissal[]> {
  const sources: Array<{ slice: string | null; location: SliceLocation }> = [
    ...(await listSlices(ctx)).map((slice) => ({ slice: slice.id, location: slice })),
    { slice: null, location: changeRunLocation(ctx) },
  ];
  const dismissals: Dismissal[] = [];
  for (const source of sources) {
    for (const record of await readRunRecords(source.location).catch(() => [] as RunRecord[])) {
      for (const finding of record.findings) {
        if (finding.resolution?.as !== "dismissed") continue;
        dismissals.push({
          finding: finding.id,
          run: record.run,
          slice: source.slice,
          severity: finding.severity,
          kind: finding.kind,
          detail: finding.detail ?? "",
          by: finding.resolution.by,
          ...(finding.resolution.at ? { at: finding.resolution.at } : {}),
        });
      }
    }
  }
  return dismissals;
}

// The readable change record `<change>/review.md`: the verdict, every change run newest first, and
// "All rulings": every ruling from every slice run and change run, with its reasoning, cost if
// wrong, and whether it reopened, plus each plan finding a person dismissed (the person's own
// ruling). A slice ruling the latest change run sorted says so.
export function renderChangeReviewRecord(
  runs: RunRecord[],
  options: { changeId: string; rulings: { settled: Ruling[]; reopened: Ruling[]; dismissed?: Dismissal[] } },
): string {
  const ordered = [...runs].sort((left, right) => runNumber(right.run) - runNumber(left.run));
  const reopenedIds = new Set(options.rulings.reopened.map((ruling) => ruling.finding));
  const out: string[] = [`# Review record: change ${options.changeId}`, ""];
  out.push("Written by `weave review record` from `review/*.findings.json` and the slices' review records. Do not edit by hand. Newest run first.", "");

  out.push("## Verdict", "");
  const decided = ordered.find((run) => run.outcome && run.outcome.state !== "review_failed");
  if (!decided?.outcome) {
    out.push("No verdict yet: the final review has not been finalized.", "");
  } else {
    const counts = decided.outcome.counts;
    const parked = counts && decided.outcome.state === "ready_with_parked_items" ? ` (${counts.parked_items})` : "";
    out.push(`- Verdict: ${label(decided.outcome.state)}${parked}`);
    out.push(`- From run: \`${decided.run}\` (${decided.outcome.at})`);
    if (counts) {
      out.push(`- Rulings: ${counts.open_rulings}; parked items: ${counts.parked_items}; plan problems open: ${counts.plan_problems_open}`);
    }
    out.push(`- Partial: ${decided.partial ? "yes (part of the change could not be reviewed)" : "no"}`);
    out.push("");
  }
  if (ordered.length === 0) {
    out.push("No final review runs recorded yet.", "");
  }
  for (const run of ordered) {
    out.push(...renderRun(run, reopenedIds));
  }

  out.push("## All rulings", "");
  const entries: Array<{ order: string; ruling?: Ruling; dismissal?: Dismissal }> = [
    ...[...options.rulings.settled, ...options.rulings.reopened].map((ruling) => ({ order: rulingOrder(ruling), ruling })),
    ...(options.rulings.dismissed ?? []).map((dismissal) => ({ order: rulingOrder(dismissal), dismissal })),
  ];
  const all = entries.sort((left, right) => left.order.localeCompare(right.order));
  // The final reviewer's sort of slice rulings, from the newest change run that recorded a report.
  const sortedBy = ordered.find((run) => run.final_only !== undefined || run.findings.some((finding) => finding.final_sort !== undefined));
  if (all.length === 0) {
    out.push("None.", "");
  } else {
    out.push("Every ruling from every slice review and the final review, and every plan problem a person dismissed (their own ruling), oldest run first.", "");
    for (const { ruling, dismissal } of all) {
      if (dismissal) {
        const where = dismissal.slice ? `slice \`${dismissal.slice}\`` : "final review";
        out.push(`- \`${dismissal.finding}\` (${dismissal.severity}, ${dismissal.kind}, ${where}, the person's ruling): dismissed by ${oneLine(dismissal.by)}${dismissal.at ? ` (${dismissal.at})` : ""}`);
        out.push(`  - Finding: ${oneLine(dismissal.detail)}`);
        out.push("  - Cost if wrong: not recorded; the person dismissed the finding");
        continue;
      }
      if (!ruling) continue;
      const where = ruling.slice ? `slice \`${ruling.slice}\`` : "final review";
      out.push(`- \`${ruling.finding}\` (${ruling.severity}, ${ruling.kind}, ${where}, ${ruling.agreed ? "agreed the finding is real" : "disagreed"}): ${oneLine(ruling.reason)}`);
      out.push(`  - Finding: ${oneLine(ruling.detail)}`);
      out.push(`  - Cost if wrong: ${oneLine(ruling.cost_if_wrong)}`);
      out.push(`  - Reopened: ${ruling.changed.length > 0 ? `yes (changed since the ruling: ${ruling.changed.map((entry) => `\`${entry}\``).join(", ")})` : "no"}`);
      const sort = ruling.slice && sortedBy ? finalSortOf(sortedBy, ruling.finding) : undefined;
      if (sort) out.push(`  - Final review sort: ${sort}`);
    }
    out.push("");
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

// How a change run sorted a slice ruling, with what became of a must-fix one.
function finalSortOf(run: RunRecord, findingId: string): string | undefined {
  const copy = run.findings.find((finding) => finding.id === findingId && finding.source === "minor_sort");
  if (copy?.final_sort === "must_fix") return `must fix, reopened in \`${run.run}\` (now ${findingStatus(copy)})`;
  const entry = (run.final_only?.minor_sort ?? []).find((candidate) => candidate.finding === findingId);
  return entry?.class === "can_wait" || copy?.final_sort === "can_wait" ? `can wait (\`${run.run}\`)` : undefined;
}

// Slice runs first by slice, then change runs, each by run number.
function rulingOrder(ruling: Pick<Ruling, "run" | "slice" | "finding">): string {
  const run = ruling.run.split("/").pop() ?? ruling.run;
  return `${ruling.slice === null ? "~" : ruling.slice}|${String(runNumber(run)).padStart(6, "0")}|${ruling.finding}`;
}

// --- repair ----------------------------------------------------------------------------------

export interface RepairedSlice {
  slice: string;
  run: string;
  state: StoredSliceState;
  written: boolean;
  // Finalize-only fields rebuilt from the current tree because the block had lost them.
  recomputed: string[];
  warnings: string[];
}

// `status --repair`: rebuilds each slice's `review:` block from its latest `review/*.findings.json`
// (for example after an older CLI dropped the block). Unknown keys in an existing block are kept.
// Fields only finalize computes are recomputed from the current tree only when the latest run was
// finalized and the block no longer holds them for that run. A block already ahead of the findings
// (a newer packaged run without a report) is left alone.
export async function repairSliceReviews(
  ctx: ReviewContext,
  options: { slice?: SliceLocation; now?: Date; boundary?: ReviewBoundary } = {},
): Promise<RepairedSlice[]> {
  const slices = options.slice ? [options.slice] : await listSlices(ctx);
  const repaired: RepairedSlice[] = [];
  for (const slice of slices) {
    if (!(await pathExists(slice.statusPath))) continue;
    const latest = (await readRunRecords(slice))[0];
    if (!latest) continue;
    const current = await readSliceReview(slice.statusPath);
    if (typeof current?.latest_run === "string" && runNumber(current.latest_run) > runNumber(latest.run)) continue;

    const run = latest.run.split("/").pop() ?? latest.run;
    const state = (latest.outcome?.state ?? deriveSliceState(latest.findings).state) as StoredSliceState;
    const finalized = latest.outcome?.state === "reviewed" || latest.outcome?.state === "reviewed_with_rulings";
    const sameRun = current?.latest_run === run;
    const recomputed: string[] = [];
    const extra: Partial<SliceReviewBlock> = {};
    let warnings: string[] = [];

    if (finalized) {
      extra.reviewed_task_total = latest.outcome?.reviewed_task_total ?? latest.tasks.total;
      const needFingerprint = !(sameRun && isRecord(current?.fingerprint));
      const needPlanBasis = !(sameRun && isRecord(current?.plan_basis));
      const needMergeBase = !(sameRun && isRecord(current?.merge_base));
      if (needFingerprint || needPlanBasis || needMergeBase) {
        const covered = await runCoveredFiles(ctx, slice, run, {
          ...(latest.start_ref ? { startRef: latest.start_ref } : {}),
          ...(options.boundary ? { boundary: options.boundary } : {}),
        });
        warnings = covered.warnings;
        if (needFingerprint) {
          const owned = await withoutLaterOwners(ctx, slice.id, latest.outcome?.at, covered.files);
          extra.fingerprint = await computeFingerprint(await sliceRepoCheckouts(ctx, slice), owned);
          recomputed.push("fingerprint");
        }
        if (needPlanBasis) {
          const ids = await planDecisionIds(ctx.weaveRoot, covered.weavePaths, latest.findings);
          extra.plan_basis = await computePlanBasis(ctx.changePath, slice.id, ids, { weaveRoot: ctx.weaveRoot });
          recomputed.push("plan_basis");
        }
        if (needMergeBase) extra.merge_base = covered.mergeBase;
      }
    }

    let written = false;
    await updateSliceReview(
      ctx,
      slice.id,
      (block) => {
        const next: SliceReviewBlock = {
          ...(block ?? {}),
          ...(latest.start_ref && !block?.start_ref ? { start_ref: latest.start_ref } : {}),
          state,
          latest_run: run,
          counts: sliceCounts(latest.findings, latest.tasks),
          independent: latest.independent,
          partial: latest.partial,
          ...extra,
        };
        written = JSON.stringify(withoutStamp(block)) !== JSON.stringify(withoutStamp(next));
        return next;
      },
      options.now ? { now: options.now } : {},
    );
    repaired.push({ slice: slice.id, run: latest.run, state, written, recomputed, warnings });
  }
  return repaired;
}

// --- internals -------------------------------------------------------------------------------

// `files` without those a later finalized review of another slice now owns (its fingerprint holds
// them and its run finalized after `finalizedAt`), so a repaired fingerprint never takes a file
// back from a newer review.
async function withoutLaterOwners(
  ctx: ReviewContext,
  sliceId: string,
  finalizedAt: string | undefined,
  files: Record<string, string[]>,
): Promise<Record<string, string[]>> {
  const taken = new Set<string>();
  for (const other of await listSlices(ctx)) {
    if (other.id === sliceId || !(await pathExists(other.statusPath))) continue;
    const block = await readSliceReview(other.statusPath);
    if (!isRecord(block?.fingerprint)) continue;
    const latest = (await readRunRecords(other).catch(() => [])).find((record) => record.outcome?.state === "reviewed" || record.outcome?.state === "reviewed_with_rulings");
    if (!latest?.outcome || (finalizedAt && latest.outcome.at <= finalizedAt)) continue;
    for (const [repo, entries] of Object.entries(block.fingerprint)) {
      for (const file of Object.keys(isRecord(entries) ? entries : {})) taken.add(`${repo}:${file}`);
    }
  }
  // A change review finalized later owns every file it fingerprints.
  const changeBlock = await readChangeReview(ctx.changePath).catch(() => undefined);
  if (isRecord(changeBlock?.fingerprint)) {
    const decided = (await readRunRecords(changeRunLocation(ctx)).catch(() => [] as RunRecord[])).find((record) => record.outcome && record.outcome.state !== "review_failed");
    if (decided?.outcome && (!finalizedAt || decided.outcome.at > finalizedAt)) {
      for (const [repo, entries] of Object.entries(changeBlock.fingerprint)) {
        for (const file of Object.keys(isRecord(entries) ? entries : {})) taken.add(`${repo}:${file}`);
      }
    }
  }
  return Object.fromEntries(Object.entries(files).map(([repo, paths]) => [repo, paths.filter((file) => !taken.has(`${repo}:${file}`))]));
}

// The `plan_basis` a run waiting on a person is compared with: the one `package` stored for the
// run, plus the decisions its findings cite, hashed now when the basis does not hold them yet.
// Existing hashes are kept, so a plan edit made while the slice waits is never absorbed.
async function waitingPlanBasis(ctx: ReviewContext, sliceId: string, stored: unknown, findings: StoredFinding[]): Promise<Record<string, unknown>> {
  const cited = await planDecisionIds(ctx.weaveRoot, [], findings);
  if (!isRecord(stored)) {
    return computePlanBasis(ctx.changePath, sliceId, cited, { weaveRoot: ctx.weaveRoot });
  }
  const decisions = isRecord(stored.decisions) ? { ...stored.decisions } : {};
  const missing = cited.filter((id) => !(id in decisions));
  if (missing.length === 0) return stored;
  Object.assign(decisions, await decisionHashes(ctx.weaveRoot, missing));
  return { ...stored, decisions: Object.fromEntries(Object.entries(decisions).sort(([left], [right]) => left.localeCompare(right))) };
}

function newRunRecord(ctx: ReviewContext, target: ResolvedRun, block: RunBlock | undefined, modelLevel: string | null, now: Date): RunRecord {
  const change = target.scope === "change";
  return {
    run: target.runId,
    scope: change ? { kind: "change" } : { kind: "slice", slice: target.slice.id },
    independent: true,
    partial: block?.partial === true,
    model_level: modelLevel,
    start_ref: !change && typeof block?.start_ref === "string" ? block.start_ref : null,
    end_ref: change ? changeRunRef(ctx.changeId, target.run, "end") : sliceRunEndRef(ctx.changeId, target.slice.id, target.run),
    reports: [],
    strengths: [],
    findings: [],
    declined: [],
    verdict: null,
    tasks: { total: 0, untested: [], human_checks: [] },
    recorded_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

// A run accepts writes while it is its scope's latest run (the slice's, or the change's for a
// change run) and has not been finalized or failed.
export async function assertRunWritable(target: ResolvedRun, block: { latest_run?: unknown } | undefined, record: RunRecord | undefined): Promise<void> {
  const owner = target.scope === "change" ? "change" : target.slice.id;
  const packageCommand = target.scope === "change" ? "weave review package --change" : `weave review package --slice ${target.slice.id}`;
  if (record?.outcome) {
    throw new ChangeCommandError("run_closed", `Run ${target.runId} is already ${label(record.outcome.state)}. Start a new run with \`${packageCommand}\`.`, {
      run: target.runId,
      state: record.outcome.state,
    });
  }
  const latest = typeof block?.latest_run === "string" ? block.latest_run : undefined;
  if (latest && runNumber(latest) > runNumber(target.run)) {
    throw new ChangeCommandError("run_closed", `Run ${target.runId} is not the ${target.scope === "change" ? "change's" : "slice's"} latest run (${owner}/${latest}).`, {
      run: target.runId,
      latest_run: `${owner}/${latest}`,
    });
  }
  if (!record && latest !== target.run) {
    throw new ChangeCommandError("run_not_found", `No packaged run ${target.runId}. Run \`${packageCommand}\` first.`, {
      run: target.runId,
      ...(latest ? { latest_run: `${owner}/${latest}` } : {}),
    });
  }
}

function assertFinalizable(target: ResolvedRun, record: RunRecord): "reviewed" | "reviewed_with_rulings" {
  const derived = deriveSliceState(record.findings, { finalize: true });
  if (derived.state !== "reviewed" && derived.state !== "reviewed_with_rulings") {
    const plan = openPlanFindings(record.findings);
    throw new ChangeCommandError(
      "finalize_blocked",
      plan.length > 0
        ? `Run ${target.runId} cannot be finalized: plan problems are waiting on a person (${plan.join(", ")}).`
        : `Run ${target.runId} cannot be finalized: every finding needs a fix, a ruling, or (Minors) parking first. Open: ${derived.open.join(", ")}.`,
      { run: target.runId, open: derived.open, plan_findings_open: plan },
    );
  }
  return derived.state;
}

async function buildResolution(
  as: string,
  input: ResolutionInput,
  finding: StoredFinding,
  now: Date,
  basis: () => Promise<RulingBasis>,
): Promise<Resolution> {
  const at = now.toISOString();
  switch (as) {
    case "ruling": {
      const agreed = parseBoolean(input.agreed);
      const missing = [
        ...(agreed === undefined ? ["--agreed true|false"] : []),
        ...(!input.reason?.trim() ? ["--reason <text>"] : []),
        ...(!input.cost?.trim() ? ["--cost <text>"] : []),
      ];
      if (missing.length > 0 || agreed === undefined) {
        throw new ChangeCommandError("invalid_resolution", `A ruling needs ${missing.join(", ")}.`, { finding: finding.id, missing });
      }
      return { as: "ruling", agreed, reason: input.reason!.trim(), cost_if_wrong: input.cost!.trim(), basis: await basis(), at };
    }
    case "parked":
      if (finding.severity !== "minor") {
        throw new ChangeCommandError("invalid_resolution", `Only Minor findings can be parked; ${finding.id} is ${finding.severity}.`, {
          finding: finding.id,
          severity: finding.severity,
        });
      }
      return { as: "parked", at };
    case "dismissed":
      if (!input.by?.trim()) {
        throw new ChangeCommandError("invalid_resolution", "--as dismissed needs --by <person>: the person who dismissed the finding.", { finding: finding.id });
      }
      return { as: "dismissed", by: input.by.trim(), at };
    default:
      throw new ChangeCommandError("invalid_resolution", `--as takes fixed, ruling, parked, or dismissed, not ${as}.`, { finding: finding.id, as });
  }
}

// `--as fixed --round <n>`: the round must have been packaged, so its patch exists. The fix carries
// the round's patch and the files it touched, and is marked "needs your check" when the slice's
// tasks have a `Human check:` step.
function fixedResolution(target: ResolvedRun, record: RunRecord, input: ResolutionInput, tasks: RunTasks, now: Date): Resolution {
  const round = parseRoundNumber(input.round);
  if (round === undefined) {
    throw new ChangeCommandError("invalid_resolution", "--as fixed needs --round <n>: the fix round, a whole number from 1.", {
      finding: input.finding,
      round: input.round ?? null,
    });
  }
  const entry = (record.rounds ?? []).find((candidate) => candidate.round === round);
  if (!entry?.patch) {
    throw new ChangeCommandError(
      "round_not_found",
      entry
        ? `Round ${round} of run ${target.runId} has no patch yet. Run \`weave review package --run ${target.runId} --fix-round ${round}\` first.`
        : `Run ${target.runId} has no fix round ${round}.`,
      { run: target.runId, round, rounds: (record.rounds ?? []).map((candidate) => candidate.round) },
    );
  }
  return {
    as: "fixed",
    round,
    patch: entry.patch,
    files: [...(entry.files ?? [])],
    needs_your_check: tasks.human_checks.length > 0,
    at: now.toISOString(),
  };
}

// A fix round number: a whole number from 1, or undefined.
export function parseRoundNumber(value: unknown): number | undefined {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(text)) return undefined;
  const round = Number.parseInt(text, 10);
  return round >= 1 ? round : undefined;
}

// Accepts `F3`, `r1-F3`, `02/r1-F3`, or `02-work/r1-F3` for the run being written (`F3`, `f1-F3`,
// or `change/f1-F3` for a change run), or any id in `known` as written (a change run holds slice
// Minors under their slice ids).
function normalizeFindingId(target: ResolvedRun, value: string, known?: ReadonlySet<string>): string {
  if (known?.has(value.trim())) {
    return value.trim();
  }
  if (target.scope === "change") {
    const own = /^(?:change\/)?(?:(f\d+)-)?(F\d+)$/i.exec(value.trim());
    if (!own || (own[1] !== undefined && own[1].toLowerCase() !== target.run)) {
      throw new ChangeCommandError("finding_not_found", `${value} is not a finding of run ${target.runId}.`, { finding: value, run: target.runId });
    }
    return scopeFindingId(target.runId, (own[2] ?? "").toUpperCase());
  }
  const match = /^(?:(.+)\/)?(?:(r\d+)-)?(F\d+)$/i.exec(value.trim());
  const slicePart = match?.[1];
  const runPart = match?.[2]?.toLowerCase();
  const sameSlice = slicePart === undefined || slicePart === target.slice.id || target.slice.id.startsWith(`${slicePart}-`);
  if (!match || !sameSlice || (runPart !== undefined && runPart !== target.run)) {
    throw new ChangeCommandError("finding_not_found", `${value} is not a finding of run ${target.runId}.`, { finding: value, run: target.runId });
  }
  return scopeFindingId(target.runId, match[3].toUpperCase());
}

// Writes a run's findings file and regenerates the slice's `review.md` (the change's, for a change
// run), marking the rulings whose basis changed as reopened. Call it inside the run scope's update
// mutate (`updateRunBlock`), so it runs under the change lock.
export async function writeRunRecord(slice: SliceLocation, record: RunRecord): Promise<void> {
  await writeFileAtomic(runFindingsPath(slice, record.run.split("/").pop() ?? record.run), `${JSON.stringify(record, null, 2)}\n`);
  const records = await readRunRecords(slice);
  if (record.scope.kind === "change") {
    const ctx = reviewContextForChangePath(slice.path);
    const rulings = ctx ? await classifyRulings(ctx, { kind: "change" }) : { settled: [], reopened: [], warnings: [] };
    const dismissed = ctx ? await collectDismissals(ctx) : [];
    await writeFileAtomic(
      reviewRecordPath(slice),
      renderChangeReviewRecord(records, {
        changeId: ctx?.changeId ?? path.basename(slice.path),
        rulings: { settled: rulings.settled, reopened: rulings.reopened, dismissed },
      }),
    );
    return;
  }
  await writeFileAtomic(reviewRecordPath(slice), renderReviewRecord(records, { reopened: await reopenedRulingIds(slice) }));
}

// Ids of the slice's own rulings whose basis changed. Empty when the slice is not laid out as
// `<root>/wiki/changes/<id>/task-slices/<slice>`.
async function reopenedRulingIds(slice: SliceLocation): Promise<Set<string>> {
  const ctx = reviewContextForChangePath(path.resolve(slice.path, "..", ".."));
  if (!ctx) return new Set();
  const { reopened } = await classifyRulings(ctx, { kind: "slice", slice: slice.id });
  return new Set(reopened.map((ruling) => ruling.finding));
}

// --- run scope helpers -----------------------------------------------------------------------

export type RunBlock = SliceReviewBlock | ChangeReviewBlock;

// The `review:` block a run belongs to: the slice's, or the change's for a change run.
export async function readRunBlock(ctx: ReviewContext, target: ResolvedRun): Promise<RunBlock | undefined> {
  return target.scope === "change" ? readChangeReview(ctx.changePath) : readSliceReview(target.slice.statusPath);
}

// Updates the run's `review:` block under the change lock (`updateSliceReview` or
// `updateChangeReview`). Not re-entrant.
export async function updateRunBlock(
  ctx: ReviewContext,
  target: ResolvedRun,
  mutate: (block: RunBlock | undefined) => RunBlock | undefined | Promise<RunBlock | undefined>,
  options: { now?: Date } = {},
): Promise<void> {
  if (target.scope === "change") {
    await updateChangeReview(ctx, async (block) => (await mutate(block)) as ChangeReviewBlock | undefined, options);
  } else {
    await updateSliceReview(ctx, target.slice.id, async (block) => (await mutate(block)) as SliceReviewBlock | undefined, options);
  }
}

// The repos a run covers: the slice's, or every repo of the change.
export async function runRepoCheckouts(ctx: ReviewContext, target: ResolvedRun): Promise<SliceRepoCheckout[]> {
  return target.scope === "change" ? changeRepoCheckouts(ctx) : sliceRepoCheckouts(ctx, target.slice);
}

// The tasks a run reports on: the slice's, or every slice's for a change run.
export async function runTasksFor(ctx: ReviewContext, target: ResolvedRun): Promise<RunTasks> {
  return target.scope === "change" ? changeRunTasks(ctx) : runTasks(await readTasks(target.slice));
}

// Every task of the change: each slice's tasks with ids prefixed by the slice (`02-work/T3`), or
// the change's own `tasks.md` in flat mode.
export async function changeRunTasks(ctx: ReviewContext): Promise<RunTasks> {
  const slices = await listSlices(ctx);
  if (slices.length === 0) {
    return runTasks(await readTasks(changeRunLocation(ctx)));
  }
  const tasks: RunTasks = { total: 0, untested: [], human_checks: [] };
  for (const slice of slices) {
    const own = runTasks(await readTasks(slice));
    tasks.total += own.total;
    tasks.untested.push(...own.untested.map((task) => ({ id: `${slice.id}/${task.id}`, title: task.title })));
    tasks.human_checks.push(...own.human_checks.map((check) => ({ task: `${slice.id}/${check.task}`, step: check.step })));
  }
  return tasks;
}

// `r1-round2` for a slice run's round; `f1-fix` for a change run's single fix batch. The stem of
// the round's patch, check, and package files.
export function runRoundStem(target: ResolvedRun, round: number): string {
  return target.scope === "change" ? `${target.run}-fix` : `${target.run}-round${round}`;
}

async function foreignTestFor(ctx: ReviewContext, target: ResolvedRun): Promise<(location: FindingLocation) => boolean> {
  if (target.scope === "change") {
    // A change review owns every file of the change; nothing is another slice's work.
    return () => false;
  }
  return foreignLocationTest(ctx, target.slice, await readTasks(target.slice));
}

// The block and state after a write to a run. A slice run's state comes from its findings
// (`deriveSliceState`). A change run is `in_progress`, or `not_ready` while a plan problem waits on
// a person; its counts are the verdict counts so far.
async function blockAfterWrite(
  ctx: ReviewContext,
  target: ResolvedRun,
  block: RunBlock | undefined,
  record: RunRecord,
): Promise<{ state: RunScopeState; block: RunBlock }> {
  if (target.scope === "change") {
    const summary = await changeVerdictSummary(ctx, record, { partial: record.partial });
    const state: ChangeReviewState = openPlanFindings(record.findings).length > 0 ? "not_ready" : "in_progress";
    return { state, block: { ...((block as ChangeReviewBlock | undefined) ?? {}), state, latest_run: target.run, counts: summary.counts } };
  }
  const sliceBlock = block as SliceReviewBlock | undefined;
  const state = deriveSliceState(record.findings).state as StoredSliceState;
  const next: SliceReviewBlock = { ...(sliceBlock ?? {}), state, latest_run: target.run, independent: record.independent, counts: sliceCounts(record.findings, record.tasks) };
  if (state === "waiting_on_person") {
    next.plan_basis = await waitingPlanBasis(ctx, target.slice.id, sliceBlock?.plan_basis, record.findings);
  }
  return { state, block: next };
}

function openFindingIds(findings: StoredFinding[]): string[] {
  return findings.filter((finding) => finding.resolution === null).map((finding) => finding.id);
}

async function readTasks(slice: SliceLocation): Promise<string> {
  return (await pathExists(slice.tasksPath)) ? readFile(slice.tasksPath, "utf8") : "";
}

// Whether a finding's location is outside the slice's task `Files:` anchors (always false when the
// tasks name no anchors).
async function foreignLocationTest(ctx: ReviewContext, slice: SliceLocation, tasksMd: string): Promise<(location: FindingLocation) => boolean> {
  const checkouts = await sliceRepoCheckouts(ctx, slice);
  const anchors = parseFileAnchors(tasksMd);
  const ownership = { repos: checkouts.map((repo) => repo.id), anchors };
  return (location) =>
    anchors.length > 0 && labelForeignFiles([{ repo: location.repo, path: location.path, repoDir: repoDirOf(ctx, checkouts, location.repo) }], ownership).foreign.length > 0;
}

export function runTasks(tasksMd: string): RunTasks {
  const evidence = parseTaskEvidence(tasksMd);
  return {
    total: parseTaskSections(tasksMd).filter((task) => task.status !== "invalid").length,
    untested: evidence.untested.map((task) => ({ id: task.id, title: task.title })),
    human_checks: evidence.humanChecks,
  };
}

// The model level hint `package` wrote into the run's package header, when the package is here.
async function packageModelLevel(ctx: ReviewContext, target: ResolvedRun): Promise<string | null> {
  const reservation = path.join(slicePackageDir(ctx, target.slice.id), `${target.run}.package.md`);
  try {
    let text = await readFile(reservation, "utf8");
    const moved = /^Written to (.+)$/m.exec(text);
    if (moved) text = await readFile(moved[1].trim(), "utf8");
    return /model level hint: ([a-z_-]+)/.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

function repoDirOf(ctx: ReviewContext, checkouts: Array<{ id: string; path?: string }>, repo: string): string {
  const checkout = checkouts.find((candidate) => candidate.id === repo);
  return checkout?.path ? path.relative(ctx.weaveRoot, checkout.path).split(path.sep).join("/") : "";
}

function openPlanFindings(findings: StoredFinding[]): string[] {
  return findings.filter((finding) => finding.kind === "plan" && finding.resolution === null).map((finding) => finding.id);
}

function validateFinding(value: unknown, where: string, errors: string[], repos: string[] | undefined): ReportFinding | undefined {
  if (!isRecord(value)) {
    errors.push(`${where}: must be an object`);
    return undefined;
  }
  const before = errors.length;
  let id: string | undefined;
  if (typeof value.id !== "string") {
    errors.push(`${where}.id: required, like "F1"`);
  } else {
    const match = /(?:^|-)F(\d+)$/i.exec(value.id.trim());
    if (match) id = `F${Number.parseInt(match[1], 10)}`;
    else errors.push(`${where}.id: must look like "F1" (got ${JSON.stringify(value.id)})`);
  }
  const severity = enumValue(value.severity, severities, `${where}.severity`, errors, true);
  const kind = enumValue(value.kind, findingKinds, `${where}.kind`, errors, true);

  let location: FindingLocation | undefined;
  if (!isRecord(value.location)) {
    errors.push(`${where}.location: required, an object with repo and path`);
  } else {
    const repo = requiredString(value.location.repo, `${where}.location.repo`, errors)?.trim();
    const rawPath = requiredString(value.location.path, `${where}.location.path`, errors);
    const normalized = rawPath === undefined ? undefined : normalizeLocationPath(rawPath);
    if (rawPath !== undefined && normalized === undefined) {
      errors.push(`${where}.location.path: must be a path inside the repo, relative and without "..", not ${JSON.stringify(rawPath)}`);
    }
    if (repo !== undefined && repos && !repos.includes(repo)) {
      errors.push(`${where}.location.repo: unknown repo ${JSON.stringify(repo)} (known: ${repos.join(", ")})`);
    }
    let line: number | undefined;
    if (value.location.line !== undefined && value.location.line !== null) {
      if (typeof value.location.line === "number" && Number.isInteger(value.location.line) && value.location.line >= 1) {
        line = value.location.line;
      } else {
        errors.push(`${where}.location.line: must be a positive whole number`);
      }
    }
    if (repo !== undefined && normalized !== undefined) {
      location = { repo, path: normalized, ...(line !== undefined ? { line } : {}) };
    }
  }

  let fails: ReportFinding["fails"] | undefined;
  if (!isRecord(value.fails)) {
    errors.push(`${where}.fails: required, an object with type and ref`);
  } else {
    const type = enumValue(value.fails.type, failsTypes, `${where}.fails.type`, errors, true);
    const ref = value.fails.ref === undefined ? "" : typeof value.fails.ref === "string" ? value.fails.ref : undefined;
    if (ref === undefined) errors.push(`${where}.fails.ref: must be a string`);
    if (type !== undefined && ref !== undefined) fails = { type, ref };
  }
  const detail = requiredString(value.detail, `${where}.detail`, errors);
  let fixHint: string | undefined;
  if (value.fix_hint !== undefined && value.fix_hint !== null) {
    if (typeof value.fix_hint === "string") fixHint = value.fix_hint;
    else errors.push(`${where}.fix_hint: must be a string`);
  }

  if (errors.length > before || !id || !severity || !kind || !location || !fails || detail === undefined) {
    return undefined;
  }
  return { id, severity, kind, location, fails, detail, ...(fixHint !== undefined ? { fix_hint: fixHint } : {}) };
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], where: string, errors: string[], required: boolean): T | undefined {
  if (value === undefined) {
    if (required) errors.push(`${where}: required, one of ${allowed.join(", ")}`);
    return undefined;
  }
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : value;
  if (typeof normalized !== "string" || !(allowed as readonly string[]).includes(normalized)) {
    errors.push(`${where}: must be one of ${allowed.join(", ")} (got ${JSON.stringify(value)})`);
    return undefined;
  }
  return normalized as T;
}

function requiredString(value: unknown, where: string, errors: string[]): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${where}: required, a non-empty string`);
    return undefined;
  }
  return value;
}

function reportInvalid(errors: string[]): ChangeCommandError {
  return new ChangeCommandError("report_invalid", `The reviewer report is invalid: ${errors.slice(0, 3).join("; ")}${errors.length > 3 ? ` (and ${errors.length - 3} more)` : ""}`, {
    errors,
  });
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" ? true : normalized === "false" ? false : undefined;
}

function runNumber(run: string): number {
  const match = /[rf](\d+)$/.exec(run);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function label(value: string): string {
  return value.replace(/_/g, " ");
}

function cell(value: string): string {
  return oneLine(value).replace(/\|/g, "\\|");
}

function oneLine(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, " ").trim();
}

function shortHash(value: string): string {
  if (value === absentHash) return value;
  return value.replace(/^sha256:/, "").slice(0, 12);
}

function withoutStamp(block: SliceReviewBlock | undefined): unknown {
  if (!block) return undefined;
  const { updated_at: _ignored, ...rest } = block;
  return rest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
