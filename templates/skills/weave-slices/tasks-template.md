---
artifact: tasks
slice: <slice-id>
status: draft
owner: engineering
created_at: <iso>
updated_at: <iso>
source: architecture
---

# Tasks: <slice title>

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
| T1 | todo | hitl | <repo-id> | | <task title> | None |

## <repo-id>

### T1: <task title>

Status: todo
Owner:
Repos: <repo-id>
Execution: hitl
Blocked by: None
Files:
- <path> (C)

### What to build

<implementation summary>

### Acceptance Criteria

- [ ] <criterion>

### Verification

- Automated tests: <command>
- Manual/smoke check: <steps>
- Human check: <step a person must do>
<!-- Optional. Only for steps an agent cannot perform; reviews list each one as "needs your check". -->

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
