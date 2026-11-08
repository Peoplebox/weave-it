# Agent guidance for change cleanup

## Outcome

Weave's skills tell agents to use `weave change list --fetch --json`, matching on `state.id`, before closing a change or reporting that nothing needs cleanup.

## User flow

1. An agent running `weave-next` or a close-out step runs `weave change list --fetch --json`.
2. It acts only on `state.id` values, and offers `close` only for `landed` or `folder_missing`.

## In scope

- `templates/skills/weave-next/SKILL.md`, and any other bundled skill that lists or closes changes.
- Each skill must keep working in in-place mode, where the new fields are absent.

## Out of scope

- The knowledge wiki pages, which are updated by `weave-knowledge` after implementation.
- Release notes, which are written at release.

## Acceptance criteria

- [ ] PRD Acceptance Criterion "Weave's own skills use `weave change list --fetch --json` before closing a change or reporting that nothing needs cleanup" holds.
- [ ] The skill drift and agent-skill tests still pass.
