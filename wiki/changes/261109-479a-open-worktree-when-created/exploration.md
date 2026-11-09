---
artifact: exploration
status: draft
owner: product
created_at: 2026-11-09T08:57:56.921Z
updated_at: 2026-11-09T14:46:58.000Z
reviewed_at: null
approved_at: null
approved_by: null
source: discussion
---

# Open Worktree When Created

## Topic

"Whenever a new change is created, rather than giving the user only the path and asking them to go to the path manually, why not take them there automatically? It should support herdr, cursor, claude, codex, opencode."

## Problem

People who use change folders (one separate folder per change) create a change and are then told only where its folder is. To start working, they have to open a new terminal tab or editor window themselves, go to that folder, start their agent, and remember which step to run first. The same chore repeats every time they resume a change or open a teammate's change. It is friction at the moment they most want to get going, and easy to get wrong, for example by carrying on in the old session, whose files are not the change's files.

## Existing Behavior

- Creating a change in folder mode builds the change's folder next to the main project and ends with one line: "Open <folder> in a new session to work on this change." Nothing is opened.
- Switching to an existing change (your own, a teammate's pushed change, or a deleted folder being recreated) prints the same line.
- The guided "start a change" and "fix a bug" flows, the "what's next" helper, the README, and the help pages all tell the person to open the folder themselves. The recorded decision that gives each change its own folder says so too, reasoning that an agent session cannot move itself into another folder.
- That reasoning holds for most agents but not all (checked 2026-11-09). Claude Code can move its current session into an existing change folder, wherever Claude runs: a terminal, the desktop app, or an editor panel. Codex, Cursor's agent, opencode, and pi have no such ability as far as is known, so for them the only way in is a new tab, window, or app. Weave does not use Claude's ability today.
- Weave can already open a new herdr tab, tmux window, iTerm window, or Terminal window, and start Claude in it. It does this only for automatic hand-offs between workflow phases, and only when someone has configured an agent. A recorded decision rejected opening a new visible window by default for those hand-offs: surprise windows, Weave guessing the agent, and work split across windows.
- Weave knows which agents have its skills installed in a project, but nothing records which tool a person actually prefers. It can recognise only a few of the places it runs inside: Claude Code, herdr, tmux, and iTerm.
- Projects that switch branches in place (no change folders) have no new folder to go to.

## Options Considered

### A. Better hand-off, no auto-opening — Rejected

- What it means for users: Weave keeps printing the folder plus a ready-to-run line for their tool (for example "open in Cursor: …").
- Trade-offs: the person still does the last step every time.
- Why rejected: it only describes the chore instead of removing it.

### B. One "open" action with a remembered preference set up front — Folded into D

- What it means for users: the person configures once where they work, and creating or switching to a change opens it there.
- Trade-offs: a separate setup step before anything happens, and nothing guides people to it.
- Why folded in: its remembered default and later reconfiguration became part of D. D sets the default by asking at the moment it is first needed, not through up-front setup.

### C. Automatic, guessing from where you are — Rejected

- What it means for users: with no setup, Weave opens the same kind of place the person is in now and starts the agent they are running.
- Trade-offs: unpredictable. Windows appear unasked, and some places cannot be told apart (Cursor's terminal looks like VS Code's; Codex and T3 Code cannot be detected reliably).
- Why rejected: Weave should never start an agent or open a place the person did not choose. It also repeats what the auto-hand-off decision rejected.

### D. Ask at the moment of creation, remember the answer as a default — Chosen

- What it means for users: the first time a change is created or switched to, Weave asks where to open it. The answer becomes the person's default and is used without asking from then on. They can change it later in their settings.
- Trade-offs: one question the first time, and an extra menu option for those who want today's behaviour.
- Why chosen: the person chooses explicitly, nothing opens that they did not pick, and after one answer it costs nothing.
- Revisited after E and the D+E merge were proposed, and kept as is.

### E. Skill-first "take me there" — Rejected

- What it means for users: Weave keeps creating change folders as today. One shared guided step then moves the person in. If the agent can move its own session (Claude Code), the same conversation carries on inside the change. Otherwise a new terminal tab opens in the folder. Otherwise the folder is shown. There is no menu, no saved default, and no apps. Inspired by the superpowers `using-git-worktrees` skill ("use the agent's own way in when it has one").
- Trade-offs: no opening in an app of the person's choice, no picking a different agent, and no pre-filled first step. It also opens a new tab without asking unless that step asks first. Moving a session has untested limits: moving straight from one change to another, whether the moved session picks up the change's own instructions, and terminal tab titles still showing the main project.
- Why rejected: it works best in Claude and falls back to something weaker for everyone else. The goal is the same experience for every agent and app. Superpowers creates its own worktrees, which Weave must not do, because Weave's change folders cover several repos, setup approval, slots, and closing. So only the "move in if you can" idea could be borrowed.

### D+E merge: menu with "move this session here" as an extra choice — Rejected for now

- What it means for users: D's menu and saved default, plus a "here" choice listed only in agents that can move their own session.
- Trade-offs: the most capable shape, but it needs a default that copes with "here" not being possible in some agents ("here when possible, otherwise X", or a default per agent), and it carries E's untested limits.
- Why rejected for now: it keeps one behaviour across every agent and keeps the first version simpler. "Here" can be added to the menu later without changing anything else.

## Chosen Direction

When a person creates a change, or switches to one, in a project that uses change folders, Weave opens that change's folder in the place they chose.

**Choosing where (asked once, then remembered):**

1. Step one, where to open:
   - **A terminal:** herdr tab, tmux window, iTerm window, or Terminal window.
   - **An app:** VS Code, Cursor, the Claude desktop app, or T3 Code.
   - **Don't open:** just show the folder, as today. This can be saved as "don't ask again".
2. Step two, only for a terminal, what to start in it: Claude, Codex, opencode, Cursor's agent, any of the person's own agents (see below), or just a shell.

**Which choices are offered (fixed and predictable):**

- Weave ships a fixed list of supported places and agents: the four terminals, the four agents, and the four apps above. Each entry has a fixed check: its known command name and its usual install locations. Weave looks only there and never scans or guesses, so the same machine always shows the same menu. Supporting a new tool means a Weave update.
- Agents and apps are offered when found by their command or in their usual install location. VS Code is always found by its own install location, never through the shared `code` command, because Cursor can take that command over.
- herdr and tmux are offered only when installed **and** the person is working inside them, because the new tab opens next to where they are. iTerm and Terminal are offered on a Mac.
- Places Weave cannot fully check are still offered, with a short hint, for example "T3 Code (must be running)". If opening fails, the usual failure rule applies.
- On Linux the menu offers herdr, tmux, VS Code, and Cursor when found, and T3 Code when found. The Claude desktop app, iTerm, and Terminal are Mac-only here.
- **The person's own agents:** in personal settings, a person can add agents that are not on the list (for example pi) as a name plus the command that starts it. Weave lists them in step two without checking them and never fills in a first step for them. Personal settings can also point a listed tool at an unusual install location. They cannot add new places or apps.

**Who asks:**

- A person running the command at a terminal sees the menu there.
- When an agent creates or switches to a change through the guided flow, the agent asks in the chat with the same choices and passes the answer on.
- When there is no saved default and nobody can be asked (a script, or an older guided flow), nothing opens and today's folder message is shown.

**The default:**

- It is personal to the person and their machine, applies across all their projects, and is never shared through the project. Teammates use different tools.
- A per-project override is allowed (for example "in this project, open in Cursor").
- Once set, it is used without asking on **every** create or switch, whoever runs the command: a person, an agent, or a script. Weave says what it opened and how to change it.
- A different choice can be made for a single change: by telling the agent ("don't open this one", "open this one in Cursor"), or by an option on the command itself when typing it at a terminal.
- The default can be changed later through a Weave settings command that shows the same menu again, or by editing the personal settings file.
- The menu comes back only when the default's app or command is gone (for example uninstalled). A one-off failure, such as T3 Code not running this time, keeps the default.
- The default covers only opening changes. Automatic phase hand-offs keep their own project setting and rule, and the two are documented as independent.

**What the new session starts with:**

- Where the tool can hold a first message as an unsent draft, the session opens with the next step for that change filled in but **not sent**, so the person can read or edit it and add context before starting. For a new change this is its first step. For a switched-to change it is whatever "what's next" would recommend.
- Where the tool can only start with a message already sent, or cannot take one at all, the session opens empty in the folder and Weave or the original agent shows the step for the person to type or paste.
- Weave never starts an agent the person did not choose and never runs a step automatically.

**Switching to a change that may already be open:**

- Already inside that change's folder: nothing opens. The next step is shown.
- Already open in a tmux or herdr tab that Weave can recognise as sitting in the change folder: that tab is brought forward instead of opening a new one.
- Already open somewhere Weave cannot recognise (other terminals, apps): a new one opens anyway. A duplicate session is a known limitation.
- Folder recreated after it went missing: it opens as normal.

**After opening:**

- The original session says where the change was opened and that it continues there, and always includes the fallback: the folder and the next step, in case the new session did not start.
- The original session no longer edits the change's files, but it can still help the person reopen it ("open it again", "open it in Cursor instead"), which switches to the change again.
- Setup commands for the new folder (such as installing dependencies) are never run or approved as part of opening. They still need the person's approval at a terminal later, as today.

**If opening fails:**

- The change is still created or switched to. Opening never blocks or undoes it.
- Weave says in one line what went wrong and falls back to today's message: the folder and the step to run there.
- Weave does not watch whether the opened session actually started. The fallback in the original session's message covers that.
- When the person is connected over SSH, Mac terminal windows and apps are skipped (they would appear on a screen the person cannot see). Weave shows the folder and step and says why. herdr and tmux tabs on the remote machine still open.

**Not part of this change:**

- The "fix a bug" flow keeps today's behaviour: it writes its files and then shows the folder. It tells Weave not to open its change, so no window opens before its findings are written. Opening from the fix flow will be handled in a later change.
- Moving the current session into the change (possible in Claude Code) is not offered.

## Scenarios

1. **First change after upgrading.** Arpit, working inside herdr with Claude, asks the agent to start a change. The agent asks: "Open it now? A terminal (herdr, iTerm, Terminal) / an app (VS Code, Cursor, Claude desktop) / don't open". Arpit picks herdr, then Claude. A new herdr tab opens in the change folder with Claude started. If the tab can hold an unsent draft, "use weave-questions for change <id>" is filled in. Otherwise the original session shows the step to paste. The original session says "Opened in a new herdr tab with Claude, continue there", gives the folder and the step as a fallback, and stops editing the change.
2. **Every change after that.** Arpit creates another change. No question: a new herdr tab with Claude opens straight away, and Weave says how to change the default.
3. **One-off exception.** Arpit is creating a quick throwaway change and says "don't open this one". Only the folder is shown, and the default is unchanged. Typing the command at a terminal, he uses the command's "don't open" option for the same effect.
4. **App with a pre-filled step.** Mei's default is the Claude desktop app. Switching to a teammate's pushed change opens a new Code session there on that folder with the "what's next" step filled in. The app asks her to confirm the folder, as it always does.
5. **App that can only open the folder.** Sam's default is VS Code. The change opens in a VS Code window, and the original session tells Sam which step to run.
6. **Default no longer works.** Sam uninstalled T3 Code, which was the default. The next time, the change is still created, Weave explains that T3 Code isn't available, and the menu is shown again.
7. **Default temporarily unavailable.** Lee's default is T3 Code, which is installed but not running. Opening fails, the change is created anyway, Weave says T3 Code must be running and shows the folder and step. The default is kept.
8. **Opening fails.** The herdr tab cannot be opened. The change is created anyway, and Weave prints one line about the failure plus the folder and the step to run.
9. **Opened, but nothing started.** Mei cancels the Claude desktop app's folder confirmation. She goes back to the original session, which still shows the folder and step, and says "open it in Cursor instead". The change opens in Cursor.
10. **Someone who likes today's behaviour.** Priya picks "don't open, and don't ask again". She sees today's folder message from then on.
11. **A script with a saved default.** Arpit runs a script that creates five changes in a row. His default is herdr + Claude, so five herdr tabs open, each with Claude. This is accepted.
12. **A script with no default.** A CI job creates a change on a machine with no saved default. Nothing is asked, nothing opens, and the output is unchanged.
13. **Already open.** Arpit switches to a change that already has a tmux window sitting in its folder. That window is brought forward and no new one opens. Running switch from inside the change's own folder opens nothing and just shows the next step.
14. **Their own agent.** Kai uses pi, which is not on Weave's list. Kai adds "pi" with its start command to personal settings, picks "herdr + pi", and changes open in a herdr tab running pi, with the step shown to paste.
15. **Over SSH.** Arpit is connected to his Mac over SSH with a default of iTerm + Codex. Nothing opens. Weave explains why and shows the folder and step.
16. **Older guided flows.** Weave is upgraded but a project's installed "start a change" flow is still the old one. With a saved default the change opens as normal, and the old flow also says "open the folder", which is redundant but harmless. With no default, nothing opens and today's message is shown. Weave's existing notice about out-of-date flows prompts an update.
17. **Project without change folders.** In a project that switches branches in place, no menu appears.
18. **Linux.** The menu offers herdr and tmux when the person is inside them, plus VS Code, Cursor, and T3 Code when found.

## Decisions

- Ask at the moment of need, then remember the answer. — Explicit choice without an up-front setup step.
- Two-step choice: place first, then (for terminals) the agent. — Places (terminals, apps) and agents are different things. Apps bring their own agent or editor.
- Never start an agent or open a place the person didn't pick. — No surprise windows, and no guessing the person's tools.
- Offer only choices from a fixed list of supported tools, checked by their known commands and usual install locations. Nothing is discovered at run time. — Deterministic: the same machine always shows the same menu. (Stress test C6)
- herdr and tmux need the person to be inside them. Apps and agents need to be installed. Hard-to-check places are shown with a hint. — The new tab opens next to the person, and uncertain cases are covered by the failure rule. (C6)
- People can add their own agents (name plus start command) and point listed tools at unusual locations, but cannot add places or apps. — Agents change fast. Places change slowly. This extends the existing "your own command" option for hand-offs. (C6)
- Both the person at a terminal and the agent in chat can ask, with the same choices. — Most changes are created through agents, and Weave cannot show a question when an agent runs it.
- With a saved default, opening happens on every create or switch, whoever runs it, including scripts. Batches open one window each. — Weave does not need to tell people and scripts apart, and this was judged acceptable. (C1)
- The default is personal to the person and machine, across projects, with an optional per-project override, never shared through the project. — Teammates use different tools, and a shared default would break on machines without that tool.
- With a default set, use it without asking. A per-change override is available in chat and on the command. The menu returns only when the default's tool is gone, not after a one-off failure. — Asking every time gets tedious, and a temporary failure shouldn't wipe a choice. (C6, C10)
- Fill in the next step as an unsent draft only where the tool supports one. Otherwise open empty and show the step to type or paste. Never start with the step already sent. — Nothing runs that the person didn't start, and every tool stays in the menu. (C2)
- Applies to both creating and switching to a change. — Same chore, same habit.
- When switching: open nothing if already inside the change's folder, bring forward a recognisable tmux or herdr tab already in the folder, otherwise open. — Avoid duplicate sessions where Weave can tell. (C4)
- Opening never blocks creation or switching. On failure, fall back to today's message. — Opening is a convenience.
- The original session's message always includes the folder and next step. It stops editing the change but can reopen it on request. Weave doesn't watch whether the new session started. — Nobody is left stranded when a window opens but nothing usable starts. (C9)
- Opening never runs or approves setup commands. — Setup approval must stay with a person at a terminal.
- Over SSH, skip Mac terminal windows and apps. herdr and tmux still open. — Windows would appear on a screen the person cannot see. (C11)
- The personal default does not affect automatic phase hand-offs, which keep their project setting and rule. Documented as independent. — Opening a change ("where do I work") and running a phase ("who runs it") are different questions. Linking them can come later. (C8)
- Older installed guided flows: with a default the change opens, otherwise today's message. Weave's existing out-of-date notice prompts an update. — Nothing breaks in mixed versions. (C7)
- No opt-in switch. Existing users see the menu once, with a "don't open, don't ask again" choice. — Discoverable, and one answer restores today's behaviour.
- Each place and agent is an optional, separate connection. Weave works fully with none of them. — Weave stays independent of any single tool or app.
- Kept D over E and the D+E merge. — Every agent and app gets the same experience, not one that works best in Claude and falls back elsewhere.
- Weave keeps creating change folders itself, and agents never create their own worktrees for a change. — Change folders span several repos and carry setup approval, slots, and closing.
- The "fix a bug" flow is out of scope. It keeps today's behaviour and asks Weave not to open its change. — It writes files after creating the change. It will be handled in a later change. (C3)

## Assumptions

- From the follow-up check on this machine on 2026-11-09:
  - The Claude desktop app can be opened on a folder with a first message filled in but not sent, and it asks the person to confirm the folder each time.
  - VS Code can open a folder but cannot be given the next step as a first message. Copilot is not set up here, and the Claude extension cannot target a folder.
  - T3 Code can open a folder only while it is already running, without a first message. It is not installed on this machine.
- Cursor's agent can be started in a terminal in a given folder.
- On this machine, the usual command for VS Code actually opens Cursor, so VS Code has to be reached through its own install location.
- tmux can list its windows with their current folders, so Weave can recognise a tmux window already sitting in a change folder. This was not covered by the research.
- Removed: "herdr and opencode can take a first message without sending it". This is unsupported by the evidence and is now an open question.

## Open Questions

- Which tools can hold a first message as an unsent draft (herdr's first-message option, Claude, Codex, opencode, Cursor's agent)? Each one that can't opens empty with the step shown. Blocks the PRD: no.
- Can herdr list its tabs with their folders, so an already-open change can be brought forward? If not, herdr behaves like the other terminals. Blocks the PRD: no.
- Recorded decisions: the technical design should draft a record replacing the worktree decision's "people open the folder themselves" consequence (and its "a session cannot move itself" reasoning, no longer true for Claude Code). It should also draft a record keeping opening a chosen place separate from the auto-hand-off rule against opening visible windows (which this shape now does without asking once a default exists, including from scripts), and one for the new personal settings store. Blocks the PRD: no.
- Should "move this session into the change" (Claude Code today) be added to the menu later, and how would the saved default work in agents that can't do it? Deliberately left out of this change. Blocks the PRD: no.
- When a herdr tab or app opens, does focus move to it, or does it open in the background? Blocks the PRD: no.
- How does the Claude desktop app behave on macOS when it is already running: new window, or the existing one? Blocks the PRD: no.
- What are the exact usual install locations for each listed tool on macOS and Linux? Blocks the PRD: no.

## PRD Readiness

Ready
