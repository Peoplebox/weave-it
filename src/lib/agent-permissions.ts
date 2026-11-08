import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./files.js";

// What every Weave phase needs without asking: writing its own change files and running
// `weave` plus read-only git. Anything else, such as editing source code or running other
// commands, still asks the person, so a prompt during research means it left its job.
export const claudePhaseAllowRules = [
  "Edit(/wiki/changes/**)",
  "Bash(weave *)",
  "Bash(git log *)",
  "Bash(git show *)",
  "Bash(git diff *)",
  "Bash(git status *)",
  "Bash(git ls-files *)",
];

export interface PermissionResult {
  path: string;
  added: string[];
}

// Adds the phase rules to the project's committed Claude Code settings, keeping every other
// setting and rule as it is. Sub-agents inherit these rules from the session.
export async function ensureClaudePhasePermissions(root: string): Promise<PermissionResult> {
  const settingsPath = path.join(root, ".claude", "settings.json");
  const settings = (await pathExists(settingsPath)) ? (JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>) : {};
  const permissions = isRecord(settings.permissions) ? settings.permissions : {};
  const allow = Array.isArray(permissions.allow) ? permissions.allow.filter((rule): rule is string => typeof rule === "string") : [];
  const added = claudePhaseAllowRules.filter((rule) => !allow.includes(rule));
  if (added.length > 0) {
    settings.permissions = { ...permissions, allow: [...allow, ...added] };
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }
  return { path: path.relative(root, settingsPath), added };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
