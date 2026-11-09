---
artifact: questions
status: draft
owner: engineering
created_at: 2026-11-09T09:10:00.000Z
updated_at: 2026-11-09T09:10:00.000Z
source: discussion
---

# Research Questions: Open worktree when created

1. In `src/commands/change.ts` (the `new` subcommand) and `src/lib/changes.ts` / `src/lib/worktrees.ts`, how does `weave change new` work end to end today? Cover in-place vs worktree checkout modes (`workspaceCheckoutMode`), where the change folder and worktree paths are decided, and what the command prints in human and `--json` output once it finishes, including any path or next-step text.
2. How does the `weave-new` skill (`templates/skills/weave-new/SKILL.md`) use the result of `weave change new`, and what does it tell the user and the calling agent about where to go next? Do other skills or the README describe moving into the new change folder?
3. How does `src/lib/terminal-launch.ts` detect and open terminals today (herdr via `HC_TERMINAL_ID` and `herdr-app do tab.new`, tmux, iTerm, Terminal.app)? What is the `TerminalOpener` contract, what order are openers tried in, what happens when none apply, and which commands use it?
4. How does `src/lib/agent-launchers.ts` build launch plans (`AgentLauncher`, `claudeLauncher`, `commandTemplateLauncher`, the `custom` agent, `defaultLaunchAgent`)? Which agents have a launcher today, how are working directory, prompt, and permissions passed, and how does `advance.launch` (`terminal`, `background`, `handoff`) choose between them in `src/lib/advance.ts`?
5. Where does Weave know which coding agents a project uses? Trace `AgentName` (`codex`, `cursor`, `claude`, `opencode`) in `src/lib/agent-skills.ts` and `src/commands/agent.ts`, and any config in `.weave` or local state (`src/lib/local-state.ts`, `src/lib/session-state.ts`) that records a preferred agent, terminal, or launch setting.
6. For each of herdr, Cursor, Claude Code, Codex CLI, and opencode, what command-line or programmatic interface exists today to open a directory or start a session in a given working directory (for example a `cursor` CLI, `claude`/`codex`/`opencode` CLI flags for cwd and initial prompt, `herdr-app do` actions)? How can a running process tell it is inside each one (environment variables or similar)?
7. How are terminal and agent launching tested today (`tests/` for `terminal-launch`, `agent-launchers`, `advance`, and `change new`)? How do the tests avoid spawning real terminals or agents?
8. Which recorded decisions and knowledge pages govern this area, and what do they say? Start with `wiki/decisions/261107-ohne-each-change-gets-its-own-worktree-folder.md`, `wiki/decisions/261108-4z8l-auto-advance-hands-phases-to-the-calling-agent.md`, any decisions returned by `weave adr list --path` for the files above, and `wiki/knowledge/domains/change-workflow/domain-wide/auto-advance-launch.md`.

## Key Context Pointers

- Tools named by the user: herdr, cursor, claude, codex, opencode
- Paths: `src/commands/change.ts`, `src/lib/changes.ts`, `src/lib/worktrees.ts`, `src/lib/terminal-launch.ts`, `src/lib/agent-launchers.ts`, `src/lib/advance.ts`, `src/lib/agent-skills.ts`, `src/commands/agent.ts`, `templates/skills/weave-new/SKILL.md`, `templates/opencode/commands`
- Decisions: `261107-ohne-each-change-gets-its-own-worktree-folder`, `261108-4z8l-auto-advance-hands-phases-to-the-calling-agent`, `261108-4ko1-remote-state-refreshes-in-the-background-into-weave-only-refs`
- Knowledge: `wiki/knowledge/domains/change-workflow/domain-wide/auto-advance-launch.md`
