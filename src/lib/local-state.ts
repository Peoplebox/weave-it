import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ChangeCommandError } from "./change-error.js";
import { gitCommonDir } from "./git.js";

// Machine-local state lives in the main repo's git directory: it is shared by every
// worktree of that repo and is never committed.
export async function localStateDir(mainRoot: string): Promise<string> {
  const common = (await gitCommonDir(mainRoot)) ?? path.join(mainRoot, ".git");
  return path.join(common, "weave");
}

export async function withStateLock<T>(mainRoot: string, action: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await localStateDir(mainRoot);
  await mkdir(stateDir, { recursive: true });
  const lock = path.join(stateDir, "lock");
  for (let attempt = 0; ; attempt += 1) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      const age = await stat(lock).then((info) => Date.now() - info.mtimeMs).catch(() => 0);
      if (age > 30_000) {
        await rm(lock, { recursive: true, force: true });
      } else if (attempt >= 100) {
        throw new ChangeCommandError("state_locked", `Another Weave command is updating ${stateDir}. Try again.`, {
          error: error instanceof Error ? error.message : String(error),
        });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
  try {
    return await action(stateDir);
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

// Writes through a temp file and a rename, so readers never see a half-written file.
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(temp, content);
  await rename(temp, file);
}
