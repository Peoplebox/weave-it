# Contracts: Open in VS Code, Cursor, Claude desktop, and T3 Code

## Interfaces

- Registry entries `vscode`, `cursor`, `claude-desktop`, `t3code` (`kind: app`, `remoteOk: false`). `choices[]` entries carry `hint` where the place can't be fully checked (`t3code`: "must be running").
- `open()`: spawn detached with `stdio: "ignore"` and `unref()`. Success means the launcher returned within 10 s.

### Launch mechanisms (findings, 2026-11-09, slice 04 T2)

- **Claude desktop app (4.23118.0, `com.anthropic.claudefordesktop`):** registers the `claude` URL scheme. Its bundled handler accepts `claude://code/new` with repeated `folder=` parameters and a `q=` (or `prompt=`) first message. The app's own Finder service "New Claude Code Session Here" runs `open "claude://code/new?folder=<path>&source=services"`. Weave opens `claude://code/new?folder=<folder>&source=weave` with `open`. A `q=` draft is added only once slice 07 confirms it is not sent automatically. The app asks the person to confirm the folder (PRD assumption).
- **T3 Code (0.1.7 beta, `com.t3tools.t3code`):** registers `t3code://`, but its handler only accepts `t3code://pair` (device pairing). Its `open-file` handler accepts only web pages. No CLI ships in the bundle. **No way to open a folder from outside was found.** Weave brings the app up with `open -a` and reports `failed` with "add the folder as a project there", keeping the default. The hint in the menu says the same. This is a product question for the PRD owner (keep T3 Code on the list or drop it until it supports opening folders).
- **VS Code / Cursor:** their bundled CLIs (`…/bin/code`, `…/bin/cursor`) with `-n <folder>`, started detached.

## Data

- Install path tables per platform (macOS `.app` bundles and their `bin/` CLIs; Linux `/usr/share/code/bin/code`, `/opt/cursor`, AppImage locations, and so on), pinned in tests.
- `locations.<id>` adds paths.

## State

- `missing`: none of the absolute install paths exist.
- `unavailable_now`: Linux with neither `DISPLAY` nor `WAYLAND_DISPLAY`.
- `failed`: the launcher exits non-zero or times out (for example T3 Code not running), and the default is kept.
- `draft: "shown"` for every app in this slice.

## Validation and errors

- `--agent` with an app place → `agent_not_for_app` (argument error, before creating).
- The folder is always passed as one argv element.

## Files and artifacts

- Modified: `src/lib/open-places.ts`, `src/lib/open-change.ts` (display rule), `tests/open-places.test.ts`, `tests/open-change.test.ts`.
