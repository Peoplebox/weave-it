# Contracts: Review readiness rules, preserved review state, and weave review status

See `architecture/index.md` (Shared rules, Locking, Activation and locating the skill), `architecture/schema.md`, and `architecture/api-contract.md` (`weave review status`). This slice implements the subset below.

## Interfaces

- `src/lib/review/rules.ts` (pure functions, no file or git access):
  - `isReadyForReview(statuses: TaskStatus[]): boolean`: every non-`invalid` task is `done` or `not_tested`, and there is at least one active task.
  - `satisfiesDependents(slice: { statuses; sliceStatus; reviewState? }, reviewActive: boolean): boolean`: review active → ready for review and stored state in `reviewed | reviewed_with_rulings | skipped | predates_review`; review inactive → rollup `status === "done"`. Uses the **stored** state, never the out-of-date overlay, so rollup output stays deterministic.
  - `effectiveState(stored: StoredSliceReview | undefined, ctx: { readyForReview: boolean; outOfDateReasons: OutOfDateReason[] }): { state; outOfDate: boolean; reasons }`. No block, or only `start_ref`, plus ready → `not_reviewed`. Stored `reviewed`/`reviewed_with_rulings` plus reasons → stored state kept, `outOfDate: true`.
  - `deriveVerdict(items: { planProblemsOpen; partial; agreedCriticalRulings; canWaitMinors; disagreedRulings; humanChecks; otherOpen }): "ready_to_merge" | "ready_with_parked_items" | "not_ready"` (rules in `architecture/index.md` § Verdict).
  - `excludedPathspecs(weaveRootRelative: string): string[]` → `:(exclude)<prefix>wiki/changes/**`.
  - `planAndDocsPaths`: `wiki/knowledge/**`, `wiki/decisions/**`, `.weave/coding-guidelines.md`.
  - `bodyHash(contents: string): string`: strips YAML frontmatter, then `hashDocument`.
- `src/lib/review/state.ts`:
  - `readSliceReview(statusPath)`, `readChangeReview(changePath)`.
  - `updateSliceReview(ctx, sliceId, mutate)`, `updateChangeReview(ctx, mutate)`: per-change lock, re-read, merge only the `review` key, atomic write.
  - `adoptChange(ctx)`: idempotent first-contact stamping.
  - `reviewActivation(ctx): { active; enabled; skipped; installed; skill_paths: string[]; settings: { slice_rounds; models } }`.
- `src/lib/local-state.ts`: `withChangeLock(mainRoot, changeId, action)`, a lock directory `<local state>/locks/change-<id>` with the same stale-lock (30 s) and retry rules as `withStateLock`. When the change is not inside a git repo, run the action without a lock rather than creating a `.git` folder.
- `weave slice rollup --json` result gains `ready_slices: string[]`, and each `slices[]` entry gains `ready_for_review: boolean`.
- `weave review status [--slice <id> | --change] [--json]` → `{status: "ok", active, skill_paths, settings, stored_state, effective_state, out_of_date_reasons: [], ready_for_review, counts}`. Without `--slice` or `--change`, report the change plus every slice. `settings` is an additive field so the skill can read `slice_rounds` and `models` without parsing `workspace.yml` itself.

## Data

- Slice `status.yml` `review:` and change `status.yml` `review:` blocks exactly as in `architecture/schema.md`. This slice writes only `adopted_at`, `state: predates_review`, and `updated_at`.
- `.weave/workspace.yml` `review: { enabled?: boolean; slice_rounds?: number; models?: Record<agent, { cheap; mid; most_capable }> }`, parsed in `src/lib/workspace-repos.ts`. Absent `enabled` means true. Absent `slice_rounds` means 2.

## State

- Rollup never writes review fields itself. It calls `adoptChange`, which is the only review write rollup triggers, and it carries the existing block through.
- Adoption: on the first `weave review` command or rollup for a change with no `review.adopted_at`, write `adopted_at` on the change and `state: predates_review` on every slice that is ready for review and has no `review` block and no `start_ref`. Never repeat.
- `not_reviewed` is derived only and never stored.

## Validation and errors

- `weave review status --slice <id>` for an unknown slice → `slice_not_found` (existing error shape, exit 1). In flat mode (`task-slices/` missing) `--slice` → `no_slices`.
- A malformed `review:` block is read as absent for derivation and is never rewritten by rollup.
- Errors use the `{status: "error", code, message, details?}` shape and exit 1, like `src/commands/slice.ts`.

## Files and artifacts

- New: `src/lib/review/rules.ts`, `src/lib/review/state.ts`, `src/commands/review.ts`, `tests/review-rules.test.ts`, `tests/review-state.test.ts`, `tests/cli-review-status.test.ts`.
- Modified: `src/lib/sliceRollup.ts`, `src/lib/local-state.ts`, `src/lib/workspace-repos.ts`, `src/cli.ts`, `tests/slice-rollup.test.ts`, `tests/changes.test.ts` (regression only).
