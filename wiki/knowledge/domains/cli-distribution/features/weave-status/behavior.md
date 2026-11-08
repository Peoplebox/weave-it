# weave-status

## Purpose

A single read-only command that gives the full picture of installed `weave-it` package version, every installed skill's version/drift state, and the same notices the Tier 1 commands surface.

`weave status` is the canonical "where do I stand?" surface and the destination every notice points to.

## Current Behavior

`weave status` (and `weave status --json`) is one of the five Tier 1 commands. It:

- Reads `package.json.version` from the installed `weave-it` package by walking up from the CLI's own module path.
- Reads the cached npm-registry latest version for `@weave-tools/weave-it` from `~/.weave/cache/npm-version.json` (no blocking fetch; honors opt-out env vars).
- Walks `.weave/agents.yml` for the current cwd; for each installed skill it stats the file on disk, hashes it, and compares against the manifest `installed_hash` and the bundled `last_changed_in`.
- Composes a `notices` array using the standard `gatherNotices()` path (so notices match what other Tier 1 commands return).
- Renders either a human table (default) or a structured JSON document (`--json`).

Outside a Weave-managed folder (no `.weave/agents.yml`), `weave status` still reports the package version and notices array, with `inRepo: false` and `skills: []`.

In a worktree-mode repo or workspace (from the main checkout, a change folder, or any subfolder), it also reads the attention snapshot `weave change list` leaves in `.git/weave/attention.json` and, when the total is above zero, prints one line before the notices: `<N> change(s) need attention (<n> landed, <m> folder missing). Run 'weave change list'.` Zero counts are left out. It never fetches or runs the landed check itself, so it can briefly lag behind the list. See [change-folder-states](../../../change-workflow/features/change-folder-states/behavior.md).

The command is read-only; it never writes the cache, the manifest, the attention snapshot, or installed skill files.

## Domain Model

JSON output shape (`weave status --json`):

```jsonc
{
  "status": "ok",
  "packageVersion": "0.1.0",
  "cwd": "/Users/.../repo",
  "inRepo": true,                  // false outside a Weave-managed folder
  "skills": [
    {
      "agent": "claude",
      "name": "weave-explore",
      "installed_from": "0.1.0",   // null for legacy manifest entries
      "current": "0.1.0",          // "unknown" if templates not reachable
      "state": "current"           // current | outdated | modified | missing
    }
  ],
  "changes_attention": {           // null without a snapshot or outside worktree mode
    "total": 2, "counts": { "landed": 1, "folder_missing": 1 }, "computed_at": "<iso>"
  },
  "notices": []                    // same shape as other Tier 1 commands
}
```

Human output groups installed skills in a fixed-width table (`agent`, `skill`, `state`, `installed_from`, `current`) sorted by agent (`claude`, `codex`, `cursor`, `opencode`), then by install order. The body ends with `Notices: none.` or a numbered list of notice messages.

## Behavioral Rules

- `state` is computed in this priority order: `missing` > `modified` > `outdated` > `current`. A `modified` skill never shows `outdated`.
- `current` reports `unknown` when the bundled templates directory cannot be reached (e.g., a corrupted install). The CLI does not crash.
- `inRepo` is `false` when `.weave/agents.yml` is absent; in that case `skills` is `[]`.
- The npm cache value (`npmLatest`) is taken from the cache file only; `weave status` never triggers a synchronous fetch. The first run on a cold machine reports `npm latest (cached): unknown` and triggers a background refresh from `https://registry.npmjs.org/@weave-tools%2fweave-it/latest`.
- `weave status` honors `WEAVE_NO_NOTICES=1` and `NO_UPDATE_NOTIFIER=1`: `notices` becomes `[]` and `npmLatest` becomes `null`.

## Integrations And Side Effects

- Uses `getNpmVersionInfo()` from `src/lib/npm-version.ts` to read (not block on) the cached npm latest version.
- Uses `gatherNotices()` from `src/lib/notices.ts` so its `notices` array matches what other Tier 1 commands return for the same repo state.
- Wraps the action with `withNotices()` so the table output gets the standard stderr footer when interactive.

## Source Anchors

- Command: `src/commands/status.ts`
- Action and table renderer: `src/lib/status.ts` (`buildStatus`, `collectSkillRows`, `renderStatusMessage`, `readPackageVersion`, `readChangesAttention`, `attentionLine`)
- Attention snapshot: `src/lib/change-attention.ts`
- Tier 1 wrapper: `src/lib/with-notices.ts`
- User-paths: `src/lib/user-paths.ts` (`getNpmVersionCachePath`)
- Tests: `tests/cli-status.test.ts`

## Change History

- 2026-06-03 (change `260603-piln-npm-and-skill-versioning-and-updates`): `weave status` introduced as the fifth Tier 1 command and the canonical detailed view of package, skill, and notice state.
- 2026-06-07 (change `260607-vuwa-architecture-skill-update`): npm latest refresh targets the scoped package metadata for `@weave-tools/weave-it` instead of the unscoped `weave-it` package name.
- 2026-11-09 (change `261107-4oq6-flag-stale-change-folders-in-weave`): added the change attention line and `changes_attention`.

## Open Questions

- Whether to expose remediation commands per skill state directly in the human table (current implementation defers to README and notice messages).
