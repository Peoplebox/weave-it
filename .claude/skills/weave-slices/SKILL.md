---
name: weave-slices
description: Break the active Weave change's architecture into tracer-bullet vertical slices under task-slices/, each with its own tasks, technical contract, and dependencies, plus a dependency graph. Use when the design is ready and the user wants tasks, slices, a work breakdown, or an implementation plan. Not for the technical design itself (use weave-architect) or for implementing tasks (use weave-execute).
license: MIT
compatibility: Requires the weave CLI (npm package @weave-tools/weave-it) on PATH, run inside a git repo or workspace initialised with weave init.
metadata:
  author: weave-tools
  last_changed_in: "0.1.11"
---

# Weave Slices

# Silent Weave Command Output

Weave skills run Weave CLI commands silently by default. Use command results
as internal context, not response content.

Do not show raw stdout, JSON payloads, command echoes, lifecycle payloads,
internal state-write confirmations, or verbatim notice text unless the user
explicitly asks for diagnostic output.

Surface only information that changes what the user or agent should do next:
blockers, failures, missing relevant repos, branch or task outcomes,
lifecycle failures, package-outdated notices, relevant outdated or modified
skills, and user-required actions.

Notice handling:

- `package_outdated`: show only when present. Say exactly:
  `A newer Weave version is available. Run \`weave status\` for details, then upgrade Weave when convenient.`
- `skills_outdated`: suppress unrelated skills. If the invoked skill is outdated, say:
  `The installed \`<skill-name>\` skill appears older than the bundled template. Run \`weave status\` for details, then \`weave agent update --all\` when you want to refresh installed skills.`
- `skills_outdated`: if multiple skills used in this workflow are outdated, say:
  `Some installed skills used in this workflow appear older than the bundled templates: \`<skill-a>\`, \`<skill-b>\`. Run \`weave status\` for details, then \`weave agent update --all\` when you want to refresh them.`
- `skills_modified`: suppress unless the invoked skill is modified locally or the user is asking about skill updates. If the invoked skill is modified, say:
  `The installed \`<skill-name>\` skill has local edits, so its behavior may differ from the bundled template. Run \`weave status\` or \`weave agent diff\` if you want to inspect the difference.`
- `skills_modified`: if the user asks to update skills and installed skills have local edits, say:
  `Some installed skills have local edits. \`weave agent update\` may skip or protect them; run \`weave status\` or \`weave agent diff\` before updating.`

Do not say `Notices: ...`, `The command returned notices`, raw
`notices[].message`, full notice JSON, or full skill lists unless the user
asks for diagnostics.

Break a change into vertical slices under `task-slices/<NN>-<slug>/`. Each slice gets `slice.md`, `contracts.md`, `tasks.md`, and `status.yml`. The change-level `task-slices/dependency-graph.md` is rollup-derived when there are two or more slices.

`weave-slices` replaces the legacy flat `tasks.md` model for new sliced changes.

## Upstream Inputs By Change Type

- `--type feat`: `prd.md` + `architecture/` (both required).
- `--type fix`: `findings.md` (required) + `architecture/` (optional).
- `--type chore` / `--type refactor`: `exploration.md` (required) + `architecture/` (optional).

## Outputs

```text
wiki/changes/<change-id>/task-slices/
  <NN>-<slug>/
    slice.md
    contracts.md
    tasks.md
    status.yml
```

## Generation Rules

- Allocate all slice IDs atomically in one pass (`01`, `02`, …). Never renumber slices with `in_progress` or `done` tasks.
- Every task has explicit `Repos:` (csv). No path-to-repo derivation.
- `Owner:` left blank in `tasks.md` and `status.yml`.
- `Execution:` defaults to `afk` for all generated tasks. Use `hitl` only when the user explicitly asks to mark a particular architecture area, slice, or task as human-in-the-loop.
- `Blocked by:` is within-slice only. Cross-slice ordering uses `status.yml.depends_on`.
- Populate `depends_on` from architecture cues; surface ambiguities in the completion response.
- `contracts.md` uses slice-level technical contracts (Interfaces, Data, State, Validation; adaptive sections — not FE/BE-only).
- For fix-type single-slice changes, skip `slice.md` / `contracts.md` when nothing meaningful to write.

## Verification Tasks

Every slice must include explicit verification tasks. Do not leave verification implied inside implementation tasks only.

- Prefer tests closest to the changed behavior: unit, integration, request/API, component, E2E, migration/data, or regression tests as applicable.
- Name the behavior, boundary, or regression being verified. Good titles: `Verify approver picker rejects empty selection`, `Regression: list endpoint returns 404 for unknown workflow`.
- Bad titles: `Write tests`, `Add test coverage`, `Test the feature`.
- Put automated verification in each task's `### Verification` section with concrete commands (for example `npm test -- ApproverPicker`, `npm test -- listApprovers`).
- When automated tests are not practical for a slice, add a dedicated manual verification task with numbered steps and an expected result.
  - Manual verification tasks are `afk` only when the steps are fully mechanical and can be performed by the agent in the available environment.
  - Mark manual verification as `hitl` when it requires a browser-only check, product judgment, visual approval, credentials, customer data, production access, or human acceptance.
- Verification tasks may be the final task in a slice (`Blocked by:` the implementation tasks they cover) or embedded in the same tracer-bullet task when the slice is small — but the verification expectation must be explicit either way.

## Idempotent Re-Run

When `task-slices/` already exists:

- Inspect current slices vs upstream artifacts.
- Propose additive expansion only.
- Never silently move `in_progress` or `done` tasks.
- Destructive changes require explicit user confirmation.

## Templates

Use files under `templates/skills/weave-slices/`:

- `slice-template.md`
- `contracts-template.md`
- `tasks-template.md`
- `status-template.yml`
- `dependency-graph-template.md` (reference only; rollup generates the live file)

## After Scaffolding

1. Run `weave slice rollup --all --json`.
2. Run `weave change progress slices --source <upstream> --json` (architecture for feat; findings or architecture for fix; exploration for chore/refactor).
3. Report slice folders, dependency hints, and next step (`/weave-next` or `/weave-execute <slice-id> T1`).

## Lifecycle

Follow the Lifecycle Progress and Staleness protocol before calling `weave change progress`.

Do not commit, push, or open PRs.

# Lifecycle Staleness Verification

Before calling `weave change progress`, verify content-sync of every artifact
that would otherwise be marked stale by the default pessimistic propagation.

The `--source` arguments of `weave change progress` declare causal influence,
not strict-DAG dependency. Pessimistic staleness propagation is the safe default,
not the only correct answer. When the clarification this skill just performed is
narrowly contained (a typo fix, a sentence rewording, an open-question
resolution), dependents may already be in content sync; flagging them stale
creates churn the user did not ask for.

Procedure:

1. Identify the set of structural dependents of the lane being progressed. Read
   `wiki/changes/<change-id>/status.yml` and compute which lanes list this
   lane in their `artifacts.<lane>.sources`.
2. For each dependent lane, read both the dependent artifact and the artifact
   just being progressed. Decide whether the change you just made invalidates
   the dependent's content. The judgement is binary per lane: invalidates, or
   does not invalidate.
3. Select the appropriate progress invocation:

   - Every dependent is invalidated (or there are no dependents):
     `weave change progress <lane> --source <list> --json` (default, no new flags)
   - No dependent is invalidated:
     `weave change progress <lane> --source <list> --no-invalidate --json`
   - Some dependents are invalidated, some are not:
     `weave change progress <lane> --source <list> --invalidate=<comma-list> --json`

4. If a previously-stale dependent is now in content sync (because the upstream
   change has been absorbed but the stale flag still lingers from an earlier
   pessimistic propagation), clear it explicitly:

   `weave change clear-stale <lane> --reason "<one-sentence verification>" --json`

   Always pass `--reason` so the audit entry in `stale_history` carries the
   verification rationale. Do not clear flags without reading both artifacts.

5. Never edit `status.yml` by hand to manipulate stale state. Use the CLI.

Failure mode: if you are uncertain whether a dependent is in content sync,
prefer the pessimistic default (omit `--no-invalidate` and `--invalidate`).
The user can always run `weave-clarify <lane>` later. A false-positive stale
flag is recoverable; silently leaving a real downstream artifact mismatched is
not.
