---
artifact: architecture
facet: index
description: Canonical entry point for a folder-based architecture artifact, holding the technical shape.
status: draft
owner: engineering
created_at: 2026-11-08T13:58:54.000Z
updated_at: 2026-11-08T15:30:00.000Z
source: prd.md
---

# Change Folder States Architecture

## Decision Summary

- **Approach A.** `weave change list` computes states inline from live local facts and sha-cached landed results, then spawns a detached `weave change refresh` for remote facts.
- **Starting branch.** It's remembered per change and repo in `.git/weave/bases/<id>.yml`. It's written when Weave creates a branch, recovered lazily from the reflog otherwise, and never deleted by `close`. `changes/<id>.yml` keeps meaning "has a registered folder". (Decision 1)
- **Remote facts.** They're fetched into a Weave-only namespace, `refs/weave/remotes/origin/*`, with narrow refspecs, `--prune --no-tags --no-write-fetch-head`, and no prompts. The user's `origin/*`, `FETCH_HEAD`, and tags are never written. Comparisons use the newest of Weave's ref, the user's `origin/<t>`, and the local `<t>`. (Decision 2)
- **Landed check.** The tip is an ancestor of the target, or `merge-tree --write-tree` equals the target tree. `git cherry` tells rebased from squashed. "Landed, with newer commits" is found by walking back at most 50 commits. Results are cached by `(repo, tip, target)` sha. (Decision 3)
- **Refresh process.** At most one runs, tracked in `refresh.json` by pid and age, throttled to one start per 60 seconds, with a 30-second timeout per repo, fetching in parallel. It recomputes states and writes `attention.json` for `weave status`. `--fetch` joins a running refresh or runs one in-process. (Decision 4)
- **`--json` contract.** Strictly additive: today's fields stay, set to `""` or empty when there's no source. It adds `state.id`, `state.label`, `next.commands`, `labels`, `landed_check`, `repos[]`, and `freshness`. (Decision 5)
- **`close` and `switch`.** Both handle missing folders: `git worktree remove` for the change's own entries only, never `prune`. `reuse` requires the path to exist. Slots are re-checked and setup is reset on recreate. (Decision 6)
- **Modules.** The logic is split into `change-facts` (I/O), a pure `change-states`, `landed`, and `change-refresh`. Pure state derivation is unit-tested, and git edge cases get integration tests against real repos. (Decision 7)

### Stress-test refinements (2026-11-08)

The architecture stress test kept the direction and settled these points. Details are folded into the sections below.

- **Starting-branch recovery order** (C1). The order is: `bases/`, then the folder's `status.yml` `checkout.repos.<repo>` block, then the reflog, then `unknown`. The reflog's `Created from <x>` is rejected when `<x>` is a SHA, `HEAD`, or the change's own `[origin/]change/<id>`. Why: verified on git 2.50, `add_new` logs a SHA, `add_tracking` logs `origin/change/<id>`, and `checkout -b` logs `HEAD`. The last two would measure a change against itself.
- **"No commits" needs a known base** (C2). The test runs only when `base_commit` is known. Otherwise the landed checks run directly. Why: `merge-base(target, tip)` equals the tip after any merge, so merged branches read as empty.
- **`contained` method** (C2). With an unknown base, a tip on the target's first-parent line is `landed` with method `contained`, labelled "nothing left to merge: every commit is already in <t>". Why: a fast-forward and an empty branch look identical, and "landed" would falsely claim work went in.
- **Which branches count** (C3). A local branch counts when it matches the change-id pattern *and* has a `bases/` or `changes/` record or a committed `status.yml`. Closed states offer `switch` only when `status.yml` is on the branch; otherwise they show a `git worktree add` recovery hint. Titles are read from the branch when present. No folder plus no commits means `done`. Why: `switch` fails without a committed `status.yml`, and the PRD excludes hand-made branches.
- **Remote-derived targets only** (C4). For repos with `origin`, a local-only merge never counts as landed. "Gone" means absent on origin at the last successful refresh. `may_have_landed` uses the `seen` list kept in `refresh.json`. Why: the PRD makes the remote the source of truth, and 6c16 deletes on `landed`.
- **Bounded cost, untouched object store** (C5):
  - merge-tree writes into a temporary object directory, with the real store as an alternate.
  - The inline landed work for cache misses stops after 2 s. Unchecked changes say "still checking", and the refresh finishes them.
  - Target: a warm list in ≤ 500 ms for 30 changes, measured in the first slice.
- **Fetch hygiene** (C6, C7):
  - `ls-remote --heads origin` runs first.
  - Then a fetch with named refspecs, covering only known `change/<id>` branches and the targets in use, never `change/*`.
  - Gone refs are deleted with `update-ref -d`.
  - Hardened config and env (schema.md).
  - Both the background and the `--fetch` git child run in a new session with no controlling terminal.
- **Unavailable versus deleted changes root** (C8). The root is `unavailable` only when its parent directory is missing or it is a dangling symlink. Otherwise it is treated as deleted, and its changes get normal `folder_missing` states. Unavailable changes get the state `folder_unavailable`.
- **A change's repo set** (C9). A repo belongs to a change when it has a worktree entry for `change/<id>` (prunable included) or is listed in the new optional `changes/<id>.yml` `repos` field. Repos skipped with `--repo`, and repos registered later, are not part of the change.
- **Attention snapshot freshness** (C10). `close` and `switch` recompute `attention.json`. Every writer stamps `facts_at`, and a write only replaces an older `facts_at`, under `withStateLock`.
- **Compatibility** (C11):
  - `active` and `targets[].path` keep today's cwd-based meaning.
  - `id`, `slug`, `branch`, and `path` are never blanked.
  - `title`, `type`, and `stage` come from the branch's `status.yml` when possible, else `""`.
  - Every new behaviour is gated to `checkout: worktree` in `src/commands/change.ts`, which also owns the spawn.
- **Stale-entry removal is a planned action** (C12). `remove_stale_entry` runs in the apply phase, after every repo passes. Any unlocked prunable entry for `change/<id>`, at any path, qualifies, so `switch` works after a move or a `worktrees.root` change.
- **Minor points:**
  - git capability floors: 2.29 (`--no-write-fetch-head`, which is omitted below it), 2.31 (porcelain `prunable`/`locked`; below it, `locked` is read from `.git/worktrees/<name>/locked`), and 2.38 (merge-tree).
  - On git < 2.38, one list-level line replaces per-change "couldn't check" labels.
  - The cache key includes `base_commit`.
  - The auth test uses `ext::` with `protocol.ext.allow=always`.
  - The ADRs' `applies_to` lists were widened.
  - `change status <id>` and opening a folder report "folder missing; run `weave change list`" instead of `change_not_found`.

## System Context

- **Repo:** weave-it, in repo mode with `checkout: worktree` and `repos: {}` (`.weave/workspace.yml`). Workspace mode adds registered repos, each with its own worktrees. Local state lives only in the root repo's git dir (research.md, "Machine-local state").
- **List today.** `listChanges` → `readChangesWithWorktrees` (`src/lib/changes.ts:490-505`, `:1435-1460`) merges the main checkout's `wiki/changes/*` with `git worktree list` entries whose `status.yml` exists, which is why missing folders vanish. `ChangeSummary` is defined at `src/lib/changes.ts:179-201`, and the text renderer is `formatListMessage` at `src/lib/changes.ts:2177-2198`. `change list` does not use `withNotices`.
- **Local state.** `.git/weave/changes/<id>.yml` holds `{version, change, folder, slot, created_at, setup?}` (`src/lib/worktrees.ts:82-89`). `close` deletes it (`:230`). `nextFreeSlot` only counts files whose folder exists (`:661-671`). `withStateLock` is a directory mutex with a 30-second takeover (`:621-645`).
- **Starting branch.** It's recorded only in the uncommitted `status.yml` `checkout` block, and only for `add_new` (`src/lib/worktrees.ts:256-274`, `:515`, `:563-565`).
- **Git helpers.** `listGitWorktrees` parses only `worktree`, `HEAD`, `branch`, `detached`, and `bare` (`src/lib/git.ts:137-168`). No git call has a timeout or prompt suppression (research.md, "git facts"). Nothing uses `merge-tree`, `cherry`, or `--is-ancestor`.
- **Precedents.** `weave advance --detach` self-spawns detached and unref'd (`src/lib/advance.ts:495-500`). The npm check runs as an in-process `void` promise with a 3-second abort (`src/lib/npm-version.ts:50-91`).
- **`weave status`.** It reads only `<cwd>/.weave/agents.yml` and notices (`src/lib/status.ts:38-70`), and never calls git.
- **Git behaviour observed.** On git 2.50.1: a hand-deleted worktree keeps its `branch` line, is marked `prunable`, blocks `branch -d`, `checkout`, and `worktree add`, and `git worktree remove <missing>` clears it. `merge-tree --write-tree` equals the target tree for merge, squash, and rebase, and differs for unmerged work, newer commits, and later same-line edits (research.md, External Dependencies).
- **Accepted ADRs consulted.**
  - `261107-ohne-each-change-gets-its-own-worktree-folder`: this design stays inside it. Weave owns git edge cases with plain git, and closing keeps branches.
  - `261101-c4tg-human-decision-points-never-auto-advance`: not affected.
- **Team considerations.** `.weave/architecture-considerations.md` is still the unedited template, so there are no constraints to apply.

## Options Considered

### A. Compute in `list`, fetch in a detached child — Chosen

- How it works: `list` gathers live local facts and sha-cached landed results synchronously, prints, then spawns `weave change refresh` detached. The refresh fetches, recomputes, and writes the attention snapshot.
- What changes: new `change-facts.ts`, `change-states.ts`, `landed.ts`, and `change-refresh.ts`; additions to `git.ts`; wiring in `changes.ts` (list, close), `worktrees.ts` (planTarget, close, slots), and `status.ts`; skill templates.
- Trade-offs: remote facts are one refresh old, but labelled. The background process needs test isolation. It's reversible: dropping the spawn leaves a working offline list.
- Why chosen: local facts are always live, it uses existing spawn and lock patterns, and it never blocks agents.

### B. The background worker owns a full snapshot — Rejected

- How it works: the refresh computes every state, and `list` renders the snapshot with cheap live facts layered on top.
- Trade-offs: `list` and `status` always agree, but local commits show late, there are two merge paths to keep correct, and the first run still needs inline compute.
- Why rejected: it breaks "local facts are always live" and ends up building A anyway.

### C. Everything in-process, like the npm check — Rejected

- How it works: the same compute as A, but the fetch is a `void` promise in the `list` process.
- Trade-offs: the fewest pieces, but the process can't exit until the fetch settles, which can take up to 30 seconds.
- Why rejected: agents and scripts that wait for exit would hang.

### Sub-decision alternatives (rejected)

- **Starting branch in git config, or kept in `changes/<id>.yml` with `closed_at`.** Writing user git config, or overloading the folder-registration file, is easy to get wrong.
- **Plain `git fetch --prune origin`.** It moves the user's refs, fetches every branch, and risks lock collisions.
- **An uncapped walk for newer commits.** A cold list could take seconds.
- **Computing newer commits only in the background.** Local commits would show late.
- **The state label as the only JSON state value.** Agents would match on prose.
- **`null` for unknown fields.** It changes field types.
- **`close` running `git worktree prune`.** It clears other changes' leftovers.
- **`switch` using `worktree add -f`.** It overrides unrelated safety checks.
- **A single-file implementation in `changes.ts`.** It's harder to unit-test, in an already 2,468-line file.

## Architecture Overview

```text
weave change list [--fetch] [--all] [--json]
├ resolve root: findWorkspaceMode(cwd) → mainWorktreePath → repos (root + registered)
├ --fetch? → refresh.join() or refresh.run() in-process (≤ 30 s per repo)
├ gatherFacts(root)                                   change-facts.ts
│  ├ changes = main wiki/changes/* ∪ worktree entries on change/* ∪ changes/<id>.yml ∪ bases/<id>.yml
│  │   ∪ local refs/heads/change/<id-pattern> with a record or a committed status.yml   (C3)
│  ├ repo set = repos with a change/<id> worktree entry ∪ changes/<id>.yml repos   (C9)
│  ├ per change × repo: entry {path, prunable, locked}, pathExists, uncommitted count,
│  │   tip, base (bases/ → status.yml checkout → filtered reflog → unknown), target ref (remote-derived), planning files present?
│  ├ changesRoot exists? parent missing or dangling symlink → unavailable; else deleted → folder_missing (C8)
│  └ landed(repo, tip, target, base)                   landed.ts (cache hit or compute)
├ deriveStates(facts) → ChangeView[]                   change-states.ts (pure)
├ write attention.json (only if its facts_at is newer)
├ render text | json                                   changes.ts formatListMessage (extended)
└ maybeSpawnRefresh()                                  called from src/commands/change.ts, worktree mode only (detached; skipped if running or < 60 s, or WEAVE_NO_BACKGROUND_REFRESH=1)

weave change refresh --root <main>          (hidden)
├ claim refresh.json.running under withStateLock (take over a dead pid or an expired run)
├ per repo in parallel: lsRemoteHeads → fetchNoPrompt(named refspecs, timeout 30 s) → update-ref -d gone refs
│   → result ok|timeout|auth|unreachable|no_remote|error; record seen change branches
├ gatherFacts + deriveStates → write attention.json
└ clear running, record per-repo results

weave status  → findWorkspaceMode(cwd) → mainWorktreePath → read attention.json → one line if total > 0
weave change close <id> / switch <id>  → resolve via gatherFacts (Decision 6) → recompute attention.json
```

### Landed algorithm (per change × repo)

1. **Target.** Take the `bases/` branch name (for example, `origin/change/worktrees` becomes `change/worktrees`), or else `resolveDefaultBase`.
   - **Repos with `origin`.** Candidates are remote-derived only: `refs/weave/remotes/origin/<t>` and `refs/remotes/origin/<t>`. Pick the one that contains the other; if they've diverged, prefer Weave's. A merge only into the local `refs/heads/<t>` never counts (C4).
   - **Repos without `origin`.** `refs/heads/<t>` is used.
   - **Gone targets.** `<t>` is gone when the last successful refresh found it absent on origin. The target is then the default branch.
   - Record `local_view_older` when Weave's ref is strictly ahead of `refs/remotes/origin/<t>`.
2. **No commits** (only when `base_commit` is known). `rev-list --count <base_commit>..<tip>` is 0, so `no_commits`. With an unknown `base_commit`, this step is skipped (C2).
3. **Merged.** `merge-base --is-ancestor <tip> <target>` gives `landed`. The method is `merged`, except when the base is unknown and the tip lies on the target's first-parent line. That's checked with `rev-list --first-parent --parents <tip>..<target>`, or by the tip being the target. Then the method is `contained`, because a fast-forward and an empty branch can't be told apart (C2).
4. **Squashed or rebased** (git ≥ 2.38). The first line of `merge-tree --write-tree <target> <tip>` equals `rev-parse <target>^{tree}`, so `landed`. If every line of `git cherry <target> <tip>` starts with `-`, the method is `rebased`; otherwise it's `squashed`. merge-tree runs with `GIT_OBJECT_DIRECTORY` set to a temporary directory and `GIT_ALTERNATE_OBJECT_DIRECTORIES` set to the real store. The directory is deleted afterwards, so the user's object store is never written (C5).
   - On git < 2.38: all `-` from `cherry` means `landed` (rebased); otherwise `unchecked` ("git 2.38+ needed").
5. **Newer commits.** Walk `rev-list --first-parent <merge-base>..<tip>` from the tip's parent backwards, at most 50 commits, applying steps 3 and 4. The first landed commit gives `landed_with_newer_commits`. If none is found, the result is `not_landed`.
6. **Errors.** Any git error gives `unchecked`, with a reason.
7. **Cache.** Store `{result, method, checked_at}` in `landed.json`, keyed `repo:tip:target:base_commit|-`, holding 1,000 entries with the oldest evicted first. Entries are dropped when `git_caps` changes.
8. **Budget** (C5). Inline in `list`, cache-miss checks stop after 2 s in total. The remaining changes get `landed_check: unchecked`, with the reason `still checking`, and the background refresh finishes them and warms the cache. The target is a warm list in ≤ 500 ms for 30 changes in one repo, measured in the first slice.

### State derivation (pure)

Each repo first gets a status: `missing`, `missing_kept`, `landed_with_newer_commits`, `landed`, `in_progress`, or `no_commits`. These are combined as follows:

- **Folder missing first.** If any repo is `missing`, the change is `folder_missing`. If every missing repo is locked, it's `folder_missing_kept`.
- **Otherwise the least-finished repo with commits decides:** `in_progress`, then `landed_with_newer_commits`, then `landed`. A change where no repo has commits is `in_progress` with the `no_commits_yet` label.
- **No folder.** It's `done` if landed, if the planning files are on main without a branch, or if the branch has no commits. It's `closed_not_landed` if not landed, and `closed_unchecked` if the check couldn't run.
- **Which branches count** (C3). A local `change/*` branch is a change only when its name matches the change-id pattern (`YYMMDD-xxxx-slug`) and it has a `bases/` or `changes/` record or a committed `wiki/changes/<id>/status.yml`.
- **Titles of closed changes.** When `status.yml` is committed on the branch, `title`, `type`, and `stage` are read with `git show <branch>:wiki/changes/<id>/status.yml`.
- **Repo set** (C9). Only repos in the change's repo set (overview) can be `missing`.
- **Labels:**
  - `uncommitted_files`, on landed states only, which also adapts `next`
  - `no_commits_yet`
  - `may_have_landed`: `not_landed`, and the change branch was in `refresh.json` `seen` but absent on origin at the last successful refresh
  - `starting_branch_unknown`
  - `local_view_older`
  - `refresh`, with a per-repo problem
- **`next.commands`** are fixed per state (api-contract.md). `switch` is offered, for `folder_missing` and the closed states alike, only when the change's `status.yml` exists on the branch (`git cat-file -e <branch>:wiki/changes/<id>/status.yml`). Otherwise the closed states get `next.text`: `recover the work with: git worktree add <path> change/<id>` (C3).
- **Unavailable** (C8). The changes root is unavailable only when it doesn't exist *and* either its parent directory is missing or it is a dangling symlink. Its changes get the state `folder_unavailable`: the problem is reported once, not counted, and they get no `close`. A missing root whose parent exists is treated as deleted, and its changes get normal `folder_missing` states.

### `close` and `switch` (Decision 6)

**`close <id>`**

1. Refuse when:
   - the changes root is unavailable
   - an entry is `locked` (with the hint `git worktree unlock <path>`)
   - an existing folder has uncommitted files
2. Per repo, nested repos first: run `git worktree remove <path>`, whether or not the folder exists. Never run `prune`.
3. Then delete `changes/<id>.yml`, keep `bases/<id>.yml`, and warn about moved folders if any repo's folder was missing.
4. Recompute `attention.json` (C10).

**`switch <id>`**

1. In `planTarget`, `reuse` requires `pathExists`. An unlocked prunable entry for `change/<id>`, at any path, becomes a planned `remove_stale_entry` action, followed by `add_existing`. Nothing is removed during planning. The removal runs in the apply phase only after every repo passes its checks. This covers moved folders and an old `worktrees.root` (C12). A locked entry still blocks.
2. Under `withStateLock`, keep the slot unless another state file with an existing folder holds it. In that case use `nextFreeSlot` and report the change.
3. Drop `setup[<repo>]` for every recreated repo, and write `repos` into `changes/<id>.yml`.
4. Recompute `attention.json` (C10).

### Module layout and testing (Decision 7)

**Modules**

- **`src/lib/change-facts.ts`:** git and filesystem I/O that gathers facts.
- **`src/lib/change-states.ts`:** a pure `deriveState`, multi-repo combining, ordering, labels, `next`, and text.
- **`src/lib/landed.ts`:** the landed algorithm and its cache.
- **`src/lib/change-refresh.ts`:** the refresh command, its liveness and throttling, and the attention snapshot.
- **`src/lib/git.ts` additions:**
  - `prunable` and `locked` parsing in `listGitWorktrees`
  - `isAncestor`, `mergeTreeWrite`, `cherry`, and `revCount`
  - `lsRemoteHeads(remote)` and `fetchNoPrompt({refspecs, timeoutMs})`, with hardened env and config (schema.md)
  - `gitVersionCaps()`, cached per process: 2.29 (`--no-write-fetch-head`), 2.31 (porcelain `prunable`/`locked`; below it, `locked` is read from `.git/worktrees/<name>/locked`), and 2.38 (merge-tree)
- **Wiring:**
  - `changes.ts`: `listChanges`, `formatListMessage`, `closeChange`
  - `worktrees.ts`: `planTarget` reuse, `removeChangeWorktrees`, slot re-check, setup reset, `bases/` write
  - `status.ts`: the attention line
  - `src/commands/change.ts`: the `--fetch`, `--all`, and hidden `refresh` commands. It owns `maybeSpawnRefresh` and gates every new behaviour to `checkout: worktree`; in-place lists exactly as today.
  - `change status <id>` and opening a folder: they report "folder missing; run `weave change list`" instead of `change_not_found`.
  - skill templates: the `--fetch --json` guidance

**Tests**

- **Unit** (`tests/change-states.test.ts`): table-driven `deriveState` covering every state, precedence, multi-repo combination, each label, and `next` adaptation. No git.
- **Landed integration** (`tests/landed.test.ts`), against real temp repos:
  - merged, squashed, rebased
  - newer commits after a squash
  - an empty branch
  - a stacked base
  - a later same-line edit
  - the 50-commit cap
  - old git, through `WEAVE_TEST_GIT_NO_MERGE_TREE=1`
  - cache hits and invalidation
  - base recovery for each creation path (`add_new` from the status.yml block, `add_tracking` and `checkout -b` rejected as unknown)
  - a merged branch with an unknown base reads `landed`
  - an empty branch with an unknown base reads `landed` with method `contained`
  - a merge only into local `main` is not landed
  - no new loose objects in the user's store after a check
  - the 2 s inline budget leaves the remaining changes as `still checking`
- **Refresh integration** (`tests/change-refresh.test.ts`), against a file-path bare remote:
  - success, and a gone branch removed with `update-ref -d`
  - only known `change/<id>` branches are fetched; a teammate's other branches are not
  - `may_have_landed` after a seen branch disappears
  - namespace isolation: `refs/remotes/*`, `FETCH_HEAD`, and tags untouched, even with `fetch.pruneTags=true`
  - auth failure, with prompts disabled, through `ext::` with `protocol.ext.allow=always` and a `GIT_ASKPASS` that would block
  - timeout, through an `ext::` transport that sleeps
  - throttling
  - taking over a dead pid
  - `--fetch` joining a running refresh
- **Missing folders** (extending `tests/worktrees.test.ts`):
  - `rm -rf`, then list
  - `close`, with the branch deletable afterwards
  - `switch` recreating the folder, with a slot collision and a setup reset
  - a locked entry
  - an unavailable changes root (parent missing) versus a deleted one (parent present)
  - git having already pruned its own record
  - a `--repo` subset, and a repo registered later, are not missing
  - `switch` after the folder was moved, and a blocked second repo leaving the first repo's entry untouched
  - `weave status` cleared after `close`, and an older refresh not overwriting a newer snapshot
- **CLI contract** (`tests/cli-change-list.test.ts`, `tests/cli-status.test.ts`):
  - text snapshots
  - JSON field presence and types against today's `ChangeSummary`
  - the `weave status` line and its `--json`
  - `WEAVE_NO_BACKGROUND_REFRESH=1` set throughout
  - `active` and `targets[].path` unchanged from today when run from a change folder
  - in-place mode output byte-identical to today

## Facets

- `schema.md`: machine-local state files and the Weave ref namespace (current).
- `api-contract.md`: the CLI contracts for `change list` (text and JSON), `status`, the hidden `change refresh`, `close`, `switch`, and skill guidance (current).

## Decisions Recorded

- `261108-kl3n-landed-means-merging-changes-nothing-against-the-starting-branch` (proposed): one definition of landed, measured against a remembered starting branch, shared with `261107-6c16-close-delete-merged`, with only `landed` safe to delete.
- `261108-4ko1-remote-state-refreshes-in-the-background-into-weave-only-refs` (proposed): a detached refresh, a Weave-only ref namespace, never moving the user's refs, and never prompting.

## Tradeoffs

- **Remote facts lag by one refresh.** This is accepted because the lag is labelled, shows a "refreshing now" hint, and only under-reports landing. Revisit if users rely on plain `list` for destructive actions.
- **The extra ref namespace and background process add moving parts.** They're accepted for non-interference with the user's git. Revisit on Windows support, or if disk use shows up.
- **The 50-commit cap can miss "landed, with newer commits" on long branches.** These show as `in_progress`, which errs safe. Revisit if long-lived branches are common.
- **merge-tree is fooled by later same-line edits on the target.** This is mitigated by the `may_have_landed` hint. Revisit with host PR lookup if reports appear.
- **Commits reachable only through `refs/weave/*` appear in `git log --all`.** The ref names aren't decorated by default (verified on git 2.50), and `push --mirror` would push them. This is accepted, because hiding them would mean writing user config.
- **`contained` can't tell a fast-forward from an empty branch.** It's accepted, since its label claims only "nothing left to merge" and deleting loses nothing.
- **Unavailable versus deleted is a heuristic.** A drive whose mount point is itself the changes root reads as deleted. That errs toward offering `close`, which keeps branches, so it stays recoverable.

## Product Questions Raised by Technical Design

- **"(on origin; run `git fetch` to see it locally)".** When Weave's snapshot shows a landing that the user's `origin/<t>` doesn't, the list line adds this hint, and `--json` sets `local_view_older`. This visible behaviour isn't in the PRD yet. Record it with `weave-clarify prd`. It does not block slices: the design carries it either way.
- **New visible behaviour from the stress test.** Record these with `weave-clarify prd`; none blocks slices.
  - the `contained` wording "nothing left to merge: every commit is already in <t>"
  - the `folder_unavailable` state
  - the `git worktree add` recovery hint for closed changes without a committed status.yml
  - "still checking"
  - the git < 2.38 list line
  - `list` writing Weave's own cache files (`landed.json`, `refresh.json`, `attention.json`) and `bases/` records under `.git/weave/`, which the PRD's "changes nothing during a list except…" doesn't name
- **`exploration.md` lags `prd.md`.** It doesn't include the refresh-in-flight hint or the agent `--fetch` guidance. Fix with `weave-clarify exploration`. Not blocking.

## Risks And Open Questions

- **Auth error classification** depends on git and ssh stderr text, which varies by version and locale. The fallback is `error` with the raw message. Not blocking slices.
- **Reflog recovery of old starting branches** depends on reflog retention (90 days by default) and on the branch having been created on this machine. When it fails, the branch is labelled `starting_branch_unknown`. Not blocking.
- **Detached spawn on macOS and Linux only,** matching ADR `ohne`'s platform scope. Not blocking.
- **The git 2.38 minimum for `merge-tree --write-tree`** comes from git's documentation and isn't verified on older versions. Confirm in the first slice's tests with a version probe. Not blocking.
- **Clock skew or a reused pid could keep a dead run looking alive.** The age limit (30 s × repos + 10 s) bounds this. Not blocking.
- **A user's `core.sshCommand` or `GIT_SSH_COMMAND` gets no added `BatchMode`.** The git child runs in a new session with no controlling terminal and `SSH_ASKPASS_REQUIRE=never`, so ssh can't prompt. Not blocking.
- **The 500 ms warm-list target is unmeasured.** Confirm it in the first slice. If it's missed, lower the inline budget. Not blocking.
- **The state-id and label-id contract** is long-lived and could get its own decision record. Deferred, not blocking.

## Slices Readiness

Ready
