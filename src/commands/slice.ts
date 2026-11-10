import { Command } from "commander";
import { activeChangeContext, ChangeCommandError } from "../lib/changes.js";
import { buildCheckpoints } from "../lib/build-checkpoints.js";
import { renderCheckpointLine } from "../lib/checkpoints.js";
import { rollupChange } from "../lib/sliceRollup.js";

interface SliceRollupOptions {
  slice?: string;
  all?: boolean;
  check?: boolean;
  json?: boolean;
}

export function sliceCommand(): Command {
  const command = new Command("slice").description("Manage task-slices for the active change.");

  command
    .command("rollup")
    .description("Re-derive slice status and dependency graph from tasks.md and status.yml.")
    .option("--slice <path>", "rollup a single slice folder or id")
    .option("--all", "rollup every slice (default when no --slice)")
    .option("--check", "dry-run; exit non-zero if derived files would change")
    .option("--json", "print machine-readable JSON")
    .action(async (options: SliceRollupOptions) => {
      await runAction(options.json ?? false, async () => {
        const current = await activeChangeContext({ cwd: process.cwd() });
        const changePath = current.change.changePath;

        const result = await rollupChange({
          changePath,
          slicePath: options.slice,
          check: options.check ?? false,
        });

        // A slice that finished building gets its build commit (decision 261111-htho).
        const checkpoints = options.check
          ? []
          : await buildCheckpoints({
              weaveRoot: current.target.path,
              changeId: current.change.id,
              changePath,
              branch: current.change.branch,
              title: current.change.title,
              rollup: result,
            }).catch(() => []);
        const lines = checkpoints.map((checkpoint) => renderCheckpointLine(checkpoint)).filter((line): line is string => Boolean(line));
        writeResult(
          checkpoints.length > 0 ? { ...result, checkpoints, message: [result.message, ...lines].join("\n") } : result,
          options.json ?? false,
        );
        if (result.status === "check_failed") {
          process.exitCode = 1;
        }
      });
    });

  return command;
}

function writeResult(result: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const message = typeof result === "object" && result && "message" in result ? String((result as { message: string }).message) : String(result);
  process.stdout.write(`${message}\n`);
}

async function runAction(json: boolean, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (json) {
      process.stdout.write(`${JSON.stringify(errorResult(error), null, 2)}\n`);
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  }
}

function errorResult(error: unknown): { status: "error"; code: string; message: string; details?: unknown } {
  if (error instanceof ChangeCommandError) {
    return {
      status: "error",
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  return {
    status: "error",
    code: "unknown_error",
    message: error instanceof Error ? error.message : String(error),
  };
}
