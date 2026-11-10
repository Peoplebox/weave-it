---
artifact: tasks
slice: 09-switches-and-status-visibility
status: draft
owner: engineering
created_at: 2026-11-09T23:35:06.000Z
updated_at: 2026-11-09T23:35:06.000Z
source: architecture
---

# Tasks: Review switches, status lines, and the reviews-available notice

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
| T1 | done | afk | root | | Add weave review skip and unskip with the skipped overlay | None |
| T2 | done | afk | root | | Show review progress and the verdict in weave change status | T1 |
| T3 | done | afk | root | | Add the skills_available notice | None |
| T4 | done | afk | root | | Show the active change's review summary in weave status | T2, T3 |
| T5 | done | afk | root | | Regression: status output is unchanged for changes without review data | T4 |

## root

### T1: Add weave review skip and unskip with the skipped overlay

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `src/commands/review.ts` (M: `skip`, `unskip`)
- `src/lib/review/state.ts` (M: skipped overlay helper, if not already present)
- `tests/cli-review-skip.test.ts` (C)

### What to build

`skip` and `unskip` per `contracts.md`, and the skipped overlay for every slice when the change is skipped or the workspace is off.

### Acceptance Criteria

- [x] `skip --reason` writes the block; `skip` without a reason exits 1 with `missing_reason`.
- [x] After skip, `review status` returns `active: false` and every slice `skipped`; the gate passes.
- [x] `unskip` restores the previous effective states.

### Verification

- Automated tests: `npx vitest run tests/cli-review-skip.test.ts`
- `npm run typecheck`
- Evidence (2026-11-10): `npx vitest run tests/cli-review-skip.test.ts` passed (7 tests): missing_reason with no write, skip block written, `review status` `active: false`/`inactive_cause: change_skipped` with every slice `skipped` (stored state kept), gate `pass: true, reason: inactive`, same-reason re-skip keeps `at`, unskip restores states, unskip no-op writes nothing, workspace-off and skill-missing causes, rollup readiness falls back to `done` for all three causes. `npm run typecheck` passed.

### T2: Show review progress and the verdict in weave change status

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1
Files:
- `src/lib/changes.ts` (M: `formatStatusTarget` and the status result)
- `tests/cli-change-status-review.test.ts` (C)

### What to build

Build a review summary (reusing `review status` logic from `src/lib/review/*`, not the CLI) and render the lines and JSON in `contracts.md`. Failures to read review data show `review: unreadable` and never fail the command.

### Acceptance Criteria

- [x] Each slice state renders in its PRD wording ("tasks done, not reviewed", "in review", "reviewed", "reviewed with rulings", "waiting on you: plan problem", "reviewed, out of date", "review skipped").
- [x] The verdict line renders all three verdicts, the parked count, and out of date.
- [x] JSON carries the `review` object.

### Verification

- Automated tests: `npx vitest run tests/cli-change-status-review.test.ts`
- `npm run typecheck`
- Evidence (2026-11-10): `npx vitest run tests/cli-change-status-review.test.ts` passed: PRD wording for every slice state including out of date (code changed), read-only predates-review projection, all three verdicts with parked count, rulings, partial, and out of date, skipped and workspace-off lines, skill-missing stored-only view, and `Review: unreadable` without failing. JSON `change.review` asserted. `npm run typecheck` passed.

### T3: Add the skills_available notice

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `src/lib/notices.ts` (M)
- `tests/notices.test.ts` (M)

### What to build

In `gatherNotices`, compare `listDefaultSkills` with each configured agent's manifest entries and emit one `skills_available` notice listing missing skills per agent, per `contracts.md`.

### Acceptance Criteria

- [x] A manifest missing one bundled skill gives one notice naming it and the agent install command.
- [x] A complete manifest, no manifest, or `WEAVE_NO_NOTICES=1` gives none.
- [x] Existing notice tests pass unchanged.

### Verification

- Automated tests: `npx vitest run tests/notices.test.ts tests/cli-tier1-notices.test.ts`
- `npm run typecheck`
- Evidence (2026-11-10): `npx vitest run tests/notices.test.ts tests/cli-tier1-notices.test.ts` passed: one notice naming the missing skill and `weave agent install claude`; multi-agent message; none for a complete manifest, no manifest, empty manifest, or `WEAVE_NO_NOTICES=1`; existing notice tests unchanged. `npm run typecheck` passed.

### T4: Show the active change's review summary in weave status

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T2, T3
Files:
- `src/lib/status.ts` (M)
- `tests/cli-status.test.ts` (M)

### What to build

When the current folder resolves an active change with review data, add the review line and JSON `review` object to `weave status`. Never fail `weave status` because of review data.

### Acceptance Criteria

- [x] Inside a change with a recorded verdict, the line shows the verdict.
- [x] Outside any change, no line and `review: null`.
- [x] The `skills_available` notice appears under `Notices`.

### Verification

- Automated tests: `npx vitest run tests/cli-status.test.ts`
- `npm run typecheck`
- Evidence (2026-11-10): `npx vitest run tests/cli-change-status-review.test.ts tests/cli-status.test.ts` passed: verdict line `Review (<id>): verdict: ready with parked items (3)`, slice-count summary before the final review, `review: null` and no line outside a change, `skills_available` listed under `Notices`. `npm run typecheck` passed.

### T5: Regression: status output is unchanged for changes without review data

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T4
Files:
- `tests/cli-change-status-review.test.ts` (M)

### What to build

Assert that `weave change status` and `weave status` text for a change with no `review` block and review inactive is identical to the pre-change format (no review lines, same line order). Then run the full suite, typecheck, and build.

### Acceptance Criteria

- [x] No review lines appear for such changes.
- [x] The full suite, typecheck, and build pass.

### Verification

- Automated tests: `npx vitest run tests/cli-change-status-review.test.ts`, then `npm test`
- `npm run typecheck && npm run build`
- Evidence (2026-11-10): regression cases in `tests/cli-change-status-review.test.ts` passed for skill-not-installed and workspace-off with no review data: same line order, no `Review:`/`Verdict:` lines, no `review` JSON key, no write, `weave status` `review: null`. `npm test` 728 passed (52 files); `npm run typecheck` and `npm run build` passed.

## QA Findings

| ID | Status | Severity | Source | Related Task | Summary |
| --- | --- | --- | --- | --- | --- |

None.

## Refactors

| ID | Status | Scope | Related Tasks | Summary |
| --- | --- | --- | --- | --- |

None.

## Verification

- 2026-11-10: `npm run typecheck`, `npm test` (728 passed, 52 files), and `npm run build` passed.
