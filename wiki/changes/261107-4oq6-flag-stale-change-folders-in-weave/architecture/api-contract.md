---
facet: api-contract
description: CLI contracts for change list, status, refresh, close, switch, and agent guidance.
---

# API Contract Design

## Consumers And Producers

- **Producers:**
  - `weave change list` (`src/lib/changes.ts` `listChanges`, new `change-states.ts` rendering)
  - `weave status` (`src/lib/status.ts`)
  - the hidden `weave change refresh` (`change-refresh.ts`)
  - `weave change close` and `weave change switch`
- **Consumers:**
  - developers, through the text output
  - AI agents and Weave skills, through `--json`
  - existing scripts that read today's `weave change list --json`
  - `261107-6c16-close-delete-merged`, which reads `state.id` and calls `landed.ts`

## Contract Shape

### `weave change list [--all] [--fetch] [--json]`

**Text layout:** today's first line is kept, and new indented lines are added under it.

```text
change folders unavailable at <path> (drive not mounted?)        ← only when it applies

* <id>  <type>  <stage>  <title | (title unknown)>
    <state label>[ · <label text>]…[ — <repo>: <repo state> · …]
    next: <command>[ | <command>]                                 ← when next.commands is non-empty, or next.text
    folder: <path>  (slot N)                                      ← existing folder (today's line)
    folder not found at <path>  (slot N)                          ← missing folder
    as of last fetch: <repo> <age>[ (<problem>)] · …              ← only when repos differ or a refresh failed

as of last fetch, <age>[ · refreshing now, run again in a few seconds for the latest]
```

**State ids, labels, and next steps:**

| `state.id` | Label (printed exactly) | `next.commands` | `needs_attention` |
| --- | --- | --- | --- |
| `folder_unavailable` | `change folders unavailable` | `[]`; `next.text`: `reconnect <changes root>` | false |
| `folder_missing` | `folder missing: not found at <path>` | `["weave change close <id>"]`, plus `"weave change switch <id>"` when `status.yml` is committed on the branch | true |
| `folder_missing_kept` | `folder missing (kept on purpose)` | `[]`; `next.text`: `unlock with: git worktree unlock <path>` | false |
| `landed_with_newer_commits` | `landed in <t> (<method>), with newer commits` | `[]`; `next.text`: `review the newer commits before closing` | false |
| `landed` | `landed in <t> (<method>)`, plus `, not in <default> yet` when `<t>` ≠ the default branch; with method `contained`: `nothing left to merge: every commit is already in <t>` | `["weave change close <id>"]`; with `uncommitted_files`: `[]`, and `next.text`: `commit or discard the N uncommitted files, then weave change close <id>` | true |
| `in_progress` | `in progress` | `[]` | false |
| `closed_not_landed` | `closed, work not in <t>` | `["weave change switch <id>"]` when `status.yml` is committed on the branch; otherwise `[]` and `next.text`: `recover the work with: git worktree add <path> change/<id>` | false |
| `closed_unchecked` | `closed, couldn't check whether it landed` | same as `closed_not_landed` | false |
| `done` | `done` (shown only with `--all`); includes no-folder branches with no commits | `[]` | false |

**Notes and label texts:**

- `work already landed in <t>`: a note on `folder_missing`. `next.commands` then drops `switch`.
- `nothing was committed, so its planning files can't be recovered`: a note on `folder_missing` when the branch has no `status.yml`.
- **Labels:**
  - `N uncommitted files in folder`
  - `no commits yet`
  - `couldn't check whether this landed: <reason>`
  - `branch deleted on origin; it may have landed`
  - `starting branch unknown`
  - `on origin; run git fetch to see it locally`
- **List-level lines:**
  - on git < 2.38, one line: `git 2.38+ is needed to detect squash merges`, instead of per-change labels
  - `couldn't check whether this landed: still checking` when the 2 s inline budget ran out
- **Refresh problems:**
  - `couldn't refresh: origin needs a login`
  - `couldn't reach origin`
  - `last refresh timed out`
  - `couldn't refresh: <message>`

**JSON:** additive to today's `ChangeListResult` (`src/lib/changes.ts:203-214`).

```jsonc
{
  "status": "ok",
  "targets": [{
    "id": "...", "name": "...", "path": "...",
    "freshness": { "refreshing": false, "as_of": "<iso|null>" },         // new
    "unavailable": { "path": "<changes root>" },                           // new, only when it applies
    "changes": [{
      // ── today's ChangeSummary fields: all present, same types and meanings ──
      "id", "slug", "title", "type", "stage", "stale", "stale_history", "artifacts",
      "stress_tests", "auto_advance", "runs", "knowledge?", "branch", "path", "changePath",
      "folder?",            // only when the folder exists
      "slot?", "created_at?", "updated_at?", "active",
      // when planning files are unavailable: id, slug, branch, path are always real; title, type, stage
      //   come from the branch's committed status.yml when present, else ""; other strings "",
      //   objects {}, arrays [], changePath ""
      // active and targets[].path keep today's cwd-based meaning (active = cwd branch is change/<id>)
      // ── new ──
      "planning": { "available": true } | { "available": false, "reason": "folder missing" | "no folder" },
      "missing_folder": "<recorded path>",                                  // folder_missing* only
      "state": { "id": "<state id>", "label": "<printed label>", "note": "<string>?",
                 "next": { "commands": ["<argv-ready string>"], "text": "<string>?" },
                 "needs_attention": true },
      "labels": [ { "id": "uncommitted_files", "count": 2, "text": "2 uncommitted files in folder" } ],
      "landed_check": { "status": "checked" } | { "status": "unchecked", "reason": "<string>" },
      "repos": [ { "id": "root", "path": ".", "state": "<repo status>",
                   "target": { "branch": "main", "ref": "refs/weave/remotes/origin/main", "sha": "…" },
                   "method": "merged|contained|rebased|squashed|null",
                   "base_source": "created|reflog|unknown",
                   "local_view_older": false,
                   "as_of": "<iso|null>",
                   "refresh": "ok|timeout|auth|unreachable|no_remote|error|null" } ]
    }]
  }],
  "message": "<text output>"
}
```

- **Label ids:** `uncommitted_files`, `no_commits_yet`, `couldnt_check`, `may_have_landed`, `starting_branch_unknown`, `local_view_older`.
- **Mode gate:** in in-place mode, `list` output and JSON are exactly today's, with no new fields and no refresh. The gate lives in `src/commands/change.ts` (C11).

### `weave status [--json]`

- **Text:** one line before `Notices`, only when `total > 0`: `<N> change(s) need attention (<n> landed, <m> folder missing). Run 'weave change list'.` Zero counts are omitted from the parentheses.
- **JSON:** adds `"changes_attention": { "total": 2, "counts": { "landed": 1, "folder_missing": 1 }, "computed_at": "<iso>" }`, or `null` when there's no snapshot or the repo isn't in worktree mode.
- **Resolution:** `findWorkspaceMode(cwd)` → `mainWorktreePath` → `<git-common-dir>/weave/attention.json`. It never runs git network or landed checks.

### `weave change refresh --root <path>` (hidden)

- **Not shown** in `--help`.
- **Exit:** always 0. Results are only recorded in `refresh.json`.
- **Env and flags:** the caller's env plus the hardened fetch env, config, and no-terminal session in schema.md, "Ref namespace". This applies to in-process `--fetch` too.
- **Suppressed** entirely when `WEAVE_NO_BACKGROUND_REFRESH=1` (no spawn).

### `weave change close <id>` (changed)

- **New refusals:**
  - `changes_unavailable`: "Change folders are unavailable at <path>; reconnect the drive or folder first."
  - `worktree_locked`: "<path> is locked; unlock with `git worktree unlock <path>` first."
- **Behaviour on a missing folder:** succeeds, and adds the warning "if you moved this folder, move it back first; closing stops tracking it" to the text and `warnings[]`.
- **Afterwards:** recomputes `attention.json`, so `weave status` drops the change.
- The existing JSON fields are unchanged.

### `weave change switch <id>` (changed)

- **Recreates** missing worktrees, including after a move or a `worktrees.root` change (C12). It recomputes `attention.json`.
- **`change status <id>` and opening a folder** for a missing-folder change report "folder missing; run `weave change list`" instead of `change_not_found`.
- **New text and JSON:**
  - `slot_changed: {from, to}`, when the slot was reassigned
  - `setup_reset: [<repo>]`, listing the recreated repos

### Skill and agent guidance

- Skills that close changes or report cleanup state (`weave-next`, `weave-execute` close-out, and the future 6c16 skill) use `weave change list --fetch --json`, and match on `state.id`, never on `state.label`.
- The `core-command-reference` and `weave-status` knowledge pages document the contract.

## Versioning And Compatibility

- **No `--json` field** that exists today is renamed, removed, retyped, or given a new meaning. `folder` means an existing folder only.
- **New fields are added.** Consumers must ignore unknown fields, as today.
- **Default membership changes:** past changes need `--all`. This goes in the release notes.
- **State ids and label ids** are a stable contract from this release. Label text may be reworded; ids may not.

## Authorization And Validation

- Local only. There are no new permissions.
- `next.commands` contain only `weave change close|switch <id>` with a validated change id, and no user-controlled text.
- The refresh never prompts and never writes outside `refs/weave/*` and `.git/weave/`.

## Observability And Testing

- **Observability:** `refresh.json` records the last attempt, success, and result per repo, which is surfaced in the list's age line and in `--json` `repos[].refresh`. There's no logging beyond that, matching today's CLI.
- **Contract tests:**
  - text layout snapshots for every state and label
  - a JSON field-presence and type check against today's `ChangeSummary` keys
  - the `weave status` line and its `--json`
  - `next.commands` executed as given in integration tests, which must succeed
  - assertions that `refs/remotes/*` and `FETCH_HEAD` are untouched after a refresh
- **The test seams:**
  - `WEAVE_NO_BACKGROUND_REFRESH=1`
  - `WEAVE_TEST_GIT_NO_MERGE_TREE=1`, to simulate git < 2.38
  - an injectable clock and timeout for refresh liveness
