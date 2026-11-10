---
artifact: tasks
slice: 04-build-commits
status: draft
owner: engineering
created_at: 2026-11-11T03:30:00.000Z
updated_at: 2026-11-11T03:30:00.000Z
source: architecture
---

# Tasks: Build commits when a slice finishes

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
| T1 | done | afk | root | | Coverage and build-commit lookup | None |
| T2 | done | afk | root | | Make build commits from rollup | T1 |
| T3 | done | afk | root | | Verify build commits | T2 |

## root

### T1: Coverage and build-commit lookup

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- src/lib/checkpoints.ts (M)
- src/lib/sliceRollup.ts (M)

### What to build

Coverage hash from active task ids/statuses; find newest `Weave-Slice` commit and its coverage; superseded detection.

### Acceptance Criteria

- [x] Implemented as described and typechecks

### Verification

- Automated tests: covered by the slice's verification task
- Typecheck: `npm run typecheck`
- Result (T1): passed — npx vitest run tests/checkpoints-build.test.ts (4/4); full suite green; typecheck clean (2026-11-11).

### T2: Make build commits from rollup

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1
Files:
- src/lib/checkpoints.ts (M)
- src/lib/sliceRollup.ts (M)
- src/commands/slice.ts (M)

### What to build

After `rollupChange` releases the lock, call `codeCheckpoint('build')` for candidates; per-repo commits with exclusions, hooks, timeout, unattended refusal; add `checkpoints` to the result and text output.

### Acceptance Criteria

- [x] Implemented as described and typechecks

### Verification

- Automated tests: covered by the slice's verification task
- Typecheck: `npm run typecheck`
- Result (T2): passed — npx vitest run tests/checkpoints-build.test.ts (4/4); full suite green; typecheck clean (2026-11-11).

### T3: Verify build commits

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T2
Files:
- tests/checkpoints-build.test.ts (C)

### What to build

Integration tests.

### Acceptance Criteria

- [x] First finish, `not_tested` readiness, and re-finish with new coverage each make one build commit; re-running rollup is idempotent.
- [x] Other changes' `wiki/changes/<id>/` and `.weave/coding-guidelines*.md` are never staged.
- [x] Hooks run; rejection gives `hooks_rejected` and the rollup result still succeeds.
- [x] A failed build is retried until another slice has started; then the later build reports `leftovers_from`.
- [x] Under `WEAVE_UNATTENDED`, rollup skips build commits with `unattended`.

### Verification

- first finish commits; `not_tested` commits; re-finish commits again; re-run is idempotent
- exclusions hold; failing pre-commit → hooks_rejected and rollup ok
- retry then superseded with leftovers_from
- WEAVE_UNATTENDED skips; flat change skips
- `npx vitest run tests/checkpoints-build.test.ts tests/slice-rollup.test.ts` and full suite pass
- Result (T3): passed — npx vitest run tests/checkpoints-build.test.ts (4/4); full suite green; typecheck clean (2026-11-11).


## QA Findings

| ID | Status | Severity | Source | Related Task | Summary |
| --- | --- | --- | --- | --- | --- |

None.

## Refactors

| ID | Status | Scope | Related Tasks | Summary |
| --- | --- | --- | --- | --- |

None.

## Verification

Not run yet.
