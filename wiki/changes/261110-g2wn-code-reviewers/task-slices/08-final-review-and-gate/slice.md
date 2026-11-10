# Final review gate, change package, and the change verdict

## Outcome

Once every slice is reviewed, the whole change can be reviewed and given a verdict. `weave review gate --change` says whether the final review may start and, if not, which slices block it. `weave review package --change` packages the whole change against the merge-base with its target branch, across every repo, with a separate "plan and docs edits" section and every saved Minor, ruling, untested task, and human check from the slice reviews. The final run records the reviewer's must-fix and can-wait sort, takes one fix batch with one fix check, and on `--finalize` stores the change verdict (`ready_to_merge`, `ready_with_parked_items`, or `not_ready`) and writes `wiki/changes/<id>/review.md` with the verdict and the full list of rulings, each with its cost if wrong. Flat changes without slices can run this on demand.

## User flow

1. The last slice review finalizes. The session runs `weave review gate --change --json` and gets `{pass: true, blocking: []}`.
2. It runs `weave review package --change --json` and gets `run_id: "change/f1"`, `model_level: "most_capable"`.
3. The final reviewer's report is recorded with `record --run change/f1 --report -`, including `final_only.minor_sort`.
4. The agent snapshots the fix start, fixes agreed Critical and Important findings plus must-fix Minors in one batch, packages the batch, records the single fix check, and records rulings.
5. `record --run change/f1 --finalize` stores the verdict. `wiki/changes/<id>/review.md` shows `ready with parked items (4)` and every ruling from every slice and the final run.
6. If a slice is `not_reviewed`, `waiting_on_person`, or out of date, the gate fails and lists it. An on-demand `package --change --partial` still runs and is recorded as partial, and its verdict is at best `not_ready`.

## In scope

- `src/lib/review/gate.ts` and `weave review gate --change`.
- `weave review package --change [--partial] [--force] [--out]` (change runs `change/f<N>`, refs under `_change/`).
- Final fix batch through the slice 06 mechanism with exactly one round (`fix-start` / `fix-end` refs, `review/f<N>-fix.patch`, `f<N>-fix.check.md`).
- Change-run records: `final_only.minor_sort` validation and storage, rulings, dismissals, plan-gap stops.
- Change `--finalize`: verdict through `deriveVerdict`, change fingerprint taking ownership of every covered file, counts, change `review:` block, and `wiki/changes/<id>/review.md`.
- Change-level out-of-date ("verdict out of date") through the slice 07 evaluation.

## Out of scope

- Showing the verdict in `weave change status` and `weave status` (slice 09).
- The skill text that decides when to start the final review (slice 11).

## Acceptance criteria

- [ ] The gate passes only when every slice's effective state is `reviewed`, `reviewed_with_rulings`, or `predates_review` and none is out of date; `skipped` slices pass only when the change is skipped.
- [ ] The change package diffs the merge-base (or `base_commit` fallback) against the current tree in every change repo, lists `wiki/knowledge/**`, `wiki/decisions/**`, and `.weave/coding-guidelines.md` edits under "plan and docs edits", and excludes `wiki/changes/**`.
- [ ] The change package includes every slice's saved Minors, rulings, untested tasks, and human checks.
- [ ] Flat mode allows `--change`; a missing repo makes the run partial.
- [ ] A second fix round on a change run is rejected.
- [ ] `--finalize` derives the verdict from open items (agreed Critical ruling, open plan problem, or partial → `not_ready`), stores it, and re-baselines the change fingerprint after the fix batch.
- [ ] `wiki/changes/<id>/review.md` holds the verdict and the full rulings list with costs.
- [ ] An edit to a file the final review covered marks the verdict out of date in `weave review status --change`.
- [ ] `npm run typecheck`, `npm test`, and `npm run build` pass.
