# Slice review package

## Outcome

`weave review package --slice <id> --json` turns a finished slice into a review package a fresh reviewer can read: it allocates the run id, takes the end snapshot, marks the slice `in_review`, and writes one package file inside the change's own checkout folder. The package holds the whole-tree diff between the slice's start and end boundaries in every repo the slice touches, with files outside the slice labelled "possibly another slice's work", and a context manifest (planning documents, applicable decisions, guideline files, task evidence as claims, untested tasks, human-check steps). The agent only names the slice; it never picks a range.

## User flow

1. Slice 02 has a start snapshot and every active task is `done` or `not_tested`.
2. The session runs `weave review package --slice 02 --json`.
3. Weave returns `{run_id: "02/r1", package_path, scope, partial: false, fallback_base: null, foreign_files: 1, model_level: "mid", size_hint, settled_rulings: 0, reopened_rulings: 0}`.
4. The package file at `<checkout>/.weave/tmp/reviews/<change>/02/r1.package.md` shows the diff, labels the one foreign file, lists guideline files (present or absent), the PRD, architecture, `slice.md`, the applicable decisions, and the slice's untested tasks and human checks.
5. `weave review status --slice 02` shows `in_review`, `latest_run: r1`.
6. Without a start snapshot (a slice started before review shipped, or built on another machine), the package falls back to the diff base and says so in its header.

## In scope

- `src/lib/review/package.ts`: diff assembly over `ReviewBoundary`, foreign-file labelling against the slice's `repos[]` and task `Files:` anchors, diff stat and size hint, model-level hint, fallback labels, and the context manifest.
- Task-evidence parsing from `tasks.md`: untested tasks, `Human check:` lines under `### Verification`, and verification result lines (as claims).
- Planning documents by change type: `prd.md` and `architecture/**` for `feat`; `findings.md` (and `architecture/` when present) for `fix`; `exploration.md` (and `architecture/` when present) for `chore` / `refactor`; always `slice.md`.
- Applicable decisions: accepted decisions whose `applies_to` matches any diffed file (`matchesAppliesTo` in `decisions.ts`).
- `weave review package --slice <id> [--partial] [--force] [--out <path>] [--json]`.
- Package location with a self-ignoring `.weave/tmp/.gitignore`.
- The optional `Human check:` line in `templates/skills/weave-slices/tasks-template.md`.

## Out of scope

- Recording reports (slice 05), fix rounds (slice 06), settled and reopened rulings in the package and "from main" labels (slice 07), change packages (slice 08), prune (slice 10).

## Acceptance criteria

- [ ] A package for a ready slice contains the diff between `start` and the new `<rN>/end` ref in every slice repo, with `wiki/changes/**` excluded.
- [ ] A file changed outside the slice's repos and `Files:` anchors appears under a "possibly another slice's work" label and is counted in `foreign_files`.
- [ ] A slice with a `not_tested` task is packaged without `--partial`, and the task appears under "Untested tasks".
- [ ] A slice with a `todo` task returns `slice_not_ready`, and with `--partial` it is packaged with `partial: true`.
- [ ] No start ref → falls back to the diff base, header says "fallback base: change base"; a `start_ref` named but missing locally → warning `start_ref_missing_on_this_machine`.
- [ ] Missing repo checkout → `partial: true`. No diff base at all → `base_unknown`, package still written, `partial: true`.
- [ ] Workspace review off → `review_disabled` unless `--force`; change skipped → `change_review_skipped`; flat mode → `no_slices`.
- [ ] Run ids are allocated under the change lock, so two concurrent calls get `r1` and `r2`.
- [ ] `npm run typecheck`, `npm test`, and `npm run build` pass.
