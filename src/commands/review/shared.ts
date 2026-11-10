// Helpers shared by the `weave review` subcommands: change resolution and the JSON result and
// error shapes used across the CLI (`{status: "error", code, message, details?}`, exit 1).
import { activeChangeContext, ChangeCommandError } from "../../lib/changes.js";
import { reviewContextFromActive, type ReviewContext } from "../../lib/review/state.js";

export async function activeReviewContext(): Promise<ReviewContext> {
  return reviewContextFromActive(await activeChangeContext({ cwd: process.cwd() }));
}

export function writeResult(result: unknown, json: boolean, text: string): void {
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${text}\n`);
}

export async function runAction(json: boolean, action: () => Promise<void>): Promise<void> {
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

export function errorResult(error: unknown): { status: "error"; code: string; message: string; details?: unknown } {
  if (error instanceof ChangeCommandError) {
    return {
      status: "error",
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return {
    status: "error",
    code: "unknown_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

// Human wording for a state value: `reviewed_with_rulings` -> `reviewed with rulings`.
export function stateLabel(state: string): string {
  return state.replace(/_/g, " ");
}
