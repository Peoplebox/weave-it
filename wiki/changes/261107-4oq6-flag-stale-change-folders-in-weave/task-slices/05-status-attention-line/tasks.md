---
artifact: tasks
slice: 05-status-attention-line
status: draft
owner: engineering
created_at: 2026-11-08T14:27:28.000Z
updated_at: 2026-11-08T14:27:28.000Z
source: architecture
---

# Tasks: Attention line in weave status

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
| T1 | done | afk | root | | Show the attention line from the last snapshot | None |
| T2 | done | afk | root | | Verify the status attention line and its JSON | T1 |

## root

### T1: Show the attention line from the last snapshot

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `src/lib/status.ts` (M)
- `src/commands/status.ts` (M)

### What to build

Resolve `findWorkspaceMode(cwd)` → `mainWorktreePath` → `attention.json`. Print `<N> change(s) need attention (<counts>). Run 'weave change list'.` before `Notices`, only when `total > 0`, using correct singular and plural forms. Add `changes_attention` to `--json`. Spawn no git processes beyond the existing path resolution.

### Acceptance Criteria

- [x] No network or landed-check calls
- [x] Nothing shown when there's no snapshot

### Verification

- Typecheck: `npm run typecheck`
- Covered by T2
- Result (2026-11-08): passed via T2

### T2: Verify the status attention line and its JSON

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1
Files:
- `tests/cli-status.test.ts` (M)

### What to build

Cover:
- the line with mixed counts and with zero counts omitted
- no line when the total is 0 or there's no snapshot
- the same output from the main checkout, a change folder, and a subfolder
- `--json` `changes_attention`, including `null`
- in-place mode unchanged

### Acceptance Criteria

- [x] Every case above has a named test

### Verification

- Automated tests: `npx vitest run tests/cli-status.test.ts`
- Typecheck: `npm run typecheck`
- Result (2026-11-08): passed: npx vitest run tests/cli-status.test.ts (10 tests); npm run typecheck

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
