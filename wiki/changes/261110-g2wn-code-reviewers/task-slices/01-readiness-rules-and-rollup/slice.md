# Review readiness rules, preserved review state, and weave review status

## Outcome

The tracer bullet for review state. Weave gains the shared pure rules every review consumer uses (`src/lib/review/rules.ts`), a locked writer for the `review:` blocks in slice and change `status.yml` (`src/lib/review/state.ts`), and a first `weave review` subcommand, `status`. `weave slice rollup` keeps the `review:` block it used to drop, takes the per-change lock, reports which slices are ready for review, and, when review is active, only lets dependent slices start once the slice they depend on has been reviewed. Nothing reviews code yet. This slice makes review state exist, survive, and show.

## User flow

1. An agent finishes the last task of slice 02 (all tasks `done` or `not_tested`) and runs `weave slice rollup --json`.
2. Rollup reports `ready_for_review: true` for slice 02 and lists the slices that may start now in `ready_slices`.
3. With review active, slice 03 (which depends on 02) is not in `ready_slices`, because slice 02 is not reviewed yet. With review inactive, slice 03 is ready as today.
4. `weave review status --slice 02 --json` returns `active`, `skill_paths`, `settings`, `stored_state`, `effective_state: not_reviewed`, `ready_for_review: true`, and `counts`.
5. On first contact with a change, the CLI stamps `review.adopted_at` on the change and `state: predates_review` on every slice that was already ready for review.
6. A test writes a `review:` block into a slice `status.yml`, runs rollup, and the block is still there, unchanged.

## In scope

- `src/lib/review/rules.ts` (pure, no I/O): `isReadyForReview`, `satisfiesDependents`, `effectiveState` (takes precomputed out-of-date reasons as input), `deriveVerdict`, review state and verdict types, the excluded-path and "plan and docs edits" path lists, and frontmatter-stripped body hashing over `hashDocument`.
- `src/lib/review/state.ts`: types for the slice and change `review:` blocks (`architecture/schema.md`), readers, a locked read-merge-write that touches only the `review` key, adoption stamping (`adopted_at`, `predates_review` once), and review activation (`review.enabled`, change skipped, `weave-review` in `.weave/agents.yml`, `skill_paths`).
- A per-change lock in `src/lib/local-state.ts`, following the `withStateLock` pattern.
- `review:` settings parsed from `.weave/workspace.yml` (`enabled`, `slice_rounds`, `models`).
- `src/lib/sliceRollup.ts`: carry `review` through `readSliceStatus` and the writer, take the per-change lock, write atomically, use `satisfiesDependents` in `renderSliceDisplayStatus` and the dependency graph, expose `ready_for_review` per slice and `ready_slices` in the result, and run adoption stamping.
- `src/commands/review.ts` with the `status` subcommand, registered in `src/cli.ts`.

## Out of scope

- Snapshots, packages, records, fingerprints, the gate, skip and unskip, prune, guidelines (later slices).
- Out-of-date evaluation. `effectiveState` accepts reasons, but nothing computes them until slice 07. `out_of_date_reasons` is always `[]` here.
- `weave review status --repair` (slice 05).
- `weave change status` and `weave status` review lines (slice 09).
- Skill text (slice 11).

## Acceptance criteria

- [ ] A slice whose active tasks are all `done` or `not_tested` is ready for review, even though rollup's `status` stays `in_progress` when a task is `not_tested`.
- [ ] `weave slice rollup` never drops or edits a slice `review:` block, and `weave slice rollup --check` result is unaffected by it.
- [ ] With review active, a slice depending on a `done` but unreviewed slice is `blocked` in `dependency-graph.md` and absent from `ready_slices`. With review inactive, behaviour matches today.
- [ ] `weave review status --slice <id> --json` and `--change --json` return the contract fields; `active` is false when `review.enabled: false`, when the change is skipped, or when no agent has `weave-review` installed.
- [ ] First contact stamps `adopted_at` once and `predates_review` only on slices already ready at that moment, never twice.
- [ ] Concurrent review writes and rollup writes to one slice `status.yml` lose no update.
- [ ] `npm run typecheck`, `npm test`, and `npm run build` pass.
