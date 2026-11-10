# Snapshot boundaries and the diff base

## Outcome

`weave review snapshot --slice <id> --at start` records the working tree, including uncommitted and untracked files, as a parentless commit under `refs/weave/reviews/<change>/<slice>/start` in every repo the slice touches. It never touches the branch, index, HEAD, or stash. The slice `review:` block gains `start_ref`. Behind this sit the `ReviewBoundary` interface with its `SnapshotBoundary` implementation, and diff-base resolution (merge-base with the target branch, then `base_commit`, then unknown). Every later slice builds packages and patches on these two modules.

## User flow

1. The build session starts the first task of slice 02 and runs `weave review snapshot --slice 02 --at start --json`.
2. Weave writes a snapshot ref in each of the slice's repos (`root` in repo mode) and returns `{refs, merge_base}`.
3. `git status`, `git stash list`, `git rev-parse HEAD`, and the branch are exactly as before.
4. Running the same command again keeps the existing ref. `--force` replaces it.
5. `weave review status --slice 02 --json` now shows `start_ref`.

## In scope

- `src/lib/review/base.ts`: resolve the diff base per repo: `git merge-base HEAD <target>`, with the target resolved as `landed.ts` does; else `checkout.repos.<repo>.base_commit`; else `base_unknown`. A helper lists files changed between an old and a new merge-base, for later "from main" labelling.
- `src/lib/review/boundary.ts`: the `ReviewBoundary` interface and `SnapshotBoundary` (temporary index in the local state folder seeded by copying the real index, `git add -A`, `write-tree`, `commit-tree`, `update-ref`, temporary index removed in `finally`), reading a boundary back, and diffs and patches between boundaries with `wiki/changes/**` excluded.
- Each snapshot records the merge-base it was taken against, in the snapshot commit message.
- `weave review snapshot --slice <id> --at start [--force] [--json]`.

## Out of scope

- `--run <run> --at round-start --round <n>` (slice 06).
- End snapshots and packages (slice 04).
- Prune (slice 10).
- The execute hook that calls this (slice 11).

## Acceptance criteria

- [ ] A snapshot includes modified, staged, and untracked files and honours `.gitignore`.
- [ ] After a snapshot, HEAD, the branch, the index file contents, and the stash list are unchanged.
- [ ] The snapshot works from a linked worktree and in a workspace with two repos, writing each ref into that repo's object store.
- [ ] `--at start` is idempotent without `--force`.
- [ ] The diff base falls back from merge-base to `base_commit` to `base_unknown`, and an in-place change without `base_commit` still resolves through the merge-base.
- [ ] Diffs and patches between two boundaries never contain `wiki/changes/**`.
- [ ] `npm run typecheck`, `npm test`, and `npm run build` pass.
