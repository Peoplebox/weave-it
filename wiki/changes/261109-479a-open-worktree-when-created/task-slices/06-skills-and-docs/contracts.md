# Contracts: Guided flows, help, README, and knowledge describe opening

## Interfaces

- **Skills call:**
  - `weave change new "<title>" --skill <s> --context "<gist>" --json`
  - `weave change switch <id> --json`
  - `weave change open <id> [--in <place>] [--agent <a>] [--remember] --json`
  - `weave settings open --in … | --clear [--project] --json`
- **Skills read:** `open.status`, `open.choices`, `open.where`, `open.draft`, `open.detail`, `next_step`, `folder`.

## State

How the skills respond:

| `open.status` | Skill behaviour |
| --- | --- |
| `needs_choice` | Ask in chat with `choices` (what to start only for terminals), then "just this once, or make it your default?". Run `change open`, adding `--remember` only for a default, or `--in none --remember` for "don't ask again". A plain "don't open" runs nothing |
| `opened` / `brought_forward` | Say where it opened. Give the folder and `next_step` as the fallback (say "paste this" when `draft: shown`). Stop editing the change |
| `not_attempted` / `skipped` / `failed` | Give the folder and `next_step` (and `detail`). Do not keep editing the change here |

- **One-off instructions** ("don't open this one", "open this one in X") use `--no-open` or `--in X` without `--remember`.
- **Remembering:** `--remember` is used only when the person chose to make their answer the default.

## Validation and errors

- **Older-CLI fallback:** if the command's stderr or JSON error contains `unknown option`, re-run without `--skill`, `--context`, and `--no-open`, then follow today's "open the folder in a new session" guidance.

## Files and artifacts

- Modified: `templates/skills/weave-new/SKILL.md`, `templates/skills/weave-next/SKILL.md`, `templates/skills/weave-fix/SKILL.md`, the installed copies via `weave agent update --all`, `README.md`, `src/commands/change.ts` and `src/commands/settings.ts` (help text), `wiki/knowledge/domains/change-workflow/domain-wide/change-checkouts.md`, `wiki/knowledge/domains/change-workflow/domain-wide/auto-advance-launch.md`.
