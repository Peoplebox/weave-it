# Change Folder States

## Purpose

In worktree checkouts, `weave change list` tells developers and agents what each change on this machine needs: whether its work has landed, whether its folder has gone missing, and the one command to run next. `weave status` surfaces the count of changes that need attention. In-place checkouts are unaffected.

## Current Behavior

- **Scope.** `weave change list` lists only the changes of the repo or workspace it runs in, and gives the same list from the main checkout, any change folder, or any subfolder. Facts are gathered from the main checkout (`mainWorktreePath`). `targets[].path` and `active` keep their cwd-based meaning: `active` is true for the change whose `change/<id>` branch is checked out where the command runs.
- **Which changes are listed:**
  - changes with planning files on main (`wiki/changes/*`)
  - changes with a worktree entry on `change/<id>`
  - changes with a Weave folder record (`.git/weave/changes/<id>.yml`)
  - changes with a remembered starting branch (`.git/weave/bases/<id>.yml`)
  - local `change/*` branches whose name matches the change-id pattern (`YYMMDD-xxxx-slug`) and that have a record or a committed `wiki/changes/<id>/status.yml`

  Hand-made branches such as `change/experiment` are ignored. Changes that exist only on the remote are not listed. `done` changes appear only with `--all`.
- **One state per change**, the same in text and `--json`. See the decision table below.
- **Text layout.** Today's first line (active marker, id, type, stage, title, or `(title unknown)`) is kept. Indented under it are:
  - the state line: the state, its labels joined by ` · `, and, for multi-repo changes, ` — <repo>: <repo state> · …`
  - `next: <command>[ | <command>]` or `next: <text>`
  - `folder: <path>  (slot N)` or `folder not found at <path>  (slot N)`
  - for multi-repo changes, an optional per-change age line

  A shared age line ends the list. `change folders unavailable at <path> (drive not mounted?)` appears once at the top when it applies.
- **Freshness.** Local facts are read live on every list: folders, git's worktree records, uncommitted files, local commits, and branches. Remote facts come from the last background refresh, so a change may show `in_progress` briefly after it merged, never `landed` because data is old. The age line reads `as of last fetch, <age>`, plus any refresh problem and ` · refreshing now, run again in a few seconds for the latest` while a refresh runs. A fresh `--fetch` shows no age.
- **Background refresh.** After printing, `list` starts a detached, unref'd `weave change refresh --root <main>` (hidden command). At most one runs at a time; none starts within 60 seconds of the last; each repo gets about 30 seconds. `--fetch` joins a running refresh or runs one in-process and waits. `WEAVE_NO_BACKGROUND_REFRESH=1` disables the spawn.
- **`weave status`** reads only the saved attention snapshot. It prints `<N> change(s) need attention (<n> landed, <m> folder missing). Run 'weave change list'.` when the total is above zero, and adds `changes_attention` to `--json` (`null` without a snapshot or outside worktree mode). See [weave-status](../../../cli-distribution/features/weave-status/behavior.md).

## Domain Model

### Landed (ADR `261108-kl3n`)

A change has landed in a repo when merging its tip into its target would change nothing. That means the tip is an ancestor of the target, or `git merge-tree --write-tree <target> <tip>` yields the target's tree. `src/lib/landed.ts` is the single definition, shared with `261107-6c16-close-delete-merged`.

- **Target:** the remembered starting branch (`origin/` stripped), or the default branch when it's unknown, gone on origin, or no longer resolves.
  - **Repos with `origin`:** only remote-derived refs count (`refs/weave/remotes/origin/<t>`, `refs/remotes/origin/<t>`), and the newer of the two is used. A merge only into a local branch never counts as landed.
  - **Repos without `origin`:** `refs/heads/<t>` is used.
- **No commits:** reported only when the fork point (`base_commit`) is known and `base_commit..tip` is empty.
- **Methods:**
  - `merged`
  - `contained`: the base is unknown and the tip lies on the target's first-parent line. A fast-forward and an empty branch can't be told apart, so the label claims only "nothing left to merge".
  - `rebased`: every `git cherry` mark is `-`. A one-commit squash also reads as `rebased`.
  - `squashed`
- **Newer commits:** found by walking back along the branch's first-parent line, at most 50 commits, for a commit whose work landed. With an unknown base, a merge base that arrived through a merge commit's side parent also counts.
- **Old git:** below git 2.38 (no merge-tree), normal and rebase merges are still found. Anything else is `unchecked`, and one list-level line says git 2.38+ is needed.
- **Object store:** merge-tree runs against a temporary object directory with the real store as an alternate, so checks never write into the repo.
- **Cache:** results go in `.git/weave/landed.json`, keyed `repo:tip:target:base_commit|-`, with at most 1,000 entries. The cache is dropped when git's capabilities change.

### Starting branch (`.git/weave/bases/<id>.yml`)

- **Created:** written at `weave change new` for every new branch (source `created`).
- **Recovered** for other changes, in this order:
  1. the folder's `status.yml` `checkout.repos.<repo>` block
  2. the branch's reflog creation entry. A SHA, `HEAD`, or the change's own `[origin/]change/<id>` is rejected as a branch name, but a SHA or `HEAD` still keeps the fork point.
  3. `unknown`, which gets the `starting_branch_unknown` label
- **Kept:** Weave never deletes it; `close` keeps it.

### Repo set

A repo belongs to a change when it has a worktree entry for `change/<id>` (prunable included) or is listed in `changes/<id>.yml` `repos` (written at create and switch). A closed change's repos are the ones that still have its branch. Repos skipped with `--repo`, and repos registered later, are never `folder missing`.

## Decision Tables

| `state.id` | When | `next` | Needs attention |
| --- | --- | --- | --- |
| `folder_unavailable` | The folder is missing and the changes root is unavailable (its parent is missing, or it's a dangling symlink) | text `reconnect <root>` | no |
| `folder_missing` | A repo's folder is missing and not locked | `close`, plus `switch` when `status.yml` is committed on the branch. Notes: `work already landed in <t>` (close only), or `nothing was committed, so its planning files can't be recovered` (close only) | yes |
| `folder_missing_kept` | Every missing folder is locked (`git worktree lock`) | text `unlock with: git worktree unlock <path>` | no |
| `landed_with_newer_commits` | The least-finished repo with commits landed, and later commits haven't | text `review the newer commits before closing` | no |
| `landed` | Every repo with commits landed | `close`; with uncommitted files, text `commit or discard the N uncommitted files, then weave change close <id>` | yes |
| `in_progress` | A folder exists and the work hasn't landed (or no repo has commits: label `no_commits_yet`) | none | no |
| `closed_not_landed` | No folder, the branch exists, and the work hasn't landed | `switch` when `status.yml` is on the branch; otherwise text `recover the work with: git worktree add <path> change/<id>` | no |
| `closed_unchecked` | No folder, and the check couldn't run | as above | no |
| `done` | No folder, and the work landed, or the branch has no commits, or there's no branch but planning files are on main | none (shown only with `--all`) | no |

Precedence: `folder_unavailable`, `folder_missing`, `folder_missing_kept`, then landed with newer commits, landed, in progress. Closed and done apply only when there is no folder record. A multi-repo change is decided by its least-finished repo with commits; repos with no commits are ignored.

Label ids:
- `uncommitted_files`: landed states only
- `no_commits_yet`
- `couldnt_check`: `in_progress` only, with the reason (`still checking` when the 2-second inline budget ran out)
- `may_have_landed`: the branch was seen on origin and is now absent, with no landing found
- `starting_branch_unknown`
- `local_view_older`: Weave's copy of origin is ahead of the user's `origin/<t>`, shown as "on origin; run git fetch to see it locally"

## Behavioral Rules

- `state.id` and label ids are a stable contract. Label text may be reworded. Agents and skills match on ids (see `weave-next`).
- `--json` is strictly additive to the earlier `ChangeSummary`. Every old field stays with the same meaning. `folder` is set only for existing folders, and a missing one's location goes in `missing_folder`.
- When planning files are unavailable, `id`, `slug`, `branch`, and `path` are still real; `title`, `type`, and `stage` come from a committed `status.yml` on the branch, else `""`. Other fields are left empty (`changePath: ""`), with `planning: {available: false, reason: "folder missing" | "no folder"}`.
- New fields: `planning`, `missing_folder`, `state {id, label, note?, next {commands, text?}, needs_attention}`, `labels[]`, `landed_check`, `repos[]` (`state`, `target`, `method`, `base_source`, `local_view_older`, `as_of`, `refresh`), and per target `freshness {refreshing, as_of, refresh_finished?}` and `unavailable`.
- Only `landed` is safe to delete; `landed_with_newer_commits` never is.
- `weave change list` and `weave status` clean nothing up; only an explicit `close` does.
- Inline landed checks for cache misses stop after 2 seconds in total. Changes with folders are checked first, newest first.

## Lifecycle

- **`close <id>`** works on a missing folder:
  - It runs `git worktree remove` on this change's own entries only (nested repos first) and never `git worktree prune`.
  - It deletes `changes/<id>.yml` and keeps branches and `bases/`.
  - It adds the warning `if you moved this folder, move it back first; closing stops tracking it`.
  - It refuses with `worktree_locked` (with the unlock hint) or `changes_unavailable`.
  - It succeeds when git already pruned its own record.
- **`switch <id>`** recreates a missing folder from committed work:
  - Any unlocked leftover entry for the branch, at any path, is a planned `remove_stale_entry`, applied only after every repo passes. That covers moved folders too.
  - The old slot is kept if free; otherwise `slot_changed: {from, to}`.
  - Recreated repos lose their setup record (`setup_reset`); approvals are kept.
- **Snapshot.** `close`, `switch` (when it created worktrees), every list, and every refresh rewrite `.git/weave/attention.json`. A write replaces it only when its `facts_at` is newer.
- **`change status <id>`** for a missing-folder change fails with `folder_missing` ("folder missing; run `weave change list`") instead of `change_not_found`.

## Integrations And Side Effects

The refresh (ADR `261108-4ko1`) works like this:
1. `git ls-remote --heads origin` lists origin's branches.
2. It fetches only the local `change/*` branches and the target branches in use, with named refspecs, into `refs/weave/remotes/origin/*`. The fetch uses `--no-tags --no-recurse-submodules --refmap=` (and `--no-write-fetch-head` on git 2.29+), plus `fetch.pruneTags=false`, `gc.auto=0`, `maintenance.auto=false`, `fetch.writeCommitGraph=false`, and `fetch.recurseSubmodules=false`.
3. Known branches gone from origin get their Weave ref removed with `update-ref -d`.

The empty `--refmap=` matters: without it, git also moves the user's `refs/remotes/origin/<branch>`.

It never prompts:
- the environment sets `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=false`, `SSH_ASKPASS=false`, `SSH_ASKPASS_REQUIRE=never`, and `GCM_INTERACTIVE=never`
- `GIT_SSH_COMMAND="ssh -o BatchMode=yes"` is added only when the user has no ssh command configured
- git runs in its own session with stdin closed, and the process group is killed at the time limit

Results per repo are `ok | timeout | auth | unreachable | no_remote | error`, recorded in `.git/weave/refresh.json` together with the `seen` and `absent` branch lists. They show as `couldn't refresh: origin needs a login`, `couldn't reach origin`, `last refresh timed out`, or `couldn't refresh: <message>`.

Machine-local files, all in `.git/weave/`:
- `bases/`: durable
- `landed.json`: cache
- `refresh.json`
- `attention.json`

To roll everything back, delete those files, and delete every ref under `refs/weave/`.

## Edge Cases

- A hand-deleted changes root (parent present) shows normal `folder_missing` states; an unmounted drive shows `folder_unavailable`.
- A folder deleted after its work landed shows `folder_missing` with the note `work already landed in <t>`, and only `close` is offered.
- A stacked change is measured against its parent branch, even after close, and shows `, not in <default> yet`.
- After upgrading, old local change branches whose work isn't found on main show as `closed_not_landed`.

## Invariants

- Weave never writes `refs/remotes/*`, `FETCH_HEAD`, or tags during a list or refresh.
- `bases/` records are never deleted by Weave.
- Landed checks never add objects to the user's object store.

## Source Anchors

- Landed check: `src/lib/landed.ts` (`checkLanded`, `LandedCache`, `landedRepoInfo`)
- Starting branches: `src/lib/change-bases.ts` (`recoverBase`, `resolveChangeBase`, `recordBases`, `rejectReflogBase`)
- Facts: `src/lib/change-facts.ts` (`gatherFacts`, `changesRootUnavailable`, `changeIdPattern`)
- States: `src/lib/change-states.ts` (`deriveState`, `attentionCounts`, `stateLine`, `nextLine`)
- Refresh: `src/lib/change-refresh.ts` (`runRefresh`, `planBackgroundRefresh`, `spawnBackgroundRefresh`, `joinOrRunRefresh`, `remoteFacts`)
- Snapshot: `src/lib/change-attention.ts`
- Git primitives: `src/lib/git.ts` (`mergeTreeWrite`, `onFirstParentLine`, `cherryMarks`, `gitVersionCaps`, `lsRemoteHeads`, `fetchNoPrompt`, `noPromptEnv`, `worktreeLockedOnDisk`)
- List, close, switch wiring: `src/lib/changes.ts` (`listWorktreeChanges`, `describeFreshness`, `closeChange`, `missingFolderChanges`, `refreshAttention`); `src/lib/worktrees.ts` (`planTarget`, `removeChangeWorktrees`, `ensureChangeWorktrees`)
- Command layer: `src/commands/change.ts` (`list --all --fetch`, hidden `refresh`)
- Status line: `src/lib/status.ts` (`readChangesAttention`, `attentionLine`)
- Tests: `tests/landed.test.ts`, `tests/change-states.test.ts`, `tests/cli-change-list.test.ts`, `tests/change-refresh.test.ts`, `tests/worktrees.test.ts` ("missing change folders"), `tests/cli-status.test.ts` ("weave status attention line")

## Change History

- 2026-11-09 (change `261107-4oq6-flag-stale-change-folders-in-weave`): introduced change states, the shared landed check, remembered starting branches, the background remote refresh, missing-folder `close`/`switch`, and the `weave status` attention line.

## Open Questions

- Host PR lookup for merges hidden by later same-line edits on the target (deferred; the `may_have_landed` hint covers it).
- Whether the state-id and label-id contract deserves its own decision record.
