# Guided flows, help, README, and knowledge describe opening

## Outcome

`weave-new`, `weave-next`, and `weave-fix` use the new contract:
- they pass the first step
- they ask in chat on `needs_choice`
- they handle one-off and reopen requests
- they keep the fix flow closed (`--no-open`)
- they fall back cleanly on an older CLI

The README, command help, and knowledge wiki describe the menu, the default, `weave settings open`, the per-change override, the environment switches, and that opening is independent of auto-advance.

## User flow

1. In Claude, the person says "start a change for CSV export of reports; I want to brainstorm first".
2. `weave-new` picks `weave-explore` and runs `weave change new "CSV export of reports" --skill weave-explore --context "brainstorm CSV export for reports" --json`.
3. On `needs_choice`, it asks in chat with the choices. The person answers "herdr, Claude". The agent runs `weave change open <id> --in herdr --agent claude --remember --json`, reports where it opened with the fallback, and stops editing the change.
4. Later, "open it in Cursor instead" leads `weave-next` to run `weave change open <id> --in cursor --json` without `--remember`.
5. A teammate on an older global `weave` gets an unknown-option error. The skill re-runs without the new flags and gives today's guidance.

## In scope

- `templates/skills/weave-new/SKILL.md`: choose the first skill (ask if the intent is unclear), pass `--skill`/`--context`, handle each `open.status`, ask in chat on `needs_choice`, `--remember` only for menu answers, stop editing after opening, and the older-CLI fallback.
- `templates/skills/weave-next/SKILL.md`: switch and reopen through `change switch` and `change open`, the same `needs_choice` handling, settings changes from chat through `weave settings open`, and the older-CLI fallback.
- `templates/skills/weave-fix/SKILL.md`: `--no-open` on `change new`, plus the older-CLI fallback.
- Refreshing the installed copies (`.claude/skills`, `.agents/skills`, opencode commands) with `weave agent update --all`.
- `README.md` worktree section and a new "Where changes open" section; `weave change`/`weave settings` help text.
- `wiki/knowledge/domains/change-workflow/domain-wide/change-checkouts.md`, plus a note in `auto-advance-launch.md` that the two are independent.

## Out of scope

- The `weave-knowledge` change-delta write-up (done by `weave-knowledge` after implementation).

## Acceptance criteria

- [ ] No bundled skill still tells every person to open the folder themselves, except as the documented fallback.
- [ ] `weave-new` passes `--skill`/`--context` and handles `needs_choice` by asking in chat and running `change open --remember`.
- [ ] `weave-fix` passes `--no-open`, and its behaviour is otherwise unchanged.
- [ ] Skills fall back when the new flags are rejected as unknown.
- [ ] The skill drift and content checks pass, and the installed copies match the templates.
- [ ] The README and knowledge pages describe the default, `settings open`, the one-off override, `WEAVE_NO_OPEN`/`WEAVE_NO_PROMPT`, and that opening is independent of `advance.*`.
