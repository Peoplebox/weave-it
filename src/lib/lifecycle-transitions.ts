import type { ChangeStage, ChangeType, StressTestLane } from "./changes.js";

// Lifecycle transitions between lanes, and whether `weave advance` may start the next
// phase on its own. A transition with `humanDecision` never auto-advances: the next
// phase (or the gate in between) needs the user's choices, so it is listed only so the
// CLI can explain why it cannot be turned on.
export const lifecycleTransitionIds = [
  "questions_to_research",
  "findings_to_questions",
  "research_to_exploration",
  "research_to_architecture",
  "exploration_to_prd",
  "prd_to_architecture",
  "findings_to_architecture",
  "architecture_to_slices",
] as const;
export type LifecycleTransitionId = (typeof lifecycleTransitionIds)[number];

export interface LifecycleTransition {
  id: LifecycleTransitionId;
  from: ChangeStage;
  to: ChangeStage;
  skill: string;
  humanDecision?: string;
  // Stress test the next skill gates on, for the listed change types.
  requiresVerdict?: { lane: StressTestLane; types: readonly ChangeType[] };
}

export const lifecycleTransitions: readonly LifecycleTransition[] = [
  { id: "questions_to_research", from: "questions", to: "research", skill: "weave-research" },
  { id: "findings_to_questions", from: "findings", to: "questions", skill: "weave-questions" },
  {
    id: "research_to_exploration",
    from: "research",
    to: "exploration",
    skill: "weave-explore",
    humanDecision: "weave-explore needs you to pick a product direction",
  },
  {
    id: "research_to_architecture",
    from: "research",
    to: "architecture",
    skill: "weave-architect",
    humanDecision: "weave-architect needs you to pick a technical approach",
  },
  {
    id: "exploration_to_prd",
    from: "exploration",
    to: "prd",
    skill: "weave-prd",
    humanDecision: "the product shape must be stress-tested with you in weave-stress-test first",
    requiresVerdict: { lane: "exploration", types: ["feat"] },
  },
  {
    id: "prd_to_architecture",
    from: "prd",
    to: "architecture",
    skill: "weave-architect",
    humanDecision: "weave-architect needs you to pick a technical approach",
  },
  {
    id: "findings_to_architecture",
    from: "findings",
    to: "architecture",
    skill: "weave-architect",
    humanDecision: "weave-architect needs you to pick a technical approach",
  },
  {
    id: "architecture_to_slices",
    from: "architecture",
    to: "slices",
    skill: "weave-slices",
    humanDecision: "the architecture shape must be stress-tested with you in weave-stress-test first",
    requiresVerdict: { lane: "architecture", types: ["feat"] },
  },
];

// Transitions a user may turn on. Only these are stored under `auto_advance` in status.yml.
export const autoAdvanceTransitions = lifecycleTransitions.filter((transition) => !transition.humanDecision);
export type AutoAdvanceFlags = Partial<Record<LifecycleTransitionId, boolean>>;

// Flags proposed by `weave change new`. Everything else stays off until the user turns it on.
export const autoAdvanceDefaults: Record<ChangeType, AutoAdvanceFlags> = {
  feat: { questions_to_research: true, findings_to_questions: false },
  fix: { questions_to_research: true, findings_to_questions: false },
  refactor: { questions_to_research: true, findings_to_questions: false },
  docs: { questions_to_research: true, findings_to_questions: false },
  test: { questions_to_research: true, findings_to_questions: false },
  ci: { questions_to_research: true, findings_to_questions: false },
  chore: { questions_to_research: true, findings_to_questions: false },
};

export function isLifecycleTransitionId(value: unknown): value is LifecycleTransitionId {
  return typeof value === "string" && (lifecycleTransitionIds as readonly string[]).includes(value);
}

export function lifecycleTransition(id: LifecycleTransitionId): LifecycleTransition {
  const transition = lifecycleTransitions.find((candidate) => candidate.id === id);
  if (!transition) {
    throw new Error(`Unknown lifecycle transition: ${id}`);
  }
  return transition;
}

export function canAutoAdvance(id: LifecycleTransitionId): boolean {
  return !lifecycleTransition(id).humanDecision;
}

// Every auto-advanceable transition with an explicit on/off value, defaulting to off.
export function normalizeAutoAdvanceFlags(flags: AutoAdvanceFlags): Record<string, boolean> {
  return Object.fromEntries(autoAdvanceTransitions.map((transition) => [transition.id, flags[transition.id] === true]));
}
