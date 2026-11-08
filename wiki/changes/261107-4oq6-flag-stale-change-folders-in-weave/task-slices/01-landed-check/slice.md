# Shared landed check and starting-branch memory

## Outcome

A single library, `src/lib/landed.ts`, answers "has this change's work landed in its starting branch, and how?" for one change in one repo, using plain git. Starting branches are remembered durably in `.git/weave/bases/<id>.yml`. This is the definition `261107-6c16-close-delete-merged` will reuse (ADR `261108-kl3n`).

## User flow

1. A developer runs `weave change new`, and Weave records the starting branch and commit in `bases/<id>.yml`, as well as the `status.yml` `checkout` block.
2. Later, any Weave code calls `landed(repo, change)`, which resolves the target, runs the algorithm, and returns `{result, method, reason}` from cache or by computing it.

## In scope

- `git.ts` helpers: `isAncestor`, `mergeTreeWrite` (temporary object dir), `cherry`, `revCount`, `firstParentContains`, and `gitVersionCaps` (2.29, 2.31, 2.38).
- `bases/<id>.yml` read and write, plus lazy recovery: the `status.yml` checkout block, then the filtered reflog, then `unknown`.
- The landed algorithm, steps 1–7 (architecture/index.md "Landed algorithm"), including `contained` and the 50-commit newer-commits walk.
- The `landed.json` cache: key `repo:tip:target:base_commit|-`, `git_caps` invalidation, a 1,000-entry cap.
- Target candidates: Weave's ref (when present) and `origin/<t>` for repos with `origin`; local `<t>` only for repos without one. The "gone" input is accepted as a parameter, which slice 04 supplies.

## Out of scope

- Rendering, list wiring, and states (slice 02).
- Fetching and the `refs/weave/*` namespace (slice 04). Until then, the Weave candidate is simply absent.
- The 2 s inline budget (slice 02, which owns the list call site).

## Acceptance criteria

- [ ] Normal, rebased, and squash merges return `landed` with methods `merged`, `rebased`, and `squashed`.
- [ ] A merged branch with an unknown base returns `landed`, never `no_commits`. An empty branch with an unknown base returns `landed` with method `contained`.
- [ ] A branch with no commits since a known `base_commit` returns `no_commits`.
- [ ] Newer commits after a squash return `landed_with_newer_commits`. The walk is capped at 50 commits.
- [ ] A merge only into a local `main`, for a repo with `origin`, is `not_landed`.
- [ ] `add_tracking` and `checkout -b` reflog values are rejected, and an `add_new` folder recovers its base from `status.yml`.
- [ ] The user's object store gains no loose objects from a check.
- [ ] On simulated git < 2.38, normal and rebase merges are still found, and others are `unchecked`.
