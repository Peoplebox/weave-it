---
id: 261101-opav-research-never-reads-intent
title: Research never reads the change's intent
status: accepted
date: 2026-11-01
owner: arpit016
applies_to:
  - templates/skills/weave-questions/**
  - templates/skills/weave-research/**
supersedes: []
superseded_by: null
---

# Research never reads the change's intent

## Context

When product discovery and code reading happened in the same conversation, the planned feature steered what got read, and the facts stayed in the chat or were mixed in with decisions.

## Decision

`weave-questions` writes descriptive questions that never mention the planned change. `weave-research` reads only those questions plus current-state sources, never `exploration.md`, `prd.md`, `findings.md`, `architecture/`, sessions, or tickets, and it runs best in a fresh session.

## Alternatives Rejected

- **One skill that researches and discovers together.** Simpler, but the research is biased and hard to reuse.
- **Let research read the brief for focus.** The questions already carry the focus, without carrying the intended answer.

## Consequences

- `research.md` is a neutral baseline that later lanes can share.
- It takes two steps and possibly a second session. Greenfield work can skip both.
- The quality of the research depends on the quality of the questions.

## Reconsider When

In real use the questions routinely miss what the change needed, so that research has to be redone with the brief in hand.
