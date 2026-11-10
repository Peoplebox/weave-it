---
artifact: tasks
slice: 05-commit-review-boundaries
status: draft
owner: engineering
created_at: 2026-11-11T03:30:00.000Z
updated_at: 2026-11-11T03:30:00.000Z
source: architecture
---

# Tasks: Review boundaries and fix commits

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
| T1 | done | afk | root | | CommitBoundary and factory | None |
| T2 | done | afk | root | | Fix and final-fix commits | T1 |
| T3 | done | afk | root | | Verify commit-backed boundaries | T2 |

## root

### T1: CommitBoundary and factory

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- src/lib/review/commit-boundary.ts (C)
- src/lib/review/boundary.ts (M)
- src/lib/review/package.ts (M)
- src/lib/review/rounds.ts (M)
- src/lib/review/fingerprint.ts (M)
- src/commands/review/snapshot.ts (M)
- src/lib/review/record.ts (M)

### What to build

Implement `CommitBoundary` (end refs to commits when clean and matching, else snapshot; `read()` parses `Weave-Merge-Base`) and route all `new SnapshotBoundary()` callers through `reviewBoundaryFor`.

### Acceptance Criteria

- [x] Implemented as described and typechecks

### Verification

- Automated tests: covered by the slice's verification task
- Typecheck: `npm run typecheck`
- Result (T1): passed — npx vitest run tests/checkpoints-review.test.ts (5/5); review suites (tests/review-*.test.ts, tests/cli-review-*.test.ts) green; full suite green; typecheck clean (2026-11-11).

### T2: Fix and final-fix commits

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1
Files:
- src/lib/checkpoints.ts (M)
- src/lib/review/rounds.ts (M)
- src/lib/review/package.ts (M)
- src/commands/review/status.ts (M)

### What to build

Make fix commits at round-end packaging and the change run's fix-end; skip with `build_not_committed` while the build is missing; `(continued)` on re-package; report boundary kinds.

### Acceptance Criteria

- [x] Implemented as described and typechecks

### Verification

- Automated tests: covered by the slice's verification task
- Typecheck: `npm run typecheck`
- Result (T2): passed — npx vitest run tests/checkpoints-review.test.ts (5/5); review suites (tests/review-*.test.ts, tests/cli-review-*.test.ts) green; full suite green; typecheck clean (2026-11-11).

### T3: Verify commit-backed boundaries

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T2
Files:
- tests/checkpoints-review.test.ts (C)

### What to build

Integration tests and regression of existing review suites against both kinds.

### Acceptance Criteria

- [x] Clean tree with matching build commit → end ref = build commit; dirty tree → snapshot.
- [x] Fix round makes its own commit and the round-end ref points at it; round patch still reverses with `git apply -R`.
- [x] Build missing → `build_not_committed`, snapshot boundaries.
- [x] Final review fix batch → `Final review fixes` commit.
- [x] Package and review status report `boundary: commit|snapshot` per repo.
- [x] With commits off, behaviour equals today's snapshots.

### Verification

- end ref equals build commit on clean tree; snapshot on dirty tree
- fix round commit, ref, and reversible patch
- build_not_committed path
- final fix commit
- existing review suites pass: `npx vitest run tests/review-*.test.ts tests/cli-review-*.test.ts`
- full suite passes
- Result (T3): passed — npx vitest run tests/checkpoints-review.test.ts (5/5); review suites (tests/review-*.test.ts, tests/cli-review-*.test.ts) green; full suite green; typecheck clean (2026-11-11).


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
