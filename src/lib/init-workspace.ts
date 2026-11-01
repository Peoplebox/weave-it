import * as prompts from "@clack/prompts";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { createDirExclusive, isDirectoryEmpty, movePath, pathExists, writeFileIfMissing } from "./files.js";
import { type ResolvedFolder, resolveFolder } from "./folders.js";
import { findGitRoot, getGitRemote, runGitRequired } from "./git.js";
import { slugify, titleFromSlug } from "./ids.js";
import { loadCurrentSession, saveCurrentSession, createCurrentSession, defaultSessionPath } from "./session-state.js";
import { ensureDecisionGuidance } from "./decisions.js";
import { ensureWeaveScaffold } from "./weave-scaffold.js";
import { findWorkspaceMode } from "./workspace-mode.js";
import { registerRepoIntoWorkspace, workspaceGitignoreBaseTemplate } from "./workspace-repos.js";

export type InitStatus = "initialized" | "cancelled" | "already_initialized";
export type InitMode = "repo" | "workspace";

export type InitWorkspaceOptions = {
  cwd?: string;
  folderId?: string;
  folderKind?: string;
  mode?: InitMode | string;
  workspaceName?: string;
  workspacePath?: string;
  yes?: boolean;
  interactive?: boolean;
  now?: Date;
  sessionPath?: string;
};

export type InitWorkspaceResult = {
  status: InitStatus;
  message: string;
  folderPath: string;
  wikiDir: string;
  metadataDir: string;
  sessionPath: string;
  mode?: InitMode;
  commitCreated?: boolean;
  warning?: string;
};

export async function initWorkspace(options: InitWorkspaceOptions = {}): Promise<InitWorkspaceResult> {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const sessionPath = options.sessionPath ?? defaultSessionPath();

  const existingWorkspace = await findWorkspaceMode(cwd);
  if (existingWorkspace) {
    const guidance = await ensureDecisionGuidance(existingWorkspace.workspacePath);
    return {
      status: "already_initialized",
      message: `${alreadyInitializedMessage(existingWorkspace.mode)}${guidance === "unchanged" ? "" : "\nAdded decision guidance to AGENTS.md."}`,
      folderPath: existingWorkspace.workspacePath,
      wikiDir: "",
      metadataDir: "",
      sessionPath,
      mode: existingWorkspace.mode,
    };
  }

  const existingSession = await loadCurrentSession(sessionPath);

  if (existingSession && !(await shouldReplaceSession(options))) {
    return {
      status: "cancelled",
      message: "Cancelled. Existing Weave session was not replaced.",
      folderPath: cwd,
      wikiDir: "",
      metadataDir: "",
      sessionPath,
    };
  }

  const mode = await selectInitMode(options);
  if (mode === "cancelled") {
    return {
      status: "cancelled",
      message: "Cancelled. Weave was not initialized.",
      folderPath: cwd,
      wikiDir: "",
      metadataDir: "",
      sessionPath,
    };
  }

  if (mode === "workspace") {
    return initWorkspaceMode({ ...options, cwd, now, sessionPath });
  }

  return initRepoMode({ ...options, cwd, now, sessionPath });
}

async function initRepoMode(
  options: InitWorkspaceOptions & { cwd: string; now: Date; sessionPath: string },
): Promise<InitWorkspaceResult> {
  const folder = await resolveFolder({
    cwd: options.cwd,
    id: options.folderId,
    kind: options.folderKind,
  });
  const scaffold = await ensureWeaveScaffold({ folder });
  const workspaceMetadata = await writeRepoWorkspaceMetadata(folder);
  if (workspaceMetadata) {
    scaffold.created.push(".weave/workspace.yml");
  }
  if ((await ensureDecisionGuidance(folder.path)) !== "unchanged") {
    scaffold.created.push("AGENTS.md");
  }
  const session = createCurrentSession(folder, options.now);
  await saveCurrentSession(session, options.sessionPath);

  return {
    status: "initialized",
    mode: "repo",
    message: initializedMessage({
      mode: "repo",
      folderId: folder.id,
      folderPath: folder.path,
      created: scaffold.created,
      sessionPath: options.sessionPath,
    }),
    folderPath: folder.path,
    wikiDir: scaffold.wikiDir,
    metadataDir: scaffold.metadataDir,
    sessionPath: options.sessionPath,
  };
}

async function initWorkspaceMode(
  options: InitWorkspaceOptions & { cwd: string; now: Date; sessionPath: string },
): Promise<InitWorkspaceResult> {
  const gitRoot = await findGitRoot(options.cwd);

  if (gitRoot) {
    return initWorkspaceFromGitRepo(options, await realpath(gitRoot));
  }

  return initWorkspaceWithoutGitRepo(options);
}

async function initWorkspaceFromGitRepo(
  options: InitWorkspaceOptions & { cwd: string; now: Date; sessionPath: string },
  gitRoot: string,
): Promise<InitWorkspaceResult> {
  const repoDirectoryName = path.basename(gitRoot);
  const defaultWorkspaceName = `${repoDirectoryName}-workspace`;
  if ((options.yes || options.interactive === false) && !options.workspacePath && (await isWeaveSourceRepo(gitRoot))) {
    throw new Error(
      "Refusing to adopt the Weave source repo without --workspace-path. Run this command from a disposable test repo, or pass an explicit workspace path.",
    );
  }

  const workspaceName = await resolveWorkspaceName(options, defaultWorkspaceName);
  if (workspaceName === "cancelled") {
    return cancelledWorkspace(options.cwd, options.sessionPath);
  }

  const workspacePath = options.workspacePath
    ? path.resolve(options.cwd, options.workspacePath)
    : path.join(path.dirname(gitRoot), slugify(workspaceName, "workspace"));
  const repoTargetPath = path.join(workspacePath, repoDirectoryName);

  await assertPathMissing(workspacePath, "Workspace path already exists");
  await assertPathMissing(repoTargetPath, "Repo target path already exists");

  const remote = await getGitRemote(gitRoot);
  await createDirExclusive(workspacePath);
  await movePath(gitRoot, repoTargetPath);
  const resolvedWorkspacePath = await realpath(workspacePath);

  const created = await scaffoldWorkspace({
    workspacePath: resolvedWorkspacePath,
    workspaceName,
    repos: {
      [slugify(repoDirectoryName, "repo")]: {
        path: repoDirectoryName,
        kind: options.folderKind ?? "app",
        ...(remote ? { remote } : {}),
      },
    },
  });

  const folder = workspaceFolder(resolvedWorkspacePath, workspaceName, options.folderId);
  const commitCreated = await createInitialWorkspaceCommit(resolvedWorkspacePath);
  const session = createCurrentSession(folder, options.now);
  await saveCurrentSession(session, options.sessionPath);

  return {
    status: "initialized",
    mode: "workspace",
    message: initializedMessage({
      mode: "workspace",
      folderId: folder.id,
      folderPath: folder.path,
      created,
      sessionPath: options.sessionPath,
      oldRepoPath: gitRoot,
      newRepoPath: repoTargetPath,
      commitCreated,
    }),
    folderPath: folder.path,
    wikiDir: path.join(resolvedWorkspacePath, "wiki"),
    metadataDir: path.join(resolvedWorkspacePath, ".weave"),
    sessionPath: options.sessionPath,
    commitCreated,
    warning: commitCreated ? undefined : "Initial workspace commit was not created. Run git status in the workspace to recover.",
  };
}

async function initWorkspaceWithoutGitRepo(
  options: InitWorkspaceOptions & { cwd: string; now: Date; sessionPath: string },
): Promise<InitWorkspaceResult> {
  const workspacePath = await resolveWorkspacePath(options);
  if (workspacePath === "cancelled") {
    return cancelledWorkspace(options.cwd, options.sessionPath);
  }

  const workspaceName = await resolveWorkspaceName(options, path.basename(workspacePath));
  if (workspaceName === "cancelled") {
    return cancelledWorkspace(options.cwd, options.sessionPath);
  }

  const workspacePathExists = await pathExists(workspacePath);
  if (workspacePathExists) {
    const currentPath = await realpath(options.cwd);
    const targetPath = await realpath(workspacePath);
    const isCurrentPath = currentPath === targetPath;

    if (!isCurrentPath || !(await isDirectoryEmpty(workspacePath))) {
      throw new Error(`Workspace path already exists and is not an empty current directory: ${workspacePath}`);
    }
  } else {
    await createDirExclusive(workspacePath);
  }

  const created = await scaffoldWorkspace({
    workspacePath,
    workspaceName,
    repos: {},
  });

  const folder = workspaceFolder(await realpath(workspacePath), workspaceName, options.folderId);
  const commitCreated = await createInitialWorkspaceCommit(folder.path);
  const session = createCurrentSession(folder, options.now);
  await saveCurrentSession(session, options.sessionPath);

  return {
    status: "initialized",
    mode: "workspace",
    message: initializedMessage({
      mode: "workspace",
      folderId: folder.id,
      folderPath: folder.path,
      created,
      sessionPath: options.sessionPath,
      commitCreated,
    }),
    folderPath: folder.path,
    wikiDir: path.join(folder.path, "wiki"),
    metadataDir: path.join(folder.path, ".weave"),
    sessionPath: options.sessionPath,
    commitCreated,
    warning: commitCreated ? undefined : "Initial workspace commit was not created. Run git status in the workspace to recover.",
  };
}

async function selectInitMode(options: InitWorkspaceOptions): Promise<InitMode | "cancelled"> {
  if (options.mode) {
    if (options.mode === "repo" || options.mode === "workspace") {
      return options.mode;
    }

    throw new Error(`Unsupported init mode: ${options.mode}. Expected "repo" or "workspace".`);
  }

  if (options.yes || options.interactive === false) {
    return "repo";
  }

  const answer = await prompts.select({
    message: "How should Weave initialize this folder?",
    options: [
      {
        value: "repo",
        label: "Repo mode",
        hint: "Use this when you want to code/reference only this repo.",
      },
      {
        value: "workspace",
        label: "Workspace mode",
        hint: "Use this when you work across multiple repos or folders.",
      },
    ],
    initialValue: "repo",
  });

  if (prompts.isCancel(answer)) {
    prompts.cancel("Cancelled.");
    return "cancelled";
  }

  return answer as InitMode;
}

async function shouldReplaceSession(options: InitWorkspaceOptions): Promise<boolean> {
  if (options.yes || options.interactive === false) {
    return true;
  }

  const answer = await prompts.confirm({
    message: "A Weave session already exists. Start a new session from this folder?",
    initialValue: true,
  });

  if (prompts.isCancel(answer)) {
    prompts.cancel("Cancelled.");
    return false;
  }

  return answer;
}

async function resolveWorkspaceName(
  options: InitWorkspaceOptions,
  defaultName: string,
): Promise<string | "cancelled"> {
  if (options.workspaceName) {
    return options.workspaceName;
  }

  if (options.yes || options.interactive === false) {
    return defaultName;
  }

  const answer = await prompts.text({
    message: "Workspace name",
    placeholder: defaultName,
    defaultValue: defaultName,
  });

  if (prompts.isCancel(answer)) {
    prompts.cancel("Cancelled.");
    return "cancelled";
  }

  return String(answer).trim() || defaultName;
}

async function resolveWorkspacePath(
  options: InitWorkspaceOptions & { cwd: string },
): Promise<string | "cancelled"> {
  if (options.workspacePath) {
    return path.resolve(options.cwd, options.workspacePath);
  }

  if (options.yes || options.interactive === false) {
    throw new Error("Workspace path is required for workspace mode outside a git repo.");
  }

  const answer = await prompts.text({
    message: "Workspace path",
    placeholder: path.join(path.dirname(options.cwd), "my-workspace"),
  });

  if (prompts.isCancel(answer)) {
    prompts.cancel("Cancelled.");
    return "cancelled";
  }

  const value = String(answer).trim();
  if (!value) {
    throw new Error("Workspace path is required for workspace mode outside a git repo.");
  }

  return path.resolve(options.cwd, value);
}

async function writeRepoWorkspaceMetadata(folder: ResolvedFolder): Promise<boolean> {
  return writeFileIfMissing(
    path.join(folder.path, ".weave", "workspace.yml"),
    workspaceMetadataTemplate({
      mode: "repo",
      name: folder.name,
      repos: {},
    }),
  );
}

async function scaffoldWorkspace(input: {
  workspacePath: string;
  workspaceName: string;
  repos: Record<string, { path: string; kind: string; remote?: string }>;
}): Promise<string[]> {
  await runGitRequired(["init"], input.workspacePath);
  const folder = workspaceFolder(input.workspacePath, input.workspaceName);
  const scaffold = await ensureWeaveScaffold({ folder });
  const created = [...scaffold.created];
  if ((await ensureDecisionGuidance(input.workspacePath)) !== "unchanged") {
    created.push("AGENTS.md");
  }

  if (
    await writeFileIfMissing(
      path.join(input.workspacePath, ".weave", "workspace.yml"),
      workspaceMetadataTemplate({
        mode: "workspace",
        name: input.workspaceName,
        repos: {},
      }),
    )
  ) {
    created.push(".weave/workspace.yml");
  }

  if (
    await writeFileIfMissing(
      path.join(input.workspacePath, ".gitignore"),
      workspaceGitignoreBaseTemplate(),
    )
  ) {
    created.push(".gitignore");
  }

  for (const [id, repo] of Object.entries(input.repos)) {
    await registerRepoIntoWorkspace({
      workspacePath: input.workspacePath,
      id,
      relativePath: repo.path,
      kind: repo.kind,
      remote: repo.remote,
    });
  }

  return created;
}

async function createInitialWorkspaceCommit(workspacePath: string): Promise<boolean> {
  try {
    await runGitRequired(["add", "."], workspacePath);
    await runGitRequired(["commit", "-m", "Initialize Weave workspace"], workspacePath);
    return true;
  } catch {
    return false;
  }
}

function workspaceFolder(workspacePath: string, workspaceName: string, folderId?: string): ResolvedFolder {
  const id = folderId ?? slugify(workspaceName, "workspace");

  return {
    id,
    path: workspacePath,
    name: titleFromSlug(id) || workspaceName,
    kind: "workspace",
  };
}

async function assertPathMissing(targetPath: string, message: string): Promise<void> {
  if (await pathExists(targetPath)) {
    throw new Error(`${message}: ${targetPath}`);
  }
}

async function isWeaveSourceRepo(gitRoot: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(path.join(gitRoot, "package.json"), "utf8")) as { name?: string };
    return manifest.name === "weave-it";
  } catch {
    return false;
  }
}

function workspaceMetadataTemplate(input: {
  mode: InitMode;
  name: string;
  repos: Record<string, { path: string; kind: string; remote?: string }>;
}): string {
  return YAML.stringify({
    version: 1,
    mode: input.mode,
    name: input.name,
    repos: input.repos,
  });
}

function cancelledWorkspace(folderPath: string, sessionPath: string): InitWorkspaceResult {
  return {
    status: "cancelled",
    message: "Cancelled. Weave workspace was not initialized.",
    folderPath,
    wikiDir: "",
    metadataDir: "",
    sessionPath,
  };
}

function alreadyInitializedMessage(mode: "workspace" | "repo"): string {
  return `Weave is already initialized (mode: ${mode}). Start a new change with \`weave change new "<title>"\`.`;
}

function initializedMessage(input: {
  mode: InitMode;
  folderId: string;
  folderPath: string;
  created: string[];
  sessionPath: string;
  oldRepoPath?: string;
  newRepoPath?: string;
  commitCreated?: boolean;
}): string {
  const createdText = input.created.length > 0 ? input.created.join("\n  ") : "No repo files changed";
  const modeText = input.mode === "workspace" ? "workspace mode" : "repo mode";
  const repoMoveText =
    input.oldRepoPath && input.newRepoPath
      ? `
Adopted repo:
  From: ${input.oldRepoPath}
  To:   ${input.newRepoPath}
`
      : "";
  const commitText =
    input.mode === "workspace"
      ? `
Initial workspace commit:
  ${input.commitCreated ? "Created" : "Not created - run git status in the workspace to recover"}
`
      : "";
  const nextText =
    input.mode === "workspace"
      ? `Open this workspace path in your editor:
  ${input.folderPath}

Then run:
  weave workspace`
      : `weave add <path>
  weave workspace`;

  return `Initialized Weave in ${modeText} for folder: ${input.folderId}

Folder:
  ${input.folderPath}

Created:
  ${createdText}
${repoMoveText}${commitText}

Started current session:
  ${input.folderId}

Session state:
  ${input.sessionPath}

Next:
  ${nextText}`;
}
