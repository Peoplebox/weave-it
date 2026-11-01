---
id: 261101-c4tg-human-decision-points-never-auto-advance
title: Human decision points never auto-advance
status: accepted
date: 2026-11-01
owner: arpit016
applies_to:
  - src/lib/lifecycle-transitions.ts
  - src/lib/advance.ts
supersedes: []
superseded_by: null
---

# Human decision points never auto-advance

## Context

`weave advance` can start the next phase in a fresh session without anyone present. Some phases cannot work that way, because they exist to get decisions from a person.

## Decision

Transitions that need a person's decisions are marked `humanDecision` and cannot be turned on: anything into or out of `weave-explore`, `weave-architect`, or `weave-stress-test`, and PRD to architecture. Other transitions are per-change flags, with only questions to research on by default.

## Alternatives Rejected

- **Let teams turn every transition on.** That would skip the review that gives the pipeline its value.
- **No auto-advance.** Research needs no person, so waiting for one wastes time.

## Consequences

- A full feature still needs someone at each design step.
- Unattended runs stay limited to work that can be checked afterwards.
- The list lives in code, so changing it means changing weave.

## Reconsider When

Workflows become editable files, or unattended critique proves reliable enough to run without a person.
