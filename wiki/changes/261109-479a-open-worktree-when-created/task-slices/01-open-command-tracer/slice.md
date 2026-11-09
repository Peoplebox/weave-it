# weave change open with saved settings (tmux, herdr, claude, shell)

## Outcome

A person (or agent) can run `weave change open [<change>]` and the change folder opens in a new tmux window or herdr tab running Claude or a plain shell. The choice can be saved as a personal default or a per-project override in `~/.weave/settings.yml`. When no choice exists, the command shows the two-step menu at a real terminal, or returns `needs_choice` with `choices` in `--json`. This is the tracer bullet: settings store, registry, resolution, opening, outcome reporting, and the test guard, end to end, with two terminals and two agents.

## User flow

1. Inside tmux, the person runs `weave change open --in tmux --agent claude --remember`.
2. Weave checks tmux and claude, opens a foreground tmux window in the change folder running `claude`, and keeps a login shell after it exits.
3. Weave saves `{place: tmux, agent: claude}` as the default and prints `Opened in tmux window …, continue there.` plus the folder and next step.
4. Next time `weave change open` uses the default without asking.
5. An agent running `weave change open --json` with no default gets `open.status: "needs_choice"` and `choices`, and nothing opens.

## In scope

- `src/lib/user-settings.ts`: load, validate, atomic write, precedence, project key from the main checkout, unrecognised values never touched.
- `src/lib/open-places.ts`: `Place`/`AgentEntry` types, registry with `herdr`, `tmux`, `claude`, `shell`, its own argv openers (tmux foreground plus `switch-client`; herdr `tab.new` with a resolved `herdr-app` path), the login-shell tail, and `listChoices`.
- `src/lib/open-change.ts`: `openChange` resolution steps 0, 1, 3, 5, 6 from `architecture/index.md` (inside-folder and bring-forward come in slice 02), `canPrompt`, 2 s/10 s timeouts, clearing on absolute-path `missing` only, `WEAVE_NO_OPEN`, `WEAVE_NO_PROMPT`.
- `weave change open` command: `--in`, `--agent`, `--remember`, `--project`, `--choices`, `--json`; `folder_missing`; the two-step `@clack/prompts` menu when `canPrompt`.
- Next step for `open`: the `weave-next` fallback only (stored steps come in slice 02).
- A global vitest setup that sets `WEAVE_NO_OPEN=1` and a temporary `WEAVE_USER_HOME`.

## Out of scope

- Opening from `change new`/`change switch` (slice 02).
- iTerm, Terminal, apps, and the other agents (slices 03, 04).
- `weave settings open` (slice 05).
- Unsent drafts (slice 07). Every entry here is `draft: none`.
- Skill and doc changes (slice 06).

## Acceptance criteria

- [ ] `weave change open --in tmux --agent claude --remember` inside tmux opens a foreground window in the folder and saves the default.
- [ ] `weave change open --json` with no default and no flags returns `needs_choice` with `choices` (tmux/herdr only when inside them, plus `none`), and opens nothing.
- [ ] At a real TTY with no agent marker, the two-step menu appears. An answer is saved unless it is a plain "don't open".
- [ ] `--in none --remember` saves `{place: none, ask: false}`, and later opens report `not_attempted` (`dont_ask`).
- [ ] A default whose tool is absent from every absolute install location is cleared. A PATH miss, a missing agent, a timeout, or `unavailable_now` never clears it.
- [ ] Unrecognised saved values report `not_attempted` (`unknown_saved_value`) and are never written.
- [ ] `change open` for a change with no folder returns `folder_missing`.
- [ ] No test can open a real window (global `WEAVE_NO_OPEN=1`), and `tests/advance.test.ts` is unchanged and green.
