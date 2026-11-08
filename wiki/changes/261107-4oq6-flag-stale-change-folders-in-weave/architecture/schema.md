---
facet: schema
description: Machine-local state files and the Weave-only ref namespace.
---

# Schema Design

## Current Model

All of today's machine-local state lives in the root repo's `<git-common-dir>/weave/` (`src/lib/worktrees.ts:614-619`):

- **`changes/<id>.yml`:** `{version: 1, change, folder, slot, created_at, setup?: {<repo>: {hash, completed_at}}}`. It's written at create and switch, deleted by close, and is the slot source.
- **`lock/`:** a directory mutex used by `withStateLock`. A lock older than 30 seconds is taken over.
- **`approved-setup.yml`** and **`logs/`:** setup approvals and setup output.

The starting branch exists only in the change folder's uncommitted `status.yml` (`checkout.repos.<repo>.base/base_commit`), and only for `add_new`.

Refs: Weave writes only `refs/heads/change/*`, through worktree add. It never writes remote-tracking refs.

## Proposed Model

All new files are YAML or JSON in `<git-common-dir>/weave/`. Each is written atomically (write to a temp file, then rename) under `withStateLock` unless noted.

### `bases/<id>.yml`

Durable: never deleted by close.

```yaml
version: 1
change: <id>
recorded_at: <iso>
repos:
  <repo-id>:            # "root" for the workspace root
    base: <ref>         # e.g. origin/main, origin/change/worktrees; null when unknown
    base_commit: <sha>  # null when unknown
    source: created | reflog | unknown
```

- **Written** by `ensureChangeWorktrees` for `add_new` repos, from the same values that already go into the `checkout` block.
- **Recovered lazily** by `change-facts` when a repo has no entry, trying these sources in order (C1):
  1. **The folder's `status.yml`.** When the folder exists, its `checkout.repos.<repo>.base`/`base_commit` is recorded with source `created`.
  2. **The reflog.** Otherwise the oldest reflog entry of `refs/heads/change/<id>` is read with `git reflog show --format=%gs`. A `branch: Created from <ref>` match is recorded with source `reflog`, unless `<ref>` is a SHA, `HEAD`, or `[origin/]change/<id>`. Those are verified on git 2.50 as what `add_new`, `checkout -b`, and `add_tracking` log.
  3. **`unknown`.** If neither gives a usable ref, the repo is recorded as `unknown` and gets the `starting_branch_unknown` label. An `unknown` record is retried from the `status.yml` block if a folder later appears; the reflog is never re-read.
- **Read** by the landed check. When a repo has no record, or its base no longer resolves, the target is the default branch.

### `landed.json`

A cache. It can be deleted at any time.

```json
{ "version": 1, "git_caps": "<caps string>",
  "entries": { "<repo>:<tipSha>:<targetSha>:<baseCommit|->": { "result": "landed|landed_with_newer_commits|not_landed|no_commits|unchecked",
                                                  "method": "merged|contained|rebased|squashed|null", "reason": "…|null",
                                                  "checked_at": "<iso>" } } }
```

- It holds at most 1,000 entries, with the oldest by `checked_at` evicted first.
- It's written without the state lock: last writer wins. The cache is only an optimisation, so a lost write just means one recomputation.

### `refresh.json`

```yaml
version: 1
running: { pid: <int>, started_at: <iso> } | null
last_started_at: <iso>
repos:
  <repo-id>: { last_attempt_at: <iso>, last_success_at: <iso|null>,
               result: ok | timeout | auth | unreachable | no_remote | error, message: <string|null>,
               seen: [<change branch>],      # known change/<id> branches present on origin at last success
               absent: [<branch>] }          # known change and target branches absent on origin at last success
```

- **`seen` and `absent`** drive `may_have_landed` (seen before, absent now) and gone targets (C4). Branches deleted before the first refresh never get the hint, which is accepted.

- **Alive** means `running` is set, `process.kill(pid, 0)` succeeds, and `now − started_at < 30 s × repo count + 10 s`. Anything else is dead and can be taken over.

### `attention.json`

```json
{ "version": 1, "computed_at": "<iso>", "facts_at": "<iso>", "total": 2, "counts": { "landed": 1, "folder_missing": 1 } }
```

- It's written by every `list`, every refresh, `close`, and `switch`, and read only by `weave status` (C10).
- `facts_at` is when fact-gathering started. Under `withStateLock`, a write replaces the file only when its `facts_at` is newer, so a slow refresh can't overwrite a newer list.

### Ref namespace `refs/weave/remotes/origin/*`

- **Written only by `change refresh`** and in-process `--fetch` (C6, C7):
  1. `git ls-remote --heads origin` lists the branches on origin.
  2. Only the known `change/<id>` branches (and the target branches in use) that are present are fetched, with named refspecs `+refs/heads/<b>:refs/weave/remotes/origin/<b>`. A teammate's other `change/*` branches are never fetched.
  3. Known branches that are absent get their Weave ref deleted with `update-ref -d`, instead of `--prune`.
- **Fetch flags:** `--no-tags --no-write-fetch-head --no-recurse-submodules` (with `--no-write-fetch-head` only on git ≥ 2.29), and `-c fetch.pruneTags=false -c gc.auto=0 -c maintenance.auto=false -c fetch.writeCommitGraph=false -c core.askPass= -c credential.interactive=false`.
- **Env:**
  - `GIT_TERMINAL_PROMPT=0`
  - `GIT_ASKPASS` and `SSH_ASKPASS` point to a program that exits non-zero
  - `SSH_ASKPASS_REQUIRE=never` and `GCM_INTERACTIVE=never`
  - `GIT_SSH_COMMAND="ssh -o BatchMode=yes"` only when the user has no ssh command set
  - The git child runs detached in a new session with stdin ignored, so there's no controlling terminal, for both the background refresh and `--fetch`.
- **Read by the landed check** as one candidate target, and through `refresh.json` `seen`/`absent` for `may_have_landed` and gone targets.
- **Per remote:** only `origin` is fetched, matching today's `resolveDefaultBase` and `findChangeBranch`. A repo without `origin` is recorded as `no_remote`.

### `changes/<id>.yml`

The format gains one optional field, `repos: [<repo-id>]`. It's written at create and switch with the repos the change was checked out in (C9). Files without it fall back to worktree entries. Other behaviours change too:

- **On recreate,** switch may rewrite `slot` and drops `setup.<repo>` entries.
- **Its meaning** is unchanged: the change has a registered folder.

## Migration Strategy

- **No migration step.** All new files are created on demand, and missing files read as empty.
- **Existing changes** get `bases/` entries lazily, from the reflog or as unknown, on their first `list`.
- **The first refresh** creates `refs/weave/remotes/origin/*`. Until it does, landed checks use the user's `origin/<t>` or the local `<t>`.
- **Rollback.** Older Weave versions ignore the new files and refs. To remove everything, run `rm -rf .git/weave/{bases,landed.json,refresh.json,attention.json}`, then `git for-each-ref --format='delete %(refname)' refs/weave/ | git update-ref --stdin`.

## Compatibility

- **`changes/<id>.yml` readers** (`nextFreeSlot`, `readLocalChangeInfo`, setup) are unaffected.
- **The `refs/weave/*` namespace** doesn't appear in `git branch -a`. Its commits are included in `git log --all` and `gc` reachability, but the ref names aren't decorated by default (verified on git 2.50), like `refs/prefetch/`. `push --mirror` would push them.
- **The `checkout` block in `status.yml`** keeps being written as today. `bases/` is the durable copy.

## Validation And Risks

- **Invariant:** a `bases/` record is never deleted by Weave.
- **Invariant:** `refs/remotes/*`, `FETCH_HEAD`, and tags are never written by Weave. Integration tests assert this.
- **Invariant:** landed checks never write to the user's object store. merge-tree uses a temporary object directory with the real store as an alternate (C5).
- **Invariant:** `landed.json` results are a pure function of `(repo, tip, target)` and of the git version capability. On a git upgrade, the cache is invalidated by storing `git_caps` in the file and dropping entries when it changes.
- **Risk: refs keep objects alive.** The narrow refspecs and `--prune` bound this.
- **Risk: concurrent `landed.json` writers** may drop entries. This is accepted, since it's a cache.
