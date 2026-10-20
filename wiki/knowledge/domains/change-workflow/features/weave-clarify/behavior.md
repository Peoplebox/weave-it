# weave-clarify

## Purpose

`weave-clarify` refines one existing Weave change artifact when scope, requirements, assumptions, or decisions change midstream.

For architecture, it also owns explicit structural refactoring of folder-mode architecture facets.

## Current Behavior

`weave-clarify` resolves the active change, selects one target artifact (`exploration`, `prd`, or `architecture`), reads the selected artifact before session notes, asks blocking questions when needed, updates only the selected artifact lane, and records lifecycle progress with `weave change progress <target> --json`.

If multiple artifact lanes are affected, the skill updates only the selected lane and reports follow-up lanes instead of cascading changes.

## Workspace Repo Context

In workspace mode, `weave-clarify` treats the workspace root as the single artifact root and registered `repos[]` entries as optional implementation/documentation context.

Unlike `weave-explore` and `weave-architect`, it does not inventory or inspect every registered repo by default. It inspects sub-repos only when the selected artifact clarification depends on repo-local truth, such as a referenced repo, module, API, schema, job, migration, test, doc, ADR, implementation area, behavior change, technical direction change, rollout, integration boundary, or architecture facet ownership.

When sub-repo context is needed, it prefers repo-local docs, knowledge, specs, ADRs, and prior changes before implementation code, then uses code and tests to verify important claims. If the required context is broad or uncertain, it recommends `weave-explore` or `weave-architect` instead of turning clarification into broad discovery.

## Architecture Restructuring

For architecture targets, the selected lane may be legacy file mode or folder mode:

- Legacy file mode: `architecture.md`
- Folder mode: `architecture/index.md` plus direct child facet files
- Conflict mode: both `architecture.md` and `architecture/` exist; the skill stops before editing and asks how to resolve the conflict

Supported architecture structural operations:

- create a facet
- split content from `index.md`, `architecture.md`, or another facet into a facet file
- merge facets
- rename a facet and update index references
- delete a facet only when the user explicitly confirms content is obsolete or preserved elsewhere
- move content between index and facets without changing meaning
- update `architecture/index.md` as the canonical overview and facet map

When only legacy `architecture.md` exists, `weave-clarify architecture` migrates to folder mode only when the user explicitly asks to split or introduce facets. It preserves lifecycle frontmatter in `architecture/index.md` and removes `architecture.md` only after preserving valid content and confirming the migration intent.

## Behavioral Rules

- This is not a generation skill: it does not create a new change, create issues, generate a PRD from scratch, or generate architecture from scratch.
- It preserves still-valid content and records superseded, removed, or narrowed scope explicitly.
- It does not silently delete requirements, decisions, constraints, risks, or facets.
- It applies the Lifecycle Staleness Verification Protocol before calling lifecycle progress.
- It never hand-edits `status.yml`.
- If repo context influenced the clarification, the completion response reports repos inspected, docs/knowledge read, code/test anchors read, and repos intentionally skipped.

## Source Anchors

- Canonical skill: `templates/skills/weave-clarify/SKILL.md`
- Installed copies: `.agents/skills/weave-clarify/SKILL.md`, `.claude/skills/weave-clarify/SKILL.md`
- Architecture artifact shape: `wiki/knowledge/domains/change-workflow/domain-wide/architecture-artifacts.md`
- Workspace-aware skill context: `wiki/knowledge/domains/change-workflow/domain-wide/workspace-aware-skill-context.md`
- Lifecycle protocol: `wiki/knowledge/domains/change-workflow/domain-wide/lifecycle-progress-and-staleness.md`
- Tests: `tests/agent-skills.test.ts`

## Change History

- 2026-06-06 (change `260606-k0l6-architecture-folder`): `weave-clarify architecture` learned folder-mode architecture shape detection, legacy migration by explicit request, and lane-local structural operations for architecture facets.
- 2026-06-06 (change `260606-k0l6-architecture-folder`): `weave-clarify` gained targeted sub-repo awareness for repo-local verification when a clarification depends on implementation or documentation truth, while still avoiding broad workspace discovery by default.
- 2026-10-20 (branch `change/questions-research-skills`): per-target rules moved to the `target-rules.md` resource; changing the chosen direction or approach moves the old one under Options Considered.

## Open Questions

- None at this time.
