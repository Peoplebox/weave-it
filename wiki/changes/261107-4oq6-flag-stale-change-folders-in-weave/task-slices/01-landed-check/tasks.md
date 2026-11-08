---
artifact: tasks
slice: 01-landed-check
status: draft
owner: engineering
created_at: 2026-11-08T14:27:28.000Z
updated_at: 2026-11-08T14:27:28.000Z
source: architecture
---

# Tasks: Shared landed check and starting-branch memory

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
| T1 | done | afk | root | | Add git primitives for landed checks | None |
| T2 | done | afk | root | | Remember and recover starting branches | T1 |
| T3 | done | afk | root | | Implement the landed algorithm and its cache | T1, T2 |
| T4 | done | afk | root | | Verify landed detection against real git repos | T3 |

## root

### T1: Add git primitives for landed checks

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `src/lib/git.ts` (M)

### What to build

Add `isAncestor`, `revCount`, `cherry`, `firstParentContains(tip, target)` (via `rev-list --first-parent --parents <tip>..<target>`), and `mergeTreeWrite(target, tip)`. `mergeTreeWrite` runs with `GIT_OBJECT_DIRECTORY` set to a fresh temp dir and `GIT_ALTERNATE_OBJECT_DIRECTORIES` set to the real objects dir, returns the first output line, and removes the temp dir. Add `gitVersionCaps()`, cached per process, exposing `noWriteFetchHead` (2.29), `worktreePorcelainFlags` (2.31), and `mergeTreeWrite` (2.38), with `WEAVE_TEST_GIT_NO_MERGE_TREE=1` forcing `mergeTreeWrite: false`.

### Acceptance Criteria

- [x] Each helper returns typed results and never prompts
- [x] `mergeTreeWrite` leaves the user's object count unchanged
- [x] Caps are probed from `git --version` once per process

### Verification

- Typecheck: `npm run typecheck`
- Covered by T4
- Result (2026-11-08): passed via T4: npx vitest run tests/landed.test.ts (25 tests); npm run typecheck

### T2: Remember and recover starting branches

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1
Files:
- `src/lib/change-bases.ts` (C)
- `src/lib/worktrees.ts` (M)

### What to build

Implement `bases/<id>.yml` read and atomic write under `withStateLock`. Write it in `ensureChangeWorktrees` for `add_new` repos, from the same values as the `checkout` block. Implement `recoverBase`, which tries the folder's `status.yml` `checkout.repos.<repo>` block (source `created`), then the oldest `git reflog show --format=%gs refs/heads/change/<id>` entry matching `branch: Created from <ref>` with the rejection rule (source `reflog`), then records `unknown`. Never delete `bases/` files.

### Acceptance Criteria

- [x] `change new` writes `bases/<id>.yml` for every `add_new` repo
- [x] Recovery rejects a SHA, `HEAD`, and `[origin/]change/<id>`
- [x] `close` leaves `bases/<id>.yml` in place

### Verification

- Typecheck: `npm run typecheck`
- Covered by T4
- Result (2026-11-08): passed: landed.test.ts starting-branch cases, worktrees.test.ts bases on create and kept after close

### T3: Implement the landed algorithm and its cache

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1, T2
Files:
- `src/lib/landed.ts` (C)

### What to build

Implement `checkLanded` following architecture/index.md "Landed algorithm" steps 1–7:
- target resolution (remote-derived only when `origin` exists, with `goneTargets` falling back to the default branch, and `local_view_older`)
- no-commits only with a known `base_commit`
- ancestor check with `merged` or `contained`
- merge-tree tree equality with the `cherry` rebased/squashed split
- the pre-2.38 cherry-only path
- the 50-commit first-parent walk for `landed_with_newer_commits`
- errors as `unchecked`

Add the `landed.json` cache with `git_caps` invalidation, oldest-first eviction at 1,000 entries, and lock-free last-writer-wins writes.

### Acceptance Criteria

- [x] Matches every rule in the Landed algorithm section
- [x] Cache hits skip all git calls except resolving the tip and target shas

### Verification

- Typecheck: `npm run typecheck`
- Covered by T4
- Result (2026-11-08): passed via T4 (25 tests)

### T4: Verify landed detection against real git repos

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T3
Files:
- `tests/landed.test.ts` (C)

### What to build

Build temp repos with a file-path bare `origin`, and cover:
- merged, squashed, and rebased
- newer commits after a squash
- an empty branch with a known base (`no_commits`)
- a merged branch with an unknown base (`landed`/`merged`) and an empty branch with an unknown base (`contained`)
- a stacked base
- a later same-line edit (`not_landed`)
- the 50-commit cap
- a merge only into local `main` (not landed)
- base recovery for `add_new` (from status.yml), `add_tracking` (rejected), and `checkout -b` (rejected)
- `WEAVE_TEST_GIT_NO_MERGE_TREE=1`
- cache hits and `git_caps` invalidation
- no new loose objects (`git count-objects -v` before and after)

### Acceptance Criteria

- [x] Every case above has a named test
- [x] Tests run without network access

### Verification

- Automated tests: `npx vitest run tests/landed.test.ts`
- Typecheck: `npm run typecheck`
- Result (2026-11-08): passed: npx vitest run tests/landed.test.ts tests/worktrees.test.ts (44 tests); npm test (335 tests); npm run typecheck

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
