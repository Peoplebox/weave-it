import { describe, expect, it } from "vitest";
import {
  attentionCounts,
  deriveState,
  nextLine,
  squashNeedsNewGit,
  stateLine,
  type ChangeFacts,
  type RepoFacts,
  type RepoLandedFact,
} from "../src/lib/change-states.js";

const id = "261107-a1b2-login";
const close = `weave change close ${id}`;
const switchCmd = `weave change switch ${id}`;

function landed(result: RepoLandedFact["result"], extra: Partial<RepoLandedFact> = {}): RepoLandedFact {
  return {
    result,
    method: result === "landed" || result === "landed_with_newer_commits" ? "merged" : null,
    reason: result === "unchecked" ? "git exploded" : null,
    targetBranch: "main",
    targetRef: "refs/remotes/origin/main",
    targetSha: "abc",
    defaultBranch: "main",
    fellBack: false,
    localViewOlder: false,
    ...extra,
  };
}

function repo(extra: Partial<RepoFacts> = {}): RepoFacts {
  return {
    id: "root",
    path: ".",
    hasFolderRecord: true,
    folderExists: true,
    locked: false,
    uncommitted: 0,
    hasTip: true,
    landed: landed("not_landed"),
    baseKnown: true,
    baseSource: "created",
    ...extra,
  };
}

function facts(extra: Partial<ChangeFacts> = {}, repos: RepoFacts[] = [repo()]): ChangeFacts {
  return {
    id,
    folder: "/x/acme.changes/261107-a1b2-login",
    hasFolderRecord: true,
    folderExists: true,
    slot: 1,
    unavailable: false,
    changesRoot: "/x/acme.changes",
    branchExists: true,
    statusOnBranch: true,
    planningOnMain: false,
    repos,
    ...extra,
  };
}

const missing = { folderExists: false } as const;

describe("deriveState: one state per change", () => {
  const table: Array<[string, ChangeFacts, string, string, string[], string | undefined, boolean]> = [
    ["in progress", facts(), "in_progress", "in progress", [], undefined, false],
    ["landed", facts({}, [repo({ landed: landed("landed") })]), "landed", "landed in main (merged)", [close], undefined, true],
    [
      "landed in a stacked parent",
      facts({}, [repo({ landed: landed("landed", { method: "squashed", targetBranch: "change/parent" }) })]),
      "landed",
      "landed in change/parent (squashed), not in main yet",
      [close],
      undefined,
      true,
    ],
    [
      "landed, contained",
      facts({}, [repo({ landed: landed("landed", { method: "contained" }) })]),
      "landed",
      "nothing left to merge: every commit is already in main",
      [close],
      undefined,
      true,
    ],
    [
      "landed with newer commits",
      facts({}, [repo({ landed: landed("landed_with_newer_commits", { method: "squashed" }) })]),
      "landed_with_newer_commits",
      "landed in main (squashed), with newer commits",
      [],
      "review the newer commits before closing",
      false,
    ],
    [
      "folder missing with committed work",
      facts(missing, [repo(missing)]),
      "folder_missing",
      "folder missing: not found at /x/acme.changes/261107-a1b2-login",
      [close, switchCmd],
      undefined,
      true,
    ],
    [
      "folder missing, kept on purpose",
      facts(missing, [repo({ ...missing, locked: true })]),
      "folder_missing_kept",
      "folder missing (kept on purpose)",
      [],
      "unlock with: git worktree unlock /x/acme.changes/261107-a1b2-login",
      false,
    ],
    [
      "folder unavailable",
      facts({ ...missing, unavailable: true }, [repo(missing)]),
      "folder_unavailable",
      "change folders unavailable",
      [],
      "reconnect /x/acme.changes",
      false,
    ],
    [
      "closed, not landed, status on branch",
      facts({ hasFolderRecord: false, folderExists: false }, [repo({ hasFolderRecord: false, folderExists: false })]),
      "closed_not_landed",
      "closed, work not in main",
      [switchCmd],
      undefined,
      false,
    ],
    [
      "closed, not landed, nothing committed",
      facts({ hasFolderRecord: false, folderExists: false, statusOnBranch: false }, [repo({ hasFolderRecord: false, folderExists: false })]),
      "closed_not_landed",
      "closed, work not in main",
      [],
      `recover the work with: git worktree add <path> change/${id}`,
      false,
    ],
    [
      "closed, couldn't check",
      facts({ hasFolderRecord: false, folderExists: false }, [repo({ hasFolderRecord: false, folderExists: false, landed: landed("unchecked") })]),
      "closed_unchecked",
      "closed, couldn't check whether it landed",
      [switchCmd],
      undefined,
      false,
    ],
    [
      "closed and landed is done",
      facts({ hasFolderRecord: false, folderExists: false }, [repo({ hasFolderRecord: false, folderExists: false, landed: landed("landed") })]),
      "done",
      "done",
      [],
      undefined,
      false,
    ],
    [
      "closed with no commits is done",
      facts({ hasFolderRecord: false, folderExists: false }, [repo({ hasFolderRecord: false, folderExists: false, landed: landed("no_commits") })]),
      "done",
      "done",
      [],
      undefined,
      false,
    ],
    [
      "planning files on main without a branch",
      facts({ hasFolderRecord: false, folderExists: false, branchExists: false, planningOnMain: true }, []),
      "done",
      "done",
      [],
      undefined,
      false,
    ],
  ];

  it.each(table)("%s", (_name, input, stateId, label, commands, text, attention) => {
    const view = deriveState(input);
    expect(view.state.id).toBe(stateId);
    expect(view.state.label).toBe(label);
    expect(view.state.next.commands).toEqual(commands);
    expect(view.state.next.text).toBe(text);
    expect(view.state.needs_attention).toBe(attention);
  });
});

describe("deriveState: precedence and notes", () => {
  it("puts folder missing ahead of landed, notes it, and drops switch", () => {
    const view = deriveState(facts(missing, [repo({ ...missing, landed: landed("landed") })]));
    expect(view.state).toMatchObject({ id: "folder_missing", note: "work already landed in main", next: { commands: [close] } });
    expect(stateLine(view, facts(missing, [repo({ ...missing, landed: landed("landed") })]))).toBe(
      "folder missing: not found at /x/acme.changes/261107-a1b2-login (work already landed in main)",
    );
  });

  it("offers only close for a missing folder whose planning files were never committed", () => {
    const view = deriveState(facts({ ...missing, statusOnBranch: false }, [repo(missing)]));
    expect(view.state).toMatchObject({
      id: "folder_missing",
      note: "nothing was committed, so its planning files can't be recovered",
      next: { commands: [close] },
    });
    expect(view.missing_folder).toBe("/x/acme.changes/261107-a1b2-login");
  });

  it("keeps showing folder missing after git pruned its own record", () => {
    // Weave's record remains, so the repo still has a folder record.
    const view = deriveState(facts(missing, [repo({ ...missing, hasFolderRecord: true })]));
    expect(view.state.id).toBe("folder_missing");
  });
});

describe("deriveState: multi-repo", () => {
  it("is decided by the least-finished repo with commits", () => {
    const repos = [repo({ landed: landed("landed") }), repo({ id: "api", path: "api", landed: landed("not_landed") })];
    const input = facts({}, repos);
    const view = deriveState(input);
    expect(view.state.id).toBe("in_progress");
    expect(stateLine(view, input)).toBe("in progress — root: landed in main (merged) · api: in progress");
  });

  it("is landed with newer commits when one repo is and the rest landed", () => {
    const repos = [repo({ landed: landed("landed") }), repo({ id: "api", path: "api", landed: landed("landed_with_newer_commits") })];
    expect(deriveState(facts({}, repos)).state.id).toBe("landed_with_newer_commits");
  });

  it("ignores a repo with no commits", () => {
    const repos = [repo({ landed: landed("landed") }), repo({ id: "web", path: "web", landed: landed("no_commits") })];
    expect(deriveState(facts({}, repos)).state.id).toBe("landed");
  });

  it("is folder missing when one repo's folder is missing", () => {
    const repos = [repo(), repo({ id: "api", path: "api", ...missing })];
    const input = facts({}, repos);
    const view = deriveState(input);
    expect(view.state.id).toBe("folder_missing");
    expect(stateLine(view, input)).toContain("api: folder missing");
  });
});

describe("deriveState: labels", () => {
  it("labels uncommitted files only on landed states and adapts next", () => {
    const view = deriveState(facts({}, [repo({ landed: landed("landed"), uncommitted: 2 })]));
    expect(view.labels).toEqual([{ id: "uncommitted_files", count: 2, text: "2 uncommitted files in folder" }]);
    expect(view.state.next).toEqual({ commands: [], text: `commit or discard the 2 uncommitted files, then ${close}` });
    expect(nextLine(view)).toBe(`next: commit or discard the 2 uncommitted files, then ${close}`);

    expect(deriveState(facts({}, [repo({ uncommitted: 2 })])).labels).toEqual([]);
  });

  it("labels a change with no commits yet", () => {
    const view = deriveState(facts({}, [repo({ landed: landed("no_commits") })]));
    expect(view.state.id).toBe("in_progress");
    expect(view.labels.map((label) => label.id)).toEqual(["no_commits_yet"]);
  });

  it("labels a check that couldn't run, with its reason, and a separate JSON field", () => {
    const view = deriveState(facts({}, [repo({ landed: landed("unchecked") })]));
    expect(view.labels).toEqual([{ id: "couldnt_check", text: "couldn't check whether this landed: git exploded" }]);
    expect(view.landed_check).toEqual({ status: "unchecked", reason: "git exploded" });
  });

  it("leaves the old-git reason to a single list-level line", () => {
    const view = deriveState(facts({}, [repo({ landed: landed("unchecked", { reason: squashNeedsNewGit }) })]));
    expect(view.labels).toEqual([]);
    expect(view.landed_check).toEqual({ status: "unchecked", reason: squashNeedsNewGit });
  });

  it("labels an unknown starting branch only when the fallback was used for it", () => {
    const unknown = deriveState(facts({}, [repo({ baseKnown: false, baseSource: "unknown", landed: landed("not_landed", { fellBack: true }) })]));
    expect(unknown.labels.map((label) => label.id)).toEqual(["starting_branch_unknown"]);
    const gone = deriveState(facts({}, [repo({ landed: landed("not_landed", { fellBack: true }) })]));
    expect(gone.labels).toEqual([]);
  });

  it("labels may-have-landed and a newer remote view", () => {
    expect(deriveState(facts({}, [repo({ mayHaveLanded: true })])).labels.map((label) => label.id)).toEqual(["may_have_landed"]);
    const newer = deriveState(facts({}, [repo({ landed: landed("landed", { localViewOlder: true }) })]));
    expect(newer.labels.map((label) => label.id)).toEqual(["local_view_older"]);
  });
});

describe("attentionCounts", () => {
  it("counts only landed and folder missing", () => {
    const views = [
      deriveState(facts({}, [repo({ landed: landed("landed") })])),
      deriveState(facts(missing, [repo(missing)])),
      deriveState(facts(missing, [repo({ ...missing, locked: true })])),
      deriveState(facts({}, [repo({ landed: landed("landed_with_newer_commits") })])),
      deriveState(facts()),
    ];
    expect(attentionCounts(views)).toEqual({ total: 2, counts: { landed: 1, folder_missing: 1 } });
  });
});
