import { Command } from "commander";
import { addCommand } from "./commands/add.js";
import { adrCommand } from "./commands/adr.js";
import { advanceCommand } from "./commands/advance.js";
import { agentCommand } from "./commands/agent.js";
import { changeCommand } from "./commands/change.js";
import { doctorCommand } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";
import { skillCommand, skillsCommand } from "./commands/skills.js";
import { statusCommand } from "./commands/status.js";
import { sliceCommand } from "./commands/slice.js";
import { taskCommand } from "./commands/task.js";
import { workspaceCommand } from "./commands/workspace.js";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function readPackageVersion(moduleUrl = import.meta.url): string {
  const packageJsonPath = path.join(path.dirname(fileURLToPath(moduleUrl)), "..", "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };

  if (typeof packageJson.version !== "string") {
    throw new Error(`Missing version in ${packageJsonPath}`);
  }

  return packageJson.version;
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("weave")
    .description("Repo-local LLM wiki and temporary multi-folder AI session tooling.")
    .version(readPackageVersion());

  program.addCommand(initCommand());
  program.addCommand(addCommand());
  program.addCommand(workspaceCommand());
  program.addCommand(changeCommand());
  program.addCommand(advanceCommand());
  program.addCommand(adrCommand());
  program.addCommand(doctorCommand());
  program.addCommand(agentCommand());
  program.addCommand(skillsCommand());
  program.addCommand(skillCommand());
  program.addCommand(statusCommand());
  program.addCommand(taskCommand());
  program.addCommand(sliceCommand());

  return program;
}

export function isDirectCliInvocation(
  scriptPath = process.argv[1],
  moduleUrl = import.meta.url,
): boolean {
  if (!scriptPath) {
    return false;
  }

  try {
    return realpathSync(scriptPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isDirectCliInvocation()) {
  await createProgram().parseAsync(process.argv);
}
