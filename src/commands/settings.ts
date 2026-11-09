import { Command } from "commander";
import { ChangeCommandError } from "../lib/change-error.js";
import { canPrompt, currentChoices, defaultMenuPrompt, validateExplicitChoice, type MenuPrompt, type OpenMenuChoice } from "../lib/open-change.js";
import { clearOpenChoice, loadUserSettings, saveOpenChoice, userSettingsPath, type OpenChoice, type SettingsScope } from "../lib/user-settings.js";
import { findWorkspaceMode } from "../lib/workspace-mode.js";
import { mainCheckoutPath } from "../lib/worktrees.js";
import { runAction } from "./change.js";

export interface SettingsOpenOptions {
  in?: string;
  agent?: string;
  clear?: boolean;
  project?: boolean;
  json?: boolean;
}

export interface SettingsOpenResult {
  status: "ok";
  scope: SettingsScope;
  project?: string;
  saved?: OpenChoice;
  cleared?: boolean;
  current: { default?: OpenChoice; project?: OpenChoice };
  choices?: OpenMenuChoice[];
  settings_path: string;
  message: string;
}

export function settingsCommand(): Command {
  const command = new Command("settings").description("Your personal Weave settings (~/.weave/settings.yml). Never shared with the project.");

  command
    .command("open")
    .description("Choose where changes open. With no flags at a terminal, shows the menu. Never opens anything itself.")
    .option("--in <place>", "save this place: herdr, tmux, iterm, terminal, vscode, cursor, claude-desktop, t3code, or none (don't open, don't ask again)")
    .option("--agent <agent>", "terminals only: claude, codex, opencode, cursor-agent, one of your own agents, or shell")
    .option("--clear", "remove the saved choice, so you are asked again next time")
    .option("--project", "apply to this project only, instead of your default for every project")
    .option("--json", "print machine-readable JSON")
    .action(async (options: SettingsOpenOptions) => {
      const json = options.json ?? false;
      await runAction(json, async () => {
        const result = await settingsOpen(options, { interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) });
        process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${result.message}\n`);
      });
    });

  return command;
}

export async function settingsOpen(
  options: SettingsOpenOptions,
  deps: { interactive: boolean; cwd?: string; env?: NodeJS.ProcessEnv; prompt?: MenuPrompt },
): Promise<SettingsOpenResult> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  if (options.clear && options.in) throw new ChangeCommandError("conflicting_flags", "Use either --in or --clear, not both.");
  if (options.agent && !options.in) throw new ChangeCommandError("agent_needs_place", "--agent needs --in <terminal>.");

  const scope: SettingsScope = options.project ? "project" : "default";
  const project = options.project ? await projectKey(cwd) : undefined;
  const where = scope === "project" ? `this project (${project})` : "every project";
  const base = { status: "ok" as const, scope, ...(project ? { project } : {}), settings_path: userSettingsPath(env) };

  if (options.clear) {
    const cleared = await clearOpenChoice(env, scope, project);
    return {
      ...base,
      cleared,
      current: await current(env, cwd),
      message: cleared ? `Cleared where changes open for ${where}. You'll be asked next time.` : `Nothing was saved for ${where}.`,
    };
  }

  if (options.in) {
    const choice: OpenChoice = { place: options.in, ...(options.agent ? { agent: options.agent } : {}) };
    await validateExplicitChoice(choice, { env });
    await saveOpenChoice(env, scope, choice, project);
    return { ...base, saved: choice.place === "none" ? { place: "none", ask: false } : choice, current: await current(env, cwd), message: `Saved for ${where}: ${describe(choice)}.` };
  }

  const choices = await currentChoices({ env });
  const now = await current(env, cwd);
  if (canPrompt({ json: options.json ?? false, interactive: deps.interactive, env })) {
    const answer = await (deps.prompt ?? defaultMenuPrompt)(choices, scope === "project" ? now.project : now.default);
    if (!answer || (answer.place === "none" && !("dontAsk" in answer && answer.dontAsk))) {
      return { ...base, current: now, message: "Nothing changed." };
    }
    const choice: OpenChoice = { place: answer.place, ...("agent" in answer && answer.agent ? { agent: answer.agent } : {}) };
    await saveOpenChoice(env, scope, choice, project);
    return { ...base, saved: choice.place === "none" ? { place: "none", ask: false } : choice, current: await current(env, cwd), message: `Saved for ${where}: ${describe(choice)}.` };
  }

  return {
    ...base,
    current: now,
    choices,
    message: [
      `Default for every project: ${now.default ? describe(now.default) : "not set (you'll be asked)"}`,
      ...(now.project ? [`This project: ${describe(now.project)}`] : []),
      "",
      "Choices on this machine:",
      ...choices.map((choice) => `  ${choice.place}  ${choice.label}${choice.hint ? ` — ${choice.hint}` : ""}${choice.agents ? ` (${choice.agents.map((agent) => agent.id).join(", ")})` : ""}`),
      "",
      "Change it with: weave settings open --in <place> [--agent <agent>] [--project]",
    ].join("\n"),
  };
}

async function projectKey(cwd: string): Promise<string> {
  const found = await findWorkspaceMode(cwd).catch(() => undefined);
  if (!found) throw new ChangeCommandError("no_weave_context", "--project needs a Weave project. Run it from inside one.");
  return mainCheckoutPath(found.workspacePath);
}

async function current(env: NodeJS.ProcessEnv, cwd: string): Promise<{ default?: OpenChoice; project?: OpenChoice }> {
  const settings = (await loadUserSettings(env)).settings;
  const found = await findWorkspaceMode(cwd).catch(() => undefined);
  const key = found ? await mainCheckoutPath(found.workspacePath).catch(() => undefined) : undefined;
  return {
    ...(settings.open?.default ? { default: settings.open.default } : {}),
    ...(key && settings.open?.projects?.[key] ? { project: settings.open.projects[key] } : {}),
  };
}

function describe(choice: OpenChoice): string {
  if (choice.place === "none") return "don't open, don't ask again";
  return choice.agent ? `${choice.place} with ${choice.agent}` : choice.place;
}
