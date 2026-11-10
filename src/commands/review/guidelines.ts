// `weave review guidelines status [--repo <id>] [--json]`: lists which guidelines files exist, for
// the weave-coding-guidelines skill. `weave review guidelines init [--repo <id>] [--json]`: writes
// the starter shared coding guidelines, or a repo's heading-only file, only when absent (decision
// 261110-dtld). Both work on the checkout they run in and need no active change.
import { stat } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { ChangeCommandError } from "../../lib/changes.js";
import { guidelineRepos, guidelinesFileName, resolveGuidelines, writeGuidelinesIfMissing, type GuidelineTarget } from "../../lib/review/guidelines.js";
import { findWorkspaceMode } from "../../lib/workspace-mode.js";
import { readWorkspaceMetadata } from "../../lib/workspace-repos.js";
import { runAction, writeResult } from "./shared.js";

interface GuidelinesInitOptions {
  repo?: string;
  json?: boolean;
}

export interface GuidelinesInitResult {
  status: "ok";
  // Relative to the checkout root, with `/` separators.
  path: string;
  result: "created" | "unchanged";
}

export interface GuidelinesStatusEntry {
  scope: "shared" | "repo";
  repo?: string;
  // The folder whose code the file covers, relative to the checkout root ("." for the shared file).
  root: string;
  // Relative to the checkout root, with `/` separators.
  path: string;
  status: "present" | "absent";
}

export interface GuidelinesStatusResult {
  status: "ok";
  mode: "repo" | "workspace";
  // Absolute path of the checkout root the paths are relative to.
  checkout_root: string;
  files: GuidelinesStatusEntry[];
  // Registered repos with no checkout here; their files cannot be checked or written.
  missing_repos: string[];
}

export function registerReviewGuidelines(review: Command): void {
  const guidelines = review.command("guidelines").description("Manage the coding guidelines reviewers apply.");
  guidelines
    .command("status")
    .description("List the shared and per-repo coding guidelines files and whether each exists.")
    .option("--repo <id>", "only this repo's file (workspace mode)")
    .option("--json", "print machine-readable JSON")
    .action(async (options: GuidelinesInitOptions) => {
      const json = options.json ?? false;
      await runAction(json, async () => {
        const result = await guidelinesStatus({ cwd: process.cwd(), repo: options.repo });
        writeResult(result, json, renderGuidelinesStatus(result));
      });
    });
  guidelines
    .command("init")
    .description("Write the starter coding guidelines, or an empty repo file with --repo, only when absent.")
    .option("--repo <id>", "write the repo's own guidelines file (workspace mode)")
    .option("--json", "print machine-readable JSON")
    .action(async (options: GuidelinesInitOptions) => {
      const json = options.json ?? false;
      await runAction(json, async () => {
        const result = await initGuidelines({ cwd: process.cwd(), repo: options.repo });
        writeResult(result, json, renderGuidelinesInit(result));
      });
    });
}

export async function initGuidelines(options: { cwd: string; repo?: string }): Promise<GuidelinesInitResult> {
  const workspace = await findWorkspaceMode(options.cwd);
  if (!workspace) {
    throw new ChangeCommandError("no_weave_context", "No Weave context found. Run `weave init` first.");
  }
  const root = workspace.workspacePath;

  let target: GuidelineTarget;
  let relative: string;
  if (options.repo === undefined) {
    target = { path: path.join(root, guidelinesFileName), scope: "shared" };
    relative = guidelinesFileName;
  } else {
    if (workspace.mode === "repo") {
      throw new ChangeCommandError("invalid_arguments", "--repo applies only in workspace mode. A repo-mode project has one guidelines file; run without --repo.");
    }
    const entry = (await readWorkspaceMetadata(root))?.repos[options.repo];
    if (!entry) {
      throw new ChangeCommandError("repo_not_found", `Repo is not registered in the workspace: ${options.repo}`, { repo: options.repo });
    }
    const repoRoot = path.join(root, entry.path);
    if (!(await isDirectory(repoRoot))) {
      throw new ChangeCommandError("repo_missing", `Repo ${options.repo} is not checked out here: ${repoRoot}`, { repo: options.repo, path: entry.path });
    }
    target = { path: path.join(repoRoot, guidelinesFileName), scope: "repo", repo: options.repo };
    relative = path.relative(root, target.path).split(path.sep).join("/");
  }

  return { status: "ok", path: relative, result: await writeGuidelinesIfMissing(target) };
}

// Read-only. Lists the shared file and, in workspace mode, each registered repo's file. It works
// on the checkout it runs in and needs no active change.
export async function guidelinesStatus(options: { cwd: string; repo?: string }): Promise<GuidelinesStatusResult> {
  const workspace = await findWorkspaceMode(options.cwd);
  if (!workspace) {
    throw new ChangeCommandError("no_weave_context", "No Weave context found. Run `weave init` first.");
  }
  const root = workspace.workspacePath;
  const metadata = await readWorkspaceMetadata(root);
  if (options.repo !== undefined) {
    if (workspace.mode === "repo") {
      throw new ChangeCommandError("invalid_arguments", "--repo applies only in workspace mode. A repo-mode project has one guidelines file; run without --repo.");
    }
    if (!metadata?.repos[options.repo]) {
      throw new ChangeCommandError("repo_not_found", `Repo is not registered in the workspace: ${options.repo}`, { repo: options.repo });
    }
  }

  const resolution = await resolveGuidelines({
    checkoutRoot: root,
    mode: workspace.mode,
    repos: guidelineRepos(metadata, options.repo === undefined ? undefined : [options.repo]),
  });
  // A repo registered at the workspace root has no file of its own: the shared file covers it.
  const repoAtRoot = options.repo !== undefined && !resolution.files.some((file) => file.scope === "repo") && resolution.missingRepos.length === 0;
  const files: GuidelinesStatusEntry[] = resolution.files
    .filter((file) => options.repo === undefined || repoAtRoot || file.scope === "repo")
    .map((file) => ({
      scope: file.scope,
      ...(file.repo === undefined ? {} : { repo: file.repo }),
      root: file.scope === "shared" ? "." : path.posix.dirname(path.posix.dirname(file.path)),
      path: file.path,
      status: file.status,
    }));
  return { status: "ok", mode: workspace.mode, checkout_root: root, files, missing_repos: resolution.missingRepos };
}

export function renderGuidelinesStatus(result: GuidelinesStatusResult): string {
  const lines = result.files.map((file) => `${file.status === "present" ? "present" : "missing"}  ${file.path}${file.repo ? ` (${file.repo})` : " (shared)"}`);
  if (lines.length === 0) lines.push("No guidelines file applies here.");
  for (const repo of result.missing_repos) lines.push(`not checked out  ${repo}`);
  if (result.files.some((file) => file.status === "absent")) {
    lines.push("", "Run the weave-coding-guidelines skill in your agent to draft the missing files from your code.");
  }
  return lines.join("\n");
}

export function renderGuidelinesInit(result: GuidelinesInitResult): string {
  return result.result === "created"
    ? `Created ${result.path}. Your team owns it: edit the rules to match how you work.`
    : `Unchanged: ${result.path} already exists, so it was left as it is.`;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}
