import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { resolveFolder } from "./folders.js";
import { cloneRepo, getGitRemote } from "./git.js";
import { movePath, pathExists } from "./files.js";
import {
  addFolderToSession,
  defaultSessionPath,
  loadCurrentSession,
  loadOrCreateSession,
  saveCurrentSession,
} from "./session-state.js";
import { guidelinesFileName, guidelinesHint } from "./review/guidelines.js";
import { ensureWeaveScaffold } from "./weave-scaffold.js";
import { findWorkspaceMode, isWorkspaceMode } from "./workspace-mode.js";
import {
  defaultRepoId,
  findRegisteredRepoByPath,
  isGitUrl,
  isInsideWorkspace,
  readWorkspaceMetadata,
  registerRepoIntoWorkspace,
  repoNameFromUrl,
  relativeRepoPath,
} from "./workspace-repos.js";

export type AddFolderOptions = {
  cwd?: string;
  targetPath: string;
  folderId?: string;
  folderKind?: string;
  now?: Date;
  sessionPath?: string;
};

export type AddFolderStatus = "added" | "already_exists" | "not_initialized";

export type AddFolderCommandResult = {
  status: AddFolderStatus;
  message: string;
};

export async function addFolder(options: AddFolderOptions): Promise<AddFolderCommandResult> {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const sessionPath = options.sessionPath ?? defaultSessionPath();

  const modeResult = await findWorkspaceMode(cwd);
  if (!modeResult) {
    return {
      status: "not_initialized",
      message: "No Weave context found. Run `weave init` first.",
    };
  }

  if (isWorkspaceMode(modeResult)) {
    return addFolderToWorkspace({
      cwd,
      workspacePath: modeResult.workspacePath,
      targetPath: options.targetPath,
      folderId: options.folderId,
      folderKind: options.folderKind ?? "app",
    });
  }

  const session = await loadOrCreateSession(now, sessionPath);

  return addFolderToRepoSession({
    cwd,
    targetPath: options.targetPath,
    folderId: options.folderId,
    folderKind: options.folderKind,
    session,
    sessionPath,
    now,
  });
}

async function addFolderToRepoSession(input: {
  cwd: string;
  targetPath: string;
  folderId?: string;
  folderKind?: string;
  session: NonNullable<Awaited<ReturnType<typeof loadCurrentSession>>>;
  sessionPath: string;
  now: Date;
}): Promise<AddFolderCommandResult> {
  const folder = await resolveFolder({
    cwd: input.cwd,
    targetPath: input.targetPath,
    id: input.folderId,
    kind: input.folderKind,
  });
  await ensureWeaveScaffold({ folder });

  const result = addFolderToSession(input.session, folder, input.now);
  await saveCurrentSession(result.session, input.sessionPath);

  if (!result.added) {
    return {
      status: "already_exists",
      message: `Folder already exists in current Weave session: ${result.id}\n\nPath:\n  ${folder.path}`,
    };
  }

  return {
    status: "added",
    message: `Added folder to current Weave session: ${result.id}\n\nPath:\n  ${folder.path}\n\nNext:\n  weave workspace`,
  };
}

async function addFolderToWorkspace(input: {
  cwd: string;
  workspacePath: string;
  targetPath: string;
  folderId?: string;
  folderKind: string;
}): Promise<AddFolderCommandResult> {
  const workspacePath = await realpath(input.workspacePath);
  const metadata = await readWorkspaceMetadata(workspacePath);

  if (!metadata) {
    throw new Error(`Workspace metadata is missing or invalid: ${path.join(workspacePath, ".weave", "workspace.yml")}`);
  }

  let repoAbsolutePath: string;
  let relativePath: string;
  let remote: string | undefined;

  if (isGitUrl(input.targetPath)) {
    const url = input.targetPath.trim();
    const destName = repoNameFromUrl(url);
    relativePath = destName;
    repoAbsolutePath = path.join(workspacePath, destName);

    const existingId = findRegisteredRepoByPath(metadata, relativePath);
    const repoExists = await pathExists(repoAbsolutePath);
    if (existingId && repoExists) {
      return workspaceAlreadyRegisteredMessage(existingId, relativePath, workspacePath);
    }

    if (!existingId && repoExists) {
      throw new Error(`Destination already exists: ${repoAbsolutePath}`);
    }

    try {
      await cloneRepo(url, destName, workspacePath);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to clone repository: ${detail}`);
    }

    if (existingId) {
      return withGuidelinesHint(workspaceMaterializedMessage(existingId, relativePath, workspacePath), existingId, repoAbsolutePath);
    }

    remote = url;
  } else {
    const candidate = path.resolve(input.cwd, input.targetPath);
    await assertDirectory(candidate);

    if (await isInsideWorkspace(workspacePath, candidate)) {
      repoAbsolutePath = await realpath(candidate);
      relativePath = relativeRepoPath(workspacePath, repoAbsolutePath);

      const existingId = findRegisteredRepoByPath(metadata, relativePath);
      if (existingId) {
        return workspaceAlreadyRegisteredMessage(existingId, relativePath, workspacePath);
      }
    } else {
      const sourcePath = await realpath(candidate);
      const destName = path.basename(sourcePath);
      relativePath = destName;
      repoAbsolutePath = path.join(workspacePath, destName);

      if (await pathExists(repoAbsolutePath)) {
        throw new Error(`Destination already exists in workspace: ${repoAbsolutePath}`);
      }

      try {
        await movePath(sourcePath, repoAbsolutePath);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to adopt folder into workspace: ${detail}`);
      }

      const existingId = findRegisteredRepoByPath(metadata, relativePath);
      if (existingId) {
        return withGuidelinesHint(workspaceMaterializedMessage(existingId, relativePath, workspacePath), existingId, repoAbsolutePath);
      }
    }

    remote = await getGitRemote(repoAbsolutePath);
  }

  const id = defaultRepoId(relativePath, input.folderId);
  await registerRepoIntoWorkspace({
    workspacePath,
    id,
    relativePath,
    kind: input.folderKind,
    remote,
  });

  const remoteText = remote ? `\n\nRemote:\n  ${remote}` : "";
  return withGuidelinesHint(
    {
      status: "added",
      message: `Registered repo in workspace: ${id}\n\nPath:\n  ${relativePath}${remoteText}\n\nWorkspace:\n  ${workspacePath}\n\nNext:\n  weave workspace`,
    },
    id,
    repoAbsolutePath,
  );
}

// A newly added repo with no guidelines file of its own gets a pointer to the skill that drafts
// one. Weave never writes the file itself here.
async function withGuidelinesHint(result: AddFolderCommandResult, id: string, repoAbsolutePath: string): Promise<AddFolderCommandResult> {
  if (await pathExists(path.join(repoAbsolutePath, guidelinesFileName))) return result;
  return { ...result, message: `${result.message}\n\n${guidelinesHint(id)}` };
}

function workspaceAlreadyRegisteredMessage(
  id: string,
  relativePath: string,
  workspacePath: string,
): AddFolderCommandResult {
  return {
    status: "already_exists",
    message: `Repo already registered in workspace: ${id}\n\nPath:\n  ${relativePath}\n\nWorkspace:\n  ${workspacePath}`,
  };
}

function workspaceMaterializedMessage(
  id: string,
  relativePath: string,
  workspacePath: string,
): AddFolderCommandResult {
  return {
    status: "added",
    message: `Materialized registered repo in workspace: ${id}\n\nPath:\n  ${relativePath}\n\nWorkspace:\n  ${workspacePath}\n\nNext:\n  weave workspace`,
  };
}

async function assertDirectory(targetPath: string): Promise<void> {
  try {
    const value = await stat(targetPath);
    if (!value.isDirectory()) {
      throw new Error(`Expected a directory: ${targetPath}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Expected a directory")) {
      throw error;
    }
    throw new Error(`Expected a directory: ${targetPath}`);
  }
}
