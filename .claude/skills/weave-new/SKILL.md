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

3. Choose the change's first step before creating it, because a change with a saved default opens straight away with that step filled in. Use the rules under **Behavior Rules**: for a `feat` change, `weave-questions` when it touches existing behaviour and the code should be understood first, `weave-explore` when the user is starting from an idea or a rough description or wants to brainstorm; for other types, the fitting skill. If the conversation doesn't make the intent clear, ask one short question, for example: "Should we first understand the existing code, or brainstorm from the idea?"

   Then run:

```bash
weave change new "<title>" --skill <first-skill> --context "<one-line gist of what the user wants>" --json
```

   `--context` is one plain line in the user's words (no secrets); Weave adds it to the step the new session starts with.

   If the command fails because `--skill` or `--context` is an unknown option, the installed `weave` CLI is older than this skill: run `weave change new "<title>" --json` without them and follow the "Older CLI" note in step 4.

Use `--type <type>` when the work is not a new capability. Supported values are `feat`, `fix`, `refactor`, `docs`, `test`, `ci`, and `chore`.

Use `--slug <slug>` only when the user requested a specific folder or branch slug.

Use `--repo <id>` (repeatable) only when the user says the change touches just some registered repos. Use `--base <ref>` only when the user asks to start from a specific branch. When only some repos should start there, pass it per repo, for example `--base api=feature/x` (`root` is the workspace root); other repos then start from their default branch.

4. Report the change id and branch. What comes next depends on the result's `checkout`:
   - `in-place`: the current checkout switched to the change branch, and the new change is current here. Recommend the first step.
   - `worktree`: the change has its own folder (`folder` in the result), with a worktree per repo on the change branch. The user's current checkout did not move. Weave may have opened the folder for them; act on `open.status`:

| `open.status` | What to do |
| --- | --- |
| `opened` | Say where it opened (`open.where`) and that work continues there. Give the folder and `next_step` as a fallback in case the new session didn't start; when `open.draft` is `shown`, say the step must be pasted there. |
| `brought_forward` | Say the existing window was brought forward and give `next_step`. |
| `needs_choice` | Nothing is saved yet. Ask where changes should open; see **Asking where changes open** below. |
| `skipped`, `failed` | Say what went wrong in one line (`open.detail`) and give the folder and `next_step` to run there. |
| `not_attempted` | Give the folder and `next_step`, as before opening existed. |

   **Asking where changes open** (only on `needs_choice`):

   1. If `open.detail` is set (for example the old default was uninstalled), say it first.
   2. Ask where changes should open, listing each entry of `open.choices` by its `label` (add its `hint` in brackets when present), including "Don't open".
   3. Only if the chosen entry has `kind: "terminal"`, ask what to start in it, listing that entry's `agents` by `label`. An entry with `kind: "app"` (VS Code, Cursor, the Claude desktop app, T3 Code) brings its own agent or editor: never ask this question for it, and never pass `--agent` with it.
   4. Ask "Just this once, or make it your default?" (for "Don't open": "Just this once, or don't ask again?"). You may fold this into the earlier question when the user already said it, for example "always open in Cursor".
   5. Open with the answer. Add `--remember` only when they chose to make it their default:
      - a terminal: `weave change open <id> --in <place> --agent <agent id> [--remember] --json`
      - an app: `weave change open <id> --in <place> [--remember] --json`
      - "don't open, don't ask again": `weave change open <id> --in none --remember --json`
      - "don't open" just this once: run nothing; they will be asked next time.
   6. Report the result's `open` with the table above. When it was just this once, mention they will be asked again next time, and that `weave settings open` sets a default.

   In every `worktree` case, do not keep working on the change from this session, because this session's files are not the change's files. This session can still reopen it on request: "open it again" is `weave change open <id> --json`, and "open it in Cursor instead" is `weave change open <id> --in cursor --json`.

   One-off instructions never change the default: for "don't open this one" pass `--no-open` to `weave change new`; for "open this one in X" pass `--open <place>[:<agent>]`. Use `--remember` only when the user chose to make their answer the default, never for one-off instructions.

   Older CLI: if `open` is missing from the result, tell the user to open the folder in a new session and run `next_step` (or the recommended first skill) there.

If the command fails with `worktree_blocked` or `stacked_change`, nothing was created. Show the user the reasons it gives and stop.

# Behavior Rules

- The CLI owns change id generation, folder creation, worktrees, status metadata, and git branch creation. Never run `git worktree` or `git checkout` yourself for this.
- The created branch is `change/{change-id}`.
- Do not create `prd.md`.
- For `feat` changes, the CLI scaffolds `exploration.md` and starts at `stage: exploration`; treat `exploration.md` as the first artifact.
- For non-feature changes (`fix`, `refactor`, `docs`, `test`, `ci`, `chore`), the CLI does not scaffold `exploration.md` and starts at `stage: started`. The first real artifact is created later by the fitting skill: `weave-questions` then `weave-research` when the affected code needs to be understood first, `weave-architect` for diagnosis or technical design, `weave-slices` when the work is already clear, or `weave-explore`/`weave-prd` only when expected behavior is unclear. For bug reports, `weave-fix` is usually the better entry point than `weave-new`.
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

Checkpoint commits (`checkpoint` or `checkpoints[]` in a result): say when one
failed, or was skipped for `wrong_branch`, `detached_head`, or
`operation_in_progress`, with its `reason` and `detail` (the step was still
recorded; never retry or block on it). List a build or fix commit's files. On
`notice: commits_enabled`, say once that Weave now commits each recorded stage
and finished slice, and `weave settings commits off` turns it off for you.

Do not say `Notices: ...`, `The command returned notices`, raw
`notices[].message`, full notice JSON, or full skill lists unless the user
asks for diagnostics.
