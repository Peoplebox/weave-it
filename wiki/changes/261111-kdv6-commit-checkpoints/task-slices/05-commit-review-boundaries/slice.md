# Review boundaries and fix commits

## Outcome

Reviews measure slice and fix-round ends against real commits, fix rounds become their own commits, and snapshots remain the fallback.

## User flow

1. `weave review package --slice 02` points `r1/end` at slice 2's build commit.
2. After fixes, `weave review package --run 02/r1 --fix-round 1` makes "<slice>: review fixes, round 1" and points `round1-end` at it.
3. If the build commit is missing, the round skips the fix commit and uses snapshots.

## In scope

- `CommitBoundary` + `reviewBoundaryFor(ctx)`; end boundaries at commits, starts as snapshots; `Weave-Merge-Base` trailer parsed in `read()`; fix and final-fix commits; `build_not_committed`; `(continued)` re-packages; `boundary` kind in package/status output.

## Out of scope

- Changing fingerprint, prune, or patch logic.

## Acceptance criteria

- [ ] Clean tree with matching build commit → end ref = build commit; dirty tree → snapshot.
- [ ] Fix round makes its own commit and the round-end ref points at it; round patch still reverses with `git apply -R`.
- [ ] Build missing → `build_not_committed`, snapshot boundaries.
- [ ] Final review fix batch → `Final review fixes` commit.
- [ ] Package and review status report `boundary: commit|snapshot` per repo.
- [ ] With commits off, behaviour equals today's snapshots.
