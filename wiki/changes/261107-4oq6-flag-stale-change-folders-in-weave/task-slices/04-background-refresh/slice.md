# Background remote refresh and freshness

## Outcome

Remote facts (merged on origin, branch deleted on origin) reach the list without ever slowing it down or touching the user's refs. A detached refresh fetches into `refs/weave/remotes/origin/*`, and `--fetch` waits for a fresh answer. Ages, problems, and "refreshing now" are shown (ADR `261108-4ko1`).

## User flow

1. A developer runs `weave change list`, which prints immediately and spawns a refresh, and the age line says "refreshing now…".
2. A few seconds later, the next list shows `landed in main (squashed)`.
3. An agent runs `weave change list --fetch --json`. It joins a running refresh or runs one, waits at most about 30 s per repo, and returns fresh state with `freshness.refreshing: false`.

## In scope

- `change-refresh.ts`:
  - `refresh.json` liveness (pid, age limit) and the 60 s throttle
  - the hidden `weave change refresh --root`
  - `maybeSpawnRefresh` (from the command layer, worktree mode only, `WEAVE_NO_BACKGROUND_REFRESH=1`)
  - `--fetch` joining or running in-process
- Fetch:
  - `lsRemoteHeads`, then named refspecs for known `change/<id>` branches and the targets in use
  - `update-ref -d` for gone refs
  - hardened `-c` flags and env
  - a no-terminal session
  - the result classification `ok|timeout|auth|unreachable|no_remote|error`
  - `seen` and `absent` lists
- Feeding `goneTargets`, `may_have_landed`, and `local_view_older` into slices 01 and 02.
- The age lines, refresh problem texts, "refreshing now", `freshness`, `repos[].as_of`, and `repos[].refresh`.

## Out of scope

- Host PR lookup.
- Fetching remotes other than `origin`.

## Acceptance criteria

- [ ] PRD Acceptance Criteria on instant list, age, "refreshing now", one refresh at a time, the throttle, the timeout, `--fetch` join and report, never prompting, offline, and "list changes no branches" hold.
- [ ] After a refresh, `refs/remotes/*`, `FETCH_HEAD`, and tags are unchanged, even with `fetch.pruneTags=true`.
- [ ] A teammate's unknown `change/*` branches are not fetched.
- [ ] "branch deleted on origin; it may have landed" appears after a seen branch disappears.
