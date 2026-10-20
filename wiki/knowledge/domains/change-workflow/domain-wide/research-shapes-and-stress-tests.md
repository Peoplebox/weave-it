# Research, Shapes, And Stress Tests

## Purpose

Describe how a feature change moves from "what exists today" to a checked design: objective research first, then a collaborative brainstorm that ends in a written shape, then an independent stress test of that shape before the next lane builds on it.

## Current Behavior

```text
questions -> research -> exploration (product shape) -> stress test -> prd
                      -> architecture (technical shape) -> stress test -> slices
```

- **Research is separated from intent.** `weave-questions` writes `questions.md`: descriptive questions about today's system that never mention the planned change. `weave-research` reads only `questions.md` (never `exploration.md`, `prd.md`, `findings.md`, `architecture/`, sessions, or tickets) and writes a cited `research.md`. See [weave-questions-and-research](../features/weave-questions-and-research/behavior.md).
- **Design skills start with options.** `weave-explore` (product, plain language) and `weave-architect` (engineering, technical) open with two to four genuinely different directions, discuss them, and ask detailed questions only for the direction the user picks. They write a *shape* only after the user confirms: problem or system context, every option considered and why, the chosen direction, decisions, assumptions, open questions, and a readiness line (`PRD Readiness` or `Slices Readiness`).
- **Stress tests are independent.** `weave-stress-test <exploration|architecture>` runs the read-only `weave-challenger` sub-agent on the written shape plus `research.md` and the knowledge wiki only. It never sees the brainstorm conversation, so anything agreed only in chat surfaces as a gap and is written into the shape. The skill interviews the user on the challenges, updates the shape, writes `sessions/YYYYMMDD-HHMMSS-<id>-<lane>-stress-test.md`, and records a verdict with `weave change verdict`.
- **Verdicts gate feature changes.** For `feat`, `weave-prd` needs a current `exploration` verdict and `weave-slices` needs a current `architecture` verdict of `holds`, `holds-with-changes`, or `waived`. A verdict is outdated once its lane is progressed again. `needs-reshaping` sends the user back to the design skill. Other change types are not gated.

## Domain Model

- **Evidence lanes**: `questions`, `research`. Real lanes for `artifacts`, `--source`, and staleness, but progressing them never moves `stage`.
- **Shape**: the written conclusion of a design discussion. Product shape lives in `exploration.md` (sections in `templates/skills/weave-explore/shape-template.md`); technical shape lives in `architecture/index.md` plus facets (`templates/skills/weave-architect/index-template.md`).
- **Stress test record**: `status.yml.stress_tests.<lane>` with `verdict`, `judged_at`, `artifact_updated_at`, optional `session` and `reason`. `outdated` is computed on read when `artifacts.<lane>.updated_at` is newer than `artifact_updated_at`.
- **Research sub-agents**: `weave-locator`, `weave-analyzer`, `weave-pattern-finder`, `weave-web-researcher`; **critic**: `weave-challenger`. All read-only, installed for Claude Code under `.claude/agents/`. Agents without sub-agents run the same roles inside the skill.

## Behavioral Rules

- No Weave skill requires Plan Mode. Design skills write only their own lane's artifact, and only after the user confirms a direction; `weave-capture session <lane>` checkpoints without deciding.
- `weave-explore` translates research findings into product behaviour and never shows code, schemas, or APIs unless asked.
- `weave-prd` writes up the product shape and does not reopen its decisions. If a decision needs to change, it stops and points to `weave-clarify exploration` and a fresh stress test.
- Waivers are recorded only when the user explicitly asks to skip a stress test and gives a reason (`weave change verdict <lane> waived --reason ...`).
- After two `needs-reshaping` verdicts in a row on a lane, `weave-stress-test` suggests a direct conversation rather than another automatic loop.

## Source Anchors

- Skills: `templates/skills/weave-questions/`, `templates/skills/weave-research/`, `templates/skills/weave-explore/`, `templates/skills/weave-stress-test/`, `templates/skills/weave-prd/SKILL.md`, `templates/skills/weave-architect/`, `templates/skills/weave-slices/SKILL.md`, `templates/skills/weave-next/SKILL.md`
- Sub-agents: `templates/agents/*.md`, installed by `src/lib/agent-skills.ts`
- CLI: `src/lib/changes.ts` (`evidenceStages`, `verdictChange`, `parseStressTests`), `src/commands/change.ts` (`verdict`)
- Tests: `tests/changes.test.ts`, `tests/cli-change-progress.test.ts`, `tests/agent-skills.test.ts`

## Change History

- 2026-10-20 (branch `change/questions-research-skills`): introduced the questions and research lanes, read-only sub-agents, options-first `weave-explore` and `weave-architect` with written shapes, `weave-stress-test` with `weave-challenger`, `weave change verdict`, and verdict gates in `weave-prd`, `weave-slices`, and `weave-next`. Retired the Plan Mode Guard.

## Open Questions

- Whether the CLI itself (not only the skills) should refuse `weave change progress prd` or `slices` for `feat` changes without a current verdict.
- Whether OpenCode should get native sub-agent definitions instead of running the roles inside the skill.
