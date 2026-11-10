import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { type AgentName, listDefaultSkills, loadAgentsManifest } from "./agent-skills.js";
import { readAttention } from "./change-attention.js";
import { pathExists } from "./files.js";
import { mainWorktreePath } from "./git.js";
import { localStateDir } from "./local-state.js";
import { gatherNotices, type Notice } from "./notices.js";
import { getNpmVersionInfo } from "./npm-version.js";
import { findWorkspaceMode } from "./workspace-mode.js";
import { readWorkspaceMetadata } from "./workspace-repos.js";
import { shortChangeReviewLine, type ChangeStatusReviewView } from "./review/summary.js";

const agentOrder: AgentName[] = ["claude", "codex", "cursor", "opencode"];

export interface StatusSkillRow {
  agent: AgentName;
  name: string;
  installed_from: string | null;
  current: string;
  state: "current" | "outdated" | "modified" | "missing";
}

// The last worked-out count of changes needing attention (landed, or folder missing).
export interface ChangesAttention {
  total: number;
  counts: Record<string, number>;
  computed_at: string;
}

export interface StatusResult {
  status: "ok";
  packageVersion: string;
  cwd: string;
  inRepo: boolean;
  skills: StatusSkillRow[];
  // null when nothing has been worked out yet, or the repo doesn't use change folders.
  changes_attention: ChangesAttention | null;
  // The code-review summary of the change the current folder resolves; null outside a change,
  // or when there is no review data to show.
  review: StatusReview | null;
  notices: Notice[];
  message: string;
}

export type StatusReview = { change: string } & ChangeStatusReviewView;

export interface BuildStatusOptions {
  cwd: string;
  packageVersion?: string;
  npmLatest?: string | null;
  templatesDir?: string;
  env?: NodeJS.ProcessEnv;
}

export async function buildStatus(options: BuildStatusOptions): Promise<StatusResult> {
  const packageVersion = options.packageVersion ?? (await readPackageVersion());
  const inRepo = await pathExists(join(options.cwd, ".weave", "agents.yml"));
  const skills = inRepo ? await collectSkillRows(options) : [];
  const changesAttention = await readChangesAttention(options.cwd);
  const review = await readActiveChangeReview(options.cwd);
  const npmLatest =
    options.npmLatest === undefined
      ? (await getNpmVersionInfo({ packageVersion, env: options.env })).cachedLatest
      : options.npmLatest;
  const notices = await gatherNotices({
    cwd: options.cwd,
    packageVersion,
    npmLatest: npmLatest ?? null,
    templatesDir: options.templatesDir,
    env: options.env,
  });

  return {
    status: "ok",
    packageVersion,
    cwd: options.cwd,
    inRepo,
    skills,
    changes_attention: changesAttention,
    review,
    notices,
    message: renderStatusMessage({
      packageVersion,
      cwd: options.cwd,
      inRepo,
      skills,
      changesAttention,
      review,
      notices,
      npmLatest: npmLatest ?? null,
    }),
  };
}

// Reads the snapshot `weave change list` leaves behind. `weave status` never fetches or
// runs the landed check itself, so this may briefly lag behind the list.
export async function readChangesAttention(cwd: string): Promise<ChangesAttention | null> {
  try {
    const found = await findWorkspaceMode(cwd);
    if (!found) return null;
    const metadata = await readWorkspaceMetadata(found.workspacePath);
    if (metadata?.checkout !== "worktree") return null;
    const mainRoot = (await mainWorktreePath(found.workspacePath)) ?? found.workspacePath;
    const snapshot = await readAttention(await localStateDir(mainRoot));
    return snapshot ? { total: snapshot.total, counts: snapshot.counts, computed_at: snapshot.computed_at } : null;
  } catch {
    return null;
  }
}

// The review summary of the change the current folder resolves. Never throws: anything that
// goes wrong resolving the change gives null, and unreadable review data gives `unreadable`.
export async function readActiveChangeReview(cwd: string): Promise<StatusReview | null> {
  try {
    const { activeChangeContext } = await import("./changes.js");
    const { reviewContextFromActive } = await import("./review/state.js");
    const { changeStatusReview } = await import("./review/summary.js");
    const ctx = reviewContextFromActive(await activeChangeContext({ cwd }));
    const review = await changeStatusReview(ctx);
    return review ? { change: ctx.changeId, ...review } : null;
  } catch {
    return null;
  }
}

const attentionNames: Array<[string, string]> = [
  ["landed", "landed"],
  ["folder_missing", "folder missing"],
];

export function attentionLine(attention: ChangesAttention | null): string | undefined {
  if (!attention || attention.total <= 0) return undefined;
  const parts = attentionNames.filter(([id]) => (attention.counts[id] ?? 0) > 0).map(([id, name]) => `${attention.counts[id]} ${name}`);
  const subject = attention.total === 1 ? "1 change needs" : `${attention.total} changes need`;
  return `${subject} attention (${parts.join(", ")}). Run 'weave change list'.`;
}

export async function collectSkillRows(options: BuildStatusOptions): Promise<StatusSkillRow[]> {
  const manifest = await loadAgentsManifest(options.cwd);
  const templates = await listDefaultSkills({ templatesDir: options.templatesDir }).catch(() => []);
  const templatesByName = new Map(templates.map((skill) => [skill.name, skill]));

  const rows: StatusSkillRow[] = [];

  for (const agent of agentOrder) {
    const buckets = manifest.installed[agent];
    if (!buckets) continue;
    const skills = buckets.skills ?? {};
    for (const [name, entry] of Object.entries(skills)) {
      const template = templatesByName.get(name);
      const current = template?.lastChangedIn ?? "unknown";
      const absolutePath = join(options.cwd, entry.path);
      const fileExists = await pathExists(absolutePath);

      let state: StatusSkillRow["state"] = "current";
      if (!fileExists) {
        state = "missing";
      } else {
        const diskContent = await readFile(absolutePath, "utf8").catch(() => "");
        const diskHash = `sha256:${createHash("sha256").update(diskContent).digest("hex")}`;
        if (diskHash !== entry.installed_hash) {
          state = "modified";
        } else if (template && entry.installed_from !== template.lastChangedIn) {
          state = "outdated";
        }
      }

      rows.push({
        agent,
        name,
        installed_from: entry.installed_from,
        current,
        state,
      });
    }
  }

  return rows;
}

function renderStatusMessage(opts: {
  packageVersion: string;
  cwd: string;
  inRepo: boolean;
  skills: StatusSkillRow[];
  changesAttention: ChangesAttention | null;
  review: StatusReview | null;
  notices: Notice[];
  npmLatest: string | null;
}): string {
  const lines: string[] = [];
  lines.push(`weave-it ${opts.packageVersion}`);
  lines.push(`cwd: ${opts.cwd}`);
  if (opts.npmLatest) {
    lines.push(`npm latest (cached): ${opts.npmLatest}`);
  } else {
    lines.push(`npm latest (cached): unknown`);
  }

  if (!opts.inRepo) {
    lines.push("");
    lines.push("Not inside a Weave-managed repo (no .weave/agents.yml).");
  } else if (opts.skills.length === 0) {
    lines.push("");
    lines.push("No skills installed.");
  } else {
    lines.push("");
    lines.push("Installed skills:");
    const header = ["agent", "skill", "state", "installed_from", "current"];
    const rows = opts.skills.map((row) => [
      row.agent,
      row.name,
      row.state,
      row.installed_from ?? "unknown",
      row.current,
    ]);
    const widths = header.map((cell, index) =>
      Math.max(cell.length, ...rows.map((row) => row[index].length)),
    );
    const renderRow = (cells: string[]) =>
      cells.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd();
    lines.push(renderRow(header));
    lines.push(widths.map((width) => "-".repeat(width)).join("  ").trimEnd());
    for (const row of rows) {
      lines.push(renderRow(row));
    }
  }

  const attention = attentionLine(opts.changesAttention);
  if (attention) {
    lines.push("");
    lines.push(attention);
  }

  if (opts.review) {
    lines.push("");
    lines.push(`Review (${opts.review.change}): ${shortChangeReviewLine(opts.review)}`);
  }

  lines.push("");
  if (opts.notices.length === 0) {
    lines.push("Notices: none.");
  } else {
    lines.push(`Notices (${opts.notices.length}):`);
    for (const notice of opts.notices) {
      lines.push(`- [${notice.kind}] ${notice.message}`);
    }
  }

  return lines.join("\n");
}

async function readPackageVersion(): Promise<string> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  let current = moduleDir;
  while (true) {
    const candidate = join(current, "package.json");
    if (await pathExists(candidate)) {
      try {
        const parsed = JSON.parse(await readFile(candidate, "utf8")) as { version?: string };
        if (typeof parsed?.version === "string") {
          return parsed.version;
        }
      } catch {
        // ignore malformed package.json and keep walking up
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return "0.0.0";
}
