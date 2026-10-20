# weave-prd

## Purpose

Write or revise `prd.md` by writing up product decisions already made in the product shape, so the PRD stands alone for Product, Design, Engineering, QA, and Support.

## Current Behavior

- **Stress test gate**: for `feat` changes, continues only with a current `exploration` verdict of `holds`, `holds-with-changes`, or `waived`; otherwise stops with the skill to run next. A waiver is recorded only when the user asks and gives a reason. Other change types are not gated.
- Reads `exploration.md`, the stress test session note named in `stress_tests.exploration.session`, `prd.md` and `sessions/*-prd.md` for resuming, `status.yml`, `research.md`, `decisions.md`, and relevant knowledge. Does not read `architecture/`, `tasks.md`, or `implementation.md`.
- Maps shape sections to PRD sections (Problem to Problem Statement, Scenarios to workflows, stories, edge cases, and acceptance criteria, Decisions to requirements, permissions, lifecycle, and notifications, rejected options to background notes, stress-test exclusions to Non-Goals).
- Asks only blocking questions (scope, behaviour, permissions, rollout, acceptance), about five at most; everything else becomes an assumption or open question.
- If an answer would change a shape decision, stops and points to `weave-clarify exploration` and a fresh stress test.
- Records `weave change progress prd` with the sources used and points to `weave-architect`.

## Source Anchors

- `templates/skills/weave-prd/SKILL.md`, `prd-template.md`

## Change History

- 2026-10-20 (branch `change/questions-research-skills`): became a write-up of the stress-tested product shape with a verdict gate for `feat` changes.
