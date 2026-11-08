---
artifact: tasks
slice: 04-background-refresh
status: draft
owner: engineering
created_at: 2026-11-08T14:27:28.000Z
updated_at: 2026-11-08T14:27:28.000Z
source: architecture
---

# Tasks: Background remote refresh and freshness

## Status Legend

- `todo`: ready when blockers are done
- `in_progress`: currently being implemented
- `blocked`: cannot proceed without listed blocker
- `done`: implemented and verified
- `not_tested`: implementation complete, automated verification incomplete
- `invalid`: no longer applies

## Active Task Index

| ID | Status | Execution | Repos | Owner | Title | Blocked by |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | done | afk | root | | Fetch remote state into Weave-only refs without prompting | None |
| T2 | done | afk | root | | Run one throttled background refresh at a time | T1 |
| T3 | done | afk | root | | Show freshness and remote-derived labels in the list | T2 |
| T4 | done | afk | root | | Verify refresh isolation, failure handling, and freshness | T3 |

## root

### T1: Fetch remote state into Weave-only refs without prompting

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `src/lib/git.ts` (M)

### What to build

Implement `lsRemoteHeads` and `fetchNoPrompt`:
- **Fetch:** named refspecs `+refs/heads/<b>:refs/weave/remotes/origin/<b>`, with `--no-tags --no-recurse-submodules`, and `--no-write-fetch-head` when caps allow.
- **Config:** `-c fetch.pruneTags=false -c gc.auto=0 -c maintenance.auto=false -c fetch.writeCommitGraph=false -c core.askPass= -c credential.interactive=false`.
- **Env:** `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS` and `SSH_ASKPASS` set to a failing program, `SSH_ASKPASS_REQUIRE=never`, and `GCM_INTERACTIVE=never`. Add `GIT_SSH_COMMAND="ssh -o BatchMode=yes"` only when no ssh command is set.
- **Process:** spawn detached (a new session), stdin ignored, with a timeout kill.
- **Results:** classify as `ok|timeout|auth|unreachable|no_remote|error`. Delete gone refs with `update-ref -d`.

### Acceptance Criteria

- [x] Never writes outside `refs/weave/*`
- [x] No controlling terminal for the git child

### Verification

- Typecheck: `npm run typecheck`
- Covered by T4
- Result (2026-11-08): passed via T4; found and fixed git's opportunistic remote-tracking update with --refmap=

### T2: Run one throttled background refresh at a time

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1
Files:
- `src/lib/change-refresh.ts` (C)
- `src/commands/change.ts` (M)

### What to build

Implement `refresh.json` with claim and takeover under `withStateLock`, the liveness rule, and the 60 s throttle. Add the hidden `weave change refresh --root` command, which:
- runs each repo in parallel with a 30 s timeout
- records the `seen` and `absent` lists
- recomputes through `gatherFacts` and `deriveStates`
- writes `attention.json` (with `facts_at`)
- always exits 0

Add `maybeSpawnRefresh` in the command layer after printing, using the `advance --detach` spawn pattern, worktree mode only, honouring `WEAVE_NO_BACKGROUND_REFRESH=1`. Add `--fetch`, which joins a running refresh or runs one in-process under the same no-prompt rules.

### Acceptance Criteria

- [x] At most one refresh runs
- [x] `--fetch` never starts a second refresh

### Verification

- Typecheck: `npm run typecheck`
- Covered by T4
- Result (2026-11-08): passed via T4

### T3: Show freshness and remote-derived labels in the list

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T2
Files:
- `src/lib/change-facts.ts` (M)
- `src/lib/change-states.ts` (M)
- `src/lib/changes.ts` (M)

### What to build

Feed Weave refs, `goneTargets`, and the `seen`/`absent` data into facts. Enable the `may_have_landed` and `local_view_older` labels (with the "on origin; run git fetch to see it locally" text). Render the shared age line, per-change age lines when repos differ or a refresh failed, the refresh problem texts, and "refreshing now, run again in a few seconds for the latest". Fill `freshness`, `repos[].as_of`, and `repos[].refresh`. Show no age for repos without `origin`.

### Acceptance Criteria

- [x] Old remote data only under-reports landing
- [x] Text and JSON agree

### Verification

- Typecheck: `npm run typecheck`
- Covered by T4
- Result (2026-11-08): passed via T4

### T4: Verify refresh isolation, failure handling, and freshness

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T3
Files:
- `tests/change-refresh.test.ts` (C)
- `tests/cli-change-list.test.ts` (M)

### What to build

Against a file-path bare remote, cover:
- success, and a merge on origin showing `landed` after refresh
- a gone branch removed, and the `may_have_landed` label
- only known `change/<id>` branches fetched
- `refs/remotes/*`, `FETCH_HEAD`, and tags untouched, with `fetch.pruneTags=true` set
- auth failure via `ext::` with `protocol.ext.allow=always` and a blocking `GIT_ASKPASS` (it must not hang)
- timeout via a sleeping `ext::` transport
- the throttle
- a dead-pid takeover
- `--fetch` joining a running refresh
- an offline age line
- "refreshing now" text and `refreshing: true`

### Acceptance Criteria

- [x] Every case above has a named test
- [x] Tests pass with no network access

### Verification

- Automated tests: `npx vitest run tests/change-refresh.test.ts tests/cli-change-list.test.ts`
- Full suite: `npm test`
- Typecheck: `npm run typecheck`
- Result (2026-11-08): passed: npx vitest run tests/change-refresh.test.ts (12 tests); npm test (405 tests); npm run typecheck

## QA Findings

| ID | Status | Severity | Source | Related Task | Summary |
| --- | --- | --- | --- | --- | --- |

None.

## Refactors

| ID | Status | Scope | Related Tasks | Summary |
| --- | --- | --- | --- | --- |

None.

## Verification

Not run yet.
