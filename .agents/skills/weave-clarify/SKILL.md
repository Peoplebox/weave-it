---
name: weave-clarify
description: Revise one existing Weave change artifact (exploration.md, prd.md, findings.md, or architecture) when scope, requirements, assumptions, or decisions change midstream, without advancing the workflow, and flag downstream artifacts that become stale. Use when the user says something changed, wants to amend or correct an artifact, or wants to resolve an open question recorded in it. Not for creating an artifact for the first time.
license: MIT
compatibility: Requires the weave CLI (npm package @weave-tools/weave-it) on PATH, run inside a git repo or workspace initialised with weave init.
metadata:
  author: weave-tools
  last_changed_in: "0.1.7"
---

# Weave Clarify

This skill refines one existing Weave change artifact without advancing the change workflow.

Use it when the user needs to amend `exploration.md`, `prd.md`, `findings.md`, or `architecture.md` because scope changed, requirements changed, an assumption needs confirmation, or a previous requirement is no longer valid.

This is not a generation skill. Do not create a new change, create issues, generate a PRD from scratch, generate architecture from scratch, or cascade-update multiple artifacts.

---

# Operating Principles

- Treat the selected target artifact as the only write target.
- Read supporting artifacts only for context.
- Ask focused clarification questions before writing when the change is ambiguous or materially affects scope, user behavior, technical direction, acceptance, or follow-up artifacts.
- Preserve still-valid content.
- Do not silently delete old requirements, decisions, constraints, or risks.
- Record superseded, removed, or narrowed scope explicitly.
- Report likely follow-up artifacts instead of editing them automatically.
- After writing the selected artifact, update lifecycle state with `weave change progress <target> --json`.
- Do not hand-edit `status.yml`; lifecycle state is owned by the CLI.
- Do not run autonomous or internal auto mode. V1 is user-invoked and interactive only.

---

# Resolve Context

Start by discovering the current Weave session:

```bash
weave workspace --json
```

Use the cwd-dispatched workspace or repo context returned by `weave workspace --json` as the boundary for context loading. In workspace mode, the workspace root owns the change store and registered sub-repos in `repos[]` are implementation locations inside that single context. In repo mode, the active session's folders are the boundary.

Resolve the target change:

1. If the user provided a change id, slug, title fragment, or other change hint, run:

```bash
weave change status "<change-hint>" --json
```

2. Otherwise, run:

```bash
weave change current --json
weave change status --json
```

If no active or hinted change can be resolved, stop and say:

```text
No active Weave change found. Run `weave change new` or `weave change switch`, then run `weave-clarify` again.
```

Identify the change folder under the resolved workspace or repo context:

```text
wiki/changes/<change-id>/
```

In workspace mode there is one change context: the workspace root. In repo mode, do not assume every session folder is relevant; use the resolved change status and available artifacts to identify which contexts apply.

---

# Workspace Repo Context For Clarification

In workspace mode, treat `workspace.path` as the single artifact root. Registered `repos[]` entries are available as implementation and documentation context, not separate artifact targets.

`weave-clarify` is not a broad discovery skill. Do not inventory or inspect every registered repo by default.

Inspect sub-repos only when the clarification depends on repo-local truth, such as:

- the selected artifact references a repo, module, API, schema, job, migration, test, doc, or ADR
- the user names a repo or implementation area
- the clarification changes technical direction, acceptance behavior, permissions, rollout, or integration boundaries
- architecture facet restructuring depends on where responsibilities actually live

When sub-repo context is needed, prefer repo-local docs, knowledge, specs, ADRs, and prior changes before implementation code. Use code and tests to verify important claims.

Keep inspection narrowly scoped to the selected artifact and the clarification requested. Do not use `weave-clarify` to perform broad product discovery or architecture exploration; recommend `weave-explore` or `weave-architect` when the required context is broad or uncertain.

Do not create, read, or update change artifacts under each sub-repo by default. Durable change artifacts remain under:

```text
<workspace.path>/wiki/changes/<change-id>/
```

If repo context influenced the clarification, mention it in the completion response:

```text
Repo context used:
- Repos inspected:
- Docs/knowledge read:
- Code/test anchors read:
- Repos intentionally skipped:
```

---

# Target Artifact

Supported target artifacts:

```text
exploration
prd
architecture
```

Accept common filenames as aliases:

```text
exploration.md -> exploration
prd.md -> prd
architecture.md -> architecture
architecture/index.md -> architecture
architecture/<facet>.md -> architecture
```

If the user provides a target artifact, clarify only that artifact.

If the user does not provide a target artifact:

1. Read the available active change artifacts.
2. Identify which supported artifacts appear affected by the user's clarification.
3. Ask the user which single artifact to clarify first.
4. Do not write anything until the user selects one target.

If multiple artifacts are affected, still update only the selected artifact in this invocation. Report the others as follow-up targets in the completion response.

---

# Required Read Order

For each relevant change folder, read files in this order.

## 1. Target Artifact

Read the selected target first:

```text
wiki/changes/<change-id>/exploration.md
wiki/changes/<change-id>/prd.md
wiki/changes/<change-id>/architecture.md
wiki/changes/<change-id>/architecture/index.md
wiki/changes/<change-id>/architecture/*.md
```

For architecture, resolve artifact shape before reading:

- Legacy file mode: `architecture.md` exists and `architecture/` does not.
- Folder mode: `architecture/` exists and may contain `index.md` plus direct child facet files.
- Conflict mode: both `architecture.md` and `architecture/` exist. Stop before editing and ask whether to keep legacy file mode, migrate to folder mode, or reconcile by hand.
- Missing mode: neither exists. Stop with the architecture missing message.

If the selected target does not exist, stop with the relevant message:

```text
No exploration.md found for <change-id>. Run `weave-explore` or `weave-capture` first, then run `weave-clarify exploration`.
```

```text
No prd.md found for <change-id>. Run `weave-prd` first, then run `weave-clarify prd`.
```

```text
No architecture artifact found for <change-id>. Run `weave-architect` and `weave-capture` first, then run `weave-clarify architecture`.
```

## 2. Supporting Artifacts

Read supporting artifacts when present:

```text
wiki/changes/<change-id>/status.yml
wiki/changes/<change-id>/exploration.md
wiki/changes/<change-id>/prd.md
wiki/changes/<change-id>/architecture.md
wiki/changes/<change-id>/architecture/index.md
wiki/changes/<change-id>/architecture/*.md
wiki/changes/<change-id>/decisions.md
wiki/changes/<change-id>/contracts.md
wiki/changes/<change-id>/handoff.md
wiki/changes/<change-id>/implementation.md
wiki/changes/<change-id>/tasks.md
```

Do not reread the target artifact twice unless needed. Use supporting artifacts to understand context, conflicts, and follow-up impact.

## 3. Target Resume Context

Read relevant session files for the selected target when present:

```text
wiki/changes/<change-id>/sessions/*-exploration.md
wiki/changes/<change-id>/sessions/*-prd.md
wiki/changes/<change-id>/sessions/*-architecture.md
```

Only load session files that match the selected target artifact, newest-first.

Rules:

- Read the selected live artifact before session notes. The live artifact is canonical current truth.
- Use the latest `## Next Resume Point`, unresolved points, user preferences, and agent recommendations as clarification context.
- Use older matching session files only when needed to understand rationale or unresolved decisions.
- If session notes conflict with the selected live artifact, prefer the live artifact unless the latest session records an explicit newer user decision.
- If the user gives an explicit clarification instruction, follow it over the stored resume point.

## 4. Knowledge Context

Read Weave knowledge files when present:

```text
wiki/knowledge/index.md
wiki/knowledge/README.md
wiki/knowledge/domains/**/index.md
wiki/knowledge/domains/**/features/**/behavior.md
wiki/knowledge/domains/**/domain-wide/**
wiki/knowledge/shared/**/behavior.md
wiki/knowledge/**/source-map.md
```

Load only knowledge domains that appear relevant to the clarification.

## 5. Repo Documentation

If Weave knowledge is thin or missing, inspect existing repo documentation for product or technical context:

```text
CONTEXT.md
CONTEXT-MAP.md
README.md
docs/
docs/adr/
adr/
```

Use repo documentation only to clarify current behavior, terminology, constraints, or architecture context.

---

# Clarification Flow

## 1. Classify The Change

Classify the user's clarification as one or more of:

- scope expansion
- scope reduction
- superseded requirement or decision
- assumption confirmation
- ambiguity resolution
- technical direction change
- architecture facet restructuring
- follow-up artifact staleness

If the clarification appears to describe a substantially different change, stop and ask for explicit confirmation before repurposing the active change artifact.

## 2. Ask Blocking Questions

Ask questions only when the answer affects:

- product scope
- user behavior
- permissions or access
- acceptance criteria
- technical direction
- implementation risk
- artifact consistency
- whether the active change should be repurposed

For each question:

- explain why it matters
- provide a recommended answer when there is a clear default
- describe the tradeoff briefly
- wait for the user's answer before writing

If no blocking questions remain, proceed with the clarification using the available context.

## 3. Update Only The Selected Artifact

Write only the selected target artifact.

Do not edit follow-up artifacts in the same invocation, even when they are stale.

For architecture folder mode, "selected artifact" means the architecture lane. You may edit `architecture/index.md` and direct child facet files in one invocation only when the user's clarification is explicitly structural within the architecture lane.

Supported architecture structural operations:

- create facet: add `architecture/<facet>.md` when the user explicitly asks for a separate facet or a template-backed facet is clearly requested
- split facet: move a coherent concern from `index.md`, `architecture.md`, or another facet into a new facet file
- merge facets: combine two or more facet files and remove the superseded facet only after preserving still-valid content
- rename facet: move `architecture/<old>.md` to `architecture/<new>.md` and update references in `index.md`
- delete facet: remove a facet only when the user explicitly confirms the content is obsolete or preserved elsewhere
- move content: relocate content between `index.md` and facets without changing its meaning
- update index: keep `architecture/index.md` as the canonical overview and facet map

Legacy migration:

- If the user asks to split or introduce facets while only `architecture.md` exists, migrate to folder mode by creating `architecture/index.md` from the legacy file and then creating/updating facets.
- Preserve legacy lifecycle frontmatter in `architecture/index.md`.
- Remove `architecture.md` only after `architecture/index.md` and any facets contain the preserved content and the user intent clearly implies migration.
- If migration intent is unclear, ask before moving or deleting the legacy file.

When updating:

- preserve still-valid content
- Preserve existing artifact lifecycle frontmatter; if the selected artifact has no frontmatter, add compatible lifecycle frontmatter using UTC ISO timestamps for `created_at` and `updated_at`.
- update current behavior or proposed behavior to reflect the latest decision
- move removed scope to `Non-Goals` or `Out of Scope` where appropriate
- record superseded requirements or decisions in `Revision History`, `Assumptions`, `Open Questions`, or an artifact-specific notes section
- add unresolved decisions to the artifact's open-question section
- keep the artifact understandable without the conversation history

## 4. Report Follow-Up Artifacts

After writing the selected artifact, identify other supported artifacts that may need clarification:

- If `exploration.md` changed and `prd.md` exists, report `prd.md` as a likely follow-up when product behavior, scope, requirements, or acceptance changed.
- If `prd.md` changed and `status.yml.artifacts.architecture.sources` includes `prd`, report the architecture artifact as a likely follow-up when technical design, rollout, risks, or tests may be stale.
- If the architecture artifact changed and issue/task evidence depends on `architecture`, report issues or `tasks.md` as a likely follow-up when implementation slices may be stale.

Do not edit those artifacts. Ask the user to run `weave-clarify <target>` separately for each follow-up artifact.

---

# Target-Specific Rules

Each target (`exploration`, `prd`, `architecture`) has its own rules for which sections to keep current and how to handle scope changes. Before editing, read the matching section of `target-rules.md` (sibling to this `SKILL.md`, at `<agent-skills-dir>/weave-clarify/target-rules.md` after install).

---

# Output Path

Write the clarified artifact to exactly one of:

```text
wiki/changes/<change-id>/exploration.md
wiki/changes/<change-id>/prd.md
wiki/changes/<change-id>/architecture.md
wiki/changes/<change-id>/architecture/index.md
wiki/changes/<change-id>/architecture/*.md
```

Do not write any other files.

---

# Lifecycle Progress

After successfully writing the selected artifact, run the matching lifecycle command:

```bash
weave change progress exploration --source discussion --json
weave change progress prd --source exploration --source sessions --json
weave change progress architecture --source prd --source codebase --json
weave change progress architecture --source prd --source research --source codebase --json
```

Run only the command matching the selected target artifact and pass only sources that actually informed the clarified artifact. If lifecycle progress fails, do not rewrite the clarified artifact just to recover. Report the progress failure in the completion response.

---

# Completion Response

After writing, respond with:

```text
Clarified <target>: wiki/changes/<change-id>/<artifact-path>
```

Then include:

```text
Clarifications applied: <count or concise summary>
Open questions: <count>
Follow-up artifacts:
- <artifact or None>
```

If repo context influenced the clarification, also include:

```text
Repo context used:
- Repos inspected:
- Docs/knowledge read:
- Code/test anchors read:
- Repos intentionally skipped:
```

If no write was made because the skill needed target selection, confirmation, or answers to blocking questions, say that directly and list what is needed next.

---

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

---

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
