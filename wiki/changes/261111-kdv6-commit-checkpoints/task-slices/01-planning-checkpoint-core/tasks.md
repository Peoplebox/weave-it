---
artifact: tasks
slice: 01-planning-checkpoint-core
status: draft
owner: engineering
created_at: 2026-11-11T03:30:00.000Z
updated_at: 2026-11-11T03:30:00.000Z
source: architecture
---

# Tasks: Planning commits when progress is recorded

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
| T1 | done | afk | root | | Build the checkpoint module | None |
| T2 | done | afk | root | | Commit on progress | T1 |
| T3 | done | afk | root | | Verify planning commits on progress | T2 |

## root

### T1: Build the checkpoint module

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- src/lib/checkpoints.ts (C)
- src/lib/workspace-repos.ts (M)

### What to build

Create `src/lib/checkpoints.ts` with: `checkpointGit()` runner (no identity substitution, `GIT_TERMINAL_PROMPT=0`, timeout via SIGTERM), `guardRepo()` (expected branch from status.yml, detached, MERGE_HEAD/CHERRY_PICK_HEAD/REVERT_HEAD/rebase dirs), `resolveCommitSettings()` (project switch: off in main checkout or change folder wins), `planningScope()` (change folder, this change's and superseded decision files + `wiki/decisions/index.md`, knowledge files from status `knowledge`), `ownedPaths(moment)` table from architecture/index.md, catch-up commit via `git add -- <p>` + `git commit --only -- <p>`, moment commit via `git add -- <owned>` + `git commit` (whole index) with `-c core.hooksPath=<empty temp dir>`, message composition (subject, body, `Now out of date:`, trailers, per-kind subject template, 72-col wrap), and the `CheckpointOutcome` type.

### Acceptance Criteria

- [x] Implemented as described and typechecks

### Verification

- Automated tests: covered by the slice's verification task
- Typecheck: `npm run typecheck`
- Result (T1): passed — npx vitest run tests/checkpoints-planning.test.ts (9/9), full suite 755/755, npm run typecheck clean (2026-11-11).

### T2: Commit on progress

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1
Files:
- src/lib/changes.ts (M)
- src/commands/change.ts (M)

### What to build

Call `planningCheckpoint` from `progressChange` after the status write, passing the lane, stale lanes from propagation, summary, and message file; add `checkpoint` to `ProgressChangeResult`; add `--summary` and `--commit-message` to `weave change progress`; add the one-line text output.

### Acceptance Criteria

- [x] Implemented as described and typechecks

### Verification

- Automated tests: covered by the slice's verification task
- Typecheck: `npm run typecheck`
- Result (T2): passed — npx vitest run tests/checkpoints-planning.test.ts (9/9), full suite 755/755, npm run typecheck clean (2026-11-11).

### T3: Verify planning commits on progress

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T2
Files:
- tests/checkpoints-planning.test.ts (C)

### What to build

Integration tests in temp git repos.

### Acceptance Criteria

- [x] `weave change progress <lane>` commits owned paths plus status on the change branch and returns `checkpoint`.
- [x] Leftover planning files go into a separate catch-up commit made with `--only`; staged edits stay for the moment commit.
- [x] Planning commits run no hooks (including `prepare-commit-msg`/`post-commit`).
- [x] Wrong branch, detached HEAD, operations in progress, and empty commits are skipped with reasons; status is always written.
- [x] Author is the configured git identity; missing identity gives `failed: identity_missing`.
- [x] Existing tests stay green.

### Verification

- progress commits owned paths and status on the change branch; author equals `git config user.email`
- catch-up commit holds only leftover change-folder files; a staged code file and a staged slice status.yml land in the moment commit
- a failing `pre-commit` and a `prepare-commit-msg` hook are not run for planning commits
- wrong branch / detached HEAD / rebase in progress → skipped; nothing to commit → no commit
- subject template and `--summary`/`--commit-message` shape the message; trailers present
- `npx vitest run tests/checkpoints-planning.test.ts` and full `npx vitest run` pass
- Result (T3): passed — npx vitest run tests/checkpoints-planning.test.ts (9/9), full suite 755/755, npm run typecheck clean (2026-11-11).


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
