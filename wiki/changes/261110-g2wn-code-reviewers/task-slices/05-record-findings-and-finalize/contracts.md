# Contracts: Record reviewer reports, rulings, and the finished slice review

See `architecture/api-contract.md` (`weave review record`, Reviewer report schema, Authorization And Validation) and `architecture/schema.md` (Slice `review:` block, Readable records, Finding record, Ruling basis, Validation And Risks).

## Interfaces

- `weave review record --run <run> --report - [--independent false] [--json]`: reads stdin.
- `weave review record --run <run> --resolve <finding> --as ruling --agreed true|false --reason <text> --cost <text> [--json]`
- `weave review record --run <run> --resolve <finding> --as parked [--json]` (Minor findings only).
- `weave review record --run <run> --resolve <finding> --as dismissed --by <person> [--json]`.
- `weave review record --run <run> --finalize [--json]` → `{status: "ok", state, counts, fingerprint_files: n}`.
- `weave review record --run <run> --failed [--json]`.
- `weave review status [--slice <id>] --repair [--json]`.
- `src/lib/review/record.ts`: `extractReport(text): unknown`, `validateReport(json): { ok: true; report } | { ok: false; errors: string[] }`, `applyResolution(findings, id, resolution)`, `deriveSliceState(findings)`, `renderReviewRecord(runs): string`.
- `src/lib/review/fingerprint.ts`: `computeFingerprint(repos, ownedPaths)`, `computePlanBasis(changePath, sliceId, decisionIds)`, `computeRulingBasis(finding, guidelineFiles, changePath)`.

## Data

- `task-slices/<slice>/review/r<N>.report.md` (verbatim stdin), `r<N>.findings.json` (`schema.md` § Finding record).
- `task-slices/<slice>/review.md`: generated from all `*.findings.json` of the slice, newest run first, with sections: header (run id, scope, model level, independent, partial, start and end refs), Strengths, Findings (id, severity, kind, location, fails, status), Fixes, Rulings (id, reasoning, cost if wrong, basis, reopened), Declined to judge, Saved Minors, Untested tasks, Human checks. The layout is rendered in `record.ts`; slice 11 ships the matching `review-record-template.md` as its reference.
- Resolutions: `{as: ruling, agreed, reason, cost_if_wrong, basis}`, `{as: parked}`, `{as: dismissed, by}`. `basis` per `schema.md` § Ruling basis, with frontmatter-stripped hashes (`bodyHash`) for documents, decisions, and guidelines, and git blob hashes for code.
- Finalize writes `state`, `fingerprint`, `plan_basis` (PRD or other planning docs, `architecture/*.md`, `slice.md`, cited decisions), `merge_base`, `reviewed_task_total`, `counts {open_rulings, parked_minors, human_checks, untested_tasks}`, `independent`, `partial`, `updated_at`.

## State

- `--report` on the run: findings stored, slice stays `in_review`; any open `kind: plan` finding → `waiting_on_person`.
- `--resolve` plan finding with `--as` other than `dismissed` → exit 5, state `waiting_on_person`, nothing else written.
- `--resolve --as dismissed` on the last open plan finding → `in_review` (the run resumes at its next fix round in slice 06).
- `--finalize` → `reviewed` (no open findings) or `reviewed_with_rulings` (every open finding has a ruling, Minors parked, no plan finding open). Anything else → `finalize_blocked` with the open ids.
- `--failed` → `review_failed`. A new run starts with `package --slice` again.
- Every write runs under the change lock, re-reads, and writes atomically.

## Validation and errors

- Exit 4 `report_invalid` (no JSON block, invalid JSON, schema errors listed in `details.errors`), nothing written.
- Exit 5 `plan_finding_requires_person`.
- `run_not_found`, `finding_not_found`, `invalid_resolution` (e.g. `parked` on a non-Minor, `ruling` without `--reason` or `--cost`), `finalize_blocked`: exit 1.
- Reports are untrusted data: parse only, never execute, normalise `location.path`, reject paths outside a known repo.

## Files and artifacts

- New: `src/lib/review/record.ts`, `src/lib/review/fingerprint.ts`, `tests/review-record.test.ts`, `tests/review-fingerprint.test.ts`, `tests/cli-review-record.test.ts`.
- Modified: `src/commands/review.ts` (add `record`, `status --repair`).
