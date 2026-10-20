---
name: weave-questions
description: Turn the active Weave change request into a short list of current-state research questions in questions.md. Use at the start of a change, before weave-research, when the work touches existing code that needs to be understood first.
last_changed_in: 0.1.13
---

# Purpose

Write `wiki/changes/<change-id>/questions.md`: a query plan that tells `weave-research` what to find out about the system as it exists today.

This skill separates "what are we trying to do" from "how does the system work now". The questions carry the second part only, so the research that answers them stays objective.

This skill does not answer the questions, design the change, or write any other artifact.

# Resolve Context

```bash
weave workspace --json
weave change current --json
weave change status --json
```

If there is no active change, stop and say:

```text
No active Weave change found. Run `weave change new` or `weave change switch`, then run `weave-questions` again.
```

In workspace mode, `workspace.path` is the only artifact root. Registered `repos[]` are places to research, not separate artifact targets.

If `questions.md` already has substantive content, ask whether to revise it or replace it before writing.

# Inputs

Read these in full, and nothing else from the change folder:

- the user's request in this conversation
- `exploration.md` or `findings.md` for the active change, if they have substantive content
- tickets, docs, or files the user explicitly pointed to

While reading, collect every concrete pointer the user or ticket gives: links, repo names, packages and versions, file paths, commands, and domain terms. Keep them verbatim for the **Key Context Pointers** section.

# Orient Lightly

Do just enough looking around to ask well-aimed questions:

- If a codebase index such as `codebase-memory-mcp` is available, prefer it for locating code.
- If the `weave-locator` sub-agent is available, use it to find which files and folders relate to the request. Use `weave-web-researcher` only if the request names an external library or service you know nothing about.
- If sub-agents are not available in this agent, use quick `Grep`/`Glob` searches yourself.

Do not read implementation in depth. That is `weave-research`'s job.

# Write the Questions

Write 2 to 8 questions. Use fewer for small changes; go above 8 only for very large changes or when the user asks.

Good questions:

- describe the present: "how does X work", "where is Y used", "what is the contract between A and B"
- point the researcher somewhere: name the repo, folder, module, library, or doc to start from
- cover the edges that will matter: lifecycle states, permissions, error handling, configuration, and how the area is tested
- cover external dependencies when the change relies on them, including the version in use

Never:

- ask what should be built, changed, or improved
- phrase a question as "how would we…" or "how should we…"
- leak the intended change into the wording (ask "how are invoices finalised today?", not "how do we add partial finalisation?")

If the change could touch UI, always include questions about the existing design system: component library, theming, colours, typography, and spacing conventions for the affected area.

Use the structure defined in `questions-template.md` (sibling to this `SKILL.md`, at `<agent-skills-dir>/weave-questions/questions-template.md` after install). If the user has modified the template, follow their version. Fill in the timestamps and the change title.

Write the file to `wiki/changes/<change-id>/questions.md` under the resolved artifact root.

# Record Progress

Record the lane, citing what the questions were derived from:

```bash
weave change progress questions --source discussion --json
```

Add `--source exploration` when `exploration.md` informed the questions.

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

Reply with exactly this shape and nothing else:

```text
Wrote <N> research questions to wiki/changes/<change-id>/questions.md.

You don't need to answer them. They tell weave-research what to look up.

Next step: start a fresh session and run weave-research.
(A fresh session keeps the research independent of this conversation about what to build.)
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
