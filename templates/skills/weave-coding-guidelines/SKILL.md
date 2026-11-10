---
name: weave-coding-guidelines
description: Draft the project's coding guidelines from its own code. Finds which `.weave/coding-guidelines.md` files are missing (the shared file and each registered repo's file), then has one fresh writer per missing file study that code and write the conventions it actually follows, with an example path for every rule and open questions where the code disagrees with itself. Never overwrites an existing file. Use when the user wants coding guidelines, review rules, or conventions written down, after `weave init` or `weave add` points here, or with a repo id to draft one repo's file. Not for editing existing guidelines (edit the file directly) or for reviewing code (use weave-review).
license: MIT
compatibility: Requires the weave CLI (npm package @weave-tools/weave-it) on PATH, run inside a git repo or workspace initialised with weave init. Uses the agent's own sub-agent tool to start fresh writers when the agent supports sub-agents.
metadata:
  author: weave-tools
  last_changed_in: "0.1.13"
---

# Weave Coding Guidelines

Reviewers check code against `.weave/coding-guidelines.md`: one shared file at the workspace root, and an optional file at each registered repo's root, where the repo's file wins on conflict. In a single-repo project there is one file. This skill drafts the files that are missing by studying the code itself. The team owns every file afterwards and edits it freely.

Two rules hold throughout:

- **Never overwrite.** A guidelines file that exists, edited or not, is never changed, replaced, or deleted by this skill. To redraft one, the person deletes or renames it first.
- **Only what the code shows.** Every rule describes a convention the code already follows, with an example path. Nothing generic, nothing aspirational.

# Invocation

```text
weave-coding-guidelines              draft every missing file
weave-coding-guidelines <repo-id>    draft only that repo's file
weave-coding-guidelines shared       draft only the shared file (workspace mode)
```

# Find What Is Missing

```bash
weave review guidelines status --json                 # every file
weave review guidelines status --repo <repo-id> --json  # one repo
```

The result lists `files[]`, each with `scope` (`shared` or `repo`), `repo`, `root` (the folder its code lives in, relative to `checkout_root`), `path`, and `status` (`present` or `absent`), plus `missing_repos` (registered repos not checked out here) and `mode`.

- Keep only `absent` files, narrowed to the argument when one was given. For `shared`, keep the `scope: shared` entry.
- When the requested file is `present`, stop: say it exists and is never overwritten, and that the person can edit it, or delete it and run this skill again for a fresh draft.
- When nothing is absent, say every guidelines file already exists and stop.
- Name any `missing_repos` once: their files cannot be drafted until the repo is checked out here.
- `no_weave_context`: say `weave init` comes first. `repo_not_found`: list the registered repo ids from the status result without `--repo`.

Then tell the person in one short message which files you will draft, and start.

# Plan Each Writer

One writer drafts one missing file. Pick its scope:

| Status entry | Writer scope | What it studies |
| --- | --- | --- |
| `shared`, repo mode | `project` | the whole project |
| `shared`, workspace mode | `shared` | every checked-out repo, for conventions that hold across all of them and for how the repos work together |
| `repo` | `repo` | that repo only |

In workspace mode, when a registered repo lives at the workspace root (its path is `.`), the shared file also covers that repo's own code: tell the shared writer so.

For each writer, gather:

- `{TARGET_PATH}`: the absolute path of the file to write (`checkout_root` joined with `path`)
- `{CODE_ROOT}`: the absolute folder to study (`checkout_root` joined with `root`)
- `{SCOPE}`: `project`, `shared`, or `repo`
- `{REPO_ID}`: the repo id, or `-` for `project` and `shared`
- `{OTHER_REPOS}`: for `shared`, each checked-out repo as `<id>: <absolute path>`; otherwise `-`
- `{COMMIT}`: `git -C <code root> rev-parse --short HEAD`, or `uncommitted` when it fails
- `{DATE}`: today, `YYYY-MM-DD`
- `{MODEL_LEVEL}`: see **Model Levels**

# Model Levels

| Writer | Level |
| --- | --- |
| a repo or project with one main language and a few hundred source files or fewer | `mid` |
| a larger repo or project, several languages, or the `shared` writer across three or more repos | `most_capable` |

Built-in model per level, by the agent you are running in:

| Agent | `mid` | `most_capable` |
| --- | --- | --- |
| `claude` | `sonnet` | `opus` |
| `codex` | the client's standard coding model | the strongest model the client offers |
| `cursor` | the client's standard coding model | the strongest model the client offers |
| `opencode` | the provider's standard coding model | the strongest model the provider offers |

When the client's sub-agent tool cannot choose a model, the writer runs on the session model; say so in the final response.

# Run the Writers

The brief sits beside this file: `guidelines-writer-brief.md`. Read it fresh for each writer and replace every placeholder with the values above.

- Start one fresh sub-agent per file, with the filled brief as its only input. Never fork this conversation into it, and add nothing else: the writer judges the code, not what was said here.
- Start all writers at once, in the foreground, and wait for every one to finish. They write different files, so they never conflict.
- When your agent cannot start sub-agents, follow the filled brief yourself, one file at a time, and say in the final response that the drafts were written without a fresh writer.

# Check Each Draft

When a writer finishes, check the files it reports writing. These checks only touch files this run created.

1. The file exists at `{TARGET_PATH}` and starts with the title and the drafted-from line the brief asks for.
2. Each rule has an example path. Spot-check about five of them, and every one when the file has ten rules or fewer: the path exists under the code root. Remove a rule whose example does not exist; do not invent a replacement.
3. Every link in the file points to a file that exists, relative to the file that holds the link.
4. Nothing in it is generic advice that would fit any project ("write clean code", "handle errors properly") or something a formatter or linter in the repo already enforces. Remove such lines.
5. No file exceeds about 40 rules.

Fix small problems in place. When a draft fails badly (no examples, mostly generic), delete only the files this run created for it and start a fresh writer once more. If the second draft also fails, keep it, and tell the person which checks it failed.

If a writer reports that its target already existed when it was about to write, leave that file alone and report it.

# Final Response

Reply with this shape and nothing else:

```text
Coding guidelines drafted.

- <path>: <N> rules, <M> open questions<, plus topic files: <paths>>
- <path>: not drafted (<reason>)

Next: read each draft and edit it. Settle the "Open questions" sections, since reviewers do not apply them. Then commit each file in its own repo.
```

Add one line when the writers ran on the session model or without a fresh writer.

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
