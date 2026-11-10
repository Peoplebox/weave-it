# Contracts: Build commits when a slice finishes

Slice-level technical contracts for this vertical slice.

## Interfaces

- `codeCheckpoint({kind:'build', slice})` in `src/lib/checkpoints.ts`.
- `weave slice rollup` result gains `checkpoints[]`.

## Data

- Trailers: `Weave-Slice`, `Weave-Coverage`, `Weave-Merge-Base`, `Weave-Checkpoint: build`.
- `commits.code_timeout_seconds` (default 300).

## State

- Candidate = ready_for_review && no commit with current coverage && not superseded (no other slice started after it became ready).
- Lookup walks first-parent HEAD..diff base, capped at 500.
