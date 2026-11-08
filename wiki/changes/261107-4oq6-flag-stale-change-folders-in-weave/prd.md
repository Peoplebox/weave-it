---
artifact: prd
status: draft
owner: product
created_at: 2026-11-08T12:37:01.000Z
updated_at: 2026-11-08T13:48:00.000Z
reviewed_at: null
approved_at: null
approved_by: null
source: exploration.md
---

# Change Folder States in `weave change list` and `weave status` PRD

## Problem Statement

Developers who use Weave's worktree checkouts get a separate folder for every change, next to the main checkout. Over time these folders pile up. Some changes have already landed, some folders were deleted by hand, and some are still being worked on. Weave doesn't say which is which.

- To decide what to clean up, a developer has to remember each change or check git by hand.
- AI agents working in the repo have no way to tell at all.
- A folder deleted by hand leaves leftovers. Git still treats the folder as in use, so the change's branch can't be deleted or checked out anywhere. Weave quietly loses track of the change. `weave change close` can't clean it up, and `weave change switch` claims to reopen it without recreating anything.

This matters because cleanup is risky when you're unsure. Developers either leave folders around, which wastes disk and causes confusion about slots and ports, or delete them by hand, which creates the leftovers above.

## Goals

- A developer or agent can see, in one command, what happened to every change in this repo or workspace and what to do next.
- `weave status` tells you when something needs attention, without becoming a dashboard.
- Every suggested next step works when it is run as given.
- "Landed" has one definition that any part of Weave can rely on, including `261107-6c16-close-delete-merged`. Only a fully landed change is ever treated as safe to delete.
- Answers are instant, as recent as possible, and say how old they are and why.
- A folder that was deleted, moved, or is unavailable can be cleaned up or brought back safely.
- Existing readers of `weave change list --json` keep working.

## Non-Goals

- Cleaning anything up automatically. Removal stays something a person runs through `close`.
- Deleting branches. That belongs to `261107-6c16-close-delete-merged`.
- Tracking idle time or "last used" dates.
- Asking GitHub, or any other host, about pull requests.
- Listing changes that exist only on the remote.
- Showing changes from other repos or workspaces on the same machine.
- Any change for in-place checkouts.
- A new notice on commands other than `weave status`.
- Usage analytics.

## Actors

- **Developer**: a person working on changes in a repo or workspace on their own machine. They run the list, decide what to close, and run `close` and `switch`.
- **AI agent**: a coding agent or Weave skill acting in the same repo. It reads `weave change list --json` and may run the suggested next-step commands.
- **Existing script**: anything that already reads today's `weave change list --json`.
- **Git remote**: the hosted copy of the repo, such as origin on GitHub, GitLab, or a plain server. It is the source of truth for whether work has landed.

There are no roles or permissions beyond the person at the machine.

## Current Behavior

- `weave status` reports the Weave version, whether installed skills are current, and notices, only for the folder it runs in. It says nothing about changes. The wiki calls it the place to go when you ask "where do I stand?"
- `weave change list` covers only the repo or workspace it runs in: that repo's main checkout and its change folders. Each entry shows the id, type, stage, and title, then the folder and slot. Run from the main checkout, it also lists every past change whose planning files reached main; about 32 appear in this repo today.
- `weave change status` describes the single change you are in.
- A change whose folder was deleted by hand drops off the list. A closed change drops off too, unless its planning files reached main.
- `weave change close` is the only way Weave removes a folder. It refuses when there is uncommitted work, never deletes branches, and frees the slot. It fails with "change not found" when the folder was deleted by hand.
- `weave change switch` reports success for a deleted folder but does not recreate it. A slot released by a missing folder can go to another change, while the old change keeps its record, still marked as set up.
- Git keeps treating a folder deleted by hand as in use, which blocks its branch, until the record is cleared. Git clears it by itself only after about three months.
- Weave writes planning files into a change's folder and never commits them.
- Weave records each repo's starting branch only in those planning files, and only for branches it created itself.
- Weave can't tell whether a change has landed.
- "Stale" already means a planning document that needs updating. No Weave wording describes folders as stale, orphaned, or abandoned.

Today's workaround is to inspect git by hand, or to delete folders and live with the leftovers.

## Proposed Product Behavior

`weave change list` tells the story of each change in the repo or workspace it runs in: exactly one state, a short note where useful, and one suggested next step. State names, notes, labels, and next-step commands are fixed and identical in text and `--json`, so a developer and an agent read the same thing. It gives the same answer from the main checkout, any change folder, or any subfolder. `weave change status` remains the single-change view, much as `git status` is. `weave change list` works like `git branch`.

"Landed" is measured against the branch the change started from in each repo, and that branch is always named: "landed in main (squashed)", or "landed in change/worktrees, not in main yet". Weave remembers each change's starting branch even after its folder is gone. Only a fully landed change is safe to delete.

The list answers instantly from what is already known and refreshes from the remote in the background for next time. Each answer says how old it is, and why if a refresh failed. `--fetch` waits for a fresh answer.

The list keeps today's layout, with new indented lines for state, labels, next step, and age.

`weave status` adds one line when something needs attention: `2 changes need attention (1 landed, 1 folder missing). Run 'weave change list'.`

`close` and `switch` are fixed so that a missing folder can be cleaned up or brought back.

## User Workflows

### Workflow: Developer cleans up landed changes

1. The developer runs `weave status` and sees "2 changes need attention (2 landed). Run `weave change list`."
2. They run `weave change list`.
3. The list shows each landed change, for example "landed in main (squashed)", with the data's age and the next step `weave change close <id>`.
4. The developer runs `weave change close <id>` for each one.
5. The folders are removed, the slots are freed, and the branches are kept.

### Workflow: Developer cleans up a landed change with uncommitted files

1. The list shows "landed in main (squashed) · 2 uncommitted files in folder", with "next: commit or discard the 2 uncommitted files, then `weave change close add-export`".
2. The developer commits or discards those files.
3. They run `weave change close add-export`, and it succeeds.

### Workflow: Developer wants the latest answer

1. The developer has just merged a pull request.
2. They run `weave change list --fetch`.
3. If a background refresh is already running, the list waits for it. Otherwise it starts one.
4. It shows the change as landed. If the refresh didn't finish within the time limit, it shows what it has and says so.

### Workflow: Developer cleans up a folder deleted by hand

1. The developer deleted a change folder and now sees that git says its branch is in use.
2. `weave status` shows "1 change needs attention (1 folder missing)".
3. `weave change list` shows "folder missing: not found at `<path>`" and offers `weave change close <id>`. It also offers `weave change switch <id>` when there is committed work to restore.
4. The developer runs `weave change close <id>`. It warns: "if you moved this folder, move it back first; closing stops tracking it".
5. Git's leftover record and Weave's record are cleared, the slot is freed, and the branch is kept and can be deleted or checked out again. Weave still remembers the starting branch.

### Workflow: Developer brings a missing folder back

1. The list shows a change as folder missing, with "bring it back with `weave change switch <id>` (restores committed work only)".
2. The developer runs `weave change switch <id>`.
3. Weave recreates the folder from the change's committed work.
4. If the old slot was taken by another change, Weave assigns a new one and says so: "slot 2 was taken, now slot 3".
5. Setup counts as not yet run, so the next `weave change setup` runs again.

### Workflow: Agent cleans up on the developer's behalf

1. The agent runs `weave change list --fetch --json`. It uses `--fetch` because it is about to act on whether changes landed, or report that nothing needs cleanup.
2. It reads each change's state, notes, labels, couldn't-check field, per-repo data age, and next-step command.
3. It runs `weave change close <id>` for changes in the landed state with no uncommitted files.
4. It leaves alone anything landed with newer commits, anything with a couldn't-check label, and anything that isn't landed.

### Workflow: Developer checks right after merging

1. The developer merges a pull request on GitHub and immediately runs `weave change list`.
2. The list answers instantly. It still shows the change as in progress, with "as of last fetch, 2 hours ago · refreshing now, run again in a few seconds for the latest".
3. A few seconds later, the developer runs it again, and the change shows as landed. Running `--fetch` instead would have waited for that answer.

### Workflow: Developer reviews past changes

1. The developer runs `weave change list --all`.
2. Past changes appear in the done state, together with everything the default list shows.

## User Stories

1. As a developer, I want `weave change list` to show what happened to each change in this repo or workspace, so that I know what I can safely clean up.
2. As a developer, I want the list to cover only the project I'm in, so that changes from my other projects don't clutter it.
3. As a developer, I want each state to come with the exact next command, so that I don't have to work out what to do.
4. As a developer, I want "landed" to name the branch it landed in, so that I can tell a stacked change merged into its parent from one merged into main.
5. As a developer, I want Weave to remember where a change started even after its folder is gone, so that closed and old changes are measured correctly.
6. As a developer, I want to be told when Weave doesn't know where a change started, so that a possible mislabel is visible.
7. As a developer, I want squash and rebase merges recognised, so that changes merged that way don't look unfinished.
8. As a developer, I want the list to be instant and to say how old its information is, so that I'm never kept waiting and never misled.
9. As a developer, I want a reason shown when a refresh failed or timed out, so that a growing age always makes sense.
10. As a developer, I want `--fetch` to get the latest state on demand, so that I can confirm a merge I just made.
11. As a developer working offline, I want the list to still work and tell me it couldn't refresh, so that I can trust what it shows.
12. As a developer, I want `weave status` to tell me when changes need attention, so that I don't have to remember to check.
13. As a developer, I want `weave status` to say nothing when nothing needs attention, so that it stays quiet and quick.
14. As a developer, I want the list to keep showing title, type, stage, folder, and slot, so that I can recognise changes and know their ports.
15. As a developer who deleted a folder by hand, I want `weave change close` to clean up the leftovers, so that my branch is no longer blocked.
16. As a developer, I want `weave change switch` to really recreate a missing folder, so that I can get back to work.
17. As a developer, I want to be told when a missing folder can't be brought back because nothing was committed, so that I'm not offered a step that fails.
18. As a developer, I want a recreated folder to get a free slot and fresh setup, so that ports don't collide and setup isn't wrongly marked done.
19. As a developer who moved a folder, I want `close` to warn me first, so that I don't lose track of work that still exists.
20. As a developer with change folders on an external drive, I want an unplugged drive reported once, so that every change isn't marked missing.
21. As a developer, I want folders I've marked to keep left alone, so that Weave respects my choice.
22. As a developer, I want a change that landed and then got more commits shown separately, and never treated as safe to delete, so that I don't lose those commits.
23. As a developer, I want a landed change with uncommitted files flagged clearly, with the step that will actually work, so that I know why `close` refuses and what to do.
24. As a developer, I want a change with no commits yet never shown as landed, so that new changes aren't flagged for cleanup.
25. As a developer on a multi-repo change, I want one line per repo and the least-finished repo to decide the state, so that a half-landed change isn't closed by mistake.
26. As a developer, I want old branches whose work never landed shown after I upgrade, so that forgotten work comes to light.
27. As a developer, I want past changes hidden by default and shown with `--all`, so that the list stays focused on current work.
28. As a developer on old git, I want normal and rebase merges still recognised, and squash cases marked as couldn't check, so that I still get real answers.
29. As an agent, I want fixed state names, fixed next-step commands, and a separate couldn't-check field in `--json`, so that I can act without guessing.
30. As an agent, I want the list never to prompt for a login, and `--fetch` to join a running refresh, so that I'm never stuck or tripped up by my own repeated calls.
31. As the author of an existing script, I want no `--json` field renamed, removed, or changed in meaning, and no field pointing at a folder that doesn't exist, so that my script keeps working.
32. As a developer, I want a "may have landed" hint when the remote branch is gone but no landing was found, so that merges the check missed still show up.
33. As a developer, I want to be told when a refresh is running, so that a change flipping to landed on my next run isn't confusing.
34. As an agent, I want to know that I should use `--fetch` before acting on whether changes landed, so that I never report "nothing to clean up" from old data.

## Functional Requirements

### Scope

- The system should list only changes of the repo or workspace the command runs in, never those of other repos or workspaces on the machine.
- The system should give the same list from the main checkout, any change folder, or any subfolder of either.

### Listing

- The system should show, by default, every change with something here: a folder, a missing-folder leftover, or a local `change/<id>` branch whose work hasn't landed or couldn't be checked.
- The system should show past changes, meaning changes with no folder whose work has landed or whose planning files are on main, only with `--all`, in the done state.
- The system should ignore local `change/` branches that don't contain a Weave change.
- The system should not list changes that exist only on the remote.
- The system should give each change exactly one state, chosen by the order in **States and Lifecycle**, and count each change once.
- The system should show one suggested next-step command per state, adapted to its notes and labels, which can be run exactly as shown.
- The system should use the same state names, notes, labels, and next-step commands in text and `--json` output.

### Layout

- The system should keep today's first line for each change: the active marker, id, type, stage, and title. It should show "(title unknown)" when the planning files are gone.
- The system should show, as indented lines under it: the state with its labels separated by "·", the next step when there is one, and the folder and slot as today.
- The system should show, for multi-repo changes, the per-repo states on the state line.
- The system should show an age line under a change only when its repos' ages differ or a refresh failed. Otherwise it should show one shared age line at the end.
- The system should show "change folders unavailable at `<path>`" once, at the top, when it applies.

### Remembering the starting branch

- The system should remember each change's starting branch per repo, separately from the folder, and keep it after `close` and after a folder disappears.
- The system should try to recover the starting branch for branches from before this change.
- The system should use the repo's default branch when the starting branch is unknown or no longer exists. When it was unknown, it should add the label "starting branch unknown".

### Deciding "landed"

- The system should measure each repo's change against its starting branch, and always name that branch.
- The system should recognise normal merges, rebased merges, and squash merges, using plain git with any host.
- The system should treat a change as landed when merging it into that branch would change nothing.
- The system should never treat a change with no commits since its starting point as landed.
- The system should treat a change as landed with newer commits when its work landed but it has commits after that point which haven't. This includes after a squash merge.
- The system should decide a multi-repo change by its least-finished repo with commits: in progress first, then landed with newer commits, then landed.
- The system should treat only the landed state as safe to delete. Landed with newer commits is never safe to delete.
- The system should use one definition of landed, shared with `261107-6c16-close-delete-merged`.
- The system should recognise normal and rebase merges on git older than 2.38, and mark only changes that would need squash detection as couldn't check there.

### Uncertainty

- The system should show a change the check found not landed as in progress, with no label.
- The system should label a change "couldn't check whether this landed: `<reason>`" when the check couldn't run, and carry this as its own `--json` field.
- The system should show a branch with no folder that couldn't be checked as "closed, couldn't check whether it landed", shown by default with `switch` as the next step.
- The system should label a change "branch deleted on origin; it may have landed" when the remote branch is gone and no landing was found.
- The system should not count any of these towards "need attention".

### Freshness

- The system should answer `weave change list` instantly from what is already known.
- The system should start a refresh from the remote in the background after each list, and return without waiting for it.
- The system should run only one refresh at a time, and skip a new background refresh started less than a minute after the last.
- The system should give up any refresh after about 30 seconds per repo. A refresh still marked as running after that should not block the next one.
- The system should show the age of each answer. When a refresh failed or gave up, it should show why, for example "(last refresh timed out)".
- When `--fetch` is given, the system should wait for a fresh answer. It should join a refresh that is already running instead of starting another, wait at most the same time limit, and otherwise answer with what it has and say the refresh didn't finish.
- The system should never prompt for a password or passphrase. When a login would be needed, it should skip that repo and say "couldn't refresh: origin needs a login".
- The system should report each repo's data age in `--json`, and say why when a repo wasn't refreshed.
- The system should compare locally and show no age in a repo with no remote.
- The system should change nothing during a list except Weave's copy of what is on the remote.
- The system should read local facts fresh on every list: folder missing, kept on purpose, or unavailable; uncommitted files; local commits, including landed with newer commits; and local branches. Only facts that come from the remote (whether work merged there, and whether a remote branch was deleted) may be as old as the last refresh.
- The system should let older remote data only under-report landing. A change may show in progress after it merged, but it should never show landed because data is old.
- When a list starts a background refresh or finds one already running, the system should add "refreshing now, run again in a few seconds for the latest" to the age line, and set `refreshing: true` in `--json`.

### Agent guidance

- Weave's own skills, and the guidance Weave gives agents, should use `weave change list --fetch --json` before closing any change or reporting that nothing needs cleanup. Plain `weave change list` stays for quick looks.

### Compatibility

- The system should never rename or remove a `--json` field that `weave change list` has today, or change what it means.
- The system should leave fields empty, never invented, when their source (the planning files) is unavailable, and add a field saying why.
- The system should keep today's folder field for folders that exist, and put a missing folder's recorded location in a new field.

### `weave status`

- The system should add one line when changes need attention: `<N> changes need attention (<counts per state>). Run 'weave change list'.`
- The system should count only landed and folder missing as needing attention.
- The system should add nothing when nothing needs attention, or when nothing has been worked out yet.
- The system should show the line from anywhere in a worktree-mode repo or workspace, counting only that repo's or workspace's changes.
- The system should never contact the remote or run the landed check from `weave status`. It should use the last known result.
- The system should include the same count in `weave status --json`.

### Missing folders

- The system should say "folder not found at `<path>`", never "deleted".
- The system should offer `weave change switch <id>` for a missing folder only when the branch has the change's files committed, and say it restores committed work only.
- The system should say "folder missing: nothing was committed, so its planning files can't be recovered" when there is nothing to restore, and offer only `close`.
- The system should report "change folders unavailable at `<path>`" once when the whole location of change folders is missing. In that case it should not mark each change folder missing, not count them, and not suggest `close`.
- The system should list a folder marked in git to be kept as "folder missing (kept on purpose)", not count it, and say how to unmark it.
- The system should keep showing a change as folder missing after git clears its own record, for as long as Weave's record remains.

### Uncommitted files

- The system should label uncommitted files only on landed states, as "N uncommitted files in folder".
- When that label is present, the system should change the next step to "commit or discard the N uncommitted files, then `weave change close <id>`".

### `close` and `switch`

- The user should be able to run `weave change close <id>` on a folder missing change. It should clear git's leftover record and Weave's own record, free the slot, and keep the branch and the remembered starting branch.
- The system should warn on that close: "if you moved this folder, move it back first; closing stops tracking it".
- The system should refuse `close` for a folder kept on purpose, and say how to unmark it.
- The user should be able to run `weave change switch <id>` to recreate a missing folder from committed work.
- The system should keep a recreated folder's old slot only if it is free. Otherwise it should assign a new slot and say so.
- The system should treat setup as not yet run for a recreated folder, and keep existing setup approvals.
- The system should not clean anything up from `weave change list` or `weave status`.

## Permissions and Access Control

- Everything here acts only on the developer's own machine and their own clone. There are no roles.
- `weave change list` and `weave status` change nothing except Weave's copy of what is on the remote, and Weave's small record of starting branches.
- Folders, records, and slots are removed only by `weave change close`, which a person or an agent runs explicitly.
- No command deletes branches. `261107-6c16-close-delete-merged` may delete only changes in the landed state.
- Existing setup approval rules are unchanged. Recreating a folder doesn't ask for or grant new approvals.

## States and Lifecycle

| State | Meaning | Next step | Need attention |
| --- | --- | --- | --- |
| folder missing | The folder is not found at its recorded place, and the change is still registered. | `weave change close <id>`; `weave change switch <id>` only when committed work exists | yes |
| folder missing (kept on purpose) | As above, and the folder is marked in git to be kept. | unmark it first | no |
| landed, with newer commits | The work landed, and later commits haven't. Not safe to delete. | review the newer commits before closing | no |
| landed (merged / rebased / squashed) | All the work is in the starting branch, which is named. The only safe-to-delete state. | `weave change close <id>`; with uncommitted files, commit or discard them first | yes |
| in progress | The folder exists and the work hasn't landed. This includes multi-repo changes where any repo is still in progress. | none | no |
| closed, work not in `<branch>` | No folder, the branch exists locally, and its work hasn't landed. | `weave change switch <id>` | no |
| closed, couldn't check whether it landed | No folder, the branch exists locally, and the check couldn't run. | `weave change switch <id>` | no |
| done | No folder, and the work has landed or its files are on main. Shown only with `--all`. | none | no |

**Precedence.** When more than one state fits, the first in this order wins: folder missing, landed with newer commits, landed, in progress. Closed and done apply only when there is no folder. The winning state carries a note about the others, for example "folder missing (work already landed in main)", and the next step adapts. In that example, the next step is close only.

**Labels**

- **N uncommitted files in folder**: only on landed states.
- **no commits yet**: on in progress.
- **couldn't check whether this landed: `<reason>`**: on in progress.
- **branch deleted on origin; it may have landed**: on in progress.
- **starting branch unknown**: on any state measured against the default-branch fallback.

**Transitions**

- in progress → landed, or landed with newer commits: the work reaches the starting branch, as seen after a refresh.
- landed → landed with newer commits: new commits are added after landing.
- any state with a folder → folder missing: the folder disappears outside Weave.
- folder missing → in progress, or a landed state: `weave change switch` recreates the folder.
- folder missing, or any state with a folder → closed or done: `weave change close`. A change becomes done if its work landed, and closed otherwise.
- closed → in progress: `weave change switch`.
- closed or done → no longer listed by default: the branch is deleted. A done change stays visible with `--all` only if its files are on main.

**Invalid transitions**

- `weave change list` and `weave status` never move a change between states by acting on it. They only observe.
- `close` never succeeds on a folder kept on purpose, or on a landed change with uncommitted files.
- Nothing treats landed with newer commits as safe to delete.

## Notifications and Visibility

- **`weave status`**: one line, only when something needs attention: `2 changes need attention (1 landed, 1 folder missing). Run 'weave change list'.` It counts only this repo's or workspace's changes, and may briefly lag behind the list.
- **No other commands** gain a notice.
- **Data age**: every list answer shows how old its information is, per change only when its repos differ or a refresh failed, and otherwise in one shared line at the end. A fresh `--fetch` answer shows no age.
- **Refresh problems**: shown with the age, for example "couldn't refresh: origin needs a login", "(couldn't reach origin)", or "(last refresh timed out)".
- **Refresh in flight**: when a refresh has just started or is running, the age line adds "refreshing now, run again in a few seconds for the latest", and `--json` carries `refreshing: true`.
- **Unavailable folders**: one line at the top of the list.
- **`--json`**: carries the state, notes, labels, a separate couldn't-check field, the next-step command, the slot, the folder (existing folders only), a missing folder's recorded location, a reason when planning-file fields are empty, and each repo's data age and refresh status. `weave status --json` carries the attention count.

## Edge Cases

- **Run in one project on a machine with several**: only that repo's or workspace's changes are listed and counted.
- **Planning-only change with no commits**: in progress with "no commits yet". It's never landed, and its uncommitted planning files get no label.
- **Stacked change** merged into its parent branch: "landed in `<parent>`, not in main yet". After close, it's still measured against the parent, because the starting branch is remembered.
- **Starting branch deleted** after it merged: Weave measures against the repo's default branch instead.
- **Starting branch unknown**, as with an old branch from before this change: Weave measures against the default branch and shows "starting branch unknown".
- **Repo with no remote**: Weave compares locally, there's no refresh, and no age is shown.
- **Main later changed the same lines** after a squash merge: the check says not landed. If the remote branch is gone, the change is labelled "may have landed".
- **Check can't run** (missing branches, an unreadable repo): in progress with "couldn't check" and the reason. With no folder, the state is "closed, couldn't check whether it landed".
- **Git older than 2.38**: normal and rebase merges are still recognised. Only changes needing squash detection are marked couldn't check.
- **Offline, or remote unreachable**: the list answers from the last fetch with its age, and the next list says it couldn't refresh.
- **Remote needs a login**: Weave never prompts, skips that repo, and says so.
- **Refresh hangs**: it's given up after about 30 seconds per repo, and the list says "(last refresh timed out)". The next refresh can start.
- **`--fetch` while a background refresh runs**: it joins that refresh instead of starting a second one.
- **List run repeatedly**, for example by an agent: at most one refresh runs, and none starts within a minute of the last.
- **List run right after a merge**: it may still show in progress, with "refreshing now, run again in a few seconds for the latest". The next run, or `--fetch`, shows landed.
- **Agent deciding nothing needs cleanup**: it uses `--fetch` first, so it doesn't report from old remote data.
- **Folder deleted, and its work had already landed**: folder missing, with the note "work already landed in main". The next step is close only.
- **Folder deleted with nothing committed**: folder missing, with "(title unknown)". Weave says the planning files can't be recovered and offers only `close`.
- **Folder moved or renamed**: "folder not found at `<path>`", and `close` warns first.
- **Changes location unavailable**, for example an unmounted drive: reported once at the top, with nothing counted and no `close` suggested.
- **Folder kept on purpose**: listed but not counted. `close` refuses, and Weave says how to unmark it.
- **Git cleared its own record** after about three months: still folder missing. The branch is no longer blocked, and `close` cleans up Weave's record.
- **Recreated folder whose old slot is taken**: it gets a new slot, and Weave says so.
- **Recreated folder previously set up**: setup counts as not run.
- **Landed with uncommitted files**: "N uncommitted files in folder", and the next step is to commit or discard them, then close.
- **Landed, then more commits**: landed with newer commits. Not counted, and not safe to delete.
- **Multi-repo, one repo in progress**: in progress, with per-repo lines, not counted.
- **Multi-repo, one repo landed with newer commits and the rest landed**: landed with newer commits, naming the repo.
- **Multi-repo with one repo's folder missing**: folder missing, and the per-repo line names the repo.
- **A repo with no commits on a multi-repo change**: ignored when deciding landed.
- **Many old local `change/` branches after upgrading**: landed ones are done and hidden, and unlanded ones show as closed.
- **Local branch that isn't a Weave change**: ignored.
- **Existing script reading `--json`** for a change with no planning files: the fields are empty with a reason. No field is renamed or removed, and the folder field is never set to a missing folder.
- **Existing script looking up a past change by id**: not found by default. It needs `--all`, and the release notes say so.
- **`weave status` before any list has run**: no line.
- **Running from a subfolder of a change folder**: the same list and the same `weave status` line as from the main checkout.

## Acceptance Criteria

- [ ] `weave change list` lists only the changes of the repo or workspace it runs in, and gives the same list from the main checkout, any change folder, and any subfolder.
- [ ] Each listed change has exactly one state from the states table, and a next-step command where the table gives one.
- [ ] State names, notes, labels, and next-step commands are identical in text and `--json`.
- [ ] Every next-step command shown succeeds when run as given in the situation it is shown for, or is refused only for the reasons the list itself states.
- [ ] Each change's first line matches today's (active marker, id, type, stage, title), with "(title unknown)" when planning files are gone. The folder and slot still appear.
- [ ] A normal merge, a rebased merge, and a squash merge into the starting branch each show as "landed in `<branch>`" with the matching method.
- [ ] A stacked change merged into its parent shows "landed in `<parent>`, not in main yet", and is still measured against the parent after close.
- [ ] A change whose starting branch is unknown is measured against the default branch and labelled "starting branch unknown".
- [ ] A change with no commits since its starting point is never shown as landed.
- [ ] A landed change with later unlanded commits, including after a squash, shows as landed with newer commits, is not counted, and is not treated as safe to delete.
- [ ] A multi-repo change takes the state of its least-finished repo with commits, and shows per-repo lines.
- [ ] When the landed check can't run, the change shows a couldn't-check label and reason, and `--json` has a separate field for it. A branch with no folder becomes "closed, couldn't check whether it landed".
- [ ] On git older than 2.38, normal and rebase merges are still recognised.
- [ ] When the remote branch is deleted and no landing was found, the change shows the "may have landed" label.
- [ ] `weave change list` returns without waiting on the network, and shows the age of its answer.
- [ ] Local facts (folders, uncommitted files, local commits and branches) are current on every list. Only remote-derived facts may lag, and old data never makes a change show landed.
- [ ] When a refresh has just started or is running, the age line says "refreshing now, run again in a few seconds for the latest", and `--json` has `refreshing: true`.
- [ ] Weave's own skills use `weave change list --fetch --json` before closing a change or reporting that nothing needs cleanup.
- [ ] After a list, a background refresh updates what the next list shows. At most one refresh runs at a time, and none starts within a minute of the last.
- [ ] A refresh that hangs is given up after about 30 seconds per repo, the list says it timed out, and later refreshes are not blocked.
- [ ] `weave change list --fetch` waits and shows the refreshed state. It joins a running refresh instead of starting another, and reports if the refresh didn't finish.
- [ ] No list or refresh ever prompts for a login. A repo that needs one is reported as such.
- [ ] Offline, the list still answers from the last fetch, and says it couldn't refresh.
- [ ] `weave change list` changes no branches, files, folders, or slots.
- [ ] No existing `weave change list --json` field is renamed, removed, or changed in meaning. Fields without a source are empty with a reason, and the folder field never names a missing folder.
- [ ] Past changes appear only with `--all`, in the done state.
- [ ] A local branch without a folder whose work hasn't landed shows as "closed, work not in `<branch>`" by default.
- [ ] Local `change/` branches that don't contain a Weave change are not listed.
- [ ] Changes that exist only on the remote, and changes of other repos or workspaces, are not listed.
- [ ] `weave status` shows the attention line, with the exact wording and correct per-state counts, only when a change is landed or folder missing. Otherwise it shows nothing.
- [ ] `weave status` never contacts the remote, shows the line from the main checkout, change folders, and subfolders alike, and counts only that repo's or workspace's changes.
- [ ] `weave status --json` includes the attention count.
- [ ] A landed change with uncommitted files shows "N uncommitted files in folder", with the next step "commit or discard the N uncommitted files, then `weave change close <id>`".
- [ ] A folder deleted by hand shows as "folder missing: not found at `<path>`", and is counted.
- [ ] `weave change close <id>` on a folder missing change clears git's and Weave's leftovers, frees the slot, keeps the branch and the remembered starting branch, and warns about moved folders. Afterwards the branch can be deleted and checked out.
- [ ] `weave change close` refuses a folder kept on purpose and says how to unmark it.
- [ ] `weave change switch <id>` recreates a missing folder from committed work.
- [ ] A recreated folder keeps its slot if free. Otherwise it gets a new slot, and the change is announced.
- [ ] A recreated folder's setup is treated as not run.
- [ ] A missing folder with nothing committed offers only `close`, and says the planning files can't be recovered.
- [ ] A missing changes location is reported once at the top, with nothing counted and no `close` suggested.
- [ ] Nothing is cleaned up without an explicit `close`.
- [ ] In-place checkouts behave exactly as today.

## Rollout Considerations

- **Scope**: worktree-mode repos and workspaces only. In-place checkouts are unchanged.
- **No setting, gradual rollout, or compatibility flag**: it ships on by default in the next Weave release.
- **No migration**: existing folders, records, and branches are read as they are. For older changes, Weave tries to recover the starting branch, and labels it unknown when it can't.
- **Visible change to `weave change list`**: past changes from main move behind `--all`, and new indented lines appear for state, labels, next step, and age. Release notes should say so.
- **Agents and scripts**: no `--json` field is renamed, removed, or changes meaning, but new fields appear, and past changes need `--all`. Release notes should say so.
- **First run after upgrading**: may show some old local `change/` branches as closed, with work not landed. Release notes should explain that this is intended.
- **Git version**: squash detection needs git 2.38 or newer. Release notes should say what older git users see.
- **Coordination**: this change builds the shared landed check. `261107-6c16-close-delete-merged` reuses it, and deletes only changes in the landed state.
- **Communication**: update the knowledge wiki pages for `weave status`, `weave change list`, `close`, `switch`, and change checkouts.

## Analytics and Success Metrics

Weave collects no usage analytics, and adding them is out of scope, so success is judged by what developers and agents can do.

- A developer can identify every change safe to close from one `weave change list`, without checking git by hand.
- Deleting a folder by hand no longer leaves a branch blocked once `close` has run.
- Agents act on `--json` without asking the developer what a state means.
- Existing scripts that read `weave change list --json` keep working after the upgrade.
- No reports of `close` or `switch` suggestions failing when run as shown.
- Few reports of merged changes left showing as in progress. Such reports would be a reason to revisit the deferred GitHub lookup.

## Revision History

- 2026-11-08: Initial PRD generated from `exploration.md`, after the stress test (holds-with-changes).
- 2026-11-08: Revised after a second, short stress test (holds-with-changes). All assumptions and open questions in `exploration.md` are now resolved. The changes:
  - Scope is the repo or workspace the command runs in, not the whole machine.
  - Weave remembers each change's starting branch separately from its folder, tries to recover it for old branches, and labels unknown ones.
  - Only landed is safe to delete. Landed with newer commits is not, and multi-repo changes follow the least-finished repo.
  - Refresh rules are refined: one refresh at a time, skipped within a minute, a 30-second limit, and `--fetch` joining a running refresh.
  - The layout keeps today's lines and adds indented ones.
  - The uncommitted-files label is reworded, with an adapted next step.
  - New `--json` compatibility rules.
  - A git version rule: squash detection needs 2.38, and normal and rebase merges work on older git.
  - A new state: "closed, couldn't check whether it landed".
  - Superseded from the first version: "this machine" wording, the bare "uncommitted work" label, `close` as the only next step for landed changes, and the earlier "`--json` only adds fields" phrasing.

- 2026-11-08: Clarified during architecture.
  - Only remote-derived facts may lag, and old data only under-reports landing.
  - A "refreshing now" hint appears in text, and `refreshing: true` in `--json`, when a refresh is running.
  - Weave's skills and agent guidance use `--fetch --json` before closing changes or reporting that nothing needs cleanup.

## Assumptions

- The git 2.38 minimum for squash detection comes from general git knowledge. A local test on git 2.50.1 confirmed the detection itself, but older versions weren't tried. Engineering confirms the exact minimum.
- About 30 seconds per repo is long enough for a normal fetch and short enough that a stuck refresh doesn't hide problems for long. Engineering may tune it.
- Git's own record of where a branch was created is usually available for recovering old branches' starting branches. When it isn't, the "starting branch unknown" fallback applies.

## Open Questions

None. Exact `--json` field names, and how the starting branch is stored and recovered, are left to design. They aren't product decisions.

## Out of Scope

- Automatic cleanup of folders, records, or slots.
- Deleting branches, which belongs to `261107-6c16-close-delete-merged`.
- Idle or "last used" tracking.
- Pull request lookups on GitHub or other hosts.
- Remote-only changes in the list.
- Changes of other repos or workspaces on the same machine.
- In-place checkouts.
- New notices on Tier 1 commands other than `weave status`.
- A scheduled job, or any other always-running background process.
- Usage analytics.

## Further Notes

- Options considered and rejected:
  - Flagging only broken folders in `weave status`: solves the rarer problem.
  - Flagging only landed changes in `weave status`: misses missing folders, and puts detail in the wrong place.
  - A full folder overview in `weave status`: turns a quick check into a slow dashboard.
  - A notice on all Tier 1 commands: changes six commands' output, and invites people to ignore it.
  - Waiting up to about 2 seconds for each refresh: slower, and often falls back anyway.
  - A scheduled refresh job: installs something that runs all the time.
  - Relying on git's own background maintenance: off for most people.
  - A one-line-per-change layout: drops title, type, stage, folder, and slot.
  - GitHub pull request lookup: deferred as a possible later addition.
- The umbrella phrase is "need attention", never "stale", because "stale" already means a planning document needs updating.
- Engineering may want recorded decisions for plain-git landed detection, the background refresh, the shared landed definition, and where the starting branch is remembered.
- A local git test of merge detection is recorded in `research.md` under External Dependencies.
- Design rationale is in `sessions/20261108-180441-xego-exploration-stress-test.md` and `sessions/20261108-183313-rtfn-exploration-stress-test.md`.
