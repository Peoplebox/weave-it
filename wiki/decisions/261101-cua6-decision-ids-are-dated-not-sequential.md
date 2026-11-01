---
id: 261101-cua6-decision-ids-are-dated-not-sequential
title: Decision ids are dated, not sequential
status: accepted
date: 2026-11-01
owner: arpit016
applies_to:
  - src/lib/decisions.ts
supersedes: []
superseded_by: null
---

# Decision ids are dated, not sequential

## Context

ADR files need stable identifiers. Parallel branches, which git worktrees will make common, can each add a decision without seeing the other.

## Decision

Decision ids use `<YYMMDD>-<4 random characters>-<slug>`, the same style as change ids, rather than `0001`, `0002`. The id does not depend on the change that created the decision, because a decision outlives any one change.

## Alternatives Rejected

- **Sequential numbers.** Short and familiar, but two branches pick the same number and collide on merge.
- **Use the change or ticket id.** One change can record several decisions.

## Consequences

- No merge collisions, and no central counter.
- Ids are longer and do not say how many decisions exist.
- `weave adr` accepts any unique part of an id, so references stay short.

## Reconsider When

Teams consistently want human-friendly numbers more than they hit parallel-branch collisions.
