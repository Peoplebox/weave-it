---
id: 261108-4z8l-auto-advance-hands-phases-to-the-calling-agent
title: Auto-advance hands phases to the calling agent
status: accepted
date: 2026-11-08
owner: arpit016
applies_to:
  - src/lib/advance.ts
  - src/commands/advance.ts
  - src/lib/agent-launchers.ts
  - src/lib/agent-permissions.ts
supersedes: []
superseded_by: null
---

# Auto-advance hands phases to the calling agent

## Context

Auto-advance first started each phase as a headless `claude -p` session. It was invisible: nothing showed it running, its log stayed empty until it ended, and with nobody to approve file writes a research run did all its work and then saved nothing. It also assumed Claude, while people use Codex, opencode, pi, and others. The major agents can start a fresh sub-agent themselves, show its progress in the session, and pass its permission requests to the person.

## Decision

By default `weave advance` starts no agent. It decides, records the run, and returns a self-contained brief; the calling skill runs the phase as one fresh, foreground sub-agent with its own agent's tools, never a fork of the conversation. Weave only starts a session itself (`here`, `terminal`, `background`) when someone configured the agent: `--agent`, `advance.agent`, or an `advance.command` template. For Claude Code, agent install allows phases to write `wiki/changes/**` and run `weave` and read-only git without asking, and nothing more.

## Alternatives Rejected

- **Keep a default agent and launch it.** Wrong for anyone on another agent, and the headless session can neither be seen nor ask for approval.
- **Open a new visible terminal by default.** Visible, but it still needs an agent CLI Weave picks, does not work inside desktop apps, and splits the work across windows.
- **Run the phase inline in the calling session.** The calling session knows what is being built, which research must not see.
- **Bypass permission prompts for phase sessions.** Simple, but a phase could then edit anything; narrow allow rules keep a prompt as the signal that a phase left its job.

## Consequences

- Works with any agent that has sub-agents; others fall back to the person pasting the brief into a new session.
- Research independence now depends on the sub-agent starting with a fresh context and on the brief standing alone. Claude Code and opencode document fresh contexts; Codex does not say.
- A phase that starts its own helper sub-agents relies on nesting, which Claude Code allows three levels deep; elsewhere the skill does the helpers' work itself.
- The calling session waits while the foreground sub-agent runs.
- Permission rules are written only for Claude Code; other agents need them set by hand.

## Reconsider When

An agent Weave supports cannot start fresh sub-agents, Codex is found to fork the conversation into sub-agents, or agents gain a common way to start a separate visible session that would serve better than a sub-agent.
