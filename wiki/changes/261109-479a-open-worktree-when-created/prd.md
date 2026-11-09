---
artifact: prd
status: draft
owner: product
created_at: 2026-11-09T14:48:36.000Z
updated_at: 2026-11-09T21:08:49.716Z
reviewed_at: null
approved_at: null
approved_by: null
source: exploration.md
---

# Open Worktree When Created PRD

## Problem Statement

People whose projects use change folders (each change gets its own separate folder next to the main project) create a change and are then told only where its folder is. To start work they have to open a new terminal tab or editor window themselves, go to that folder, start their agent, and remember which step to run first.

The same chore repeats every time they switch to a change: resuming their own, opening a teammate's pushed change, or recreating a folder that went missing. It costs time at the moment they most want to get going, and it is easy to get wrong. A common mistake is to carry on in the old session, whose files are not the change's files.

Most changes are created through an agent's guided "start a change" flow. Today the agent can only repeat the instruction to open the folder elsewhere, so the person has to stop and do it themselves.

## Goals

- Creating or switching to a change in a project with change folders takes the person into that change's folder, in the place they chose, without manual steps.
- The person chooses explicitly where changes open. Weave never opens a place or starts an agent they did not pick.
- The choice is asked at the moment it is needed. The person decides each time whether it applies just this once or becomes their personal default. Once it is the default, opening costs nothing.
- The same experience for every supported agent and app, not one that works best in a single agent.
- Where the chosen tool supports it, the new session starts with the change's next step filled in but not sent.
- Opening is a convenience. It never blocks, undoes, or changes creating or switching to a change, and nobody is left stranded when it fails.
- Anyone who prefers today's behaviour can get it back with a single answer.

## Non-Goals

- Moving the current agent session into the change folder, even where the agent supports it (Claude Code). Not offered in this change.
- Opening changes from the "fix a bug" flow. That flow keeps today's behaviour.
- Changing how automatic phase hand-offs choose and start agents. They keep their own project setting and rules.
- Discovering tools at run time or guessing which tool the person is using.
- Letting people add new places or apps beyond the fixed list.
- Running or approving a change folder's setup commands as part of opening.
- Any change for projects that switch branches in place (no change folders).
- Agents creating their own worktrees for a change. Weave keeps creating change folders itself.

## Actors

- **Person at a terminal:** runs `weave change new` or `weave change switch` directly.
- **Agent in a guided flow:** an agent (Claude, Codex, opencode, Cursor's agent, and others) that creates or switches to a change on the person's behalf through Weave's guided "start a change" flow or similar, and talks to the person in chat.
- **Script or CI job:** runs the same commands with nobody to ask.
- **Weave:** creates or switches to the change, decides whether and where to open it, opens it, and reports the result.
- **Places:** the terminals (herdr, tmux, iTerm, Terminal) and apps (VS Code, Cursor, the Claude desktop app, T3 Code) where a change can be opened.
- **Agents to start:** Claude, Codex, opencode, Cursor's agent, and any agents the person adds themselves.

## Current Behavior

- Creating a change in a project with change folders builds the change's folder next to the main project and ends with one line: "Open <folder> in a new session to work on this change." Nothing is opened.
- Switching to an existing change (your own, a teammate's pushed change, or a deleted folder being recreated) prints the same line.
- The guided "start a change" and "fix a bug" flows, the "what's next" helper, the README, and the help pages all tell the person to open the folder themselves. The recorded decision that gives each change its own folder says so too, reasoning that an agent session cannot move itself into another folder.
- That reasoning holds for most agents but not all: Claude Code can move its current session into an existing folder. Codex, Cursor's agent, opencode, and pi cannot, as far as is known. Weave does not use Claude's ability today.
- Weave can already open a new herdr tab, tmux window, iTerm window, or Terminal window and start Claude in it, but only for automatic hand-offs between workflow phases, and only when someone has configured an agent for the project. A recorded decision rejected opening a new visible window by default for those hand-offs.
- Weave knows which agents have its skills installed in a project, but nothing records which tool a person prefers. There is no setting for a preferred terminal, editor, or app.
- Projects that switch branches in place have no new folder to go to.

**Workaround today:** the person copies the printed folder, opens a terminal tab or editor window there by hand, starts their agent, and types the next step themselves.

## Proposed Product Behavior

When a person creates or switches to a change in a project that uses change folders, Weave opens that change's folder in the place they chose.

### Choosing where (just this once, or make it the default)

The choice has up to three steps.

1. **Where to open:**
   - **A terminal:** herdr tab, tmux window, iTerm window, or Terminal window.
   - **An app:** VS Code, Cursor, the Claude desktop app, or T3 Code.
   - **Don't open:** just show the folder, as today. This can be saved as "don't ask again".
2. **What to start (terminals only):** Claude, Codex, opencode, Cursor's agent, any of the person's own agents, or just a shell. Apps (VS Code, Cursor, the Claude desktop app, T3 Code) bring their own agent or editor, so they never get this step.
3. **Just this once, or make it my default:**
   - **Just this once:** the change opens there, nothing is saved, and the person is asked again next time.
   - **Make it my default:** the change opens there and the choice is saved as the person's default.
   - For "Don't open" the pair is **just this once** (show the folder this time; ask again next time) or **don't ask again** (save "don't open" as the default, which restores today's behaviour).

Only "make it my default" (or "don't ask again") saves anything. Weave's settings command (`weave settings open`) still sets a default directly, without the third question.

### Which choices are offered

- Weave ships a fixed list of supported places and agents: four terminals, four agents, and four apps. Each has a fixed check: its known command name and its usual install locations. Weave looks only there and never scans or guesses, so the same machine always shows the same menu. Supporting a new tool requires a Weave update.
- Agents and apps are offered when found by their command or in their usual install location.
- VS Code is always found through its own install location, never through the shared `code` command, because Cursor can take that command over.
- herdr and tmux are offered only when installed **and** the person is currently working inside them, because the new tab opens next to where they are.
- iTerm and Terminal are offered on a Mac.
- Places Weave cannot fully check, or cannot fully open, are still offered with a short hint, for example "T3 Code (add the folder as a project there)".
- On Linux the menu offers herdr and tmux (when the person is inside them), plus VS Code, Cursor, and T3 Code when found. The Claude desktop app, iTerm, and Terminal are Mac-only.
- **The person's own agents:** in personal settings a person can add agents that are not on the list (for example pi) as a name plus the command that starts it. These appear in step two without being checked, and Weave never fills in a first step for them.
- Personal settings can also point a listed tool at an unusual install location. They cannot add new places or apps.

### Who asks

- A person running the command at a terminal sees the menu there.
- When an agent creates or switches to a change through a guided flow, the agent asks in the chat with the same choices and passes the answer to Weave: where to open; then, only for a terminal, what to start (never for an app); then "just this once, or make it your default?" (for "don't open": "just this once, or don't ask again?"). The agent asks Weave to save the choice only when the person picked "make it my default" or "don't ask again".
- When there is no saved default and nobody can be asked (a script, or an older guided flow), nothing opens and today's folder message is shown.

### The default

- Set only when the person says so: by answering "make it my default" (or "don't ask again" for "don't open") at the terminal menu or in chat, through the settings command, or by editing the personal settings file. A "just this once" answer never sets or changes it.
- Personal to the person and their machine, applies across all their projects, and never shared through the project.
- A per-project override is allowed (for example "in this project, open in Cursor").
- Once set, it is used without asking on **every** create or switch, whoever runs the command: a person, an agent, or a script. Weave says what it opened and how to change the default.
- A different choice can be made for a single change, without changing the default: by telling the agent ("don't open this one", "open this one in Cursor"), or with an option on the command when typing it at a terminal.
- The default can be changed later through a Weave settings command that shows the same menu again (and saves the answer directly), by answering "make it my default" to a later menu, or by editing the personal settings file.
- Once a default is set, the menu comes back only when the default's app or command is gone (for example uninstalled). A one-off failure, such as T3 Code not opening the folder this time, keeps the default.
- The default covers only opening changes. Automatic phase hand-offs keep their own project setting and rules. The two are independent and documented as such.

### What the new session starts with

- Where the chosen tool can hold a first message as an unsent draft, the session opens with the change's next step filled in but **not sent**, so the person can read or edit it and add context before starting.
  - For a new change, the next step is its first step.
  - For a switched-to change, it is whatever "what's next" would recommend.
- Where the tool can only start with a message already sent, or cannot take one at all, the session opens empty in the folder and the step is shown in the original session for the person to type or paste.
- Checked by hand on 2026-11-10:
  - **Claude desktop app:** holds the first message unsent. It is the only place that gets the step filled in.
  - **herdr:** its first message is sent automatically, so a herdr tab opens empty and the step is shown.
  - **Codex, opencode, Cursor's agent:** not verified, so they open empty and the step is shown. A tool is marked as holding an unsent draft only after it has been checked by hand.
  - VS Code, Cursor, and T3 Code cannot take a first message at all.
- Weave never starts an agent the person did not choose and never runs a step automatically.

### Switching to a change that may already be open

- Already inside that change's folder: nothing opens. The next step is shown.
- Already open in a tmux window or herdr tab that Weave can recognise as sitting in the change folder: that tab is brought forward instead of opening a new one. herdr can list its open terminals with their folders, so it behaves exactly like tmux here. The session Weave was run from is never the one brought forward.
- Already open somewhere Weave cannot recognise (other terminals, apps): a new one opens anyway. A duplicate session is a known limitation.
- Folder recreated after it went missing: it opens as normal.

### After opening

- The original session says where the change was opened and that work continues there. It always includes the fallback: the folder and the next step, in case the new session did not start.
- The original session no longer edits the change's files, but it can still help the person reopen the change ("open it again", "open it in Cursor instead"), which switches to the change again.
- Setup commands for the new folder (such as installing dependencies) are never run or approved as part of opening. They still need the person's approval at a terminal, as today.

### If opening fails

- The change is still created or switched to. Opening never blocks or undoes it.
- Weave says in one line what went wrong and falls back to today's message: the folder and the step to run there.
- Weave does not watch whether the opened session actually started. The fallback in the original session's message covers that.
- When the person is connected over SSH, Mac terminal windows and apps are skipped, because they would appear on a screen the person cannot see. Weave shows the folder and step and says why. herdr and tmux tabs on the remote machine still open.

### Known limitations

- **T3 Code cannot be told to open a folder from outside.** Its `t3code://` links only handle device pairing. When T3 Code is chosen, Weave brings the app to the front and reports that it couldn't open the folder, with the hint to add the folder as a project there, plus the folder and step. This counts as a one-off failure, so a T3 Code default is kept. Whether T3 Code should stay on the list is an open product question.
- **Cursor run from outside Cursor (Cursor 3.21):** when Weave runs from outside Cursor (for example from a terminal), Cursor may open its Agents window instead of a window on the change folder. When Weave runs from inside Cursor (for example from Cursor's agent), the folder opens correctly. Tracked as QA finding QF1 in slice 04 (app places).

## User Workflows

### Workflow: Person creates their first change after upgrading (through an agent)

1. The person, working inside herdr with Claude, asks the agent to start a change.
2. Weave creates the change and its folder.
3. There is no saved default, so the agent asks in chat: open it in a terminal (herdr, iTerm, Terminal), an app (VS Code, Cursor, Claude desktop), or don't open.
4. The person picks herdr, then Claude, then "make it my default".
5. Weave opens a new herdr tab in the change folder with Claude started. herdr sends a first message automatically, so the tab opens empty and the original session shows the step to paste.
6. Weave saves herdr + Claude as the person's default. Had the person picked "just this once", nothing would be saved and the agent would ask again on the next create or switch.
7. The original session says "Opened in a new herdr tab with Claude, continue there", gives the folder and step as a fallback, and stops editing the change.

### Workflow: Person creates a change with a saved default

1. The person (or their agent) creates another change.
2. Weave opens it straight away in the default place with the default agent. No question is asked.
3. Weave says what it opened, gives the folder and step as a fallback, and says how to change the default.

### Workflow: Person at a terminal with no default

1. The person runs the create or switch command at a terminal.
2. Weave creates or switches to the change, then shows the menu in the terminal.
3. The person picks a place (and, for a terminal, an agent), or "don't open".
4. The person picks "just this once" or "make it my default" (for "don't open": "just this once" or "don't ask again").
5. Weave opens the change there (or shows the folder). It saves the answer as the default only for "make it my default" or "don't ask again"; after "just this once" the menu is shown again next time.

### Workflow: One-off exception

1. The person has a saved default but wants something different for one change.
2. In chat they tell the agent "don't open this one" or "open this one in Cursor"; at a terminal they use the command's option for the same effect.
3. Weave follows the one-off choice. The default is unchanged.

### Workflow: Switching to a change

1. The person switches to a change (their own, a teammate's pushed change, or one whose folder went missing).
2. If they are already inside that change's folder, nothing opens and the next step is shown.
3. If a tmux window or herdr tab Weave can recognise is already sitting in the folder, it is brought forward.
4. Otherwise Weave opens the change in the default place, with the "what's next" step as an unsent draft where supported.

### Workflow: Opening fails or nothing usable starts

1. Weave tries to open the change and fails (for example the app isn't running), or a window opens but the person cancels it.
2. The change is created or switched to regardless.
3. On failure Weave prints one line saying what went wrong, plus the folder and step.
4. The person returns to the original session, which still shows the folder and step, and can ask it to "open it again" or "open it in Cursor instead".

### Workflow: Default tool is gone

1. The person's default app or command has been uninstalled.
2. On the next create or switch, the change is still created, Weave explains the tool isn't available, and the menu is shown again (or, with nobody to ask, today's folder message is shown).

### Workflow: Changing the default later

1. The person runs Weave's settings command, which shows the same menu and saves the answer directly, answers "make it my default" to a later menu, or edits their personal settings file.
2. The new answer replaces the default. A per-project override can be set the same way.

### Workflow: Adding their own agent

1. The person adds an agent that is not on the list (for example pi) to personal settings as a name plus its start command.
2. The agent appears in step two of the menu for terminals.
3. Changes open in the chosen terminal running that agent, with the step shown in the original session to paste.

## User Stories

1. As a person using change folders, I want a new change to open in my chosen place automatically, so that I can start working without opening a tab and navigating there myself.
2. As a person using change folders, I want switching to a change to open it the same way, so that resuming my own or a teammate's change is just as quick.
3. As a first-time user after upgrading, I want to be asked where changes should open, so that I choose explicitly and never get windows I didn't ask for.
4. As a person choosing a terminal, I want to pick which agent starts in it (or just a shell), so that the new session matches how I work.
5. As a person working through an agent, I want the agent to ask me in chat with the same choices, so that I can answer without leaving the conversation.
6. As a person with a saved default, I want it used without asking every time, so that opening costs nothing once I've made a choice my default.
7. As a person with a saved default, I want to skip opening or pick a different place for a single change, so that throwaway or unusual changes don't need a settings change.
8. As a person who likes today's behaviour, I want "don't open, don't ask again", so that I keep seeing just the folder.
9. As a person, I want to change my default later through a settings command or by editing my settings file, so that I can follow changes in my tools.
10. As a person who uses a different tool in one project, I want a per-project override, so that the project opens where it makes sense.
11. As a person, I want the next step filled in but not sent where my tool supports it, so that I can read or edit it and add context before starting.
12. As a person whose tool cannot hold a draft, I want the step shown in the original session, so that I know what to type or paste.
13. As a person, I want Weave never to start an agent I didn't choose or run a step on its own, so that nothing happens without me.
14. As a person switching to a change I'm already in, I want nothing new to open, so that I don't get a duplicate session.
15. As a person switching to a change already open in a recognisable tmux or herdr tab, I want that tab brought forward, so that I don't end up with two.
16. As a person whose opening failed, I want the change still created and a one-line explanation with the folder and step, so that I can carry on by hand.
17. As a person whose new window opened but nothing usable started, I want the original session to still show the folder and step and to reopen it on request, so that I'm never stranded.
18. As a person whose default tool is temporarily unavailable, I want my default kept, so that a one-off problem doesn't wipe my choice.
19. As a person whose default tool was uninstalled, I want the menu shown again, so that I can pick something that works.
20. As a person connected over SSH, I want Weave to skip Mac windows and apps and say why, so that nothing opens on a screen I can't see.
21. As a person who uses an agent Weave doesn't list, I want to add it with its start command, so that I can still pick it.
22. As a person with a tool in an unusual install location, I want to point Weave at it, so that it is still offered.
23. As a person running a script with a saved default, I want each created change to open as usual, so that behaviour is the same whoever runs the command.
24. As a CI job with no saved default, I want nothing asked and nothing opened, so that the output stays exactly as today.
25. As a person on Linux, I want the menu to offer only what works there, so that I'm not shown Mac-only choices.
26. As a person in a project that switches branches in place, I want no menu, so that nothing changes for me.
27. As a person whose installed guided flows are older than Weave, I want nothing to break, so that I can update the flows when convenient.
28. As a person, I want setup commands for the new folder never run or approved by opening, so that setup approval stays with me at a terminal.
29. As a person trying out a place, I want to choose "just this once" or "make it my default" after picking it, so that trying something does not quietly become my default.
30. As a person choosing an app, I want no question about which agent to start, so that I'm only asked what matters for that app.

## Functional Requirements

### Scope of opening

- The system should consider opening only when a change is created or switched to in a project that uses change folders.
- The system should never show the menu or open anything in a project that switches branches in place.
- The "fix a bug" flow should tell Weave not to open its change, and should keep today's behaviour of showing the folder after writing its files.

### The menu

- The system should offer a choice of a place (a terminal, an app, or don't open), then, for terminals only, what to start (a listed agent, one of the person's own agents, or just a shell), then whether the choice is "just this once" or "make it my default" (for "don't open": "just this once" or "don't ask again").
- The system should never ask what to start for an app (VS Code, Cursor, the Claude desktop app, T3 Code), at the terminal menu or in chat.
- The system should offer only places and agents from Weave's fixed supported list, plus agents the person added in personal settings.
- The system should decide whether to offer each listed tool only by checking its known command name and usual install locations (or a location set in personal settings), never by scanning or guessing.
- The system should show the same menu on the same machine in the same situation every time.
- The system should find VS Code only through its own install location, never through the shared `code` command.
- The system should offer herdr and tmux only when they are installed and the person is currently working inside them.
- The system should offer iTerm, Terminal, and the Claude desktop app only on a Mac.
- The system should offer places it cannot fully check or fully open with a short hint about what they need (for example "T3 Code (add the folder as a project there)").
- The system should list the person's own agents in step two without checking them.
- The system should offer "don't open" with the choice of "just this once" or "don't ask again".

### Asking and the default

- The system should show the menu at the terminal when a person runs the command there and there is no default.
- The system should let a guided-flow agent ask the person in chat with the same choices (including "just this once" or "make it my default") and pass the answer to Weave, asking Weave to save it only when the person chose to make it the default.
- The system should open nothing and show today's folder message when there is no default and nobody can be asked.
- The system should save the person's answer as their default only when they choose "make it my default" (or "don't ask again"), personal to them and their machine, applying across all their projects.
- The system should open without saving anything when the person chooses "just this once", and ask again on the next create or switch.
- The system should never store the default, or the per-project override, in the project's shared files.
- The system should allow a per-project override of the default.
- The system should use the default without asking on every create or switch, whoever runs the command (person, agent, or script).
- The system should let the person make a one-off choice for a single change (don't open, or open elsewhere), in chat through the agent or with an option on the command, without changing the default.
- The system should provide a settings command that shows the same menu and saves the answer directly as the default (without the "just this once" question), and should honour edits made directly to the personal settings file.
- Once a default is set, the system should show the menu again only when the default's app or command is gone, and should keep the default after a one-off failure.
- The system should keep the default for opening changes independent of the project's automatic phase hand-off settings.

### Opening the session

- The system should open the change's folder in the chosen place and, for terminals, start only the chosen agent or a shell.
- The system should never start an agent the person did not choose and never run a step automatically.
- Where the chosen tool can hold a first message as an unsent draft, the system should fill in the change's next step without sending it: the first step for a new change, or the "what's next" recommendation for a switched-to change.
- Where the tool cannot hold an unsent draft, the system should open the session empty in the folder and show the step in the original session.
- The system should treat a tool as holding an unsent draft only after it has been checked by hand. As of 2026-11-10 that is the Claude desktop app only.
- If opening with a draft fails, the system should try once more without it and show the step in the original session.
- The system should never fill in a first step for the person's own agents.
- The system should never run or approve a change folder's setup commands as part of opening.

### Switching to an already-open change

- The system should open nothing and show the next step when the switch is run from inside that change's folder.
- The system should bring forward a tmux window or herdr tab it can recognise as sitting in the change folder instead of opening a new one, never choosing the session the command was run from.
- The system should open a new session when the change may be open somewhere it cannot recognise.
- The system should open a recreated folder as normal.

### Reporting and failure

- The system should tell the original session where the change was opened and that work continues there, and always include the folder and the next step as a fallback.
- The system should say how to change the default whenever it opens using a saved default.
- The original session (agent) should stop editing the change's files after opening, but should still be able to reopen the change on request, which switches to it again.
- The system should never let a failure to open block or undo creating or switching to the change.
- The system should report an opening failure in one line and fall back to today's message: the folder and the step to run there.
- The system should not watch whether the opened session actually started.
- When the person is connected over SSH, the system should skip Mac terminal windows and apps, say why, and show the folder and step, while still opening herdr and tmux tabs on the remote machine.

### Personal settings

- The user should be able to add their own agents as a name plus the command that starts it.
- The user should be able to point a listed tool at an unusual install location.
- The system should prevent personal settings from adding new places or apps.

### Guidance and documentation

- The guided "start a change" flow, the "what's next" helper, the README, the help pages, and the knowledge wiki should describe the new behaviour instead of telling every person to open the folder themselves.
- The documentation should state that the opening default and automatic phase hand-offs are independent.

## Permissions and Access Control

- The default, the per-project override, the person's own agents, and custom install locations are personal to the person and their machine. They are not shared with teammates and are never committed to the project.
- Only the person (directly, or through their agent in chat) chooses where changes open. Weave never picks a place or agent on their behalf.
- An agent can pass a choice or a one-off override only on the person's instruction or by passing on their answer to the menu.
- Opening never grants or bypasses setup approval. Setup commands from the project still require a person's approval at an interactive terminal, as today.
- Opening does not change who can create, switch to, or close changes.

## States and Lifecycle

### The opening default (per person and machine, optionally per project)

| State | Meaning | Behaviour on create or switch |
| --- | --- | --- |
| Unset | No default saved | Ask (terminal menu or agent in chat). If nobody can be asked, open nothing and show today's message. |
| Set to a place (+ agent for terminals) | A saved choice | Open there without asking. |
| Set to "don't open, don't ask again" | Today's behaviour chosen | Show the folder message. Never ask. |

Transitions:

- Unset → Set: the person answers the menu (terminal or chat) with a place and "make it my default", or with "don't open" and "don't ask again"; or uses the settings command; or edits the personal settings file.
- Unset → Unset: the person answers "just this once" (with a place or with "don't open"). The change opens (or not) as chosen, nothing is saved, and the menu is shown next time.
- Set → Set (different value): the person uses the settings command, edits the personal settings file, or answers "make it my default" to a menu shown because the default's tool is gone.
- Set → Unset (menu shown again): the default's app or command is found to be gone.
- A one-off failure (tool temporarily unavailable, window cancelled) does not change the state.
- A one-off choice for a single change does not change the state.
- A per-project override, when present, takes precedence over the personal default for that project.

### An opening attempt

`not attempted` (in-place project, fix flow, already inside the folder, one-off "don't open", or no default and nobody to ask) → `brought forward` (recognisable tmux or herdr tab already in the folder) or `opened` or `skipped` (over SSH for Mac places) or `failed`. In every outcome the change itself is created or switched to, and the original session shows the folder and next step.

## Notifications and Visibility

All feedback appears in the session that created or switched to the change (terminal output, or the agent's chat).

- **Opened:** where it opened (for example "Opened in a new herdr tab with Claude, continue there"), the folder and next step as a fallback, and how to change the default when a saved default was used.
- **Brought forward:** that the existing tab was brought forward, plus the next step.
- **Already inside the folder:** the next step only.
- **Not opened (no default, nobody to ask; or "don't open"):** today's folder message.
- **Failed:** one line saying what went wrong, then the folder and step to run there.
- **Skipped over SSH:** why nothing opened, then the folder and step.
- **Default tool gone:** that the tool isn't available, then the menu (or today's message when nobody can be asked).
- **Hints in the menu:** short notes for places Weave cannot fully check (for example "add the folder as a project there" for T3 Code).
- No email, Slack, or other external notifications.

## Edge Cases

- **Script with a saved default:** every create or switch opens a session, so a batch of five changes opens five tabs. Accepted.
- **Script or CI with no default:** nothing asked, nothing opened, output unchanged from today.
- **Default temporarily unavailable** (for example herdr chosen but the person is not inside herdr this time): opening fails, the change is created, Weave says what it needs and shows the folder and step, and the default is kept.
- **T3 Code chosen:** Weave brings T3 Code to the front but cannot open the folder in it, so it reports the failure with the hint to add the folder as a project there, plus the folder and step. The default is kept.
- **Cursor chosen, Weave run from outside Cursor:** Cursor 3.21 may open its Agents window instead of the folder (QA finding QF1). Run from inside Cursor, the folder opens correctly. Known limitation.
- **"Just this once" answered:** the change opens as chosen and the menu is shown again next time. Nothing is saved.
- **Default tool uninstalled:** the change is created, Weave explains, and the menu is shown again.
- **Window opened but nothing usable started** (for example the Claude desktop app's folder confirmation was cancelled, or Cursor showed its Agents window): Weave does not notice. The original session still shows the folder and step and can reopen the change on request.
- **Already inside the change folder when switching:** nothing opens; the next step is shown.
- **Change already open in a recognisable tmux or herdr tab:** that tab is brought forward.
- **Change already open somewhere unrecognisable:** a new session opens; a duplicate is a known limitation.
- **Folder recreated after going missing:** opens as normal.
- **Connected over SSH:** Mac terminal windows and apps are skipped with an explanation; herdr and tmux still open on the remote machine.
- **Linux:** only herdr and tmux (when inside them), VS Code, Cursor, and T3 Code (when found) are offered.
- **Cursor has taken over the `code` command:** VS Code is still found only through its own install location, so choosing VS Code never opens Cursor.
- **Person's own agent:** listed without checking; if its command doesn't work, the usual failure rule applies. No first step is filled in.
- **Older installed guided flows:** with a saved default the change opens, and the old flow's "open the folder" instruction is redundant but harmless. Without a default, nothing opens and today's message is shown. Weave's existing out-of-date notice prompts an update.
- **Project switches branches in place:** no menu, nothing opens.
- **"Fix a bug" flow:** asks Weave not to open its change; it shows the folder after writing its files, as today.
- **Setup commands configured for the folder:** never run or approved by opening.
- **Original session after opening:** stops editing the change's files, but can reopen the change ("open it again", "open it in Cursor instead").

## Acceptance Criteria

- [ ] In a project with change folders and no saved default, creating a change at a terminal shows the menu after the change is created.
- [ ] In a guided flow with no saved default, the agent asks in chat with the same choices and the change opens where the person chose.
- [ ] After picking a place (and, for a terminal, an agent), the person is asked "just this once" or "make it my default", at the terminal and in chat.
- [ ] An answer with "make it my default" becomes their default and is used without asking on later creates and switches, across their projects on that machine.
- [ ] An answer with "just this once" opens the change as chosen, saves nothing, and the menu is shown again next time.
- [ ] Choosing "don't open" and "don't ask again" restores today's folder message permanently; "don't open" with "just this once" asks again next time.
- [ ] The settings command saves its answer as the default without asking "just this once".
- [ ] Step two appears only for terminals and lists the found listed agents, the person's own agents, and "just a shell". Apps never get it, at the terminal or in chat.
- [ ] Only tools from the fixed list (plus the person's own agents) are offered, each based on its known command or usual install location; the same machine shows the same menu.
- [ ] herdr and tmux are offered only when installed and the person is inside them.
- [ ] VS Code is never reached through the `code` command.
- [ ] On Linux, iTerm, Terminal, and the Claude desktop app are not offered.
- [ ] Places Weave cannot fully check are shown with a hint.
- [ ] A per-change override in chat or on the command opens elsewhere (or not at all) without changing the default.
- [ ] A per-project override applies in that project and is not written to the project's shared files.
- [ ] The settings command shows the same menu and changes the default; direct edits to the personal settings file are honoured.
- [ ] With a saved default, a script's create or switch opens a session; with no default, a script's output is unchanged from today.
- [ ] Where the tool supports an unsent draft, the new session starts with the next step filled in and not sent (first step for a new change, "what's next" step for a switched-to change).
- [ ] Where it doesn't, the session opens empty in the folder and the step is shown in the original session. As of 2026-11-10 only the Claude desktop app holds an unsent draft; herdr, Codex, opencode, and Cursor's agent open empty with the step shown.
- [ ] Weave never starts an unchosen agent and never sends or runs a step.
- [ ] Switching from inside the change folder opens nothing and shows the next step.
- [ ] Switching to a change with a recognisable tmux or herdr tab in its folder brings that tab forward (never the session the command was run from).
- [ ] Choosing T3 Code brings the app forward and reports, in one line, that the folder must be added as a project there, keeping the default.
- [ ] After opening, the original session states where the change opened and always includes the folder and next step.
- [ ] A failure to open never blocks or undoes the create or switch, and produces one line of explanation plus the folder and step.
- [ ] A temporarily unavailable default is kept; an uninstalled default brings the menu back.
- [ ] Over SSH, Mac windows and apps are skipped with an explanation; herdr and tmux still open.
- [ ] Opening never runs or approves setup commands.
- [ ] Projects that switch branches in place see no menu and no change in behaviour.
- [ ] The "fix a bug" flow does not open its change and behaves as today.
- [ ] The automatic phase hand-off settings and behaviour are unchanged by the opening default.
- [ ] The guided "start a change" flow, "what's next", README, help, and knowledge wiki describe the new behaviour.

## Rollout Considerations

- **No opt-in switch.** After upgrading, existing users see the menu on their next create or switch, and on each one after it until they make a choice their default. "Don't open" with "don't ask again" restores today's behaviour.
- **Scripts and CI:** unchanged unless the machine has a saved default.
- **Mixed versions:** projects whose installed guided flows are older than Weave keep working. With a default the change opens; without one, today's message. Weave's existing out-of-date notice prompts people to update their installed flows.
- **Recorded decisions:** the technical design should draft a record replacing the change-folder decision's "people open the folder themselves" consequence, a companion record keeping opening a chosen place separate from the auto-hand-off rule against opening visible windows, and a record for the new personal settings store.
- **Communication:** release notes and the README should explain the menu, the default, how to change it, the per-change override, and that it is independent of automatic phase hand-offs.
- **No migration or backfill.** There is no existing preference to migrate.

## Analytics and Success Metrics

Weave is a local command-line tool and is assumed to collect no usage telemetry, so success is judged qualitatively and through testing:

- People in projects with change folders stop opening change folders by hand once they have made a choice their default.
- Few people choose "don't open, don't ask again" (judged from feedback and issues).
- No reports of windows or agents appearing that the person did not choose.
- No reports of a create or switch failing because opening failed.
- Fewer cases of people continuing work in the wrong session after creating a change.
- Every supported place and agent is covered by checks that confirm it is offered, opened, and reported correctly.

## Revision History

- 2026-11-09: Initial PRD generated from `exploration.md` (stress test verdict holds-with-changes), the stress test session note, and `research.md`.
- 2026-11-10: Brought in line with what was built and decided during implementation.
  - **Saving the choice (user decision):** superseded "asked once, then remembered / the answer becomes the default". After picking a place (and, for a terminal, what to start) the person chooses "just this once" or "make it my default"; for "don't open", "just this once" or "don't ask again". Only the default answers are saved. Applies to the terminal menu and to the agent asking in chat. `weave settings open` still sets the default directly. Updated Goals, Choosing where, Who asks, The default, workflows, stories (new 29), requirements, States and Lifecycle, acceptance criteria, rollout, and assumptions.
  - **Apps:** made explicit that apps never get the "what to start" question, in chat as well (new story 30).
  - **Unsent drafts:** recorded the hand check of 2026-11-10 (only the Claude desktop app holds an unsent draft; herdr sends its first message, so it opens empty; Codex, opencode, and Cursor's agent unverified). Resolved the matching open question.
  - **herdr bring-forward:** herdr can list its terminals with their folders, so it brings an existing tab forward like tmux. Resolved the matching open question.
  - **T3 Code:** cannot be told to open a folder from outside. Weave brings it forward and reports the failure with a hint, keeping the default. Added as a known limitation and an open product question. The earlier assumption that T3 Code can open a folder while running is superseded.
  - **Cursor from outside Cursor:** added the QF1 limitation (Agents window instead of the folder, Cursor 3.21).

## Assumptions

- The "first step" of a new change is the step the guided "start a change" flow recommends today (for example `weave-questions` or `weave-explore`).
- A one-off choice (in chat or on the command) never becomes the default, even when there is no default yet. Only answers where the person chose "make it my default" (or "don't ask again"), at the terminal menu or in chat, and the settings command are saved. (Superseded 2026-11-10: previously every answer given to the menu was saved.)
- The per-project override is personal (stored with the person's settings), not committed to the project, consistent with "never shared through the project".
- A per-project override takes precedence over the personal default in that project.
- When the default is herdr or tmux but the person is not inside it this time, this is treated as a one-off unavailability: nothing opens, Weave explains why, shows the folder and step, and keeps the default.
- A recognisable tmux or herdr tab already in the change folder is brought forward regardless of what the default place is.
- When an agent passes a choice through a guided flow and opening succeeds, the original agent tells the person the step to type or paste only when the draft could not be filled in.
- Weave collects no usage telemetry, so success metrics are qualitative.
- From checks on one machine on 2026-11-09 and 2026-11-10: the Claude desktop app can open a folder with an unsent first message and asks the person to confirm the folder each time; VS Code can open a folder but cannot take a first message; T3 Code cannot be told to open a folder from outside at all (superseding the earlier belief that it could while running); herdr sends a first message automatically; Cursor's agent can be started in a terminal in a given folder.
- tmux can report its windows with their current folders, and herdr can list its terminals with their folders, so a tmux window or herdr tab sitting in a change folder can be recognised.

## Open Questions

None block this PRD.

Product questions:

- **T3 Code:** keep T3 Code on the list until it supports opening folders from outside, or drop it? Today choosing it only brings the app forward and reports that the folder must be added there. Not blocking.

For the technical design:

- When a herdr tab or app opens, does focus move to it or does it open in the background?
- How does the Claude desktop app behave on macOS when it is already running: new window, or the existing one?
- What are the exact usual install locations for each listed tool on macOS and Linux?
- Should "move this session into the change" (Claude Code today) be added to the menu later, and how would the saved default work in agents that can't do it? Deliberately left out of this change.

Resolved:

- Which tools can hold a first message as an unsent draft? Resolved 2026-11-10 by hand check: only the Claude desktop app. herdr sends its first message automatically, so it opens empty with the step shown. Codex, opencode, and Cursor's agent were not verified and show the step.
- Can herdr list its tabs with their folders, so an already-open change can be brought forward? Resolved: yes. herdr brings an existing tab in the change folder forward, like tmux.

## Out of Scope

- Opening changes from the "fix a bug" flow (handled in a later change).
- Moving the current agent session into the change folder.
- Linking the opening default with automatic phase hand-off settings.
- Adding new places or apps through personal settings.
- Run-time discovery of tools.
- Detecting duplicate sessions in places other than recognisable tmux and herdr tabs.
- Watching whether an opened session actually started.
- Running or approving setup commands as part of opening.
- Projects that switch branches in place.

## Further Notes

Options considered during exploration, for background only:

- **Better hand-off, no auto-opening:** rejected; it only describes the chore instead of removing it.
- **Up-front configured preference:** folded into the chosen direction; the default is set by asking at the moment it is needed (with "just this once" or "make it my default") rather than through a separate setup step.
- **Automatic, guessing from where you are:** rejected; unpredictable, some places cannot be told apart, and it repeats what the auto-hand-off decision rejected.
- **Skill-first "take me there" (move the session where possible, else a new tab):** rejected; it works best in Claude and falls back to something weaker elsewhere, with no app choice or pre-filled step.
- **Menu plus "move this session here":** rejected for now to keep one behaviour across agents; it can be added to the menu later.

Each place and agent is an optional, separate connection. Weave works fully with none of them and stays independent of any single tool or app. Weave keeps creating change folders itself, because they span several repos and carry setup approval, slots, and closing.
