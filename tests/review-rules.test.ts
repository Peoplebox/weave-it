import { describe, expect, it } from "vitest";
import {
  bodyHash,
  decisionHash,
  deriveVerdict,
  effectiveState,
  excludedPathspecs,
  isReadyForReview,
  planAndDocsPaths,
  satisfiesDependents,
  storedSliceStates,
  type StoredSliceState,
  type VerdictInputs,
} from "../src/lib/review/rules.js";

describe("isReadyForReview", () => {
  it("needs every active task done or not_tested", () => {
    expect(isReadyForReview(["done", "not_tested", "invalid"])).toBe(true);
    expect(isReadyForReview(["done"])).toBe(true);
    expect(isReadyForReview(["not_tested"])).toBe(true);
    expect(isReadyForReview(["done", "todo"])).toBe(false);
    expect(isReadyForReview(["done", "in_progress"])).toBe(false);
    expect(isReadyForReview(["done", "blocked"])).toBe(false);
  });

  it("is false without an active task", () => {
    expect(isReadyForReview([])).toBe(false);
    expect(isReadyForReview(["invalid"])).toBe(false);
  });
});

describe("satisfiesDependents", () => {
  const passing: StoredSliceState[] = ["reviewed", "reviewed_with_rulings", "skipped", "predates_review"];

  it("follows rollup's done when review is inactive, whatever the review state", () => {
    for (const reviewState of [undefined, ...storedSliceStates]) {
      expect(satisfiesDependents({ statuses: ["done"], sliceStatus: "done", reviewState }, false)).toBe(true);
      expect(satisfiesDependents({ statuses: ["done", "not_tested"], sliceStatus: "in_progress", reviewState }, false)).toBe(false);
      expect(satisfiesDependents({ statuses: ["todo"], sliceStatus: "pending", reviewState }, false)).toBe(false);
    }
  });

  it("needs readiness and a passing stored state when review is active", () => {
    for (const reviewState of storedSliceStates) {
      const expected = passing.includes(reviewState);
      expect(satisfiesDependents({ statuses: ["done"], sliceStatus: "done", reviewState }, true)).toBe(expected);
      // not_tested tasks still count as ready for review.
      expect(satisfiesDependents({ statuses: ["done", "not_tested"], sliceStatus: "in_progress", reviewState }, true)).toBe(expected);
      // A slice that is not ready never satisfies, even with a passing stored state.
      expect(satisfiesDependents({ statuses: ["done", "todo"], sliceStatus: "in_progress", reviewState }, true)).toBe(false);
    }
  });

  it("does not satisfy dependents without a stored state when review is active", () => {
    expect(satisfiesDependents({ statuses: ["done"], sliceStatus: "done" }, true)).toBe(false);
    expect(satisfiesDependents({ statuses: ["done"], sliceStatus: "done", reviewState: null }, true)).toBe(false);
  });
});

describe("effectiveState", () => {
  it("derives not_reviewed for a ready slice without a review", () => {
    expect(effectiveState(undefined, { readyForReview: true, outOfDateReasons: [] })).toEqual({
      state: "not_reviewed",
      outOfDate: false,
      reasons: [],
    });
    expect(effectiveState({ start_ref: "refs/weave/reviews/c/s/start" } as never, { readyForReview: true, outOfDateReasons: [] }).state).toBe(
      "not_reviewed",
    );
    expect(effectiveState({ state: "bogus" }, { readyForReview: true, outOfDateReasons: [] }).state).toBe("not_reviewed");
  });

  it("derives not_ready_for_review while tasks are still open", () => {
    expect(effectiveState(undefined, { readyForReview: false, outOfDateReasons: [] }).state).toBe("not_ready_for_review");
  });

  it("keeps the stored state under an out-of-date overlay and returns to current without reasons", () => {
    const stored = { state: "reviewed" };
    expect(effectiveState(stored, { readyForReview: true, outOfDateReasons: ["code_changed", "plan_changed"] })).toEqual({
      state: "reviewed",
      outOfDate: true,
      reasons: ["code_changed", "plan_changed"],
    });
    expect(effectiveState({ state: "reviewed_with_rulings" }, { readyForReview: true, outOfDateReasons: ["tasks_added"] })).toMatchObject({
      state: "reviewed_with_rulings",
      outOfDate: true,
    });
    expect(effectiveState(stored, { readyForReview: true, outOfDateReasons: [] })).toEqual({
      state: "reviewed",
      outOfDate: false,
      reasons: [],
    });
  });

  it("returns every other stored state as stored", () => {
    for (const state of storedSliceStates) {
      const result = effectiveState({ state }, { readyForReview: true, outOfDateReasons: [] });
      expect(result).toEqual({ state, outOfDate: false, reasons: [] });
    }
    expect(effectiveState({ state: "predates_review" }, { readyForReview: true, outOfDateReasons: ["code_changed"] }).outOfDate).toBe(false);
  });
});

describe("deriveVerdict", () => {
  const keys: Array<keyof VerdictInputs> = [
    "planProblemsOpen",
    "partial",
    "agreedCriticalRulings",
    "canWaitMinors",
    "disagreedRulings",
    "humanChecks",
    "otherOpen",
  ];
  const blocking = new Set<keyof VerdictInputs>(["planProblemsOpen", "partial", "agreedCriticalRulings", "otherOpen"]);
  const parking = new Set<keyof VerdictInputs>(["canWaitMinors", "disagreedRulings", "humanChecks"]);

  it("covers every combination of its inputs", () => {
    for (let mask = 0; mask < 1 << keys.length; mask += 1) {
      const set = keys.filter((_, index) => (mask >> index) & 1);
      const inputs = Object.fromEntries(keys.map((key) => [key, key === "partial" ? set.includes(key) : set.includes(key) ? 1 : 0])) as unknown as VerdictInputs;
      const expected = set.some((key) => blocking.has(key))
        ? "not_ready"
        : set.some((key) => parking.has(key))
          ? "ready_with_parked_items"
          : "ready_to_merge";
      expect(deriveVerdict(inputs), JSON.stringify(inputs)).toBe(expected);
    }
  });

  it("names the single causes", () => {
    const none: VerdictInputs = {
      planProblemsOpen: 0,
      partial: false,
      agreedCriticalRulings: 0,
      canWaitMinors: 0,
      disagreedRulings: 0,
      humanChecks: 0,
      otherOpen: 0,
    };
    expect(deriveVerdict(none)).toBe("ready_to_merge");
    expect(deriveVerdict({ ...none, agreedCriticalRulings: 1 })).toBe("not_ready");
    expect(deriveVerdict({ ...none, planProblemsOpen: 2 })).toBe("not_ready");
    expect(deriveVerdict({ ...none, partial: true })).toBe("not_ready");
    expect(deriveVerdict({ ...none, canWaitMinors: 3 })).toBe("ready_with_parked_items");
    expect(deriveVerdict({ ...none, disagreedRulings: 1 })).toBe("ready_with_parked_items");
    expect(deriveVerdict({ ...none, humanChecks: 1 })).toBe("ready_with_parked_items");
  });
});

describe("paths and hashing", () => {
  it("excludes the change planning folder relative to the Weave root", () => {
    expect(excludedPathspecs("")).toEqual([":(exclude)wiki/changes/**"]);
    expect(excludedPathspecs(".")).toEqual([":(exclude)wiki/changes/**"]);
    expect(excludedPathspecs("docs/weave/")).toEqual([":(exclude)docs/weave/wiki/changes/**"]);
  });

  it("lists plan and docs paths", () => {
    expect(planAndDocsPaths).toEqual(["wiki/knowledge/**", "wiki/decisions/**", ".weave/coding-guidelines.md"]);
  });

  it("ignores frontmatter-only edits and changes on a body edit", () => {
    const original = "---\nstatus: proposed\n---\n\n# Decision\n\nUse refs.\n";
    const frontmatterEdit = "---\nstatus: accepted\nsuperseded_by: null\n---\n\n# Decision\n\nUse refs.\n";
    const bodyEdit = "---\nstatus: proposed\n---\n\n# Decision\n\nUse commits.\n";
    expect(bodyHash(frontmatterEdit)).toBe(bodyHash(original));
    expect(bodyHash(bodyEdit)).not.toBe(bodyHash(original));
    expect(bodyHash(original)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("hashes a decision's body plus its superseded_by, so superseding it counts and a status edit does not", () => {
    const proposed = "---\nid: 261110-wdfo-x\nstatus: proposed\nsuperseded_by: null\n---\n\n# Decision\n\nUse refs.\n";
    const accepted = proposed.replace("status: proposed", "status: accepted");
    const superseded = proposed.replace("status: proposed", "status: superseded").replace("superseded_by: null", "superseded_by: 261111-abcd-new");
    const otherReplacement = superseded.replace("261111-abcd-new", "261111-efgh-other");
    expect(decisionHash(accepted)).toBe(decisionHash(proposed));
    expect(decisionHash(proposed)).toBe(bodyHash(proposed));
    expect(decisionHash(superseded)).not.toBe(decisionHash(proposed));
    expect(decisionHash(otherReplacement)).not.toBe(decisionHash(superseded));
    expect(decisionHash(proposed.replace("Use refs.", "Use commits."))).not.toBe(decisionHash(proposed));
    expect(decisionHash("# No frontmatter\n")).toBe(bodyHash("# No frontmatter\n"));
  });

  it("hashes documents without frontmatter whole", () => {
    expect(bodyHash("# Plain\n")).not.toBe(bodyHash("# Plain edited\n"));
    expect(bodyHash("---\n---\nbody\n")).toBe(bodyHash("body\n"));
  });
});
