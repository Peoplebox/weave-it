# weave-questions and weave-research

## Purpose

Build an objective, cited picture of how the system works today before anything is designed, without the planned change biasing what gets looked at.

## Current Behavior

`weave-questions`:

- reads the user's request, `exploration.md` or `findings.md` when substantive, and files the user pointed to, and nothing else from the change folder
- orients lightly with `weave-locator` (or quick searches) without reading implementation in depth
- writes two to eight descriptive questions to `questions.md` ("how does X work", "where is Y used"), never normative ones ("how should we…"), plus a **Key Context Pointers** section copied verbatim from the request; UI changes always get design-system questions
- records `weave change progress questions --source discussion` (plus `exploration` when used) and tells the user to run `weave-research` in a fresh session

`weave-research`:

- reads only `questions.md` (and current-state knowledge, docs, code, and tests); never the change's intent artifacts
- groups questions into two to six areas and runs `weave-locator`, then `weave-analyzer`, `weave-pattern-finder`, and `weave-web-researcher` as needed, in parallel where independent
- writes `research.md` with takeaway headers, `path:line` citations, diagrams or call trees where useful, how each area is tested, code references with coverage notes, and open questions
- makes one more targeted pass on open questions, then records `weave change progress research --source questions --source codebase`
- recommends `weave-explore` or `weave-prd` for `feat` changes and `weave-architect` otherwise

## Behavioral Rules

- Research documents what exists. No recommendations, critiques, root causes, or designs unless the user asks.
- Both lanes are evidence lanes: progressing them never changes `stage`. Progressing `questions` again marks `research` stale.
- Without sub-agents, the skill performs the same roles itself in order: locate, analyze, collect patterns, check external docs.

## Source Anchors

- `templates/skills/weave-questions/SKILL.md`, `questions-template.md`
- `templates/skills/weave-research/SKILL.md`, `research-template.md`
- `templates/agents/weave-locator.md`, `weave-analyzer.md`, `weave-pattern-finder.md`, `weave-web-researcher.md`

## Change History

- 2026-10-20 (branch `change/questions-research-skills`): introduced both skills, the research sub-agents, and the evidence lanes.
- 2026-11-01 (branch `change/questions-research-skills`): research reports accepted decisions that apply, and where code differs from them.
