# Knowledge Delta

## Durable Behavior Changes

- **Code reviews exist.** In slice mode each slice is reviewed by a fresh reviewer as soon as every active task is `done` or `not_tested`, with up to `review.slice_rounds` (default 2) fix rounds checked by fresh fix checkers, rulings for what stays open, and Minors saved for later. Once every slice is reviewed and current, a final review of the whole change runs on the most capable model, with one fix batch and one check, and ends with a verdict (`ready_to_merge`, `ready_with_parked_items`, `not_ready`) and the full ruling list in `wiki/changes/<id>/review.md`. Weave never merges.
- **New `weave-review` skill** (judgement, briefs, receiving rules, model levels, plan-problem stops) with four resources, and a **new `weave review` command group**: `status [--repair]`, `snapshot`, `package`, `record` (exit 4 `report_invalid`, exit 5 `plan_finding_requires_person`), `gate --change`, `skip`/`unskip`, `prune`, `guidelines init`.
- **Snapshots** under `refs/weave/reviews/<change>/…` mark review boundaries without touching HEAD, the branch, the index, or the stash. Packages are written to the git-ignored `.weave/tmp/reviews/`. Records live in `task-slices/<slice>/review.md` and `review/`, and in the change's `review.md` and `review/`.
- **Review state** lives in `review:` blocks of slice and change `status.yml`, written only by `weave review` under a per-change lock. `predates_review` is stamped once on slices already ready when a change is adopted, and adoption happens only while review is active. "Out of date" (code changed, plan changed, tasks added) is derived at read time and never stored. Files belong to the latest review that covered them. Files from main after a rebase are labelled and ignored. Rulings store basis hashes and reopen when the code, guidelines, cited documents, or cited decisions change. Decision hashes cover the body without frontmatter plus `superseded_by`.
- **Plan problems** stop the review until a person changes the plan or dismisses the finding (`--as dismissed --by`). A dismissal is the person's own ruling everywhere: it finalizes the slice as `reviewed_with_rulings`, counts as a parked ruling in the verdict, and is listed under "All rulings".
- **Dependency readiness respects review.** While review is active, a slice lets dependents start only once it is ready for review and `reviewed`, `reviewed_with_rulings`, `skipped`, or `predates_review`. `weave slice rollup --json` exposes `ready_for_review` and `ready_slices`, and `weave-execute` and `weave-next` choose slices from `ready_slices`.
- **Rollup** carries the `review:` block unchanged, runs under the per-change lock, writes atomically, and `--check` no longer writes anything. A change in `updated_at` or the graph's "Generated at" line alone no longer counts as a change.
- **`weave-execute` hook**: it checks activation, takes a start snapshot for a `pending` slice, hands over to `weave-review` when the slice is ready for review, and waits before starting another slice. **`weave-next`** recommends reviews, the final review, and re-runs for out-of-date verdicts, and surfaces waiting plan problems.
- **Coding guidelines** live in `.weave/coding-guidelines.md` at the workspace root (shared) and optionally at each repo root (the repo file wins on conflict). They are read from the change's own checkout. `weave init` seeds the starter file and `weave review guidelines init` adds it to existing projects; nothing else writes it.
- **Switches**: `.weave/workspace.yml` `review.enabled` (default true), `review.slice_rounds` (default 2), and `review.models.<agent>.<level>`. Each change also has `weave review skip --reason` / `unskip`. Review is inactive when the change is skipped, the workspace is off, or `weave-review` is not installed.
- **Visibility**: `weave change status` shows `Review:` and `Verdict:` lines and a `review` JSON object. `weave status` shows a `Review (<id>):` line and `review` JSON. Neither adopts or writes, and they are unchanged for changes without review data.
- **`skills_available` notice** names bundled skills a configured agent has not installed. `weave-execute`, `weave-next`, and `weave-review` mention it only when `weave-review` is missing.
- **`weave agent update`** no longer installs new resource files for a skill the agent has not installed.
- **Cleanup**: `weave review prune` and the background refresh delete snapshot refs and packages only for changes that fully landed or no longer exist. `weave change close` keeps them.

## Affected Knowledge Areas

- Domain `change-workflow`: new feature `code-reviews`, plus `weave-execute`, `task-slices`, `change-folder-states`, `recorded-decisions`, and the domain index.
- Domain `cli-commands`: `core-command-reference` (the `weave review` synopsis, `weave slice rollup` JSON and `--check`, workspace `review:` settings, and guideline seeding in `weave init`).
- Domain `cli-distribution`: `notices` (`skills_available`), `skill-resources` (`weave-review` resources and the update fix), `weave-status` (review line), and the domain index.

## Knowledge Files Updated

- Created `wiki/knowledge/domains/change-workflow/features/code-reviews/behavior.md`
- Created `wiki/knowledge/domains/change-workflow/features/code-reviews/decision-tables.md`
- Updated `wiki/knowledge/domains/change-workflow/index.md`
- Updated `wiki/knowledge/domains/change-workflow/features/weave-execute/behavior.md`
- Updated `wiki/knowledge/domains/change-workflow/features/task-slices/behavior.md`
- Updated `wiki/knowledge/domains/change-workflow/features/change-folder-states/behavior.md`
- Updated `wiki/knowledge/domains/change-workflow/features/recorded-decisions/behavior.md`
- Updated `wiki/knowledge/domains/cli-commands/features/core-command-reference/behavior.md`
- Updated `wiki/knowledge/domains/cli-distribution/index.md`
- Updated `wiki/knowledge/domains/cli-distribution/features/notices/behavior.md`
- Updated `wiki/knowledge/domains/cli-distribution/features/skill-resources/behavior.md`
- Updated `wiki/knowledge/domains/cli-distribution/features/weave-status/behavior.md`

## No-Impact Rationale

Not applicable: this change has durable behaviour impact.

## Where The Code Differs From The Plan

The knowledge pages describe the code. Where the code differs from `prd.md` or `architecture/`, the pages follow the code:

1. **Adoption only while review is active.** The architecture said the first touch by any review-aware command, or by rollup, adopts a change. In the code (a ruling made during slice 01), `adoptChange` writes nothing while review is inactive. Projects that upgrade Weave before installing `weave-review` are adopted only once the skill is installed.
2. **The final-review sort covers slice rulings.** The API contract had `final_only.minor_sort` cover Minors only. After a post-slice fix (PRD FR12), it also covers slice review rulings of any severity: `must_fix` reopens a ruling into the change run's fix batch, and `can_wait` leaves it parked as the slice's ruling.
3. **Dismissals count as rulings.** The schema invariants did not say how a dismissed plan finding counts. In the code it counts as the person's ruling: the slice finalizes `reviewed_with_rulings`, the finding is counted in `open_rulings` and as a parked ruling (`parked_items`), and it is listed under "All rulings" with who dismissed it.
4. **Parked Minors alone give `reviewed`.** Only a ruling or a dismissal makes a slice `reviewed_with_rulings`.
5. **The gate passes whenever review is inactive.** The contract said skipped slices pass only when the change is skipped. The code also returns `pass: true, reason: "inactive"` for any inactive cause (workspace off, or skill not installed), and `flat: true` for flat changes. Slices that are skipped while the change is reviewed still block.
6. **`weave slice rollup --check` no longer writes.** Before this change it rewrote slice `status.yml` files even in check mode. A change in `updated_at` or in the graph's "Generated at" line alone is also no longer a change. This was not in the plan; it was needed so that `--check` is stable around review blocks.
7. **`base_unknown` is a warning.** The API contract listed it under errors. The code writes the package, marks it partial, and returns `base_unknown` in `warnings` (the same contract text already said the package is still written).
8. **The change state `skipped` is derived, not stored.** The schema listed `skipped` as a stored change state. The code stores `review.skipped: {reason, at}` and derives the `skipped` state from it, so `unskip` restores the earlier state.
9. **The package layout is per slice.** The schema had `.weave/tmp/reviews/<change>/<run>[-roundN].package.md`. The code writes `.weave/tmp/reviews/<change>/<slice>/r<N>.package.md` and `r<N>-round<n>.package.md`, and `_change/f<N>.package.md` and `f<N>-fix.package.md` for the change.
10. **Run ids use the slice folder name.** A run id looks like `02-api/r1`, and a unique leading number (`02/r1`) is also accepted.
11. **`plan_basis` has wider coverage and is stored earlier.** The slice `plan_basis` also covers `contracts.md`. It is stored at package time too (not only at finalize), so a waiting run can detect a plan change. The change block also stores `plan_basis`, `merge_base`, and `reviewed_task_total`, which the schema's change block did not list. The change `plan_basis` covers every slice's `slice.md` and `contracts.md`, so adding a slice marks the verdict `plan_changed`.
12. **Slice fix rounds are capped only by the skill.** `review.slice_rounds` is read by the skill. The CLI does not cap slice rounds; it enforces only ordering (`round_not_started`, `round_not_ended`, `round_already_started`) and the single fix batch of a change run (`round_limit`). PRD FR15's fixed "2 rounds" is the configurable default.
13. **A change run with an open plan finding is `not_ready`.** It is not `waiting_on_person`, which is a slice-only state. Unlike slice finalize, change finalize does not refuse while findings are open; they make the verdict `not_ready`.
14. **Additional error codes** beyond the contract: `run_closed`, `run_not_found`, `report_not_recorded`, `round_not_found`, `round_already_started`, `round_not_ended`, `finalize_blocked`, `finding_not_found`, `invalid_resolution`, `missing_reason`, `change_locked`, `missing_repo_checkout`, `repo_not_found`, `repo_missing`.
15. **`weave review status` has more fields than planned.** With no flag it returns `scope: "all"` (the change plus every slice), and it adds `enabled`, `installed`, and `inactive_cause` to the planned fields. Read-only views show an unadopted ready slice as `predates_review`.
16. **The `weave agent update` fix was not planned.** It came in as a post-slice fix: `update` no longer creates resource files for a skill the agent has not installed.
17. **Smaller implementation details.**
    - Snapshot temporary indexes keep the real index's timestamps, so same-size edits are never missed.
    - Prune counts a change as landed only when every repo with commits is exactly `landed`. It keeps `no_commits` as well as the other non-landed results.
    - `weave-execute` never takes a late start snapshot for a slice that is already `in_progress`.

## Source Evidence

- Code: `src/lib/review/*.ts`, `src/commands/review.ts`, `src/commands/review/*.ts`, `src/lib/sliceRollup.ts`, `src/lib/notices.ts`, `src/lib/status.ts`, `src/lib/changes.ts` (`statusChange`, `formatStatusTarget`), `src/lib/agent-skills.ts` (`updateArtifact`), `src/lib/init-workspace.ts` (`seedGuidelines`), `src/lib/change-refresh.ts` (`runRefresh`), `src/lib/local-state.ts` (`withChangeLock`), `src/lib/workspace-repos.ts` (`parseReviewSettings`), `src/lib/landed.ts` (exported `resolveTarget`).
- Skills: `templates/skills/weave-review/*`, `templates/skills/weave-execute/SKILL.md`, `templates/skills/weave-next/SKILL.md`, `templates/skills/weave-slices/tasks-template.md`, `templates/opencode/commands/weave-review.md`.
- Evidence and post-slice fix notes: `task-slices/01` through `11`, `tasks.md`. `npm test`: 52 files, 739 tests passing.
- Decisions consulted: `261110-wdfo` (snapshot refs as boundaries), `261110-dbm2` (judgement in the skill, mechanics in the CLI), `261110-dtld` (coding guidelines files), plus `261108-4ko1` (Weave-only refs) and `261108-kl3n` (landed result) as used by prune.

## Follow-Up Knowledge Work

- `weave-next` has no feature page of its own. Its review recommendations are described in `code-reviews` and `task-slices`.
- `cli-distribution/index.md` still says Tier 1 has five commands, while `notices/behavior.md` lists six (including `weave doctor`). This inconsistency predates this change and was left as is.
- When checkpoint commits replace snapshot boundaries, update `code-reviews` (boundaries, packages, edge cases).
