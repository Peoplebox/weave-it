---
artifact: tasks
slice: 06-skills-and-docs
status: draft
owner: engineering
created_at: 2026-11-09T16:30:00.000Z
updated_at: 2026-11-09T16:30:00.000Z
source: architecture
---

# Tasks: Guided flows, help, README, and knowledge describe opening

## Status Legend

- `todo`: ready when blockers are done
- `in_progress`: currently being implemented
- `blocked`: cannot proceed without listed blocker
- `done`: implemented and verified
- `not_tested`: implementation complete, automated verification incomplete
- `invalid`: no longer applies

## Active Task Index

| ID | Status | Execution | Repos | Owner | Title | Blocked by |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | done | afk | root | | Update weave-new to pick the first step, ask in chat, and open | None |
| T2 | done | afk | root | | Update weave-next for switching, reopening, and settings from chat | None |
| T3 | done | afk | root | | Keep weave-fix closed with --no-open and add the older-CLI fallback | None |
| T4 | done | afk | root | | Document opening in the README, help, and knowledge wiki | None |
| T5 | done | afk | root | | Verify skill drift and content checks, and refresh the installed copies | T1, T2, T3 |

## root

### T1: Update weave-new to pick the first step, ask in chat, and open

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `templates/skills/weave-new/SKILL.md` (M)

### What to build

Replace "tell the user to open that folder in a new session" (line 41) with the contract in `contracts.md`:

**Before creating:**
- Choose the first skill from the conversation, using today's rules at line 52: `weave-questions` for existing behaviour, `weave-explore` for an idea or a brainstorm, and the matching rules for non-feat types. Ask one short question if the intent is unclear.
- Run `change new` with `--skill`, `--context` (a one-line gist), and `--json`.

**After creating:**
- Handle each `open.status` per the table in `contracts.md`, including the two-step question in chat.
- Use `--remember` only for menu answers.
- Use the older-CLI fallback when the flags are rejected.

Keep the in-place branch unchanged. Follow the existing skill-versioning rules: `scripts/bump-skill-versions.mjs` runs at release, so don't hand-edit versions unless the file requires it.

### Acceptance Criteria

- [x] The skill names both first-step options and when each applies.
- [x] `needs_choice` handling and `--remember` rules are explicit.
- [x] The fallback is present.

### Verification

- Covered by T5
- Result (2026-11-09): weave-new picks weave-questions or weave-explore (asking if the intent is unclear), passes --skill and --context with --json, handles each open.status with a table, asks in chat on needs_choice, uses --remember only for menu answers, and has the older-CLI fallback.
- Result (2026-11-09): (2026-11-10) After the user's Cursor test: weave-new now never asks what to start for an app and passes no --agent with one. It then asks 'Just this once, or make it your default?' (user decision) and adds --remember only for the default. README, knowledge, and weave-next updated to match. Installed copies refreshed.

### T2: Update weave-next for switching, reopening, and settings from chat

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `templates/skills/weave-next/SKILL.md` (M)

### What to build

Replace "open the one you want in a new session" (line 56) with:
- `weave change switch <id> --json`, handling `open.status` the same way as `weave-new`
- reopen requests through `weave change open <id> [--in …] --json`
- default changes through `weave settings open … --json`
- the older-CLI fallback

### Acceptance Criteria

- [x] Reopen, open elsewhere, and change default are covered, and none of them uses `--remember` for one-off requests.

### Verification

- Covered by T5
- Result (2026-11-09): weave-next: the no-change message points to weave change switch, plus a rule covering switch/open/settings from chat and the older-CLI fallback.

### T3: Keep weave-fix closed with --no-open and add the older-CLI fallback

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `templates/skills/weave-fix/SKILL.md` (M)

### What to build

- Add `--no-open` to its `weave change new … --json` call.
- If the flag is rejected as unknown, re-run without it.
- Keep today's behaviour of writing the files under `folder` and then telling the person to open the folder.

### Acceptance Criteria

- [x] `weave-fix` never triggers opening, and its other text is unchanged.

### Verification

- Covered by T5
- Result (2026-11-09): weave-fix passes --no-open, with a retry without it on an older CLI; the rest is unchanged.

### T4: Document opening in the README, help, and knowledge wiki

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `README.md` (M)
- `src/commands/change.ts` (M: option descriptions)
- `src/commands/settings.ts` (M: description)
- `wiki/knowledge/domains/change-workflow/domain-wide/change-checkouts.md` (M)
- `wiki/knowledge/domains/change-workflow/domain-wide/auto-advance-launch.md` (M)

### What to build

**README:**
- Update the worktree section (line 486).
- Add a "Where changes open" section covering:
  - the menu and the default
  - the fixed list of places
  - `weave settings open`
  - `--open`/`--no-open`
  - `weave change open`
  - `WEAVE_NO_OPEN`/`WEAVE_NO_PROMPT`
  - SSH and Linux behaviour
  - independence from `advance.*`

**Help:** clear option descriptions on `change new`, `change switch`, `change open`, and `settings open`.

**Knowledge:**
- `change-checkouts.md`: describe opening, and point to decision `261109-mn61` instead of `261107-ohne`'s old consequence.
- `auto-advance-launch.md`: add an independence note citing `261109-bv3c`.
- Also fix that page's broken `261108-hndf` link, found in research.

### Acceptance Criteria

- [x] The README and knowledge describe the behaviour from the PRD's Notifications section.
- [x] No doc still says every person must open the folder themselves.

### Verification

- Manual: `grep -rn "in a new session" README.md wiki/knowledge templates/skills` shows only the documented fallbacks.
- Result (2026-11-09): README: new options and a 'Where changes open' section. change-checkouts.md has an Opening bullet, updated integrations, and the mn61 decision link. auto-advance-launch.md has an independence note, and its broken 261108-hndf link is fixed. The grep shows only documented fallbacks.

### T5: Verify skill drift and content checks, and refresh the installed copies

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1, T2, T3
Files:
- `.claude/skills/weave-new/SKILL.md`, `.claude/skills/weave-next/SKILL.md`, `.claude/skills/weave-fix/SKILL.md` (M via update)
- `.agents/skills/…` (M via update)

### What to build

1. Run `npm run build && node dist/cli.js agent update --all` to refresh the installed copies.
2. Run the skill tests.
3. Check that nothing outside the three skills changed in `templates/skills`.

### Acceptance Criteria

- [x] The skill tests and drift checks pass.
- [x] The installed copies match the templates.

### Verification

- Automated tests: `npx vitest run tests/agent-skills.test.ts tests/bump-skill-versions.test.ts` and `npm test`
- Result (2026-11-09): npm run build && node dist/cli.js agent update all refreshed .claude/.agents copies (they match the templates; .weave/agents.yml hashes and timestamps updated). tests/agent-skills and bump-skill-versions: 58 passed. npm test: 499 passed. typecheck green.

## QA Findings

| ID | Status | Severity | Source | Related Task | Summary |
| --- | --- | --- | --- | --- | --- |

None.

## Refactors

| ID | Status | Scope | Related Tasks | Summary |
| --- | --- | --- | --- | --- |

None.

## Verification

Not run yet.
