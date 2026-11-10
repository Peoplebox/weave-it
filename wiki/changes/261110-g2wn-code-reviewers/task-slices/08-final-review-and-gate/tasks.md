---
artifact: tasks
slice: 08-final-review-and-gate
status: draft
owner: engineering
created_at: 2026-11-09T23:35:06.000Z
updated_at: 2026-11-10T05:39:52.000Z
source: architecture
---

# Tasks: Final review gate, change package, and the change verdict

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
| T1 | done | afk | root | | Add the final-review gate | None |
| T2 | done | afk | root | | Add weave review package --change | T1 |
| T3 | done | afk | root | | Record change runs with the Minor sort and a single fix batch | T2 |
| T4 | done | afk | root | | Finalize the change verdict, take file ownership, and write the change review record | T3 |
| T5 | done | afk | root | | Verify gate cases, verdict outcomes, flat mode, and verdict out of date | T4 |

## root

### T1: Add the final-review gate

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `src/lib/review/gate.ts` (C)
- `src/commands/review.ts` (M: `gate --change`)
- `tests/review-gate.test.ts` (C)

### What to build

`evaluateGate` per `contracts.md`, using `effectiveState` and `outOfDateReasons` for every slice. `weave review gate --change [--json]` with text output listing blocking slices.

### Acceptance Criteria

- [x] Passes with `reviewed`, `reviewed_with_rulings`, and `predates_review` slices.
- [x] Blocks on `not_reviewed`, `in_review`, `waiting_on_person`, `review_failed`, and out of date, each listed with its reason.
- [x] `skipped` slices pass only when the change is skipped.

### Verification

- Automated tests: `npx vitest run tests/review-gate.test.ts`
- `npm run typecheck`
- Evidence (2026-11-10): `src/lib/review/gate.ts` (`evaluateGate`, `describeBlocking`, `gatePassingStates`) and `src/commands/review/gate.ts` (`weave review gate --change [--json]`, exit 0 either way, `invalid_arguments` without `--change`). Uses `effectiveState` + `evaluateOutOfDate` per slice and first-contact `adoptChange`. Blocking entries: `{slice, effective_state, reasons}` (`out_of_date` with its reasons; otherwise the state). Flat changes pass (`flat: true`).
- `npx vitest run tests/review-gate.test.ts`: 7 passed (pass states, each blocking state incl. `not_ready_for_review`, out of date, skipped only with a skipped change, flat, predates_review stamping, missing `--change`).

### T2: Add weave review package --change

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1
Files:
- `src/lib/review/package.ts` (M: change package)
- `src/commands/review.ts` (M)
- `tests/cli-review-change.test.ts` (C)

### What to build

Change package per `contracts.md`: allocate `change/f<N>`, end snapshots under `_change/`, diff from the diff base in every change repo, "plan and docs edits" section, all slices' saved Minors, rulings (settled and reopened), untested tasks, human checks, planning docs, decisions, guidelines. Gate check with `--partial`. Works in flat mode.

### Acceptance Criteria

- [x] A two-slice change package holds both slices' code once each and every saved item from both slice records.
- [x] A `wiki/decisions/` edit appears under "plan and docs edits" and not in the code diff.
- [x] Without `--partial`, a failing gate gives `gate_failed`; with it, the run is partial.
- [x] A flat change packages without error.

### Verification

- Automated tests: `npx vitest run tests/cli-review-change.test.ts`
- `npm run typecheck`
- Evidence (2026-11-10): `buildChangePackage`, `allocateChangeRun`, `renderChangePackage` in `src/lib/review/package.ts`; `package --change [--partial] [--force] [--out]` in `src/commands/review/package.ts`. Run `change/f<N>`, end ref `refs/weave/reviews/<change>/_change/f<N>/end`, package `.weave/tmp/reviews/<change>/_change/f<N>.package.md`, model level `most_capable`. Diff per change repo (`changeRepoIds`: root + checkout repos + slice repos, or flat `Repos:`) from `resolveDiffBase`; `wiki/changes/**` excluded; `wiki/knowledge/**`, `wiki/decisions/**`, `.weave/coding-guidelines.md` under "Plan and docs edits" (`isPlanOrDocsPath`). Context: planning docs (all slices), decisions, guidelines, settled/reopened rulings (`classifyRulings({kind: "change"})`), saved Minors of each slice's latest run, untested tasks, human checks, task evidence. Change block `in_progress`, `latest_run`, `partial`, change `plan_basis`.
- `npx vitest run tests/cli-review-change.test.ts`: two-slice package (each file's diff once, decision/knowledge edits only under plan and docs, every saved item), `gate_failed` and `--partial`, flat change, `change_review_skipped`.

### T3: Record change runs with the Minor sort and a single fix batch

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T2
Files:
- `src/lib/review/record.ts` (M)
- `src/commands/review.ts` (M: change-run paths for snapshot and package `--fix-round`)
- `tests/cli-review-change.test.ts` (M)

### What to build

- Accept change runs in `record`, with files under `wiki/changes/<id>/review/`.
- Validate and store `final_only.minor_sort` against existing slice Minors.
- Map round 1 of a change run to `fix-start` / `fix-end` refs and `f<N>-fix.patch`, and reject round 2 with `round_limit`.
- Plan findings stop the run (`not_ready`, waiting on the person), as for slices.

### Acceptance Criteria

- [x] A `minor_sort` naming an unknown finding exits 4.
- [x] The fix batch patch and check files land at the change-level paths.
- [x] A second round is rejected.

### Verification

- Automated tests: `npx vitest run tests/cli-review-change.test.ts`
- `npm run typecheck`
- Evidence (2026-11-10): `resolveRun` accepts `change/f<N>` (`ResolvedRun.scope`, `changeRunLocation`); record/resolve/fix-check/failed dispatch on scope (`readRunBlock`, `updateRunBlock`, `runRepoCheckouts`, `runTasksFor`, `changeRunTasks`). `resolveMinorSort` + `applyMinorSort`: entries must name a Minor of the run or a slice run (unknown or non-Minor -> `report_invalid`, exit 4); slice Minors are copied into `f<N>.findings.json` with `final_sort` and `origin_run` (slice files untouched); `can_wait` parks (`by_sort`), `must_fix` stays open and joins the fix batch targets. Rounds: `roundRef` maps round 1 to `_change/f<N>/fix-start|fix-end`, files `review/f<N>-fix.patch` and `f<N>-fix.check.md` (`runRoundStem`); round 2 -> `round_limit`. Plan finding -> change `not_ready`, resolving it other than `dismissed` -> exit 5.
- `npx vitest run tests/cli-review-change.test.ts`: Minor sort exit 4 cases, change-level patch/check paths, refs, `round_limit` for snapshot and package, plan stop.
- Post-slice fix (2026-11-10, PRD FR12): `final_only.minor_sort` may also name slice review rulings (any severity) by full id. `must_fix` reopens the ruling: it is copied into `f<N>.findings.json` unresolved (`source: minor_sort`, slice files untouched) and becomes a fix batch target; `can_wait` leaves it parked as the slice's ruling (not copied). Change runs store the sort with resolved ids. A non-Minor that is not a slice ruling still exits 4. Tests: `tests/cli-review-change.test.ts` ("sorts slice review rulings", "validates a ruling sort").

### T4: Finalize the change verdict, take file ownership, and write the change review record

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T3
Files:
- `src/lib/review/record.ts` (M)
- `src/lib/review/fingerprint.ts` (M: change fingerprint, change out-of-date)
- `src/lib/review/state.ts` (M, if change helpers are missing)
- `src/commands/review.ts` (M: `status --change` uses change out-of-date)
- `tests/cli-review-change.test.ts` (M)

### What to build

Change `--finalize` per `contracts.md` § State: verdict through `deriveVerdict`, counts, change fingerprint after the fix batch, `releaseOwnership` for every covered file, and `wiki/changes/<id>/review.md` with the "All rulings" list. `status --change` overlays out-of-date.

### Acceptance Criteria

- [x] An agreed Critical ruling, an open plan problem, or a partial run gives `not_ready`.
- [x] Only can-wait Minors, disagreed rulings, or human checks give `ready_with_parked_items`; nothing open gives `ready_to_merge`.
- [x] After finalize, slice fingerprints no longer list files the change run covered.
- [x] `review.md` lists rulings from every slice run and the change run with cost if wrong.

### Verification

- Automated tests: `npx vitest run tests/cli-review-change.test.ts`
- `npm run typecheck`
- Evidence (2026-11-10): `finalizeChangeRun` (via `finalizeRun`), `changeVerdictSummary` -> `deriveVerdict`, `renderChangeReviewRecord` (`wiki/changes/<id>/review.md`: verdict, runs, Minor sort, "All rulings" with cost if wrong and reopened). Finalize stores `state` (verdict), `fingerprint` (after the fix batch, `changeCoveredFiles`), `plan_basis` (`computeChangePlanBasis`), `merge_base`, `reviewed_task_total`, `counts`, `partial`; `releaseOwnership(ctx, files)` with no exception. `evaluateChangeOutOfDate` feeds `status --change` (`out_of_date`, reasons; stored verdict kept). `round_not_ended` when the fix batch was never packaged. Coordinator ruling: decision hashes (`decisionHash` in rules.ts, used by `decisionHashes`) cover the stripped body plus `superseded_by`, so superseding a cited decision is `plan_changed` and reopens rulings; status-only edits are not.
- `npx vitest run tests/cli-review-change.test.ts tests/review-rules.test.ts tests/review-fingerprint.test.ts`: verdict scenarios, ownership release, review.md, out of date and revert; `decisionHash` unit test, superseded_by -> `plan_changed`, accepting a superseding decision -> `plan_changed`, superseded_by reopens a ruling, status-only edits do not.
- Post-slice fix (2026-11-10, PRD FR27 and FR12): a plan finding a person dismissed is listed under "All rulings" as the person's ruling with who dismissed it (`collectDismissals`), and `changeVerdictSummary` counts it as a parked ruling (in `open_rulings` and `parked_items`), since every ruling other than an agreed Critical one is a parked item. "All rulings" also shows how the latest change run sorted each slice ruling. Tests: `tests/cli-review-change.test.ts` ("lists a dismissed plan problem as the person's ruling").

### T5: Verify gate cases, verdict outcomes, flat mode, and verdict out of date

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T4
Files:
- `tests/cli-review-change.test.ts` (M)

### What to build

End-to-end CLI tests in temporary repos: two slices reviewed → gate passes → change package → report with one must-fix Minor and one Important → fix batch → check → finalize, for each of the three verdicts. Add a flat-mode run and an edit after finalize that marks the verdict out of date (and a revert that clears it). Then run the full suite, typecheck, and build.

### Acceptance Criteria

- [x] All three verdicts are reached by their scenarios.
- [x] Flat mode and out-of-date scenarios pass.
- [x] The full suite, typecheck, and build pass.

### Verification

- Automated tests: `npx vitest run tests/review-gate.test.ts tests/cli-review-change.test.ts`, then `npm test`
- `npm run typecheck && npm run build`
- Evidence (2026-11-10): `tests/cli-review-change.test.ts` (12 tests, temp git repos): ready with parked items (5) with must-fix and can-wait Minors, fix batch, check, ownership handoff, out of date on edit and current on revert, new slice -> `tasks_added` + `plan_changed`; ready to merge; not ready for agreed Critical, open plan problem, and partial; flat-mode full run; failed change run then `change/f2`.
- `npx vitest run tests/review-gate.test.ts tests/cli-review-change.test.ts`: 19 passed. `npm run typecheck`: pass. `npm test`: 50 files, 706 passed. `npm run build`: pass.

## QA Findings

| ID | Status | Severity | Source | Related Task | Summary |
| --- | --- | --- | --- | --- | --- |

None.

## Refactors

| ID | Status | Scope | Related Tasks | Summary |
| --- | --- | --- | --- | --- |

None.

## Verification

- 2026-11-10: `npm run typecheck` pass; `npm test` 50 files, 706 tests passed; `npm run build` pass.
