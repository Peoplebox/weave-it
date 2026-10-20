---
name: weave-explore
description: Stress-test product requirements against the current system, workflows, and domain language. Use when refining PRDs, validating workflows, uncovering edge cases, clarifying ownership, or aligning new changes with existing product behavior.
last_changed_in: 0.1.9
---

# Weave Awareness

This is a Weave product exploration skill.

---

# Plan Mode Guard

This skill must run in Plan Mode.

If the current environment exposes collaboration mode and it is not Plan Mode, stop immediately and say:

`This skill must run in Plan Mode. Switch to Plan Mode, then invoke weave-explore again.`

Do not inspect deeply, ask discovery questions, update artifacts, or continue work before this guard passes.

Static Weave skill content cannot automatically switch collaboration mode. The host, user, or developer layer must switch modes before this skill continues.

In Plan Mode, this skill resolves the active branch-derived change and treats `exploration` as the explicit target lane. It does not write local artifact lane state.

Do not write repo-tracked artifacts directly. Produce the plan, decisions, questions, or proposed artifact changes needed for the user to approve. Actual artifact writes happen only after the user exits Plan Mode and asks to implement the plan.

---

Start by discovering the current Weave session:

```bash
weave workspace --json
weave change current --json
```

Use the cwd-dispatched workspace or repo context returned by `weave workspace --json` as the exploration boundary. In workspace mode, the workspace root owns the change store and registered sub-repos in `repos[]` are implementation locations inside that single context. In repo mode, the active session's folders are the boundary. If there is no active Weave change, stop and ask the user to run `weave change new` or `weave change switch` before continuing.

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
- docs and knowledge surfaces present, such as `README.md`, `CONTEXT.md`, `CONTEXT-MAP.md`, `docs/`, `docs/adr/`, `adr/`, `wiki/knowledge/`, `wiki/changes/`, `specs/`
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

---

For each resolved context, inspect Weave knowledge first when present:

```text
wiki/knowledge/index.md
wiki/knowledge/README.md
wiki/knowledge/domains/**/index.md
wiki/knowledge/domains/**/features/**/behavior.md
wiki/knowledge/domains/**/domain-wide/**
wiki/knowledge/shared/**/behavior.md
wiki/knowledge/**/source-map.md
wiki/changes/
```

Use `wiki/knowledge/` as current product/domain context.

Use `wiki/changes/` as historical or in-progress change context.

If a relevant change folder exists, read the applicable change artifacts:

```text
exploration.md
prd.md
sessions/*-exploration.md
decisions.md
contracts.md
status.yml
handoff.md
implementation.md
tasks.md
```

In workspace mode there is one change context: the workspace root. In repo mode, do not assume every session folder is equally relevant; identify which contexts appear relevant and why.

---

# Resume Context

`weave-explore` means enter or resume exploration for the active change.

When an active change already has exploration context, resume before asking new discovery questions:

1. Read `wiki/changes/<change-id>/exploration.md` first. Treat the live artifact as canonical current truth.
2. Read relevant `wiki/changes/<change-id>/sessions/*-exploration.md` files newest-first.
3. Prioritize the latest `## Next Resume Point` when deciding what to ask or examine next.
4. Use older exploration session files only when needed for rationale, unresolved points, user preferences, or agent recommendations.
5. If session notes conflict with the live artifact, prefer the live artifact unless the latest session records an explicit newer user decision.
6. If the user gives an explicit direction, follow it over the stored resume point.

At the start of a resumed exploration, briefly state what was loaded:

```text
Resuming exploration for <change-id>.
Loaded exploration.md and <N> exploration session note(s).
Latest resume point: <summary>
```

If no useful prior exploration content or session notes exist, start normal exploration.

---

# Current-State Research

`weave-explore` is product discovery. Facts about how the system works today belong in `wiki/changes/<change-id>/research.md`, written by `weave-research` from `questions.md`.

- If `research.md` exists, read it before asking discovery questions and treat it as the current-state baseline. Use it to ground scenarios, call out contradictions, and avoid asking the user things the research already answers.
- Do not repeat research that `research.md` already covers. Inspect code yourself only to confirm a specific behaviour the conversation depends on, or to fill a small gap.
- If `research.md` is missing and the change touches existing behaviour, say once that `weave-questions` then `weave-research` (in a fresh session) would give exploration a factual baseline, then continue if the user wants to proceed without it.
- If you find that `research.md` is wrong or out of date, say so and suggest re-running `weave-research`; do not edit it from this skill.
- When `research.md` informed the exploration, the capture that persists it should record `--source research` alongside `--source discussion`.

---

# Purpose

This skill helps refine product requirements by interrogating workflows, domain language, permissions, lifecycle behavior, operational expectations, and edge cases.

The goal is to clarify:
- what the system should do
- who experiences it
- how it behaves in real scenarios
- how it fits into the existing product model

This is a product discovery and requirement clarification exercise - not an architecture review.

---

# Core Behavior

Interview the user relentlessly about the product behavior until a shared understanding is reached.

Ask questions one at a time and wait for the user's response before continuing.

For each question:
- explain why the question matters
- provide a likely/default recommendation
- explain implications of alternative choices
- keep the discussion grounded in user and business behavior
- avoid implementation details unless explicitly requested

Prefer:
- concrete scenarios
- user journeys
- lifecycle transitions
- ownership clarification
- operational edge cases

Avoid:
- infrastructure discussions
- database choices
- eventing strategies
- APIs
- storage design
- deployment architecture
- framework discussions

unless the user explicitly asks for technical design.

---

# Discovery Order

Resolve questions in this order:

1. Domain language
2. Users, actors, and roles
3. User workflows
4. Permissions and admin controls
5. State transitions and lifecycle rules
6. Failure cases and edge cases
7. Notifications and visibility
8. Operational expectations
9. Rollout flags, configuration, rollout scope, and migration concerns
10. Technical implications (only if required)

Do not jump into technical implementation prematurely.

---

# Technical Boundary

Prefer `research.md` for current-state facts. Beyond that, you may inspect the codebase to:
- understand existing workflows
- identify terminology
- discover current constraints
- detect contradictions
- understand current product behavior
- uncover hidden assumptions

Use the codebase to anchor the conversation in reality.

But do NOT ask users to choose:
- databases
- queues
- event buses
- consistency models
- storage engines
- deployment patterns
- API styles
- frameworks

unless:
1. the user explicitly requests technical design
2. or the decision materially changes product behavior, compliance, or operational guarantees

If a technical concern emerges:
- capture it as a technical implication
- do not force resolution immediately
- continue product discovery first

Translate technical concerns into behavioral language whenever possible.

Example:
Instead of asking:
> "Should this be eventually consistent?"

Ask:
> "Is it acceptable if users see updates a few seconds later?"

---

# Sub-Repo Product Discovery

In workspace mode, use registered repos to understand existing product behavior across the workspace.

For relevant repos, prioritize reading:

```text
wiki/knowledge/**
wiki/changes/**
README.md
CONTEXT.md
CONTEXT-MAP.md
docs/**
docs/adr/**
adr/**
specs/**
tests/**
```

Use sub-repo context to discover:

- domain language and user-facing terminology
- actors, roles, permissions, and ownership boundaries
- existing workflows and lifecycle states
- configuration or rollout behavior that changes user experience
- failure states, edge cases, and operational expectations
- prior changes or specs that constrain the current exploration

Read implementation code only as needed to verify current behavior, locate hidden assumptions, or resolve contradictions between docs and reality.

Translate technical findings into product behavior questions. Do not ask the user to choose implementation details unless the choice materially changes user behavior, compliance, visibility, permissions, rollout, or operational guarantees.

---

# Scenario-Driven Discovery

Prefer concrete scenarios over abstractions.

Instead of:
> "Can approvals be revoked?"

Ask:
> "Suppose compensation is finalized and a manager reopens the review afterward - what should happen?"

Use scenarios to:
- expose hidden assumptions
- clarify ownership
- test lifecycle boundaries
- uncover operational risks
- reveal conflicting expectations

---

# Domain Awareness

During codebase exploration, also look for existing documentation. Prefer Weave knowledge when present, and use existing repo documentation as additional context.

## File structure

Most repos have a single context:

```text
/
|-- CONTEXT.md
|-- docs/
|   `-- adr/
`-- src/
```

Some repos have multiple contexts:

```text
/
|-- CONTEXT-MAP.md
|-- docs/
|   `-- adr/
`-- src/
    |-- ordering/
    |   |-- CONTEXT.md
    |   `-- docs/adr/
    `-- billing/
        |-- CONTEXT.md
        `-- docs/adr/
```

Use existing documentation to:
- align terminology
- avoid duplicate concepts
- detect conflicting meanings
- understand established workflows
- reconcile Weave knowledge with repo-local docs when they conflict

---

# PM-Safe Code Exploration

Code inspection is allowed when needed to verify current product behavior.

However, do not show code snippets, function internals, database schemas, API details, or infrastructure details unless the user explicitly asks.

Translate technical findings into product language.

Good:
> "Today, the system appears to finalize the whole review at once. It does not currently support partial approvals."

Avoid unless asked:
> "The `finalizeReview()` function calls `updateMany()` on all review items."

If technical uncertainty matters, surface it as a product-relevant implication:
> "There may be technical coupling here, but the product question is whether partial approval should exist at all."

Keep technical implications separate from product decisions.

---

# Glossary Discipline

Challenge terminology aggressively.

If the user uses a term that conflicts with the existing language, call it out immediately.

Example:
> "Your glossary defines 'submission' differently from how you're using it here - which meaning should we standardize on?"

Sharpen vague language.

Replace overloaded terms with precise domain concepts.

Example:
> "When you say 'manager', do you mean the direct manager, calibration owner, or workflow approver?"

Do not allow ambiguous terminology to survive.

---

# Cross-Reference With Reality

When the user describes behavior:
- verify whether the existing system already behaves differently
- inspect workflows if necessary
- surface contradictions explicitly

Example:
> "You mentioned partial approvals are allowed, but the current workflow finalizes the entire review together. Which behavior should be authoritative?"

Treat the current product behavior as an important input - but not necessarily the correct future behavior.

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
