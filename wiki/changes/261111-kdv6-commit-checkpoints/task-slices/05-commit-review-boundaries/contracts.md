# Contracts: Review boundaries and fix commits

Slice-level technical contracts for this vertical slice.

## Interfaces

- `CommitBoundary implements ReviewBoundary` in `src/lib/review/commit-boundary.ts`.
- `reviewBoundaryFor(ctx): ReviewBoundary`.
- `codeCheckpoint({kind:'fix'|'final-fix'})`.

## Data

- Trailers `Weave-Run`, `Weave-Round`, `Weave-Merge-Base`.

## State

- Start boundaries always snapshots; end boundaries commit-first.
