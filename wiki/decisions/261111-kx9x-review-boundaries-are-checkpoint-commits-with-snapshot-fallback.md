---
id: 261111-kx9x-review-boundaries-are-checkpoint-commits-with-snapshot-fallback
title: Review boundaries are checkpoint commits with snapshot fallback
status: accepted
date: 2026-11-11
owner: arpit016
change: 261111-kdv6-commit-checkpoints
applies_to:
  - src/lib/review/**
  - src/commands/review.ts
  - src/commands/review/**
  - src/lib/sliceRollup.ts
  - templates/skills/weave-review/**
  - templates/skills/weave-execute/SKILL.md
supersedes:
  - 261110-wdfo-code-reviews-use-weave-only-snapshot-refs-as-boundaries
superseded_by: null
---

# Review boundaries are checkpoint commits with snapshot fallback

## Context

Decision `261110-wdfo` made review boundaries Weave-only snapshot refs because execute never committed, and named checkpoint commits as its reconsider trigger. Change `261111-kdv6-commit-checkpoints` adds build and fix commits (PRD FR14–FR16, FR21) while keeping private save points as the fallback when a commit fails, for legacy flat changes, and with commits switched off (FR18, FR37).

## Decision

Boundary refs keep their names (`refs/weave/reviews/<change>/<slice>/start`, `r<N>/end`, `round<n>-start|end`, `_change/f<N>/end|fix-start|fix-end`). A new `CommitBoundary` implements `ReviewBoundary` for **end** boundaries: when the slice's build commit (for its current coverage) or the round's fix commit exists and the repo's tree outside `wiki/changes/**` is clean, the ref points at that commit; otherwise it delegates to `SnapshotBoundary`. Fix-round ends and the final fix-end make the fix commit first; while a slice's build commit is missing, fix commits are skipped and the round uses snapshots. **Start** boundaries stay snapshots (on a clean tree they equal HEAD's tree). Build and fix commits carry a `Weave-Merge-Base` trailer written from the caller's merge-base, which `read()` parses; it is never recomputed. Packages and review status report the boundary kind per repo. With commits off or skipped, `SnapshotBoundary` is used unchanged.

## Alternatives Rejected

- **Keep snapshots and add commits beside them:** two parallel boundary systems and FR16 unmet.
- **Make the build commit when the review packages the slice:** code commits would depend on review being active.
- **Drop snapshots entirely:** failed commits, flat changes, and the off switch would lose exact boundaries.

## Consequences

- Fingerprints, packages, round patches, out-of-date checks, and `weave review prune` keep working through the same refs.
- Boundary refs remain machine-local, as before; only the commits they point at are shareable.
- The boundary kind is reported, so the share of snapshot fallbacks can be observed.
- A boundary may mix a commit in one repo with a snapshot in another; packages already handle per-repo refs.
- `git apply -R` on a round patch still undoes a round; reverting the fix commit now does too.

## Reconsider When

Snapshot fallbacks turn out to be common (hooks rejecting most build commits), parallel slices in one folder become routine, or reviews move to comparing pushed branches only.
