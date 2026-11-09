---
id: 261110-0uwv-weave-opens-change-folders-where-the-person-chose-saving-only-what-they-make-the-default
title: Weave opens change folders where the person chose, saving only what they make the default
status: proposed
date: 2026-11-10
owner: arpit016
change: 261109-479a-open-worktree-when-created
applies_to:
  - src/lib/open-change.ts
  - src/lib/open-places.ts
  - src/commands/change.ts
  - src/commands/settings.ts
  - src/lib/worktrees.ts
  - src/lib/changes.ts
  - src/lib/task-prepare.ts
  - src/lib/git.ts
  - templates/skills/weave-new/SKILL.md
  - templates/skills/weave-next/SKILL.md
  - templates/skills/weave-fix/SKILL.md
supersedes:
  - 261109-mn61-weave-opens-change-folders-in-the-place-the-person-chose
superseded_by: null
---

# Weave opens change folders where the person chose, saving only what they make the default

## Context

Decision `261107-ohne` gave each change its own folder of worktrees, with the consequence that people open the change folder in a new session themselves. Decision `261109-mn61` superseded it: it kept ohne's core and made Weave open the change folder in a place the person chose, asking once and then saving the answer as a personal default.

While the change was being built and tried by hand (2026-11-10), the person who owns it decided that saving every menu answer was wrong. People pick a place to try it, or for one unusual change, and should not find that choice has quietly become their default. Picking an app such as T3 Code, or Cursor run from outside Cursor, also showed that a first try can go badly, and a bad first try should not stick. This record restates `261109-mn61` in full, including the core carried over from `261107-ohne`, and changes only how the choice is kept, so that agents looking up `open-change.ts`, `worktrees.ts`, or `changes.ts` find one current record.

## Decision

**Carried over unchanged from `261107-ohne` (through `261109-mn61`):** with `checkout: worktree`, the default for new workspaces, `weave change new` creates one folder per change holding a git worktree of the workspace root and of each registered repo, all on `change/<change-id>`, laid out with the same relative paths as the main checkout. Each starts from the freshly fetched remote default branch. Weave calls `git worktree` directly. Setup commands run at execution time, only after a person approves each command on that machine.

**Carried over unchanged from `261109-mn61`:** in change-folder mode, Weave opens the change's folder in a place the person chose explicitly:
- **Where:** a terminal from a fixed list (herdr, tmux, iTerm, Terminal) with a chosen agent or a shell, or an app from a fixed list (VS Code, Cursor, Claude desktop, T3 Code). Apps are never asked what to start.
- **Who asks:** a terminal menu (text output at a real TTY only), or the calling agent in chat (`needs_choice` in `--json`).
- **The command:** opening is a separate command with no git side effects (`weave change open`), which `new` and `switch` call.
- **Guarantees:** opening never blocks or undoes the create or switch, never sends a step, and always leaves the folder and next step in the original session.

**Changed (how the choice is kept):** after picking where to open (and, for a terminal, what to start), the person chooses **just this once** or **make it my default**. For "don't open" the pair is **just this once** or **don't ask again**.
- Only "make it my default" and "don't ask again" save anything, as the personal default (or, with `--project`, the override for this project). "Just this once" opens without saving, and the person is asked again on the next create or switch.
- The same rule applies at the terminal menu (a third question, `MenuAnswer.remember`) and in chat: guided skills add `--remember` (or `--project`) to `weave change open` only when the person chose the default.
- `weave settings open` still sets the default directly, without the third question.
- Once a default is set, it applies to every create and switch, whoever runs the command (person, agent, or script), exactly as before.

## Alternatives Rejected

- **Save every menu answer as the default (`261109-mn61` as accepted).** A first try, or an answer for one unusual change, silently became the default. Rejected by the person who owns the change on 2026-11-10.
- **Never save from the menu; set defaults only through `weave settings open`.** Forces a separate step on everyone who does want a default, and loses "the choice is made at the moment it is needed".
- **For the folder model:** see `261107-ohne` (switch branches in place, depend on a separate worktree tool, create worktrees only before implementation). Those reasons still hold.
- **For opening (from `261109-mn61`):** better hand-off text with no opening; guessing the place from the environment; moving the current session where possible; opening only from inside `new` and `switch`; returning an open plan for the calling agent to run. The reasons in `261109-mn61` still hold.

See `wiki/changes/261109-479a-open-worktree-when-created/architecture/index.md`, Options Considered and Revision History.

## Consequences

- **Carried over from `261107-ohne`:**
  - No Weave command moves a main checkout.
  - Each change costs a full checkout of every repo on disk, plus its own installs.
  - Weave owns the git edge cases.
  - Windows, submodules, and sparse checkouts are not handled.
  - Existing workspaces keep `in-place` checkouts until they opt in.
- **Carried over from `261109-mn61`:**
  - People no longer open the change folder themselves. Creating or switching lands them in the folder, with the folder and next step always shown as a fallback.
  - Scripts on a machine with a saved default open one session per create or switch.
  - Weave carries a fixed registry of places and agents with fixed checks. A new tool needs a Weave release, and each tool's draft support has to be checked by hand.
  - `weave-new`, `weave-next`, and `weave-fix` must handle `needs_choice` (or pass `--no-open`), and fall back when an older CLI rejects the new flags.
- **New:**
  - Someone who keeps answering "just this once" is asked on every create or switch until they make a choice their default. Accepted: it is their choice, and "make it my default" or "don't ask again" is always one answer away.
  - Trying a place never changes the default, so a bad first experience (for example T3 Code, which cannot be told to open a folder) does not stick.
  - The menu has one more question, and the guided skills ask one more question in chat.
  - Skills must add `--remember` only when the person chose the default, never for one-off or "just this once" answers.

## Reconsider When

Any of these:
- From `261107-ohne`: disk use or checkout time per change becomes a real cost, Windows support is needed, or a worktree tool appears that can be installed with Weave and coordinates several repos.
- From `261109-mn61`: most supported agents can move their own session into another folder, a common cross-agent way to open a visible session appears, or keeping the fixed tool list up to date costs more than it saves.
- From this decision: people report the third question as friction they would rather skip, for example most people always answer "make it my default".
