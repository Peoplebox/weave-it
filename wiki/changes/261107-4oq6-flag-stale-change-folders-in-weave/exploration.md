---
artifact: exploration
status: draft
owner: product
created_at: 2026-11-07T11:22:53.092Z
updated_at: 2026-11-08T13:03:13.000Z
reviewed_at: null
approved_at: null
approved_by: null
source: discussion
---

# Flag Stale Change Folders In Weave Status

## Topic

Flag stale change folders in weave status: tell a developer, and the AI agents working alongside them, which of this repo's or workspace's change folders need attention and what happened to each change.

## Problem

A developer using worktree checkouts gets a new folder for every change, and the folders pile up next to the main checkout. Some changes have already landed, some folders were deleted by hand, and some are still being worked on. Nothing in Weave says which is which. To decide what to clean up, the developer has to remember each change or check git by hand, and an agent has no way to tell at all. A folder deleted by hand also leaves leftovers behind: the change's branch can't be deleted or checked out, and Weave quietly loses track of the change.

## Existing Behavior

- `weave status` reports only the Weave version, whether installed skills are current, and any notices, for the folder it runs in. It says nothing about changes or their folders. The wiki calls it the place to go when you ask "where do I stand?"
- `weave change list` covers only the repo or workspace it runs in: that repo's main checkout and its change folders. Each line shows the id, type, stage, and title, then the folder and slot. Run from the main checkout, it also lists every past change whose planning files reached main, with no folder. A change whose folder was deleted by hand disappears from the list. A closed change disappears too, unless its planning files have already reached main.
- `weave change status` describes the one change you are in.
- `weave change close` is the only way Weave removes a folder. It refuses if there is uncommitted work, never deletes branches, and frees the slot.
- When a folder is deleted by hand, git still treats it as in use. That blocks deleting or checking out its branch anywhere until git's record is cleared, which git does by itself only after about three months. `close` then says the change doesn't exist, so it can't clean up. `switch` says it reopened the folder but doesn't recreate it. The slot can be given to another change while Weave's record of the old one stays behind, still marked as set up.
- Weave writes a change's planning files into its folder but never commits them.
- Weave records each repo's starting branch only in the change's planning files, and only for branches it created itself.
- Weave can't tell whether a change's work has landed, and it doesn't use commit dates.
- "Stale" already means something in Weave: a planning document that needs updating because an earlier one changed. Folders need a different word.

## Options Considered

### A. Broken folders only — Rejected

- What it means for users: `weave status` lists folders deleted by hand that are still registered, with a cleanup command.
- Trade-offs: says nothing about finished changes, which are most of the clutter.
- Why rejected: solves the rarer problem. Its cleanup part survives in the chosen direction.

### B. Finished work in `weave status` — Rejected as a standalone option

- What it means for users: `weave status` flags folders whose work has landed and suggests closing them.
- Trade-offs: squash and rebase merges are harder to recognise, and the answer depends on how recently the remote was fetched.
- Why rejected: on its own it leaves out missing folders and puts the detail in the wrong place. Its "has this landed?" check is the core of the chosen direction.

### C. Folder overview in `weave status` — Rejected

- What it means for users: a new section in `weave status` lists every change folder with a one-word state.
- Trade-offs: turns a quick version-and-skills check into a dashboard that gets slower and noisier as folders pile up.
- Why rejected: the overview belongs in `weave change list`, with `weave status` only pointing to it.

### D. A notice on every Tier 1 command — Rejected

- What it means for users: commands that already show notices add "N change folders need attention".
- Trade-offs: changes the output of six commands, and the wiki treats a new notice kind as a deliberate decision. People get used to notices and ignore them.
- Why rejected: one line in `weave status` is enough for now.

### E. `weave change list` tells each change's story, `weave status` points to it — Chosen

- What it means for users: one command shows what happened to every change in this repo or workspace and what to do next, in words both developers and agents can act on. `weave status` says when something needs attention.
- Trade-offs: the list's answer can be minutes old, or older after a break, because the refresh happens in the background. Squash and rebase detection can be fooled if main later changes the same lines.
- Why chosen: it puts the detail where people already look for changes, keeps `weave status` short while staying true to its "where do I stand?" role, and makes every suggested next step actually work.

### Landed detection through GitHub pull requests — Deferred

- What it means for users: asks GitHub whether the change's pull request was merged, which is certain even for squash merges.
- Trade-offs: depends on GitHub, a logged-in `gh`, and a network call per change. It doesn't help on other hosts.
- Why deferred: plain git works with any host and catches most squash and rebase merges. It could come later as an optional extra.

### Refreshing: wait with a time limit, a scheduled job, or git's own maintenance — Rejected

- What it means for users: the list waits up to about 2 seconds for a fresh fetch, or a job on the machine refreshes every few minutes, or Weave relies on git's hourly background fetch.
- Trade-offs: waiting makes every list slower and still falls back often in workspace mode. A scheduled job installs something that runs all the time on every machine. Git's maintenance is off for most people and only hourly.
- Why rejected: a background refresh after each list is always instant, almost always recent, never hangs, and installs nothing.

### A single-line layout per change — Rejected

- What it means for users: each change takes one line, with id, state, and next step.
- Trade-offs: drops the title, type, stage, folder, and slot that today's list shows, and has no room for labels or per-repo refresh problems.
- Why rejected: slot matters for ports, and ids without titles are hard to recognise. Today's layout with indented additions keeps everything.

## Chosen Direction

**Scope.** `weave change list` covers only the repo or workspace it runs in: its main checkout, its change folders, their leftovers, and its local branches. It never includes other repos or workspaces on the same machine. Running it from the main checkout, from any change folder, or from any subfolder of either gives the same list. `weave change status` remains the command for the single change you are in, much like `git status`. `weave change list` is closer to `git branch`: it shows every change, because the ones needing attention are usually not the one you're in.

Each change gets exactly one state, a short note where useful, and one suggested next step. State names, notes, labels, and next-step commands are fixed and identical in text and `--json`, so a developer and an agent read the same thing.

"Landed" always names the branch the change was measured against, which is the branch it started from: for example "landed in main (squashed)", or "landed in change/worktrees, not in main yet".

| State | Meaning | Suggested next step | Counts as "need attention" |
| --- | --- | --- | --- |
| folder missing | The folder is not found at its recorded place, but the change is still registered. | `weave change close <id>` to clean up; `weave change switch <id>` to bring it back, only when the branch has the change's files committed | yes |
| folder missing (kept on purpose) | As above, but the folder was marked in git to be kept. | unmark it first (the list says how) | no |
| landed, with newer commits | The work landed, and there are commits after that point which haven't. Not safe to delete. | review the newer commits before closing | no |
| landed (merged / rebased / squashed) | All of the change's work is in the branch it started from. The only state that is safe to delete. | `weave change close <id>`; with uncommitted files, "commit or discard the N uncommitted files, then `weave change close <id>`" | yes |
| in progress | The folder is there and the work hasn't landed. Includes multi-repo changes where any repo is still in progress. | none | no |
| closed, work not in `<branch>` | No folder, the branch still exists here, and its work hasn't landed. | `weave change switch <id>` to pick it back up | no |
| closed, couldn't check whether it landed | No folder, the branch still exists here, and the landed check couldn't run. Weave claims neither way. | `weave change switch <id>` | no |
| done | No folder, and its work has landed or its files are on main. Shown only with `--all`. | none | no |

When more than one state fits, the first in this order wins: folder missing, landed with newer commits, landed, in progress. Closed and done apply only when there is no folder at all. The winning state carries a note about the others, for example "folder missing (work already landed in main)", and its next step adapts: close to clean up, with no need to bring it back. Each change counts once.

**Labels**

- **N uncommitted files in folder**: shown only on landed states, because uncommitted files are what stop `close`. It describes the folder, not the landed work, which is all committed. When present, the next step becomes "commit or discard the N uncommitted files, then `weave change close <id>`". Uncommitted files, including Weave's planning files, are normal on in-progress changes and get no label.
- **no commits yet**: in progress, with nothing committed since the starting point. A stacked change doesn't inherit its parent's commits.
- **couldn't check whether this landed: `<reason>`**: Weave couldn't run the check at all, for example because the starting and default branches are both missing, a repo can't be read, or git is too old for squash detection. The change stays in progress, and `--json` carries this as its own field so an agent never mistakes it for a confirmed answer.
- **branch deleted on origin; it may have landed**: the check found no landing, but the remote branch is gone. This usually means a merge the check missed.
- **starting branch unknown**: Weave fell back to the default branch because it doesn't know where the change started. For example: "landed in main (starting branch unknown)".

**Which changes appear by default.** This repo's or workspace's changes that still have something here: a folder, a missing-folder leftover, or a local `change/<id>` branch whose work hasn't landed or couldn't be checked. Past changes whose work has landed, or whose files are on main with no folder or branch, are *done* and appear only with `--all`. This is a deliberate change to today's list, which shows every past change from main. Branches that don't contain a Weave change are ignored. Changes that exist only on the remote, such as a teammate's branch never opened here, are not listed, because `weave change switch` already opens those. The first run after upgrading may show a few old branches whose work never landed. That is intended, and there is nothing to migrate.

**How "landed" is decided.** Weave measures against the branch each repo's change started from.

- **Remembering the starting branch.** Weave remembers each change's starting branch per repo, separately from the folder, and keeps that record after `close` and after a folder disappears. It is small, so it never needs cleaning up. For branches from before this change, Weave tries to recover the starting branch from git's own record of where the branch was created; how is for design.
- **Fallback.** If the starting branch is unknown or no longer exists, Weave uses the repo's default branch and adds the *starting branch unknown* label when the branch was unknown.
- **The check.** Plain git, with any host. It recognises normal merges, rebases, and squashes. A change has landed when merging it into that branch would change nothing. It can be fooled when that branch later changed the same lines, which is one reason to close changes soon after they land.
- **No commits.** A change with no commits since its starting point is never landed.
- **Newer commits.** "Landed, with newer commits" is recognised after a squash merge too, by checking earlier points on the branch, not just the newest commit.
- **Git version.** Squash detection needs git 2.38 or newer. Normal and rebase merges are recognised on older git too. On older git, only a change that would need squash detection gets the couldn't-check label.
- **Shared definition.** `261107-6c16-close-delete-merged` uses exactly the same definition. Only *landed* means safe to delete. *Landed, with newer commits* is explicitly not safe, because it has work that exists nowhere else. Anything this list calls landed, that change treats as safe to delete, and the reverse.

**Freshness.** `weave change list` answers instantly from what is already known, then starts a background refresh from the remote for next time and returns without waiting. Every answer shows its age, for example "as of last fetch, 2 hours ago".

- **Login.** The refresh never asks for a password or passphrase. If a login would be needed, it skips that repo, and the list says "couldn't refresh: origin needs a login".
- **One at a time.** Only one refresh runs at a time. A new background refresh is skipped if the last one started less than a minute ago.
- **Time limit.** Every refresh gives up after a time limit of about 30 seconds per repo. A refresh still marked as running after that counts as dead, so the next one can start. When a refresh fails or gives up, the list says why, for example "as of last fetch, 3 days ago (last refresh timed out)". A growing age always comes with a reason.
- **`--fetch`.** It waits for a fresh answer. If a refresh is already running, it joins it rather than starting another, waits for it, and answers from it. Otherwise it starts one. It waits at most the same time limit, then answers with what it has and says the refresh didn't finish.
- **No remote.** In a repo with no remote, Weave compares locally and shows no age.
- **`--json`.** Gives each repo's data age and, when it wasn't refreshed, why.
- **Read-only.** Apart from updating Weave's copy of what is on the remote, the list never changes branches, files, folders, or slots.

**Layout.** Today's layout stays, and the new parts are indented lines under each change:

```text
change folders unavailable at /Volumes/ext/weave.changes (drive not mounted?)     ← only when it applies

* 261107-4oq6-flag-stale…  feat  prd  Flag stale change folders in weave status
    in progress · no commits yet
    folder: ~/…/261107-4oq6-flag-stale…  (slot 1)
  add-export  feat  slices  Add export
    landed in main (squashed) · 2 uncommitted files in folder
    next: commit or discard the 2 uncommitted files, then weave change close add-export
    folder: ~/…/add-export  (slot 3)
  checkout-v2  feat  slices  Checkout v2
    in progress — api: landed in main (squashed) · web: in progress
    folder: ~/…/checkout-v2  (slot 4)
    as of last fetch: api 12 minutes ago · web 3 hours ago (couldn't refresh: origin needs a login)

as of last fetch, 12 minutes ago
```

- **First line:** exactly as today, with the active marker, id, type, stage, and title. When the planning files are gone, it shows "(title unknown)".
- **Then:** the state with its labels after "·", the next step when there is one, and the folder and slot as today.
- **Age:** a line under a change appears only when its repos' ages differ or a refresh failed. Otherwise one shared age line goes at the end.
- **Unavailable folders:** "change folders unavailable" appears once, at the top, only when it applies.

The `weave status` line reads: `2 changes need attention (1 landed, 1 folder missing). Run 'weave change list'.` Exact `--json` field names are left to design.

**Compatibility for agents and scripts.**

- **The promise:** no `--json` field that `weave change list` has today is renamed, removed, or changes meaning. It does not promise the same set of changes. Hiding past changes by default is deliberate, `--all` brings them back, and release notes say so.
- **Empty fields:** when planning files are gone, fields that come from them (such as title, stage, and the change's path) are left empty, never invented, and a new field says why, for example "planning files not available: folder missing".
- **The folder field:** today's folder field keeps its meaning, a folder that exists. A missing folder's recorded location goes in a new field, so no existing reader is pointed at a folder that isn't there.
- **Text output:** may change, within the layout above.

**Multi-repo changes** (workspace mode). The least-finished repo decides:

- If any repo with commits is in progress, the change is in progress.
- Otherwise, if any repo is landed with newer commits, the change is landed with newer commits, and the per-repo line names the repo.
- Only when every repo with commits is landed is the change landed.
- It is folder missing if any repo's folder is missing, and the per-repo line names which one.
- A repo with no commits on the change doesn't count either way.

**`weave status`.** When something needs attention, it adds one line, for example "2 changes need attention (1 landed, 1 folder missing). Run `weave change list`."

- "Need attention" counts only *landed* and *folder missing*.
- When nothing needs attention, or nothing has been worked out yet, it adds nothing.
- The line appears from anywhere in a worktree-mode repo or workspace (the main checkout, any change folder, any subfolder) and counts that repo's or workspace's changes only.
- It never contacts the remote and never runs the landed check itself. It shows the last known result, so it may briefly lag behind the list.
- `--json` carries the same count.

**Fixes so the suggested steps work.**

- `weave change close <id>` works on a folder missing change. It clears git's leftover record and Weave's own record, frees the slot, and keeps the branch and the remembered starting branch, like a normal close. It warns: "if you moved this folder, move it back first; closing stops tracking it". It refuses for a folder kept on purpose. A person still runs it.
- `weave change switch <id>` recreates a missing folder from committed work instead of claiming it reused one. It keeps the old slot if that slot is still free, and otherwise assigns a new one and says so ("slot 2 was taken, now slot 3"). Setup counts as not yet run for the recreated folder, so the next `weave change setup` runs again. Approvals stay.

**Missing in a different sense.** The list says "folder not found at `<path>`", never "deleted", because the folder may have been moved or renamed. If the whole place where change folders live is missing, for example an unmounted drive, the list says "change folders unavailable at `<path>`" instead of marking each change folder missing, doesn't count them, and doesn't suggest `close`. After git clears its own record of a missing folder, Weave's record still shows the change as folder missing, and `close` cleans up the rest.

`weave change list` and `weave status` never clean anything up. All removal goes through `close`, which a person runs.

## Scenarios

1. **Landed by squash.** Asha's change `add-export` was squash-merged on GitHub yesterday. She runs `weave change list`, which shows `add-export` as *landed in main (squashed)*, as of a fetch 10 minutes ago, with "next: `weave change close add-export`". She closes it and the folder is gone.
2. **Wanting the latest.** Asha just merged a pull request and wants to see it reflected right away. `weave change list --fetch` waits for the refresh and shows the change as landed.
3. **Offline.** On a train with no connection, `weave change list` still answers instantly, labelled "as of last fetch, 3 hours ago". The background refresh fails, and the next list says it couldn't refresh.
4. **Folder deleted by hand.** Ravi deleted the folder for `fix-login` with `rm -rf`, and git now says its branch is in use. `weave status` shows "1 change needs attention (1 folder missing)". `weave change list` shows `fix-login` as *folder missing* with both options. He runs `weave change close fix-login`. The leftovers are cleared, the slot is freed, and the branch can now be deleted.
5. **Bringing a missing folder back.** Ravi actually wanted `fix-login` back. `weave change switch fix-login` recreates the folder from committed work. His old slot went to another change in the meantime, so he's told "slot 2 was taken, now slot 3". His next `weave change setup` runs setup again.
6. **Nothing to bring back.** Mei deleted the folder of a change that was only in planning and had no commits. The list shows "folder missing: nothing was committed, so its planning files can't be recovered", with "(title unknown)", and offers only `close`.
7. **Moved, not deleted.** Mei renamed a change folder by hand. The list shows "folder not found at `<path>`". `close` warns her to move it back first if she moved it.
8. **Drive not mounted.** Ravi keeps change folders on an external drive that isn't plugged in. The list says "change folders unavailable at `<path>` (drive not mounted?)" at the top. `weave status` counts nothing, and no change is offered `close`.
9. **Landed, then more work.** Asha's change landed, and then she added two follow-up commits. The list shows *landed, with newer commits*, so she doesn't close it by mistake. `weave status` doesn't count it, and `261107-6c16-close-delete-merged` would not delete it.
10. **Landed with uncommitted files.** A landed change has two uncommitted files in its folder. The list shows "landed in main (squashed) · 2 uncommitted files in folder" with "next: commit or discard the 2 uncommitted files, then `weave change close add-export`".
11. **Planning only.** A change that has just been created shows as *in progress* with *no commits yet*, not as landed, even though its planning files are uncommitted.
12. **Stacked change.** A change started from `change/worktrees` and was merged into it. The list shows *landed in change/worktrees, not in main yet*. After it is closed, `--all` still shows it as *done* measured against `change/worktrees`, because Weave remembered the starting branch after close.
13. **Starting branch unknown.** An old branch from before the upgrade has no recoverable starting branch. The list measures it against main and shows "closed, work not in main (starting branch unknown)".
14. **Multi-repo.** `checkout-v2` touches `api` and `web`. The `api` work was squash-merged, and `web` is still open. The list shows *in progress* with "api: landed in main (squashed) · web: in progress", and `weave status` doesn't count it. If instead `web` had landed and `api` had landed with newer commits, the change would show *landed, with newer commits*, naming `api`.
15. **Old branches after upgrading.** This repo has 15 local `change/` branches from before. After upgrading, those whose work landed are *done* and hidden. The two whose work never landed show as *closed, work not in main*, with `switch` as the next step.
16. **Merge missed by the check.** A teammate renamed a function on main after Asha's squash landed, so the check says not landed. Her remote branch was deleted after the merge, so the list shows *in progress* with "branch deleted on origin; it may have landed".
17. **Old git.** Ravi's machine has git 2.30. Normal and rebase merges are still recognised. A squash-merged closed branch shows "closed, couldn't check whether it landed (git 2.38+ needed)".
18. **Refresh stuck.** A fetch hangs on a bad network. After about 30 seconds it is given up. The list shows "as of last fetch, 3 days ago (last refresh timed out)", and the next list can start a new refresh.
19. **Agent runs `--fetch` during a refresh.** An agent runs `weave change list` and immediately `weave change list --fetch`. The second call joins the refresh the first one started and answers from it, instead of starting a second fetch.
20. **An agent cleaning up.** An agent runs `weave change list --json`, finds changes in the *landed* state with no uncommitted files, and runs their next-step command, `weave change close <id>`, as given. It skips anything marked *couldn't check* and anything *landed, with newer commits*.
21. **Existing script.** A script that reads today's `weave change list --json` fields keeps working. For a folder missing change it sees an empty title and stage, plus a new field explaining that the planning files aren't available.
22. **Two projects on one machine.** Asha has `weave-it` and another project, each with change folders. `weave change list` in `weave-it` shows only `weave-it`'s changes, and `weave status` there counts only those.
23. **Nothing to report.** All changes are in progress. `weave status` looks exactly as it does today.

## Decisions

- The detail lives in `weave change list`, and `weave status` gets one pointer line. — Keeps `weave status` quick while staying true to its "where do I stand?" role.
- `weave change list` and the `weave status` line cover only the repo or workspace they run in, never other repos or workspaces on the machine, and give the same answer from the main checkout, any change folder, or any subfolder. `weave change status` remains the single-change view. — Like `git branch` and `git status`: the list is about this project's changes, and the changes needing attention are usually not the one you're in.
- Output must read cleanly for developers and AI agents: fixed state names in text and `--json`, a fixed next-step command per state, and plain wording. — Weave is a developer tool that agents drive too.
- No new notice on other commands. — Adding a notice kind changes six commands' output, and the wiki treats it as a deliberate decision.
- The states are as in the table under Chosen Direction. A fixed order picks one, and each change counts once. — Every change gets one unambiguous answer and one count.
- "Need attention" counts only *landed* and *folder missing*. — Only things you can act on now, so the line isn't ignored.
- Idle time is left out of this version. — Weave doesn't track it today, and it's a judgement rather than a fact.
- The umbrella phrase is "need attention", never "stale". — "Stale" already means planning documents that need updating.
- By default the list shows only changes with something here, and past changes appear with `--all` as *done*. This is a deliberate change to today's list. — Keeps the list about current work without losing history.
- Branches without a folder are *done* if their work landed, *closed, work not in `<branch>`* if it didn't, and *closed, couldn't check whether it landed* if the check couldn't run. Non-Weave branches are ignored. — Surfaces forgotten work without flooding the list after an upgrade, and never claims something Weave didn't check.
- Remote-only changes are not listed. — The list is about local work, and `switch` already opens remote branches.
- "Landed" is measured against the branch the change started from, which is always named. — Stacked changes and non-`main` repos get true answers, and naming the branch is easiest to read.
- Weave remembers each change's starting branch per repo, separately from the folder, keeps it after close and after a folder disappears, and tries to recover it for older branches. When it's still unknown, Weave falls back to the default branch with a *starting branch unknown* label. — The starting branch is otherwise lost exactly when it's needed: after close, after a deletion, and for old branches. A visible fallback beats a silent mislabel.
- Landed is detected with plain git for any host, including squash and rebase merges. GitHub pull request lookup is deferred. — Works everywhere without extra logins.
- "Landed" has exactly one definition, owned by this change's PRD and built by this change. `261107-6c16-close-delete-merged` reuses it. Only *landed* is safe to delete, and *landed, with newer commits* is explicitly not. — The two changes must never contradict each other, and commits that never landed must never be deleted.
- A multi-repo change takes the state of its least-finished repo: in progress, then landed with newer commits, then landed. — A half-merged change must not be closed or deleted by mistake.
- A change with no commits since its starting point is never landed. — Otherwise every new or stacked change would look landed.
- Checked-and-not-landed is plain *in progress*. Couldn't-check is labelled with its reason and carried as its own `--json` field. A deleted remote branch with no landing found gets a "may have landed" label. — Honest about uncertainty, without counting guesses as attention.
- Squash detection requires git 2.38 or newer. Normal and rebase merges are recognised on any supported git, and only squash cases get the couldn't-check label on older git. — Older machines still get real answers for most changes. The 2.38 minimum is to be confirmed in design.
- The "may have landed" label is only a hint. — If a team doesn't delete merged branches, the label simply never appears, and nothing breaks.
- The list answers instantly and refreshes in the background for next time, `--fetch` waits for a fresh answer, and every answer shows its age. — The user wants instant results that are as recent as possible, without the list ever hanging.
- One refresh runs at a time. A background refresh is skipped within a minute of the last. Every refresh gives up after about 30 seconds per repo, and a dead one doesn't block the next. `--fetch` joins a running refresh instead of starting another. — Avoids piling up network calls, avoids two fetches tripping over each other, and makes sure a stuck refresh never freezes the age silently.
- The refresh never prompts for a login. — The list must never hang, and agents can't type passwords.
- Answers that are old after a long break are an accepted risk. — Every answer shows its age, with a reason when a refresh failed, and `--fetch` is there when it matters.
- `weave status` never contacts the remote and never runs the landed check, and it shows the last known result. — It must stay fast. Briefly lagging the list is acceptable.
- Uncommitted files are labelled only on landed states, as "N uncommitted files in folder", and the next step becomes "commit or discard them, then close". — The label must not read as if the landed work were uncommitted, and the suggested step must work.
- The list keeps today's layout, and adds the state, labels, next step, and per-change age as indented lines, with "(title unknown)" when planning files are gone and the unavailable-folders message at the top. — Keeps the title, type, stage, folder, and slot people rely on, and gives every new piece a place.
- `--json` never renames or removes a field, or changes its meaning. Fields with no source are left empty with a reason, and a missing folder's location goes in a new field. Hiding past changes by default is deliberate, with release notes. — Existing agents and scripts keep working, and are never pointed at a folder that doesn't exist.
- `close` and `switch` are fixed in this change to handle a missing folder. — The list's suggested next steps must work.
- `switch` is offered only when there is committed work to restore, and says it restores committed work only. — A suggestion that fails is worse than none.
- A recreated folder keeps its slot only if the slot is free, and its setup counts as not yet run. — Prevents two changes sharing ports, and prevents a false "setup complete".
- Missing folders are described as "not found", `close` warns about moved folders, an unavailable changes location is reported once, and folders kept on purpose are respected. — Avoids discarding work that still exists somewhere else.
- Commits that only touch planning files count as work that should land. — Planning files belong on main too.
- Nothing is cleaned up automatically. `list` and `status` change nothing except Weave's copy of what is on the remote. — Matches the wiki: removal is something a person runs.
- Worktree mode only. In-place checkouts are unchanged. — Change folders exist only in worktree mode.
- No setting or gradual rollout, and no compatibility flag. — Read-only reporting plus fixes to existing commands, with nothing to migrate.
- The `weave status` wording is fixed as shown, and exact `--json` field names are left to design. — Fixes what developers and agents read, and leaves the data format to engineering.
- Success is judged by what developers and agents can do, without usage tracking. — Weave has no analytics, and adding them is out of scope.

## Assumptions

None open. Each earlier assumption was confirmed or turned into a decision on 2026-11-08:

- **Plain-git detection of squash and rebase merges:** confirmed by a local git test, recorded in research.md under External Dependencies. Normal, squash, and rebase merges were detected; unmerged work wasn't; and both known traps showed up as expected (an empty branch, and a later edit to the same lines on main). The 2.38 minimum for squash detection is now a decision, to be confirmed in design.
- **Teams deleting merged remote branches:** now a decision that the label is only a hint.
- **Regular use keeping answers fresh:** now an accepted risk, covered by age labels with reasons and `--fetch`.
- **Planning-only commits count as work:** now a decision.
- **The starting branch is always known:** wrong. Weave records it only in uncommitted planning files, and only for branches it created. Remembering it separately, recovering it for old branches, and labelling the fallback are now decisions.

`weave-architect` may want recorded decisions for lasting choices here: plain-git landed detection, the background refresh, the shared landed definition, and where the starting branch is remembered.

## Open Questions

None. Resolved on 2026-11-08:

- **Which change builds the shared landed check first:** this one (see Decisions).
- **Wording and layout:** fixed under **Layout**, with `--json` field names left to design.
- **Skipping a refresh when one just ran:** yes, within a minute, with one refresh at a time and the time limit above.

## PRD Readiness

Ready
