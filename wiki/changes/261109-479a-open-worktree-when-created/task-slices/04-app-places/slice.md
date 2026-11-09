# Open in VS Code, Cursor, Claude desktop, and T3 Code

## Outcome

The app side of the fixed list works:
- VS Code (found only through its own install path, never `code` on PATH).
- Cursor (opened with `-n`).
- Claude desktop on macOS.
- T3 Code, shown with a "must be running" hint.

Apps have no second step. App processes are detached so Weave never waits on them. Apps are skipped over SSH on every platform, and on Linux they are `unavailable_now` with no display.

## User flow

1. The person picks "Cursor" in the menu. Cursor opens a new window on the change folder, and the original session shows the next step to paste.
2. On a machine where Cursor has taken over `code`, choosing VS Code still opens VS Code.
3. With T3 Code installed but not running, a create reports `Didn't open: T3 Code must be running.` plus the folder and step, and the default is kept.
4. On a headless Linux box, a Cursor default reports `skipped` (`no_display`).

## In scope

- Places `vscode`, `cursor`, `claude-desktop`, `t3code`: `kind: app`, `remoteOk: false`, install paths, hints, and `open()` via `open -a`, the app's CLI, or its URL scheme, detached and unref'd.
- Establishing and recording how Claude desktop and T3 Code accept a folder (URL scheme, `open -a`, or CLI). If no way exists, the place keeps its hint and reports `failed`.
- The Linux `DISPLAY`/`WAYLAND_DISPLAY` rule.
- SSH skipping for every app.

## Out of scope

- An unsent first message for Claude desktop (slice 07).

## Acceptance criteria

- [ ] VS Code is never found through a PATH `code`. A fake PATH `code` that points to Cursor is ignored.
- [ ] Cursor opens with `-n` and the folder.
- [ ] App places have no agent step, and `--agent` with an app gives `agent_not_for_app`.
- [ ] Over SSH, every app gives `skipped` (`ssh`). On Linux with no display, `skipped` (`no_display`).
- [ ] Each installed app opens the change folder on a real Mac (manual check). The launch mechanisms for Claude desktop and T3 Code are recorded.
