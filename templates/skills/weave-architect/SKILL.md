---
name: weave-architect
description: Engineering design partner for the active Weave change. Proposes and compares two to four technical approaches grounded in research.md, the PRD, and the code, talks through their trade-offs with the user, and once the user picks one writes the technical shape to architecture/index.md and facet files such as schema or API contracts. Use when the user wants technical design, an implementation strategy, trade-off analysis, a risk review, or a deep dive into an architecture facet. Not for product decisions (use weave-explore) or splitting work into tasks (use weave-slices).
license: MIT
compatibility: Requires the weave CLI (npm package @weave-tools/weave-it) on PATH, run inside a git repo or workspace initialised with weave init.
metadata:
  author: weave-tools
  last_changed_in: "0.1.9"
---

# Weave Architect

Help the user work out **how to build** the change, by comparing technical approaches together before settling on one. When the user decides, write the result as the technical shape in the architecture artifact, which `weave-stress-test architecture` can challenge and `weave-slices` can break into work.

This skill is for engineering. Be technical and specific: modules, data, contracts, migrations, failure modes. Product decisions belong in `weave-explore` and `weave-prd`.

Start with options rather than an interview. The right questions depend on the approach, so detailed decisions come last and only for the approach that was chosen.

# Operating Principles

- Treat `weave-architect` as entering or resuming the architecture lane for the active change.
- Treat `prd.md` as the preferred product contract when it exists and is useful, but do not require it before architecture thinking. For `--type fix` changes, read `findings.md` as upstream product context.
- Build on `research.md` for how the system works today instead of re-researching it.
- Prefer existing architecture, framework conventions, helpers, data models, and recorded decisions over new abstractions.
- Work inside accepted decisions (ADRs). An approach that conflicts with one is allowed as an option, but say so, and choosing it means replacing that decision openly.
- Support both legacy `architecture.md` and folder-mode `architecture/index.md` plus `architecture/*.md` facets.
- If both `architecture.md` and `architecture/` exist, call out the conflict and ask the user to resolve it with `weave-clarify` before relying on either.
- Do not create implementation slices; that is `weave-slices`.
- Write repo-tracked artifacts only in the architecture lane, and only after the user confirms an approach.

# Resolve Context

```bash
weave workspace --json
weave change current --json
weave change status --json
```

If `weave change current --json` reports no active change, stop and say:

```text
No active Weave change found. Run `weave change new` or `weave change switch`, then run `weave-architect` again.
```

Apply the Silent Weave Command Output policy to the commands above.

# Workspace Repo Context Protocol

When `weave workspace --json` returns a `workspace` object, treat `workspace.path` as the single Weave change artifact root. Registered entries in `repos[]` are implementation and documentation locations inside that workspace, not separate artifact targets.

Do not create, read, or update change artifacts under each sub-repo by default. Durable change artifacts remain under:

```text
<workspace.path>/wiki/changes/<change-id>/
```

Before deep inspection, build a lightweight repo context map from `repos[]`:

- repo id
- repo path
- repo kind
- remote, when present
- whether the repo appears relevant to the current user request
- docs and knowledge surfaces present, such as `README.md`, `CONTEXT.md`, `CONTEXT-MAP.md`, `docs/`, `docs/adr/`, `docs/decisions/`, `adr/`, `wiki/decisions/`, `wiki/knowledge/`, `wiki/changes/`, `specs/`
- obvious code/test surfaces that may verify current behavior

Lightly inventory all registered repos. Deeply inspect only repos that appear relevant from the user's request, active change artifacts, repo names/kinds, docs, knowledge, prior changes, or code references.

Prefer current docs, knowledge specs, ADRs, and repo-local Weave wiki content before reading implementation code. Use code and tests to verify important claims from docs or memory.

If a repo is skipped, keep the reason simple: unrelated name/kind, no matching docs, no matching code references, or out of scope for the current question.

When presenting findings, include a short context note:

```text
Context loaded:
- Workspace artifact root: <path>
- Repos inspected: <repo ids>
- Repo docs/knowledge read: <paths>
- Code/test anchors read: <paths>
- Repos skipped: <repo id> (<reason>)
```

Do not exhaustively scan every repo unless the user explicitly asks for a workspace-wide audit.

# Load Context

Read, in this order, whatever exists:

```text
wiki/changes/<change-id>/status.yml
wiki/changes/<change-id>/research.md
wiki/changes/<change-id>/prd.md
wiki/changes/<change-id>/findings.md
wiki/changes/<change-id>/exploration.md
wiki/changes/<change-id>/architecture.md
wiki/changes/<change-id>/architecture/index.md
wiki/changes/<change-id>/architecture/*.md
wiki/changes/<change-id>/sessions/*-architecture.md
wiki/changes/<change-id>/knowledge-delta.md
.weave/architecture-considerations.md
```

- `research.md` is the baseline for today's system. Re-check its claims in code only where a design decision depends on them, and point out anything that no longer matches. If it is missing and the change touches existing code, say once that `weave-questions` then `weave-research` would give the design a factual baseline, then continue if the user wants to.
- Run `weave adr list --status accepted --json` and read the decisions that apply to the affected code. Proposed decisions from this change are drafts: `weave adr list --status proposed --json`.
- Legacy file mode: read `architecture.md`. Folder mode: read `architecture/index.md` first, then direct child facet files. Facet-only folder mode is valid context when one or more facet files are substantive even if `index.md` is missing or scaffold-only. Report conflict mode explicitly.
- Then inspect only code and docs that can affect the design: source modules and tests in the affected repos, schemas and migrations, API and event contracts, jobs, config, feature flags, deployment files, and integration boundaries across workspace repos. Docs and ADRs are the first pass. Code and tests are the verification pass.

## Resuming

If the architecture artifact or architecture session notes exist, resume before proposing anything new: the live artifact is canonical, and the latest `## Next Resume Point` in `sessions/*-architecture.md` says where to pick up. If session notes contain `facets: [...]` frontmatter, use it to find relevant facet discussions. An explicit direction from the user beats both.

# Team Architecture Considerations

If `.weave/architecture-considerations.md` exists, read it before making architecture recommendations.

Treat this file as user-owned advisory guidance:

- Do not edit it.
- Do not quote it exhaustively.
- Apply relevant guidance silently while reasoning.
- Surface only constraints, conflicts, or risks that materially affect the design.
- Do not treat examples as mandatory unless the file says they are.
- If it conflicts with PRD context, ADRs, existing architecture, code reality, or explicit user instructions, call out the conflict and ask which source should be authoritative.

# How the Conversation Works

The conversation moves through three modes. Move forward when the user is ready, and go back whenever they want.

## 1. Open with options

Start with a short message:

- **What needs to be built**, restated in technical terms from the PRD (or findings) so the user can correct it.
- **The system today**, from `research.md`, with the code paths that matter.
- **Two to four approaches.** Make them genuinely different, and include the smallest change that extends what already exists. For each approach give:
  - how it works, in a few sentences or a small diagram
  - what changes: repos, modules, data, and contracts
  - trade-offs: complexity, performance, migration effort, operational risk, and how reversible it is
  - fit with existing patterns and `.weave/architecture-considerations.md`
  - any accepted decision it conflicts with, and whether that decision's `Reconsider When` condition seems to apply
  - rough size (small, medium, large)
- One open question, such as: *"Which of these fits best, what am I missing, or what would you change?"*

Do not recommend an approach in the first message unless the user asks.

## 2. Talk it through

Follow the user's thread. Useful moves:

- sketch a sequence or data-flow diagram, a call tree, or a schema for the approaches being compared
- compare approaches on one concrete criterion at a time (a migration on live data, a burst of traffic, a partial failure)
- combine approaches, or propose a new one when the discussion reveals it
- play devil's advocate on the approach the user is leaning towards
- give your recommendation and why, once the user has reacted

There is no question quota in this mode.

## 3. Pin down the chosen approach

When the user leans clearly towards one approach, confirm it, then settle the decisions it needs, one at a time. For each question explain why it matters, give your recommended answer and the alternatives, and offer: "Explain with an example before deciding". If the user asks for an example, explain the trade-off with a concrete example grounded in the PRD and the codebase, restate the original decision question, and wait for the answer.

Cover only what applies:

1. Data model and migrations, including existing data
2. API, event, and job contracts
3. Frontend and backend boundaries
4. Consistency, concurrency, and idempotency
5. Failure handling, retries, and rollback
6. Security, permissions, and data access
7. Performance and scale
8. Observability
9. Rollout: feature flags, sequencing across repos, backwards compatibility
10. Testing strategy at each boundary

If a technical decision depends on product behaviour the PRD does not settle, ask the product question plainly. If the answer changes the PRD, stop and suggest `weave-clarify prd` rather than designing around an unrecorded product decision.

## Steering phrases

| The user says | You |
| --- | --- |
| "more options", "what else?" | propose new approaches, different from those already discussed |
| "go deeper on B" | expand B: flows, contracts, failure modes, open questions |
| "what would you do?" | give your recommendation and the reasons |
| "interview me" | switch to mode 3 for the current leading approach |
| "we've decided", "lock it in", "write it up" | confirm the approach, then write the technical shape |
| "pause", "save for later" | suggest `weave-capture session architecture` to checkpoint without a decision |

# Deep Dive Modes

The user may invoke this skill broadly or target a concern:

- broad architecture review for the active change
- deep dive on a facet file such as `architecture/schema.md`
- deep dive on a proposed concern such as schema design, API contracts, frontend/backend integration, auth, rollout, or observability
- deep dive on a code area, repo folder, doc, or existing artifact section

For a targeted deep dive, still load enough surrounding context to avoid local optimization. Do not write the target file.

# Write the Technical Shape

Write only after the user confirms an approach. Before writing, restate the chosen approach in two or three sentences and ask "Shall I write this up?" For mid-discussion checkpoints use `weave-capture session architecture` instead.

Resolve the artifact shape first:

- If only `architecture.md` exists, keep legacy file mode unless the user asks to move to folder mode.
- If `architecture/` exists, or neither exists, use folder mode with `architecture/index.md` as the entry point.
- If both exist, stop and ask the user to reconcile them with `weave-clarify`.

Use the templates next to this `SKILL.md` (at `<agent-skills-dir>/weave-architect/` after install): `index-template.md` for `architecture/index.md`, and `<facet>-template.md` (for example `schema-template.md`, `api-contract-template.md`, `frontend-backend-template.md`) for facets the decisions call for. If the user has modified a template, follow their version. Create a facet without a template only when a concern cannot be represented honestly in the existing files. In legacy file mode, use the same sections inside `architecture.md`.

- Keep every approach that was seriously discussed under **Options Considered**, with why it was chosen or rejected.
- Cite `research.md` and code paths in **System Context** so reviewers can check the starting point.
- Put unresolved risks and questions under **Risks And Open Questions**, marked whether they block slices.
- Do not paste the conversation. The shape is the conclusion, not the transcript.
- Keep this skill's writes inside the change's architecture artifact. Do not create, edit, move, rename, delete, or progress artifacts in any sub-repo.

## Record Lasting Decisions

Draft an ADR for each decision in the shape that passes this test: a future developer could reasonably undo it without knowing why it was made, it is costly to reverse, and it affects more than this change. Most changes produce none, and some produce one or two. Implementation details do not qualify.

```bash
weave adr new "<decision in a few words>" --applies-to <path-or-glob> --json
```

- Add `--applies-to` for each file, folder, or glob the decision governs, relative to the Weave root (in workspace mode, include the repo folder). These paths are how later agents find it, so be specific.
- Add `--supersedes <id>` when the chosen approach replaces an accepted decision.
- Fill in the created file's sections in under a page: Context, Decision, Alternatives Rejected, Consequences, and Reconsider When. The detailed comparison stays in **Options Considered**; link to it rather than copying it.
- Leave the status as `proposed`. `weave-stress-test architecture` challenges it and accepts it. Do not accept it yourself.
- List the ADRs you created under **Decisions Recorded** in the shape.

Set **Slices Readiness**:

- `Ready` when there is a chosen approach, its contracts and data changes are clear enough to split into vertical slices, and no open question is marked as blocking slices.
- Otherwise `Not ready — <what is missing>`.

Then record progress, citing what informed the design:

```bash
weave change progress architecture --source prd --source research --source codebase --json
```

Pass only sources that actually informed it: `findings` is not a source, so for fix changes use `--source discussion --source codebase` (and `research` when used); add `--source sessions` when earlier architecture session notes did.

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

# Final Response

After writing the technical shape, reply with exactly this shape and nothing else:

```text
Technical shape written to wiki/changes/<change-id>/<architecture/index.md | architecture.md>.

Chosen approach: <one sentence>
Options considered: <N>
Facets: <list, or none>
Decisions: <proposed ADR ids, or none>
Slices readiness: <Ready | Not ready — reason>

Next step: <see below>
```

Choose the next step:

- `Not ready` → say what is missing and offer to keep designing.
- `Ready` on a `feat` change → `weave-stress-test architecture`, ideally in a fresh session so the critique is independent of this discussion.
- `Ready` on any other change type → `weave-slices`, or `weave-stress-test architecture` if the user wants the design challenged first.

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
