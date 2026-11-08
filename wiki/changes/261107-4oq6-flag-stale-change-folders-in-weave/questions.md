---
artifact: questions
status: draft
owner: engineering
created_at: 2026-11-07T11:40:00.000Z
updated_at: 2026-11-07T11:40:00.000Z
source: discussion
---

# Research Questions: Flag stale change folders in weave status

1. How does `weave status` work end to end today, from `src/commands/status.ts` through `buildStatus` in `src/lib/status.ts` to the rendered text and `--json` output? What does it inspect (skills, npm version, notices), what does it assume about the current directory (main checkout vs. a change folder, repo vs. workspace mode), and how is it tested in `tests/cli-status.test.ts`?

2. How are change folders laid out and created in worktree checkout mode? Starting from `changeFolderPath` and `ensureChangeWorktrees` in `src/lib/worktrees.ts`, where does a change folder live relative to the main checkout (for example `weave-it.changes/<change-id>/`), what does it contain for the workspace root and each registered repo, and what is recorded in the change's `status.yml` `checkout` block and in machine-local state under `.git/weave/` (slots, setup approvals, setup logs)?

3. What is the full lifecycle of a change folder today: creation by `weave change new`, reopening by `weave change switch`, and removal by `weave change close` (`closeChange` in `src/lib/changes.ts`, `removeChangeWorktrees` in `src/lib/worktrees.ts`)? What preconditions does close check (uncommitted work, branches kept), and what happens to slots and `.git/weave/` entries when a folder is removed, or when a folder is deleted by hand outside Weave?

4. How does `weave change list` (`listChanges` in `src/lib/changes.ts`) find and describe change folders? Which sources does it combine (change folders on disk, `git worktree list`, `wiki/changes/*/status.yml`, local and remote `change/<id>` branches), and what per-change fields does it report (stage, branch, folder path, slot, dirty state, or others)?

5. What git facts does the codebase already know how to read about a change branch or worktree, through `src/lib/git.ts` and its callers? For example: whether a branch exists locally or on origin, whether it has been merged into the default branch, ahead/behind counts, last commit time, uncommitted changes, and prunable or missing worktrees. Which of these run network operations such as fetch?

6. What does "stale" already mean in Weave? Document the artifact staleness model (`stale`, `stale_history`, `weave change progress --invalidate`, `weave change clear-stale`, the handling around `src/lib/changes.ts:814-838`) and any other place that uses "stale", "outdated", or similar wording, so the existing vocabulary and its user-facing text are clear.

7. How do notices and health checks work today? Cover `gatherNotices` in `src/lib/notices.ts` (notice kinds such as `package_outdated`, `skills_outdated`, `skills_modified`, and how they attach to command output through `src/lib/with-notices.ts`) and `weave doctor` in `src/lib/doctor.ts` (check structure, statuses, and `--fix`). Which commands surface which notices, and how are both tested (`tests/notices.test.ts`, `tests/cli-tier1-notices.test.ts`, `tests/cli-doctor.test.ts`)?

8. What do the knowledge wiki and recorded decisions say about change folders and status today? Read ADR `261107-ohne-each-change-gets-its-own-worktree-folder`, the `core-command-reference` and `weave-doctor` features under `wiki/knowledge/domains/cli-commands/`, and the change-workflow domain docs, and note any rules about what Weave may detect, report, or remove on its own.

## Key Context Pointers

- Repositories: weave-it (repo mode, `checkout: worktree` in `.weave/workspace.yml`)
- Paths: `src/commands/status.ts`, `src/lib/status.ts`, `src/lib/worktrees.ts`, `src/lib/changes.ts`, `src/lib/git.ts`, `src/lib/notices.ts`, `src/lib/doctor.ts`, `.git/weave/`, `wiki/decisions/261107-ohne-each-change-gets-its-own-worktree-folder.md`
- Commits: `bc97354` "Give each change its own folder of git worktrees", `0a2d3e8` "Use worktree checkouts for weave-it itself"
- Domain terms: change folder, worktree, slot, `weave status`, `weave change list`, `weave change close`, `weave change switch`, stale
