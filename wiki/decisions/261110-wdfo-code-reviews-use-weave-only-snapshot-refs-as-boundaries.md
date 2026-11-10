---
id: 261110-wdfo-code-reviews-use-weave-only-snapshot-refs-as-boundaries
title: Code reviews use Weave-only snapshot refs as boundaries
status: superseded
date: 2026-11-10
owner: arpit016
change: 261110-g2wn-code-reviewers
applies_to:
  - src/lib/review/**
  - src/commands/review.ts
  - src/lib/sliceRollup.ts
  - templates/skills/weave-review/**
  - templates/skills/weave-execute/SKILL.md
supersedes: []
superseded_by: 261111-kx9x-review-boundaries-are-checkpoint-commits-with-snapshot-fallback
---

# Code reviews use Weave-only snapshot refs as boundaries

## Context

Slice and fix-round reviews need exact boundaries: what a slice changed, and what each fix changed (PRD FR23, FR33). `weave-execute` never commits, so the work exists only as uncommitted edits over the change base. A separate future change will introduce checkpoint commits.

## Decision

Until checkpoint commits exist, review boundaries are snapshots of the working tree. Each snapshot is made with a temporary index (`git add -A`, `write-tree`, `commit-tree`) and stored under `refs/weave/reviews/<change>/<slice>/<run>/<point>`. Snapshots never touch the branch, index, or HEAD, and are never pushed. Boundaries are per slice: start, end, and before and after each fix round, never per task. All access goes through a `ReviewBoundary` interface, so a commit-based implementation can replace snapshots without changing the skill. The temporary index is seeded from the real index for speed. Diffs, patches, and fingerprints exclude `wiki/changes/**`. Each snapshot records the merge-base it was taken against.

## Alternatives Rejected

- **Commit per task or slice from execute:** breaks execute's no-commit contract, and the checkpoint work is a separate change.
- **Diff against `base_commit` filtered by task file anchors:** cannot isolate a fix round, and misses files beyond the anchors.
- **Per-task file tracking in execute:** new bookkeeping, and it misses hand edits.

## Consequences

- Fix rounds produce exact patches that can be reversed with `git apply -R`.
- Out-of-date checks can compare against a known tree.
- When slices are built in parallel in one folder, their edits appear in each other's diffs. Packages label files outside the slice.
- Boundaries are machine-local. A review on another machine gets a labelled merge-base fallback.
- Refs accumulate until `weave review prune` removes them for landed or missing changes. Closing a change does not, because it can be reopened.
- Normal pushes skip `refs/weave/`, but `git push --mirror` or a `refs/*` refspec would push the snapshots.
- Slices started before this ships fall back to the merge-base with the target branch, then to `base_commit`.

## Reconsider When

Checkpoint commits land (switch to a commit boundary), parallel slices in one folder become common enough that labelled diffs mislead reviewers, several people or machines routinely build one change, or snapshot refs become a measurable disk cost (as in `261108-4ko1`).
