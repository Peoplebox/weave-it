---
id: 261111-7orw-auto-advance-hands-phases-to-the-calling-agent-and-phases-save-their-stage-through-weave
title: Auto-advance hands phases to the calling agent, and phases save their stage through Weave
status: accepted
date: 2026-11-11
owner: arpit016
change: 261111-kdv6-commit-checkpoints
applies_to:
  - src/lib/advance.ts
  - src/commands/advance.ts
  - src/lib/agent-launchers.ts
  - src/lib/agent-permissions.ts
supersedes:
  - 261108-4z8l-auto-advance-hands-phases-to-the-calling-agent
superseded_by: null
---

# Auto-advance hands phases to the calling agent, and phases save their stage through Weave

## Context

Decision `261108-4z8l` stands as written for how phases are launched. It also said Claude Code phases may write `wiki/changes/**` and run `weave` and read-only git "and nothing more". Change `261111-kdv6-commit-checkpoints` makes Weave's recording commands commit (decision `261111-htho`), so an unattended phase that records its stage now moves the change branch forward with no person present. The product shape accepted this deliberately; the old wording no longer describes what happens.

## Decision

By default `weave advance` starts no agent. It decides, records the run, and returns a self-contained brief; the calling skill runs the phase as one fresh, foreground sub-agent with its own agent's tools, never a fork of the conversation. Weave only starts a session itself (`here`, `terminal`, `background`) when someone configured the agent: `--agent`, `advance.agent`, or an `advance.command` template. For Claude Code, agent install allows phases to write `wiki/changes/**` and run `weave` and read-only git without asking, and nothing more. Recording a stage through `weave` makes a planning commit on the change branch with every project hook disabled; a phase gains no other way to write git history. Sessions Weave launches itself set `WEAVE_UNATTENDED=1`, and code checkpoints (build and fix commits) refuse under it. A failed planning commit is recorded on the run so the next person sees it.

## Alternatives Rejected

- **Keep the old wording:** it would misdescribe unattended runs that now commit.
- **Give phases `git commit` permission:** broad, agent-specific, and lets a phase commit anything.
- **Leave unattended output uncommitted until a person returns:** recreates the lost-planning gap.
- (From `261108-4z8l`.) Default agent launch, a new visible terminal by default, running inline in the calling session, and bypassing permission prompts.

## Consequences

- Unattended research and PRD runs are saved to history without any new permission rule.
- The handoff brief's "leave the rest of the project as you found it" stays true for the phase; Weave's commit is the only history change.
- All consequences of `261108-4z8l` carry over.

## Reconsider When

An agent Weave supports cannot start fresh sub-agents, Codex is found to fork the conversation into sub-agents, agents gain a common way to start a separate visible session, unattended phases need to write outside the change folder, or a supported unattended phase needs code commits (handoff sub-agents carry no unattended marker).
