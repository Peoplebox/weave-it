# Out-of-date reviews, file ownership, and reopened rulings

## Outcome

A reviewed slice never silently describes code that has since changed. Whenever review state is read, Weave compares the stored fingerprint, task total, and `plan_basis` with the current tree and documents, and shows `reviewed, out of date (code changed | plan changed | tasks added)`. Reverting the change makes it current again, because out-of-date is derived and never stored. Slices that share files do not cascade: the latest review that covered a file owns it. If the merge-base moved during a slice (a rebase onto main), files that changed on main are labelled "from main" and are not fingerprinted. Rulings reopen when their code, guideline, planning document, or decision changes, and packages list settled and reopened rulings so later reviewers do not argue settled points again. A slice waiting on a plan problem whose plan was changed reads `not_reviewed (plan changed)`, and the next review is a fresh run.

## User flow

1. Slice 02 is `reviewed`. Someone edits `src/lib/foo.ts`, which slice 02 owns.
2. `weave review status --slice 02 --json` returns `stored_state: reviewed`, `effective_state: out_of_date`, `out_of_date_reasons: ["code_changed"]`.
3. They revert the edit. Status reads `reviewed` again.
4. Slice 03 is later reviewed and also covers `src/lib/foo.ts`. Slice 02 stops fingerprinting that file, so a later edit to it marks only slice 03 out of date.
5. A body edit to `prd.md` marks every reviewed slice `out of date (plan changed)`. A frontmatter-only edit does not.
6. A ruling on `src/lib/bar.ts` reopens when that file changes, and the next slice package lists it under "Reopened rulings".

## In scope

- `src/lib/review/fingerprint.ts` evaluation: `code_changed`, `tasks_added`, `plan_changed`.
- Ownership handoff at finalize: a newer run's covered files are removed from earlier slices' fingerprints.
- "From main" labelling in packages and exclusion from fingerprints when the merge-base moved between start and end.
- Ruling reopen evaluation and the settled and reopened rulings sections and counts in slice packages.
- `weave review status` returning real `effective_state` and `out_of_date_reasons`.
- Plan change on a `waiting_on_person` run → `not_reviewed (plan changed)`, and `package --slice` then starts a fresh run.

## Out of scope

- The change-level fingerprint and verdict out-of-date (slice 08 reuses these functions).
- Showing out-of-date in `weave change status` (slice 09).

## Acceptance criteria

- [ ] An edit inside the reviewed set gives `out_of_date (code_changed)`; an edit outside it does not.
- [ ] A rising active task count gives `tasks_added`.
- [ ] A body edit to the PRD, an architecture file, `slice.md`, or a cited decision gives `plan_changed`; a frontmatter-only edit does not.
- [ ] Reverting the edit returns the slice to current, and nothing in `status.yml` changed in between.
- [ ] Two slices sharing a file: after the second review, an edit to that file marks only the second slice out of date.
- [ ] Files changed on main between the start and end merge-bases are labelled "from main" and are absent from the fingerprint.
- [ ] A ruling whose code, guideline, document, or decision hash changed is reported as reopened; unchanged rulings are listed as settled.
- [ ] `weave slice rollup --check` is unaffected by any of this.
- [ ] `npm run typecheck`, `npm test`, and `npm run build` pass.
