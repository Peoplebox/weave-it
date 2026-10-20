---
name: weave-stress-test
description: Stress-test a written Weave shape before building on it. An independent weave-challenger sub-agent attacks the product shape in exploration.md or the architecture shape using only that artifact, research.md, and the knowledge wiki, then this skill interviews the user on the weak points one at a time, writes the answers into the shape, and records a verdict (holds, holds-with-changes, needs-reshaping). Use after weave-explore or weave-architect, before weave-prd or weave-slices, ideally in a fresh session, or when the user asks to poke holes in, grill, or sanity-check a plan. Not for brainstorming (use weave-explore).
license: MIT
compatibility: Requires the weave CLI (npm package @weave-tools/weave-it) on PATH, run inside a git repo or workspace initialised with weave init. Uses the read-only weave-challenger sub-agent when the agent supports sub-agents (installed for Claude Code by weave agent install).
metadata:
  author: weave-tools
  last_changed_in: "0.1.13"
---

# Purpose

Find the weak points in a shape while they are still cheap to fix. The brainstorm that produced the shape was collaborative; this step is deliberately skeptical.

Two things keep it honest:

- **The critic is independent.** The `weave-challenger` sub-agent did not help build the shape, so it has no reason to defend it.
- **Only what is written counts.** The challenger reads the shape, `research.md`, and the knowledge wiki, never the brainstorm conversation. `weave-prd`, `weave-slices`, and the people implementing the change will only see what is written too, so anything agreed only in conversation is a real gap. When the user says "we covered that", write it into the shape.

# Pick the Lane

The lane is the first argument: `exploration` (product shape) or `architecture` (technical shape).

If no lane is given, read `weave change status --json` and pick the lane whose shape exists and whose stress test is missing or outdated. If both qualify, ask which one.

| Lane | Shape | Lens | Language |
| --- | --- | --- | --- |
| `exploration` | `exploration.md` | product | users, workflows, scenarios; no code, schemas, or APIs |
| `architecture` | `architecture/index.md` and facet files, or legacy `architecture.md` | engineering | contracts, data, migrations, failure modes, testing |

# Resolve Context

```bash
weave workspace --json
weave change current --json
weave change status --json
```

If there is no active change, stop and say:

```text
No active Weave change found. Run `weave change new` or `weave change switch`, then run `weave-stress-test` again.
```

In workspace mode, `workspace.path` is the only artifact root. Registered `repos[]` are places to look, not separate artifact targets.

If the shape is missing or only scaffolding, stop and say which skill writes it: `weave-explore` for `exploration`, `weave-architect` for `architecture`.

# What to Read

Read only:

- the shape for the lane
- `wiki/changes/<change-id>/research.md`, if it exists
- relevant `wiki/knowledge/` pages
- `wiki/changes/<change-id>/status.yml`
- earlier stress test notes for this lane (`sessions/*-<lane>-stress-test.md`), for decisions already settled

Do not read the brainstorm session notes (`sessions/*-exploration.md`, `sessions/*-architecture.md`), tickets, or other lanes' artifacts. If they are already in this conversation's context, run the stress test in a fresh session instead, or at minimum do not let them answer challenges on the user's behalf.

# Get the Challenges

When the `weave-challenger` sub-agent is available, run it with:

- the lens (`product` or `engineering`)
- the shape path(s)
- the `research.md` path and the knowledge pages you found
- decisions settled by earlier stress tests, if any

If sub-agents are not available in this agent, produce the challenges yourself using the same rules: read only the files above, look for contradictions with research, missing people, uncovered scenarios, inner conflicts, unsupported assumptions, and blocking gaps, and rank them `blocking`, `major`, or `minor`.

Read the challenges critically before asking anything. Drop any that the shape already answers, and merge duplicates.

# Interview the User

Open with one short message: how many challenges there are by severity, and the strengths the challenger found so the user knows what is not being reopened. Then take the challenges in order, blocking first, one per message:

- one line of context: what the shape says and why it is a problem, citing the evidence
- the question
- a suggested answer only when you have a well-founded one, labelled as a suggestion

For each answer, settle it as one of:

- **decided**: the answer becomes a decision in the shape
- **deferred**: it becomes an open question in the shape, marked whether it blocks the next lane
- **out of scope**: record it as a non-goal or exclusion
- **breaks the direction**: the answer means the chosen direction no longer works; note it and keep going only if the user wants to

Keep the lens's language throughout. For `exploration`, translate any technical point into behaviour, as `weave-explore` does.

Stop asking when the blocking and major challenges are settled, or after about ten questions, whichever comes first. Then list the remaining minor challenges in one message and let the user accept, defer, or discuss them together. The user can say "enough" at any point.

# Record the Results

Do these in order.

## 1. Write the session note

Create `wiki/changes/<change-id>/sessions/YYYYMMDD-HHMMSS-<4-char-id>-<lane>-stress-test.md` (local timestamp, lowercase alphanumeric id; retry if the name exists):

```md
---
artifact: <lane>
capture_mode: stress-test
captured_at: <YYYY-MM-DDTHH:mm:ss.sssZ>
---

# Stress Test: <Lane> - <YYYY-MM-DD>

## Challenges

### C1 — <severity> — <category>
- Challenge: <one or two sentences>
- Answer: <the user's answer, summarised>
- Outcome: <decided | deferred | out of scope | breaks the direction>

## Verdict

<verdict> — <one sentence why>

## Next Resume Point

<what should happen next>
```

## 2. Update the shape

Merge the outcomes into the shape's existing sections. Do not rewrite the chosen direction.

- decided answers → **Decisions** (with the reason), and new **Scenarios** where a scenario was clarified
- deferred answers → **Open Questions**, marked whether they block the next lane
- confirmed or rejected assumptions → update **Assumptions**
- out-of-scope answers → a non-goal or exclusion note in the relevant section
- for `exploration`, update **PRD Readiness**: `Ready` only if no blocking question remains and the verdict is not `needs-reshaping`
- for `architecture`, use the architecture artifact's own decision, risk, and open-question sections

Keep frontmatter. Keep `exploration.md` in product language.

## 3. Record lane progress

If the shape changed, record progress. `--source` replaces the lane's recorded sources, so pass the sources already listed under `artifacts.<lane>.sources` in `status.yml`, plus `discussion`:

```bash
weave change progress <lane> --source <existing sources> --source discussion --json
```

# Lifecycle Staleness Verification

Before calling `weave change progress`, verify content-sync of every artifact
that would otherwise be marked stale by the default pessimistic propagation.

The `--source` arguments of `weave change progress` declare causal influence,
not strict-DAG dependency. Pessimistic staleness propagation is the safe default,
not the only correct answer. When the clarification this skill just performed is
narrowly contained (a typo fix, a sentence rewording, an open-question
resolution), dependents may already be in content sync; flagging them stale
creates churn the user did not ask for.

Procedure:

1. Identify the set of structural dependents of the lane being progressed. Read
   `wiki/changes/<change-id>/status.yml` and compute which lanes list this
   lane in their `artifacts.<lane>.sources`.
2. For each dependent lane, read both the dependent artifact and the artifact
   just being progressed. Decide whether the change you just made invalidates
   the dependent's content. The judgement is binary per lane: invalidates, or
   does not invalidate.
3. Select the appropriate progress invocation:

   - Every dependent is invalidated (or there are no dependents):
     `weave change progress <lane> --source <list> --json` (default, no new flags)
   - No dependent is invalidated:
     `weave change progress <lane> --source <list> --no-invalidate --json`
   - Some dependents are invalidated, some are not:
     `weave change progress <lane> --source <list> --invalidate=<comma-list> --json`

4. If a previously-stale dependent is now in content sync (because the upstream
   change has been absorbed but the stale flag still lingers from an earlier
   pessimistic propagation), clear it explicitly:

   `weave change clear-stale <lane> --reason "<one-sentence verification>" --json`

   Always pass `--reason` so the audit entry in `stale_history` carries the
   verification rationale. Do not clear flags without reading both artifacts.

5. Never edit `status.yml` by hand to manipulate stale state. Use the CLI.

Failure mode: if you are uncertain whether a dependent is in content sync,
prefer the pessimistic default (omit `--no-invalidate` and `--invalidate`).
The user can always run `weave-clarify <lane>` later. A false-positive stale
flag is recoverable; silently leaving a real downstream artifact mismatched is
not.

## 4. Record the verdict

Record the verdict last, so it is pinned to the shape you just wrote:

```bash
weave change verdict <lane> <verdict> --session <session-note-path> --reason "<one sentence>" --json
```

| Verdict | When |
| --- | --- |
| `holds` | the direction stands and answers only added detail |
| `holds-with-changes` | the direction stands but some decisions or scope changed |
| `needs-reshaping` | an answer broke the direction, or a blocking challenge has no answer the user accepts |

If the previous verdict for this lane was also `needs-reshaping`, say so in the final response and suggest talking the direction through with the people involved rather than another automatic brainstorm and stress test loop.

## Waiving

Feature changes are expected to have a verdict before `weave-prd` (exploration) and `weave-slices` (architecture). If the user explicitly wants to skip the stress test, record that instead of running it:

```bash
weave change verdict <lane> waived --reason "<why it is safe to skip>" --json
```

Never waive on the user's behalf.

# Final Response

Reply with exactly this shape and nothing else:

```text
Stress test for <lane>: <verdict>.

Challenges: <N> (<b> blocking, <m> major, <n> minor) — <d> decided, <f> deferred, <o> out of scope.
Shape updated: <path>
Notes: <session note path>

Next step: <next skill>
```

Choose the next skill from the verdict:

- `holds` or `holds-with-changes` on `exploration` → `weave-prd`
- `holds` or `holds-with-changes` on `architecture` → `weave-slices`
- `needs-reshaping` on `exploration` → `weave-explore`, starting from what broke
- `needs-reshaping` on `architecture` → `weave-architect`, starting from what broke

---

# Silent Weave Command Output

Weave skills run Weave CLI commands silently by default. Use command results
as internal context, not response content.

Do not show raw stdout, JSON payloads, command echoes, lifecycle payloads,
internal state-write confirmations, or verbatim notice text unless the user
explicitly asks for diagnostic output.

Surface only information that changes what the user or agent should do next:
blockers, failures, missing relevant repos, branch or task outcomes,
lifecycle failures, package-outdated notices, relevant outdated or modified
skills, and user-required actions.

Notice handling:

- `package_outdated`: show only when present. Say exactly:
  `A newer Weave version is available. Run \`weave status\` for details, then upgrade Weave when convenient.`
- `skills_outdated`: suppress unrelated skills. If the invoked skill is outdated, say:
  `The installed \`<skill-name>\` skill appears older than the bundled template. Run \`weave status\` for details, then \`weave agent update --all\` when you want to refresh installed skills.`
- `skills_outdated`: if multiple skills used in this workflow are outdated, say:
  `Some installed skills used in this workflow appear older than the bundled templates: \`<skill-a>\`, \`<skill-b>\`. Run \`weave status\` for details, then \`weave agent update --all\` when you want to refresh them.`
- `skills_modified`: suppress unless the invoked skill is modified locally or the user is asking about skill updates. If the invoked skill is modified, say:
  `The installed \`<skill-name>\` skill has local edits, so its behavior may differ from the bundled template. Run \`weave status\` or \`weave agent diff\` if you want to inspect the difference.`
- `skills_modified`: if the user asks to update skills and installed skills have local edits, say:
  `Some installed skills have local edits. \`weave agent update\` may skip or protect them; run \`weave status\` or \`weave agent diff\` before updating.`

Do not say `Notices: ...`, `The command returned notices`, raw
`notices[].message`, full notice JSON, or full skill lists unless the user
asks for diagnostics.
