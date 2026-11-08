# Change Checkouts

## Purpose

Define how a change's branch gets checked out across the workspace root and registered repos: either a folder of git worktrees per change, or switching branches in the existing checkouts.

## Current Behavior

`.weave/workspace.yml` sets `checkout`:

- `worktree`: each change gets its own folder holding a git worktree of the workspace root and of each registered repo, all on `change/<change-id>`. `weave init` writes this for new workspaces and repos.
- `in-place`: the current checkout switches to the change branch, and `weave task prepare` switches each registered repo. A workspace without the key is `in-place`, so workspaces created before worktrees keep working as they did.

### Worktree checkouts

- **Folder:** `<main checkout parent>/<main checkout name>.changes/<change-id>/` unless `worktrees.root` sets another place (relative to the main checkout). Inside it, the workspace root worktree is at `.` and each repo worktree is at its registered `path`, so every path in `.weave/workspace.yml` works unchanged and the active change is still derived from the checked-out branch.
- **Creating:** `weave change new` plans every repo first and creates nothing if any repo is blocked: an unreadable repo, a missing path, a branch already checked out elsewhere, a folder already in the way, a base that does not exist, or a workspace root whose base does not contain `.weave/workspace.yml`. Then it creates the root worktree and each repo worktree in order. If any `git worktree add` fails, it removes every worktree and branch that run created.
- **Base:** `--base <repo>=<ref>` for that repo (`root` for the workspace root), then a plain `--base <ref>` for every repo, then the repo's `base` (or `worktrees.base` for the root), then the remote default branch after `git fetch origin <branch>`, then the local default branch when there is no `origin`. An explicit `origin/<branch>` is fetched first; a plain name uses the local branch or ref when it exists and otherwise fetches and uses `origin/<name>`. A named base missing from a repo blocks creation and points at the per-repo form; `--base` for an unregistered repo, or for one `--repo` leaves out, also blocks. `--no-fetch` skips the fetch. A failed fetch is a warning, not a blocker. Each repo's `base` and `base_commit` are recorded under `status.yml.checkout.repos`.
- **Repo selection:** `--repo <id>` limits the repos; `weave task prepare` later adds worktrees for any registered repo the change lacks, and never moves an existing checkout. A registered folder that is not its own git repo is skipped and travels with the root worktree.
- **Copy:** each worktree gets the literal paths in its `copy` list (`worktrees.copy` for the root, the repo's `copy` for a repo) from the main checkout, when they exist and are not tracked.
- **Listing and opening:** `weave change list` gives every change of the repo or workspace one state (landed, folder missing, in progress, closed, done…) with labels and a runnable next step, the same from the main checkout or any change folder; see [change-folder-states](../features/change-folder-states/behavior.md). `weave change switch <change>` makes sure the folder and worktrees exist (reusing existing ones, adding missing ones from the local or `origin` branch, and recreating a folder that was deleted or moved by first clearing git's leftover record in the apply phase) and prints the folder; it never switches the current checkout. A recreated folder keeps its slot only while no other open folder holds it (`slot_changed` otherwise) and its setup counts as not run (`setup_reset`). When no open change matches, it matches the id, token, or slug against `change/` branches in the workspace root, locally and on `origin` (`git ls-remote`), so a teammate's pushed change or a closed change can be opened. The branch must contain `wiki/changes/<id>/status.yml`, or it fails with `not_a_change_branch` before creating anything. While opening, each repo fetches the change branch from `origin`; repos that have it get a tracking worktree, and the rest start from their base.
- **Setup:** `weave change setup` runs each worktree's `setup` command (`worktrees.setup` for the root, the repo's `setup` for a repo) once per command. A command runs only after a person approves that exact command with `weave change setup --approve` at an interactive terminal; without a terminal the approval fails with `approval_needs_terminal`. Approvals are remembered per machine. Results are `ok`, `nothing_to_run`, `needs_approval`, `declined`, or `failed` (with the log path and its last lines). Commands get `WEAVE_CHANGE_ID`, `WEAVE_CHANGE_DIR`, `WEAVE_REPO_ID`, `WEAVE_SOURCE_DIR`, and `WEAVE_SLOT`.
- **Starting branch:** `weave change new` also records each repo's starting branch in `.git/weave/bases/<id>.yml`, which survives `close` and is what the landed check measures against.
- **Slots:** every open change gets the lowest free slot number on the machine, starting at 1. A slot frees up when its folder is closed or deleted.
- **Closing:** `weave change close [change]` refuses when run from inside the change folder, when any existing worktree has uncommitted work, when a worktree is locked (`worktree_locked`, with the unlock hint), or when the change folders are unavailable (`changes_unavailable`). It removes the repo worktrees, then the root worktree (with `git worktree remove`, even when the folder is already gone, and never `git worktree prune`), keeps every branch and the remembered starting branch, and reports which branches are not on `origin`. Closing a missing folder warns "if you moved this folder, move it back first; closing stops tracking it".
- **Machine-local state:** slots, the repos each change was checked out in, setup approvals, completed setup, setup logs, remembered starting branches (`bases/`), the landed cache, refresh records, and the attention snapshot live in `.git/weave/` of the main checkout, shared by all its worktrees and never committed. Weave's copy of origin lives in `refs/weave/remotes/origin/*`.

### In-place checkouts

- `weave change new` refuses (`stacked_change`) while the current branch is another `change/` branch, unless `--base` is given; with `--base` the branch starts from that ref.
- `weave task prepare` blocks a repo whose git state cannot be read instead of skipping it, compares real paths so a symlinked repo path is still prepared, blocks a clean repo that sits on a branch other than its base (or default) branch, and switches back the repos it already moved, deleting branches it created, when a later repo fails to switch.

## Behavioral Rules

- No Weave command switches the branch of a main checkout in worktree mode.
- Nothing is created unless every repo passes its checks; a partial failure is rolled back.
- Setup commands from committed config never run without a person's approval on that machine; skills and auto-advance cannot approve.
- Closing never deletes branches or uncommitted work.
- Listing never cleans anything up, and never writes `refs/remotes/*`, `FETCH_HEAD`, or tags.
- Worktree checkouts support macOS and Linux; setup runs commands with `/bin/sh`.

## Integrations And Side Effects

- `weave-new` and `weave-fix` report the change folder and tell the user to open it in a new session; `weave-fix` writes its files under that folder.
- `weave-execute` runs `weave change setup --json` before implementing and stops on `needs_approval` or `failed`.
- Decision: [261107-ohne-each-change-gets-its-own-worktree-folder](../../../../decisions/261107-ohne-each-change-gets-its-own-worktree-folder.md).
- Decisions: [261108-kl3n-landed-means-merging-changes-nothing-against-the-starting-branch](../../../../decisions/261108-kl3n-landed-means-merging-changes-nothing-against-the-starting-branch.md), [261108-4ko1-remote-state-refreshes-in-the-background-into-weave-only-refs](../../../../decisions/261108-4ko1-remote-state-refreshes-in-the-background-into-weave-only-refs.md).

## Related Specs

- [change-creation-and-stages](change-creation-and-stages.md)
- [workspace-aware-skill-context](workspace-aware-skill-context.md)
- [weave-prepare](../features/weave-prepare/behavior.md)
- [change-folder-states](../features/change-folder-states/behavior.md)
