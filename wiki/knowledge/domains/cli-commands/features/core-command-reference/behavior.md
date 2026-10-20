# Core Command Reference

## Purpose

This document explains the core Weave CLI commands in plain English, with options, behavior, and examples for common user setups.

Use this as current-state product knowledge when deciding how `weave init`, `weave add`, and `weave workspace` should behave.

## Command Surface

| Command | Purpose | Mode-aware? |
| --- | --- | --- |
| `weave init` | Initialize Weave for the current context and start a local session. Picks between repo mode and workspace mode. | Sets the mode for the context. |
| `weave add <path \| url>` | Grow the current context: in repo mode, add a folder to the session; in workspace mode, register a sub-repo (path or git URL) under `workspace.yml`. | Yes — dispatches on `cwd`. |
| `weave workspace` | Show what is around the current directory: workspace view (workspace mode) or session folders (repo mode). | Yes — dispatches on `cwd`. |

Mode detection for `weave add` and `weave workspace` walks up from the current working directory looking for `.weave/workspace.yml` and reads its `mode` field. If `mode: workspace` is found, the context is workspace mode; otherwise it is repo mode.

## Current Behavior

`weave init` initializes Weave for the current working context and starts a local Weave session.

There are two init modes:

- `repo` mode: use this when the user wants Weave to work with only the current repo or folder.
- `workspace` mode: use this when the user wants a workspace that can contain multiple repos or folders for one product or platform boundary.

When no mode is passed in an interactive terminal, Weave asks the user to choose between repo mode and workspace mode.

When `--yes` is passed and no mode is provided, Weave defaults to repo mode.

If a valid `.weave/workspace.yml` already exists anywhere up the tree from `cwd`, `weave init` is a safe no-op: it reports `Weave is already initialized (mode: <repo|workspace>). Start a new change with \`weave change new "<title>"\`.` and exits successfully without re-scaffolding, overwriting files, running `git init`, moving the repo, or writing/replacing the local session. This makes re-running `weave init` on a cloned workspace safe and idempotent.

## Command: `weave init`

Synopsis:

```bash
weave init [options]
```

### Options

| Option | Default | Description |
| --- | --- | --- |
| `--mode <mode>` | (prompt; defaults to `repo` with `--yes`) | Init mode: `repo` or `workspace`. |
| `--workspace-name <name>` | basename of workspace path | Workspace name written to `.weave/workspace.yml` (workspace mode only). |
| `--workspace-path <path>` | (prompt) | Where the workspace directory lives. Required for workspace mode outside a git repo. |
| `--id <id>` | derived from folder name | Session folder id used in `session.folders.<id>`. |
| `--kind <kind>` | `app` | Folder kind recorded in the session. Workspace mode uses `workspace`. |
| `--yes` | off | Accept defaults, skip prompts. Required for non-interactive use. |

### Repo Mode

Repo mode initializes Weave directly in the current folder.

Use repo mode when:

- the project is a single repo;
- the user wants `wiki/` and `.weave/` to live inside that repo;
- automation needs the old deterministic behavior.

Example:

```bash
weave init --mode repo --yes
```

What happens:

- Weave creates `wiki/knowledge/`, `wiki/changes/`, `.weave/sync.yml`, and `.weave/architecture-considerations.md` if missing.
- Weave writes `.weave/workspace.yml` with `mode: repo` if missing.
- Weave starts the current local session with the folder kind set to `app` by default.
- Weave does not run `git init`.
- Weave does not move files.
- `.weave/architecture-considerations.md` is user-owned architecture guidance. Weave creates it once and never overwrites it.

### Workspace Mode In The Current Empty Directory

Workspace mode can turn the current empty directory into the workspace itself.

Use this when the user has already created the platform/workspace folder and wants Weave to use that folder as the workspace root.

Example:

```bash
mkdir peoplebox-platform
cd peoplebox-platform
weave init --mode workspace --workspace-path . --yes
```

What happens:

- The current directory becomes the workspace.
- Weave initializes git in the current directory.
- Weave creates `.gitignore`, `wiki/`, `.weave/sync.yml`, `.weave/architecture-considerations.md`, and `.weave/workspace.yml`.
- `.weave/workspace.yml` has `mode: workspace`.
- The workspace has no registered repos yet.
- Weave starts the current local session with `kind: workspace`.

### Workspace Mode Outside A Git Repo

When workspace mode runs outside a git repo and no `--workspace-path` is provided, Weave asks for a workspace path.

Use this when the user is in a scratch folder or parent directory and wants to create a workspace somewhere specific.

Example:

```bash
weave init --mode workspace --workspace-name peoplebox-platform --workspace-path ../peoplebox-platform --yes
```

What happens:

- Weave creates the target workspace directory if it does not already exist.
- Weave refuses unsafe existing target paths instead of overwriting user data.
- Weave initializes git in the workspace directory.
- Weave creates `.gitignore`, `wiki/`, `.weave/sync.yml`, `.weave/architecture-considerations.md`, and `.weave/workspace.yml`.
- Weave starts the current local session with `kind: workspace`.

### Workspace Mode From Inside A Git Repo

When workspace mode runs inside an existing git repo, Weave adopts that repo into the new workspace.

Use this when the user starts in an app repo but wants to create a higher-level workspace around it.

Example:

```bash
cd peoplebox-api
weave init --mode workspace --workspace-name peoplebox-platform --yes
```

What happens:

- Weave detects the git root even if the command runs from a nested subdirectory.
- Weave creates the workspace beside the repo.
- Weave moves the whole repo, including `.git/`, into the workspace.
- Weave preserves dirty, staged, deleted, and untracked files because it does not run a clean-worktree guard.
- Weave adds the adopted repo directory to the workspace `.gitignore`.
- Weave registers the adopted repo in `.weave/workspace.yml`.
- Weave starts the current local session with `kind: workspace`.

After this command, the user should open the workspace path in their editor.

## Command: `weave add`

`weave add` is mode-aware. Weave walks up from the current working directory to find `.weave/workspace.yml` and reads `mode`. The single argument is either a filesystem path or a git URL.

Synopsis:

```bash
weave add [options] <path>
```

### Options

| Option | Default | Description |
| --- | --- | --- |
| `<path>` | (required) | Filesystem path or git URL to add. Workspace mode also accepts URLs starting with `git@`, `https://`, `http://`, `ssh://`, `git://`, or `file://`. |
| `--id <id>` | slug of basename | In repo mode: `session.folders.<id>`. In workspace mode: `workspace.yml.repos.<id>`. |
| `--kind <kind>` | `app` | Folder kind recorded under the entry. |

`weave add` does not take a `--mode` flag; mode is detected from the directory tree.

### Repo mode

Use when Weave is initialized in repo mode, or when no workspace metadata applies (no `.weave/workspace.yml` above `cwd`, or `mode: repo`).

Example:

```bash
weave add ../backend --id backend --kind api
```

What happens:

- Weave resolves the target path.
- Weave scaffolds `wiki/`, `.weave/sync.yml`, and `.weave/architecture-considerations.md` in the target if missing.
- Weave adds the folder to `~/.cache/weave/current-session.yml` under `session.folders`. If no session file exists (for example on a fresh clone of a repo-mode workspace), Weave lazily creates one containing only the target folder and proceeds; the workspace-root repo is not auto-added.
- Weave does not update `.weave/workspace.yml` or `.gitignore` in a parent workspace.

If no `.weave/workspace.yml` exists anywhere up the tree, `weave add` returns `status: not_initialized` (exit 1) with the message `No Weave context found. Run \`weave init\` first.`

### Workspace mode

Use when the current context is inside a workspace with `mode: workspace` in `.weave/workspace.yml`.

Examples:

```bash
weave add ./billing
weave add ../external-tooling
weave add git@github.com:peoplebox/billing.git
weave add https://github.com/peoplebox/audit.git --id audit-service
```

What happens for a **path inside the workspace**:

- Weave computes the relative path from the workspace root.
- Weave appends `/<relative-path>/` to the workspace `.gitignore` (idempotent literal-line check).
- Weave records `remote.origin.url` when the folder has a `.git/` with an `origin` remote.
- Weave writes `repos.<id>` under `.weave/workspace.yml` with `path`, `kind`, and optional `remote`.
- Weave does **not** add the sub-repo to `session.folders`.

What happens for a **path outside the workspace**:

- Weave moves the folder (including `.git/`) into the workspace root using the basename as the destination directory.
- Weave refuses if the destination already exists.
- If the destination path is not already registered, Weave then registers and gitignores it as above.
- If the destination path is already registered but missing locally, Weave materializes the registered repo by moving the folder into that path and does not rewrite `.weave/workspace.yml` or `.gitignore`.

What happens for a **git URL**:

- Weave runs `git clone -- <url> <basename>` into the workspace root using the URL repo basename as the directory name.
- The `--` separator defends against URLs that start with `-` (option-injection).
- If the destination path is not already registered, Weave sets `repos.<id>.remote` to the URL used for the clone.
- If the destination path is already registered but missing locally, Weave materializes the registered repo by cloning into that path and does not rewrite `.weave/workspace.yml` or `.gitignore`.
- Weave refuses when an unregistered destination directory already exists, and does not write `.gitignore` or `workspace.yml`.

What happens on **duplicate add**:

- If the resolved relative path is already present in `workspace.yml.repos` and the repo directory is also present locally, Weave prints "already registered" and exits successfully without changing files. Passing a different `--id` for an already-registered present path is still a no-op.
- A registered path that is missing locally is not treated as a duplicate. It is a materialization target for `weave add <git-url>` or `weave add <local-path>`.

Example run inside a workspace:

```bash
$ cd peoplebox-platform
$ weave add ./billing
Registered repo in workspace: billing

Path:
  billing

Remote:
  git@github.com:peoplebox/billing.git

Workspace:
  /Users/arpit/work/peoplebox-platform

Next:
  weave workspace
```

After the command, the workspace's `.weave/workspace.yml` contains:

```yaml
version: 1
mode: workspace
name: peoplebox-platform
repos:
  billing:
    path: billing
    kind: app
    remote: git@github.com:peoplebox/billing.git
```

And `.gitignore` contains `/billing/` (in addition to anything that was already there).

## Command: `weave workspace`

`weave workspace` shows what is around you. It dispatches on the **current working directory**, not on session state. It is read-only — it never clones, moves, or writes to any file.

Synopsis:

```bash
weave workspace [options]
```

### Options

| Option | Default | Description |
| --- | --- | --- |
| `--json` | off | Emit machine-readable JSON instead of human-readable text. |

### Dispatch

`weave workspace` calls `findWorkspaceMode(cwd)` — the same helper `weave add` uses — and walks up from the current working directory looking for `.weave/workspace.yml`.

| `findWorkspaceMode(cwd)` result | Session present | Exit | Output |
| --- | --- | --- | --- |
| `mode: workspace` | yes or no | 0 | Workspace view: `workspace`, `repos`, `folders: []`. |
| `mode: repo` | yes | 0 | Repo-mode view: `session.folders` in `folders`. |
| `mode: repo` | no | 0 | Derived repo-root view: a single folder derived from the workspace root (no session write). |
| missing or malformed | no | 1 | `status: not_initialized` with `No Weave context found. Run \`weave init\` first.` |

A teammate cloning a workspace fresh can run `weave workspace` immediately, before ever running `weave init`. In workspace mode the view is fed entirely by the committed `workspace.yml`; no session is required. In repo mode with no session, the workspace root (the directory holding `.weave/workspace.yml`) is shown as a single derived folder, and no session file is written. `weave workspace` remains read-only in all paths.

### Workspace mode output

Triggered when `cwd` is inside (or is) a directory whose `.weave/workspace.yml` has `mode: workspace`.

Text:

```text
Weave workspace: peoplebox-platform

Path:
  /Users/arpit/work/peoplebox-platform

Repos:
  billing    billing    app    present    git@github.com:peoplebox/billing.git
  audit      audit      app    missing

Next:
  weave add <path|url>
  weave change new <title>
```

When there are no registered repos yet, the `Repos:` block reads `(no repos registered yet)`.

JSON (`--json`):

```json
{
  "session": { "status": "active", "updated_at": "2026-06-04T16:57:35.257Z" },
  "workspace": {
    "name": "peoplebox-platform",
    "path": "/Users/arpit/work/peoplebox-platform",
    "mode": "workspace"
  },
  "repos": [
    {
      "id": "billing",
      "path": "billing",
      "kind": "app",
      "availability": "present",
      "remote": "git@github.com:peoplebox/billing.git"
    },
    { "id": "audit", "path": "audit", "kind": "app", "availability": "missing" }
  ],
  "folders": []
}
```

The `session` key is `null` if no Weave session exists. The `folders` array is always `[]` in workspace mode (the workspace itself is the source of truth, not `session.folders`).

Each workspace-mode repo row includes runtime-only `availability`:

- `present`: the registered repo path exists locally under the workspace root.
- `missing`: the registered repo path does not exist locally.

Availability is computed when `weave workspace` renders the workspace view. It is not written back to `.weave/workspace.yml`, and missing repos do not cause `weave workspace` to fail or clone anything automatically.

### Repo mode output

Triggered when no workspace.yml is found above `cwd`, when `mode: repo` is recorded, or when the yml is malformed.

Text:

```text
Current Weave session

Folders:
  frontend  /Users/arpit/personal/frontend  app

Next:
  weave add <path>
  weave change new "<title>"
```

JSON (`--json`):

```json
{
  "session": { "status": "active", "updated_at": "2026-06-04T16:57:35.257Z" },
  "workspace": null,
  "repos": [],
  "folders": [
    {
      "id": "frontend",
      "path": "/Users/arpit/personal/frontend",
      "kind": "app",
      "wiki": "/Users/arpit/personal/frontend/wiki",
      "metadata": "/Users/arpit/personal/frontend/.weave"
    }
  ]
}
```

Top-level JSON keys (`session`, `workspace`, `repos`, `folders`) are present in both modes so consumers can branch on `workspace != null`. Mode-irrelevant fields are `null` or `[]`.

### Behavioral rules

- `weave workspace` does not change directories.
- `weave workspace` does not open the workspace in an editor.
- `weave workspace` does not clone, move, or modify files — use `weave add` to grow the workspace.
- In workspace mode `weave workspace` does not display `session.folders`. The workspace `workspace.yml` is the source of truth.
- A malformed `workspace.yml` is treated as if absent. The command falls through to repo mode silently (no warning, no crash).

## Change Command Context

`weave change` uses cwd-dispatched context resolution. It walks up from `cwd` to the nearest valid `.weave/workspace.yml`:

- `mode: workspace` resolves to the workspace root, so `workspace/wiki/changes/` is the single change store even when the command runs inside a registered sub-repo. The workspace root branch is the active-change authority.
- `mode: repo` resolves to the repo root, so nested directories do not create their own accidental `wiki/changes/`.
- No valid Weave mode file above `cwd` is an error; initialize the project with `weave init` first.

These command families no longer expose multi-target behavior. `--target`, `all` positional targets, and `weave change propagate` are removed.

### Command Synopsis

`weave change` manages durable change folders under the resolved root's `wiki/changes/` directory:

```bash
weave change new "<title>" [--type <type>] [--slug <slug>] [--json]
weave change list [--json]
weave change current [--json]
weave change status [change] [--json]
weave change switch <change> [--json]
weave change progress <lane> [--source <source>...] [--no-invalidate|--invalidate <lanes>] [--json]
weave change clear-stale <lane> [--reason <reason>] [--json]
weave change verdict <exploration|architecture> <holds|holds-with-changes|needs-reshaping|waived> [--reason <reason>] [--session <path>] [--json]
weave change knowledge <status> [--domain <domain>...] [--shared <shared>...] [--file <file>...] [--delta <path>] [--reason <reason>] [--invalidated-by <source>] [--json]
```

`weave task` manages task-oriented local workflow commands for the active change:

```bash
weave task prepare [--json]
```

`weave task prepare` is branch-readiness-only. In repo mode, it prepares the active repo root for `status.yml.branch`. In workspace mode, it prepares every registered workspace repo for `status.yml.branch`. It records readiness in `status.yml.execution.repos`. It does not inspect task artifacts, implement, verify, mark tasks done, commit, push, open PRs, stash, discard changes, or create remote branches.

### Examples

Workspace mode from a registered sub-repo:

```bash
cd peoplebox-platform/billing/src
weave change current
weave change progress prd --source sessions
```

Both commands walk up to `peoplebox-platform/.weave/workspace.yml`, operate on `peoplebox-platform/wiki/changes/`, and do not create `billing/wiki/`.

Repo mode from a nested directory:

```bash
cd single-app/src/routes
weave change new "Fix route loading" --type fix
weave change status
```

Both commands walk up to `single-app/.weave/workspace.yml` and operate on `single-app/wiki/changes/`.

JSON consumers:

```bash
weave change current --json
```

The `targets` field remains a one-element array for compatibility with existing skills and automation, even though the command surface is now single-context.

Removed behavior:

```bash
weave change new "Do thing" --target app
weave change current all
weave change propagate <change-id> --to api
```

These forms are no longer supported. Users should run commands from the desired workspace or repo context and let cwd dispatch select the single change store.

### Use Cases

#### Use Case: Workspace User Works Inside A Sub-Repo

A user edits code inside `peoplebox-platform/billing/` while the active Weave change lives at the workspace root. They can run `weave change current`, `weave change status`, and `weave change progress` from the sub-repo without first changing directory to the workspace root.

Expected outcome: Weave resolves `peoplebox-platform/` as the command root and reads or writes `peoplebox-platform/wiki/changes/`.

#### Use Case: Repo User Works Inside A Nested Source Directory

A user is inside `single-app/src/routes/` in a repo-mode project and creates a fix change.

Expected outcome: Weave resolves `single-app/` as the command root, creates `single-app/wiki/changes/<change-id>/`, and avoids accidental nested `src/routes/wiki/` scaffolding.

#### Use Case: Agent Resolves Current Context

An agent runs `weave change current --json` from the directory currently being edited.

Expected outcome: The agent receives the active branch-derived change for the containing workspace or repo root and reads `targets[0]`. The agent does not pass `--target`, `all`, or repo ids.

#### Use Case: User Attempts Old Multi-Target Commands

A user tries an older `--target`, `all`, or propagation command.

Expected outcome: Commander rejects the unknown option or subcommand. The recovery is to rerun the command from the desired workspace/repo context.

### Behavioral Rules

- `session.folders` may provide display metadata such as id and name for the resolved root, but `.weave/workspace.yml` is the source of root selection.
- Change commands do not add workspace sub-repos to `session.folders` merely because they are the current working directory.
- Change commands do not create `wiki/` or `.weave/` inside workspace sub-repos during context resolution.
- `weave change new` returns `targets: [...]` as a one-element array in JSON output for compatibility.
- `weave change progress` and stale propagation semantics are unchanged after the root is resolved.
- `weave change knowledge` records knowledge freshness for the active change in the resolved root and no longer accepts `--target`.

### Source Anchors

- Context resolver: `src/lib/workspace-mode.ts` (`findWorkspaceMode`, `resolveChangeContext`)
- Change command library: `src/lib/changes.ts` (`createChange`, `currentChange`, `statusChange`, `progressChange`, `knowledgeChange`)
- Task prepare library: `src/lib/tasks.ts`, `src/lib/task-prepare.ts`
- CLI command definitions: `src/commands/change.ts`, `src/commands/artifact.ts`, `src/commands/task.ts`, `src/commands/doctor.ts`
- Tests: `tests/changes.test.ts`, `tests/task-prepare.test.ts`, `tests/tasks.test.ts`, `tests/cli-change-progress.test.ts`, `tests/cli-change-staleness.test.ts`, `tests/cli-skills.test.ts`, `tests/cli-tier1-notices.test.ts`
- Skill guidance: `templates/skills/weave-new/SKILL.md`, `templates/skills/weave-next/SKILL.md`

## Use Cases

### Use Case: Single Repo Project

A user has one repo and wants Weave context in that repo.

They run:

```bash
weave init --mode repo --yes
```

The repo gets its own `wiki/` and `.weave/`. Future change artifacts and knowledge live in that repo.

### Use Case: User Already Made A Workspace Folder

A user creates a folder named after the product/platform boundary.

They run:

```bash
mkdir peoplebox-platform
cd peoplebox-platform
weave init --mode workspace --workspace-path . --yes
```

The folder itself becomes the workspace. This is the lowest-effort path when the user already knows the workspace name.

### Use Case: User Starts From An Existing App Repo

A user is inside `peoplebox-api` and realizes the feature spans backend, frontend, and maybe infra.

They run:

```bash
weave init --mode workspace --workspace-name peoplebox-platform --yes
```

Weave creates `peoplebox-platform/`, moves `peoplebox-api/` into it, git-ignores the app repo from the workspace git repo, and registers the app repo in workspace metadata.

### Use Case: Automation Wants Stable Repo Mode

Automation should avoid prompts.

It runs:

```bash
weave init --mode repo --yes
```

If automation omits `--mode`, `--yes` still defaults to repo mode for backward compatibility.

### Use Case: Agent Needs To Know The Current Context

An agent wants to know which folder Weave currently considers active.

It runs:

```bash
weave workspace --json
```

If the agent is inside a Weave workspace, the JSON response describes the workspace, its registered repos, and each repo's local availability. Otherwise it lists the session folders.

### Use Case: Teammate Joins From A Fresh Clone

A teammate clones the workspace and wants to see what's inside before doing anything else.

They run:

```bash
git clone git@github.com:peoplebox/peoplebox-platform.git
cd peoplebox-platform
weave workspace --json
```

The command reads `.weave/workspace.yml` directly and returns the workspace name, root path, registered repos, and whether each registered repo is present or missing locally. No `weave init` is required first. Missing repos are informational in this command; Weave does not clone or pull them automatically.

### Use Case: Grow A Workspace After Init

A user already has `peoplebox-platform/` as a workspace and wants to add `billing`.

They run:

```bash
cd peoplebox-platform
weave add git@github.com:peoplebox/billing.git
weave workspace
```

Weave clones `billing/`, gitignores it, registers it in `workspace.yml`, and `weave workspace` lists it under `Repos:`.

### Use Case: Teammate Materializes A Missing Registered Repo

A teammate clones a committed workspace where `.weave/workspace.yml` already lists `billing`, but `/billing/` is gitignored and missing locally.

They run either:

```bash
cd peoplebox-platform
weave add git@github.com:peoplebox/billing.git
```

or, if they already have a local checkout elsewhere:

```bash
cd peoplebox-platform
weave add ../billing
```

Expected outcome: Weave recognizes that `billing` is registered but missing locally. The git URL form clones into `peoplebox-platform/billing`; the local path form moves the local folder into `peoplebox-platform/billing`. In both cases, Weave does not rewrite `.weave/workspace.yml` or `.gitignore`.

## Source Anchors

- `src/commands/init.ts`: defines `weave init` and its options (`--mode`, `--workspace-name`, `--workspace-path`, `--id`, `--kind`, `--yes`).
- `src/lib/init-workspace.ts`: implements repo mode, workspace mode, current-repo adoption, workspace metadata, git initialization, and session updates. Uses `registerRepoIntoWorkspace` for adopted-repo registration.
- `src/commands/add.ts`: defines `weave add` and its options (`--id`, `--kind`).
- `src/lib/add-folder.ts`: mode-aware add. Repo mode writes `session.folders`; workspace mode dispatches on URL vs path-inside vs path-outside and writes `workspace.yml.repos`.
- `src/lib/workspace-mode.ts`: `findWorkspaceMode(cwd)` walks up looking for `.weave/workspace.yml` and reads `mode`. Shared by `weave add` and `weave workspace`.
- `src/lib/workspace-repos.ts`: workspace.yml repos registry, idempotent `.gitignore` append (`/<path>/`), URL helpers (`isGitUrl` supports `git@`, `https://`, `http://`, `ssh://`, `git://`, `file://`), `registerRepoIntoWorkspace` (the single write path used by both init and add).
- `src/lib/git.ts`: `cloneRepo` runs `git clone -- <url> <dest>` (the `--` separator is intentional to block URL-as-flag injection); `getGitRemote` reads `remote.origin.url`.
- `src/commands/workspace.ts`: defines `weave workspace` and passes `process.cwd()` to `showWorkspace`.
- `src/lib/show-workspace.ts`: `showWorkspace({ cwd })` dispatches on `findWorkspaceMode(cwd)`; emits stable top-level JSON keys (`session`, `workspace`, `repos`, `folders`) and computes workspace repo `availability` at render time.
- `tests/init.test.ts`: covers init modes, repo-mode add, workspace-mode add (path inside, path outside adoption, URL clone, missing registered repo materialization from both local path and git URL, non-git folder, duplicate, refused destination, slug from `--id`), `weave workspace` workspace-mode view (root and from a subdirectory), present/missing workspace repo availability, `weave workspace` workspace-mode without a session, `weave workspace` repo-mode view, and graceful fall-through on malformed workspace.yml.

## Change History

- 2026-06-04: Added current command reference for init modes, workspace setup paths, examples, and `weave workspace` session behavior.
- 2026-06-04: Documented mode-aware `weave add` and workspace-mode `weave workspace` repos listing.
- 2026-06-04: Reworked `weave workspace` to dispatch on cwd (shared `findWorkspaceMode` helper). Workspace mode renders a workspace view (`workspace`/`repos` keys) and no longer requires an active session; repo mode renders session folders without crawling workspace.yml.
- 2026-06-04: Added a Command Surface overview and per-command Options tables, dispatch decision table for `weave workspace`, sample text and JSON outputs for both modes, and an explicit `file://` URL scheme entry in `weave add`. Documented `git clone -- <url> <dest>` separator as an intentional injection guard.
- 2026-06-07 (change `260607-vuwa-architecture-skill-update`): `ensureWeaveScaffold` now creates `.weave/architecture-considerations.md` as user-owned architecture guidance during init and scaffold repair paths.
- 2026-06-08 (change `260608-78sp-fix-weave-add`): Workspace `weave add` now treats registered-but-missing repo paths as local materialization targets for both git URLs and local paths instead of duplicate adds.
- 2026-07-21 (change `260721-6d48-fix-init`): Cloned Weave workspaces now work without `weave init`. `weave init` is a safe no-op when `.weave/workspace.yml` already exists up the tree (no re-scaffold, no repo move, no session write). `weave add` in repo mode lazily creates a session containing only the target folder when no session exists. Repo-mode `weave workspace` with no session derives the workspace-root folder without writing. The `no_session` JSON status is renamed to `not_initialized` and is emitted only in the genuine uninitialized case.
