# Planning commits for verdicts, stale clears, knowledge, and review results

## Outcome

Every other status-recording command commits its planning work the same way progress does.

## User flow

1. The stress test records a verdict → commit "Stress test: …".
2. `clear-stale` → commit naming the lane back in line.
3. `weave change knowledge` → commit of the change's knowledge files.
4. `weave review record --finalize|--failed` or a resolution that waits on a person → commit of review records.

## In scope

- Wire `verdictChange`, `clearChangeStaleness`, `knowledgeChange`, `finalizeRun`, `failRun`, and waiting-on-person resolutions to `planningCheckpoint` with their moments.
- `--summary`/`--commit-message` on those commands.

## Out of scope

- Code commits; switches beyond the project switch.

## Acceptance criteria

- [ ] verdict, clear-stale, knowledge, and review record each return `checkpoint` and commit their owned paths.
- [ ] Verdict owns its `--session` note and the change's decision files; knowledge owns `knowledge-delta.md` and listed knowledge files; review owns review records.
- [ ] Command exit codes and existing outputs are unchanged apart from the added field/line.
