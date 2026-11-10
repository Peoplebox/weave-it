---
id: 261110-dtld-coding-guidelines-live-in-weave-coding-guidelines-md-at-workspace-and-repo-roots
title: Coding guidelines live in .weave/coding-guidelines.md at workspace and repo roots
status: accepted
date: 2026-11-10
owner: arpit016
change: 261110-g2wn-code-reviewers
applies_to:
  - src/lib/review/guidelines.ts
  - src/lib/review/package.ts
  - src/commands/review.ts
  - src/lib/init-workspace.ts
  - templates/skills/weave-review/**
supersedes: []
superseded_by: null
---

# Coding guidelines live in .weave/coding-guidelines.md at workspace and repo roots

## Context

Reviews check code against coding guidelines. Changes can span repositories with different languages and stacks. Some rules apply everywhere, and teams own their rules. Weave has had no guidelines file before, and `.weave/` already holds team-owned advisory files such as `architecture-considerations.md`.

## Decision

Shared guidelines live in `<workspace root>/.weave/coding-guidelines.md`. Each registered repository may have `<repo root>/.weave/coding-guidelines.md`. Both apply, and the repository file wins on conflict. The reviewer applies that precedence by judgement, guided by its brief. The CLI only resolves which files apply and never merges rules. Files missing from the checkout are recorded as `absent` in the package. A repository that is not checked out locally makes the review partial. In a single-repository project the two paths are the same file. Weave reads no other convention files (such as `AGENTS.md` or `CONTRIBUTING.md`). Reviews read the files from the change's own checkout folder. `weave init` seeds a starter shared file when it is absent. Existing projects opt in with `weave review guidelines init`. Upgrades never write or overwrite it.

## Alternatives Rejected

- **Discover existing convention files:** unpredictable, and teams cannot tell which rules applied.
- **Built-in Weave guidelines plus a team file:** rules shift between releases, and teams cannot remove one.
- **Repository file replaces shared:** one local line silently drops all shared rules.

## Consequences

- Teams can see and edit every rule a reviewer applies.
- A change can edit guidelines and be reviewed against its own edits.
- Teams with existing convention docs must copy or link them into the file.

## Reconsider When

Teams consistently keep guidelines elsewhere and copying them becomes a burden, or a convention-file standard emerges across agent clients.
