---
artifact: tasks
slice: 07-out-of-date-and-ruling-reopen
status: draft
owner: engineering
created_at: 2026-11-09T23:35:06.000Z
updated_at: 2026-11-09T23:35:06.000Z
source: architecture
---

# Tasks: Out-of-date reviews, file ownership, and reopened rulings

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
| T1 | done | afk | root | | Evaluate out-of-date reasons and wire them into weave review status | None |
| T2 | done | afk | root | | Hand file ownership to the latest review at finalize | T1 |
| T3 | done | afk | root | | Label files from main when the merge-base moved and keep them out of fingerprints | T1 |
| T4 | done | afk | root | | Reopen rulings on basis changes and list settled and reopened rulings in packages | T1 |
| T5 | done | afk | root | | Verify out-of-date, revert, no-cascade, and plan-change scenarios | T2, T3, T4 |

## root

### T1: Evaluate out-of-date reasons and wire them into weave review status

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `src/lib/review/fingerprint.ts` (M)
- `src/commands/review.ts` (M: `status` overlay; fresh run on plan change)
- `tests/review-fingerprint.test.ts` (M)

### What to build

`outOfDateReasons` per `contracts.md`, used by `status` through `effectiveState`. Handle the `waiting_on_person` plus `plan_changed` case and let `package --slice` start a new run for it.

### Acceptance Criteria

- [x] Each of the three reasons is produced by its scenario, alone and combined.
- [x] A frontmatter-only edit to a decision produces no reason.
- [x] A waiting slice with a changed plan reads `not_reviewed` and packages as `r2`.

### Verification

- Automated tests: `npx vitest run tests/review-fingerprint.test.ts`
- `npm run typecheck`
- Passed: `npx vitest run tests/review-fingerprint.test.ts` (each reason alone and combined; frontmatter-only PRD and decision edits give no reason; a new architecture file gives `plan_changed`; waiting slice reads `not_reviewed (plan changed)`; `repo_missing` warning with no reason). The `r2` packaging of a waiting slice is covered in `tests/review-out-of-date.test.ts`.
- Passed: `npm run typecheck`.

### T2: Hand file ownership to the latest review at finalize

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1
Files:
- `src/lib/review/fingerprint.ts` (M: `releaseOwnership`)
- `src/lib/review/record.ts` (M: call it in `--finalize`)
- `tests/review-out-of-date.test.ts` (C)

### What to build

At finalize, after computing the run's fingerprint, remove each covered file from every other slice's fingerprint under the same lock.

### Acceptance Criteria

- [x] Slice 01 and 02 share `a.ts`; after slice 02 finalizes, slice 01's fingerprint no longer lists `a.ts`, and an edit to `a.ts` marks only slice 02 out of date.
- [x] Foreign files are never added to any fingerprint.

### Verification

- Automated tests: `npx vitest run tests/review-out-of-date.test.ts`
- `npm run typecheck`
- Passed: `npx vitest run tests/review-out-of-date.test.ts` ("hands a shared file to the latest review": slice 02 loses `src/shared.ts` only, finalize returns `released_from: ["02-work"]`, a foreign edit is fingerprinted by nobody, and a later edit to the shared file marks only slice 03 out of date).
- Passed: `npm run typecheck`.

### T3: Label files from main when the merge-base moved and keep them out of fingerprints

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1
Files:
- `src/lib/review/package.ts` (M: "From main (ignore)" section)
- `src/lib/review/record.ts` (M: exclude from fingerprint)
- `tests/review-out-of-date.test.ts` (M)

### What to build

Compare the start and end snapshot merge-bases. When they differ, compute `filesBetween` and move those paths out of the owned and foreign sections into "From main (ignore)", and skip them at finalize.

### Acceptance Criteria

- [x] After a rebase between start and end, a file changed only on main is listed under "From main (ignore)" and absent from the fingerprint.
- [x] With an unchanged merge-base the section is omitted.

### Verification

- Automated tests: `npx vitest run tests/review-out-of-date.test.ts`
- `npm run typecheck`
- Passed: `npx vitest run tests/review-out-of-date.test.ts` (a rebase between start and end lists main-only files under "From main (ignore)", keeps them out of the diff and the fingerprint, keeps a file both main and the slice changed as the slice's own; the section is omitted when the merge-base did not move).
- Passed: `npm run typecheck`.

### T4: Reopen rulings on basis changes and list settled and reopened rulings in packages

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1
Files:
- `src/lib/review/fingerprint.ts` (M: `rulingReopened`, `classifyRulings`)
- `src/lib/review/package.ts` (M: rulings sections and counts)
- `src/lib/review/record.ts` (M: Rulings section shows "reopened")
- `tests/review-fingerprint.test.ts` (M)

### What to build

Recompute each ruling's basis hashes and compare. Slice packages list settled rulings (do not raise again) and reopened rulings, and return the counts. `review.md` marks reopened rulings.

### Acceptance Criteria

- [x] Each of code, guideline, document, and decision changes reopens a ruling; a frontmatter-only edit does not.
- [x] `settled_rulings` and `reopened_rulings` in the package JSON match the sections.

### Verification

- Automated tests: `npx vitest run tests/review-fingerprint.test.ts`
- `npm run typecheck`
- Passed: `npx vitest run tests/review-fingerprint.test.ts` (code, guideline, document, and decision changes reopen a ruling; frontmatter-only edits do not; a missing repo never reopens) and `tests/review-out-of-date.test.ts` (package JSON `settled_rulings`/`reopened_rulings` match the sections; `review.md` shows "ruling (reopened)").
- Passed: `npm run typecheck`.

### T5: Verify out-of-date, revert, no-cascade, and plan-change scenarios

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T2, T3, T4
Files:
- `tests/review-out-of-date.test.ts` (M)

### What to build

CLI-level tests through finalize in temporary repos covering every acceptance criterion in `slice.md`, including that `weave slice rollup --check` passes before and after an out-of-date edit and that `status.yml` bytes are unchanged by status reads. Then run the full suite, typecheck, and build.

### Acceptance Criteria

- [x] Every `slice.md` acceptance criterion has a passing test.
- [x] The full suite, typecheck, and build pass.

### Verification

- Automated tests: `npx vitest run tests/review-out-of-date.test.ts`, then `npm test`
- `npm run typecheck && npm run build`
- Passed: `npx vitest run tests/review-out-of-date.test.ts` (7 tests: in-set and out-of-set edits, `tasks_added`, revert to current with unchanged `status.yml` bytes, `rollupChange({check: true})` passing before and after the out-of-date edit, plan body vs frontmatter edits, no-cascade ownership, from main, waiting slice plus plan change packaging `r2`, settled and reopened rulings).
- Passed: `npm test` (48 files, 685 tests), `npm run typecheck`, `npm run build`.

## QA Findings

| ID | Status | Severity | Source | Related Task | Summary |
| --- | --- | --- | --- | --- | --- |

None.

## Refactors

| ID | Status | Scope | Related Tasks | Summary |
| --- | --- | --- | --- | --- |

None.

## Verification

- 2026-11-10: `npm run typecheck`, `npm test` (48 files, 685 tests), and `npm run build` passed.
