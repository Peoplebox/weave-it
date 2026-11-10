// `weave review guidelines init [--repo <id>] [--json]`: writes the starter shared coding
// guidelines, or a repo's heading-only file, only when absent (decision 261110-dtld). It works on
// the checkout it runs in and needs no active change.
import { stat } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { ChangeCommandError } from "../../lib/changes.js";
import { guidelinesFileName, writeGuidelinesIfMissing, type GuidelineTarget } from "../../lib/review/guidelines.js";
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

export function registerReviewGuidelines(review: Command): void {
  const guidelines = review.command("guidelines").description("Manage the coding guidelines reviewers apply.");
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
