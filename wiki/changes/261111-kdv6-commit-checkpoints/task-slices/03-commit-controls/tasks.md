---
artifact: tasks
slice: 03-commit-controls
status: draft
owner: engineering
created_at: 2026-11-11T03:30:00.000Z
updated_at: 2026-11-11T03:30:00.000Z
source: architecture
---

# Tasks: Switches, notice, and unattended marker

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
| T1 | done | afk | root | | Personal switch and settings command | None |
| T2 | done | afk | root | | Per-change skip | None |
| T3 | done | afk | root | | Notice, unattended marker, and run failures | None |
| T4 | done | afk | root | | Verify switches, notice, and run recording | T1, T2, T3 |

## root

### T1: Personal switch and settings command

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- src/lib/user-settings.ts (M)
- src/commands/settings.ts (M)
- src/lib/checkpoints.ts (M)

### What to build

Extend `UserSettings` with `commits`, add `weave settings commits`, read it in `resolveCommitSettings`, warn on unreadable settings.

### Acceptance Criteria

- [x] Implemented as described and typechecks

### Verification

- Automated tests: covered by the slice's verification task
- Typecheck: `npm run typecheck`
- Result (T1): passed — npx vitest run tests/checkpoints-controls.test.ts (6/6), tests/advance.test.ts asserts the WEAVE_UNATTENDED terminal prefix; full suite green; typecheck clean (2026-11-11).

### T2: Per-change skip

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- src/lib/changes.ts (M)
- src/commands/change.ts (M)
- src/lib/checkpoints.ts (M)

### What to build

Add `weave change skip-commits|unskip-commits` writing `commits.skipped` in the change status; honour it.

### Acceptance Criteria

- [x] Implemented as described and typechecks

### Verification

- Automated tests: covered by the slice's verification task
- Typecheck: `npm run typecheck`
- Result (T2): passed — npx vitest run tests/checkpoints-controls.test.ts (6/6), tests/advance.test.ts asserts the WEAVE_UNATTENDED terminal prefix; full suite green; typecheck clean (2026-11-11).

### T3: Notice, unattended marker, and run failures

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- src/lib/checkpoints.ts (M)
- src/lib/agent-launchers.ts (M)
- src/lib/changes.ts (M)

### What to build

First-commit notice with machine-local record; set `WEAVE_UNATTENDED=1` in launcher envs; record failed planning checkpoints on the lane's running run.

### Acceptance Criteria

- [x] Implemented as described and typechecks

### Verification

- Automated tests: covered by the slice's verification task
- Typecheck: `npm run typecheck`
- Result (T3): passed — npx vitest run tests/checkpoints-controls.test.ts (6/6), tests/advance.test.ts asserts the WEAVE_UNATTENDED terminal prefix; full suite green; typecheck clean (2026-11-11).

### T4: Verify switches, notice, and run recording

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1, T2, T3
Files:
- tests/checkpoints-controls.test.ts (C)
- tests/cli-settings.test.ts (M)

### What to build

Tests for precedence, commands, notice once, env marker, run checkpoint.

### Acceptance Criteria

- [x] Project off (main or change folder) > personal off (project scope > default) > per-change skip; outcome names the switch.
- [x] `weave settings commits` writes only personal settings.
- [x] Notice appears once per project per machine in an attended command.
- [x] Background/terminal/here launches set `WEAVE_UNATTENDED=1`.
- [x] A running run whose lane's planning commit failed records `checkpoint` on the run.

### Verification

- precedence matrix of project/personal/skip
- notice emitted once, not consumed under WEAVE_UNATTENDED
- launcher env contains WEAVE_UNATTENDED
- `npx vitest run tests/checkpoints-controls.test.ts tests/cli-settings.test.ts` and full suite pass
- Result (T4): passed — npx vitest run tests/checkpoints-controls.test.ts (6/6), tests/advance.test.ts asserts the WEAVE_UNATTENDED terminal prefix; full suite green; typecheck clean (2026-11-11).


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
