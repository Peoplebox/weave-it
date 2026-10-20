---
name: weave-capture
description: Save the current discussion into the active Weave change as a structured session note, optionally updating the matching artifact (exploration.md, prd.md, findings.md, or architecture) and its lifecycle state. Use when the user says capture this, save this discussion, checkpoint, or wants decisions from a chat persisted before moving on. Not for amending an artifact after scope changes (use weave-clarify).
license: MIT
compatibility: Requires the weave CLI (npm package @weave-tools/weave-it) on PATH, run inside a git repo or workspace initialised with weave init.
metadata:
  author: weave-tools
  last_changed_in: "0.1.9"
---

# Purpose

Capture the current discussion into the active Weave change context.

Use this when the user wants to preserve discussion rationale, decisions, options considered, unresolved points, user preferences, agent recommendations, and the next resume point without storing a raw transcript.

There are two capture modes:

- Artifact capture: bare `weave-capture` creates a structured session note, promotes pending session context for the selected lane, and updates the selected live artifact.
- Session-only capture: `weave-capture session [exploration|prd|findings|architecture]` creates a lane-aware structured session note and does not create or update any live artifact.

The session file is a continuation aid. Live artifacts remain the durable current truth.

# Workflow

1. Run:

```bash
weave workspace --json
weave change current --json
```

2. Resolve the capture mode and lane.

If the user invoked session-only mode, such as:

```text
weave-capture session
weave-capture session exploration
weave-capture session prd
weave-capture session architecture
```

use session-only behavior for this invocation.

In session-only mode, an explicit lane wins for this invocation:

```text
exploration
prd
findings
architecture
```

If the user invoked `weave-capture session` without a lane, stop before writing and ask:

```text
Which lane should I capture this session under: exploration, prd, findings, or architecture?
```

If the user did not invoke session-only mode, use artifact capture behavior.

3. For artifact capture, resolve the capture target.

If the user explicitly named an artifact target, use it for this invocation. Supported targets are:

```text
exploration
prd
findings
architecture
```

If the user did not name a target, stop before writing and ask:

```text
Which artifact should I capture this into: exploration, prd, findings, or architecture?
```

# Defensive Lane Verification

Before writing any session note or artifact, defensively verify that the resolved lane matches the substance of the conversation being captured.

Compare:

- the resolved lane (from explicit user input or `weave-capture session <lane>`)
- and the dominant subject of the discussion being captured (exploration: product discovery and stress-tested requirements; prd: user-facing requirements, acceptance criteria, scope, open questions; architecture: engineering design, module boundaries, tradeoffs, technical risks)

If the resolved lane and the dominant subject clearly disagree (for example, the user explicitly selected `prd` but the conversation is heavily architectural; or the user invoked `weave-capture session exploration` after a long architectural discussion), do not write. Stop and ask:

```text
Selected lane is <lane>, but the conversation reads as <observed-lane>.
Capture this into: <lane>, <observed-lane>, or another lane?
```

Wait for the user's choice. Use the user's reply as the resolved lane for the rest of this invocation. Do not silently override the explicit selection.

If the lane and the conversation substance are aligned (or if the conversation is too short or mixed to judge), proceed with the resolved lane without asking.

4. Identify the active change folder:

```text
wiki/changes/<change-id>/
```

5. Ensure the sessions folder exists:

```text
wiki/changes/<change-id>/sessions/
```

If it is missing in an older change, create it before writing the session note.

6. Create a new structured session file:

```text
wiki/changes/<change-id>/sessions/YYYYMMDD-HHMMSS-<4-char-id>-<artifact>.md
```

Use the local timestamp for `YYYYMMDD-HHMMSS`. Use a 4-character lowercase alphanumeric id and retry if the filename already exists.

Existing session files using `yyyy-mm-dd-<4-char-id>-<artifact>.md` remain valid historical notes.

7. Write structured session notes with this shape:

```md
---
artifact: <exploration|prd|architecture>
capture_mode: <artifact|session>
captured_at: <YYYY-MM-DDTHH:mm:ss.sssZ>
facets: []
---

# Session Capture: <Artifact> - <YYYY-MM-DD>

## Summary

## Decisions Made

## Options Considered

## Rejected Approaches

## User Preferences

## Agent Recommendations

## Unresolved Points

## Live Artifact Updates Applied

## Next Resume Point
```

Do not copy or store the raw transcript. Summarize and structure the discussion.

Set `capture_mode: session` for session-only capture. Set `capture_mode: artifact` for regular artifact capture.

For architecture captures, set `facets: [...]` to the architecture concerns discussed, such as `index`, `schema`, `api-contract`, `frontend-backend`, or user-named facet slugs. For non-architecture captures, use `facets: []`.

For session-only capture, write `None; session-only capture` or equivalent under `Live Artifact Updates Applied`.

8. For session-only capture, stop after writing the session note.

Do not create or update:

```text
wiki/changes/<change-id>/exploration.md
wiki/changes/<change-id>/prd.md
wiki/changes/<change-id>/architecture.md
wiki/changes/<change-id>/architecture/
```

Session-only capture is resume context only. It is not canonical artifact truth. It does not require the lane's live artifact to exist and does not require upstream prerequisite artifacts.

9. For artifact capture, create or merge durable content into the selected live artifact:

```text
exploration -> wiki/changes/<change-id>/exploration.md
prd -> wiki/changes/<change-id>/prd.md
architecture -> wiki/changes/<change-id>/architecture.md or wiki/changes/<change-id>/architecture/index.md plus facets
```

For architecture targets, resolve artifact shape before writing:

- If only `architecture.md` exists, preserve legacy file mode unless the user explicitly asks to move to folder mode or create a separate facet.
- If `architecture/` exists, use folder mode. Treat `architecture/index.md` as the canonical entry point and direct child `architecture/*.md` files as facets.
- If neither exists and architecture content is being captured, create folder mode at `architecture/index.md` by default.
- If both `architecture.md` and `architecture/` exist, stop before writing and ask whether to keep legacy file mode, migrate to folder mode, or reconcile the conflict with `weave-clarify`.
- Facet-only folder mode is valid. If a user explicitly asks to capture a concern into its own file and no matching template exists, create the facet file without a template and link or mention it from `index.md` when useful.

Before writing the live artifact, inspect pending session notes for the selected lane:

```text
wiki/changes/<change-id>/sessions/*-<artifact>.md
```

Pending session notes are session captures that may contain durable discoveries, decisions, constraints, rejected approaches, unresolved questions, risks, preferences, or next-resume context that has not yet been reflected in the live artifact.

Selection rules:

- If the selected live artifact does not exist, consider all matching lane session notes.
- If the selected live artifact exists, consider matching lane session notes newer than the artifact `updated_at` timestamp.
- Determine session time from YAML `captured_at` first. If missing, derive it from the timestamped filename. For legacy `yyyy-mm-dd-<id>-<artifact>.md` notes or ambiguous session time, include the note conservatively when it might be newer than the artifact.
- Do not reconsider older matching notes after their durable content is reflected in a live artifact update; future bare captures use the live artifact `updated_at` cutoff.
- Do not read session notes for other lanes.

Only merge artifact-relevant current truth:

- decisions
- clarified requirements
- accepted constraints
- important rejected approaches
- unresolved questions
- risks or edge cases relevant to the artifact
- next-phase-relevant context

When the live artifact already exists, preserve its template structure and lifecycle frontmatter. When the live artifact is missing but allowed by the target rules below, create it with appropriate lifecycle frontmatter and the normal artifact structure for that lane.

For `exploration.md`, use the product shape structure in `<agent-skills-dir>/weave-explore/shape-template.md` and keep it in product language. `weave-explore` normally writes the shape itself once the user picks a direction; capture is for checkpoints and for promoting pending exploration session notes.

For folder-mode architecture, discover direct child template resources in the installed skill directory:

```text
<agent-skills-dir>/weave-architect/*-template.md
```

Use templates by convention only. `index-template.md` is for `architecture/index.md`; `<facet>-template.md` is for `architecture/<facet>.md`. If no relevant template exists, fit content into existing architecture docs wherever it belongs. Create a new no-template facet only when the user explicitly asks for a separate facet file or the current capture cannot be represented honestly in existing docs.

Do not add transcript-style discussion to the live artifact.

10. For artifact capture, after successfully creating or updating the live artifact, run lifecycle progress for the selected artifact:

```bash
weave change progress exploration --source discussion --json
weave change progress prd --source exploration --source sessions --json
weave change progress architecture --source prd --source codebase --json
weave change progress architecture --source prd --source research --source codebase --json
```

Run only the command matching the selected artifact and pass only sources that actually informed the live artifact. If lifecycle progress fails, do not rewrite the session note or live artifact just to recover. Report the progress failure in the completion response.

# Target Rules

## Session-Only Capture

- Session-only mode is selected by invocations like `weave-capture session`, `weave-capture session exploration`, `weave-capture session prd`, or `weave-capture session architecture`.
- Explicit session-only lane wins for this invocation.
- Supported lanes are `exploration`, `prd`, and `architecture`.
- `weave-capture session` without an explicit lane asks which lane to use before writing.
- Session-only capture requires a valid active change.
- Session-only capture does not require the selected live artifact to exist.
- Session-only capture does not enforce upstream prerequisite artifacts.
- Session-only capture must not create or update `exploration.md`, `prd.md`, `architecture.md`, or `architecture/`.

## Artifact Capture

- An explicit user target wins for this invocation.
- `weave-explore` maps to `exploration`.
- `weave-prd` maps to `prd`.
- `weave-architect` maps to `architecture`.
- If no explicit target is provided, ask for a target before writing.
- If the selected live artifact does not exist, create it only when the active change, target context, and selected-lane context are sufficient:
  - missing `exploration.md`: create it for the valid active change
  - missing `prd.md`: create it from current discussion, PRD sessions, and useful exploration context when enough product truth exists
  - missing architecture artifact: create `architecture/index.md` from current discussion, architecture sessions, useful PRD context, and codebase/technical context when enough engineering truth exists
- Treat upstream artifacts as optional sources, not prerequisites.
- If selected-lane context is insufficient, write the session note and stop before creating the live artifact. Tell the user which lane conversation or interview is needed next.

# Missing Artifact Creation

Creating a missing live artifact is allowed only for the selected capture target. The captured discussion supplies the current lane context, and upstream artifacts supply optional product or technical context when they exist and are useful.

- For `exploration.md`, synthesize the artifact from the current discussion and mark unresolved discovery points clearly.
- For `prd.md`, synthesize the artifact from current discussion, PRD sessions, and useful exploration context. Do not require `exploration.md`.
- For architecture, synthesize `architecture/index.md` and any explicit or template-backed facet files from current discussion, architecture sessions, useful PRD context, and codebase/technical context. A just-completed Plan Mode `weave-architect` discussion is valid source material for the first architecture draft.
- If the current discussion does not contain enough durable content for the selected missing artifact, write the session note and stop before creating the live artifact. Tell the user which lane conversation is needed next.

# Behavior Rules

- The CLI owns active change lookup. The skill owns explicit target resolution.
- The skill owns discussion synthesis, session note writing, and live artifact merging.
- Bare `weave-capture` is the only v1 flow that promotes pending session-only context into live artifacts.
- Do not create a new change unless the user explicitly asks for a new change.
- Do not create `exploration.md`, `prd.md`, `architecture.md`, or `architecture/` in session-only mode.
- Do not create `exploration.md`, `prd.md`, `architecture.md`, or `architecture/` in artifact capture mode without a valid active change, valid target context, and enough selected-lane context.
- Do not store raw transcripts in v1.
- Do not remove existing lifecycle frontmatter.
- Do not call lifecycle progress in session-only mode.
- Do not hand-edit `status.yml`; use `weave change progress <lane> --json` after successful artifact capture.
- Do not update `reviewed_at`, `approved_at`, or `approved_by` unless a future approval flow defines that behavior.
- Keep unresolved choices explicit in the session note and live artifact where relevant.

# Completion Response

For artifact capture, report both outputs:

```text
Captured session: wiki/changes/<change-id>/sessions/<filename>.md
Updated artifact: wiki/changes/<change-id>/<artifact-path>
```

For session-only capture, report the session and explicitly state that no live artifact was updated:

```text
Captured session: wiki/changes/<change-id>/sessions/<filename>.md
Updated artifact: none (session-only capture)
```

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
