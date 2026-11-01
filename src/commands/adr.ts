import { Command, InvalidArgumentError } from "commander";
import {
  checkDecisions,
  decisionStatuses,
  type DecisionStatus,
  ensureDecisionGuidance,
  isDecisionStatus,
  listDecisions,
  newDecision,
  setDecisionStatus,
} from "../lib/decisions.js";
import { findWorkspaceMode } from "../lib/workspace-mode.js";
import { runAction } from "./change.js";

interface AdrNewOptions {
  slug?: string;
  appliesTo: string[];
  supersedes: string[];
  owner?: string;
  json?: boolean;
}

interface AdrListOptions {
  status?: DecisionStatus;
  path?: string;
  json?: boolean;
}

interface AdrStatusOptions {
  supersededBy?: string;
  json?: boolean;
}

interface AdrCheckOptions {
  base?: string;
  json?: boolean;
}

export function adrCommand(): Command {
  const command = new Command("adr").description("Record and look up long-lived engineering decisions (ADRs).");

  command
    .command("new")
    .description("Create a proposed decision from a title and add it to the index.")
    .argument("<title>", "decision title")
    .option("--slug <slug>", "file name slug override")
    .option("--applies-to <path>", "file, folder, or glob it applies to, relative to the Weave root; repeatable", collectValues, [])
    .option("--supersedes <decision>", "decision this one replaces once accepted; repeatable", collectValues, [])
    .option("--owner <owner>", "decision owner; defaults to git user.name")
    .option("--json", "print machine-readable JSON")
    .action(async (title: string, options: AdrNewOptions) => {
      const json = options.json ?? false;
      await runAction(json, async () => {
        const result = await newDecision({
          cwd: process.cwd(),
          title,
          slug: options.slug,
          appliesTo: options.appliesTo,
          supersedes: options.supersedes,
          owner: options.owner,
        });
        // Repos initialised before ADRs existed pick up the agent guidance on first use.
        const workspace = await findWorkspaceMode(process.cwd());
        if (workspace) {
          await ensureDecisionGuidance(workspace.workspacePath);
        }
        writeResult(result, json);
      });
    });

  command
    .command("list")
    .description("List decisions, newest first.")
    .option("--status <status>", `only this status: ${decisionStatuses.join(", ")}`, parseStatus)
    .option("--path <file>", "only decisions that apply to this file")
    .option("--json", "print machine-readable JSON")
    .action(async (options: AdrListOptions) => {
      const json = options.json ?? false;
      await runAction(json, async () => {
        writeResult(await listDecisions({ cwd: process.cwd(), status: options.status, filePath: options.path }), json);
      });
    });

  command
    .command("status")
    .description("Change a decision's status. Accepting a decision supersedes the decisions it names.")
    .argument("<decision>", "decision id, or a unique part of it")
    .argument("<status>", `new status: ${decisionStatuses.join(", ")}`, parseStatus)
    .option("--superseded-by <decision>", "the replacement, when marking a decision superseded")
    .option("--json", "print machine-readable JSON")
    .action(async (decision: string, status: DecisionStatus, options: AdrStatusOptions) => {
      const json = options.json ?? false;
      await runAction(json, async () => {
        writeResult(
          await setDecisionStatus({ cwd: process.cwd(), decision, status, supersededBy: options.supersededBy }),
          json,
        );
      });
    });

  command
    .command("check")
    .description("List the decisions that apply to files changed on this branch. Reports only; never blocks.")
    .option("--base <ref>", "compare against this ref; defaults to the default branch")
    .option("--json", "print machine-readable JSON")
    .action(async (options: AdrCheckOptions) => {
      const json = options.json ?? false;
      await runAction(json, async () => {
        writeResult(await checkDecisions({ cwd: process.cwd(), base: options.base }), json);
      });
    });

  return command;
}

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseStatus(value: string): DecisionStatus {
  if (isDecisionStatus(value)) {
    return value;
  }
  throw new InvalidArgumentError(`Unsupported status: ${value}. Expected ${decisionStatuses.join(", ")}`);
}

function writeResult(result: { message: string }, json: boolean): void {
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${result.message}\n`);
}
