# Contracts: iTerm, Terminal, more agents, own agents, and SSH rules

## Interfaces

- Registry entries:
  - `iterm` and `terminal` (`kind: terminal`, `platforms: [darwin]`, `remoteOk: false`)
  - `codex`, `opencode`, `cursor-agent` (`AgentEntry`)
- `--agent` accepts the new ids and own-agent names. `choices[].agents[]` gains `{ id, label, own?: true }`.

## Data

- `settings.yml` `agents.<name>: { command, label? }` and `locations.<listed id>: <absolute path>` (`schema.md`).
- Install path tables in `open-places.ts`, covered by tests.

## State

- `missing` only from absolute paths. iTerm is `missing` when `/Applications/iTerm.app` and `locations.iterm` are both absent. Terminal is never `missing`.
- A listed agent that isn't found gives `failed` (`agent_not_found`), and the default is kept. An own-agent name removed from settings is unknown, so that entry is cleared.
- SSH gives `skipped` (`ssh`) before any `check()` of a `remoteOk: false` place.

## Validation and errors

- AppleScript lines: `shellQuote` on every value, then the AppleScript string escaping. No unquoted interpolation.
- Own-agent `command` is the only shell line accepted from settings. It is run as written, with no draft appended.

## Files and artifacts

- Modified: `src/lib/open-places.ts`, `src/lib/open-change.ts` (SSH rule), `tests/open-places.test.ts`, `tests/open-change.test.ts`.
