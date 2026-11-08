---
artifact: tasks
slice: 03-close-switch-missing-folders
status: draft
owner: engineering
created_at: 2026-11-08T14:27:28.000Z
updated_at: 2026-11-08T14:27:28.000Z
source: architecture
---

# Tasks: Close and switch for missing folders

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
| T1 | done | afk | root | | Close changes whose folders are missing | None |
| T2 | done | afk | root | | Recreate missing folders with switch | None |
| T3 | done | afk | root | | Verify close and switch recover every missing-folder case | T1, T2 |

## root

### T1: Close changes whose folders are missing

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `src/lib/changes.ts` (M)
- `src/lib/worktrees.ts` (M)

### What to build

Resolve `close <id>` through `gatherFacts`. Add the `changes_unavailable` and `worktree_locked` refusals. Per repo, nested first, run `git worktree remove <path>` whether or not the folder exists, and never `prune`. Delete `changes/<id>.yml`, keep `bases/`, add the moved-folder warning to text and `warnings[]`, then recompute `attention.json`.

### Acceptance Criteria

- [x] The branch can be deleted with `git branch -d` and checked out after close
- [x] Other changes' prunable entries survive

### Verification

- Typecheck: `npm run typecheck`
- Covered by T3
- Result (2026-11-08): passed via T3

### T2: Recreate missing folders with switch

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `src/lib/worktrees.ts` (M)
- `src/lib/changes.ts` (M)

### What to build

In `planTarget`, `reuse` requires `pathExists`. An unlocked prunable entry for `change/<id>`, at any path, becomes a planned `remove_stale_entry` followed by `add_existing`, applied in the apply phase only after every repo passes. Under `withStateLock`, re-check the slot and reassign with `nextFreeSlot` if taken, reporting `slot_changed`. Drop `setup[<repo>]` for recreated repos (`setup_reset`), write `repos`, and recompute `attention.json`. Make `change status <id>` and opening a folder report "folder missing; run `weave change list`".

### Acceptance Criteria

- [x] `switch` works after a folder move or a `worktrees.root` change
- [x] Existing setup approvals are kept

### Verification

- Typecheck: `npm run typecheck`
- Covered by T3
- Result (2026-11-08): passed via T3

### T3: Verify close and switch recover every missing-folder case

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1, T2
Files:
- `tests/worktrees.test.ts` (M)
- `tests/cli-change-list.test.ts` (M)

### What to build

Cover:
- `rm -rf`, then `close`, then `branch -d` succeeding
- `close` refusing locked, unavailable, and landed-with-uncommitted
- `close` after git already pruned its own record
- `switch` recreating, with a slot collision (`slot_changed`) and a setup reset
- `switch` after a move
- a blocked second repo leaving the first untouched
- every `next.commands` emitted for missing and closed states executed as given and succeeding
- the `weave status` counts (via `attention.json`) dropping after close

### Acceptance Criteria

- [x] Every case above has a named test

### Verification

- Automated tests: `npx vitest run tests/worktrees.test.ts tests/cli-change-list.test.ts`
- Typecheck: `npm run typecheck`
- Result (2026-11-08): passed: npx vitest run tests/worktrees.test.ts (31 tests); npm test; npm run typecheck

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
