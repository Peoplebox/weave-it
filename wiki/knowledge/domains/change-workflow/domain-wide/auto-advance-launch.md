# Auto-Advance Launch

## Purpose

Define how `weave advance` starts the next lifecycle phase, how a run is finished, what a phase may do without asking, and how a person sees a run's progress.

## Current Behavior

`weave advance` starts a phase only when its transition's conditions hold (see the README's auto-advance section). How it starts comes from `--launch`, then `advance.launch` in `.weave/workspace.yml`, then `handoff`. `--detach` alone means `background`.

- `handoff` (default): Weave starts no agent. Under the advance lock it records a run with `launch: handoff` and returns `steps[0].handoff`: `run_id`, `skill`, `lane`, `change_id`, `folder`, `skill_files` (installed copies of the skill under `.claude/skills`, `.agents/skills`, or `.opencode/commands`), and a self-contained `brief`. The brief names the skill and change, the folder, the skill files to read when the agent cannot load skills by name, says there is no earlier conversation to rely on, says what the phase produces goes in `wiki/changes/<change-id>/` and the rest of the project stays as it was, and says recording progress completes the run. The run's `agent` is `claude` inside Claude Code (`CLAUDECODE=1`), `--agent` when given, and `calling-agent` otherwise. A dry run says it would hand the phase to a fresh sub-agent.
- `here`, `terminal`, `background`: Weave starts the session itself. These need an agent someone chose: `--agent`, `advance.agent`, or an `advance.command` template, where `{prompt}` is replaced by the shell-quoted prompt (agent name `custom`). Without one they fail with `missing_launch_agent`; an unknown agent name fails with `unsupported_launch_agent`.
  - `here`: an interactive session in the current terminal; Weave waits for it to end, then records the run.
  - `terminal`: the same session in a new terminal, returning at once. Openers are tried in order: herdr (`HC_TERMINAL_ID` set and `herdr-app` on `PATH`; `herdr-app do tab.new`), tmux (`TMUX` set; `tmux new-window -d`), iTerm2 (`TERM_PROGRAM=iTerm.app`), and Terminal.app on macOS. None is a Weave dependency. The terminal runs the session followed by `weave advance --finish-run <run-id>`. The terminal opens before the run is recorded, so one that fails to open (`no_terminal`) leaves no run behind.
  - `background`: a headless session. For Claude, `--permission-mode acceptEdits` (unless `--permission-mode` is given), `--output-format stream-json --verbose`, and `--allowedTools` limited to web lookups, `weave`, read-only `git`, and `ls`. From an agent (no terminal) it is detached; from a terminal it runs in place.

## Runs

- Each run records `launch` and, for `terminal`, `where`.
- `weave change progress <lane>` finishes every `running` run of that lane as `succeeded`, so a session that records its lane finishes its run even while it stays open.
- `weave advance --finish-run <run-id>` (used after a sub-agent returns, and by terminal sessions when they end) finishes a still-running run as `succeeded` if its lane was progressed after the run started, otherwise `incomplete`, and then keeps advancing unless `--once`.
- A background run finishes when its process exits; if the session already progressed the lane, that recorded result is kept.

## Phase Permissions

`weave agent install` and `weave agent update`, when they target Claude Code, add any missing rules from this list to `.claude/settings.json` `permissions.allow`, keeping every other setting and rule: `Edit(/wiki/changes/**)`, `WebSearch`, `WebFetch`, `Bash(weave *)`, `Bash(git log *)`, `Bash(git show *)`, `Bash(git diff *)`, `Bash(git status *)`, `Bash(git ls-files *)`. The summary names the rules it added. Other agents' permission formats are documented in the README, not written.

## Watching A Run

- `weave change runs` lists runs; a running one says where it is: a sub-agent of the session that handed it off, the terminal it opened in, or the `weave change run log` command for a background run.
- `weave change run log [run-id] [--follow]` prints a background run's log as readable lines (session start, text, tool calls such as `Read <file>` or `Agent <type>: <description>`, tool errors, the final result, and how many tool calls were blocked), following until the run finishes. For interactive runs it says where the session is.

## Integrations And Side Effects

- `weave-questions` calls `weave advance --transition questions_to_research --json`. On a handoff it starts one fresh, foreground sub-agent with exactly the brief, waits for it, then runs `weave advance --finish-run <run-id> --launch handoff --once --json`. Without sub-agents it gives the person the brief for a new session.
- `weave-stress-test` hands off the PRD after a passing exploration verdict (`exploration_to_prd`, on by default for `feat`, gated on a current passing verdict for every change type and on `## PRD Readiness` reading `Ready`). For a PRD handoff the brief adds that nobody can answer questions, so the sub-agent returns blocking questions instead of writing `prd.md`.
- `weave-research` investigates freely (code, tests, docs, web lookups, and quick checks in a temporary folder outside the repo), adds only `research.md` (written with the file tools), edits nothing else in the repo, reads files named in `questions.md` first, and answers follow-up questions in dated `## Follow-Up` sections.
- `weave-next` reports a running phase with where it runs and never recommends starting it again.
- Decisions: [261108-adko-write-ups-after-a-passing-stress-test-may-auto-advance](../../../../decisions/261108-adko-write-ups-after-a-passing-stress-test-may-auto-advance.md), [261108-4z8l-auto-advance-hands-phases-to-the-calling-agent](../../../../decisions/261108-4z8l-auto-advance-hands-phases-to-the-calling-agent.md).
- Opening a change folder where the person chose (`weave change new`/`switch`/`open`, `~/.weave/settings.yml`; see [opening-changes](../features/opening-changes/behavior.md)) is a separate feature with its own openers and agent setting: it never reads `advance.*`, and `weave advance` never reads the opening default. Only the quoting helpers (`shellQuote`, `appleScriptString` in `src/lib/terminal-launch.ts`) are shared ([261109-bv3c](../../../../decisions/261109-bv3c-opening-a-change-is-separate-from-auto-advance-launching.md)).

## Related Specs

- [lifecycle-progress-and-staleness](lifecycle-progress-and-staleness.md)
- [change-checkouts](change-checkouts.md)
- [opening-changes](../features/opening-changes/behavior.md)
