---
artifact: research
status: draft
owner: engineering
created_at: 2026-11-08T06:43:00.000Z
updated_at: 2026-11-08T13:03:13.000Z
source: questions.md
git_commit: weave-it 0a2d3e8
branch: weave-it change/261107-4oq6-flag-stale-change-folders-in-weave
---

# Research: Flag stale change folders in weave status

## Summary

`weave status` is a package-and-skills report: it reads the installed `weave-it` version, the cached npm latest version, and the skill manifest in the current directory, then prints the same notices the other Tier 1 commands print. It does not call git, does not read `.weave/workspace.yml`, and knows nothing about changes, worktrees, or change folders. Change folders exist only in `checkout: worktree` mode: each change gets `<main>.changes/<change-id>/` holding a git worktree of the workspace root and of each registered repo, plus one machine-local state file under the main checkout's `.git/weave/changes/`. `weave change close` is the only Weave command that removes a folder; it refuses on uncommitted work, keeps every branch, and deletes the state file. A folder deleted by hand is not detected anywhere: its state file stays, git's stale worktree entry stays (`listGitWorktrees` drops git's `prunable` annotation), and the change quietly disappears from `weave change list`. A local run on git 2.50.1 shows the stale entry keeps its `branch` line, so `weave change switch` takes the `reuse` path for it, and the entry blocks deleting or checking out that branch anywhere until it is pruned or removed. The codebase can already read local branch existence, remote-tracking refs, dirty state, the worktree list, and the default branch; it cannot read merge status, ahead/behind counts, or last-commit times. "Stale" in Weave today means an artifact-lane flag in `status.yml`, not anything about folders.

## `weave status` reads package, skill, and notice state from the current directory only

`statusCommand` wraps one call, `buildStatus({ cwd: process.cwd() })`, in `withNotices` (`src/commands/status.ts:5-21`). `buildStatus` does four things (`src/lib/status.ts:38-70`):

```text
statusCommand                                  src/commands/status.ts:5-21
└ withNotices({commandName:"status"})          src/lib/with-notices.ts:22-47
  └ buildStatus({cwd})                         src/lib/status.ts:38-70
    ├ readPackageVersion()   walk up from module dir to package.json, else "0.0.0"   :174-194
    ├ inRepo = exists(<cwd>/.weave/agents.yml)                                       :40
    ├ collectSkillRows()     only when inRepo                                         :72-113
    ├ getNpmVersionInfo().cachedLatest   cache only, never blocks                     :42-45
    ├ gatherNotices()                                                                 :46-52
    └ renderStatusMessage()                                                           :115-172
```

- **Current-directory assumption.** `inRepo` is just "does `<cwd>/.weave/agents.yml` exist" (`src/lib/status.ts:40`). It does not walk up to a parent, does not call `findWorkspaceMode`, and does not distinguish repo mode from workspace mode or a main checkout from a change folder. In this repo `.weave/agents.yml` is committed (`git ls-files .weave`), so at the root of a change folder `inRepo` is `true`; from any subdirectory it is `false`.
- **Skill rows.** For each agent in the fixed order `claude, codex, cursor, opencode` (`:10`), each installed skill gets `state` = `missing` (file absent) > `modified` (sha256 differs from `installed_hash`) > `outdated` (`installed_from` differs from the bundled `lastChangedIn`) > `current` (`:86-100`). `current` falls back to `"unknown"` when templates can't be read (`:85`).
- **JSON.** The command removes `message` and `notices` from the result and returns `{json, text}` (`src/commands/status.ts:14-18`); `withNotices` adds its own `notices` (`src/lib/with-notices.ts:70-75`). The shape is:

  ```ts
  { status: "ok", packageVersion: string, cwd: string, inRepo: boolean,
    skills: Array<{ agent, name, installed_from: string|null, current: string,
                    state: "current"|"outdated"|"modified"|"missing" }>,
    notices: Notice[] }                                  // src/lib/status.ts:12-28
  ```

- **Text.** In this order: `weave-it <ver>`, `cwd: <cwd>`, `npm latest (cached): <v|unknown>`, then either `Not inside a Weave-managed repo (no .weave/agents.yml).`, `No skills installed.`, or the padded `Installed skills:` table, and finally `Notices: none.` or `Notices (n):` with `- [kind] message` lines (`src/lib/status.ts:124-169`).
- **Notices are gathered twice.** Once inside `buildStatus` (`src/lib/status.ts:44,46`, used by the text body) and again inside `withNotices` (`src/lib/with-notices.ts:30,55`, used for the JSON and the stderr footer).
- **Exit code** is always 0; no `exitCode` is returned (`src/commands/status.ts:15-18`).
- The wiki page `wiki/knowledge/domains/cli-distribution/features/weave-status/behavior.md` matches this behaviour, and says the command is read-only.

**Tested by:** `tests/cli-status.test.ts`. These are end-to-end runs of `src/cli.ts` through `tsx` with `spawnSync`, in `mkdtemp` folders set up with `installAgentSkills` or a hand-written `agents.yml`, with no mocks (`:18-33`). The env unsets `WEAVE_NO_NOTICES` but leaves `WEAVE_USER_HOME` alone, so the npm cache read is the real `~/.weave/cache/npm-version.json` (`:24`). Cases:

- outside a repo (`:36-43`)
- empty manifest (`:45-57`)
- all skills current (`:59-73`)
- a modified skill (`:75-86`)
- text sections (`:88-98`)
- `WEAVE_NO_NOTICES=1` (`:100-110`)

The `missing` and `outdated` states, the npm-latest line, git repos, and worktree layouts are not tested.

## Notices are three package-and-skill kinds attached to six Tier 1 commands

`gatherNotices` (`src/lib/notices.ts:39-80`) returns notices in a fixed order:

| kind | trigger | message | details |
| --- | --- | --- | --- |
| `package_outdated` | cached npm latest is newer than the installed version (`isNewerVersion`, major.minor.patch only, `:160-177`) | `weave-it <latest> is available (installed <installed>). Run 'weave status' for details.` (`:47-56`) | `{installed, latest}` |
| `skills_modified` | an installed `SKILL.md` hash differs from the manifest | `<N> installed skill file(s) have been modified locally. Run 'weave status' for details.` (`:63-69`) | `{skills: [{agent,name,kind}]}` |
| `skills_outdated` | `installed_from` differs from the bundled `last_changed_in`, file unmodified | `<N> installed skill file(s) are out of date. Run 'weave agent update --all' or 'weave status' for details.` (`:71-77`) | `{skills: [...]}` |

`NoticeKind` is exactly this union (`src/lib/notices.ts:12`). Notices are read from `<cwd>/.weave/agents.yml` only, and nothing in them concerns changes, worktrees, or branches. `WEAVE_NO_NOTICES=1` returns `[]` immediately (`:40-43`).

**npm cache.** The cache file is `~/.weave/cache/npm-version.json` (or `$WEAVE_USER_HOME/...`), shaped `{latest, fetched_at}`, with a 24 h TTL (`src/lib/npm-version.ts:6-11,34-46`; `src/lib/user-paths.ts:4-18`). When the cache is stale, missing, or corrupt, it starts a background `refreshNpmVersionCache` without waiting for it (`npm-version.ts:50-59`). The refresh does a GET to `https://registry.npmjs.org/@weave-tools%2fweave-it/latest` with a 3 s abort (`:69-91`). `NO_UPDATE_NOTIFIER=1` or `WEAVE_NO_NOTICES=1` skips the refresh entirely (`:28-31`).

**`withNotices`** (`src/lib/with-notices.ts`):

```ts
interface CommandOutput { json: unknown; text: string; exitCode?: number }   // :8-12
withNotices({ commandName, json, cwd?, env?, packageVersion? }, action)     // :14-47
```

- It starts gathering notices before the action runs and awaits them afterwards (`:30-32`). Any error degrades to `[]` (`:49-68`).
- **JSON mode** merges `notices` into an object payload, or wraps a non-object as `{result, notices}` (`:70-75`).
- **Text mode** prints the text to stdout. It then prints `weave-it: N notice(s) - run 'weave status' for details` to stderr, but only when there are notices, `WEAVE_NO_NOTICES` is not `1`, `CI` is unset, empty, `false`, or `0`, and stdout is a TTY (`:37-42,77-87`).
- A non-zero `exitCode` is passed through to `process.exitCode` (`:44-46`). `commandName` is accepted but never read.

**Which commands use it:**

- `status` (`src/commands/status.ts:10`)
- `doctor` (`src/commands/doctor.ts:17`)
- `workspace` (`src/commands/workspace.ts:10-17`)
- `change new` (`src/commands/change.ts:139`)
- `change current` (`src/commands/change.ts:175`)
- `change status` (`src/commands/change.ts:190`)

`change list`, `change switch`, `change close`, `change progress`, and `change clear-stale` do not use it (`src/commands/change.ts:159-165,211-240`). All six Tier 1 commands surface the same three kinds.

**Tested by:**

- `tests/notices.test.ts`: unit tests on temp folders with `installAgentSkills` and custom `templatesDir`. It covers each kind, `WEAVE_NO_NOTICES`, the modified-vs-outdated split, and `isNewerVersion` (`:13-169`).
- `tests/with-notices.test.ts`: `vi.mock` of `gatherNotices` and `getNpmVersionInfo` (`:4-16`), with stdout and stderr captured by replacing `write`. It covers the JSON merge, the non-object wrap, the footer and each suppression rule, exit-code passthrough, and error degradation (`:68-224`).
- `tests/cli-tier1-notices.test.ts`: end-to-end `spawnSync` against a repo-mode fixture (`:31-61`). It checks:
  - a `notices` array exists on the five read commands (`:63-81`) and on `change new` (`:83-96`)
  - it is absent on `agent install` and `skills list` (`:98-112`)
  - `skills_modified` appears in `status --json` (`:114-130`)
- `tests/npm-version.test.ts`: cache TTL and abort, using an injected `fetchImpl` and fake timers.

Notice ordering and exact message text are not asserted.

## `weave doctor` runs five fixed checks; only one looks at git, and it reads only the current branch name

```ts
type DoctorStatus = "ok" | "warning" | "error";
interface DoctorCheck { id: string; status: DoctorCheckStatus; message: string; fixable: boolean; files?: string[]; details?: string[] }
interface DoctorResult { status; cwd; mode: "workspace"|"repo"|null; root: string|null;
  activeChange: { id; branch; branchMatch: boolean|null; currentBranch: string|null } | null;
  checks: DoctorCheck[]; changed: string[]; message: string }       // src/lib/doctor.ts:8-41
```

`buildDoctor` (`src/lib/doctor.ts:59-182`) resolves the root through `findWorkspaceMode(cwd)`, which walks up to the first readable `.weave/workspace.yml` (`src/lib/workspace-mode.ts:24-49,73-83`). It then runs these checks in order:

| id | statuses | what it checks | fixable |
| --- | --- | --- | --- |
| `weave_context` | error / ok | No readable `workspace.yml` gives `No readable Weave metadata found. Run \`weave init\` first.`, and doctor returns early with only this check (`:68-84`). | no |
| `safe_scaffold` | warning / ok | Six safe scaffold files exist (`:43-50,92-109`). | yes, when warning |
| `safe_scaffold_dirs` | warning / ok | `.weave`, `wiki/changes`, `wiki/knowledge/domains`, `wiki/knowledge/shared` exist (`:52-57,111-128`). | yes, when warning |
| `skill_drift` | warning / ok | Runs only if `<root>/.weave/agents.yml` exists. Uses `collectSkillRows(root)` and lists rows that are not current (`:130-159`). | no |
| `active_change` | warning / ok | `readActiveChange(root)` (`:161-179`, `:204-220`) | no |

- **`active_change`** calls `currentBranch(root)` (`git rev-parse --show-toplevel`, then `git branch --show-current`). It requires the branch to start with `change/` and `<root>/wiki/changes/<id>/status.yml` to exist. It always returns `branchMatch: true`, so the mismatch warning text at `:165-168` cannot happen.
  - From a main checkout on `main`, the result is always `No active change found for this context.` (warning).
  - Inside a change folder, it is `Active change found: <id>.`
- **Overall status** is the worst check (`:249-253`). The exit code is 1 only on `error` (`src/commands/doctor.ts:26`).
- **`--fix`** calls `ensureWeaveScaffold` when at least one scaffold file is missing. It only writes missing files, never overwrites, and records created paths in `changed` (`src/lib/doctor.ts:86-90`; `src/lib/weave-scaffold.ts:12-56`). A missing `wiki/changes/` on its own does not trigger the fix, because the trigger checks files only (`:87`).
- **Text output** has these blocks: `Weave Doctor`, a context block (Cwd, Root, Mode, Active change, Branch), `Checks` with `[ok]`, `[warning]`, `[error]` markers, then `Summary` (`:263-297`).
- **JSON** is `{status, cwd, mode, root, activeChange, checks, changed, notices}`.
- `BuildDoctorOptions.sessionPath` is declared but never read.
- No doctor check reads `git worktree list`, `gitCommonDir`, the change-folder root, `.git/weave/`, or any branch other than the current one. A grep finds no `.git/weave` string in `src/` outside the worktree state helpers.

**Tested by:** `tests/cli-doctor.test.ts`. End-to-end `spawnSync` with `WEAVE_NO_NOTICES=1` (`:20-31`), on temp folders with a repo-mode `workspace.yml` (`:37-48`). Cases:

- the command is registered (`:51-56`)
- a missing scaffold warns without changing files (`:58-79`)
- text sections (`:81-92`)
- no context gives an error and exit 1 (`:94-110`)
- skill drift is reported but not fixed (`:112-134`)
- `--fix` creates files and is idempotent (`:136-160`)
- `--fix` leaves skills alone (`:162-173`)

The fixtures are not git repos, so `active_change` is not exercised. Workspace mode and any worktree layout are not tested either.

## Each change folder is a set of worktrees next to the main checkout, with one machine-local state file

Checkout mode comes from `.weave/workspace.yml`.

- `readWorkspaceMetadata` maps `checkout: worktree` to `"worktree"` and anything else to `"in-place"` (`src/lib/workspace-repos.ts:97`). It also parses `worktrees: {root?, base?, copy[], setup?}` (`:106-114`) and each repo's `base`, `copy`, and `setup` (`:139-147`).
- `workspaceCheckoutMode` defaults to `"in-place"` (`src/lib/worktrees.ts:91-93`), and `weave init` writes `checkout: "worktree"` (`src/lib/init-workspace.ts:483-484`).
- This repo is `mode: repo`, `checkout: worktree`, `worktrees.setup: npm ci && npm run build`, `repos: {}` (`.weave/workspace.yml`).

**Location.** `changeFolderPath` is `join(changesRoot(mainRoot, metadata), changeId)` (`src/lib/worktrees.ts:95-99`).

- `mainRoot` is the realpath of the first `git worktree list` entry, so commands run from inside a change folder still find the main checkout (`:384-387`; `src/lib/git.ts:170-174`).
- `changesRoot` is `worktrees.root` resolved against `mainRoot` when set, otherwise `dirname(mainRoot)/<basename(mainRoot)>.changes` (`src/lib/worktrees.ts:397-401`).

**Contents.** `selectTargets` always includes the workspace root at `.`, then each registered repo at its registered `path` (`src/lib/worktrees.ts:425-438`). A registered folder that is not its own git repo is skipped and travels with the root worktree (`:459-466`). In repo mode with `repos: {}` only the root worktree is created (`tests/worktrees.test.ts:340-359`).

```text
<parent>/acme/                         main checkout (never switched in worktree mode)
  .git/weave/                          machine-local Weave state (below)
  api/  web/                           main checkouts of registered repos (workspace mode)
<parent>/acme.changes/                 changes root, or worktrees.root
  <change-id>/                         root worktree on change/<change-id>
    .weave/workspace.yml               from the base commit; must be committed (worktrees.ts:508-514)
    wiki/changes/<change-id>/
      status.yml                       includes the checkout: block
      sessions/
      exploration.md                   feat changes only
    api/                               repo worktree on change/<change-id>
      .env                             copied ignored file, when listed in copy
    web/
```

Change files are written by `writeChangeFiles(folder, …)` (`src/lib/changes.ts:436,472-488`), and Weave does not commit them. Ignored files from `copy` are copied only into worktrees created in that run (`src/lib/worktrees.ts:141-144,590-612`).

**`status.yml` `checkout` block.** Written by `recordCheckoutInStatus` (`src/lib/worktrees.ts:256-274`), which merges with any existing entries and skips `skipped_not_git` repos:

```yaml
checkout:
  mode: worktree
  repos:
    <repo-id>:          # "root" for the workspace root
      path: <relative path in the folder>   # "." for root
      base: <ref>                           # only when the branch was newly created (add_new)
      base_commit: <sha>                    # only when the branch was newly created
```

It is called from `createChange` (`src/lib/changes.ts:437`), from `openChangeFolder` when `status.yml` exists (`:651-653`), and from `prepareWorktrees` (`src/lib/task-prepare.ts:143`). The block records no folder path, slot, creation time, or last-activity time.

**Machine-local state.** `localStateDir` is `<git-common-dir of mainRoot>/weave`, falling back to `<mainRoot>/.git/weave` (`src/lib/worktrees.ts:614-619`). In workspace mode this is only the root repo's git dir.

| Path | Format | Written by | Read by |
| --- | --- | --- | --- |
| `lock/` | Empty directory used as a mutex: 100 tries × 50 ms; a lock older than 30 s is taken over; otherwise `state_locked` | `withStateLock` (`:621-645`) | same |
| `changes/<change-id>.yml` | `{version: 1, change, folder, slot, created_at, setup?: {<repo>: {hash, completed_at}}}` (`:82-89`) | `ensureChangeWorktrees` (`:146-157`), `runChangeSetup` (`:372-378`); deleted by `removeChangeWorktrees` (`:230`) | `readLocalState` (`:647-652`), `readLocalChangeInfo` (`:249-253`), `nextFreeSlot` (`:661-671`), `removeChangeWorktrees` (`:177`), `runChangeSetup` (`:313`) |
| `approved-setup.yml` | `{approved: [sha256(repo + "\n" + command)]}` | `writeApprovals` (`:684-687`) | `readApprovals` (`:677-682`) |
| `logs/<change-id>-<repo>-setup.log` | raw output of the last setup run, overwritten each time | `runShell` (`:359-360,689-701`) | tail shown on failure (`:368,703-706`) |

**Observed on this machine (2026-11-08).** `/Users/arpit/personal/weave-it/.git/weave/` holds only `changes/`, with two state files: `261107-4oq6-flag-stale-change-folders-in-weave.yml` (slot 1) and `261107-6c16-close-delete-merged.yml` (slot 2). Each has exactly `version`, `change`, `folder`, `slot`, and `created_at`, with no `setup` key. There is no `lock/`, `approved-setup.yml`, or `logs/`, which matches no `weave change setup` having run yet and no lock being held. The layout matches the code above.

`created_at` in the state file is the only creation timestamp Weave keeps for a folder. `folder` is rewritten on every ensure call, while `slot` and `created_at` keep their first values (`:148-156`).

**Slots** are small integers meant to become port numbers (`src/lib/worktrees.ts:659-660`), passed to setup as `WEAVE_SLOT` (`:364`).

- **Allocation.** A slot is allocated only when no state file exists, inside the lock (`:148-154`). `nextFreeSlot` picks the lowest integer ≥ 1 that no state file *whose `folder` still exists on disk* is using (`:661-671`).
- **Release.** A slot is freed explicitly when close deletes the state file (`:230`). It is also freed implicitly when the folder is gone, because that file's slot stops counting, but the file itself stays.
- **Reopening.** A reopened change whose state file survived keeps its old slot, and nothing re-checks that slot for collisions (`:148`).
- **Setup without state.** `runChangeSetup` uses slot `0` when there is no state file (`:314`).

**Tested by:** `tests/worktrees.test.ts`. This is vitest against real git, with no mocks. `workspaceFixture` builds a workspace repo with registered `api` (with `copy` and `setup`) and `web`, each cloned from a local bare `origins/<repo>.git` (`:39-81`). Tests inject fixed `now`, `randomId`, and `sessionPath`. They cover:

- layout, base, copy, and the `checkout` block (`:98-139`)
- per-repo `--base` (`:141-177`)
- an uncommitted `.weave` (`:179-187`)
- rollback via a failing `post-checkout` hook (`:189-204`)
- `--repo` (`:206-219`)
- repo mode (`:340-359`)
- registration keeping settings (`:361-369`)
- setup approval (`:323-338`)

`worktrees.root` and the setup `failed` path are not tested.

## Folders are created by `new`, recreated by `switch`, and removed only by `close`; nothing notices a folder deleted by hand

**`weave change new`** (`src/commands/change.ts:120-153` → `createChange`, `src/lib/changes.ts:407-470`):

```text
createChange
├ resolveTarget → resolveChangeContext            changes.ts:1393-1404
├ generateChangeId (id unused in wiki, local branch, and change folder)   :1308-1331
├ ensureChangeWorktrees                           worktrees.ts:101-160
│  ├ planTarget per repo: missing/unreadable source, branch checked out elsewhere,
│  │  path in the way, missing base → blocker; existing worktree at same path → reuse;
│  │  local branch → add_existing; origin/<branch> → add_tracking; else add_new from base   :442-516
│  ├ any blocker → worktree_blocked, nothing created                                     :116-118
│  ├ git worktree add … ; any failure → rollback (remove --force, prune, branch -D)      :124-139, 569-581
│  ├ copyIgnoredFiles                                                                    :141-144
│  └ withStateLock: allocate slot, write .git/weave/changes/<id>.yml                    :146-157
├ writeChangeFiles(folder)                        changes.ts:472-488
└ recordCheckoutInStatus                          worktrees.ts:256-274
```

No setup command runs on creation. The only caller of `runChangeSetup` is `weave change setup [--approve]` (`src/lib/changes.ts:730-746`; `src/commands/change.ts:376-393`), which `weave-execute` calls. Repo `post-checkout` hooks do run during `git worktree add`.

**`weave change switch`** (`src/commands/change.ts:361-374` → `switchChange`, `src/lib/changes.ts:604-631`). In worktree mode it returns early into `openChangeFolder` (`:606-608,635-671`):

1. It resolves the reference against `readChangesWithWorktrees`. On `change_not_found` it falls back to `findChangeBranch` (`:675-720`). That function:
   - lists local `refs/heads/change/*`
   - runs `git ls-remote --heads origin refs/heads/change/*` when there is an origin
   - fetches the matched branch
   - requires `wiki/changes/<id>/status.yml` on it, or fails with `not_a_change_branch`
2. It calls `ensureChangeWorktrees({fetchBranch: true})`, which reuses existing worktrees and adds missing ones from the local or origin branch.
3. It prints the folder. It never switches the current checkout.

**`weave change close [change]`** (`src/commands/change.ts:395-404` → `closeChange`, `src/lib/changes.ts:760-790` → `removeChangeWorktrees`, `src/lib/worktrees.ts:169-242`):

- **Mode and argument.** It refuses outside worktree mode (`not_worktree_checkout`, `changes.ts:762-767`). The change argument defaults to the change on the current branch, and with neither it fails `missing_change` (`:769-774`).
- **Finding worktrees.** For the root and each registered repo whose main path exists, it finds the `git worktree list` entry on the change branch, excluding the main checkout itself (`worktrees.ts:180-191`). It fails `no_worktrees` if none are found (`:192-194`).
- **Blockers.** It is blocked when cwd is inside the folder, or when any worktree's `git status --porcelain` fails or is non-empty. The non-empty case reports `<path> has N uncommitted change(s). Commit or remove them first.` (`:196-212`).
- **Removal.** It runs `git worktree remove <path>` without `--force`, nested repos first and the root last (`:214-227`). A failure part-way stops with `worktree_remove_failed` and does not restore what was already removed.
- **Cleanup.** It then calls `rmdir(folder)` (non-recursive, errors ignored) and deletes `.git/weave/changes/<id>.yml` (`:229-230`). `approved-setup.yml` and the setup logs stay.
- **Branches** are always kept (`:168`). Each is reported with `pushed` = "`refs/remotes/origin/<branch>` exists locally" (`:232-240`), which is not compared against the local branch tip. The text shows `(not on origin)` for unpushed branches (`changes.ts:787`).
- **Unpushed commits** are not checked, and there is no `--force` flag.

**When a folder is deleted by hand outside Weave:**

| Piece | What happens |
| --- | --- |
| git's worktree record | Stays until git prunes it. Weave calls `git worktree prune` only inside create rollback (`src/lib/worktrees.ts:572`). While it stays, git refuses `git branch -d`, `git checkout`, and `git worktree add` for that branch (observed on git 2.50.1; see External Dependencies). |
| `listGitWorktrees` | Still returns the entry. It parses only `worktree`, `HEAD`, `branch`, `detached`, and `bare` lines, so a `prunable` annotation is dropped (`src/lib/git.ts:145-168`). |
| `.git/weave/changes/<id>.yml` | Stays. Its slot no longer counts as used, because `nextFreeSlot` checks `pathExists(state.folder)` (`src/lib/worktrees.ts:666`). |
| `weave change list` | Skips the worktree entry because `<path>/wiki/changes/<id>/status.yml` is missing (`src/lib/changes.ts:1445-1447`). The change disappears unless the main checkout has its own `wiki/changes/<id>/`. |
| `weave change close` | The change does not resolve, so it fails `change_not_found` (`src/lib/changes.ts:775,1921-1922`). If only a nested repo's folder is gone, the change resolves, but `git status` in the missing directory fails and becomes a `Could not read git status` blocker (`src/lib/worktrees.ts:202-204`). |
| `weave change switch` | Falls through to `findChangeBranch`, which needs the change files committed on the branch. If git still lists the stale entry at the same path, `planTarget` returns `reuse` (`src/lib/worktrees.ts:468-472`), so the folder would not be recreated. Git does keep the `branch` line for such an entry (observed on git 2.50.1), so this path is taken. The `reuse` result was traced from code; `weave change switch` itself was not run against a deleted folder. |
| `weave status`, `weave doctor` | Nothing; neither reads worktrees or local state. |

**Tested by:** `tests/worktrees.test.ts`:

- list folders and slots, switch reuse (`:221-238`)
- opening a teammate's pushed change through `ls-remote` and fetch (`:240-274`)
- reopening after close (`:276-288`)
- `not_a_change_branch` (`:290-296`)
- close blockers (cwd inside the folder, an uncommitted file), kept branches, `pushed: false`, and slot reuse (`:298-321`)

`tests/changes.test.ts` runs in in-place mode only (its fixtures have no `checkout` key, `:14-36`).

Not tested: hand-deleted folders, stale worktree entries, pruning, `no_worktrees`, `worktree_remove_failed`, `state_locked`, close with no argument, and CLI-level JSON for list, switch, and close in worktree mode.

## `weave change list` merges the main checkout's change files with the root repo's worktree list

```text
listChanges                                     src/lib/changes.ts:490-505
├ branchChangeIdForTarget  current branch change/<id> → active id         :1388-1391
└ readChangesWithWorktrees                                                 :1435-1460
  ├ readChanges: subdirs of <target>/wiki/changes, newest first            :1406-1431
  ├ in-place → return those                                                :1437-1439
  └ worktree mode: for each `git worktree list` entry on change/<id>
      whose <path>/wiki/changes/<id>/status.yml exists:
        metadata from that file, folder = worktree.path,
        slot from .git/weave/changes/<id>.yml; replaces any same-id entry  :1441-1458
formatListMessage                                                          :2177-2198
```

- **Sources it uses:** the target's own `wiki/changes/*/status.yml`, `git worktree list` of the root repo only, and the local state file for the slot.
- **Sources it does not use:** local or remote `change/<id>` branches, which only `switch` consults (`:675-686`), and the worktrees of registered sub-repos.
- **JSON.** `ChangeListResult { status: "ok", targets: [{id?, name?, path, changes: ChangeSummary[]}], message }` (`src/lib/changes.ts:203-214`). Each `ChangeSummary` has these fields (`:179-201`):
  - identity: `id`, `slug`, `title`, `type`, `stage`, `branch`
  - lifecycle state: `stale`, `stale_history`, `artifacts`, `stress_tests`, `auto_advance`, `runs`, `knowledge?`
  - location: `path` (`wiki/changes/<id>`), `changePath` (absolute), `folder?`, `slot?`
  - `created_at?`, `updated_at?`, `active`

  There is no dirty flag, no per-repo worktree list, no `checkout` block, no branch-on-origin or merged state, and no last-commit time.
- **Text.** One line per change, `{*| } <id>  <type>  <stage>  <title>`, plus `    folder: <path>  (slot N)` when a folder is known (`:2190-2191`). The text shows nothing about stale artifacts.
- **Closed changes.** There is no "closed" state. After close, a change appears only if its files exist in the target checkout's own `wiki/changes/` (for example after a merge to main), and then it has no `folder` or `slot`. Otherwise it is gone from the list, but `switch` can reopen it from the kept branch.
- `change list` does not use `withNotices` (`src/commands/change.ts:155-166`).

**Tested by:** `tests/worktrees.test.ts:221-238` (folder and slot in worktree mode) and `tests/changes.test.ts:289-304` (the active marker, in-place). Worktree-mode text output and the JSON for a missing folder are not tested.

## Weave can read branch existence, remote-tracking refs, dirty state, and the worktree list, but not merge status, ahead/behind, or commit times

All git runs go through `node:child_process` `execFile` with no shell and no timeouts, including the network calls.

- The shared wrappers are in `src/lib/git.ts:8-16,82-109`: `git()` swallows errors into `undefined`, `runGit()` returns `{ok, stdout, stderr}` with a 32 MB buffer, and `runGitRequired()` throws. They merge default author and committer identities into the env (`:18-26`).
- `src/lib/changes.ts:2096-2108`, `src/lib/decisions.ts:608-615`, and `src/lib/sliceRollup.ts` keep their own private wrappers, without `gitEnv`.

| Fact | Available today | Helper and git command | Network |
| --- | --- | --- | --- |
| Repo root | yes | `findGitRoot` (`git.ts:28-30`) and `probeGitRoot` (`:118-127`), both `rev-parse --show-toplevel`. `probeGitRoot` separates `not_git` from real errors. | no |
| Common git dir | yes | `gitCommonDir`: `rev-parse --git-common-dir` (`:129-135`) | no |
| Current branch | yes | `currentBranch`: `branch --show-current` (`:32-39`); a private copy lives at `changes.ts:2077-2084` | no |
| Main checkout | yes | `mainWorktreePath`: first `worktree list` entry, unless bare (`:171-174`) | no |
| Worktree list | partly | `listGitWorktrees`: `worktree list --porcelain` into `{path, head?, branch?, detached, bare}` (`:137-168`). `prunable` and `locked` are not parsed, and nothing checks whether `path` exists on disk. | no |
| Local branch exists | yes | `branchExists`: `rev-parse --verify refs/heads/<b>` (`:50-57`); also `resolveCommit` (`:217-220`) and inline calls at `changes.ts:1321,2051` | no |
| Branch on origin | partly | Offline: `resolveCommit(refs/remotes/origin/<b>)`, which only knows the last fetch (`worktrees.ts:238,488,543`). Online: only `findChangeBranch` runs `ls-remote --heads origin refs/heads/change/*` (`changes.ts:680`). | ls-remote: yes |
| Dirty working tree | yes | `git status --porcelain` in `isWorktreeDirty` (`git.ts:41-48`, which returns `false` on git error), `assertCleanGitTargets` (`changes.ts:2061-2075`), and `removeChangeWorktrees` (`worktrees.ts:202-208`, the only one that counts lines) | no |
| Default branch | yes | `resolveDefaultBase` (`git.ts:186-215`). Without origin: `init.defaultBranch`, then `main`, then `master`. With origin: `origin/HEAD`, then optionally `remote set-head origin --auto`, then `origin/main` or `origin/master`, then the local default with a warning. `decisions.ts:24` has its own list. | `set-head --auto` and `fetch` only when `fetch: true` |
| HEAD commit | yes | `currentHead`: `rev-parse HEAD` (`git.ts:69-76`) | no |
| Merged into default | **no** | Nothing uses `branch --merged`, `merge-base --is-ancestor`, or `rev-list`. The only `merge-base` call is `decisions.ts:590`, which finds a diff base. | — |
| Ahead/behind | **no** | No `rev-list --count`, `@{u}`, or `--left-right` anywhere | — |
| Last commit time | **no** | No `log`, `for-each-ref --format=%(committerdate)`, or `show -s --format=%ct`. The only stored timestamps are `created_at` in the local state file and `base_commit` / `prepared_head` SHAs in `status.yml`. | — |
| Prune worktrees | rollback only | `git worktree prune` at `worktrees.ts:572` | no |

**Network operations in `src/`:**

- `clone` (`add-folder.ts:146`)
- `fetch` (`git.ts:207`; `worktrees.ts:486,530,541`; `changes.ts:710`)
- `remote set-head origin --auto` (`git.ts:195`)
- `ls-remote` (`changes.ts:680`)

Nothing pushes. A fetch failure becomes a warning (`git.ts:213`; `worktrees.ts:531-533`) or is ignored (`worktrees.ts:486`; `changes.ts:710`).

**Tested by:** `src/lib/git.ts` has no unit tests and git is never mocked. Every git test is an integration test against real temp repos with file-path bare remotes, so fetch and ls-remote hit the local filesystem:

- `tests/worktrees.test.ts`
- `tests/task-prepare.test.ts` (detached HEAD `:239`, dirty repos `:283-318`, branch mismatch `:103,221`)
- `tests/changes.test.ts` (`:63,185,440`)
- `tests/decisions.test.ts:236`
- `tests/init.test.ts:725,771,858`

Untested: the `resolveDefaultBase` `set-head` path, the `gitCommonDir` fallback, `listGitWorktrees` with prunable or locked entries, and network failure.

## "Stale" today means an artifact lane invalidated by an upstream lane

**The model.** These types live in `src/lib/changes.ts`:

```ts
type StaleChangeLanes = Partial<Record<ChangeStage, { invalidated_by: ChangeStage; invalidated_at: string }>>;  // :56, :122-125
interface StaleHistoryEntry { lane: ChangeStage; invalidated_by: ChangeStage|null; invalidated_at: string|null;
                              cleared_at: string; reason: string|null }                                       // :127-133
```

- **Lanes** are `questions, research, exploration, prd, findings, architecture, slices` (`:60`). Legacy `issues` maps to `slices` (`:61`). `questions` and `research` are evidence lanes, so progressing them never moves `stage` (`:62-65,802`).
- **The dependency graph** is not static. It is built from `status.yml.artifacts.<lane>.sources`, which each `weave change progress --source …` call replaces (`:803-809`). Valid sources are `questions, research, exploration, prd, architecture, discussion, sessions, codebase` (`:70-79`). Because `findings` and `slices` are not valid sources, progressing them never marks anything stale.
- **Progress** (`progressChange`, `:792-861`):
  1. It deletes the progressed lane's own stale entry (`:810-811`).
  2. It computes `transitiveDependents`, a BFS over the `sources` lists (`:814,1852-1871`).
  3. It filters them through `resolveStalePropagationTargets` (`:815-819,1815-1850`):
     - the default is all dependents
     - `--no-invalidate` gives none
     - `--invalidate=<list>` must name a subset of the dependents, or it fails `invalid_invalidate_target`
     - giving both fails `conflicting_stale_flags`, which only the library can hit, because the CLI shares one Commander option (`src/commands/change.ts:81-84,213-219`)
  4. It writes `{invalidated_by, invalidated_at}` for each target (`:820-825`). It assigns the `stale` map when non-empty and deletes the key when empty, so `status.yml` has no `stale:` key when nothing is stale (`:833-837`).
  5. Separately, `staleKnowledgeFromProgress` flips knowledge from `updated` or `none` to `stale` on every progress call, even with `--no-invalidate` (`:838,1753-1769`).
- **Clearing.** `weave change clear-stale <lane> [--reason]` (`clearChangeStaleness`, `:884-944`) removes one entry, appends to `stale_history` (reason stored as `null` when empty), and fails `lane_not_stale` when the lane isn't flagged. Nothing trims `stale_history`.
- **Parsing** is lenient. Malformed entries are dropped (`parseStaleLanes`, `:1517-1541`; `parseStaleHistory`, `:1495-1515`), and `readChangeMetadata` always supplies `{}` and `[]` (`:1477-1478`).

**User-facing text:**

| Where | Text |
| --- | --- |
| `change status`, `change current`, `change progress` text (`formatStaleLines`, `changes.ts:2299-2307`) | `Stale: <lane> (invalidated by <lane>), …`, left out when nothing is stale |
| `clear-stale` success (`:942`) | `Cleared stale flag for <lane> (was invalidated by <lane>).` plus ` Reason: <reason>` |
| Errors | `Lane "<lane>" is not currently marked stale; nothing to clear.` (`:899`), `Use either --no-invalidate or --invalidate=<list>, not both.` (`:1823`), `Cannot invalidate lanes that are not transitive dependents of the progressed lane: …` (`:1843`) |
| Progress note (`:1795`) | `No sources recorded for <lane>; downstream stale invalidation will only use explicitly recorded dependencies.` |
| `weave advance` `fresh` condition (`src/lib/advance.ts:308-313`) | `<from> is stale (invalidated by <lane>)` / `<from> is not stale` |
| `change list` | No stale text. The JSON still carries `stale`. |

**The same and related words elsewhere:**

| Term | Concept | Where | User-facing text |
| --- | --- | --- | --- |
| knowledge `stale` | knowledge freshness (`pending, stale, updated, none`) | `changes.ts:80,1732-1742,1753-1769` | `Knowledge: stale (invalidated by <src>)` |
| `outdated` (verdict) | stress-test verdict older than the lane's latest progress | `changes.ts:87-95,1585-1593`; `advance.ts:346-348` | `(outdated: shape changed since)` |
| `package_outdated` | newer npm version cached | `notices.ts:47-56` | `weave-it <x> is available (installed <y>). …` |
| `skills_outdated` / skill state `outdated` | `installed_from` ≠ bundled `last_changed_in` | `notices.ts:71-77`; `status.ts:97-98` | `<N> installed skill file(s) are out of date. …` |
| `isStale` (npm cache) | cache older than 24 h | `npm-version.ts:6,39-50` | none |
| `staleLockMs` | advance lock left by a crashed runner, 10 min | `advance.ts:37-38,479-485` | `Another weave advance is deciding the next phase for <id>. Try again shortly.` |
| worktree state lock | lock older than 30 s is taken over | `worktrees.ts:621-645` | `Another Weave command is updating <dir>. Try again.` |
| rollup "stale" | derived slice files would change | `sliceRollup.ts:350-360` | `Derived slice state is stale; run \`weave slice rollup\` to update.` |
| `prune` | `git worktree prune` during create rollback | `worktrees.ts:572` | none |
| orphan / abandoned / inactive | no code concept; "abandoned change" appears once in prose | `wiki/knowledge/domains/change-workflow/features/recorded-decisions/behavior.md:26` | none |

No code or text uses "stale", "orphan", "abandoned", or "inactive" for change folders, worktrees, branches, or slots.

The skills carry a byte-identical `# Lifecycle Staleness Verification` block, whose source of truth is `src/lib/skill-template-checks.ts:33-79`, in 9 progress-calling skills. `weave-next` recommends stale lanes first (`templates/skills/weave-next/SKILL.md:139-149`).

**Tested by:**

- `tests/cli-change-staleness.test.ts`: library-level, real temp git repo. It covers default, `noInvalidate`, and `invalidateOnly` propagation, both error codes, clear plus history, `lane_not_stale`, a null reason, and history preserved across clears (`:70-269`).
- `tests/cli-change-progress.test.ts`: CLI flag wiring for `--no-invalidate` and `--invalidate issues` (`:114-133`).
- `tests/changes.test.ts`: propagation, no `stale` key when empty, source inference, transitive propagation, re-progress clearing, the `Stale:` text, and knowledge staleness (`:533-977`).
- `tests/advance.test.ts`: `fresh: false` (`:215-225`) and an outdated verdict (`:380-394`).
- `tests/agent-skills.test.ts`: byte identity (`:636-653`).

The `clear-stale` CLI path and its text, `Stale:` lines in `current` and `progress` output, and `--invalidate=` with an empty value are not tested.

## The wiki says closing never deletes branches or work, and doctor's fixes stay narrow and additive

- **`change-checkouts.md`** (`wiki/knowledge/domains/change-workflow/domain-wide/change-checkouts.md`) describes worktree checkouts as above and states these behavioural rules:
  - No Weave command switches the branch of a main checkout in worktree mode (`:34`).
  - Nothing is created unless every repo passes its checks; a partial failure is rolled back (`:35`).
  - Setup commands never run without a person's approval on that machine, and skills and auto-advance cannot approve (`:36`).
  - Closing never deletes branches or uncommitted work (`:37`).
  - Worktree checkouts support macOS and Linux (`:38`).

  It also says "A slot frees up when its folder is closed or deleted" (`:23`), and that machine-local state lives in `.git/weave/` and is never committed (`:25`). `weave change list` "reads change files from every worktree on a `change/` branch, so the main checkout sees all open changes with their `folder` and `slot`" (`:21`).
- **`weave-doctor/behavior.md`** (`wiki/knowledge/domains/cli-commands/features/weave-doctor/behavior.md`):
  - Doctor is read-only by default (`:62`).
  - `--fix` only creates missing safe scaffold files and directories, never updates skills, changes branches, edits `status.yml`, mutates `wiki/changes/**`, or runs migrations (`:63-68`).
  - A missing active change is a warning, not an error (`:70`), and only `error` exits non-zero (`:71`).
  - Its open question leaves room for more check categories, and says "any stronger repair action should remain explicit and separate from v1 `doctor --fix`" (`:95`).
- **`weave-status/behavior.md`** (`wiki/knowledge/domains/cli-distribution/features/weave-status/behavior.md`) calls `weave status` "the canonical 'where do I stand?' surface and the destination every notice points to" (`:7`). It says the command "never writes the cache, never writes the manifest, never touches installed skill files" (`:21`).
- **`notices/behavior.md`** (`wiki/knowledge/domains/cli-distribution/features/notices/behavior.md`) defines the Tier 1 set of six commands. It says "Adding another Tier 1 command is a deliberate change; the rest of the CLI stays notice-free to keep `--json` payloads stable" (`:39`), and that all notice sources degrade silently on failure (`:16`).
- **`core-command-reference/behavior.md`** lists the `weave change` synopsis, including `list`, `switch`, `setup`, and `close [change]` (`:404-418`). It records no rule about detecting or removing folders.
- **`lifecycle-progress-and-staleness.md`** says hand-editing `status.yml` stale state is out of policy, and that the CLI is the only authorised writer (`:80`).

No wiki page or decision mentions detecting or reporting abandoned or hand-deleted change folders, and none gives Weave permission to remove a folder, worktree, branch, or state file on its own. The only removal paths documented are `weave change close`, which a person runs, and rollback of a failed create.

## Recorded Decisions

- **`261107-ohne-each-change-gets-its-own-worktree-folder`** (accepted 2026-11-07; applies to `src/lib/worktrees.ts`, `src/lib/changes.ts`, `src/lib/task-prepare.ts`, `src/lib/git.ts`).
  - **Decision.** With `checkout: worktree`, `weave change new` creates one folder per change holding worktrees of the root and each registered repo on `change/<change-id>`, with the main checkout's relative paths. Each starts from the freshly fetched remote default branch. Weave calls `git worktree` directly, and setup runs only at execution time after per-machine approval.
  - **Consequences that bear on folders:**
    - no command moves a main checkout
    - each change costs a full checkout on disk
    - "Weave owns the git edge cases itself (rollback, branch already checked out elsewhere, closing)"
    - Windows, submodules, and sparse checkouts are not handled
  - **Reconsider when** disk use or checkout time becomes a real cost, Windows support is needed, or an installable multi-repo worktree tool appears.
  - **How the code compares.** It matches the decision. The decision lists closing as a git edge case Weave owns, but says nothing about folders removed outside Weave, and the code has no handling for them.
- **`261101-opav-research-never-reads-intent`** governs this document: only `questions.md`, the code, and the wiki were read.
- **`261101-c4tg-human-decision-points-never-auto-advance`** (applies to `src/lib/lifecycle-transitions.ts`, `src/lib/advance.ts`) is the decision behind the advance `fresh` condition referenced above. It doesn't touch folders.

Wiki and code differ in one place, which is relevant only to the staleness vocabulary. `lifecycle-progress-and-staleness.md:104` says `weave-slices` "warns and blocks when `status.yml.stale.architecture` exists", but `templates/skills/weave-slices/SKILL.md` only contains the generic `# Lifecycle Staleness Verification` block and no such check.

## External Dependencies

**git `worktree`, `gc`, and merge checks.** Weave shells out to the system `git` and does not pin or check a version. Sources are the git-scm.com docs for 2.56; the 2.30.0 and 2.31.0 pages were compared for when features arrived.

- **A folder deleted by hand stays registered.** `git worktree list --porcelain` keeps listing it and adds a `prunable gitdir file points to non-existent location` line. Records are separated by blank lines; `bare` and `detached` appear only when true; `locked` and `prunable` may carry a reason. `prunable` and `locked` in porcelain output, and `list -v`, are in the 2.31.0 docs but not 2.30.0. `list --expire <time>` marks a missing worktree prunable only when it is older than `<time>`. ([git-worktree](https://git-scm.com/docs/git-worktree), [2.30.0](https://git-scm.com/docs/git-worktree/2.30.0), [2.31.0](https://git-scm.com/docs/git-worktree/2.31.0))
- **Adding at a missing path is refused.** `git worktree add` refuses a branch "already checked out by another worktree" (overridden by `--force`). It separately refuses a `<path>` that "is already assigned to some worktree but is missing (for instance, if <path> was deleted manually)" (overridden by `-f`, or `-f -f` when locked). `git checkout` refuses a branch "in use by another worktree" unless `--ignore-other-worktrees` is given. ([git-worktree](https://git-scm.com/docs/git-worktree), [git-checkout](https://git-scm.com/docs/git-checkout))
- **Pruning.** `git worktree prune` removes only the admin data in `$GIT_DIR/worktrees` for worktrees whose folders are missing, never branches. It has `--expire`, `-n` (dry run), and `-v`. `git worktree lock` stops automatic pruning. `git gc` runs `git worktree prune --expire <gc.worktreePruneExpire>`, which defaults to `3.months.ago`. `gc --auto` does this only when its thresholds trigger housekeeping. Weave never sets or reads this config. ([git-worktree](https://git-scm.com/docs/git-worktree), [git-gc](https://git-scm.com/docs/git-gc))
- **Merge checks are local-only.** `git branch --merged [<commit>]` and `git merge-base --is-ancestor A B` (exit 0 = ancestor, 1 = not) only read local refs and objects. Against `origin/<default>` they see the last fetch. Being pure reachability checks, they report a squash-merged or rebased branch as not merged. ([git-branch](https://git-scm.com/docs/git-branch), [git-merge-base](https://git-scm.com/docs/git-merge-base))
- **How this meets Weave's code.** `listGitWorktrees` drops the `prunable` line (`src/lib/git.ts:153-166`). `planTarget` looks up a branch's existing worktree entry before calling `git worktree add` (`src/lib/worktrees.ts:468-472`). The stale entry does carry its `branch` line (next bullet), so `switch` treats it as `reuse` and never reaches git's missing-path refusal.
- **Observed locally on git 2.50.1 (Apple Git-155), 2026-11-08.** In a throwaway repo, a worktree on branch `change/x` and a detached worktree were added, then their folders were removed with `rm -rf`.
  - `git worktree list --porcelain` still listed both. The branch worktree kept `branch refs/heads/change/x` and gained `prunable gitdir file points to non-existent location`; the detached one showed `detached` plus the same `prunable` line. `git worktree list -v` printed the same reason under each.
  - `git branch -d change/x` failed with `cannot delete branch 'change/x' used by worktree at '<missing path>'`.
  - `git checkout change/x` in the main worktree failed with `'change/x' is already used by worktree at '<missing path>'`.
  - `git worktree add <new path> change/x` failed with the same message.
  - `git worktree remove <missing path>` exited 0 with no output and dropped the entry from the list.
  - Only this git version was tried; the `prunable` reason text in other versions was not checked.
- **Observed locally on git 2.50.1: merge-tree against merged branches, 2026-11-08.** In a throwaway repo, `git merge-tree --write-tree main <branch>` was run for branches merged in different ways. Its output tree was compared with `main^{tree}`, where equal means merging would change nothing.
  - Equal for a `--no-ff` merge, a `--squash` merge of two commits, and a cherry-picked (rebase-style) copy.
  - Different for an unmerged branch, for a squash-merged branch with one later commit added on the branch, and for a squash-merged branch whose file main later edited.
  - Equal for a branch with no commits beyond `main` (`git rev-list --count main..<branch>` = 0).
  - `git cherry main <branch>` marked a single-commit squash's commit as already upstream (`-`) and a later branch commit as not (`+`). It does not match a multi-commit squash commit by commit.
  - Weave's code uses neither `merge-tree` nor `cherry` today. The `--write-tree` mode was not tried on any older git version, so its minimum version wasn't checked here.

## Code References

**`weave status` and notices** (exhaustive for the command):

- `src/commands/status.ts:5-21` — command wiring, JSON and text split
- `src/lib/status.ts:12-36` — `StatusSkillRow`, `StatusResult`, `BuildStatusOptions`
- `src/lib/status.ts:38-70` — `buildStatus`
- `src/lib/status.ts:72-113` — `collectSkillRows`, skill state precedence
- `src/lib/status.ts:115-172` — `renderStatusMessage`
- `src/lib/notices.ts:12-80` — `NoticeKind`, `Notice`, `gatherNotices`
- `src/lib/notices.ts:87-158` — `detectSkillDrift`
- `src/lib/notices.ts:160-177` — `isNewerVersion`
- `src/lib/npm-version.ts:6-91` — npm cache TTL, background refresh
- `src/lib/with-notices.ts:8-87` — `CommandOutput`, `withNotices`, footer rules
- `src/commands/workspace.ts:10-17`, `src/commands/doctor.ts:17`, `src/commands/change.ts:139,175,190` — the other Tier 1 call sites

**`weave doctor`** (exhaustive):

- `src/commands/doctor.ts:10-29` — command wiring, exit code
- `src/lib/doctor.ts:8-41` — types
- `src/lib/doctor.ts:43-57` — scaffold file and directory lists
- `src/lib/doctor.ts:59-182` — `buildDoctor` and the five checks
- `src/lib/doctor.ts:204-220` — `readActiveChange`
- `src/lib/doctor.ts:222-304` — rendering, overall status
- `src/lib/weave-scaffold.ts:12-56` — `ensureWeaveScaffold`
- `src/lib/workspace-mode.ts:24-83` — `findWorkspaceMode`

**Change folders and local state** (key files):

- `src/lib/worktrees.ts:82-99` — `LocalChangeState`, `workspaceCheckoutMode`, `changeFolderPath`
- `src/lib/worktrees.ts:101-160` — `ensureChangeWorktrees`
- `src/lib/worktrees.ts:162-242` — `removeChangeWorktrees`
- `src/lib/worktrees.ts:244-274` — `readLocalChangeInfo`, `recordCheckoutInStatus`
- `src/lib/worktrees.ts:276-378` — setup types, `runChangeSetup`
- `src/lib/worktrees.ts:384-440` — `workspaceLayout`, `changesRoot`, `selectTargets`
- `src/lib/worktrees.ts:442-588` — `planTarget`, `resolveBaseRef`, `applyPlan`, `rollback`
- `src/lib/worktrees.ts:590-612` — `copyIgnoredFiles`
- `src/lib/worktrees.ts:614-706` — `localStateDir`, `withStateLock`, local state I/O, `nextFreeSlot`, approvals, logs
- `src/lib/workspace-repos.ts:97-147` — `checkout`, `worktrees`, and per-repo settings parsing
- `src/lib/init-workspace.ts:483-484` — `weave init` writes `checkout: worktree`

**Change lifecycle and list** (key files):

- `src/commands/change.ts:120-166` — `new`, `list`
- `src/commands/change.ts:361-404` — `switch`, `setup`, `close`
- `src/lib/changes.ts:179-214` — `ChangeSummary`, `ChangeListResult`
- `src/lib/changes.ts:407-505` — `createChange`, `writeChangeFiles`, `listChanges`
- `src/lib/changes.ts:604-720` — `switchChange`, `openChangeFolder`, `findChangeBranch`
- `src/lib/changes.ts:730-790` — `setupChange`, `closeChange`
- `src/lib/changes.ts:1406-1460` — `readChanges`, `readChangesWithWorktrees`
- `src/lib/changes.ts:2177-2198` — `formatListMessage`

**Git helpers** (exhaustive for `src/lib/git.ts`):

- `src/lib/git.ts:8-26` — wrappers, `gitEnv`
- `src/lib/git.ts:28-109` — root, branch, dirty, branch-exists, checkout, HEAD, remote, `runGit`
- `src/lib/git.ts:111-174` — `probeGitRoot`, `gitCommonDir`, `listGitWorktrees`, `mainWorktreePath`
- `src/lib/git.ts:176-244` — `resolveDefaultBase`, `resolveCommit`, default-branch helpers
- `src/lib/changes.ts:2040-2108` — private `ensureChangeBranch`, `assertCleanGitTargets`, `currentBranch`, git wrappers
- `src/lib/decisions.ts:24,580-619` — ADR base candidates, `merge-base`, changed files

**Staleness** (key files):

- `src/lib/changes.ts:56-95` — lane, source, and knowledge constants; verdict types
- `src/lib/changes.ts:122-133` — stale types
- `src/lib/changes.ts:792-944` — `progressChange`, `clearChangeStaleness`
- `src/lib/changes.ts:1495-1541` — stale parsing
- `src/lib/changes.ts:1753-1871` — knowledge staleness, source inference, propagation targets, `transitiveDependents`
- `src/lib/changes.ts:2299-2339` — `Stale:` and knowledge text
- `src/commands/change.ts:81-84,200-240,503-519` — progress and clear-stale CLI
- `src/lib/advance.ts:37-38,308-348` — advance lock, `fresh` and verdict conditions
- `src/lib/skill-template-checks.ts:17-79` — byte-identical skill blocks

**Tests:**

- `tests/cli-status.test.ts`, `tests/notices.test.ts`, `tests/with-notices.test.ts`, `tests/cli-tier1-notices.test.ts`, `tests/npm-version.test.ts`
- `tests/cli-doctor.test.ts`
- `tests/worktrees.test.ts`, `tests/changes.test.ts`, `tests/task-prepare.test.ts`
- `tests/cli-change-staleness.test.ts`, `tests/cli-change-progress.test.ts`, `tests/advance.test.ts`, `tests/agent-skills.test.ts`

**Docs and decisions:**

- `wiki/decisions/261107-ohne-each-change-gets-its-own-worktree-folder.md`
- `wiki/knowledge/domains/change-workflow/domain-wide/change-checkouts.md`
- `wiki/knowledge/domains/change-workflow/domain-wide/lifecycle-progress-and-staleness.md`
- `wiki/knowledge/domains/cli-commands/features/weave-doctor/behavior.md`
- `wiki/knowledge/domains/cli-commands/features/core-command-reference/behavior.md`
- `wiki/knowledge/domains/cli-distribution/features/weave-status/behavior.md`
- `wiki/knowledge/domains/cli-distribution/features/notices/behavior.md`

## Open Questions

Questions 1-3 from the first research pass were answered on 2026-11-08 by a local git run and by reading `.git/weave/`. The results are in "Folders are created by `new`...", "Each change folder is a set of worktrees...", and External Dependencies.

1. **Resolved: git keeps the `branch` line for a hand-deleted worktree.** On git 2.50.1 it prints `branch refs/heads/<name>` plus `prunable gitdir file points to non-existent location`, so `weave change switch` takes the `reuse` path (`src/lib/worktrees.ts:468-472`).
2. **Resolved: a stale worktree entry blocks its branch.** `git branch -d`, `git checkout`, and `git worktree add` for that branch all fail while the entry exists. `git worktree remove <missing path>` succeeds and clears it.
3. **Resolved: `.git/weave/` matches the code.** It holds two state files under `changes/` (slots 1 and 2) and nothing else.
4. **Still open: other git versions.** Only git 2.50.1 was tried. The `prunable` reason text and the blocking behaviour were not checked on other versions, and Weave does not check the git version it runs.
