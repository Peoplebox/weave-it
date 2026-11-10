---
artifact: tasks
slice: 01-readiness-rules-and-rollup
status: draft
owner: engineering
created_at: 2026-11-09T23:35:06.000Z
updated_at: 2026-11-10T00:00:00.000Z
source: architecture
---

# Tasks: Review readiness rules, preserved review state, and weave review status

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
| T1 | done | afk | root | | Add the pure review rules module | None |
| T2 | done | afk | root | | Add the per-change lock and the locked review-block writer | T1 |
| T3 | done | afk | root | | Add review activation, workspace review settings, and adoption stamping | T2 |
| T4 | done | afk | root | | Make slice rollup carry review state, lock, and report review readiness | T3 |
| T5 | done | afk | root | | Add the weave review command group with the status subcommand | T3 |
| T6 | done | afk | root | | Regression: rollup keeps review blocks under concurrent writes and gates dependents only when review is active | T4, T5 |

## root

### T1: Add the pure review rules module

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `src/lib/review/rules.ts` (C)
- `tests/review-rules.test.ts` (C)

### What to build

Implement every function in `contracts.md` § Interfaces under `rules.ts` as pure functions with exported types (`StoredSliceState`, `EffectiveSliceState`, `OutOfDateReason = "code_changed" | "plan_changed" | "tasks_added"`, `ChangeVerdict`). Import `TaskStatus` from `sliceRollup.ts` and `hashDocument` from `sync.ts`. No file or git access.

### Acceptance Criteria

- [x] `isReadyForReview` is true for `[done, not_tested, invalid]`, false for `[done, todo]`, false for `[]` and `[invalid]`.
- [x] `satisfiesDependents` covers every stored state with review active and inactive.
- [x] `effectiveState` derives `not_reviewed`, keeps the stored state under an out-of-date overlay, and returns to current when reasons are empty.
- [x] `deriveVerdict` is tested over all combinations of its inputs: a Critical ruling with `agreed: true`, an open plan problem, or `partial` gives `not_ready`; only can-wait Minors, `agreed: false` rulings, or human checks give `ready_with_parked_items`; nothing open gives `ready_to_merge`.
- [x] `bodyHash` ignores frontmatter-only edits and changes on a body edit.

### Verification

- Automated tests: `npx vitest run tests/review-rules.test.ts`
- `npm run typecheck`
- Evidence (2026-11-10): `npx vitest run tests/review-rules.test.ts` passed (15 tests, including all 128 `deriveVerdict` input combinations); `npm run typecheck` passed.
- Note: `effectiveState` derives `not_ready_for_review` for a slice with open tasks and no stored state; `deriveVerdict` treats `otherOpen > 0` as `not_ready`.

### T2: Add the per-change lock and the locked review-block writer

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1
Files:
- `src/lib/local-state.ts` (M: add `withChangeLock`)
- `src/lib/review/state.ts` (C)
- `tests/review-state.test.ts` (C)

### What to build

- `withChangeLock(mainRoot, changeId, action)` in `local-state.ts`: lock directory `locks/change-<id>` under `localStateDir`, same retry and 30 s stale rule as `withStateLock`. Leave `withStateLock` unchanged.
- `state.ts`: review block types from `schema.md`, `readSliceReview`, `readChangeReview`, and `updateSliceReview` / `updateChangeReview`. Each update takes the per-change lock, re-reads the YAML, replaces only the `review` key with the mutated value, and writes through `writeFileAtomic`.
- Outside a git repo, run without a lock (see `contracts.md` § Interfaces).

### Acceptance Criteria

- [x] Twenty concurrent `updateSliceReview` calls, each adding a distinct key, all survive.
- [x] An update leaves every non-`review` key in the file byte-for-byte equivalent after YAML round trip.
- [x] Two worktrees of one repo share the same lock directory.
- [x] No `.git` folder is created when the change lives outside a git repo.

### Verification

- Automated tests: `npx vitest run tests/review-state.test.ts`
- `npm run typecheck`
- Evidence (2026-11-10): `npx vitest run tests/review-state.test.ts` passed (20 concurrent writers, key preservation with comments kept, shared lock across worktrees, no `.git` outside git); `npm run typecheck` passed.

### T3: Add review activation, workspace review settings, and adoption stamping

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T2
Files:
- `src/lib/workspace-repos.ts` (M: parse `review:` settings)
- `src/lib/review/state.ts` (M)
- `tests/review-state.test.ts` (M)

### What to build

- Parse `review: { enabled, slice_rounds, models }` in `readWorkspaceMetadata`, with defaults from `contracts.md` § Data.
- `reviewActivation(ctx)`: `active` when enabled is not false, the change has no `review.skipped`, and `loadAgentsManifest` lists `weave-review` for at least one agent. `skill_paths` are the installed `SKILL.md` paths of `weave-review` from the manifest.
- `adoptChange(ctx)` per `contracts.md` § State, under the change lock. Coordinator ruling: adoption runs **only while `reviewActivation` is active**. While review is inactive (skill not installed, disabled, or change skipped), `adoptChange` writes nothing. Adoption therefore happens the first time the change is touched with review active, and every slice already ready at that moment gets `predates_review`. This avoids retroactive reviews for projects that upgrade the CLI before installing `weave-review`.

### Acceptance Criteria

- [x] Each of the three inactive causes gives `active: false`; all three satisfied gives `active: true` with the installed paths.
- [x] While review is inactive, `adoptChange` writes nothing. The first call after review becomes active stamps every slice already ready for review.
- [x] Adoption stamps `predates_review` only on slices already ready for review with no `review` block, and a second call writes nothing.
- [x] A slice that becomes ready after adoption stays unstamped (reads as `not_reviewed`).
- [x] An existing `workspace.yml` writer (`weave add`) keeps a `review:` key it did not set.

### Verification

- Automated tests: `npx vitest run tests/review-state.test.ts`
- `npm run typecheck`
- Evidence (2026-11-10): `npx vitest run tests/review-state.test.ts` passed (19 tests: three inactive causes, adoption only while active, once-only stamping, late-ready slice unstamped, `registerRepoInWorkspaceMetadata` keeps `review:`); `npm run typecheck` passed.

### T4: Make slice rollup carry review state, lock, and report review readiness

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T3
Files:
- `src/lib/sliceRollup.ts` (M)
- `tests/slice-rollup.test.ts` (M)

### What to build

- `SliceMetadata` gains optional `review`. `readSliceStatus` carries it, and the writer emits it unchanged (absent stays absent).
- `rollupSlice` runs its read-modify-write under `withChangeLock` and writes through `writeFileAtomic`.
- `renderSliceDisplayStatus` and the dependency-graph renderers use `satisfiesDependents(slice, reviewActive)` instead of `status === "done"`. Rollup needs the task statuses per slice, so keep the parsed statuses beside the metadata.
- `RollupChangeResult` gains `ready_slices`, and each slice result gains `ready_for_review`.
- `rollupChange` calls `adoptChange` once before rolling up.

### Acceptance Criteria

- [x] A hand-written `review:` block survives `weave slice rollup` and `--check` reports no change for it.
- [x] `ready_for_review` is true for a slice with `not_tested` tasks whose `status` is `in_progress`.
- [x] With review active, `ready_slices` excludes a slice whose dependency is `done` but `not_reviewed`, and includes it once the dependency's stored state is `reviewed`.
- [x] With review inactive, every existing rollup test passes unchanged.

### Verification

- Automated tests: `npx vitest run tests/slice-rollup.test.ts`
- `npm run typecheck`
- Evidence (2026-11-10): `npx vitest run tests/slice-rollup.test.ts` passed; all pre-existing rollup tests pass unchanged; `npm run typecheck` passed.
- Note: `--check` no longer writes slice files, and `updated_at` and the graph's "Generated at" line alone no longer count as a change, so `--check` can report no change.

### T5: Add the weave review command group with the status subcommand

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T3
Files:
- `src/commands/review.ts` (C)
- `src/cli.ts` (M: register `reviewCommand()`)
- `tests/cli-review-status.test.ts` (C)

### What to build

- `reviewCommand()` with the shared `runAction` / `errorResult` JSON shape used by `src/commands/slice.ts`. Resolve the active change through `activeChangeContext`.
- `status [--slice <id> | --change] [--json]` per `contracts.md` § Interfaces. It calls `adoptChange` (its only write), reads task statuses through `parseSliceTasksMarkdown`, and returns `effectiveState` with empty out-of-date reasons.
- Text output: one line per slice (`02: not reviewed`, `03: predates review`) plus `active: yes|no`.

### Acceptance Criteria

- [x] `--slice <id> --json` returns every contract field for a ready slice and for a slice still in progress.
- [x] `--change --json` returns the change block with `adopted_at`.
- [x] Unknown slice → `slice_not_found`; flat mode with `--slice` → `no_slices`; both exit 1 with the JSON error shape.

### Verification

- Automated tests: `npx vitest run tests/cli-review-status.test.ts`
- `npm run typecheck`
- Evidence (2026-11-10): `npx vitest run tests/cli-review-status.test.ts` passed (7 tests); `npm run typecheck` passed; `node dist/cli.js review status` smoke-tested on this change (inactive, no writes).
- Note: subcommands live in `src/commands/review/<subcommand>.ts` and register from `src/commands/review.ts`; shared helpers are in `src/commands/review/shared.ts`.

### T6: Regression: rollup keeps review blocks under concurrent writes and gates dependents only when review is active

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T4, T5
Files:
- `tests/slice-rollup.test.ts` (M)
- `tests/changes.test.ts` (M)

### What to build

Add regression tests:
- Rollup and `updateSliceReview` run concurrently on one slice ten times; every review write and every rollup field survives.
- `weave change verdict` and `weave change progress` keep a change `review:` block they did not write.
- A two-slice change where slice 02 depends on 01: with review inactive 02 is `ready` once 01 is `done`; with review active it stays `blocked` until 01 is `reviewed`.

Then run the full suite, typecheck, and build.

### Acceptance Criteria

- [x] All three regressions pass.
- [x] The full suite, typecheck, and build pass.

### Verification

- Automated tests: `npx vitest run tests/slice-rollup.test.ts tests/changes.test.ts`, then `npm test`
- `npm run typecheck && npm run build`
- Evidence (2026-11-10): `npx vitest run tests/slice-rollup.test.ts tests/changes.test.ts` passed (51 tests); `npm test` passed (35 files, 557 tests); `npm run typecheck` and `npm run build` passed.

## QA Findings

| ID | Status | Severity | Source | Related Task | Summary |
| --- | --- | --- | --- | --- | --- |

None.

## Refactors

| ID | Status | Scope | Related Tasks | Summary |
| --- | --- | --- | --- | --- |

None.

## Verification

- 2026-11-10: `npm run typecheck`, `npm test` (35 files, 557 tests; baseline 506), and `npm run build` passed.
