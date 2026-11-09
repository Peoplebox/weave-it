# iTerm, Terminal, more agents, own agents, and SSH rules

## Outcome

The terminal side of the fixed list is complete:
- iTerm and Terminal windows on macOS.
- Codex, opencode, and Cursor's agent as step-two choices, alongside Claude and a plain shell.
- The person's own agents and custom install locations from `settings.yml`.
- Over SSH, Mac terminal windows are skipped with an explanation, and herdr and tmux still open.

## User flow

1. On a Mac outside tmux and herdr, the person picks "Terminal window" then "Codex". A Terminal window opens in the change folder running `codex -C <folder>`, and a login shell remains when Codex exits.
2. The person adds `agents: { pi: { command: "pi" } }` to `settings.yml`. `pi` appears in step two, and choosing it opens the terminal running `/bin/sh -c 'pi'`, with the step shown in the original session.
3. Connected over SSH with an iTerm default, a create reports `Didn't open: connected over SSH, so Mac windows are skipped.` plus the folder and step, and keeps the default.

## In scope

- `iterm` and `terminal` places: their own AppleScript openers with fully quoted values, `missing` and `unavailable_now` per the registry table, and `remoteOk: false`.
- Agents `codex` (`-C`), `opencode` (positional folder), and `cursor-agent` (`agent --workspace`), each with known absolute install paths and `draft: none`.
- Own agents (`agents:`) with no check and no draft, run via `/bin/sh -c`. `locations.<id>` adds absolute paths for listed ids only.
- SSH detection (`SSH_CONNECTION`/`SSH_TTY`), giving `skipped` (`ssh`) for `remoteOk: false` places.
- Pinning the exact install paths on macOS and Linux for the listed terminals and agents.

## Out of scope

- Apps (slice 04).
- Unsent drafts (slice 07).

## Acceptance criteria

- [ ] On macOS, `choices` includes iTerm (when installed) and Terminal. On Linux they are absent.
- [ ] Each agent's argv matches the registry, and folders and own-agent commands are quoted correctly.
- [ ] Own agents appear in step two marked `own: true` and never receive a draft.
- [ ] Over SSH, iTerm and Terminal are `skipped` (`ssh`), and herdr and tmux still open.
- [ ] A real iTerm window, a Terminal window, and each installed agent open correctly on a Mac (manual check).
