---
name: weave-new
description: Start a new Weave change for a feature, fix, refactor, or other piece of work. Creates the change folder under wiki/changes with its status.yml and the matching change/<id> git branch, then recommends the first skill to run. Use when the user wants to begin new work, open or create a change, or says things like "start a change for X". Not for saving an ongoing discussion (use weave-capture) or reporting a bug that needs diagnosis (use weave-fix).
license: MIT
compatibility: Requires the weave CLI (npm package @weave-tools/weave-it) on PATH, run inside a git repo or workspace initialised with weave init.
metadata:
  author: weave-tools
  last_changed_in: "0.1.0"
---

# Purpose

Start a new Weave change exploration.

Use this when the user is starting from a title or topic, not when they are already deep in a discussion. For an existing discussion, prefer `weave-capture`.

# Workflow

1. Run:

```bash
weave workspace --json
weave change current
```

2. Identify the current workspace or repo context from `weave workspace --json`. In workspace mode, the workspace root owns the change store even if implementation later touches registered sub-repos.

3. Run:

```bash
weave change new "<title>"
```

Use `--type <type>` when the work is not a new capability. Supported values are `feat`, `fix`, `refactor`, `docs`, `test`, `ci`, and `chore`.

Use `--slug <slug>` only when the user requested a specific folder or branch slug.

4. Report the change id, resolved workspace/repo context, branch status, and that the new change is now current.

# Behavior Rules

- The CLI owns change id generation, folder creation, status metadata, and git branch creation.
- The created branch is `change/{change-id}`.
- Do not create `prd.md`.
- For `feat` changes, the CLI scaffolds `exploration.md` and starts at `stage: exploration`; treat `exploration.md` as the first artifact.
- For non-feature changes (`fix`, `refactor`, `docs`, `test`, `ci`, `chore`), the CLI does not scaffold `exploration.md` and starts at `stage: started`. The first real artifact is created later by the fitting skill: `weave-architect` for diagnosis or RCA, `weave-issues` when the work is already clear, or `weave-prd`/`weave-explore` only when expected behavior is unclear.
- After creating a `feat` change that touches existing behaviour, suggest `weave-questions` then `weave-research` (in a fresh session) to build a current-state baseline, followed by `weave-explore` to brainstorm product directions. For greenfield work with no existing code to understand, suggest `weave-explore` directly. Do not do any research or product discovery yourself using this skill. After creating a non-feature change, recommend the fitting next skill instead of `weave-explore`.

---

# Silent Weave Command Output

Weave skills run Weave CLI commands silently by default. Use command results
as internal context, not response content.

Do not show raw stdout, JSON payloads, command echoes, lifecycle payloads,
internal state-write confirmations, or verbatim notice text unless the user
explicitly asks for diagnostic output.

Surface only information that changes what the user or agent should do next:
blockers, failures, missing relevant repos, branch or task outcomes,
lifecycle failures, package-outdated notices, relevant outdated or modified
skills, and user-required actions.

Notice handling:

- `package_outdated`: show only when present. Say exactly:
  `A newer Weave version is available. Run \`weave status\` for details, then upgrade Weave when convenient.`
- `skills_outdated`: suppress unrelated skills. If the invoked skill is outdated, say:
  `The installed \`<skill-name>\` skill appears older than the bundled template. Run \`weave status\` for details, then \`weave agent update --all\` when you want to refresh installed skills.`
- `skills_outdated`: if multiple skills used in this workflow are outdated, say:
  `Some installed skills used in this workflow appear older than the bundled templates: \`<skill-a>\`, \`<skill-b>\`. Run \`weave status\` for details, then \`weave agent update --all\` when you want to refresh them.`
- `skills_modified`: suppress unless the invoked skill is modified locally or the user is asking about skill updates. If the invoked skill is modified, say:
  `The installed \`<skill-name>\` skill has local edits, so its behavior may differ from the bundled template. Run \`weave status\` or \`weave agent diff\` if you want to inspect the difference.`
- `skills_modified`: if the user asks to update skills and installed skills have local edits, say:
  `Some installed skills have local edits. \`weave agent update\` may skip or protect them; run \`weave status\` or \`weave agent diff\` before updating.`

Do not say `Notices: ...`, `The command returned notices`, raw
`notices[].message`, full notice JSON, or full skill lists unless the user
asks for diagnostics.
