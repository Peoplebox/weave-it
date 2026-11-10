import { describe, expect, it } from "vitest";
import { ChangeCommandError } from "../src/lib/change-error.js";
import {
  applyResolution,
  deriveSliceState,
  extractReport,
  isFixCheckReport,
  mergeFindings,
  normalizeLocationPath,
  renderReviewRecord,
  sliceCounts,
  validateFixCheckReport,
  validateReport,
  type ReportFinding,
  type RunRecord,
  type StoredFinding,
} from "../src/lib/review/record.js";

// The example report from architecture/api-contract.md, with concrete values.
const exampleReport = {
  strengths: ["Clear module boundaries"],
  findings: [
    {
      id: "F1",
      severity: "important",
      kind: "code",
      location: { repo: "root", path: "src/x.ts", line: 10 },
      fails: { type: "acceptance", ref: "T1 acceptance criterion 2" },
      detail: "The error path is not handled.",
      fix_hint: "Catch the error and return report_invalid.",
    },
  ],
  declined: [{ behavior: "Performance under load", reason: "No benchmark in scope" }],
  verdict: "with_fixes",
  final_only: { minor_sort: [{ finding: "02/r2-F4", class: "can_wait" }] },
};

function fenced(json: unknown, prose = "Review below."): string {
  return `${prose}\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;
}

function errorsOf(json: unknown, repos: string[] = ["root"]): string[] {
  const result = validateReport(json, { repos });
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors;
}

function withFinding(patch: Record<string, unknown>): Record<string, unknown> {
  return { ...exampleReport, findings: [{ ...exampleReport.findings[0], ...patch }] };
}

function stored(id: string, extra: Partial<StoredFinding> = {}): StoredFinding {
  return {
    id,
    severity: "important",
    kind: "code",
    location: { repo: "root", path: "src/x.ts" },
    fails: { type: "correctness", ref: "" },
    detail: "detail",
    foreign_file: false,
    resolution: null,
    ...extra,
  };
}

function thrownCode(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof ChangeCommandError ? error.code : "other";
  }
  return undefined;
}

const ruling = { as: "ruling" as const, agreed: false, reason: "intended", cost_if_wrong: "a retry", basis: { code: {}, guidelines: {}, documents: {}, decisions: {} } };

describe("extractReport", () => {
  it("parses the last fenced json block only", () => {
    const text = `${fenced({ verdict: "ready", findings: [] }, "First draft:")}\nRevised:\n\n${fenced(exampleReport)}`;
    expect(extractReport(text)).toEqual(exampleReport);
  });

  it("rejects a response without a json block, and a block with invalid JSON", () => {
    const missing = (() => {
      try {
        extractReport("No findings, looks good.\n\n```text\n{}\n```\n");
      } catch (error) {
        return error as ChangeCommandError;
      }
      return undefined;
    })();
    expect(missing?.code).toBe("report_invalid");
    expect((missing?.details as { errors: string[] }).errors[0]).toMatch(/no fenced ```json block/);

    const invalid = (() => {
      try {
        extractReport("```json\n{\"verdict\": \"ready\",}\n```\n");
      } catch (error) {
        return error as ChangeCommandError;
      }
      return undefined;
    })();
    expect(invalid?.code).toBe("report_invalid");
    expect((invalid?.details as { errors: string[] }).errors[0]).toMatch(/not valid JSON/);
  });
});

describe("validateReport", () => {
  it("accepts the example report from api-contract.md and drops unknown fields", () => {
    const result = validateReport(
      { ...exampleReport, mood: "cheerful", findings: [{ ...exampleReport.findings[0], confidence: 0.9 }] },
      { repos: ["root"] },
    );
    expect(result).toEqual({ ok: true, report: exampleReport });
  });

  it("accepts a report with no findings and no optional lists", () => {
    expect(validateReport({ findings: [], verdict: "ready" }, { repos: ["root"] })).toEqual({
      ok: true,
      report: { strengths: [], findings: [], declined: [], verdict: "ready" },
    });
  });

  it("rejects a bad enum, a missing kind, and missing required fields with readable errors", () => {
    expect(errorsOf(withFinding({ severity: "high" }))).toEqual([
      'findings[0].severity: must be one of critical, important, minor (got "high")',
    ]);
    expect(errorsOf(withFinding({ kind: undefined }))).toEqual(["findings[0].kind: required, one of code, plan"]);
    expect(errorsOf({ ...exampleReport, verdict: undefined })).toEqual(["verdict: required, one of ready, with_fixes, not_ready"]);
    expect(errorsOf({ verdict: "ready" })).toEqual(["findings: required"]);
    expect(errorsOf(withFinding({ fails: { type: "vibes", ref: "x" } }))).toEqual([
      'findings[0].fails.type: must be one of acceptance, prd, architecture, decision, guideline, knowledge, correctness (got "vibes")',
    ]);
    expect(errorsOf(withFinding({ detail: "" }))).toEqual(["findings[0].detail: required, a non-empty string"]);
    expect(errorsOf([])).toEqual(["the report must be a JSON object"]);
  });

  it("rejects a location path escaping its repo, an absolute path, and an unknown repo", () => {
    expect(errorsOf(withFinding({ location: { repo: "root", path: "src/../../etc/passwd" } }))[0]).toMatch(
      /findings\[0\]\.location\.path: must be a path inside the repo/,
    );
    expect(errorsOf(withFinding({ location: { repo: "root", path: "/etc/passwd" } }))[0]).toMatch(/location\.path/);
    expect(errorsOf(withFinding({ location: { repo: "root", path: "C:\\x.ts" } }))[0]).toMatch(/location\.path/);
    expect(errorsOf(withFinding({ location: { repo: "elsewhere", path: "src/x.ts" } }))).toEqual([
      'findings[0].location.repo: unknown repo "elsewhere" (known: root)',
    ]);
  });

  it("normalises location paths and finding ids", () => {
    const result = validateReport(withFinding({ id: "02/r1-F01", location: { repo: "api", path: ".\\src//./x.ts" } }), { repos: ["root", "api"] });
    expect(result.ok && result.report.findings[0]).toMatchObject({ id: "F1", location: { repo: "api", path: "src/x.ts" } });
    expect(normalizeLocationPath("a/./b")).toBe("a/b");
    expect(normalizeLocationPath("../a")).toBeUndefined();
  });

  it("rejects duplicate finding ids and a fix-check report", () => {
    expect(errorsOf({ ...exampleReport, findings: [exampleReport.findings[0], exampleReport.findings[0]] })).toEqual([
      "findings[1].id: duplicate id F1",
    ]);
    expect(errorsOf({ checks: [] })[0]).toMatch(/fix-check report/);
  });
});

describe("mergeFindings", () => {
  const incoming = (patch: Partial<ReportFinding> = {}): ReportFinding => ({
    id: "F1",
    severity: "important",
    kind: "code",
    location: { repo: "root", path: "src/x.ts" },
    fails: { type: "correctness", ref: "" },
    detail: "first",
    ...patch,
  });

  it("scopes ids to the run and never changes kind or severity of a stored finding", () => {
    const first = mergeFindings([], [incoming()], "02-work/r1", () => false);
    expect(first.map((finding) => finding.id)).toEqual(["02-work/r1-F1"]);
    const resolved = applyResolution(first, "02-work/r1-F1", ruling);

    const second = mergeFindings(resolved, [incoming({ severity: "minor", kind: "plan", detail: "second" }), incoming({ id: "F2" })], "02-work/r1", (location) => location.path === "src/x.ts");
    expect(second[0]).toMatchObject({ id: "02-work/r1-F1", severity: "important", kind: "code", detail: "second", foreign_file: true, resolution: ruling });
    expect(second[1]).toMatchObject({ id: "02-work/r1-F2", resolution: null });
  });
});

describe("applyResolution and deriveSliceState", () => {
  it("refuses to resolve a plan finding except as dismissed, and parks only Minors", () => {
    const findings = [stored("s/r1-F1", { kind: "plan" }), stored("s/r1-F2"), stored("s/r1-F3", { severity: "minor" })];
    expect(thrownCode(() => applyResolution(findings, "s/r1-F1", ruling))).toBe("plan_finding_requires_person");
    expect(thrownCode(() => applyResolution(findings, "s/r1-F1", { as: "parked" }))).toBe("plan_finding_requires_person");
    expect(thrownCode(() => applyResolution(findings, "s/r1-F2", { as: "parked" }))).toBe("invalid_resolution");
    expect(thrownCode(() => applyResolution(findings, "s/r1-F9", { as: "parked" }))).toBe("finding_not_found");
    expect(applyResolution(findings, "s/r1-F1", { as: "dismissed", by: "alice" })[0].resolution).toEqual({ as: "dismissed", by: "alice" });
    expect(applyResolution(findings, "s/r1-F3", { as: "parked" })[2].resolution).toEqual({ as: "parked" });
  });

  it("derives in_review, waiting_on_person, and the finalize outcomes", () => {
    const plan = stored("s/r1-F1", { kind: "plan" });
    const code = stored("s/r1-F2");
    const minor = stored("s/r1-F3", { severity: "minor" });

    expect(deriveSliceState([])).toEqual({ state: "in_review", open: [] });
    expect(deriveSliceState([plan, code]).state).toBe("waiting_on_person");
    expect(deriveSliceState([{ ...plan, resolution: { as: "dismissed", by: "alice" } }, code]).state).toBe("in_review");

    expect(deriveSliceState([], { finalize: true }).state).toBe("reviewed");
    expect(deriveSliceState([code], { finalize: true })).toEqual({ state: "finalize_blocked", open: ["s/r1-F2"] });
    expect(deriveSliceState([plan], { finalize: true }).state).toBe("finalize_blocked");
    expect(deriveSliceState([minor], { finalize: true }).state).toBe("finalize_blocked");
    expect(deriveSliceState([{ ...minor, resolution: { as: "parked" } }], { finalize: true }).state).toBe("reviewed");
    expect(deriveSliceState([{ ...plan, resolution: { as: "dismissed", by: "a" } }], { finalize: true }).state).toBe("reviewed_with_rulings");
    expect(deriveSliceState([{ ...code, resolution: ruling }, { ...minor, resolution: { as: "parked" } }], { finalize: true }).state).toBe(
      "reviewed_with_rulings",
    );
  });

  it("counts rulings, parked Minors, human checks, and untested tasks", () => {
    const tasks = { total: 2, untested: [{ id: "T2", title: "x" }], human_checks: [{ task: "T1", step: "click" }, { task: "T2", step: "look" }] };
    expect(
      sliceCounts(
        [
          stored("a", { resolution: ruling }),
          stored("b", { severity: "minor", resolution: { as: "parked" } }),
          stored("c"),
          stored("d", { kind: "plan", resolution: { as: "dismissed", by: "alice" } }),
        ],
        tasks,
      ),
    ).toEqual({
      open_rulings: 2,
      parked_minors: 1,
      human_checks: 2,
      untested_tasks: 1,
    });
  });
});

describe("renderReviewRecord", () => {
  const run = (number: number, extra: Partial<RunRecord> = {}): RunRecord => ({
    run: `02-work/r${number}`,
    scope: { kind: "slice", slice: "02-work" },
    independent: true,
    partial: false,
    model_level: "mid",
    start_ref: "refs/weave/reviews/c/02-work/start",
    end_ref: `refs/weave/reviews/c/02-work/r${number}/end`,
    reports: [`r${number}.report.md`],
    strengths: ["Readable"],
    findings: [],
    declined: [],
    verdict: "ready",
    tasks: { total: 1, untested: [], human_checks: [] },
    recorded_at: "2026-11-10T10:00:00.000Z",
    updated_at: "2026-11-10T10:00:00.000Z",
    ...extra,
  });

  it("writes every section, newest run first, and shows a less independent run", () => {
    const text = renderReviewRecord([
      run(1, {
        independent: false,
        findings: [
          stored("02-work/r1-F1", { resolution: { ...ruling, basis: { code: { "root:src/x.ts": "3b18e512abcdef00" }, guidelines: {}, documents: { "prd.md": "sha256:aaaaaaaaaaaaaaaa" }, decisions: {} } } }),
          stored("02-work/r1-F2", { severity: "minor", detail: "a | pipe", resolution: { as: "parked" } }),
          stored("02-work/r1-F3", { kind: "plan", resolution: { as: "dismissed", by: "alice" } }),
        ],
        declined: [{ behavior: "Load", reason: "No benchmark" }],
        tasks: { total: 2, untested: [{ id: "T2", title: "UI" }], human_checks: [{ task: "T2", step: "Click save" }] },
        outcome: { state: "reviewed_with_rulings", at: "2026-11-10T11:00:00.000Z" },
      }),
      run(2),
    ]);

    expect(text.indexOf("## Run 02-work/r2")).toBeLessThan(text.indexOf("## Run 02-work/r1"));
    const first = text.slice(text.indexOf("## Run 02-work/r1"));
    for (const heading of ["### Strengths", "### Findings", "### Fixes", "### Rulings", "### Declined to judge", "### Saved Minors", "### Untested tasks", "### Human checks (needs your check)"]) {
      expect(first).toContain(heading);
    }
    expect(first).toContain("- Independent: no (less independent");
    expect(first).toContain("- State: reviewed with rulings");
    expect(first).toContain("| 02-work/r1-F1 | important | code | root:src/x.ts | correctness | ruling (disagreed) |");
    expect(first).toContain("| 02-work/r1-F3 | important | plan | root:src/x.ts | correctness | dismissed by alice |");
    expect(first).toContain("- `02-work/r1-F2`: a | pipe");
    expect(first).toContain("  - Cost if wrong: a retry");
    expect(first).toContain("code `root:src/x.ts` (3b18e512abcd), document `prd.md` (aaaaaaaaaaaa)");
    expect(first).toContain("  - Reopened: no");
    expect(first).toContain("- Load: No benchmark");
    expect(first).toContain("- `02-work/r1-F2` (root:src/x.ts): a | pipe");
    expect(first).toContain("- T2: UI");
    expect(first).toContain("- T2: Click save");
    expect(text.slice(0, text.indexOf("## Run 02-work/r1"))).toContain("- Independent: yes");
  });
});

describe("fix-check reports", () => {
  it("detects the fix-check shape and validates checks and new findings", () => {
    const json = {
      checks: [
        { finding: "02/r1-F1", result: "addressed" },
        { finding: "02/r1-F2", result: "NOT_ADDRESSED" },
      ],
      new_findings: [{ ...exampleReport.findings[0], id: undefined, unknown: 1 }],
      strengths: ["ignored"],
    };
    expect(isFixCheckReport(json)).toBe(true);
    expect(isFixCheckReport(exampleReport)).toBe(false);
    const result = validateFixCheckReport(json, { repos: ["root"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.checks).toEqual([
      { finding: "02/r1-F1", result: "addressed" },
      { finding: "02/r1-F2", result: "not_addressed" },
    ]);
    expect(result.report.new_findings).toEqual([{ ...exampleReport.findings[0], id: "F1" }]);
  });

  it("rejects a bad result, a duplicate check, a missing checks list, and an invalid new finding", () => {
    const bad = validateFixCheckReport(
      {
        checks: [
          { finding: "02/r1-F1", result: "maybe" },
          { finding: "02/r1-F2", result: "addressed" },
          { finding: "02/r1-F2", result: "addressed" },
        ],
        new_findings: [{ ...exampleReport.findings[0], kind: "style" }],
      },
      { repos: ["root"] },
    );
    expect(bad.ok).toBe(false);
    const errors = bad.ok ? [] : bad.errors;
    expect(errors.some((error) => error.startsWith("checks[0].result: must be one of addressed, not_addressed"))).toBe(true);
    expect(errors).toContain("checks[2].finding: 02/r1-F2 is checked twice");
    expect(errors.some((error) => error.startsWith("new_findings[0].kind"))).toBe(true);
    expect(validateFixCheckReport({ checks: "all" })).toEqual({ ok: false, errors: ["checks: must be an array"] });
  });
});

describe("fixes in counts and review.md", () => {
  const fixed = (round: number, needsCheck: boolean) => ({
    as: "fixed" as const,
    round,
    patch: `review/r1-round${round}.patch`,
    files: ["src/x.ts"],
    needs_your_check: needsCheck,
  });

  it("counts fixes that need a person's check as human checks", () => {
    const findings = [stored("a", { resolution: fixed(1, true) }), stored("b", { resolution: fixed(1, false) })];
    expect(sliceCounts(findings, { total: 1, untested: [], human_checks: [{ task: "T1", step: "Look" }] }).human_checks).toBe(2);
  });

  it("renders the Fixes table, each round's patch, undo command and check, and the needs-your-check list", () => {
    const text = renderReviewRecord([
      {
        run: "02-work/r1",
        scope: { kind: "slice", slice: "02-work" },
        independent: true,
        partial: false,
        model_level: "mid",
        start_ref: null,
        end_ref: "refs/weave/reviews/c/02-work/r1/end",
        reports: ["r1.report.md"],
        strengths: [],
        findings: [
          stored("02-work/r1-F1", { resolution: fixed(1, true) }),
          stored("02-work/r1-F2", { source: "fix_check", round: 1 }),
        ],
        declined: [],
        verdict: "with_fixes",
        tasks: { total: 1, untested: [], human_checks: [] },
        rounds: [
          {
            round: 1,
            start_ref: "s",
            started_at: "t",
            end_ref: "e",
            patch: "review/r1-round1.patch",
            undo: "git apply -R wiki/changes/c/task-slices/02-work/review/r1-round1.patch",
            files: ["src/x.ts"],
            check: { report: "r1-round1.check.md", checks: [{ finding: "02-work/r1-F1", result: "addressed" }], new_findings: ["02-work/r1-F2"], recorded_at: "t" },
          },
          { round: 2, start_ref: "s2", started_at: "t" },
        ],
        recorded_at: "t",
        updated_at: "t",
      },
    ]);
    expect(text).toContain("| Finding | Round | Patch | Files | Needs your check |");
    expect(text).toContain("| 02-work/r1-F1 | 1 | `review/r1-round1.patch` | `src/x.ts` | yes |");
    expect(text).toContain(
      "- Round 1: patch `review/r1-round1.patch` (1 files); fix check `review/r1-round1.check.md`: 1 addressed, 0 not addressed, new: `02-work/r1-F2`",
    );
    expect(text).toContain("  - Undo from the Weave root: `git apply -R wiki/changes/c/task-slices/02-work/review/r1-round1.patch`");
    expect(text).toContain("- Round 2: started, not yet packaged");
    expect(text).toContain("- `02-work/r1-F1`: fixed in round 1; repeat the slice's human checks against the fix");
  });
});
