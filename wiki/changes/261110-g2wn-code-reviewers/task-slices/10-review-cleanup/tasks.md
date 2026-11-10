---
artifact: tasks
slice: 10-review-cleanup
status: draft
owner: engineering
created_at: 2026-11-09T23:35:06.000Z
updated_at: 2026-11-09T23:35:06.000Z
source: architecture
---

# Tasks: Clean up snapshot refs and packages for finished changes

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
| T1 | done | afk | root | | Decide prune candidates and delete their refs and packages | None |
| T2 | done | afk | root | | Add weave review prune | T1 |
| T3 | done | afk | root | | Run prune from the background refresh after its landed check | T1 |
| T4 | done | afk | root | | Regression: close keeps review refs and refresh survives prune failures | T2, T3 |

## root

### T1: Decide prune candidates and delete their refs and packages

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `src/lib/review/prune.ts` (C)
- `tests/review-prune.test.ts` (C)

### What to build

`pruneReviews` per `contracts.md`: list candidate change ids from refs in every registered repo, classify each with the landed check (`checkLanded` through the same inputs `change-facts.ts` uses, or the passed facts) and the "no longer exists" rule, and delete refs and packages for `landed` and `missing` only.

### Acceptance Criteria

- [x] A landed change's refs are deleted in both repos of a two-repo workspace.
- [x] `landed_with_newer_commits`, `not_landed`, and `unchecked` changes keep their refs.
- [x] A change with refs but no folder, no branch, and no local state is pruned as `missing`.
- [x] `refs/weave/remotes/*` is untouched.

### Verification

- Automated tests: `npx vitest run tests/review-prune.test.ts`
- `npm run typecheck`
- Done: `pruneReviews` in `src/lib/review/prune.ts` lists candidates from `refs/weave/reviews/` in every registered repo, prunes only change-level `landed` (every repo with commits exactly `landed`, as `weave change list` decides) or missing, deletes refs per repo in one `update-ref --stdin` transaction, then packages in the change folder and main checkout.
- 2026-11-10: `npx vitest run tests/review-prune.test.ts` passed (landed two-repo prune, kept not_landed / landed_with_newer_commits / no_commits / unchecked, missing prune, `refs/weave/remotes/*` untouched, `--change` scoping); `npm run typecheck` passed.

### T2: Add weave review prune

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1
Files:
- `src/commands/review.ts` (M: `prune`)
- `tests/review-prune.test.ts` (M)

### What to build

The `prune [--change <id>] [--json]` subcommand per `contracts.md`, with a short text summary ("Pruned review refs for 2 changes.").

### Acceptance Criteria

- [x] JSON matches the contract shape.
- [x] `--change` on an open change prunes nothing.

### Verification

- Automated tests: `npx vitest run tests/review-prune.test.ts`
- `npm run typecheck`
- Done: `src/commands/review/prune.ts` (`registerReviewPrune`, `reviewPrune`, `renderReviewPrune`), one import + register line in `src/commands/review.ts`.
- 2026-11-10: `npx vitest run tests/review-prune.test.ts` passed (contract JSON, `--change` on an open change prunes nothing, text "Pruned review refs for 1 change." / "Nothing to prune."); `npm run typecheck` passed.

### T3: Run prune from the background refresh after its landed check

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1
Files:
- `src/lib/change-refresh.ts` (M)
- `tests/change-refresh.test.ts` (M)

### What to build

In `runRefresh`, after `gatherFacts`, call `pruneReviews(mainRoot, { facts: gathered })` inside a `try` that ignores errors. Do not add network work or new prompts (decision `261108-4ko1`).

### Acceptance Criteria

- [x] A refresh over a workspace with a landed change removes its review refs.
- [x] A prune that throws leaves the refresh result and the attention snapshot unchanged.

### Verification

- Automated tests: `npx vitest run tests/change-refresh.test.ts`
- `npm run typecheck`
- Done: `runRefresh` calls `pruneReviews(mainRoot, { facts: gathered })` after the attention write, in its own `try` that ignores errors; local git only.
- 2026-11-10: `npx vitest run tests/change-refresh.test.ts` passed (landed change's refs pruned, open change's kept; a throwing prune leaves the refresh record and attention snapshot unchanged); `npm run typecheck` passed.

### T4: Regression: close keeps review refs and refresh survives prune failures

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T2, T3
Files:
- `tests/review-prune.test.ts` (M)

### What to build

Add a test that runs `weave change close` on a change with review refs and asserts they remain, and one where a repo's ref deletion fails (read-only ref store or a stubbed git) and prune reports `reason: "error"` while continuing. Then run the full suite, typecheck, and build.

### Acceptance Criteria

- [x] Both regressions pass.
- [x] The full suite, typecheck, and build pass.

### Verification

- Automated tests: `npx vitest run tests/review-prune.test.ts tests/change-refresh.test.ts`, then `npm test`
- `npm run typecheck && npm run build`
- 2026-11-10: `npx vitest run tests/review-prune.test.ts tests/change-refresh.test.ts` passed (close keeps review refs; a stale `start.lock` in one repo yields `kept: [{reason: "error", repo: "api"}]` while root and web are pruned and packages are kept).
- 2026-11-10: `npm run typecheck`, `npm test` (43 files, 620 tests), and `npm run build` passed.

## QA Findings

| ID | Status | Severity | Source | Related Task | Summary |
| --- | --- | --- | --- | --- | --- |

None.

## Refactors

| ID | Status | Scope | Related Tasks | Summary |
| --- | --- | --- | --- | --- |

None.

## Verification

- 2026-11-10: `npm run typecheck`, `npm test` (620 passing), `npm run build` passed.
