---
name: weave-prd
description: Generate or revise prd.md for an active Weave change. Use when the user wants to convert exploration, discussion, sessions, or product interview context into a product requirements document.
last_changed_in: 0.1.9
---

# Weave PRD

This skill converts available Weave product context into a product requirements document.

Use `exploration.md` when it exists and is useful, but do not require it. If product context is missing or insufficient, interview the user until the PRD can stand alone. Ask the user when a missing answer would materially change product scope, user behavior, permissions, rollout, or acceptance.

---

# Operating Principles

- Treat `exploration.md` as a preferred source when it exists and is useful.
- Do not require `exploration.md` before generating or revising `prd.md`.
- Use current discussion, PRD session notes, knowledge context, and focused product interview questions when exploration context is missing or insufficient.
- Treat `weave-prd` as entering or resuming the PRD lane for the active change.
- Treat `prd.md` as a living product artifact.
- Create `prd.md` when it does not exist.
- Revise `prd.md` in place when it already exists.
- Use `wiki/knowledge/` as product and domain context.
- Use other change artifacts as supporting context.
- Do not blindly replace the PRD with a fresh draft.
- Do not write an implementation plan.
- Do not include code-level design, schema details, API contracts, or test strategy unless needed to explain current product behavior.
- Make reasonable assumptions for minor gaps and document them in `Assumptions`.
- Put unresolved product decisions in `Open Questions`.

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
No active Weave change found. Run `weave change new` or `weave change switch`, then run `weave-prd` again.
```

After resolving the active change, treat `prd.md` as the explicit target lane. Do not set or read local artifact context.

Identify the change folder under the resolved workspace or repo context:

```text
wiki/changes/<change-id>/
```

In workspace mode there is one change context: the workspace root. In repo mode, do not assume every session folder is relevant; use the resolved change status and available artifacts to identify which contexts apply.

---

# Required Read Order

For each relevant change folder, read files in this order.

## 1. Product Context

Read when present:

```text
wiki/changes/<change-id>/exploration.md
```

Treat `exploration.md` as thin context when it is:

- missing
- blank or whitespace-only
- scaffold-only with headings but no substantive content
- explicitly marked `PRD Readiness` as `Not ready`

Do not stop solely because exploration is thin or missing. Use same-lane session notes, current discussion, knowledge context, and product interview questions until `prd.md` can stand alone. Do not write `exploration.md` from this skill.

## 2. Current PRD Baseline

Check:

```text
wiki/changes/<change-id>/prd.md
```

If `prd.md` exists, read it as the baseline to revise. Preserve still-valid content. Do not discard existing sections just because the latest exploration is shorter.

If `prd.md` does not exist, create it from the available context.

## 3. PRD Resume Context

Read relevant session files when present:

```text
wiki/changes/<change-id>/sessions/*-prd.md
```

Load PRD session files newest-first. Use the latest `## Next Resume Point` to decide whether to continue synthesis, ask a blocking product question, or revise a specific PRD section.

Rules:

- Read `prd.md` before session notes. The live artifact is canonical current truth.
- Use session notes for rationale, unresolved points, user preferences, agent recommendations, and where to resume.
- Use older PRD session files only when needed to understand rationale or unresolved decisions.
- If session notes conflict with `prd.md`, prefer `prd.md` unless the latest session records an explicit newer user decision.
- If the user gives an explicit direction, follow it over the stored resume point.

At the start of resumed PRD work, briefly state what was loaded:

```text
Resuming PRD for <change-id>.
Loaded prd.md and <N> PRD session note(s).
Latest resume point: <summary>
```

If `prd.md` does not exist, skip PRD session resume and create the initial PRD from exploration context.

## 4. Change Metadata and Supporting Artifacts

Read when present:

```text
wiki/changes/<change-id>/status.yml
wiki/changes/<change-id>/research.md
wiki/changes/<change-id>/decisions.md
wiki/changes/<change-id>/contracts.md
wiki/changes/<change-id>/handoff.md
wiki/changes/<change-id>/implementation.md
wiki/changes/<change-id>/tasks.md
```

Use these as supporting context. If artifacts conflict, prefer the latest explicit product decision from `exploration.md` or `decisions.md`. Record important conflicts in `Assumptions`, `Open Questions`, or `Revision History`.

## 5. Knowledge Context

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

Load only knowledge domains that appear relevant to the change. Use knowledge to align terminology, workflows, permissions, and existing product behavior.

## 6. Repo Documentation

If Weave knowledge is thin or missing, inspect existing repo documentation for product context:

```text
CONTEXT.md
CONTEXT-MAP.md
docs/
docs/adr/
```

Use repo documentation only to clarify domain behavior and terminology.

---

# Create Or Revise

## When `prd.md` Is Missing

Create a complete PRD from the exploration and supporting context.

Start the file with artifact frontmatter:

```yaml
---
artifact: prd
status: draft
owner: product
created_at: <YYYY-MM-DDTHH:mm:ss.sssZ>
updated_at: <YYYY-MM-DDTHH:mm:ss.sssZ>
reviewed_at: null
approved_at: null
approved_by: null
source: exploration.md
---
```

Use UTC ISO timestamps for `created_at` and `updated_at`.

Add `Revision History` with an initial entry:

```md
## Revision History

- <YYYY-MM-DD>: Initial PRD generated from `exploration.md`.
```

## When `prd.md` Exists

Revise the existing PRD in place.

Follow these rules:

- Preserve still-valid existing content.
- Preserve existing artifact lifecycle frontmatter unless the user explicitly asks to change review or approval metadata.
- If the existing PRD has no frontmatter, add compatible `artifact: prd` frontmatter without removing existing content.
- Add new workflows, requirements, edge cases, acceptance criteria, and rollout notes from newer exploration context.
- If scope expanded, update Goals, Proposed Product Behavior, User Workflows, User Stories, Functional Requirements, Edge Cases, Acceptance Criteria, Rollout Considerations, and Open Questions as needed.
- If scope narrowed, move removed behavior to `Non-Goals` or `Out of Scope` instead of silently deleting it.
- If a previous requirement is superseded, update the requirement and mention the change in `Revision History`.
- If new context contradicts older PRD content, prefer the latest explicit product decision and record the superseded point in `Revision History`, `Assumptions`, or `Open Questions`.
- If the latest exploration describes a substantially different change, stop and say:

```text
The latest exploration appears to describe a different change than the existing PRD. Create a new Weave change, or explicitly confirm that this PRD should be repurposed.
```

Add a dated `Revision History` entry summarizing the update. Keep entries concise and product-facing.

---

# Synthesis Rules

Convert the exploration into a PRD that can stand alone without the conversation history.

The PRD should be understandable by Product, Design, Engineering, QA, Customer Success, and Support.

When writing:

- Preserve concrete decisions from `exploration.md`.
- Preserve domain language from `wiki/knowledge/`.
- Separate goals from non-goals.
- Convert scenarios into user workflows, requirements, and acceptance criteria.
- Convert ambiguity into either an assumption or an open question.
- Include product-relevant technical constraints only as behavioral implications.
- Avoid implementation planning.
- Avoid speculative requirements not supported by the source context.

If the context is incomplete but a reasonable product assumption is safe, proceed and document it.

If a gap would materially change product scope, user behavior, permissions, rollout, or acceptance, do not invent the answer. Add it to `Open Questions`.

---

# Output Path

Write the completed or revised PRD to:

```text
wiki/changes/<change-id>/prd.md
```

Use Markdown.

Do not write any other files.
Do not set local artifact context; `prd.md` is the explicit target for this skill.

---

# Lifecycle Progress

After successfully writing or revising `prd.md`, run:

```bash
weave change progress prd --source exploration --source sessions --json
```

Pass only sources that actually informed the PRD. Add `--source research` when `research.md` shaped the requirements. Examples:

```bash
weave change progress prd --source discussion --json
weave change progress prd --source exploration --source sessions --json
weave change progress prd --source exploration --source research --json
```

If lifecycle progress fails, do not rewrite `prd.md` just to recover. Report the progress failure in the completion response so the user can rerun the command or inspect `status.yml`.

---

# PRD Template

Use the structure defined in `prd-template.md` (sibling to this `SKILL.md`).

The template lives at `<agent-skills-dir>/weave-prd/prd-template.md` after install. Read it as the canonical PRD section structure when creating or revising `prd.md`. If the user has modified the template, follow the user's modified structure.

---

# Completion Response

After writing `prd.md`, respond with:

```text
Created PRD: wiki/changes/<change-id>/prd.md
```

or:

```text
Revised PRD: wiki/changes/<change-id>/prd.md
```

Then include:

```text
Sources used:
- exploration.md
- <other artifacts read>
- <knowledge files read>

Assumptions: <count>
Open questions: <count>
```

If multiple relevant contexts were processed (repo mode with multiple session folders), list each created or revised PRD separately. In workspace mode, the workspace root is the single context.

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
