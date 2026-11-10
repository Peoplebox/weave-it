---
artifact: architecture
capture_mode: stress-test
captured_at: 2026-11-10T21:45:30.000Z
---

# Stress Test: Architecture - 2026-11-11

The user asked the agent to answer the challenges itself and to ask only when absolutely necessary; none needed the user's decision. Key code claims were verified (`src/lib/sliceRollup.ts` readiness/whitelist/staging, `src/lib/git.ts` `gitEnv`).

## Challenges

### C1 — blocking — uncovered scenario (late build retry)
- Challenge: Retrying a failed or pending build "before any code checkpoint" swept the next slice's code into the earlier slice's late commit; there was no end to retries; and the retry relied on a start snapshot that exists only when review is on.
- Answer: Retry at every rollup only until another slice starts building, then mark the earlier slice superseded and let the later slice's build commit carry the leftovers (reported as `leftovers_from`). `weave-execute` runs rollup before each slice's first task as well as after its last, so this works with review off.
- Outcome: decided

### C2 — blocking — contradiction with code (build trigger)
- Challenge: Readiness is never stored, so a "transition" can't be detected. `not_tested` slices and re-finishes would be missed, and writing the outcome after the commit leaves `status.yml` dirty.
- Answer: Build state lives in git. Build commits carry `Weave-Slice` and `Weave-Coverage` (a hash of the active tasks' ids and statuses). Rollup commits when `ready_for_review` is true and no build commit matches the current coverage. No slice `status.yml` keys are added.
- Outcome: decided

### C3 — blocking — unowned assumption (index semantics)
- Challenge: It wasn't specified whether the catch-up commit takes the whole index, which would put the person's staged edits and rollup-staged files into "Planning notes".
- Answer: The catch-up uses `git commit --only -- <paths>`; everything already staged stays for the moment commit. Owned paths are re-added from the working tree. Tests cover a staged code file and a rollup-staged slice `status.yml`.
- Outcome: decided

### C4 — major — contradiction with code (identity)
- Challenge: The existing git helpers substitute a placeholder Weave identity, so `identity_missing` could never fire and pushed commits would carry a fake address.
- Answer: A dedicated runner passes the environment through untouched, and a test asserts the author matches `git config user.email`. There is no agent co-author line, which keeps Weave agent-neutral. This settles the PRD's open author question.
- Outcome: decided

### C5 — major — uncovered scenario (failed build × fix rounds)
- Challenge: A failed build combined with the fix-round retry broke "each fix round its own commit". Failed fix commits had no state, and re-packaging a round made duplicate commits.
- Answer: While the build commit is missing, fix checkpoints skip with `build_not_committed` and the round uses snapshots. The late build commit lists the rounds it includes. A failed fix commit's changes go into the next code commit, whose body notes them. A re-packaged round commits only new changes, as "(continued)".
- Outcome: decided

### C6 — major — conflict with recorded decision (unattended runs)
- Challenge: `--no-verify` still runs `prepare-commit-msg` and `post-commit`, and unattended sessions could run rollup or review commands that make code commits with hooks.
- Answer: Planning and catch-up commits disable every hook through an empty `core.hooksPath`. Weave-launched sessions set `WEAVE_UNATTENDED=1`, and code checkpoints refuse under it. Handoff sub-agents have no marker; no supported phase runs those commands, so this is recorded as an accepted residual risk.
- Outcome: decided

### C7 — major — contradiction with code (compatibility)
- Challenge: Rollup whitelists slice `status.yml` keys, so an older Weave would erase `commits.build`.
- Answer: This is moot. No new slice keys are added; build state is in git trailers. The schema's compatibility claim is corrected.
- Outcome: decided

### C8 — major — uncovered scenario (sweep scope)
- Challenge: Code commits swept other changes' folders and coding guidelines. Planning commits staged all of `wiki/decisions` and `wiki/knowledge`. The ownership table didn't match the stress test's write order or decisions accepted after the verdict.
- Answer:
  - Code commits exclude other changes' `wiki/changes/<id>/` folders and `.weave/coding-guidelines*.md`.
  - The planning scope is this change's folder, its own and superseded decision files plus `index.md`, and its listed knowledge files.
  - Progress of lane L owns changed `sessions/*-<L>*.md`; a verdict owns its session note and the change's decision files.
  - Decisions accepted after the verdict fall into the next catch-up.
- Outcome: decided

### C9 — major — failure and performance (long hooks)
- Challenge: Code commits had no timeout inside bookkeeping commands, risking agent tool timeouts, held `index.lock`, and undefined kill behaviour.
- Answer:
  - `commits.code_timeout_seconds` (default 300); planning and catch-up commits get 60 s.
  - Timeouts send SIGTERM so git releases its lock.
  - Rollup is idempotent through coverage, so an interrupted run is safe to repeat.
  - Lock contention gives `index_locked`, which the catch-up recovers.
- Outcome: decided

### C10 — major — gap against FR25 and boundary observability
- Challenge: Project message rules couldn't reach code commits, so commitlint-style hooks would reject every build and force snapshot fallbacks. The boundary kind wasn't reported.
- Answer:
  - `commits.subject_template` accepts a per-kind map with `{subject}`, `{stage}`, `{slice}` and `{change}` placeholders.
  - Bodies wrap at 72 columns, and trailers are footer-compatible.
  - Content rules are honoured where the text is written: artifacts and `--summary`.
  - Packages and review status report `boundary: commit|snapshot` with the fallback reason.
- Outcome: decided

### C11 — major — missing controls and visibility
- Challenge: Silent-output rules hid the notice, and an unattended run could consume it. The project switch was read from the change branch. There was no command for the switches, the personal layout didn't match existing settings, and bad settings files were unhandled.
- Answer:
  - The shared silent-output block surfaces the `commits_enabled` notice and checkpoint failures.
  - The notice is marked delivered only by an attended command, and handoff briefs relay it.
  - `enabled: false` in either the main checkout's or the change folder's `workspace.yml` wins.
  - `weave settings commits on|off [--project]` sets the personal switch, using the `commits: {default, projects}` layout.
  - An unreadable settings file means no preference, plus a `settings_unreadable` warning.
- Outcome: decided

### C12 — minor — weak claims in 261111-kx9x
- Challenge: The cross-machine claim was unsupported, and a lazily computed merge-base drifts after merges.
- Answer: The cross-machine claim is removed. Start boundaries stay snapshots. Build and fix commits carry a `Weave-Merge-Base` trailer written at creation, which `read()` parses.
- Outcome: decided

Smaller items folded in:
- A repo id with no git checkout gives `skipped: not_a_git_repo`.
- `261111-htho`'s `applies_to` is narrowed, with the settings readers added.
- `261111-7orw` gains a commit-related reconsider trigger.

## Verdict

holds-with-changes — the shared checkpoint module and the commit-backed review boundaries stand. Build state moved into git trailers, catch-up index semantics, hook disabling, unattended refusal, sweep exclusions, timeouts, message templates and switch reading were tightened.

## Next Resume Point

Run `weave-slices` to break the architecture into vertical slices.
