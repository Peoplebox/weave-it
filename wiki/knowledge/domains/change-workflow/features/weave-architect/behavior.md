# weave-architect

## Purpose

`weave-architect` is the engineering design partner for an active Weave change. It compares technical approaches with the user before settling on one, then writes the result as the technical shape in the architecture artifact.

## Current Behavior

It resolves the workspace and branch-derived active change with `weave workspace --json`, `weave change current --json`, and `weave change status --json`, then loads `status.yml`, `research.md`, `prd.md`, `findings.md`, `exploration.md`, the architecture artifact, `sessions/*-architecture.md`, `knowledge-delta.md`, and `.weave/architecture-considerations.md`, followed by the code and docs that affect the design.

- **Mode 1, options**: restates what needs building in technical terms, summarises today's system from `research.md` with code paths, and proposes two to four approaches (including the smallest change that extends what exists) with what changes, trade-offs, fit with team guidance, and rough size.
- **Mode 2, discussion**: diagrams, call trees, or schemas; comparisons on one concrete criterion at a time; devil's advocate; its own recommendation once the user has reacted.
- **Mode 3, pin down**: one decision at a time for the chosen approach only (data and migrations, contracts, boundaries, consistency, failures, security, scale, observability, rollout, testing), each with a recommendation and the offer to "Explain with an example before deciding".
- Writes the technical shape only after the user confirms: folder mode `architecture/index.md` plus facets from the templates by default, legacy `architecture.md` when that is what exists, and a stop when both exist. The index records **Options Considered** and **Slices Readiness**.
- Records `weave change progress architecture` with the sources used and points `feat` changes to `weave-stress-test architecture`.

`.weave/architecture-considerations.md` is user-owned team architecture guidance. `weave-architect` reads it before recommending, applies relevant guidance silently, surfaces only conflicts and material constraints, never edits it, and does not treat its examples as mandatory unless the file says so.

## Behavioral Rules

- No Plan Mode guard. It writes only the change's architecture artifact, and only after the user confirms an approach; `weave-capture session architecture` checkpoints a discussion without deciding.
- It builds on `research.md` instead of re-researching, re-checking claims only where a decision depends on them.
- If a technical question exposes an unsettled product decision, it asks plainly and points to `weave-clarify prd` if the PRD would change.
- It does not create slices and does not write in sub-repos.

## Source Anchors

- Canonical skill: `templates/skills/weave-architect/SKILL.md`
- Installed copies: `.agents/skills/weave-architect/SKILL.md`, `.claude/skills/weave-architect/SKILL.md`
- Team architecture guidance: `.weave/architecture-considerations.md`
- Pipeline: `wiki/knowledge/domains/change-workflow/domain-wide/research-shapes-and-stress-tests.md`
- Templates: `templates/skills/weave-architect/*-template.md`
- Architecture artifact shape: `wiki/knowledge/domains/change-workflow/domain-wide/architecture-artifacts.md`
- Tests: `tests/agent-skills.test.ts`

## Change History

- 2026-06-06 (change `260606-k0l6-architecture-folder`): `weave-architect` became strictly read-only; architecture writes moved to `weave-capture`, structural changes moved to `weave-clarify`, and architecture context loading became folder-shape-aware.
- 2026-06-07 (change `260607-bbam-task-execution-workflow`): inlined `weave artifact current set architecture --json` into the initial discovery command block and clarified that it is Plan-Mode-safe local session state, preventing agents from skipping the lane commit because the skill is otherwise read-only.
- 2026-06-07 (change `260607-1mo4-fixes-around-existing-commands`): clarified the top-level read-only contract to explicitly allow the local architecture lane commit, added non-blocking lane verification with `weave artifact current --json`, and kept successful lane entry silent.
- 2026-06-07 (change `260607-vuwa-architecture-skill-update`): bundled `weave-architect` now reads `.weave/architecture-considerations.md` as user-owned advisory team architecture guidance. Installed skill copies are not automatically updated; drift is surfaced through status/doctor and resolved through explicit agent update/reset commands.
- 2026-06-11 (change `260610-l397-removing-local-cache`): removed local artifact lane commit/verification. `weave-architect` remains read-only and recommends explicit `weave-capture architecture` for persistence.
- 2026-10-20 (branch `change/questions-research-skills`): rewritten into options, discussion, and a written technical shape; Plan Mode Guard removed; the skill now writes the architecture artifact and progresses the lane.

## Open Questions

- None at this time.
