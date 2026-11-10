// Coding guidelines files (decision 261110-dtld): where they live, which ones apply to a set of
// repos, and the starter text. The CLI only resolves files; the reviewer weighs shared against
// repo rules by judgement, so nothing here merges or interprets their content.
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceMetadata } from "../workspace-repos.js";

// The fixed name, relative to the workspace root (shared) or to a repo root (repo-specific).
export const guidelinesFileName = path.posix.join(".weave", "coding-guidelines.md");

// The workspace root's own repo id in slice `repos:` lists.
const rootRepoId = "root";

export type GuidelineScope = "shared" | "repo";

export interface GuidelineFile {
  scope: GuidelineScope;
  repo?: string;
  // Relative to the checkout root, with `/` separators.
  path: string;
  status: "present" | "absent";
}

export interface GuidelineResolution {
  files: GuidelineFile[];
  // Repos whose checkout is not available locally. A package built without them is partial.
  missingRepos: string[];
}

export interface GuidelineRepo {
  id: string;
  // Relative to the checkout root. Undefined when the repo is not registered.
  path?: string;
}

export interface ResolveGuidelinesInput {
  // The change's own checkout folder, so guideline edits made on the change apply to its review.
  checkoutRoot: string;
  mode: "repo" | "workspace";
  repos: GuidelineRepo[];
}

export async function resolveGuidelines(input: ResolveGuidelinesInput): Promise<GuidelineResolution> {
  const files: GuidelineFile[] = [
    { scope: "shared", path: guidelinesFileName, status: await fileStatus(input.checkoutRoot, guidelinesFileName) },
  ];
  const missingRepos: string[] = [];
  // In repo mode the shared file and the repo file are the same file.
  if (input.mode === "repo") {
    return { files, missingRepos };
  }

  const seen = new Set<string>();
  for (const repo of input.repos) {
    if (seen.has(repo.id)) continue;
    seen.add(repo.id);
    const repoPath = repo.path === undefined ? undefined : normalizeRepoPath(repo.path);
    if (repoPath === undefined || !(await isDirectory(path.join(input.checkoutRoot, repoPath)))) {
      missingRepos.push(repo.id);
      continue;
    }
    // A repo at the workspace root shares the shared file, which is already listed.
    if (repoPath === "") continue;
    const relative = path.posix.join(repoPath, guidelinesFileName);
    files.push({ scope: "repo", repo: repo.id, path: relative, status: await fileStatus(input.checkoutRoot, relative) });
  }
  return { files, missingRepos };
}

// Maps repo ids to their registered paths for `resolveGuidelines`. `root` is the workspace root.
// Omitting `ids` lists every registered repo.
export function guidelineRepos(metadata: Pick<WorkspaceMetadata, "repos"> | undefined, ids?: string[]): GuidelineRepo[] {
  const repos = metadata?.repos ?? {};
  return (ids ?? Object.keys(repos)).map((id) => {
    if (id === rootRepoId && !repos[id]) return { id, path: "." };
    const entry = repos[id];
    return entry ? { id, path: entry.path } : { id };
  });
}

export interface GuidelineTarget {
  // Absolute path of the guidelines file to write.
  path: string;
  scope: GuidelineScope;
  repo?: string;
}

// Writes the starter shared file, or a heading-only repo file, only when no file exists. An
// existing file, edited or not, is never touched.
export async function writeGuidelinesIfMissing(target: GuidelineTarget): Promise<"created" | "unchanged"> {
  const content = target.scope === "shared" ? starterGuidelines() : repoGuidelinesTemplate(target.repo);
  await mkdir(path.dirname(target.path), { recursive: true });
  try {
    await writeFile(target.path, content, { flag: "wx" });
    return "created";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "unchanged";
    throw error;
  }
}

export function repoGuidelinesTemplate(repo?: string): string {
  return `# Coding guidelines${repo ? `: ${repo}` : ""}\n`;
}

export function starterGuidelines(): string {
  return `# Coding guidelines

Reviewers check this project's code against these rules. The team owns this file: edit, add, or
delete rules freely. Weave wrote it once and never overwrites it.

In a workspace with several repositories, each repository can keep its own rules in
\`.weave/coding-guidelines.md\` at its root. Both files apply, and the repository's file wins
when the two conflict.

This file can also act as an index. Link to more guideline files anywhere in the repository,
for example \`[Models](../docs/guidelines/models.md): code under src/models/\`. Reviewers follow
the links that cover the code they review. Links are relative to this file.

## Error handling

- Handle failures where something can be done about them. Do not swallow errors silently;
  report or rethrow them with enough context to act on.
- Fail early on invalid input at the boundary, with a message that says what was wrong.

## Security

- Never commit secrets, keys, or credentials. Read them from configuration at runtime.
- Treat all external input as untrusted: validate it, and escape or parameterise it before it
  reaches a query, a shell command, a file path, or a page.

## Testing expectations

- New behaviour and bug fixes come with tests that exercise the real behaviour and would fail
  without the change. Do not test only that a mock was called.
- Do not weaken, skip, or delete a failing test to make a change pass.

## Naming and structure

- Names say what a thing is or does. Follow the conventions already used nearby.
- Keep changes focused on the task. Do not add unused code, options, or abstractions for needs
  that do not exist yet, and remove code the change makes dead.

## Documentation

- Comment why the code does something when that is not obvious, not what each line does.
- Update the relevant docs when behaviour that people or other code rely on changes.
`;
}

function normalizeRepoPath(repoPath: string): string {
  const normalized = path.posix.normalize(repoPath.split(path.sep).join("/")).replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized === "." ? "" : normalized;
}

async function fileStatus(root: string, relative: string): Promise<"present" | "absent"> {
  try {
    return (await stat(path.join(root, relative))).isFile() ? "present" : "absent";
  } catch {
    return "absent";
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}
