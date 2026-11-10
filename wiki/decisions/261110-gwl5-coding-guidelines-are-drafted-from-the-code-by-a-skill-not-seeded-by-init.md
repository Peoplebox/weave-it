---
id: 261110-gwl5-coding-guidelines-are-drafted-from-the-code-by-a-skill-not-seeded-by-init
title: Coding guidelines are drafted from the code by a skill, not seeded by init
status: accepted
date: 2026-11-10
owner: arpit016
applies_to:
  - src/lib/review/guidelines.ts
  - src/lib/review/package.ts
  - src/commands/review.ts
  - src/commands/review/guidelines.ts
  - src/lib/init-workspace.ts
  - src/lib/add-folder.ts
  - templates/skills/weave-review/**
  - templates/skills/weave-coding-guidelines/**
supersedes:
  - 261110-dtld-coding-guidelines-live-in-weave-coding-guidelines-md-at-workspace-and-repo-roots
superseded_by: null
---

# Coding guidelines are drafted from the code by a skill, not seeded by init

## Context

Decision `261110-dtld` put coding guidelines in `.weave/coding-guidelines.md`: one shared file at the workspace root and one optional file per registered repository, with the repository file winning. It also had `weave init` seed a generic starter. A generic starter tells reviewers nothing about a particular codebase, and teams rarely rewrote it. Guidelines grounded in the code's own conventions make reviews sharper. Some teams also keep several guideline files, for example one per layer.

## Decision

The file locations and precedence from `261110-dtld` stay as they were. Three things change:

- `weave init` no longer writes a guidelines file. It prints a hint pointing to the `weave-coding-guidelines` skill. `weave add` prints the same hint when the added repository has no file.
- The `weave-coding-guidelines` skill drafts only missing files, found with `weave review guidelines status`. It runs one fresh writer per file. Each rule must be a convention the code already follows, with an example path. Conventions the code splits on go under "Open questions", which reviewers do not apply. The skill never overwrites an existing file.
- A guidelines file may link to more guideline files. Reviewers follow the links that cover their diff and list every file they read. The CLI still lists only the `.weave/coding-guidelines.md` files.

`weave review guidelines init` still writes the generic starter for anyone who wants it.

## Alternatives Rejected

- **Keep seeding the starter and let the skill replace it:** the skill would have to tell an untouched starter from an edited file. "Never overwrite" stays simple only if nothing is written first.
- **A guidelines folder with path patterns that the CLI matches against the diff:** this is more precise, but adds a layout and a format teams must learn. Links followed by the reviewer cover the need with no new structure.
- **The CLI generates guidelines:** inferring conventions needs judgement, which belongs in a skill. The CLI only reports which files exist.

## Consequences

- New projects start with no guidelines until someone runs the skill. Reviews then judge against the plan and decisions alone, as before.
- Drafts are only as good as the writer's reading of the code. The team must read and edit them, and settle the open questions.
- Which linked files a reviewer reads is a judgement call. The "Guidelines read" section of every report makes it visible.

## Reconsider When

Reviewers often miss rules because they skipped linked files, or teams ask for path-scoped guideline files that a tool can select by itself.
