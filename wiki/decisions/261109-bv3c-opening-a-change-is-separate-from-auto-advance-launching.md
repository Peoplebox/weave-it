---
id: 261109-bv3c-opening-a-change-is-separate-from-auto-advance-launching
title: Opening a change is separate from auto-advance launching
status: accepted
date: 2026-11-09
owner: arpit016
change: 261109-479a-open-worktree-when-created
applies_to:
  - src/lib/open-places.ts
  - src/lib/terminal-launch.ts
  - src/lib/advance.ts
  - src/lib/agent-launchers.ts
supersedes: []
superseded_by: null
---


# Opening a change is separate from auto-advance launching

## Context

Decision `261108-4z8l` keeps auto-advance hand-offs inside the calling agent by default and rejected "open a new visible terminal by default" for them. Decision `261109-mn61` now has Weave open visible terminals and apps when a change is created or switched to. Both use terminal openers and agent command lines, so it is tempting to share one setting or one code path. That would make the two rules drift into each other.

## Decision

Opening a change and launching an auto-advanced phase are separate features with separate settings. Opening uses the person's personal default (`~/.weave/settings.yml`) and the new place registry (`src/lib/open-places.ts`), with **its own argv-based open functions**. These take a resolved executable path, open tmux in the foreground, and keep a login shell after the agent exits. Auto-advance keeps `.weave/workspace.yml` `advance.*`, `terminalOpeners`, `findTerminalOpener`'s first-available order, and its own launchers, all unchanged. The two share only the quoting helpers (`shellQuote` and the AppleScript string escaping).

## Alternatives Rejected

- **Move `weave advance` onto the new registry.** One code path, but it changes hand-off behaviour (opener order, availability rules), which `261108-4z8l` settled.
- **Share and extend the existing open functions.** The two features want opposite behaviour from the same terminal: advance runs detached and wraps the agent to record the run, while opening takes the person there and keeps a shell. Sharing them would need mode flags, and would change advance's code path.
- **Let the opening default also choose the hand-off agent.** It would open visible sessions for hand-offs because of a choice the person made for something else.

## Consequences

- Opening a visible session for a change does not contradict `261108-4z8l`. It needs an explicit personal choice and is not a phase hand-off.
- There are two agent settings: personal for opening, project-level for hand-offs. The docs must say they are independent.
- Similar opener code exists in two places (about 40 lines). This is accepted to keep hand-offs untouched. Folding advance onto the new functions later would be its own change, with its own record.
- Only the quoting helpers are shared. A change to them affects both features and is covered by both features' tests.

## Reconsider When

People expect the hand-off agent and the opening agent to be the same, or `261108-4z8l`'s "common way to start a separate visible session" condition is met.
