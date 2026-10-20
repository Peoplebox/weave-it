# Lifecycle Progress And Staleness

## Purpose

Define the current behavior of `weave change progress` (recording lane progress + source dependencies) and the staleness propagation model that flows from it, including the agent-side verification protocol that gates pessimistic flag propagation.

## Current Behavior

`weave change progress <lane> --source <source>...` records lifecycle progress for the active change:

- Advances `status.yml.stage` to the maximum of the existing stage and the progressed lane. A change still at the non-lane `started` stage advances directly to the progressed lane (see [change-creation-and-stages](change-creation-and-stages.md)).
- Replaces `status.yml.artifacts.<lane>.sources` with the supplied source IDs.
- Updates `status.yml.artifacts.<lane>.updated_at` to the call's `now`.
- Clears any existing `status.yml.stale.<lane>` entry for the progressed lane.
- For every transitive dependent of the progressed lane (computed from `status.yml.artifacts.<other-lane>.sources` lists), marks `status.yml.stale.<other-lane>` with `invalidated_by` and `invalidated_at`. This is the **default pessimistic propagation**.

Supported `--source` IDs: `exploration`, `prd`, `architecture`, `discussion`, `sessions`, `codebase`. Unknown IDs are rejected with code `unsupported_source`. Source lists are replaced (not merged) on each progress call for that lane.

`weave change clear-stale <lane> --reason "..."` explicitly clears a stale flag and appends an entry to `status.yml.stale_history` with `lane`, `invalidated_by`, `invalidated_at`, `cleared_at`, and `reason`.

`stale_history` is append-only across both `progressChange` re-progressions and explicit `clear-stale` calls; existing entries are preserved across both operations.

## Domain Model

`status.yml` shape relevant to this domain:

```yaml
stage: slices                            # max progressed lane
artifacts:
  prd:
    sources: [exploration, sessions]
    updated_at: "2026-06-03T14:52:10.640Z"
  architecture:
    sources: [prd, discussion]
    updated_at: "2026-06-03T14:58:44.150Z"
  findings:                              # fix-type only
    sources: [discussion, codebase]
    updated_at: "2026-06-09T12:00:00.000Z"
  slices:
    sources: [architecture, codebase]
    updated_at: "2026-06-09T12:30:00.000Z"
stale:                                   # absent when empty
  architecture:
    invalidated_by: prd
    invalidated_at: "2026-06-03T16:00:00.000Z"
stale_history:                           # append-only audit trail
  - lane: architecture
    invalidated_by: prd
    invalidated_at: "2026-06-03T16:00:00.000Z"
    cleared_at: "2026-06-03T16:30:00.000Z"
    reason: "Verified content sync after prd typo fix"
```

## Behavioral Rules

### Default propagation

- The set of "transitive dependents" of a progressed lane is computed from `artifacts.<lane>.sources`: any other lane that lists the progressed lane in its sources is a direct dependent, and the closure is taken across the artifacts metadata.
- Every transitive dependent is marked stale by default. This is the safe, source-aware default.

### CLI levers (override the default)

`progressChange` exposes two mutually-exclusive flags:

- `--no-invalidate`: skip stale propagation entirely. No dependent lanes are flagged.
- `--invalidate <comma-separated-lanes>`: only the named subset of transitive dependents is flagged. Lanes that are not transitive dependents are rejected with code `invalid_invalidate_target`.

Combining the two raises `conflicting_stale_flags` at the library level (`progressChange`). At the CLI level both flags share a single Commander option (`--no-invalidate` is the negation of `--invalidate`), so a later flag overrides an earlier one rather than reaching the conflict check; the `change progress` action derives `noInvalidate` from `--no-invalidate` and `invalidateOnly` from `--invalidate <lanes>` off that single option. Passing no invalidate flag uses the pessimistic default.

### Explicit clear

- `clearChangeStaleness({ lane, reason })` removes the stale entry for the named lane, appends to `stale_history` (with the prior `invalidated_by` and `invalidated_at`), and updates `status.yml.updated_at`.
- Refuses with `lane_not_stale` if the lane is not currently flagged.
- `reason` is optional in code but the agent contract (see below) requires the agent to always pass one. `reason` is stored verbatim or `null` when omitted/blank.

### Audit trail

- `stale_history` survives across progress calls and clears; nothing trims it in v1.
- New entries are appended to the end of the array.
- Hand-editing `status.yml` to mutate stale state is explicitly out-of-policy; the CLI is the only authorized writer.

## Agent-Side Verification Protocol

Skills that call `weave change progress` carry an embedded `# Lifecycle Staleness Verification` section (byte-identical across every progress-calling skill). The protocol tells the agent:

1. Identify the structural dependents of the lane being progressed by reading `status.yml.artifacts.<other-lane>.sources`.
2. For each dependent, read both that dependent artifact and the artifact being progressed; decide per-lane whether the upstream change actually invalidates the dependent content. Binary decision per lane: invalidates, or does not.
3. Choose the progress invocation:
   - Every dependent invalidated (or none exist) → default `weave change progress <lane> --source <ids>`.
   - No dependent invalidated → `--no-invalidate`.
   - Mixed → `--invalidate=<comma-list>` naming the dependents that are invalidated.
4. If a previously-stale dependent is now in content sync (verified by reading both artifacts), clear it with `weave change clear-stale <lane> --reason "<one-sentence rationale>"`. Reason is always supplied.
5. Never edit `status.yml` by hand.

When uncertain, the protocol mandates the pessimistic default. False-positive stale flags are recoverable; silently leaving a real downstream artifact mismatched is not.

The progress-calling skills: `weave-questions`, `weave-research`, `weave-explore`, `weave-stress-test`, `weave-prd`, `weave-architect`, `weave-clarify`, `weave-slices`, `weave-fix`, `weave-capture`. Legacy `weave-issues` progressed the `issues` lane (now `slices`).

## Integrations And Side Effects

- `weave change status` includes `stale`, `stale_history`, and `stress_tests` in its JSON output.
- A stress test verdict (`status.yml.stress_tests.<lane>`) is pinned to `artifacts.<lane>.updated_at`; progressing that lane again makes the verdict `outdated`, which `weave-next`, `weave-prd`, and `weave-slices` treat as needing a fresh stress test.
- `weave change progress research` defaults its source to `questions` when `questions.md` is substantive.
- `weave-slices` separately warns and blocks when `status.yml.stale.architecture` exists, recommending architecture refresh before slice scaffolding.
- `weave change progress slices` (alias `issues`) can infer `architecture` as a source from either substantive legacy `architecture.md` or substantive folder-mode architecture resolved through the architecture artifact resolver.
- Existing changes without `artifacts`, `stale`, or `stale_history` continue to work; absent fields are treated as empty.

## Source Anchors

- Core logic: `src/lib/changes.ts` (`progressChange`, `clearChangeStaleness`, `resolveStalePropagationTargets`, `transitiveDependents`, `parseStaleHistory`)
- CLI: `src/commands/change.ts` (`progress` subcommand flags `--no-invalidate`/`--invalidate`, `clear-stale` subcommand)
- Skill contract source: `EXPECTED_LIFECYCLE_SYNC_PROTOCOL` in `src/lib/skill-template-checks.ts`
- Templates embedding the protocol: `templates/skills/weave-prd/SKILL.md`, `templates/skills/weave-clarify/SKILL.md`, `templates/skills/weave-slices/SKILL.md`, `templates/skills/weave-fix/SKILL.md`, `templates/skills/weave-capture/SKILL.md`
- Architecture source inference: `src/lib/architecture-artifact.ts`, `src/lib/changes.ts`
- Tests: `tests/cli-change-staleness.test.ts` (lib-level lever behavior), `tests/cli-change-progress.test.ts` (CLI flag wiring), `tests/agent-skills.test.ts` (byte-identity), `tests/changes.test.ts` (default propagation and architecture source inference), `tests/architecture-artifact.test.ts`

## Change History

- 2026-06-03 (change `260603-piln-npm-and-skill-versioning-and-updates`): `--no-invalidate` and `--invalidate=<lanes>` flags added to `weave change progress`; `weave change clear-stale <lane> --reason` introduced; `status.yml.stale_history` audit field introduced; agent-side `# Lifecycle Staleness Verification` byte-identical block embedded in five progress-calling skills.
- 2026-06-04 (change `260604-68e6-fix-change-progress-qf-bug`): fixed a CLI flag-wiring defect where `--no-invalidate` and `--invalidate <lanes>` collided on one Commander option and made every `weave change progress` invocation crash with `raw.trim is not a function`. The `change progress` action now derives both levers from that single option; the documented lever behavior is reachable from the CLI again. Added `tests/cli-change-progress.test.ts`. `maxStage`/`stageIndex` now tolerate the `started` stored stage.
- 2026-06-06 (change `260606-k0l6-architecture-folder`): removed `weave-architect` from the progress-calling skill set because architect is now read-only; folder-mode architecture can now drive default `issues` source inference when the architecture resolver reports substantive file or folder mode.
- 2026-06-09 (change `260609-rrsq-weave-slice`): added `findings` and `slices` lanes; `issues` normalizes to `slices` on read; `weave-slices` and `weave-fix` join the progress-calling skill set.
- 2026-10-20 (branch `change/questions-research-skills`): `weave-questions`, `weave-research`, `weave-explore`, `weave-stress-test`, and `weave-architect` joined the progress-calling skills; added evidence lanes and verdict outdating.

## Open Questions

- Whether `stale_history` should be size-bounded or trimmed on stage advance (currently grows unbounded).
- Whether to expose a `--no-reason` shortcut or surface a warning when `clear-stale` is called without `--reason` from the CLI directly (currently only the agent protocol mandates `--reason`).
