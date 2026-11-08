---
id: 261108-adko-write-ups-after-a-passing-stress-test-may-auto-advance
title: Write-ups after a passing stress test may auto-advance
status: accepted
date: 2026-11-08
owner: arpit016
applies_to:
  - src/lib/lifecycle-transitions.ts
  - src/lib/advance.ts
supersedes:
  - 261101-c4tg-human-decision-points-never-auto-advance
superseded_by: null
---

# Write-ups after a passing stress test may auto-advance

## Context

Decision 261101-c4tg made every transition touching explore, architect, or the stress test require a person, including the one from the product shape to the PRD. Since then the PRD became a write-up of the shape you reviewed in the stress test, gated on a passing verdict, and phases can be handed to a fresh sub-agent. Waiting for a person to start the PRD after the review had already happened added a step without adding a decision.

## Decision

Steps where a person makes decisions never auto-advance: into `weave-explore` or `weave-architect`, and the stress tests themselves. A write-up of a reviewed shape may: `exploration_to_prd` is a flag, on by default for `feat` changes, that fires only with a current passing exploration verdict (for every change type) and `## PRD Readiness` reading `Ready`. The stress test asks whatever still blocks the PRD before it finishes; a PRD sub-agent that would still have to guess stops and returns its questions, which the stress test asks, writes into the shape, and hands off again. `architecture_to_slices` stays `never` for now.

## Alternatives Rejected

- **Keep every transition around a stress test manual.** The review already happened; a person starting the write-up decides nothing.
- **Let the PRD sub-agent record guesses as assumptions.** Requirements would rest on answers nobody gave.
- **Revise the PRD with weave-clarify after asking.** Answers would live in the PRD instead of the shape, so the shape and PRD drift.

## Consequences

- A feature goes from a passing stress test to a written PRD without opening a new session.
- The stress test interview gets a little longer, covering PRD blockers.
- A non-feat change only auto-advances to a PRD after a stress test, even though `weave-prd` itself does not require one.

## Reconsider When

PRDs written this way regularly need rework that a person starting them would have caught, or slicing turns out to be as safe to hand off after the architecture stress test.
