# Contracts: Switches, notice, and unattended marker

Slice-level technical contracts for this vertical slice.

## Interfaces

- `weave settings commits on|off [--project] [--json]`.
- `weave change skip-commits --reason <text>`, `weave change unskip-commits`.

## Data

- `~/.weave/settings.yml` `commits.default.enabled`, `commits.projects.<key>.enabled`.
- Change `status.yml` `commits.skipped {reason, at}`; `runs[].checkpoint`.
- `.git/weave/checkpoints.json` `{announced: true}`.
