import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewCommand } from "../src/commands/review.js";
import { repoGuidelinesTemplate, starterGuidelines } from "../src/lib/review/guidelines.js";

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  process.exitCode = undefined;
});

async function setup(options: { mode: "repo" | "workspace"; repos?: Record<string, string>; checkedOut?: string[] }): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-cli-review-guidelines-")));
  await mkdir(path.join(root, ".weave"), { recursive: true });
  const repos = Object.fromEntries(Object.entries(options.repos ?? {}).map(([id, repoPath]) => [id, { path: repoPath, kind: "app" }]));
  await writeFile(path.join(root, ".weave", "workspace.yml"), YAML.stringify({ version: 1, mode: options.mode, name: "fixture", repos }));
  for (const repoPath of options.checkedOut ?? []) {
    await mkdir(path.join(root, repoPath), { recursive: true });
  }
  process.chdir(root);
  return root;
}

async function runJson(args: string[], subcommand = "init"): Promise<{ result: Record<string, unknown>; exitCode: number | undefined }> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  });
  try {
    const command = reviewCommand();
    command.exitOverride();
    await command.parseAsync(["guidelines", subcommand, ...args, "--json"], { from: "user" });
  } finally {
    spy.mockRestore();
  }
  return { result: JSON.parse(chunks.join("")) as Record<string, unknown>, exitCode: process.exitCode === undefined ? undefined : Number(process.exitCode) };
}

describe("weave review guidelines init", () => {
  it("creates the starter shared file, then reports unchanged and keeps edits", async () => {
    const root = await setup({ mode: "repo" });
    const file = path.join(root, ".weave", "coding-guidelines.md");

    await expect(runJson([])).resolves.toEqual({ result: { status: "ok", path: ".weave/coding-guidelines.md", result: "created" }, exitCode: undefined });
    await expect(readFile(file, "utf8")).resolves.toBe(starterGuidelines());

    await expect(runJson([])).resolves.toMatchObject({ result: { status: "ok", result: "unchanged" } });

    await writeFile(file, "# Our own rules\n");
    await expect(runJson([])).resolves.toMatchObject({ result: { result: "unchanged" } });
    await expect(readFile(file, "utf8")).resolves.toBe("# Our own rules\n");
  });

  it("writes the shared file at the workspace root when run from inside a repo", async () => {
    const root = await setup({ mode: "workspace", repos: { api: "api" }, checkedOut: ["api/src"] });
    process.chdir(path.join(root, "api", "src"));

    await expect(runJson([])).resolves.toMatchObject({ result: { path: ".weave/coding-guidelines.md", result: "created" } });
    await expect(readFile(path.join(root, ".weave", "coding-guidelines.md"), "utf8")).resolves.toBe(starterGuidelines());
  });

  it("writes a repo's heading-only file with --repo in workspace mode, only when absent", async () => {
    const root = await setup({ mode: "workspace", repos: { api: "services/api", web: "web" }, checkedOut: ["services/api", "web"] });
    const file = path.join(root, "services", "api", ".weave", "coding-guidelines.md");

    await expect(runJson(["--repo", "api"])).resolves.toEqual({
      result: { status: "ok", path: "services/api/.weave/coding-guidelines.md", result: "created" },
      exitCode: undefined,
    });
    await expect(readFile(file, "utf8")).resolves.toBe(repoGuidelinesTemplate("api"));
    await expect(readFile(path.join(root, ".weave", "coding-guidelines.md"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(root, "web", ".weave", "coding-guidelines.md"), "utf8")).rejects.toThrow();

    await writeFile(file, "# Api rules\n- Use typed errors.\n");
    await expect(runJson(["--repo", "api"])).resolves.toMatchObject({ result: { result: "unchanged" } });
    await expect(readFile(file, "utf8")).resolves.toBe("# Api rules\n- Use typed errors.\n");
  });

  it("rejects --repo in repo mode", async () => {
    const root = await setup({ mode: "repo" });

    await expect(runJson(["--repo", "api"])).resolves.toMatchObject({ result: { status: "error", code: "invalid_arguments" }, exitCode: 1 });
    await expect(readFile(path.join(root, ".weave", "coding-guidelines.md"), "utf8")).rejects.toThrow();
  });

  it("rejects an unknown repo id and a repo whose checkout is missing", async () => {
    await setup({ mode: "workspace", repos: { api: "api" } });

    await expect(runJson(["--repo", "billing"])).resolves.toMatchObject({ result: { status: "error", code: "repo_not_found" }, exitCode: 1 });
    process.exitCode = undefined;
    await expect(runJson(["--repo", "api"])).resolves.toMatchObject({ result: { status: "error", code: "repo_missing" }, exitCode: 1 });
  });
});

describe("weave review guidelines status", () => {
  it("lists the single file in repo mode", async () => {
    const root = await setup({ mode: "repo" });

    await expect(runJson([], "status")).resolves.toEqual({
      result: {
        status: "ok",
        mode: "repo",
        checkout_root: root,
        files: [{ scope: "shared", root: ".", path: ".weave/coding-guidelines.md", status: "absent" }],
        missing_repos: [],
      },
      exitCode: undefined,
    });
    await writeFile(path.join(root, ".weave", "coding-guidelines.md"), "# Rules\n");
    await expect(runJson([], "status")).resolves.toMatchObject({ result: { files: [{ status: "present" }] } });
  });

  it("lists the shared file and every checked-out repo's file, and reports repos not checked out", async () => {
    const root = await setup({ mode: "workspace", repos: { api: "services/api", web: "web", docs: "docs" }, checkedOut: ["services/api", "web"] });
    await mkdir(path.join(root, "web", ".weave"), { recursive: true });
    await writeFile(path.join(root, "web", ".weave", "coding-guidelines.md"), "# Web rules\n");

    const { result } = await runJson([], "status");

    expect(result.files).toEqual([
      { scope: "shared", root: ".", path: ".weave/coding-guidelines.md", status: "absent" },
      { scope: "repo", repo: "api", root: "services/api", path: "services/api/.weave/coding-guidelines.md", status: "absent" },
      { scope: "repo", repo: "web", root: "web", path: "web/.weave/coding-guidelines.md", status: "present" },
    ]);
    expect(result.missing_repos).toEqual(["docs"]);
    // Read-only: nothing was written.
    await expect(readFile(path.join(root, ".weave", "coding-guidelines.md"), "utf8")).rejects.toThrow();
  });

  it("narrows to one repo with --repo, and to the shared file for a repo at the workspace root", async () => {
    await setup({ mode: "workspace", repos: { api: "api", main: "." }, checkedOut: ["api"] });

    await expect(runJson(["--repo", "api"], "status")).resolves.toMatchObject({
      result: { files: [{ scope: "repo", repo: "api", path: "api/.weave/coding-guidelines.md", status: "absent" }], missing_repos: [] },
    });
    await expect(runJson(["--repo", "main"], "status")).resolves.toMatchObject({
      result: { files: [{ scope: "shared", path: ".weave/coding-guidelines.md" }] },
    });
    await expect(runJson(["--repo", "billing"], "status")).resolves.toMatchObject({ result: { status: "error", code: "repo_not_found" }, exitCode: 1 });
  });

  it("rejects --repo in repo mode", async () => {
    await setup({ mode: "repo" });

    await expect(runJson(["--repo", "api"], "status")).resolves.toMatchObject({ result: { status: "error", code: "invalid_arguments" }, exitCode: 1 });
  });
});
