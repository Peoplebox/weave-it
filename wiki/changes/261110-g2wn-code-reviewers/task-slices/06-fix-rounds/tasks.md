---
artifact: tasks
slice: 06-fix-rounds
status: draft
owner: engineering
created_at: 2026-11-09T23:35:06.000Z
updated_at: 2026-11-09T23:35:06.000Z
source: architecture
---

# Tasks: Fix rounds with reversible patches and fix checks

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
| T1 | done | afk | root | | Add round-start snapshots for a run | None |
| T2 | done | afk | root | | Add package --fix-round with the saved round patch | T1 |
| T3 | done | afk | root | | Record fix-check reports and fixed resolutions with needs-your-check | T2 |
| T4 | done | afk | root | | Resume a run after a dismissed plan finding | T3 |
| T5 | done | afk | root | | Verify a two-round fix flow and that round patches reverse cleanly | T4 |

## root

### T1: Add round-start snapshots for a run

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `src/commands/review.ts` (M: `snapshot --run --at round-start --round`)
- `src/lib/review/boundary.ts` (M: round ref naming helper)
- `tests/cli-review-fix-rounds.test.ts` (C)

### What to build

`snapshot --run <run> --at round-start --round <n>` per `contracts.md`: resolve the run's slice and repos from the run id, check round ordering, and create `round<N>-start` refs.

### Acceptance Criteria

- [x] Round 1 start succeeds after `record --report`; round 2 start before round 1 end fails.
- [x] A second round-start for the same round fails with `round_already_started` unless `--force`.

### Verification

- Automated tests: `npx vitest run tests/cli-review-fix-rounds.test.ts`
- `npm run typecheck`
- Evidence (2026-11-10): `npx vitest run tests/cli-review-fix-rounds.test.ts` passed (round-start needs a recorded report; `round_not_ended`, `round_not_started`, `round_already_started`, `--force` restart; HEAD, branch, index, status, and stash unchanged). `npm run typecheck` passed.

### T2: Add package --fix-round with the saved round patch

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1
Files:
- `src/lib/review/package.ts` (M: round package)
- `src/commands/review.ts` (M)
- `tests/cli-review-fix-rounds.test.ts` (M)

### What to build

`package --run <run> --fix-round <n>` per `contracts.md`: `round_not_started` check, round end snapshot, round diff, patch saved to the slice `review/` folder, round package with the targeted findings, `model_level: "cheap-mid"`, and `files_touched`.

### Acceptance Criteria

- [x] The patch holds only the round's edits and no `wiki/changes/**` path.
- [x] The round package lists only the open Critical and Important findings.
- [x] `files_touched` matches the patch.

### Verification

- Automated tests: `npx vitest run tests/cli-review-fix-rounds.test.ts`
- `npm run typecheck`
- Evidence (2026-11-10): `npx vitest run tests/cli-review-fix-rounds.test.ts` passed (`round_not_started` without the round-start ref; patch holds only the round's files incl. a new and a binary file, no `wiki/changes/**`; `files_touched` equals the patch's paths; package lists only open Critical and Important findings; `git apply -R` restores the round-start files). `npm run typecheck` passed.

### T3: Record fix-check reports and fixed resolutions with needs-your-check

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T2
Files:
- `src/lib/review/record.ts` (M)
- `src/commands/review.ts` (M)
- `tests/review-record.test.ts` (M)
- `tests/cli-review-fix-rounds.test.ts` (M)

### What to build

- Validate the fix-check schema (`checks[]` with fully scoped finding ids, optional `new_findings[]`), store the `.check.md`, merge `rounds[]` into findings, and add new findings with fresh ids.
- `--as fixed --round <n>` with `patch`, `files`, and `needs_your_check` (true when the slice's tasks carry a `Human check:` line).
- Render the Fixes section and the needs-your-check list in `review.md`, and update `counts.human_checks`.

### Acceptance Criteria

- [x] A `not_addressed` check keeps the finding open; an `addressed` check plus `--as fixed` closes it.
- [x] A new Important finding from the checker joins the open list with a new id and frozen `kind` and `severity`.
- [x] `review.md` shows finding id, round, patch file, files, and "needs your check" where it applies.

### Verification

- Automated tests: `npx vitest run tests/review-record.test.ts tests/cli-review-fix-rounds.test.ts`
- `npm run typecheck`
- Evidence (2026-11-10): `npx vitest run tests/review-record.test.ts tests/cli-review-fix-rounds.test.ts` passed (fix-check stored as `r1-round1.check.md`; `not_addressed` stays open; new findings get fresh ids with `source: fix_check`, `round`, frozen kind and severity; unknown check id exits 4 and writes nothing; `--as fixed` needs `--round` and a packaged round; Fixes table and needs-your-check list; `counts.human_checks` includes the fix). `npm run typecheck` passed.

### T4: Resume a run after a dismissed plan finding

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T3
Files:
- `src/commands/review.ts` (M: `package --run` without `--fix-round`)
- `src/lib/review/package.ts` (M)
- `tests/cli-review-fix-rounds.test.ts` (M)

### What to build

`package --run <run>` per `contracts.md`: return `resume_round` for an `in_review` run with a dismissed plan finding and open code findings; `run_not_resumable` otherwise. No new run id.

### Acceptance Criteria

- [x] After `dismissed`, `package --run 02/r1` returns `resume_round: 1` (or the next round) and `latest_run` stays `r1`.
- [x] A finalized run returns `run_not_resumable`.

### Verification

- Automated tests: `npx vitest run tests/cli-review-fix-rounds.test.ts`
- `npm run typecheck`
- Evidence (2026-11-10): `npx vitest run tests/cli-review-fix-rounds.test.ts` passed (after `dismissed`, `package --run 02/r1` returns `resume_round: 1`, then 2 after round 1; `latest_run` stays `r1` and no new run is reserved; waiting and finalized runs return `run_not_resumable`). `npm run typecheck` passed.

### T5: Verify a two-round fix flow and that round patches reverse cleanly

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T4
Files:
- `tests/cli-review-fix-rounds.test.ts` (M)

### What to build

A CLI test in a temporary repo: package → report with two Important findings → round 1 fixes one, the checker adds one new finding → round 2 fixes the rest → finalize `reviewed`. Then apply `git apply -R` to the round 2 patch and then the round 1 patch, and assert the owned files match the end snapshot of the original review while `wiki/changes/` files are untouched. Repeat the patch check in a two-repo workspace. Then run the full suite, typecheck, and build.

### Acceptance Criteria

- [x] The flow ends `reviewed` with two Fixes rows per round as recorded.
- [x] Both patches reverse cleanly in repo and workspace mode.
- [x] The full suite, typecheck, and build pass.

### Verification

- Automated tests: `npx vitest run tests/cli-review-fix-rounds.test.ts`, then `npm test`
- `npm run typecheck && npm run build`
- Evidence (2026-11-10): `npx vitest run tests/cli-review-fix-rounds.test.ts` passed (two-round flow ends `reviewed` with one Fixes row per fixed finding per round; round 2 then round 1 patches reverse to the r1 end snapshot with `wiki/changes/` untouched; workspace patch with per-repo headers reverses from the Weave root). `npm test` passed (47 files, 668 tests), `npm run typecheck` and `npm run build` passed.

## QA Findings

| ID | Status | Severity | Source | Related Task | Summary |
| --- | --- | --- | --- | --- | --- |

None.

## Refactors

| ID | Status | Scope | Related Tasks | Summary |
| --- | --- | --- | --- | --- |

None.

## Verification

- 2026-11-10: `npm run typecheck`, `npm test` (47 files, 668 tests), and `npm run build` passed.
