---
artifact: research
status: draft
owner: engineering
created_at: 2026-11-09T09:30:00.000Z
updated_at: 2026-11-09T09:30:00.000Z
source: questions.md
git_commit: 211c086
branch: change/261109-479a-open-worktree-when-created
---

# Research: Open worktree when created

## Summary

`weave change new` either switches the current checkout to the change branch (`checkout: in-place`) or, in `checkout: worktree` mode (the default `weave init` writes), creates a separate change folder of git worktrees next to the main checkout and leaves the caller where it was. In worktree mode the command's only guidance about moving there is a final text line, `Open <folder> in a new session to work on this change.`, and a `folder` field in `--json`; nothing is opened. The `weave-new` and `weave-fix` skills, the README, `weave-next`, and decision `261107-ohne` all say the same thing: the person opens the folder in a new session, because an agent session cannot move itself. Weave already has code that opens visible terminals (`src/lib/terminal-launch.ts`: herdr, tmux, iTerm2, Terminal.app) and builds agent command lines (`src/lib/agent-launchers.ts`: Claude only, plus a `custom` command template), but only `weave advance --launch terminal|here|background` uses them, and only with an agent someone configured. Weave records which agents it installed skills for in `.weave/agents.yml`, and detects the calling agent only for Claude Code (`CLAUDECODE=1`); there is no setting for a preferred terminal or editor.

## `weave change new` decides the checkout mode from workspace.yml and, in worktree mode, builds a sibling folder and only prints where it is

The CLI layer (`src/commands/change.ts:124-160`) parses `<title>`, `--type` (default `feat`), `--slug`, `--no-auto-advance`, `--repo` (repeatable), `--base` (repeatable, `ref` or `repo=ref`), `--no-fetch`, and `--json`, then calls `createChange` with `cwd: process.cwd()` inside `withNotices`, passing `result.message` as the text output and the whole result as JSON.

```text
weave change new "<title>"                       src/commands/change.ts:141
└─ createChange(options)                          src/lib/changes.ts:458
   ├─ resolveTarget(cwd, sessionPath)             src/lib/changes.ts:1747   (no Weave context -> no_weave_context)
   ├─ normalizeChangeSlug / autoAdvanceDefaults[type]
   ├─ assertGitTargets
   ├─ workspaceCheckoutMode(root)                 src/lib/worktrees.ts:101  (.weave/workspace.yml `checkout`, default "in-place")
   ├─ generateChangeId -> "<yymmdd>-<4 chars>-<slug>"   src/lib/changes.ts:1662
   ├─ changeBranch(id) -> "change/<id>"; assertChangeMissing
   ├─ checkout === "worktree"                     src/lib/changes.ts:476-501
   │  ├─ ensureChangeWorktrees(...)               src/lib/worktrees.ts:111
   │  ├─ writeChangeFiles(worktrees.folder, ...)  src/lib/changes.ts:523   (status.yml, sessions/, exploration.md for feat)
   │  ├─ recordCheckoutInStatus(changePath, repos)
   │  └─ summarizeChangeOperation({... worktrees, targets:[{path: folder, ...}]})
   └─ else (in-place)                             src/lib/changes.ts:503-520
      ├─ refuse `stacked_change` when on a change/ branch and no --base
      ├─ ensureChangeBranch(root, branch, base)   `git checkout [-b] branch [base]` in the current checkout
      ├─ writeChangeFiles(root, ...)
      └─ summarizeChangeOperation({... targets})
```

`workspaceCheckoutMode` reads `.weave/workspace.yml` through `readWorkspaceMetadata` (`src/lib/workspace-repos.ts:87-112`); any value other than `worktree` parses as `in-place` (`src/lib/workspace-repos.ts:105`). `weave init` writes `checkout: "worktree"` for new workspaces (`src/lib/init-workspace.ts:483-484`). This repo's own `.weave/workspace.yml` is `mode: repo`, `checkout: worktree`, with `worktrees.setup: npm ci && npm run build`.

### Where the change folder goes

`ensureChangeWorktrees` (`src/lib/worktrees.ts:111-204`) resolves the main checkout through `git worktree` (`workspaceLayout`, `src/lib/worktrees.ts:461-464`, so it works from inside another change folder too), and the folder is `changesRoot(mainRoot, metadata)/<change-id>`:

- `worktrees.root` in workspace.yml, resolved relative to the main checkout, when set;
- otherwise `<parent of main checkout>/<main checkout name>.changes` (`src/lib/worktrees.ts:474-478`).

Inside the folder the workspace root worktree sits at `.` and each registered repo at its registered relative `path` (`selectTargets`, `src/lib/worktrees.ts:480-517`). All repos are planned first; any blocker throws `worktree_blocked` before anything is created, and a failed apply rolls back every attempted worktree (`src/lib/worktrees.ts:117-150`). It then copies ignored files listed in `copy`, takes a slot under the machine-local state lock, writes `.git/weave/changes/<id>.yml` (`LocalChangeState`: `folder`, `slot`, `repos`, `created_at`; `src/lib/worktrees.ts:90-99, 157-185, 717-720`), and records starting branches in `.git/weave/bases/<id>.yml`. The change's own files are then written into `<folder>/wiki/changes/<id>/`.

This change's own folder is an example: `/Users/arpit/personal/weave-it.changes/261109-479a-open-worktree-when-created` beside the main checkout `/Users/arpit/personal/weave-it`.

### What it prints

`summarizeChangeOperation` (`src/lib/changes.ts:2470-2518`) builds both outputs. Text output:

```text
Created change: <id>

Title: <title>
Type: <type>
Branch: change/<id>
<auto-advance lines>

# worktree mode (formatWorktreeLines, src/lib/changes.ts:2520-2535)
Folder: <absolute folder>
Slot: <n>

Worktrees:
  root  .  created from origin/main
  <repo>  <path>  created|reused|skipped: <reason> [from <base>]
[Copied: ...]
[Warnings: ...]

Open <absolute folder> in a new session to work on this change.

# in-place mode
Targets:
  <root path> (<branch status>, current)
```

`--json` returns `ChangeOperationResult` (`src/lib/changes.ts:174-191`): `status`, `id`, `slug`, `title`, `type`, `branch`, `auto_advance`, `checkout`, and, in worktree mode only, `folder`, `slot`, `repos[]` (`id`, `path` relative to the folder, `branch`, `status`, `base`, `base_commit`, `reason`), `copied`, `warnings`; plus `targets[]` (`path`, `changePath`, `branch`, `branchStatus`, `current`) and `message`. `withNotices` merges a `notices` array into the JSON, or prints a notice footer on stderr for a TTY (`src/lib/with-notices.ts:30-41`). The JSON has no separate next-step field; the "Open … in a new session" sentence exists only inside `message`.

`weave change switch <change>` in worktree mode goes through `openChangeFolder` (`src/lib/changes.ts:889-940`), which reuses `formatWorktreeLines`, so it prints the same `Folder:` block and the same `Open <folder> in a new session to work on this change.` line. Neither command spawns a process, changes the shell's directory, or opens an editor or terminal.

**Tested by:** `tests/worktrees.test.ts` (integration against real temporary git repos with bare `origin` remotes, calling `createChange` directly; asserts `checkout: "worktree"`, `folder` at `<base>/acme.changes/<id>`, `slot`, `copied`, branches in each worktree, main checkouts untouched, rollback, `--repo`, `--base`, listing and switching). `tests/changes.test.ts` covers in-place creation (`branchStatus`, `current`). `tests/cli-skills.test.ts:168-199` runs `weave change new` through `createProgram()` with a spied `process.stdout.write` and asserts `Created change:` and `Type:` lines. No test asserts the `Open … in a new session` line.

## The skills and README tell the person to open the folder in a new session themselves

`weave-new` (`templates/skills/weave-new/SKILL.md:19-44`) runs `weave workspace --json`, `weave change current`, then `weave change new "<title>"` (text output, not `--json`), and branches on the result's `checkout`:

- `worktree`: "Tell the user to open that folder in a new session and run the next skill there. Do not keep working on the change from this session, because this session's files are not the change's files." (`:41`)
- `in-place`: the current checkout switched and the change is current here (`:42`).

It forbids running `git worktree` or `git checkout` itself (`:48`) and recommends the next skill (`weave-questions` then `weave-research` "in a fresh session", or `weave-explore`; `:52-53`). The installed copy `.claude/skills/weave-new/SKILL.md` is identical to the template; the opencode command `templates/opencode/commands/weave-new.md` only says "Load and follow the `weave-new` skill." with `Topic: $ARGUMENTS`.

Other places that say the same:

| Where | What it says |
| --- | --- |
| `templates/skills/weave-fix/SKILL.md:49` | creates the change with `--json`; in worktree mode writes every file under `folder`, runs remaining `weave` commands from inside it, and tells the user to open that folder in a new session |
| `templates/skills/weave-next/SKILL.md:56` | with no active change: "Run `weave change list` to see each change's folder, open the one you want in a new session" |
| Other phase skills (`weave-questions`, `weave-research`, `weave-explore`, `weave-prd`, …) | with no active change: "Run `weave change new` or `weave change switch`" |
| `README.md:486` | "Open the printed folder in a new session to work on the change." |
| `wiki/knowledge/domains/change-workflow/domain-wide/change-checkouts.md` (Integrations) | "`weave-new` and `weave-fix` report the change folder and tell the user to open it in a new session" |
| Decision `261107-ohne` (Consequences) | "An agent session cannot move into the new folder by itself, so people open the change folder in a new session." |

**Tested by:** `tests/agent-skills.test.ts:1240-1321` checks that `weave-new` installs (skill and opencode command) and contains its name and load line; skill wording is otherwise untested.

## Terminal opening is a list of four openers tried in order; only `weave advance --launch terminal` uses it

`src/lib/terminal-launch.ts` defines the contract (`:11-29`):

```ts
interface TerminalOpenRequest { cwd: string; title: string; command: string }   // command: a full shell line
interface OpenedTerminal { kind: string; where: string }                          // where: human text
interface TerminalOpener {
  kind: string;
  available(env: NodeJS.ProcessEnv): Promise<boolean>;
  open(request: TerminalOpenRequest, env: NodeJS.ProcessEnv): Promise<OpenedTerminal>;
}
```

`terminalOpeners = [herdr, tmux, iterm, terminal-app]` (`:85`); `findTerminalOpener(env, openers)` returns the first whose `available` is true, or `undefined` (`:87-94`).

| Opener | `available` | `open` | `where` |
| --- | --- | --- | --- |
| herdr (`:31-42`) | `HC_TERMINAL_ID` set and `herdr-app` found on `PATH` | `herdr-app do tab.new '{"name":title,"folder":cwd,"argv":["/bin/sh","-c",command]}'` | `a new herdr tab named "<title>"` |
| tmux (`:44-54`) | `TMUX` set and `tmux` on `PATH` | `tmux new-window -d -c <cwd> -n <title with non-word chars as -> <command>` (detached: does not switch to it) | `tmux window <name>` |
| iTerm2 (`:56-70`) | macOS and `TERM_PROGRAM=iTerm.app` | `osascript`: `create window with default profile command "/bin/sh -c 'cd <cwd> && <command>'"` | `a new iTerm2 window` |
| Terminal.app (`:72-83`) | macOS (always, as the fallback) | `osascript`: `activate`, `do script "cd <cwd> && <command>"` | `a new Terminal window` |

`findExecutable` walks `env.PATH` checking execute permission (`:96-107`); `shellQuote` single-quotes anything outside `[\w@%+=:,./-]` (`:109-111`). On Linux outside herdr or tmux no opener is available.

The only caller is `openPhaseTerminal` in `src/lib/advance.ts:458-476`. When `findTerminalOpener` returns nothing it throws `no_terminal` ("No terminal could be opened for the next phase. Run `weave advance` yourself in a terminal to start it there."). Otherwise it builds `<agent interactive command>; <weave> advance --finish-run <run-id> [--once]` (`weave` defaults to `process.execPath` plus `process.argv[1]`), titles it `<skill> <id token>`, and opens it with `cwd: options.cwd`. The terminal opens before the run is recorded, so a failure leaves no run (`src/lib/advance.ts:231-236`). The result message then reads `Started <skill> in <where> (run <id>).` and "The session is interactive: watch it there and approve its file writes." (`src/lib/advance.ts:782-783`).

Observed in this session: the process runs inside herdr (`HC_TERMINAL_ID`, `HC_TERMINAL_SOCKET`, `HC_SCOPE` set; `__CFBundleIdentifier=dev.herdr.app`; `TERM_PROGRAM=ghostty`) and inside Claude Code (`CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT=cli`, `CLAUDE_CODE_SESSION_ID`, …). `herdr-app` 0.1.14 is on `PATH`; `tmux` and `cursor` are not.

**Tested by:** `tests/advance.test.ts:504-591` ("visible launches") injects a `recordingOpener` through `AdvanceOptions.terminalOpeners`, so no real terminal opens. It asserts the request (`cwd`, `title: "weave-research aa01"`, command containing the agent line and `; weave advance --finish-run <run>`), the recorded run (`launch: "terminal"`, `where`), and that an unavailable opener throws `no_terminal` and records no run. The four real openers, `findTerminalOpener`'s order, `findExecutable`, and `shellQuote` have no direct tests.

## Agent launchers build command lines; only Claude has one, and Weave starts an agent only when someone configured it

`src/lib/agent-launchers.ts` defines (`:9-37`):

```ts
interface AgentLaunchRequest { cwd: string; prompt: string; sessionId?: string; permissionMode?: string; logPath: string }
interface AgentLaunchPlan { command: string; args: string[] }
interface AgentLauncher {
  agent: string;
  acceptsSessionId: boolean;
  plan(req): AgentLaunchPlan;          // headless, for background
  interactive(req): AgentLaunchPlan;   // visible session
  launch(req): Promise<{ exitCode: number; sessionId?: string }>;   // runs plan() with output to logPath
}
```

- `claudeLauncher` (`:53-93`): `plan` is `claude -p <prompt> [--session-id <id>] --permission-mode <mode|acceptEdits> --output-format stream-json --verbose --allowedTools <backgroundAllowedTools>`; `interactive` is `claude <prompt> [--session-id <id>] [--permission-mode <mode>]`; `launch` deletes `CLAUDECODE` from the child env so the child starts its own session.
- `agentLaunchers = { claude }` (`:95-97`). `defaultLaunchAgent = "claude"` is a library default the CLI does not rely on (`:99-101`).
- `commandTemplateLauncher(template)` (`:107-121`): agent name `custom`; both `plan` and `interactive` are `/bin/sh -c <template with {prompt} replaced by the shell-quoted prompt>`; no session id.
- `runToLog` spawns with `cwd`, stdout and stderr to the log file (`:127-145`); a spawn error becomes `agent_launch_failed`.

The working directory is never a CLI flag: every launch uses the spawn's `cwd` (`runToLog`, `runInteractiveSession` at `src/lib/advance.ts:478-486`) or the terminal opener's `cwd`. The prompt is always `use the <skill> skill for change <id>` (`advancePrompt`, `src/lib/advance.ts:183-185`). Permissions are `--permission-mode` (from `--permission-mode`, default `acceptEdits` for background Claude) and the `--allowedTools` list.

### How `advance.launch` chooses

```text
weave advance (src/commands/advance.ts:43-89)
  launch = --launch ?? (--detach ? background : workspace.yml advance.launch ?? "handoff")
  handoff        -> agent = --agent (optional); no launcher needed
  here|terminal|background -> resolveAgent (:94-112)
        --agent or advance.agent  -> must be a key of agentLaunchers, else unsupported_launch_agent
        else advance.command      -> { custom: commandTemplateLauncher(command) }
        else                      -> missing_launch_agent
advanceStep (src/lib/advance.ts:191-288)
  handoff     -> handoffStep: record run, return { run_id, skill, lane, change_id, folder, skill_files, brief }  (:290-329)
  terminal    -> openPhaseTerminal (launcher.interactive) then record run; return detached   (:233-261)
  here        -> launcher.interactive run with stdio inherited, wait, finishLaunchedRun   (:262-267)
  background  -> detached `weave advance --execute-run` child (:268-282) or executeRun -> launcher.launch (:371-426)
```

`handoffAgent` records `--agent`, else `claude` when `CLAUDECODE=1`, else `calling-agent` (`src/lib/advance.ts:366-369`). `phaseBrief` (`:332-349`) is the self-contained text a calling agent passes to a fresh sub-agent; `installedSkillFiles` lists the installed copies found under `.claude/skills`, `.agents/skills`, and `.opencode/commands` (`:351-363`). `weave change new` does not call any of this.

**Tested by:** `tests/advance.test.ts` with a `mockLauncher` (`:66-95`) passed through `AdvanceOptions.launchers`, whose `launch` records the request and optionally writes `research.md` and progresses the lane, so no agent runs. `runInteractive` and `spawnDetached` are injected as `vi.fn()` (`:337-358`, `:549-566`). `describe("agent launchers")` (`:462-502`) checks `claudeLauncher.plan`/`interactive` argument lists and `backgroundAllowedTools` without spawning. `tests/cli-advance.test.ts:94-150` runs the CLI for dry run, default handoff, and `missing_launch_agent` with `--launch background`. `commandTemplateLauncher` and `resolveAgent`'s `unsupported_launch_agent` branch have no test found.

## Weave knows which agents have skills installed, and detects only Claude Code at run time

- `AgentName = "codex" | "cursor" | "claude" | "opencode"` and `AgentSelection = AgentName | "all"` (`src/lib/agent-skills.ts:10-11`). `weave agent install|update|diff|reset <agent>` accepts those five values (`src/commands/agent.ts:69-75`).
- Install targets (`resolveAgentTargets`, `src/lib/agent-skills.ts:568-586`): codex and cursor to `.agents/skills`; claude to `.claude/skills` plus sub-agents in `.claude/agents`; opencode to `.agents/skills` plus `.opencode/commands`.
- `.weave/agents.yml` (`manifestRelativePath`, `src/lib/agent-skills.ts:114`) records, per agent under `installed`, every skill, command, resource, and sub-agent with its path and hashes (`setManifestEntry`, `:534-556`). This repo's manifest has entries for `claude`, `opencode`, `cursor`, and `codex`. It is read by `weave status` (`src/lib/status.ts:15, 118`, ordering `claude, codex, cursor, opencode`) and notices (`src/lib/notices.ts:91`). Nothing records which agent a person prefers or uses day to day.
- `.weave/workspace.yml` `advance` block (`src/lib/workspace-repos.ts:40-49, 125-133`): `launch` (`handoff|here|terminal|background`), `agent`, `command`. These are the only launch settings. There is no terminal, editor, or opener setting.
- Machine-local state: `.git/weave/` of the main checkout (`localStateDir`, `src/lib/local-state.ts:8-11`) holds per-change folder/slot files, setup approvals, bases, refresh and attention files; no agent or terminal preference. The user session file `~/.cache/weave/current-session.yml` (or `WEAVE_SESSION_PATH`; `src/lib/session-state.ts:45-51`) records folders and the current change or artifact per folder; no agent or terminal preference.
- Run-time detection in `src/`: `CLAUDECODE` (`src/lib/advance.ts:368`, deleted from child env at `:480` and `src/lib/agent-launchers.ts:89`), and `HC_TERMINAL_ID`, `TMUX`, `TERM_PROGRAM` in the terminal openers. No code reads Cursor, Codex, or opencode environment markers.

**Tested by:** `tests/agent-skills.test.ts` (install, update, reset, diff, manifest entries per agent, using temp dirs); `tests/cli-status.test.ts` for the status view. No tests for agent detection beyond `tests/advance.test.ts:634-642` ("records the calling agent generically outside Claude Code").

## External tools offer their own ways to open a folder or start a session there

Weave depends on none of these tools; they are what a running process can call or detect. Each row combines what this machine's installed CLI reports (`--help`, `commands`) with published docs. Sources and versions are under **External Dependencies**.

| Tool | Open a folder / start a session in a directory | Initial prompt | How a child process can tell it is inside |
| --- | --- | --- | --- |
| Herdr desktop app (`herdr-app`, terminals run by herdr-core `hc`) | `herdr-app do tab.new` with `folder`, `name`, `space`, `argv`; also `space.new` (`folder`, `argv`, `task`, `machine`), `terminal.open` (`argv`, `folder`, `place`: tab / right / down), `pane.split` (`direction`, `argv`). `hc run --cwd <path>` runs a program in a kept terminal | `task` argument on `tab.new` / `space.new` ("an agent (argv) and its first message (task)") | `HC_TERMINAL_ID` (the only signal herdr-core's skill documents); `HC_TERMINAL_SOCKET`, `HC_SCOPE` observed here; `__CFBundleIdentifier=dev.herdr.app` observed here; `TERM_PROGRAM=ghostty` observed here and reported by a third party |
| herdr TUI (`herdr`, a separate older product) | `herdr tab create --cwd`, `herdr workspace create --cwd`, `herdr pane split --cwd`, `herdr agent start <name> --kind claude\|codex\|cursor\|opencode` | via the agent's own argv | `HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`, `HERDR_SOCKET_PATH`, `TERM_PROGRAM=herdr` |
| Cursor editor (`cursor`) | `cursor <folder>`; `-n` forces a new window, `-r` reuses the last window, `-a/--add` adds a folder to the last window (installed 3.21.16 help). Since Cursor 3.10 a bare `cursor <folder>` opens in the last-focused window type, which may be the Agents Window; `-n`/`-r` bypass that. Here the binary is inside `Cursor.app/Contents/Resources/app/bin/` and not on `PATH` | none for the editor | `TERM_PROGRAM=vscode` (shared with VS Code); undocumented `CURSOR_*` variables reported by third parties |
| Cursor agent CLI (`agent`) | `--workspace <path>`; `-w/--worktree [name]` | positional prompt; `-p/--print` for non-interactive | `CURSOR_AGENT` documented for agent shells |
| Claude Code (`claude`, installed 2.1.319) | no cwd flag: the session uses the process working directory; `--add-dir` grants extra directories; `-w/--worktree [name]` makes its own worktree, `--tmux` opens it in tmux or iTerm2 panes | positional `prompt` (interactive); `-p` non-interactive; `-n/--name` session name | `CLAUDECODE=1` in tool shells, hooks, MCP servers, and IDE terminals; `CLAUDE_CODE_CHILD_SESSION=1` only from Claude Code itself; `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`; `CLAUDE_CODE_ENTRYPOINT` (observed `cli` here) is undocumented |
| Codex CLI (`codex`, installed 0.135.0) | `-C/--cd <DIR>` ("use the specified directory as its working root"); `codex exec -C` | positional `[PROMPT]` | not documented by OpenAI; source sets `CODEX_SANDBOX_NETWORK_DISABLED=1` under a restricted network sandbox, `CODEX_SANDBOX=seatbelt` on macOS, and a merged PR adds `CODEX_THREAD_ID`; the installed 0.135.0 binary contains all three names (presence only, not when each is set) |
| opencode (installed 1.18.25) | positional `[project]` ("path to start opencode in"); `opencode run --dir` (v1 docs); v2 docs: `opencode [directory]` | `--prompt` on the TUI; `opencode run [message..]` | `AGENT=1`, `OPENCODE=1`, `OPENCODE_PID=<pid>`, set in the CLI's startup middleware: confirmed in the installed 1.18.25 bundle (`process.env.AGENT="1",process.env.OPENCODE="1",process.env.OPENCODE_PID=String(process.pid)`); not in official docs |
| tmux | `new-window -c <dir>`, `split-window -c <dir>` | — | `TMUX`, `TMUX_PANE`; tmux 3.2+ sets `TERM_PROGRAM=tmux`, masking the outer terminal |
| iTerm2 / Terminal.app | AppleScript (as Weave does), or `open -a <app> <dir>` | — | `TERM_PROGRAM=iTerm.app` / `Apple_Terminal` (widely reported, not officially listed); iTerm2 also `ITERM_SESSION_ID`, `LC_TERMINAL=iTerm2` |
| macOS `open` | `open -a <app> [-n] [-g] <path>`, `--args` passes the rest to the app | — | — |

What Weave's herdr opener uses today is a subset: `tab.new` with `name`, `folder`, and `argv: ["/bin/sh", "-c", <command>]`; it does not pass `task` or `space`.

**Tested by:** not applicable (external tools). The installed-CLI facts above come from running `herdr-app commands`, `hc --help`, `claude --help`, `codex --help`, `opencode --help`, and Cursor's bundled `cursor --help` on this machine on 2026-11-09.

## Recorded Decisions

- **`261107-ohne-each-change-gets-its-own-worktree-folder`** (accepted; applies to `worktrees.ts`, `changes.ts`, `task-prepare.ts`, `git.ts`). With `checkout: worktree` (default for new workspaces), `weave change new` creates one folder per change with a worktree of the root and each registered repo on `change/<id>`, from the freshly fetched remote default branch, with plain `git worktree`. Consequences include: no Weave command moves a main checkout; "An agent session cannot move into the new folder by itself, so people open the change folder in a new session"; macOS and Linux only. Reconsider when disk or checkout time per change becomes costly, Windows is needed, or an installable multi-repo worktree tool appears. The code matches: the only hand-off to the folder is the printed line.
- **`261108-4z8l-auto-advance-hands-phases-to-the-calling-agent`** (accepted; applies to `advance.ts`, `commands/advance.ts`, `agent-launchers.ts`, `agent-permissions.ts`). By default `weave advance` starts no agent and returns a brief for a fresh foreground sub-agent; Weave starts a session itself (`here`, `terminal`, `background`) only when `--agent`, `advance.agent`, or `advance.command` is configured. Rejected alternatives include "Open a new visible terminal by default" (still needs an agent CLI Weave picks, does not work inside desktop apps, splits work across windows). Reconsider when an agent cannot start fresh sub-agents, Codex forks conversations into sub-agents, or "agents gain a common way to start a separate visible session that would serve better than a sub-agent." The code matches.
- **`261108-4ko1-remote-state-refreshes-in-the-background-into-weave-only-refs`** (accepted; applies to `commands/change.ts`, `changes.ts`, and others). `weave change list` spawns a detached, unref'd `weave change refresh` after printing; detached spawning is noted as already used by `weave advance --detach`. It is the precedent for Weave spawning detached processes from a command, and requires `WEAVE_NO_BACKGROUND_REFRESH=1` in tests.
- **`261108-kl3n-landed-means-merging-changes-nothing-against-the-starting-branch`** (accepted; applies to `changes.ts`, `worktrees.ts`): defines landing against the starting branch recorded at creation in `.git/weave/bases/<id>.yml`. Touches `change new` only through that record.
- **`261108-adko-write-ups-after-a-passing-stress-test-may-auto-advance`** (accepted; applies to `advance.ts`): which transitions may auto-advance; not about launching.
- No decisions are returned for `src/lib/terminal-launch.ts`, `src/lib/agent-skills.ts`, `src/commands/agent.ts`, or `templates/skills/weave-new/SKILL.md`.

The knowledge page `wiki/knowledge/domains/change-workflow/domain-wide/auto-advance-launch.md` describes the same launch modes, opener order, and run handling as the code above. Its link for decision `261108-4z8l` points at `decisions/261108-hndf-auto-advance-hands-phases-to-the-calling-agent.md`, a file that does not exist; the decision file is `261108-4z8l-…`. `change-checkouts.md` in the same folder describes folder placement and says `weave-new` and `weave-fix` tell the user to open the folder in a new session.

## External Dependencies

None of these are Weave dependencies (`src/lib/terminal-launch.ts:8-10` says so for the terminal tools). Versions are what is installed on this machine; docs were read on 2026-11-09.

- **Herdr desktop app 0.1.14 / herdr-core (`hc`).** Beta, announced around late October 2026. `herdr-app do <command>` takes flags named after the command's arguments or one JSON object, prints `{space, tab, terminal}` or `{pane, terminal}` on success and `{"error": …}` with exit 1 on failure, and never prompts. herdr-core's skill says `$HC_TERMINAL_ID` means you are inside herdr-core. A third-party issue notes `HC_TERMINAL_ID` can belong to hidden worker or remote terminals, and that stale `HERDR_*` variables can be inherited when herdr-core was started from a herdr TUI pane. Sources: https://github.com/herdrdev/herdr-app/blob/master/defaults/AGENTS.md, https://herdr.dev/core/, https://github.com/herdrdev/herdr-core/blob/master/docs/commands.md, https://raw.githubusercontent.com/herdrdev/herdr-core/master/skills/herdr-core/SKILL.md, https://github.com/henkisdabro/sandcastle-kit/issues/863, https://github.com/affromero/gitpane/issues/129.
- **herdr TUI 0.9.x.** Separate binary with `HERDR_*` variables. Source: https://herdr.dev/docs/cli-reference/.
- **Cursor 3.21.16.** Cursor's docs have no page for the `cursor` editor command; its flags follow VS Code's CLI (https://code.visualstudio.com/docs/configure/command-line). Staff confirmed `cursor -n .` and `cursor -r .` and the 3.10 window routing (https://forum.cursor.com/t/remote-ssh-cursor-path-opens-agents-window-remote-cli-doesnt-support-classic/165329). There is no flag to open a folder as a tab in the current window (https://forum.cursor.com/t/cli-open-folder-as-a-tab-in-the-current-window/166998). Agent CLI: https://cursor.com/docs/cli/reference/parameters, https://cursor.com/docs/cli/overview; `CURSOR_AGENT`: https://cursor.com/docs/agent/tools/terminal. Agent shells were reported to get `CI=1` in 2.3.x (https://forum.cursor.com/t/cursor-sets-ci-1-in-recent-versions/149560).
- **Claude Code 2.1.319.** Flags: https://code.claude.com/docs/en/cli-reference. Environment variables set for children: https://code.claude.com/docs/en/env-vars. Weave's `claudeLauncher` uses positional prompt, `-p`, `--session-id`, `--permission-mode`, `--output-format stream-json`, `--verbose`, `--allowedTools`.
- **Codex CLI 0.135.0.** Flags: https://learn.chatgpt.com/docs/developer-commands?surface=cli. Variables Codex sets are only in source: https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/spawn.rs, https://github.com/openai/codex/pull/10096, https://github.com/openai/codex/issues/10390.
- **opencode 1.18.25** (repo now `anomalyco/opencode`, formerly `sst/opencode`). v1 CLI: https://docs.opencode.ai/docs/cli; v2 CLI differs (shared background service, `--standalone`, `--server`): https://opencode.ai/v2/docs/cli/commands/. Detection variables: https://github.com/ascorbic/am-i-vibing/issues/94, https://github.com/sst/opencode/issues/1775 (a June 2026 comment says detection may have regressed on the dev branch).
- **tmux.** https://man7.org/linux/man-pages/man1/tmux.1.html, https://raw.githubusercontent.com/tmux/tmux/master/CHANGES (3.2 exports `TERM_PROGRAM`).
- **iTerm2 / Terminal.app / `open`.** https://iterm2.com/documentation-variables.html, https://terminfo-dev.pages.dev/device/env-term-program, https://ss64.com/mac/open.html.

## Code References

Change creation and output (key files, not exhaustive):

- `src/commands/change.ts:61-69, 124-160` — `change new` options and action
- `src/commands/change.ts:593-652` — `writeResult`, `runAction`, JSON error shape
- `src/lib/changes.ts:174-191` — `ChangeOperationResult`
- `src/lib/changes.ts:458-521` — `createChange`, worktree vs in-place branches
- `src/lib/changes.ts:523-537` — `writeChangeFiles`
- `src/lib/changes.ts:889-940` — `openChangeFolder` (`weave change switch` in worktree mode)
- `src/lib/changes.ts:2398-2418` — `ensureChangeBranch` (in-place)
- `src/lib/changes.ts:2470-2535` — `summarizeChangeOperation`, `formatWorktreeLines` (the "Open … in a new session" line at `:2533`)
- `src/lib/worktrees.ts:101-204` — `workspaceCheckoutMode`, `changeFolderPath`, `ensureChangeWorktrees`
- `src/lib/worktrees.ts:461-517` — `workspaceLayout`, `changesRoot`, `selectTargets`
- `src/lib/workspace-repos.ts:21-49, 87-133` — `CheckoutMode`, `WorkspaceMetadata`, advance settings parsing
- `src/lib/init-workspace.ts:478-486` — new workspaces get `checkout: worktree`
- `src/lib/with-notices.ts:30-41` — text vs JSON output with notices

Terminal and agent launching (exhaustive for the launch path):

- `src/lib/terminal-launch.ts:1-115` — opener contract, four openers, `findTerminalOpener`, `findExecutable`, `shellQuote`
- `src/lib/agent-launchers.ts:1-149` — launcher contract, `claudeLauncher`, `commandTemplateLauncher`, `runToLog`
- `src/lib/advance.ts:105-135` — `AdvanceLaunch`, `AdvanceOptions` (injection points `terminalOpeners`, `runInteractive`, `launchers`, `spawnDetached`, `env`)
- `src/lib/advance.ts:183-369` — `advancePrompt`, `advanceStep`, `handoffStep`, `phaseBrief`, `installedSkillFiles`, `handoffAgent`
- `src/lib/advance.ts:458-486` — `openPhaseTerminal`, `runInteractiveSession`
- `src/lib/advance.ts:715-728` — `spawnDetachedAdvance`
- `src/commands/advance.ts:23-132` — launch mode and agent resolution

Agents and local state (key files):

- `src/lib/agent-skills.ts:10-11, 114, 534-586` — `AgentName`, manifest path, manifest entries, install targets
- `src/commands/agent.ts:14-75` — `weave agent` subcommands and agent parsing
- `src/lib/status.ts:15, 118`; `src/lib/notices.ts:91` — readers of `.weave/agents.yml`
- `src/lib/local-state.ts:8-39` — `.git/weave/` state dir and lock
- `src/lib/session-state.ts:10-51` — user session file shape and path

Skills and docs:

- `templates/skills/weave-new/SKILL.md:19-53` — creation workflow and next-step guidance
- `templates/opencode/commands/weave-new.md` — opencode wrapper
- `templates/skills/weave-fix/SKILL.md:49` — worktree-mode handling in `weave-fix`
- `templates/skills/weave-next/SKILL.md:56` — "open the one you want in a new session"
- `README.md:468-503` — worktree checkouts section; `README.md:635-675` — auto-advance launch modes; `README.md:942-967` — agent install targets
- `wiki/knowledge/domains/change-workflow/domain-wide/change-checkouts.md`, `auto-advance-launch.md`

Tests:

- `tests/worktrees.test.ts` — worktree creation, listing, switching (real git)
- `tests/changes.test.ts` — in-place creation and listing
- `tests/cli-skills.test.ts:168-199` — `weave change new` via the CLI program
- `tests/advance.test.ts:66-112, 462-642` — mock launcher, agent launcher plans, visible launches, handoff
- `tests/cli-advance.test.ts:94-150` — advance CLI paths
- `tests/agent-skills.test.ts` — install targets and manifest

## Open Questions

- **Which environment variables does Codex reliably set for every child shell?** OpenAI does not document them; the names come from source, a merged PR, and their presence in the installed binary. Whether each is set for every shell-tool command (for example `CODEX_THREAD_ID` only "when applicable", `CODEX_SANDBOX` only under a sandbox) needs a run inside Codex. opencode's variables were confirmed in the installed 1.18.25 bundle; whether opencode v2 keeps them is not documented.
- **Does Cursor's integrated terminal set anything that tells it apart from VS Code?** `TERM_PROGRAM=vscode` is shared, and no official list of Cursor's terminal variables was found.
- **Does `herdr-app do tab.new` require `folder` to be absolute, and how do `task` and `argv` interact?** The command list describes them, but no doc states the constraints; testing would open real tabs, which this research did not do.
