---
artifact: tasks
slice: 02-planning-triggers
status: draft
owner: engineering
created_at: 2026-11-11T03:30:00.000Z
updated_at: 2026-11-11T03:30:00.000Z
source: architecture
---

# Tasks: Planning commits for verdicts, stale clears, knowledge, and review results

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
| T1 | done | afk | root | | Commit on verdict, clear-stale, and knowledge | None |
| T2 | done | afk | root | | Commit on recorded review results | None |
| T3 | done | afk | root | | Verify planning commits for each recording command | T1, T2 |

## root

### T1: Commit on verdict, clear-stale, and knowledge

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- src/lib/changes.ts (M)
- src/commands/change.ts (M)

### What to build

Call `planningCheckpoint` after the status write in `verdictChange`, `clearChangeStaleness`, `knowledgeChange`; add flags and output.

### Acceptance Criteria

- [x] Implemented as described and typechecks

### Verification

- Automated tests: covered by the slice's verification task
- Typecheck: `npm run typecheck`
- Result (T1): passed — npx vitest run tests/checkpoints-planning.test.ts tests/cli-review-record.test.ts (27/27); full suite 757/757; typecheck clean (2026-11-11).

### T2: Commit on recorded review results

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- src/lib/review/record.ts (M)
- src/commands/review/record.ts (M)

### What to build

Call `planningCheckpoint` (moment `review`) after `finalizeRun`, `failRun`, and resolutions that set `waiting_on_person`; add flags; include `checkpoint` in review record results.

### Acceptance Criteria

- [x] Implemented as described and typechecks

### Verification

- Automated tests: covered by the slice's verification task
- Typecheck: `npm run typecheck`
- Result (T2): passed — npx vitest run tests/checkpoints-planning.test.ts tests/cli-review-record.test.ts (27/27); full suite 757/757; typecheck clean (2026-11-11).

### T3: Verify planning commits for each recording command

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1, T2
Files:
- tests/checkpoints-planning.test.ts (M)

### What to build

Integration tests.

### Acceptance Criteria

- [x] verdict, clear-stale, knowledge, and review record each return `checkpoint` and commit their owned paths.
- [x] Verdict owns its `--session` note and the change's decision files; knowledge owns `knowledge-delta.md` and listed knowledge files; review owns review records.
- [x] Command exit codes and existing outputs are unchanged apart from the added field/line.

### Verification

- verdict commit contains the session note when it was uncommitted
- clear-stale and knowledge commits contain status and owned files only
- review finalize commits slice review records
- `npx vitest run tests/checkpoints-planning.test.ts tests/cli-review-record.test.ts` and full suite pass
- Result (T3): passed — npx vitest run tests/checkpoints-planning.test.ts tests/cli-review-record.test.ts (27/27); full suite 757/757; typecheck clean (2026-11-11).


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
