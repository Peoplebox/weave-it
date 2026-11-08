---
id: 261108-4ko1-remote-state-refreshes-in-the-background-into-weave-only-refs
title: Remote state refreshes in the background into Weave-only refs
status: accepted
date: 2026-11-08
owner: arpit016
change: 261107-4oq6-flag-stale-change-folders-in-weave
applies_to:
  - src/lib/change-refresh.ts
  - src/lib/git.ts
  - src/lib/changes.ts
  - src/lib/change-facts.ts
  - src/lib/status.ts
  - src/commands/change.ts
supersedes: []
superseded_by: null
---

# Remote state refreshes in the background into Weave-only refs

## Context

`weave change list` must be instant for developers and agents, yet show remote facts (merged on origin, branch deleted on origin) that are as recent as possible. It must never prompt for credentials, and it promises to change nothing except Weave's own copy of the remote. Weave already spawns itself detached for `weave advance --detach` (`src/lib/advance.ts:495`), and fetches only during change creation and switch.

## Decision

After printing, `weave change list` spawns a detached, unref'd `weave change refresh`. It runs at most one at a time, with the run tracked in `.git/weave/refresh.json` by pid and start time, and skips a new run within 60 seconds of the last. The refresh:

- runs each repo in parallel, with a 30-second timeout per repo
- lists origin's branches with `ls-remote`, then fetches only the `change/<id>` branches this machine knows about, plus the target branches in use, with named refspecs, `--no-tags --no-write-fetch-head --no-recurse-submodules`, and auto-gc, maintenance, and commit-graph writes turned off
- writes them into `refs/weave/remotes/origin/*`, deleting the refs of known branches that are gone, and records which known branches were seen
- never prompts. Its git child runs in a new session with no controlling terminal, with `GIT_TERMINAL_PROMPT=0`, a failing askpass, `SSH_ASKPASS_REQUIRE=never`, `GCM_INTERACTIVE=never`, and `BatchMode=yes` when the user has no ssh command of their own
- recomputes the states and writes `.git/weave/attention.json`

It never writes `refs/remotes/origin/*`, `FETCH_HEAD`, or tags. Landed checks use the newer of Weave's snapshot and the user's `origin/<t>`; the local `<t>` is used only in repos without `origin`. `--fetch` joins a running refresh or runs one in-process, under the same no-prompt rules. The spawn happens only in worktree mode, from the command layer. See architecture/index.md, Decisions 2 and 4.

## Alternatives Rejected

- **Waiting for a fetch with a short time limit:** slows every list and still falls back often.
- **In-process fire-and-forget,** like the npm check: the process can't exit until the fetch settles, so agents hang.
- **Plain `git fetch origin`:** moves the user's refs without asking, and collides with their own fetches on ref locks.
- **A scheduled job, or git maintenance:** installs always-running work, or depends on a setting most people don't have on.

## Consequences

- The list never waits on the network. Remote facts can be one refresh old, labelled with their age and a "refreshing now" hint, and the lag only under-reports landing.
- A second ref namespace exists in every repo. Like git's own `refs/prefetch/`, it keeps objects reachable until it's pruned, and its commits appear in `git log --all`, though not as decorations by default.
- Weave's view and the user's `origin/*` can differ, so the list says when Weave's is newer.
- Background processes need care in tests (`WEAVE_NO_BACKGROUND_REFRESH=1`) and on platforms without detached spawn.

## Reconsider When

- Windows support is needed and detached spawning proves unreliable there.
- Users ask Weave to keep their own `origin/*` refs fresh.
- The extra refs or objects become a measurable disk cost.
