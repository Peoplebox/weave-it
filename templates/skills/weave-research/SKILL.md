---
name: weave-research
description: Document how the system works today by answering the active Weave change's questions.md with read-only research sub-agents, and write an objective, cited research.md covering flows, contracts, tests, and code references. Use after weave-questions, ideally in a fresh session, or when the user asks to map or document the current code for a change. Describes what exists only, with no recommendations. Not for product brainstorming (use weave-explore) or technical design (use weave-architect).
license: MIT
compatibility: Requires the weave CLI (npm package @weave-tools/weave-it) on PATH, run inside a git repo or workspace initialised with weave init. Uses read-only research sub-agents when the agent supports them (installed for Claude Code by weave agent install).
metadata:
  author: weave-tools
  last_changed_in: "0.1.13"
---

# Purpose

Write `wiki/changes/<change-id>/research.md`: a factual map of the system as it exists today, answering the questions in `questions.md`.

Your only job is to document what exists, where it lives, how it works, and how it is tested. Do not suggest improvements, critique the code, find root causes, or propose designs unless the user explicitly asks. Later lanes (`weave-explore`, `weave-prd`, `weave-architect`) make decisions; they rely on this document being objective.

# Resolve Context

```bash
weave workspace --json
weave change current --json
weave change status --json
```

If there is no active change, stop and say:

```text
No active Weave change found. Run `weave change new` or `weave change switch`, then run `weave-research` again.
```

In workspace mode, `workspace.path` is the only artifact root. Registered `repos[]` are places to research, not separate artifact targets.

# Read the Questions, and Only the Questions

Read `wiki/changes/<change-id>/questions.md` in full. It is the research brief.

Do not read `exploration.md`, `prd.md`, `findings.md`, `architecture/`, `sessions/`, or tickets for the change unless the user explicitly asks. Those describe what the change wants; reading them pulls the research toward the planned answer.

If `questions.md` is missing or empty:

- If the user gave research questions in this conversation, use those and record them in the **Summary** of `research.md`.
- Otherwise stop and say: `No research questions found. Run weave-questions first, or tell me what to research.`

Current-state knowledge is fair game: `wiki/knowledge/`, repo docs, ADRs, and the code and tests themselves.

# Plan the Research

Break the questions into 2 to 6 research areas. Group questions that touch the same part of the system into one area rather than giving each question its own agent. Note which repos or folders each area covers, starting from the **Key Context Pointers** in `questions.md`.

# Run Sub-Agents

If a codebase index such as `codebase-memory-mcp` is available, prefer it for locating symbols and tracing calls, then confirm against the source.

When the sub-agents below are available, use them and run independent areas in parallel:

| Sub-agent | Use it to |
| --- | --- |
| `weave-locator` | find which files, tests, and docs belong to an area. Run first. |
| `weave-analyzer` | explain how the located code works, with citations. Run on the most relevant files. |
| `weave-pattern-finder` | collect existing examples of a convention later lanes will need to follow. |
| `weave-web-researcher` | answer questions about external libraries or services. Pass the version the project uses, and ask for source links. |

Tell each sub-agent what to find, not how to search; they already know their job. Use only these research sub-agents, not general-purpose ones.

If sub-agents are not available in this agent, work through the same roles yourself in order: locate, then analyze, then collect patterns, then check external docs.

Wait for every sub-agent to finish before writing. Verify the claims you will rely on most by reading the cited code yourself.

# Write research.md

Use the structure in `research-template.md` (sibling to this `SKILL.md`, at `<agent-skills-dir>/weave-research/research-template.md` after install). If the user has modified the template, follow their version.

Write it as an explanation someone could learn the system from, not a list of answers:

- **Headers state the finding.** "Change status lives in status.yml and only the CLI writes it", not "Status storage" and not the question restated.
- **Concept first, then citation.** Say what something does, then cite where (`path:line`, or `path:start-end` for adjacent facts).
- **Show structure.** Use a call tree, file tree, table, mermaid diagram, signature, or short pseudocode wherever it is faster than prose, placed beside the text it supports.
- **Every area says how it is tested**, or that it is not tested.
- **Code References** should let a developer navigate the whole researched area. Say which groups are exhaustive.
- Fill in `git_commit` and `branch` for each researched repo. Never leave template placeholders in the written file.

Write the file to `wiki/changes/<change-id>/research.md` under the resolved artifact root.

# Close Open Questions Once

If the document has open questions, run one more targeted round of sub-agents to answer them. Update the relevant sections in place and remove questions that now have answers. Do not do a third round; leave what remains under **Open Questions**.

# Record Progress

```bash
weave change progress research --source questions --source codebase --json
```

Drop `--source questions` only if you worked from questions given in the conversation instead of `questions.md`.

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

Reply with exactly this shape and nothing else. Include the open-questions paragraph only when open questions remain.

```text
Research is in wiki/changes/<change-id>/research.md.

Review it for accuracy before decisions build on it. You can ask for more research on anything that looks thin.

There are <N> open questions. You can ask me to look for answers, answer them yourself, or tell me to drop them.

Next step: <next skill>
Auto-advance will not start it: <next skill> needs your decisions, so start it yourself in a fresh session.
```

Choose `<next skill>` from the change type in `weave change status --json`:

- `feat`: `weave-explore` to work through product behaviour, or `weave-prd` if the requirements are already clear.
- any other type: `weave-architect` for diagnosis and technical design.

Auto-advance never starts `weave-explore`, `weave-architect`, `weave-stress-test`, or anything after them, so do not run `weave advance` from this skill.

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
