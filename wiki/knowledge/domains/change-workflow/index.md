# Change Workflow

This domain captures the current behavior of Weave's change lifecycle and the agent skills that participate in it: questions, research, exploration, stress tests, PRD, architecture, findings, slices, task execution, knowledge, capture, clarify, next, fix, and new.

A Weave change moves through artifact lanes (`questions`, `research`, `exploration`, `prd`, `findings`, `architecture`, `slices`, `knowledge`) tracked in `wiki/changes/<change-id>/status.yml`. Each lane has an owning skill that creates or revises durable artifacts and records lifecycle progress via `weave change progress <lane>`. Feature changes start at `stage: exploration` with a scaffolded `exploration.md`; non-feature changes start at the non-lane `stage: started` with no scaffolded artifact.

Sliced changes store work under `task-slices/<NN>-<slug>/`; legacy flat changes keep a single change-root `tasks.md`. See [task-slices](features/task-slices/behavior.md).

## Features

- [recorded-decisions](features/recorded-decisions/behavior.md): long-lived engineering decisions (ADRs) in `wiki/decisions/`, the `weave adr` commands, and how each skill checks, drafts, and accepts them.
- [weave-questions-and-research](features/weave-questions-and-research/behavior.md): current-state research questions and objective, cited research with read-only sub-agents; the `questions` and `research` evidence lanes.
- [weave-explore](features/weave-explore/behavior.md): product brainstorm (options, discussion, then targeted questions) that writes the product shape to `exploration.md`.
- [weave-stress-test](features/weave-stress-test/behavior.md): independent critique of a written shape by `weave-challenger`, an interview on the weak points, and a recorded verdict.
- [weave-prd](features/weave-prd/behavior.md): writes the PRD from the stress-tested product shape, with a verdict gate for `feat` changes.
- [task-slices](features/task-slices/behavior.md): per-change slice folders, rollup library, dual-mode execute/next, and cross-slice coordination model.
- [weave-slices](features/weave-slices/behavior.md): scaffolds `task-slices/` from upstream artifacts; owns the `slices` lane; requires explicit per-slice verification tasks.
- [weave-fix](features/weave-fix/behavior.md): chat-driven fix-type entry; writes `findings.md` and initial single slice; owns the `findings` lane.
- [weave-architect](features/weave-architect/behavior.md): engineering design partner that compares technical approaches, then writes the technical shape to the architecture artifact.
- [weave-clarify](features/weave-clarify/behavior.md): focused artifact clarification, including `findings.md` and explicit architecture folder/facet restructuring.
- [weave-issues](features/weave-issues/behavior.md): **superseded** by `weave-slices` for flat `tasks.md` generation; retained for legacy flat-mode reference only.
- [weave-prepare](features/weave-prepare/behavior.md): **deprecated**; branch prep absorbed into `weave-execute`. `weave task prepare` CLI remains.
- [weave-execute](features/weave-execute/behavior.md): agent-first local execution in slice mode or flat legacy mode, including branch prep, dependency handling, rollup episode boundaries, and task evidence updates.
- [weave-capture](features/weave-capture/behavior.md): two-mode capture (artifact vs session-only) of the current discussion, including the Defensive Lane Verification step for explicit target/substance mismatches.

## Domain-Wide Behavior

- [change-creation-and-stages](domain-wide/change-creation-and-stages.md): `weave change new` scaffolding (feature vs non-feature), the `stage` vocabulary, and the non-lane `started` stage used by non-feature changes.
- [architecture-artifacts](domain-wide/architecture-artifacts.md): legacy `architecture.md` and folder-mode `architecture/index.md` plus facet files, including shape resolution, conflict handling, and lane-atomic lifecycle behavior.
- [lifecycle-progress-and-staleness](domain-wide/lifecycle-progress-and-staleness.md): `weave change progress` semantics, the default pessimistic stale propagation, CLI levers (`--no-invalidate`, `--invalidate`), explicit `weave change clear-stale`, the `stale_history` audit trail, and the agent-side verification protocol embedded in every progress-calling skill.
- [research-shapes-and-stress-tests](domain-wide/research-shapes-and-stress-tests.md): the questions, research, shape, and stress test pipeline, evidence lanes, read-only sub-agents, `weave change verdict`, and the verdict gates for `feat` changes.
- [plan-mode-guard](domain-wide/plan-mode-guard.md): retired; no bundled skill requires Plan Mode.
- [workspace-aware-skill-context](domain-wide/workspace-aware-skill-context.md): agent skills resolve one cwd-dispatched workspace or repo context; workspace mode uses the workspace root as the single change store and treats registered sub-repos as implementation locations, not separate artifact targets.

## Glossary Cross-References

- The canonical specification for each Weave skill lives in `templates/skills/<skill-name>/SKILL.md`. Knowledge entries here summarize observable behavior and link back to that source rather than restating the full skill prose.
- Notice surfacing, package versioning, and per-skill version drift live in the [cli-distribution](../cli-distribution/index.md) domain.

## Source Map

See each feature's own `source-map` references; this domain does not yet have a top-level `source-map.md`.
