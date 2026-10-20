# Change Creation And Stages

## Purpose

Define the current behavior of `weave change new` scaffolding and the change `stage` vocabulary, including the non-lane `started` stage used by non-feature changes.

## Current Behavior

`weave change new "<title>" [--type <type>] [--slug <slug>]` creates one change in the cwd-dispatched Weave context:

- Generates the change id, creates `wiki/changes/<change-id>/`, writes `status.yml`, and creates an empty `sessions/` directory.
- Requires a git repo and ensures/checks out the change branch `change/<change-id>`.
- Does not record local active change or artifact lane state; the active change is derived from the checked-out branch.

Weave resolves the context by walking up from `cwd` to `.weave/workspace.yml`. In workspace mode, the workspace root owns the change store even when the command runs inside a registered sub-repo. In repo mode, nested directories resolve to the repo root. `weave change new` no longer accepts `--target` and does not create changes across multiple targets.

The first-artifact scaffolding and starting stage depend on `--type`:

- `--type feat` (the default): also scaffolds `exploration.md` with the product shape sections (Topic, Problem, Existing Behavior, Options Considered, Chosen Direction, Scenarios, Decisions, Assumptions, Open Questions, PRD Readiness) and starts at `stage: exploration`.
- Non-feature types (`fix`, `refactor`, `docs`, `test`, `ci`, `chore`): do **not** scaffold `exploration.md` and start at `stage: started`. The first durable artifact is created later by the fitting skill (`weave-fix` / `weave-architect` for fixes, `weave-slices` when work is clear enough to slice, or `weave-prd`/`weave-explore` when expected behavior is unclear).

`weave change new` never creates `prd.md`.

## Domain Model

Two related stage vocabularies exist:

- **Artifact lanes** (`changeStages`): `questions`, `research`, `exploration`, `prd`, `findings`, `architecture`, `slices`. These are the only lanes that participate in lifecycle progress, source dependencies, and staleness propagation. `questions` and `research` are **evidence lanes** (`evidenceStages`): progressing them never changes `stage`. Legacy `issues` in stored `status.yml` normalizes to `slices` on read; CLI accepts `issues` as an alias for `slices`.
- **Stored stages** (`storedStages`): `started` plus the artifact lanes. `status.yml.stage` holds a stored stage. `started` is a valid stored stage but is **not** an artifact lane: it never appears in `artifacts`, is never a stale target, and is never a `--source` value.

`started` means the change exists but no durable artifact lane has been reached yet.

## Behavioral Rules

- `status.yml.stage` is read with a `started`-aware guard (`isStoredChangeStage`). A `started` value is preserved on read; only unrecognized values fall back to `exploration`.
- Stage ordering: `stageIndex("started")` is `-1` (it is not in `changeStages`). `maxStage` seeds at `exploration`, so progressing a `started` change to any real lane advances `stage` directly to that lane. Once a real lane is reached, `started` cannot reappear (progress never lowers the stage).
- `started` is not a progressable lane: `weave change progress` accepts `questions`, `research`, `exploration`, `prd`, `findings`, `architecture`, or `slices` as its `<lane>` argument (`issues` accepted as alias for `slices`). Progressing an evidence lane keeps the stored `stage` as it was, including `started`.
- Active change after creation: the checked-out `change/<change-id>` branch is authoritative. No local session artifact context is written.

## Lifecycle

Feature changes:

- `questions -> research -> exploration -> prd -> architecture -> slices` (lanes may be skipped per the change's needs; greenfield work usually starts at `exploration`). For `feat`, a stress test verdict sits between `exploration` and `prd`, and between `architecture` and `slices`.

Fix changes:

- `started -> findings` via `weave-fix` (writes `findings.md` + initial slice).
- `findings -> architecture` when technical design is needed.
- `findings -> slices` when scope grows via idempotent `weave-slices` re-run.

Other non-feature changes:

- `started -> architecture` when diagnosis or RCA is captured first.
- `started -> exploration` or `prd` when expected behavior must be clarified.
- `started -> slices` when work is clear enough to scaffold directly.

`started` should never be treated as `exploration`.

## Integrations And Side Effects

- `weave-new` recommends `weave-questions` then `weave-research` (followed by `weave-explore`) after creating a feature change that touches existing behaviour, `weave-explore` directly for greenfield work, and the fitting next skill (`weave-fix` / `weave-architect` / `weave-slices` / `weave-prd`) after creating a non-feature change.
- `weave change current` / `weave change status` surface the stored `stage`, including `started`.
- Existing change folders created before this behavior (feature-style scaffolds with `exploration.md` at `stage: exploration`) remain readable and unchanged.

## Source Anchors

- Scaffolding and stage start: `src/lib/changes.ts` (`createChange`, `statusTemplate`)
- Stored-stage vocabulary and guards: `src/lib/changes.ts` (`changeStages`, `storedStages`, `StoredChangeStage`, `isStoredChangeStage`)
- Stage read tolerance and ordering: `src/lib/changes.ts` (`readChangeMetadata`, `maxStage`, `stageIndex`)
- Branch-derived active change resolution: `src/lib/changes.ts` (`currentContextForTarget`)
- CLI: `src/commands/change.ts` (`new` subcommand)
- Skill contract: `templates/skills/weave-new/SKILL.md`
- Tests: `tests/changes.test.ts` (feature scaffold, `started` scaffold, stage read-back), `tests/cli-skills.test.ts` (`weave change new` feature vs non-feature)

## Change History

- 2026-06-04 (change `260604-68e6-fix-change-progress-qf-bug`): implemented non-feature change scaffolding. Non-feature `weave change new` now starts at `stage: started` with no `exploration.md` and no current artifact context. Added the `started` stored stage (`storedStages` / `StoredChangeStage` / `isStoredChangeStage`) distinct from the four artifact lanes. This realizes the behavior decided earlier in change `260602-of9s-add-ability-to-bug-fix` (PRD) that had not previously been implemented.
- 2026-06-09 (change `260609-rrsq-weave-slice`): added `findings` and `slices` artifact lanes; `issues` normalizes to `slices` on read; fix-type flow via `weave-fix`; feature flow ends at `slices` instead of `issues`.
- 2026-06-11 (change `260610-l397-removing-local-cache`): `weave change new` now requires git, active change resolution is branch-derived, and local session `current_change` / `current_artifact` fields are ignored for routing.
- 2026-10-20 (branch `change/questions-research-skills`): added the `questions` and `research` evidence lanes, which never move `stage`; the `exploration.md` scaffold now uses the product shape sections.

## Open Questions

- Whether `weave change status` and `weave-next` should give `started` dedicated presentation beyond printing the stage value (currently they print it as-is).
