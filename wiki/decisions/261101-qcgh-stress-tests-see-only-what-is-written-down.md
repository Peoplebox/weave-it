---
id: 261101-qcgh-stress-tests-see-only-what-is-written-down
title: Stress tests see only what is written down
status: accepted
date: 2026-11-01
owner: arpit016
applies_to:
  - templates/skills/weave-stress-test/**
  - templates/agents/weave-challenger.md
supersedes: []
superseded_by: null
---

# Stress tests see only what is written down

## Context

The agent that helps build a shape is inclined to defend it, and anything agreed only in conversation never reaches the lanes that build on the shape.

## Decision

`weave-stress-test` has the read-only `weave-challenger` sub-agent attack the written shape using only that artifact, `research.md`, recorded decisions, and the knowledge wiki. It never sees the brainstorm conversation or its session notes. The skill then interviews the user, because sub-agents cannot.

## Alternatives Rejected

- **Let the design skill critique itself.** It shares the reasoning that made the choice feel right.
- **Give the critic the transcript.** That reasoning is persuasive, and gaps in the written shape would stay hidden.

## Consequences

- Gaps surface as questions, and the answers get written into the shape.
- The user may be asked about something already discussed; answering writes it down.
- Agents without sub-agents run the critique inside the skill, which is less independent unless the session is fresh.

## Reconsider When

Users find that most challenges repeat settled discussion, even after decisions are written into the shape.
