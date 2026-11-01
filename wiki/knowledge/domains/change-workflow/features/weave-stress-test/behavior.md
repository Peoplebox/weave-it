# weave-stress-test

## Purpose

Find the weak points in a written shape while they are cheap to fix, using a critic that did not help build it and sees only what was written down.

## Current Behavior

- Lane argument `exploration` (product lens) or `architecture` (engineering lens); without one, picks the lane whose shape exists and whose verdict is missing or outdated.
- Reads only the shape, `research.md`, relevant knowledge, `status.yml`, and earlier `sessions/*-<lane>-stress-test.md` notes. Does not read brainstorm session notes, tickets, or other lanes' artifacts.
- Runs `weave-challenger` (read-only) for up to twelve ranked challenges (`blocking`, `major`, `minor`) with evidence, plus strengths not to reopen. Without sub-agents, produces the challenges itself from the same files.
- Interviews the user one challenge at a time, blocking first; each answer is settled as decided, deferred, out of scope, or breaks the direction. Stops after blocking and major items or about ten questions, then handles minor items as one batch.
- Records, in order: a session note `sessions/YYYYMMDD-HHMMSS-<id>-<lane>-stress-test.md`; answers merged into the shape (decisions, scenarios, assumptions, open questions, readiness); lane progress with the lane's existing sources plus `discussion`; then `weave change verdict <lane> <verdict> --session <note>`.
- Next step: `weave-prd` or `weave-slices` on a passing verdict; back to `weave-explore` or `weave-architect` on `needs-reshaping`.

## Behavioral Rules

- The chosen direction is never rewritten by the stress test; a broken direction becomes `needs-reshaping`.
- Waivers are recorded only on explicit user request with a reason.
- Session note names end in `-<lane>-stress-test.md` so they do not match the `*-<lane>.md` brainstorm session pattern used by `weave-explore`, `weave-architect`, and `weave-capture`.

## Source Anchors

- `templates/skills/weave-stress-test/SKILL.md`
- `templates/agents/weave-challenger.md`
- `src/lib/changes.ts` (`verdictChange`, `parseStressTests`), `src/commands/change.ts` (`verdict`)

## Change History

- 2026-10-20 (branch `change/questions-research-skills`): introduced the skill, the challenger sub-agent, and `weave change verdict`.
- 2026-11-01 (branch `change/questions-research-skills`): accepts proposed decisions on a passing `architecture` verdict; `waived` accepts nothing.
