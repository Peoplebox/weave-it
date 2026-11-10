---
artifact: tasks
slice: 03-coding-guidelines
status: draft
owner: engineering
created_at: 2026-11-09T23:35:06.000Z
updated_at: 2026-11-09T23:35:06.000Z
source: architecture
---

# Tasks: Coding guidelines files and seeding

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
| T1 | done | afk | root | | Add guideline resolution and the starter template | None |
| T2 | done | afk | root | | Add weave review guidelines init | T1 |
| T3 | done | afk | root | | Seed the starter guidelines from weave init only | T1 |
| T4 | done | afk | root | | Regression: only weave init and guidelines init ever write the guidelines file | T2, T3 |

## root

### T1: Add guideline resolution and the starter template

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `src/lib/review/guidelines.ts` (C)
- `tests/review-guidelines.test.ts` (C)

### What to build

`resolveGuidelines`, `starterGuidelines`, and `writeGuidelinesIfMissing` per `contracts.md`. Resolve repo paths with the workspace repo list (`workspace-repos.ts`), relative to the change checkout folder, so a change's own edits apply (FR43).

### Acceptance Criteria

- [x] Repo mode returns exactly one entry.
- [x] Workspace mode with two repos, one with its own file, returns the shared entry plus a `present` and an `absent` repo entry.
- [x] A shared file that does not exist is `absent`, and resolution still succeeds.
- [x] A registered repo with no checkout appears in `missingRepos`.

### Verification

- Automated tests: `npx vitest run tests/review-guidelines.test.ts`
- `npm run typecheck`
- 2026-11-10: `npx vitest run tests/review-guidelines.test.ts` passed (9 tests); `npm run typecheck` passed. Repos with no local checkout or no registered path go to `missingRepos` only (no `files` entry); a repo at the workspace root collapses into the shared entry.

### T2: Add weave review guidelines init

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1
Files:
- `src/commands/review.ts` (M: add `guidelines init`)
- `tests/cli-review-guidelines.test.ts` (C)

### What to build

The `guidelines init [--repo <id>] [--json]` subcommand per `contracts.md`, including its error codes.

### Acceptance Criteria

- [x] First run → `created`, second run → `unchanged`, and an edited file is not touched.
- [x] `--repo` writes the repo file in workspace mode, and errors in repo mode or for an unknown repo.

### Verification

- Automated tests: `npx vitest run tests/cli-review-guidelines.test.ts`
- `npm run typecheck`
- 2026-11-10: `npx vitest run tests/cli-review-guidelines.test.ts` passed (5 tests); `npm run typecheck` passed. Smoke-tested `node dist/cli.js review guidelines init` (created, then unchanged; `--repo` in repo mode exits 1). Implemented in `src/commands/review/guidelines.ts`, registered from `src/commands/review.ts`; works on the checkout it runs in and needs no active change.

### T3: Seed the starter guidelines from weave init only

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1
Files:
- `src/lib/init-workspace.ts` (M)
- `tests/init.test.ts` (M)

### What to build

After `ensureWeaveScaffold` in both init paths of `init-workspace.ts`, call `writeGuidelinesIfMissing` for the shared file and add `.weave/coding-guidelines.md` to `created` when written. Do not add it to `ensureWeaveScaffold`.

### Acceptance Criteria

- [x] `weave init` (repo mode and workspace mode) creates the file and lists it in `created`.
- [x] Re-running `weave init` keeps an edited file.

### Verification

- Automated tests: `npx vitest run tests/init.test.ts`
- `npm run typecheck`
- 2026-11-10: `npx vitest run tests/init.test.ts` passed (34 tests): repo mode, workspace mode outside git, and adopted-repo workspace mode each write the starter and list `.weave/coding-guidelines.md` in `created`; the adopted repo gets no repo file; re-running init keeps an edited file.

### T4: Regression: only weave init and guidelines init ever write the guidelines file

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T2, T3
Files:
- `tests/init.test.ts` (M)

### What to build

In a project initialised and then given its guidelines file removed, run `weave change new`, `weave doctor`, and `weave agent update all`, and assert the file is still absent. Then run the full suite, typecheck, and build.

### Acceptance Criteria

- [x] None of those commands creates `.weave/coding-guidelines.md`.
- [x] The full suite, typecheck, and build pass.

### Verification

- Automated tests: `npx vitest run tests/init.test.ts`, then `npm test`
- `npm run typecheck && npm run build`
- 2026-11-10: regression test in `tests/init.test.ts` removes the file after init and runs `createChange` (worktree mode, checks the main checkout and the change folder), `buildDoctor` with and without fix, `addFolder`, and `updateAgentSkills({agent: "all"})`; the file stays absent. `npm run typecheck` passed, `npm test` passed (38 files, 579 tests), `npm run build` passed.

## QA Findings

| ID | Status | Severity | Source | Related Task | Summary |
| --- | --- | --- | --- | --- | --- |

None.

## Refactors

| ID | Status | Scope | Related Tasks | Summary |
| --- | --- | --- | --- | --- |

None.

## Verification

- 2026-11-10: `npm run typecheck`, `npm test` (38 files, 579 tests), and `npm run build` passed.
