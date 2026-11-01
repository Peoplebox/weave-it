# weave-fix

## Purpose

`weave-fix` is the chat-driven entry point for `--type fix` changes. It writes `findings.md`, scaffolds a single initial slice under `task-slices/01-<slug>/`, and progresses the `findings` lane.

## Current Behavior

Single-turn flow from a bug description in chat:

1. Derive slug (confirm if ambiguous).
2. Check the current branch first (`weave change current --json`). If it already follows the `change/<change-id>` structure (an existing change), continue that change and write/update `findings.md` instead of creating a new one. Otherwise create the change with `weave change new "<title>" --type fix [--slug <slug>]`. In workspace mode the change is created at and owned by the workspace root even when invoked from a registered sub-repo.
3. Write `findings.md` from `findings-template.md` (Summary required minimum).
4. Scaffold `task-slices/01-<slug>/` with `tasks.md` + `status.yml` (skip `slice.md` / `contracts.md` for trivial fixes).
5. `weave slice rollup --all`.
6. `weave change progress findings --source discussion`.
7. Report next step (`/weave-execute 01 T1` or `/weave-next afk`).

Re-invocation updates `findings.md` without re-scaffolding unless the slice folder is missing. Scope growth: update `findings.md`, re-run `/weave-slices`.

## Domain Model

`findings.md` sections: Summary (required), Repro, Scope & Impact, Root cause, Related.

Fix lane chain: `findings` → optional `architecture` → `slices`.

## Source Anchors

- Canonical skill: `templates/skills/weave-fix/SKILL.md`
- Template: `templates/skills/weave-fix/findings-template.md`
- Lane: `weave change progress findings`

## Change History

- 2026-06-09 (change `260609-rrsq-weave-slice`): introduced; `last_changed_in: 0.1.6`.
- 2026-06-11 (change `260611-cuvh-slices-execution-default-afk`): corrected step 2 command from the non-existent `weave new --type fix` to `weave change new "<title>" --type fix`; added structural `change/<change-id>` branch check so re-invocation on an existing change branch continues that change instead of creating a duplicate; documented workspace-root authority for change creation.
- 2026-11-01 (branch `change/questions-research-skills`): checks recorded decisions for the code a bug touches and names them in `findings.md`.

## Open Questions

- None at this time.
