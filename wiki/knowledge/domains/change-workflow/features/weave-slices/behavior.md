# weave-slices

## Purpose

`weave-slices` scaffolds per-change `task-slices/<NN>-<slug>/` folders from upstream artifacts. It replaces the legacy flat `weave-issues` skill for new sliced changes and owns the `slices` lifecycle lane.

## Current Behavior

`weave-slices` reads upstream context by change type, allocates slice IDs in one pass, fills templates from `templates/skills/weave-slices/`, and writes slice folders. It calls `weave slice rollup --all` after scaffolding and progresses the `slices` lane via `weave change progress slices`.

Every slice must include explicit verification tasks: behavior-named automated tests where practical, or a dedicated manual verification task with steps and expected result when automation is not practical. Generic tasks like "write tests" are forbidden.

Idempotent re-run proposes additive expansion only; destructive changes require explicit user confirmation.

## Domain Model

Per-slice artifacts: `slice.md`, `contracts.md`, `tasks.md`, `status.yml`. Change-level `task-slices/dependency-graph.md` is rollup-derived when slice count ≥ 2.

Per-slice `tasks.md` uses `Execution: afk | hitl` (not legacy `Type: HITL | AFK`). Tasks group under `## <repo-id>` headings; `Repos:` is source of truth.

`Execution:` defaults to `afk` for all generated tasks. `hitl` is used only when the user explicitly asks to mark a particular architecture area, slice, or task as human-in-the-loop. Manual verification tasks are `afk` only when the steps are fully mechanical and can be performed by the agent in the available environment; they are marked `hitl` when verification requires a browser-only check, product judgment, visual approval, credentials, customer data, production access, or human acceptance.

## Behavioral Rules

- **Stress test gate (`feat`)**: before scaffolding, requires a current `stress_tests.architecture` verdict of `holds`, `holds-with-changes`, or `waived`; a missing, outdated, or `needs-reshaping` verdict stops with the skill to run next. Waivers are recorded only when the user asks and gives a reason. Other change types are not gated.

- feat requires `prd.md` + `architecture/`; fix requires `findings.md`; chore/refactor requires `exploration.md`.
- `contracts.md` uses slice-level technical contracts (Interfaces, Data, State, Validation; adaptive optional sections).
- fix-type single-slice changes may skip `slice.md` / `contracts.md` when nothing meaningful to write.
- Participates in the [Lifecycle Staleness Verification Protocol](../../domain-wide/lifecycle-progress-and-staleness.md).

## Integrations And Side Effects

- Hard rename from `weave-issues`: no deprecation banner on the old skill path.
- OpenCode command: `templates/opencode/commands/weave-slices.md`.
- Users upgrading npm must run `weave agent install all` to receive `weave-slices`; `weave agent update` alone does not install new skill names.

## Source Anchors

- Canonical skill: `templates/skills/weave-slices/SKILL.md`
- Templates: `templates/skills/weave-slices/*.md`, `status-template.yml`
- Tests: `tests/agent-skills.test.ts`, `tests/slice-rollup.test.ts`
- CLI lane: `weave change progress slices` (`issues` accepted as alias)

## Change History

- 2026-06-09 (change `260609-rrsq-weave-slice`): introduced as replacement for `weave-issues`; `last_changed_in: 0.1.6`.
- 2026-06-11 (change `260611-cuvh-slices-execution-default-afk`): `Execution:` default flipped from `hitl` to `afk` for all generated tasks; `hitl` now reserved for explicit user request. Manual-verification guidance changed to an explicit `afk`-when-mechanical vs `hitl`-when-human-judgment-needed policy.
- 2026-10-20 (branch `change/questions-research-skills`): for `feat` changes, scaffolding now requires a current architecture stress test verdict (`holds`, `holds-with-changes`, or `waived`), and a `Not ready` Slices Readiness is reported before continuing.

## Open Questions

- None at this time.
