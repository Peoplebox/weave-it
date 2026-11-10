---
facet: schema
description: Data model, storage, migration, and compatibility design.
---

# Schema Design

## Current Model

- `.weave/workspace.yml` (project, committed): `version`, `mode`, `checkout`, `worktrees`, `repos`, `review:`, `advance:`.
- `~/.weave/settings.yml` (personal, never in the project; decision `261109-a8k5`): versioned, per-feature blocks shaped `<feature>: { default, projects: { <key>: … } }` (see `open` in `src/lib/user-settings.ts`).
- Change `wiki/changes/<id>/status.yml`: `stage`, `artifacts`, `stale`, `stale_history`, `stress_tests`, `knowledge`, `runs[]`, `review:`, `checkout`.
- Slice `task-slices/<NN>-<slug>/status.yml`: whitelisted fields only (`readSliceStatus`); unknown keys other than `review` are dropped by rollup.
- Machine-local `.git/weave/` state; `refs/weave/reviews/**` boundary refs.

## Proposed Model

**Project:** `.weave/workspace.yml`

```yaml
commits:
  enabled: true                  # default true when absent
  code_timeout_seconds: 300      # optional
  subject_template: "{subject}"  # optional; string, or a per-kind map:
  # subject_template:
  #   planning: "docs(weave): {subject}"
  #   catch-up: "docs(weave): {subject}"
  #   build: "feat({slice}): {subject}"
  #   fix: "fix({slice}): {subject}"
  #   final-fix: "fix: {subject}"
```

Read from the main checkout's `.weave/workspace.yml` and from the change folder's copy. If either says `enabled: false`, commits are off, so a team switching off on main stops in-flight changes too. Other keys come from the change folder's copy, falling back to main's.

**Personal:** `~/.weave/settings.yml`, following the existing per-feature shape

```yaml
commits:
  default: { enabled: false }
  projects:
    <project-key>: { enabled: false }
```

- Written by `weave settings commits on|off [--project]`.
- Project scope beats default scope.
- An unreadable or newer-version settings file means "no personal preference". The checkpoint result carries a `settings_unreadable` warning; commits are never blocked by it.

**Change:** `status.yml`

```yaml
commits:
  skipped: { reason: "<text>", at: "<iso>" }   # present only while skipped
runs:
  - ...existing run fields...
    checkpoint: { status: failed, reason: hooks_rejected, detail: "<first line>" }  # failures only
```

**Slice:** no new keys. Build and fix state lives in git history as commit trailers:

```text
Weave-Change: <change-id>
Weave-Checkpoint: planning | catch-up | build | fix | final-fix
Weave-Stage: <lane | verdict | clear-stale | knowledge | review>   (planning)
Weave-Slice: <slice-id>                                            (build, fix)
Weave-Coverage: <12 hex>                                           (build)
Weave-Run: <slice>/<run>   Weave-Round: <n>                        (fix)
Weave-Merge-Base: <sha>                                            (build, fix, final-fix)
```

**Machine-local:** `.git/weave/checkpoints.json`: `{ "announced": true }` once the notice reached an attended command.

**Effective switch** = (main and change `commits.enabled` both not false) AND NOT personal-off AND NOT `commits.skipped`. Resolved by `resolveCommitSettings()`; the result names which switch turned commits off.

## Migration Strategy

- No migration. Absent keys mean defaults (on, not skipped).
- Slices already ready for review at upgrade have no `Weave-Slice` commit, so the ordinary retry-window rule applies with no special case. If a later slice has already started, the old slice is superseded and nothing is committed for it. Otherwise its uncommitted code is build-committed at the next rollup, and if the person already committed it by hand, nothing is staged and no commit is made.
- Existing snapshot refs stay valid; `read()` handles both kinds.

## Compatibility

- Older Weave versions ignore the new config and status keys. Nothing new lives in slice `status.yml`, so an older rollup cannot erase build state.
- `weave change skip-commits` / `unskip-commits` mirror `weave review skip`.
- With commits off, no code path writes git history and `SnapshotBoundary` is used everywhere, matching today (FR37).

## Validation And Risks

- **Invariant:** Weave commits only to `refs/heads/<status.yml branch>`. It never pushes, never amends, and never rewrites history.
- **Invariant:** planning and catch-up commits stage only this change's planning scope (`index.md`, "Planning scope"); the moment commit also carries whatever the index already held.
- **Invariant:** code commits never stage other changes' `wiki/changes/<id>/` folders or `.weave/coding-guidelines*.md`.
- `subject_template` placeholders are validated on read. Unknown placeholders are kept literally, and `weave doctor` warns about them.
- The coverage lookup walks first-parent commits from HEAD to the diff base, capped at 500 commits. Past the cap, the slice is treated as having no build commit, and the build is attempted again (at worst a redundant "additional work" commit).
