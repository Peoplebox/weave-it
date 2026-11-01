---
name: weave-fix
description: Bug-fix entry point for Weave. From a chat description of the bug, creates a fix-type change, writes findings.md with the observed and expected behaviour and what is known about the cause, and scaffolds a single task slice. Use when the user reports a bug, regression, or broken behaviour and wants to fix it through Weave. Not for new features (use weave-new).
license: MIT
compatibility: Requires the weave CLI (npm package @weave-tools/weave-it) on PATH, run inside a git repo or workspace initialised with weave init.
metadata:
  author: weave-tools
  last_changed_in: "0.1.11"
---

# Weave Fix

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

Use this skill when the user describes a bug to fix. It creates a `--type fix` change, writes `findings.md`, scaffolds `task-slices/01-<slug>/`, and runs rollup.

## Single-Turn Flow

1. Derive slug from the bug description; confirm with the user if ambiguous.
2. Check the current branch before creating a change: run `weave change current --json` (the active change is derived from a `change/<change-id>` branch). If the current branch already follows the `change/<change-id>` structure (an existing change), do not create a new change — continue on that change and write/update `findings.md` (re-invocation; see "Re-Invocation" below). Otherwise create the change with `weave change new "<title>" --type fix [--slug <slug>]`. In workspace mode the change is created at and owned by the workspace root even when this is invoked from a registered sub-repo.
3. Check recorded decisions (ADRs) for the code the bug touches: `weave adr list --path <file> --json`, then read the accepted ones. A fix that looks obvious can undo something deliberate, so what looks like a bug may be a recorded trade-off.
4. Write `findings.md` from `templates/skills/weave-fix/findings-template.md` (Summary required; Repro, Scope, Root cause when inferrable). Name any decisions that apply. If the fix would conflict with an accepted decision, say so in `findings.md` and in your report, and tell the user a replacement has to be agreed with `weave adr new "<title>" --supersedes <id>` before the fix goes ahead.
5. Scaffold `task-slices/01-<slug>/` with `tasks.md` and `status.yml` from slice templates. Skip `slice.md` and `contracts.md` for trivial single-slice fixes.
6. Run `weave slice rollup --all --json` (or call the rollup library equivalent).
7. Run `weave change progress findings --source discussion --json`.
8. Report change path, scaffolded tasks, decisions that apply, and next step (`/weave-execute 01 T1` or `/weave-next afk`).

## Re-Invocation

When invoked again on an existing fix change, update `findings.md` with new context. Do not re-scaffold unless the slice folder is missing.

## Scope Growth

When scope grows beyond a single slice, tell the user to run `/weave-slices` for idempotent additive expansion.

## Templates

- `templates/skills/weave-fix/findings-template.md`
- `templates/skills/weave-slices/tasks-template.md`
- `templates/skills/weave-slices/status-template.yml`

## Lifecycle

- `findings.md` is always created for fix-type changes, even trivial ones.
- Progress the findings lane after writing `findings.md`.
- Do not commit, push, or open PRs.
