# Fix rounds with reversible patches and fix checks

## Outcome

The agent can fix agreed Critical and Important findings in bounded rounds, and every fix can be found and undone. Before fixing, the agent runs `weave review snapshot --run 02/r1 --at round-start --round 1`. After fixing and re-running the slice's checks, `weave review package --run 02/r1 --fix-round 1` snapshots the round end, saves the exact round patch beside the slice (`review/r1-round1.patch`, reversible with `git apply -R`), and writes a small package for a fresh fix checker. The checker's report is recorded against the round, its new Critical or Important findings join the open list, and the agent marks findings `fixed` in that round. A fix on a slice with a human-only verification step is marked "needs your check". A slice paused on a plan problem resumes at its next round after the person dismisses it.

## User flow

1. After `record --report`, the agent runs `weave review snapshot --run 02/r1 --at round-start --round 1`.
2. It fixes the agreed findings, re-runs the slice's automatic checks, then runs `weave review package --run 02/r1 --fix-round 1 --json`.
3. Weave returns the round package (model level `cheap-mid`) and saves `task-slices/02/review/r1-round1.patch`.
4. A fresh fix checker reads the package. The agent pipes its response to `weave review record --run 02/r1 --report -`, which stores `r1-round1.check.md` and adds any new findings.
5. The agent runs `weave review record --run 02/r1 --resolve 02/r1-F3 --as fixed --round 1` for each addressed finding.
6. `review.md` lists each fix with its finding, round, patch file, and the files it touched.
7. A person can undo round 1 with `git apply -R task-slices/02/review/r1-round1.patch`, and no Weave file under `wiki/changes/` is affected.
8. For a run whose plan finding was dismissed, `weave review package --run 02/r1` returns the next round number to resume at.

## In scope

- `weave review snapshot --run <run> --at round-start --round <n>`.
- `weave review package --run <run> --fix-round <n>`: round end snapshot, round diff, saved patch, round package.
- `weave review package --run <run>` resume for a `waiting_on_person` run whose plan finding was dismissed.
- Fix-check report schema in `record --report` (detected by shape) and `--resolve --as fixed --round <n>`.
- "Needs your check" marking (FR19) and `review.md` Fixes section.

## Out of scope

- The number of rounds and when to stop: the skill reads `settings.slice_rounds` and enforces it (slice 11). The CLI rejects only a round that was never started.
- The final review's single fix batch (slice 08 reuses this mechanism).
- Out-of-date checks (slice 07).

## Acceptance criteria

- [ ] `package --fix-round 1` without a round-start ref fails with `round_not_started`.
- [ ] The saved patch contains exactly the round's changes, never `wiki/changes/**`, and `git apply -R` restores the round-start tree for those files.
- [ ] A fix-check report with `checks` and `new_findings` is stored as `r1-round<N>.check.md`; new Critical or Important findings get fresh ids and join the open list.
- [ ] `--as fixed` requires an existing round and records `{as: fixed, round, patch}` plus the files the patch touched.
- [ ] A fix on a slice whose `tasks.md` has a `Human check:` line is marked "needs your check" in `review.md` and counted in `counts.human_checks`.
- [ ] Resume after dismissal returns the next round number and does not start a new run.
- [ ] `npm run typecheck`, `npm test`, and `npm run build` pass.
