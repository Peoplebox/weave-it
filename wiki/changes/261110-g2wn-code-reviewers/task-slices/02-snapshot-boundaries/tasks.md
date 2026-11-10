---
artifact: tasks
slice: 02-snapshot-boundaries
status: draft
owner: engineering
created_at: 2026-11-09T23:35:06.000Z
updated_at: 2026-11-09T23:35:06.000Z
source: architecture
---

# Tasks: Snapshot boundaries and the diff base

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
| T1 | done | afk | root | | Resolve the review diff base per repo | None |
| T2 | done | afk | root | | Add the ReviewBoundary interface and the snapshot implementation | None |
| T3 | done | afk | root | | Add weave review snapshot --slice --at start | T1, T2 |
| T4 | done | afk | root | | Verify snapshots leave HEAD, index, branch, and stash untouched across worktree and workspace layouts | T3 |

## root

### T1: Resolve the review diff base per repo

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `src/lib/review/base.ts` (C)
- `src/lib/landed.ts` (M: export the target resolver only)
- `tests/review-base.test.ts` (C)

### What to build

`resolveDiffBase` and `filesBetween` per `contracts.md`. Resolve the target branch exactly as `checkLanded` does (starting branch from the bases record or `status.yml` checkout block, then the default branch), then `mergeBase(HEAD, target)`. Fall back to `checkout.repos.<repo>.base_commit`, then return `source: "unknown"`.

### Acceptance Criteria

- [x] In-place change with no `base_commit` resolves `source: "merge_base"`.
- [x] With no target branch reachable but a `base_commit`, resolves `source: "base_commit"`.
- [x] With neither, resolves `source: "unknown"`.
- [x] Merging the target into the change branch moves the resolved base forward.
- [x] `filesBetween` lists exactly the files changed on main between two merge-bases (rebase scenario).
- [x] `git diff src/lib/landed.ts` shows only an added export.

### Verification

- Automated tests: `npx vitest run tests/review-base.test.ts`, plus `npx vitest run tests/landed.test.ts` stays green
- `npm run typecheck`
- Evidence (2026-11-10): `npx vitest run tests/review-base.test.ts tests/landed.test.ts` passed (33 tests); `npm run typecheck` passed. `git diff src/lib/landed.ts` shows only `export` added to `resolveTarget`.

### T2: Add the ReviewBoundary interface and the snapshot implementation

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `src/lib/review/boundary.ts` (C)
- `tests/review-boundary.test.ts` (C)

### What to build

`ReviewBoundary` and `SnapshotBoundary` per `contracts.md`:
- copy the real index file (from `git rev-parse --git-path index`) to a temporary path in the local state dir, set `GIT_INDEX_FILE`, run `git add -A`, `write-tree`, `commit-tree -m <message>`, and `update-ref`
- remove the temporary index in `finally`
- `diff`, `diffStat`, and `patch` run `git diff` between two commits with the exclusion pathspecs from `rules.ts`, `-U<context>`, and `--binary` for patches

### Acceptance Criteria

- [x] Snapshot includes a modified tracked file, a staged file, and an untracked file, and excludes a `.gitignore`d file.
- [x] `read` returns the recorded merge-base.
- [x] A diff between two snapshots excludes a change under `wiki/changes/`.
- [x] A patch between two snapshots applies with `git apply -R` and restores the earlier tree for the non-excluded files.
- [x] The temporary index is gone after success and after a forced git failure.

### Verification

- Automated tests: `npx vitest run tests/review-boundary.test.ts`
- `npm run typecheck`
- Evidence (2026-11-10): `npx vitest run tests/review-boundary.test.ts` passed (9 tests, including temp-index cleanup after a forced `update-ref` failure and `git apply -R` restoring the start tree); `npm run typecheck` passed.

### T3: Add weave review snapshot --slice --at start

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1, T2
Files:
- `src/commands/review.ts` (M: add `snapshot`)
- `src/lib/review/boundary.ts` (M: slice start helper, if needed)
- `tests/cli-review-snapshot.test.ts` (C)

### What to build

The `snapshot --slice <id> --at start [--force] [--json]` subcommand per `contracts.md` § Interfaces and § Validation and errors. Resolve each repo of the slice through the workspace repo list (repo mode: `root`), resolve its diff base for the recorded merge-base, create the ref, and write `review.start_ref` through `updateSliceReview`. Reject `--at` values other than `start` with `--slice` (`invalid_arguments`).

### Acceptance Criteria

- [x] First call creates the ref and sets `start_ref`; second call returns `created: false` and keeps the sha; `--force` replaces it.
- [x] Unknown slice and flat mode return their error codes.
- [x] A missing repo checkout is listed in `missing_repos` and the command still succeeds for the others.

### Verification

- Automated tests: `npx vitest run tests/cli-review-snapshot.test.ts`
- `npm run typecheck`
- Evidence (2026-11-10): `npx vitest run tests/cli-review-snapshot.test.ts` passed (create/keep/`--force`, adoption, `slice_not_found`/`no_slices`/`invalid_arguments`, `missing_repos`); `npm run typecheck` passed; `node dist/cli.js review snapshot --help` shows the command after `npm run build`.

### T4: Verify snapshots leave HEAD, index, branch, and stash untouched across worktree and workspace layouts

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T3
Files:
- `tests/review-boundary.test.ts` (M)
- `tests/cli-review-snapshot.test.ts` (M)

### What to build

Add tests that record `HEAD`, the branch name, the sha1 of the index file, `git status --porcelain`, and `git stash list` before and after a snapshot:
- in a plain repo
- from a linked worktree of that repo
- in a workspace with two registered repos, where each ref lands in its own repo

Then run the full suite, typecheck, and build.

### Acceptance Criteria

- [x] All recorded values are identical before and after in all three layouts.
- [x] The full suite, typecheck, and build pass.

### Verification

- Automated tests: `npx vitest run tests/review-boundary.test.ts tests/cli-review-snapshot.test.ts`, then `npm test`
- `npm run typecheck && npm run build`
- Evidence (2026-11-10): HEAD, branch, index sha1, `git --no-optional-locks status --porcelain`, and `git stash list` unchanged in a plain repo and a linked worktree (`tests/review-boundary.test.ts`) and in a two-repo workspace with a third missing checkout (`tests/cli-review-snapshot.test.ts`). `npm test` 592 passed (40 files), `npm run typecheck` and `npm run build` passed. All fixtures are temporary repos; this repository has no `refs/weave/reviews` refs.

## QA Findings

| ID | Status | Severity | Source | Related Task | Summary |
| --- | --- | --- | --- | --- | --- |

None.

## Refactors

| ID | Status | Scope | Related Tasks | Summary |
| --- | --- | --- | --- | --- |

None.

## Verification

2026-11-10: `npm run typecheck`, `npm test` (592 passed), and `npm run build` passed after T1 to T4.
