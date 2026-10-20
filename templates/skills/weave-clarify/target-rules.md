# Weave Clarify: Target-Specific Rules

Read the section for the selected target before editing it.

## exploration

Use `exploration.md` as the target when discovery, scope, the chosen direction, scenarios, decisions, or PRD readiness changed.

Keep these sections current when present (older files may use `Current Understanding` in place of `Problem` and `Chosen Direction`):

```text
Problem
Existing Behavior
Options Considered
Chosen Direction
Scenarios
Decisions
Assumptions
Open Questions
PRD Readiness
```

If the chosen direction changes, move the previous direction under `Options Considered` with why it was dropped instead of deleting it. Keep `exploration.md` in product language.

If the clarification makes the exploration ready or not ready for PRD generation, update `PRD Readiness`.

## prd

Use `prd.md` as the target when product behavior, user workflows, user stories, requirements, edge cases, acceptance criteria, rollout, assumptions, or open questions changed.

Preserve still-valid PRD content. If scope narrowed, move removed behavior to `Non-Goals` or `Out of Scope` instead of silently deleting it.

Add a concise dated `Revision History` entry for meaningful changes.

## architecture

Use the architecture artifact as the target when technical approach, affected systems, data flow, architecture decisions, rejected alternatives, rollout, operations, testing, security, risks, assumptions, open technical questions, or architecture facet structure changed.

Prefer `prd.md` as the product contract. If the technical clarification exposes a product ambiguity not settled by the PRD, record it under `Product Questions Raised by Technical Design` and report `prd.md` as a follow-up artifact.

Add a concise dated `Revision History` entry for meaningful changes.
