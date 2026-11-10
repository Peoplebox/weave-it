---
artifact: tasks
slice: 05-record-findings-and-finalize
status: draft
owner: engineering
created_at: 2026-11-09T23:35:06.000Z
updated_at: 2026-11-09T23:35:06.000Z
source: architecture
---

# Tasks: Record reviewer reports, rulings, and the finished slice review

## Status Legend

- `todo`: ready when blockers are done
- `in_progress`: currently being implemented
- `blocked`: cannot proceed without listed blocker
- `done`: implemented and verified
- `not_tested`: implementation complete, automated verification incomplete
- `invalid`: no longer applies

## Active Task Index

| ID | Status | Execution | Repos | Owner | Title | Blocked by |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | done | afk | root | | Extract and validate reviewer reports as untrusted data | None |
| T2 | done | afk | root | | Add weave review record --report, --failed, and the review.md writer | T1 |
| T3 | done | afk | root | | Add resolutions with immutability and the plan-finding refusal | T2 |
| T4 | done | afk | root | | Compute fingerprints, plan basis, and ruling basis, and add --finalize | T3 |
| T5 | done | afk | root | | Add weave review status --repair | T4 |
| T6 | done | afk | root | | Verify the record state machine end to end, including exit codes 4 and 5 | T5 |

## root

### T1: Extract and validate reviewer reports as untrusted data

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `src/lib/review/record.ts` (C)
- `tests/review-record.test.ts` (C)

### What to build

`extractReport` takes the last fenced `json` block. `validateReport` checks the slice report schema in `api-contract.md` by hand (no new dependency): required fields, enums for `severity`, `kind`, `fails.type`, `verdict`; unknown fields dropped. Scope finding ids to `<run>-F<n>`. Normalise and check `location` against the known repo ids and reject `..` or absolute paths.

### Acceptance Criteria

- [x] Accepts the example report from `api-contract.md`.
- [x] Rejects a missing block, invalid JSON, a bad enum, a missing `kind`, and a path escaping its repo, each with a readable error.
- [x] With two JSON blocks, only the last is used.

### Verification

- Automated tests: `npx vitest run tests/review-record.test.ts`
- `npm run typecheck`
- Result (2026-11-10): `npx vitest run tests/review-record.test.ts` passed (13 tests: example report accepted with unknown fields dropped; missing block, invalid JSON, bad enum, missing `kind`, escaping/absolute paths, unknown repo rejected with readable errors; last of two blocks used). `npm run typecheck` passed.

### T2: Add weave review record --report, --failed, and the review.md writer

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1
Files:
- `src/lib/review/record.ts` (M)
- `src/commands/review.ts` (M: add `record`)
- `tests/cli-review-record.test.ts` (C)

### What to build

`record --run <run> --report -` and `--failed` per `contracts.md`, with `--independent false`. Write the report and findings files, regenerate `review.md` with `renderReviewRecord`, and update the slice `review:` block under the lock. Set exit code 4 on `report_invalid`.

### Acceptance Criteria

- [x] A valid report writes both files and `review.md`; the slice stays `in_review`, or becomes `waiting_on_person` if a plan finding is present.
- [x] An invalid report exits 4 and leaves the folder and `status.yml` unchanged.
- [x] `--failed` sets `review_failed`.
- [x] `review.md` shows "less independent" when `--independent false`.

### Verification

- Automated tests: `npx vitest run tests/cli-review-record.test.ts`
- `npm run typecheck`
- Result (2026-11-10): `npx vitest run tests/cli-review-record.test.ts` passed: valid report writes `review/r1.report.md`, `review/r1.findings.json`, and `review.md` (slice `in_review`, or `waiting_on_person` with a plan finding); invalid report exits 4 with the folder and `status.yml` unchanged; `--failed` sets `review_failed`; `--independent false` stored and shown as "less independent". `npm run typecheck` passed.

### T3: Add resolutions with immutability and the plan-finding refusal

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T2
Files:
- `src/lib/review/record.ts` (M)
- `src/commands/review.ts` (M)
- `tests/review-record.test.ts` (M)
- `tests/cli-review-record.test.ts` (M)

### What to build

`--resolve <finding> --as ruling|parked|dismissed` with the options and rules in `contracts.md`. Exit 5 for a plan finding resolved by anything but `dismissed`. A later `--report` for the same run never changes the `kind` or `severity` of an existing finding id.

### Acceptance Criteria

- [x] A ruling stores `agreed`, `reason`, `cost_if_wrong`, and a `basis` (basis contents verified in T4).
- [x] `parked` on an Important finding → `invalid_resolution`.
- [x] Plan finding + `ruling` → exit 5, `waiting_on_person`; plan finding + `dismissed --by alice` → `in_review`.

### Verification

- Automated tests: `npx vitest run tests/review-record.test.ts tests/cli-review-record.test.ts`
- `npm run typecheck`
- Result (2026-11-10): `npx vitest run tests/review-record.test.ts tests/cli-review-record.test.ts` passed: ruling stores `agreed`, `reason`, `cost_if_wrong`, and `basis`; parking an Important finding gives `invalid_resolution`; plan finding + ruling or parked exits 5 and sets `waiting_on_person` without touching findings; `dismissed --by alice` returns to `in_review`; a second report never changes `kind` or `severity`. `npm run typecheck` passed.

### T4: Compute fingerprints, plan basis, and ruling basis, and add --finalize

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T3
Files:
- `src/lib/review/fingerprint.ts` (C)
- `src/lib/review/record.ts` (M)
- `src/commands/review.ts` (M)
- `tests/review-fingerprint.test.ts` (C)
- `tests/cli-review-record.test.ts` (M)

### What to build

- `computeFingerprint`: `git hash-object` (or `ls-files -s` for unchanged files) of each owned, non-foreign, non-excluded path in the working tree; `absent` for deleted files.
- `computePlanBasis` and `computeRulingBasis` with `bodyHash` for documents, decisions, and guidelines.
- `--finalize` per `contracts.md` § State, storing every field in § Data, with counts from the findings and from `parseTaskEvidence`.

### Acceptance Criteria

- [x] Fingerprint excludes foreign files and `wiki/changes/**`, and records `absent` for a deleted owned file.
- [x] `plan_basis` is unchanged by a frontmatter-only edit to `prd.md` and changes on a body edit.
- [x] Finalize refuses with `finalize_blocked` while an Important finding is open without a ruling.
- [x] Finalize gives `reviewed` or `reviewed_with_rulings` for the matching scenarios.

### Verification

- Automated tests: `npx vitest run tests/review-fingerprint.test.ts tests/cli-review-record.test.ts`
- `npm run typecheck`
- Result (2026-11-10): `npx vitest run tests/review-fingerprint.test.ts tests/cli-review-record.test.ts` passed: fingerprint holds owned files only (no foreign file, nothing under `wiki/changes/**`) with `absent` for a deleted owned file; `plan_basis` unchanged by a frontmatter-only PRD edit and changed by a body edit; finalize refuses with `finalize_blocked` while an Important finding is open and gives `reviewed` / `reviewed_with_rulings` for the matching runs. `npm run typecheck` passed.

### T5: Add weave review status --repair

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T4
Files:
- `src/commands/review.ts` (M)
- `src/lib/review/record.ts` (M: rebuild from findings)
- `tests/cli-review-record.test.ts` (M)

### What to build

`status --repair` rebuilds each slice's `review:` block from its latest `review/*.findings.json` and the stored refs, under the lock. Fields that only finalize computes (fingerprint, `plan_basis`) are recomputed from the current tree only when the latest run was finalized, and the response says they were recomputed.

### Acceptance Criteria

- [x] After deleting a finalized slice's `review:` block, `--repair` restores the same `state`, `latest_run`, and `counts`.
- [x] Without `--repair`, `status` writes nothing except adoption.

### Verification

- Automated tests: `npx vitest run tests/cli-review-record.test.ts`
- `npm run typecheck`
- Result (2026-11-10): `npx vitest run tests/cli-review-record.test.ts` passed: after deleting a finalized slice's `review:` block, `status --repair` restores `state`, `latest_run`, `counts`, and the other fields, reporting `fingerprint` and `plan_basis` as recomputed; plain `status` left `status.yml` byte-identical. `npm run typecheck` passed.

### T6: Verify the record state machine end to end, including exit codes 4 and 5

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T5
Files:
- `tests/cli-review-record.test.ts` (M)

### What to build

A CLI test in a temporary repo running snapshot → package → record report → resolve → finalize for: no findings (`reviewed`); one Important ruling (`reviewed_with_rulings`); a plan finding refused then dismissed. Assert process exit codes 4 and 5 through the built CLI entry. Grep `src/` to confirm no other command uses exit codes 4 or 5. Then run the full suite, typecheck, and build.

### Acceptance Criteria

- [x] All three flows end in the expected state with the expected files.
- [x] Exit codes are 4 and 5 exactly where specified and nowhere else.
- [x] The full suite, typecheck, and build pass.

### Verification

- Automated tests: `npx vitest run tests/cli-review-record.test.ts`, then `npm test`
- `npm run typecheck && npm run build`
- Result (2026-11-10): `npx vitest run tests/cli-review-record.test.ts` passed: no-findings flow ends `reviewed`; Important ruling flow ends `reviewed_with_rulings`; plan finding refused (exit 5) then dismissed and finalized. Exit codes 4 and 5 asserted through the CLI entry (`src/cli.ts` via tsx); a scan of `src/` finds no other exit code besides 0 and 1. `npm run typecheck`, `npm test` (46 files, 654 tests), and `npm run build` passed.

## QA Findings

| ID | Status | Severity | Source | Related Task | Summary |
| --- | --- | --- | --- | --- | --- |

None.

## Refactors

| ID | Status | Scope | Related Tasks | Summary |
| --- | --- | --- | --- | --- |

None.

## Verification

- 2026-11-10: `npm run typecheck`, `npm test` (46 files, 654 tests), and `npm run build` passed after T1 to T6.
