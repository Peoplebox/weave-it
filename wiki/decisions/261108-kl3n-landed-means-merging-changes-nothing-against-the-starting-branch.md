---
id: 261108-kl3n-landed-means-merging-changes-nothing-against-the-starting-branch
title: Landed means merging changes nothing against the starting branch
status: accepted
date: 2026-11-08
owner: arpit016
change: 261107-4oq6-flag-stale-change-folders-in-weave
applies_to:
  - src/lib/landed.ts
  - src/lib/change-states.ts
  - src/lib/change-facts.ts
  - src/lib/worktrees.ts
  - src/lib/changes.ts
supersedes: []
superseded_by: null
---

# Landed means merging changes nothing against the starting branch

## Context

`weave change list` must tell developers and agents whether a change's work has landed, including squash and rebase merges, on any git host. `261107-6c16-close-delete-merged` will delete branches based on the same answer, so the two must never disagree. Weave records a change's starting branch only in uncommitted planning files, and only for branches it created. Changes can be stacked on other change branches.

## Decision

A change has landed in a repo when merging its tip into its target would change nothing:

- the tip is an ancestor of the target, or
- `git merge-tree --write-tree <target> <tip>` produces the target's tree.

**The target** is the change's starting branch, remembered per repo in `.git/weave/bases/<id>.yml` and kept after close.

- **Recovery.** When there's no record, the starting branch is recovered from the folder's `status.yml` `checkout` block, then from the reflog. Reflog values that are a SHA, `HEAD`, or the change's own `[origin/]change/<id>` are rejected. Otherwise the starting branch is unknown.
- **Fallback.** If the starting branch is unknown or gone on origin, the target is the repo's default branch.
- **Remote only.** For repos with `origin`, only remote-derived refs (Weave's copy or the user's `origin/<t>`) are targets. A merge only into a local branch never counts.

**No commits.** A change with no commits since a *known* base is never landed. With an unknown base, a tip on the target's first-parent line is landed with method `contained`, and Weave reports it as "nothing left to merge". It never claims the work was merged, because a fast-forward and an empty branch can't be told apart.

**Safe to delete.** Only the fully `landed` state is safe to delete; `landed_with_newer_commits` is not. All of Weave uses this one definition through `src/lib/landed.ts`. See architecture/index.md, Decision 3.

## Alternatives Rejected

- **Ancestry only (`branch --merged`):** misses every squash and rebase merge.
- **Patch matching only (`git cherry`):** misses multi-commit squashes.
- **Asking the host (GitHub PR state):** exact, but host-specific, needs a login, and needs a network call per change. Deferred.
- **Always measuring against main:** mislabels stacked changes.

## Consequences

- Works with any host, offline once fetched, and cheap enough to cache by `(tip, target)` sha.
- Can report "not landed" when the target later edited the same lines. The "may have landed" hint (remote branch deleted) and the safe-side error direction cover this.
- Squash detection needs git 2.38+. Older git gets real answers for normal and rebase merges, and "couldn't check" otherwise.
- `.git/weave/bases/` becomes durable machine-local state that close must keep.
- merge-tree runs against a temporary object directory, so landed checks never write to the user's object store.

## Reconsider When

- Teams report many merged changes stuck as in progress, which would point to adding host PR lookup.
- Weave needs to support git older than 2.38 for squash detection.
- Weave starts committing planning files, so the starting branch could live on the branch itself.
