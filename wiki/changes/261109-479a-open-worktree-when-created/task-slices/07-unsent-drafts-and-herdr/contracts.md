# Contracts: Unsent drafts where supported, and herdr bring-forward

## Interfaces

- `AgentEntry.draft` / `Place.draft`: `"unsent" | "none"`. `open(req)` receives `draft?: string` only when the effective capability is `unsent`.
- herdr: `tab.new` gains `task` when verified. A possible `findTabInFolder` uses whatever `herdr-app` exposes (to confirm).

### Manual check results (2026-11-10, slice 07 T1)

| Tool | First message | Result |
| --- | --- | --- |
| herdr `tab.new` `task` | appended to the agent argv (`claude "<task>"`) | **sent**, so `none` |
| Claude desktop `claude://code/new?q=` | put in the composer | **unsent**, so `unsent` |
| Claude CLI positional prompt | submitted at start | **sent** (known), so `none` |
| Codex, opencode `--prompt`, Cursor's agent | not checked | stay `none` |

## State

- Effective draft capability: for a terminal, the place's draft mechanism (herdr `task`), otherwise the agent's. For an app, the app's.
- The draft is always one argv element or JSON field, never part of a shell line.
- herdr bring-forward follows the same rules as tmux (slice 02 T4): only after a non-`none` choice, never with an explicit `--in`, and a 2 s timeout.

## Validation and errors

- If the draft injection fails, Weave opens without the draft and reports `draft: "shown"`. It never fails the open because of the draft.

## Files and artifacts

- Modified: `src/lib/open-places.ts`, `src/lib/open-change.ts`, `tests/open-places.test.ts`, `tests/open-change.test.ts`, `wiki/changes/261109-479a-open-worktree-when-created/architecture/index.md` (Risks: record the outcomes).
