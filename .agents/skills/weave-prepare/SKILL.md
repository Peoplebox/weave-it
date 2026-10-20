---
name: weave-prepare
description: Prepare the git branches that selected tasks or slices of the active Weave change need, across every repo involved, without implementing, verifying, committing, pushing, or opening PRs. Use when the user wants to set up branches, get repos ready for execution, or check preparation before weave-execute.
license: MIT
compatibility: Requires the weave CLI (npm package @weave-tools/weave-it) on PATH, run inside a git repo or workspace initialised with weave init.
metadata:
  author: weave-tools
  last_changed_in: "0.1.8"
---

> **Deprecated:** Branch preparation is now part of `/weave-execute`. Use `/weave-execute` for combined branch checkout and task implementation.

# Weave Prepare

Use this skill when the user wants to prepare local branches for an active Weave change.

Prepare means branch readiness only. It does not implement code, run verification, change task statuses, commit, push, open PRs, stash, discard changes, or create remote branches.

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

# Resolve Context

Start with Tier 1 context commands:

```bash
weave workspace --json
weave change current --json
weave change status --json
```

If there is no active change, stop and say that the user needs `weave change new` or `weave change switch` first.

# Prepare Handling

The CLI owns all branch movement and `status.yml` writes. Do not hand-edit `status.yml` and do not run git checkout commands yourself for this workflow.

Ignore task, scope, or slice selectors for branch preparation. Prepare applies to the active repo in repo mode, or to every registered repo in workspace mode. If the user provides a selector, explain that slice/task selection belongs to `/weave-execute`; `/weave-prepare` only checks branch readiness.

# Run Prepare

Run exactly one prepare command:

```bash
weave task prepare --json
```

If the global `weave` command is unavailable in this repo, use the local development form:

```bash
npm run dev -- task prepare --json
```

# Summarize Results

Summarize the JSON result in user terms:

- Change id and branch.
- Prepared repos and branch actions: `created`, `checked_out`, `already_active`.
- Skipped non-git repos with `skipped_not_git`.
- Blockers, if any, with the repo target and reason.

If status is `blocked`, state that no implementation repo branches were moved by the prepare command. Remind the user that dirty work on the expected branch is allowed, but dirty work on another branch must be resolved by the user.

Always close by stating that prepare did not implement, verify, commit, push, open a PR, stash, discard changes, or update task statuses.
