// Pure derivation of each change's state, labels, and next step from gathered facts.
// No I/O lives here, so every rule can be unit-tested without git.
import type { LandedMethod, LandedResult } from "./landed.js";

export type ChangeStateId =
  | "folder_unavailable"
  | "folder_missing"
  | "folder_missing_kept"
  | "landed_with_newer_commits"
  | "landed"
  | "in_progress"
  | "closed_not_landed"
  | "closed_unchecked"
  | "done";

export type RepoStateId = "missing" | "missing_kept" | "landed_with_newer_commits" | "landed" | "in_progress" | "no_commits";

export type LabelId =
  | "uncommitted_files"
  | "no_commits_yet"
  | "couldnt_check"
  | "may_have_landed"
  | "starting_branch_unknown"
  | "local_view_older";

export type RefreshResult = "ok" | "timeout" | "auth" | "unreachable" | "no_remote" | "error";

export interface RepoLandedFact {
  result: LandedResult;
  method: LandedMethod;
  reason: string | null;
  targetBranch: string | null;
  targetRef: string | null;
  targetSha: string | null;
  defaultBranch: string | null;
  fellBack: boolean;
  localViewOlder: boolean;
}

export interface RepoFacts {
  id: string;
  // Relative to the change folder; "." is the workspace root.
  path: string;
  // Git or Weave still records a folder for this repo.
  hasFolderRecord: boolean;
  folderExists: boolean;
  locked: boolean;
  uncommitted: number;
  hasTip: boolean;
  landed?: RepoLandedFact;
  baseKnown: boolean;
  baseSource: "created" | "reflog" | "unknown";
  // Filled by the background refresh (slice 04); absent until a refresh has run.
  mayHaveLanded?: boolean;
  asOf?: string | null;
  refresh?: RefreshResult | null;
  refreshMessage?: string | null;
}

export interface ChangeFacts {
  id: string;
  // The folder this change was recorded at (existing or not), when it has one.
  folder?: string;
  hasFolderRecord: boolean;
  folderExists: boolean;
  slot?: number;
  // The location of change folders is missing (an unmounted drive, say).
  unavailable: boolean;
  changesRoot?: string;
  branchExists: boolean;
  // The change's status.yml is committed on its branch, so `switch` can rebuild it.
  statusOnBranch: boolean;
  planningOnMain: boolean;
  repos: RepoFacts[];
}

export interface ChangeLabel {
  id: LabelId;
  text: string;
  count?: number;
}

export interface ChangeView {
  id: string;
  state: {
    id: ChangeStateId;
    label: string;
    note?: string;
    next: { commands: string[]; text?: string };
    needs_attention: boolean;
  };
  labels: ChangeLabel[];
  landed_check: { status: "checked" } | { status: "unchecked"; reason: string };
  repos: Array<{
    id: string;
    path: string;
    state: RepoStateId;
    target: { branch: string; ref: string; sha: string } | null;
    method: LandedMethod;
    base_source: "created" | "reflog" | "unknown";
    local_view_older: boolean;
    as_of: string | null;
    refresh: RefreshResult | null;
  }>;
  // A missing folder's recorded location.
  missing_folder?: string;
}

export const squashNeedsNewGit = "git 2.38+ is needed to detect squash merges";
export const stillChecking = "still checking";

const attentionStates = new Set<ChangeStateId>(["landed", "folder_missing"]);

export function repoState(repo: RepoFacts): RepoStateId {
  if (repo.hasFolderRecord && !repo.folderExists) return repo.locked ? "missing_kept" : "missing";
  switch (repo.landed?.result) {
    case "landed":
      return "landed";
    case "landed_with_newer_commits":
      return "landed_with_newer_commits";
    case "no_commits":
      return "no_commits";
    case undefined:
      return repo.hasTip ? "in_progress" : "no_commits";
    default:
      return "in_progress";
  }
}

const progressRank: Record<string, number> = { in_progress: 0, landed_with_newer_commits: 1, landed: 2 };

// The least-finished repo that has commits decides; repos with no commits are ignored.
function decidingRepo(repos: RepoFacts[]): { repo: RepoFacts; state: "in_progress" | "landed_with_newer_commits" | "landed" } | undefined {
  let best: { repo: RepoFacts; state: "in_progress" | "landed_with_newer_commits" | "landed" } | undefined;
  for (const repo of repos) {
    const result = repo.landed?.result;
    const state =
      result === "landed" ? "landed" : result === "landed_with_newer_commits" ? "landed_with_newer_commits" : result === "no_commits" || (!result && !repo.hasTip) ? undefined : "in_progress";
    if (!state) continue;
    if (!best || progressRank[state]! < progressRank[best.state]!) best = { repo, state };
  }
  return best;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function landedLabel(fact: RepoLandedFact | undefined): string {
  const target = fact?.targetBranch ?? "its starting branch";
  if (fact?.method === "contained") return `nothing left to merge: every commit is already in ${target}`;
  const method = fact?.method ? ` (${fact.method})` : "";
  const notDefault = fact?.defaultBranch && fact.targetBranch && fact.targetBranch !== fact.defaultBranch ? `, not in ${fact.defaultBranch} yet` : "";
  return `landed in ${target}${method}${notDefault}`;
}

function repoStateText(state: RepoStateId, repo: RepoFacts): string {
  switch (state) {
    case "missing":
      return "folder missing";
    case "missing_kept":
      return "folder missing (kept on purpose)";
    case "landed":
      return landedLabel(repo.landed);
    case "landed_with_newer_commits":
      return `${landedLabel(repo.landed)}, with newer commits`;
    case "no_commits":
      return "no commits yet";
    case "in_progress":
      return "in progress";
  }
}

export function deriveState(facts: ChangeFacts): ChangeView {
  const close = `weave change close ${facts.id}`;
  const switchCmd = `weave change switch ${facts.id}`;
  const repoStates = facts.repos.map((repo) => ({ repo, state: repoState(repo) }));
  const deciding = decidingRepo(facts.repos);
  const labels: ChangeLabel[] = [];
  let state: ChangeView["state"];

  const recover = `recover the work with: git worktree add <path> change/${facts.id}`;
  const missingRepos = repoStates.filter((item) => item.state === "missing" || item.state === "missing_kept");

  if (facts.hasFolderRecord && !facts.folderExists && facts.unavailable) {
    state = {
      id: "folder_unavailable",
      label: "change folders unavailable",
      next: { commands: [], text: `reconnect ${facts.changesRoot ?? "the change folders"}` },
      needs_attention: false,
    };
  } else if (missingRepos.length > 0 && missingRepos.some((item) => item.state === "missing")) {
    const landedAlready = deciding?.state === "landed";
    let note: string | undefined;
    let commands = [close];
    if (landedAlready) {
      note = `work already landed in ${deciding!.repo.landed?.targetBranch ?? "its starting branch"}`;
    } else if (!facts.statusOnBranch) {
      note = "nothing was committed, so its planning files can't be recovered";
    } else {
      commands = [close, switchCmd];
    }
    state = {
      id: "folder_missing",
      label: `folder missing: not found at ${facts.folder ?? "its recorded path"}`,
      ...(note ? { note } : {}),
      next: { commands },
      needs_attention: true,
    };
  } else if (missingRepos.length > 0) {
    state = {
      id: "folder_missing_kept",
      label: "folder missing (kept on purpose)",
      next: { commands: [], text: `unlock with: git worktree unlock ${facts.folder ?? "<path>"}` },
      needs_attention: false,
    };
  } else if (facts.hasFolderRecord) {
    if (deciding?.state === "landed") {
      const uncommitted = facts.repos.reduce((sum, repo) => sum + repo.uncommitted, 0);
      state = { id: "landed", label: landedLabel(deciding.repo.landed), next: { commands: [close] }, needs_attention: true };
      if (uncommitted > 0) {
        state.next = { commands: [], text: `commit or discard the ${plural(uncommitted, "uncommitted file")}, then ${close}` };
      }
    } else if (deciding?.state === "landed_with_newer_commits") {
      state = {
        id: "landed_with_newer_commits",
        label: `${landedLabel(deciding.repo.landed)}, with newer commits`,
        next: { commands: [], text: "review the newer commits before closing" },
        needs_attention: false,
      };
    } else {
      state = { id: "in_progress", label: "in progress", next: { commands: [] }, needs_attention: false };
    }
  } else if (!facts.branchExists) {
    state = { id: "done", label: "done", next: { commands: [] }, needs_attention: false };
  } else {
    const unchecked = facts.repos.find((repo) => repo.hasTip && repo.landed?.result === "unchecked");
    const reopen = facts.statusOnBranch ? { commands: [switchCmd] } : { commands: [], text: recover };
    if (!deciding || deciding.state === "landed") {
      state = { id: "done", label: "done", next: { commands: [] }, needs_attention: false };
    } else if (unchecked && deciding.repo === unchecked) {
      state = { id: "closed_unchecked", label: "closed, couldn't check whether it landed", next: reopen, needs_attention: false };
    } else {
      const target = deciding.repo.landed?.targetBranch ?? "its starting branch";
      state = {
        id: "closed_not_landed",
        label: `closed, work not in ${target}`,
        ...(deciding.state === "landed_with_newer_commits" ? { note: `earlier commits already landed in ${target}` } : {}),
        next: reopen,
        needs_attention: false,
      };
    }
  }

  // Labels, in a fixed order.
  const isLanded = state.id === "landed" || state.id === "landed_with_newer_commits";
  const uncommitted = facts.repos.reduce((sum, repo) => sum + repo.uncommitted, 0);
  if (isLanded && uncommitted > 0) {
    labels.push({ id: "uncommitted_files", count: uncommitted, text: `${plural(uncommitted, "uncommitted file")} in folder` });
  }
  if (state.id === "in_progress" && !deciding) {
    labels.push({ id: "no_commits_yet", text: "no commits yet" });
  }
  const uncheckedRepo = facts.repos.find((repo) => repo.hasTip && repo.landed?.result === "unchecked");
  if (uncheckedRepo && state.id === "in_progress" && uncheckedRepo.landed?.reason !== squashNeedsNewGit) {
    labels.push({ id: "couldnt_check", text: `couldn't check whether this landed: ${uncheckedRepo.landed?.reason ?? "unknown error"}` });
  }
  if (facts.repos.some((repo) => repo.mayHaveLanded) && (state.id === "in_progress" || state.id === "closed_not_landed")) {
    labels.push({ id: "may_have_landed", text: "branch deleted on origin; it may have landed" });
  }
  if (facts.repos.some((repo) => repo.hasTip && repo.landed?.fellBack && !repo.baseKnown)) {
    labels.push({ id: "starting_branch_unknown", text: "starting branch unknown" });
  }
  if (facts.repos.some((repo) => repo.landed?.localViewOlder && (repo.landed.result === "landed" || repo.landed.result === "landed_with_newer_commits"))) {
    labels.push({ id: "local_view_older", text: "on origin; run git fetch to see it locally" });
  }

  const view: ChangeView = {
    id: facts.id,
    state,
    labels,
    landed_check: uncheckedRepo ? { status: "unchecked", reason: uncheckedRepo.landed?.reason ?? "unknown error" } : { status: "checked" },
    repos: repoStates.map(({ repo, state: repoStateId }) => ({
      id: repo.id,
      path: repo.path,
      state: repoStateId,
      target:
        repo.landed?.targetBranch && repo.landed.targetRef && repo.landed.targetSha
          ? { branch: repo.landed.targetBranch, ref: repo.landed.targetRef, sha: repo.landed.targetSha }
          : null,
      method: repo.landed?.method ?? null,
      base_source: repo.baseSource,
      local_view_older: repo.landed?.localViewOlder ?? false,
      as_of: repo.asOf ?? null,
      refresh: repo.refresh ?? null,
    })),
    ...(facts.hasFolderRecord && !facts.folderExists && facts.folder ? { missing_folder: facts.folder } : {}),
  };
  return view;
}

export function deriveStates(facts: ChangeFacts[]): ChangeView[] {
  return facts.map(deriveState);
}

export function needsAttention(view: ChangeView): boolean {
  return attentionStates.has(view.state.id) && view.state.needs_attention;
}

export function attentionCounts(views: ChangeView[]): { total: number; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  for (const view of views) {
    if (!needsAttention(view)) continue;
    counts[view.state.id] = (counts[view.state.id] ?? 0) + 1;
  }
  return { total: Object.values(counts).reduce((sum, count) => sum + count, 0), counts };
}

// The state line under a change's first line: the state, its labels, and per-repo states
// for multi-repo changes.
export function stateLine(view: ChangeView, facts: ChangeFacts): string {
  const parts = [view.state.label + (view.state.note ? ` (${view.state.note})` : ""), ...view.labels.map((label) => label.text)];
  let line = parts.join(" · ");
  if (facts.repos.length > 1) {
    line += ` — ${facts.repos.map((repo) => `${repo.id}: ${repoStateText(repoState(repo), repo)}`).join(" · ")}`;
  }
  return line;
}

export function nextLine(view: ChangeView): string | undefined {
  if (view.state.next.commands.length > 0) return `next: ${view.state.next.commands.join(" | ")}`;
  if (view.state.next.text) return `next: ${view.state.next.text}`;
  return undefined;
}
