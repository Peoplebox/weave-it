---
id: 261101-jpss-no-skill-requires-plan-mode
title: No skill requires Plan Mode
status: accepted
date: 2026-11-01
owner: arpit016
applies_to:
  - templates/skills/weave-explore/**
  - templates/skills/weave-architect/**
supersedes: []
superseded_by: null
---

# No skill requires Plan Mode

## Context

Design skills used to refuse to run outside Plan Mode and could not write files, so every discussion needed a separate capture step before anything was saved. People also reported that the skills went straight into an interview, with no room to compare options first.

## Decision

No bundled skill requires Plan Mode. `weave-explore` and `weave-architect` discuss freely and write their own lane's artifact, and only after the user confirms a direction. `weave-capture session <lane>` checkpoints a discussion without deciding.

## Alternatives Rejected

- **Keep the guard and the capture step.** Read-only is a strong guarantee, but the extra step added friction to every design discussion, and a Plan Mode skill cannot run unattended.
- **Write continuously during the discussion.** Half-formed ideas would end up in durable artifacts.

## Consequences

- Fewer steps from discussion to artifact.
- The write limit is now a rule in the skill text, which the harness does not enforce.
- A test asserts that no bundled skill carries the guard.

## Reconsider When

Agents write artifacts without confirmation in real use, or a supported agent can enforce per-skill write limits.
