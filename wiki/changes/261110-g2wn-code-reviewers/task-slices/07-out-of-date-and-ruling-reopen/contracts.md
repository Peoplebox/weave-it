# Contracts: Out-of-date reviews, file ownership, and reopened rulings

See `architecture/index.md` (Shared rules: `effectiveState`, File ownership, Excluded paths, Body-only hashing; Diff base: Rebases; Resolving a plan problem), `architecture/schema.md` (fingerprint, `plan_basis`, Ruling basis), and `architecture/api-contract.md` (`weave review status`).

## Interfaces

- `src/lib/review/fingerprint.ts`:
  - `outOfDateReasons(ctx, sliceId): Promise<OutOfDateReason[]>`: compares `review.fingerprint` with current blob hashes (`absent` when deleted), the active task count with `reviewed_task_total`, and `plan_basis` with current `bodyHash` values.
  - `rulingReopened(basis, current): boolean` and `classifyRulings(ctx, scope): { settled: Ruling[]; reopened: Ruling[] }`.
  - `releaseOwnership(ctx, coveredFiles, exceptSliceId)`: removes the files from every other slice's `review.fingerprint` (called under the lock at finalize).
- `weave review status` now returns `effective_state` from `effectiveState(stored, { readyForReview, outOfDateReasons })` and the real `out_of_date_reasons`.
- `weave review package --slice` now fills `settled_rulings` and `reopened_rulings`, and its package gains "Settled rulings (do not raise again)", "Reopened rulings", and "From main (ignore)" sections.

## Data

- No new stored fields. Out-of-date is never written.
- `releaseOwnership` edits other slices' `review.fingerprint` maps only, under the change lock.
- The end snapshot's merge-base is compared with the start snapshot's merge-base (both read from the snapshot commits); `filesBetween` gives the "from main" set.

## State

- Stored state is kept under the overlay; reverting returns to current.
- A `waiting_on_person` slice whose `plan_basis` changed reads `effective_state: not_reviewed`, reason `plan_changed`. `package --slice` on it allocates a new run instead of returning `slice_in_review`.
- The rollup path never calls `outOfDateReasons`, so `rollup --check` stays deterministic.

## Validation and errors

- A fingerprint path whose repo checkout is missing contributes no reason and adds a `warnings` entry (`repo_missing`), so a missing repo never flips a slice to current or out of date by accident.

## Files and artifacts

- New: `tests/review-out-of-date.test.ts`.
- Modified: `src/lib/review/fingerprint.ts`, `src/lib/review/record.ts` (call `releaseOwnership` at finalize; exclude "from main" files), `src/lib/review/package.ts` (rulings and "from main" sections), `src/commands/review.ts` (`status` overlay; fresh run on plan change), `tests/review-fingerprint.test.ts`.
