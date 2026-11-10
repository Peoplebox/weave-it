# Switches, notice, and unattended marker

## Outcome

People and teams can turn commits off, the first commit announces itself once to an attended session, and Weave-launched sessions are marked unattended.

## User flow

1. Alex runs `weave settings commits off --project`; Weave stops committing for Alex in this project.
2. A change is skipped with `weave change skip-commits --reason …`.
3. The first attended commit in a project prints the `commits_enabled` notice once.
4. A background research run commits planning work; a failed commit is recorded on the run.

## In scope

- Personal `commits: {default, projects}` in `~/.weave/settings.yml`, `weave settings commits on|off [--project]`, unreadable settings → warning.
- `weave change skip-commits|unskip-commits` (`status.yml commits.skipped`).
- Notice via `.git/weave/checkpoints.json`, delivered only outside `WEAVE_UNATTENDED`.
- `WEAVE_UNATTENDED=1` in Weave-launched sessions; run `checkpoint` on failure.

## Out of scope

- Code commit behaviour under the marker (slice 04 enforces it).

## Acceptance criteria

- [ ] Project off (main or change folder) > personal off (project scope > default) > per-change skip; outcome names the switch.
- [ ] `weave settings commits` writes only personal settings.
- [ ] Notice appears once per project per machine in an attended command.
- [ ] Background/terminal/here launches set `WEAVE_UNATTENDED=1`.
- [ ] A running run whose lane's planning commit failed records `checkpoint` on the run.
