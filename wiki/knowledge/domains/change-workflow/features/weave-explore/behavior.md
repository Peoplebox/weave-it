# weave-explore

## Purpose

Product brainstorming partner: help the user decide what the product should do by comparing directions before settling on one, then write the result as the product shape in `exploration.md`.

## Current Behavior

- Loads `research.md`, relevant `wiki/knowledge/`, and `exploration.md` plus `sessions/*-exploration.md` for resuming. Does not read `prd.md`, `architecture/`, or `tasks.md`.
- **Mode 1, options**: restates the problem, summarises today's behaviour in product terms, and proposes two to four genuinely different directions (including a minimal one) with what each means for users, what it gives up, and rough size and risk. Does not recommend in the first message unless asked.
- **Mode 2, discussion**: free back-and-forth with no question quota: combining directions, concrete scenarios with named roles, devil's advocate, and its own recommendation once the user has reacted.
- **Mode 3, pin down**: one question at a time for the chosen direction only, in the order domain language, roles, workflows, permissions, lifecycle, edge cases, notifications, rollout.
- Steering phrases ("more options", "go deeper on B", "interview me", "lock it in", "pause") move between modes.
- Writes `exploration.md` only after the user confirms, using `shape-template.md`, keeping every option considered and setting **PRD Readiness**; then records `weave change progress exploration` with `discussion` (plus `research` and `sessions` when used).
- Points `feat` changes to `weave-stress-test exploration` in a fresh session; other types to `weave-prd`.

## Behavioral Rules

- Product language only: research findings are translated into behaviour; no code, schemas, APIs, or infrastructure unless asked. Technical concerns become behaviour questions or are recorded for `weave-architect`.
- Vague or conflicting terms are challenged; claims about current behaviour are checked against research.
- No Plan Mode guard.

## Source Anchors

- `templates/skills/weave-explore/SKILL.md`, `shape-template.md`
- `src/lib/changes.ts` (`explorationTemplate`, the scaffold `weave change new` writes for `feat` changes)

## Change History

- 2026-10-20 (branch `change/questions-research-skills`): rewritten from a Plan Mode interview into options, discussion, and a written product shape.
