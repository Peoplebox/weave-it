import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { addFolder } from "../src/lib/add-folder.js";
import { updateAgentSkills } from "../src/lib/agent-skills.js";
import { createChange, currentChange } from "../src/lib/changes.js";
import { buildDoctor } from "../src/lib/doctor.js";
import { initWorkspace } from "../src/lib/init-workspace.js";
import { starterGuidelines } from "../src/lib/review/guidelines.js";
import { loadCurrentSession } from "../src/lib/session-state.js";
import { showWorkspace } from "../src/lib/show-workspace.js";

const execFileAsync = promisify(execFile);

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "weave-it-"));
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Weave Test",
      GIT_AUTHOR_EMAIL: "weave-test@example.invalid",
      GIT_COMMITTER_NAME: "Weave Test",
      GIT_COMMITTER_EMAIL: "weave-test@example.invalid",
    },
  });
}

describe("current session workflow", () => {
  it("initializes repo wiki scaffold and starts a current session", async () => {
    const cwd = await tempDir();
    const resolvedCwd = await realpath(cwd);
    const sessionPath = path.join(cwd, ".cache", "current-session.yml");

    const result = await initWorkspace({
      cwd,
      interactive: false,
      yes: true,
      folderId: "frontend",
      folderKind: "app",
      now: new Date("2026-05-17T10:00:00.000Z"),
      sessionPath,
    });

    expect(result.status).toBe("initialized");
    expect(result.mode).toBe("repo");
    expect(result.wikiDir).toBe(path.join(resolvedCwd, "wiki"));
    expect(result.metadataDir).toBe(path.join(resolvedCwd, ".weave"));
    await expect(stat(path.join(cwd, "wiki", "changes"))).resolves.toMatchObject({});
    await expect(stat(path.join(cwd, "wiki", "knowledge", "domains"))).resolves.toMatchObject({});
    await expect(stat(path.join(cwd, "wiki", "knowledge", "shared"))).resolves.toMatchObject({});
    await expect(stat(path.join(cwd, ".weave", "sync.yml"))).resolves.toMatchObject({});
    await expect(stat(path.join(cwd, ".weave", "architecture-considerations.md"))).resolves.toMatchObject({});
    await expect(stat(path.join(cwd, ".weave", "workspace.yml"))).resolves.toMatchObject({});
    await expect(readFile(path.join(cwd, ".weave", "coding-guidelines.md"), "utf8")).resolves.toBe(starterGuidelines());
    expect(result.message).toContain(".weave/coding-guidelines.md");
    await expect(stat(path.join(cwd, ".git"))).rejects.toThrow();
    await expect(stat(path.join(cwd, "weave"))).rejects.toThrow();
    await expect(stat(path.join(cwd, ".weave", "local.yml"))).rejects.toThrow();

    const sync = YAML.parse(await readFile(path.join(cwd, ".weave", "sync.yml"), "utf8"));
    const workspace = YAML.parse(await readFile(path.join(cwd, ".weave", "workspace.yml"), "utf8"));
    const knowledge = await readFile(path.join(cwd, "wiki", "knowledge", "index.md"), "utf8");
    const knowledgeReadme = await readFile(path.join(cwd, "wiki", "knowledge", "README.md"), "utf8");
    const domainsReadme = await readFile(path.join(cwd, "wiki", "knowledge", "domains", "README.md"), "utf8");
    const sharedReadme = await readFile(path.join(cwd, "wiki", "knowledge", "shared", "README.md"), "utf8");
    const architectureConsiderations = await readFile(path.join(cwd, ".weave", "architecture-considerations.md"), "utf8");
    const session = await loadCurrentSession(sessionPath);

    expect(sync.documents["knowledge.index"].path).toBe("wiki/knowledge/index.md");
    expect(sync.documents["knowledge.index"].status).toBe("synced");
    expect(Object.keys(sync.documents)).toEqual(["knowledge.index"]);
    expect(workspace).toMatchObject({
      version: 1,
      mode: "repo",
      name: "Frontend",
      repos: {},
    });
    expect(knowledge).toContain("# Product Knowledge");
    expect(knowledgeReadme).toContain("domains/");
    expect(knowledgeReadme).toContain("features/");
    expect(knowledgeReadme).toContain("domain-wide/");
    expect(knowledgeReadme).toContain("shared/");
    expect(knowledgeReadme).toContain("behavior.md");
    expect(knowledgeReadme).toContain("knowledge-delta.md");
    expect(domainsReadme).toContain("# Domains");
    expect(sharedReadme).toContain("# Shared Behavior");
    expect(architectureConsiderations).toContain("# Architecture Considerations");
    expect(architectureConsiderations).toContain("This file is user-owned. Weave creates it once and never overwrites it.");
    expect(architectureConsiderations).toContain("## Patterns To Avoid");
    expect(session?.folders.frontend).toMatchObject({
      path: resolvedCwd,
      name: "Frontend",
      kind: "app",
    });
  });

  it("does not overwrite existing wiki and metadata files when init runs again", async () => {
    const cwd = await tempDir();
    const sessionPath = path.join(cwd, ".cache", "current-session.yml");
    const wikiDir = path.join(cwd, "wiki", "knowledge");
    const metadataDir = path.join(cwd, ".weave");
    const knowledgeFile = path.join(wikiDir, "index.md");
    const knowledgeReadme = path.join(wikiDir, "README.md");
    const domainsReadme = path.join(wikiDir, "domains", "README.md");
    const sharedReadme = path.join(wikiDir, "shared", "README.md");
    const syncFile = path.join(metadataDir, "sync.yml");
    const architectureConsiderations = path.join(metadataDir, "architecture-considerations.md");
    const workspaceFile = path.join(metadataDir, "workspace.yml");
    const guidelinesFile = path.join(metadataDir, "coding-guidelines.md");
    await mkdir(path.join(wikiDir, "domains"), { recursive: true });
    await mkdir(path.join(wikiDir, "shared"), { recursive: true });
    await mkdir(metadataDir, { recursive: true });
    await writeFile(knowledgeFile, "existing wiki\n");
    await writeFile(knowledgeReadme, "existing knowledge readme\n");
    await writeFile(domainsReadme, "existing domains readme\n");
    await writeFile(sharedReadme, "existing shared readme\n");
    await writeFile(syncFile, "existing: true\n");
    await writeFile(architectureConsiderations, "existing architecture notes\n");
    await writeFile(workspaceFile, "existing: true\n");
    await writeFile(guidelinesFile, "# Our rules\n");

    const result = await initWorkspace({ cwd, interactive: false, yes: true, sessionPath });

    expect(result.status).toBe("already_initialized");
    await expect(readFile(knowledgeFile, "utf8")).resolves.toBe("existing wiki\n");
    await expect(readFile(knowledgeReadme, "utf8")).resolves.toBe("existing knowledge readme\n");
    await expect(readFile(domainsReadme, "utf8")).resolves.toBe("existing domains readme\n");
    await expect(readFile(sharedReadme, "utf8")).resolves.toBe("existing shared readme\n");
    await expect(readFile(syncFile, "utf8")).resolves.toBe("existing: true\n");
    await expect(readFile(architectureConsiderations, "utf8")).resolves.toBe("existing architecture notes\n");
    await expect(readFile(workspaceFile, "utf8")).resolves.toBe("existing: true\n");
    await expect(readFile(guidelinesFile, "utf8")).resolves.toBe("# Our rules\n");
  });

  it("keeps an edited coding guidelines file when weave init runs again", async () => {
    const cwd = await tempDir();
    const sessionPath = path.join(cwd, ".cache", "current-session.yml");
    const guidelinesFile = path.join(cwd, ".weave", "coding-guidelines.md");

    await initWorkspace({ cwd, interactive: false, yes: true, sessionPath });
    await writeFile(guidelinesFile, "# Our rules\n- Prefer small functions.\n");
    const again = await initWorkspace({ cwd, interactive: false, yes: true, sessionPath });

    expect(again.status).toBe("already_initialized");
    await expect(readFile(guidelinesFile, "utf8")).resolves.toBe("# Our rules\n- Prefer small functions.\n");
  });

  it("does not seed coding guidelines in an existing project from weave change new, doctor, add, or agent update", async () => {
    const root = await tempDir();
    const cwd = path.join(root, "app");
    const other = path.join(root, "other");
    const sessionPath = path.join(root, ".cache", "current-session.yml");
    const guidelinesFile = path.join(cwd, ".weave", "coding-guidelines.md");
    await mkdir(cwd);
    await mkdir(other);
    await git(cwd, ["init", "-q"]);
    await initWorkspace({ cwd, interactive: false, yes: true, folderId: "app", sessionPath });
    // An existing project: initialised before guidelines existed.
    await rm(guidelinesFile);
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-q", "-m", "Initialize Weave"]);

    const change = await createChange({ cwd, title: "Guidelines regression", randomId: () => "gr01", sessionPath });
    expect(change.folder).toBeTruthy();
    await expect(stat(path.join(change.folder ?? cwd, ".weave", "coding-guidelines.md"))).rejects.toThrow();
    await buildDoctor({ cwd, sessionPath });
    await buildDoctor({ cwd, fix: true, sessionPath });
    await addFolder({ cwd, targetPath: "../other", folderId: "other", sessionPath });
    await updateAgentSkills({ cwd, agent: "all" });

    await expect(stat(guidelinesFile)).rejects.toThrow();
    await expect(stat(path.join(other, ".weave", "coding-guidelines.md"))).rejects.toThrow();
  });

  it("initializes workspace mode outside a git repo", async () => {
    const root = await tempDir();
    const workspacePath = path.join(root, "platform");
    const sessionPath = path.join(root, ".cache", "current-session.yml");

    const result = await initWorkspace({
      cwd: root,
      mode: "workspace",
      workspaceName: "peoplebox-platform",
      workspacePath,
      interactive: false,
      yes: true,
      now: new Date("2026-05-17T10:00:00.000Z"),
      sessionPath,
    });

    const workspace = YAML.parse(await readFile(path.join(workspacePath, ".weave", "workspace.yml"), "utf8"));
    const session = await loadCurrentSession(sessionPath);

    expect(result.status).toBe("initialized");
    expect(result.mode).toBe("workspace");
    expect(result.commitCreated).toBe(true);
    await expect(stat(path.join(workspacePath, ".git"))).resolves.toMatchObject({});
    await expect(stat(path.join(workspacePath, ".gitignore"))).resolves.toMatchObject({});
    await expect(stat(path.join(workspacePath, "wiki", "changes"))).resolves.toMatchObject({});
    await expect(stat(path.join(workspacePath, ".weave", "sync.yml"))).resolves.toMatchObject({});
    await expect(stat(path.join(workspacePath, ".weave", "architecture-considerations.md"))).resolves.toMatchObject({});
    await expect(readFile(path.join(workspacePath, ".weave", "coding-guidelines.md"), "utf8")).resolves.toBe(starterGuidelines());
    expect(result.message).toContain(".weave/coding-guidelines.md");
    expect(workspace).toMatchObject({
      version: 1,
      mode: "workspace",
      name: "peoplebox-platform",
      repos: {},
    });
    expect(session?.folders["peoplebox-platform"]).toMatchObject({
      path: await realpath(workspacePath),
      kind: "workspace",
    });
  });

  it("adopts the current git repo into workspace mode", async () => {
    const root = await tempDir();
    const repo = path.join(root, "app-repo");
    const nested = path.join(repo, "src");
    const workspacePath = path.join(root, "peoplebox-platform");
    const movedRepo = path.join(workspacePath, "app-repo");
    const sessionPath = path.join(root, ".cache", "current-session.yml");
    await mkdir(nested, { recursive: true });
    await git(repo, ["init"]);
    await git(repo, ["remote", "add", "origin", "git@example.com:peoplebox/app-repo.git"]);
    await writeFile(path.join(nested, "dirty.txt"), "not committed\n");

    const result = await initWorkspace({
      cwd: nested,
      mode: "workspace",
      workspaceName: "peoplebox-platform",
      interactive: false,
      yes: true,
      now: new Date("2026-05-17T10:00:00.000Z"),
      sessionPath,
    });

    const workspace = YAML.parse(await readFile(path.join(workspacePath, ".weave", "workspace.yml"), "utf8"));
    const gitignore = await readFile(path.join(workspacePath, ".gitignore"), "utf8");
    const session = await loadCurrentSession(sessionPath);
    const resolvedWorkspacePath = await realpath(workspacePath);

    expect(result.status).toBe("initialized");
    expect(result.folderPath).toBe(resolvedWorkspacePath);
    await expect(stat(repo)).rejects.toThrow();
    await expect(stat(path.join(movedRepo, ".git"))).resolves.toMatchObject({});
    await expect(readFile(path.join(movedRepo, "src", "dirty.txt"), "utf8")).resolves.toBe("not committed\n");
    expect(gitignore).toContain("/app-repo/");
    await expect(readFile(path.join(workspacePath, ".weave", "coding-guidelines.md"), "utf8")).resolves.toBe(starterGuidelines());
    await expect(stat(path.join(movedRepo, ".weave", "coding-guidelines.md"))).rejects.toThrow();
    expect(result.message).toContain(".weave/coding-guidelines.md");
    expect(workspace.repos["app-repo"]).toMatchObject({
      path: "app-repo",
      kind: "app",
      remote: "git@example.com:peoplebox/app-repo.git",
    });
    expect(session?.folders["peoplebox-platform"]).toMatchObject({
      path: resolvedWorkspacePath,
      kind: "workspace",
    });
  });

  it("refuses non-interactive adoption of the Weave source repo without an explicit workspace path", async () => {
    const root = await tempDir();
    const repo = path.join(root, "weave-it");
    await mkdir(repo);
    await git(repo, ["init"]);
    await writeFile(path.join(repo, "package.json"), '{"name":"weave-it"}\n');

    await expect(
      initWorkspace({
        cwd: repo,
        mode: "workspace",
        workspaceName: "demo-platform",
        interactive: false,
        yes: true,
        sessionPath: path.join(root, ".cache", "current-session.yml"),
      }),
    ).rejects.toThrow(/Refusing to adopt the Weave source repo/);

    await expect(stat(repo)).resolves.toMatchObject({});
  });

  it("refuses workspace adoption when the workspace path already exists", async () => {
    const root = await tempDir();
    const repo = path.join(root, "app-repo");
    const workspacePath = path.join(root, "peoplebox-platform");
    await mkdir(repo);
    await mkdir(workspacePath);
    await git(repo, ["init"]);

    await expect(
      initWorkspace({
        cwd: repo,
        mode: "workspace",
        workspaceName: "peoplebox-platform",
        interactive: false,
        yes: true,
        sessionPath: path.join(root, ".cache", "current-session.yml"),
      }),
    ).rejects.toThrow(/Workspace path already exists/);

    await expect(stat(repo)).resolves.toMatchObject({});
  });

  it("requires init before adding folders when no workspace.yml exists", async () => {
    const cwd = await tempDir();
    const backend = path.join(cwd, "backend");
    const sessionPath = path.join(cwd, ".cache", "current-session.yml");
    await mkdir(backend);

    const result = await addFolder({ cwd, targetPath: "backend", sessionPath });

    expect(result.status).toBe("not_initialized");
    expect(result.message).toContain("No Weave context found");
  });

  it("adds another folder to the current session and avoids duplicates", async () => {
    const root = await tempDir();
    const frontend = path.join(root, "frontend");
    const backend = path.join(root, "backend");
    const sessionPath = path.join(root, ".cache", "current-session.yml");
    await mkdir(frontend);
    await mkdir(backend);
    const resolvedBackend = await realpath(backend);

    await initWorkspace({
      cwd: frontend,
      interactive: false,
      yes: true,
      folderId: "frontend",
      sessionPath,
      now: new Date("2026-05-17T10:00:00.000Z"),
    });

    const added = await addFolder({
      cwd: frontend,
      targetPath: "../backend",
      folderId: "backend",
      folderKind: "api",
      sessionPath,
      now: new Date("2026-05-17T10:01:00.000Z"),
    });
    const duplicate = await addFolder({
      cwd: frontend,
      targetPath: "../backend/",
      folderId: "backend-copy",
      sessionPath,
      now: new Date("2026-05-17T10:02:00.000Z"),
    });
    const session = await loadCurrentSession(sessionPath);

    expect(added.status).toBe("added");
    expect(duplicate.status).toBe("already_exists");
    expect(Object.keys(session?.folders ?? {})).toEqual(["frontend", "backend"]);
    expect(session?.folders.backend).toMatchObject({
      path: resolvedBackend,
      kind: "api",
    });
    await expect(stat(path.join(backend, "wiki", "knowledge", "index.md"))).resolves.toMatchObject({});
    await expect(stat(path.join(backend, ".weave", "sync.yml"))).resolves.toMatchObject({});
    await expect(stat(path.join(backend, ".weave", "architecture-considerations.md"))).resolves.toMatchObject({});
  });

  it("prints current session as JSON for agents in repo mode", async () => {
    const cwd = await tempDir();
    const resolvedCwd = await realpath(cwd);
    const sessionPath = path.join(cwd, ".cache", "current-session.yml");
    await initWorkspace({ cwd, interactive: false, yes: true, folderId: "frontend", sessionPath });

    const outsidePath = await tempDir();
    const result = await showWorkspace({ cwd: outsidePath, json: true, sessionPath });
    const output = JSON.parse(result.message);

    expect(result.status).toBe("ok");
    expect(output.session.status).toBe("active");
    expect(output.workspace).toBeNull();
    expect(output.repos).toEqual([]);
    expect(output.folders).toEqual([
      {
        id: "frontend",
        path: resolvedCwd,
        kind: "app",
        wiki: path.join(resolvedCwd, "wiki"),
        metadata: path.join(resolvedCwd, ".weave"),
      },
    ]);
  });

  it("prints workspace view as JSON when cwd is inside a workspace", async () => {
    const root = await tempDir();
    const workspacePath = path.join(root, "platform");
    const sessionPath = path.join(root, ".cache", "current-session.yml");
    await initWorkspace({
      cwd: root,
      mode: "workspace",
      workspaceName: "platform",
      workspacePath,
      interactive: false,
      yes: true,
      sessionPath,
    });

    const result = await showWorkspace({ cwd: workspacePath, json: true, sessionPath });
    const output = JSON.parse(result.message);
    const resolvedWorkspacePath = await realpath(workspacePath);

    expect(result.status).toBe("ok");
    expect(output.workspace).toEqual({
      name: "platform",
      path: resolvedWorkspacePath,
      mode: "workspace",
    });
    expect(output.repos).toEqual([]);
    expect(output.folders).toEqual([]);
    expect(output.session.status).toBe("active");
  });

  it("prints workspace view from a subdirectory of the workspace", async () => {
    const root = await tempDir();
    const workspacePath = path.join(root, "platform");
    const sessionPath = path.join(root, ".cache", "current-session.yml");
    await initWorkspace({
      cwd: root,
      mode: "workspace",
      workspaceName: "platform",
      workspacePath,
      interactive: false,
      yes: true,
      sessionPath,
    });

    const nested = path.join(workspacePath, "wiki", "changes");
    await mkdir(nested, { recursive: true });
    const result = await showWorkspace({ cwd: nested, json: true, sessionPath });
    const output = JSON.parse(result.message);
    const resolvedWorkspacePath = await realpath(workspacePath);

    expect(output.workspace?.path).toBe(resolvedWorkspacePath);
    expect(output.repos).toEqual([]);
  });

  it("prints workspace view in workspace mode without an active session", async () => {
    const root = await tempDir();
    const workspacePath = path.join(root, "platform");
    const sessionPath = path.join(root, ".cache", "current-session.yml");
    await initWorkspace({
      cwd: root,
      mode: "workspace",
      workspaceName: "platform",
      workspacePath,
      interactive: false,
      yes: true,
      sessionPath,
    });

    const isolatedSessionPath = path.join(root, ".cache", "no-session.yml");
    const result = await showWorkspace({ cwd: workspacePath, json: true, sessionPath: isolatedSessionPath });
    const output = JSON.parse(result.message);
    const resolvedWorkspacePath = await realpath(workspacePath);

    expect(result.status).toBe("ok");
    expect(output.session).toBeNull();
    expect(output.workspace).toEqual({
      name: "platform",
      path: resolvedWorkspacePath,
      mode: "workspace",
    });
    expect(output.repos).toEqual([]);
  });

  it("returns not_initialized when no workspace.yml and no session exist", async () => {
    const outsidePath = await tempDir();
    const isolatedSessionPath = path.join(outsidePath, ".cache", "no-session.yml");

    const result = await showWorkspace({ cwd: outsidePath, json: true, sessionPath: isolatedSessionPath });
    const output = JSON.parse(result.message);

    expect(result.status).toBe("not_initialized");
    expect(output.session).toBeNull();
    expect(output.workspace).toBeNull();
    expect(output.folders).toEqual([]);
  });

  it("derives the repo root in repo mode when workspace.yml exists but no session", async () => {
    const root = await tempDir();
    const repoPath = path.join(root, "app-repo");
    const isolatedSessionPath = path.join(root, ".cache", "no-session.yml");
    await mkdir(repoPath, { recursive: true });
    await mkdir(path.join(repoPath, ".weave"), { recursive: true });
    await writeFile(
      path.join(repoPath, ".weave", "workspace.yml"),
      "version: 1\nmode: repo\nname: app-repo\nrepos: {}\n",
    );

    const result = await showWorkspace({ cwd: repoPath, json: true, sessionPath: isolatedSessionPath });
    const output = JSON.parse(result.message);
    const resolvedRepoPath = await realpath(repoPath);

    expect(result.status).toBe("ok");
    expect(output.session).toBeNull();
    expect(output.workspace).toBeNull();
    expect(output.folders).toHaveLength(1);
    expect(output.folders[0]).toMatchObject({
      id: "app-repo",
      path: resolvedRepoPath,
      kind: "app",
      wiki: path.join(resolvedRepoPath, "wiki"),
      metadata: path.join(resolvedRepoPath, ".weave"),
    });
    await expect(stat(isolatedSessionPath)).rejects.toThrow();
  });

  it("shows adopted repo in weave workspace after init", async () => {
    const root = await tempDir();
    const repo = path.join(root, "app-repo");
    const workspacePath = path.join(root, "peoplebox-platform");
    const sessionPath = path.join(root, ".cache", "current-session.yml");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init"]);
    await git(repo, ["remote", "add", "origin", "git@example.com:peoplebox/app-repo.git"]);

    await initWorkspace({
      cwd: repo,
      mode: "workspace",
      workspaceName: "peoplebox-platform",
      interactive: false,
      yes: true,
      sessionPath,
    });

    const result = await showWorkspace({ cwd: workspacePath, json: true, sessionPath });
    const output = JSON.parse(result.message);
    const resolvedWorkspacePath = await realpath(workspacePath);

    expect(output.workspace).toEqual({
      name: "peoplebox-platform",
      path: resolvedWorkspacePath,
      mode: "workspace",
    });
    expect(output.repos).toEqual([
      {
        id: "app-repo",
        path: "app-repo",
        kind: "app",
        availability: "present",
        remote: "git@example.com:peoplebox/app-repo.git",
      },
    ]);
    expect(result.text).toContain("Repos:");
    expect(result.text).toContain("app-repo");
    expect(result.text).toContain("present");
  });

  it("shows missing registered workspace repos without throwing", async () => {
    const root = await tempDir();
    const workspacePath = path.join(root, "platform");
    const presentRepo = path.join(workspacePath, "present-app");
    const sessionPath = path.join(root, ".cache", "current-session.yml");
    await initWorkspace({
      cwd: root,
      mode: "workspace",
      workspaceName: "platform",
      workspacePath,
      interactive: false,
      yes: true,
      sessionPath,
    });
    await mkdir(presentRepo, { recursive: true });
    await writeFile(
      path.join(workspacePath, ".weave", "workspace.yml"),
      YAML.stringify({
        version: 1,
        mode: "workspace",
        name: "platform",
        repos: {
          "present-app": {
            path: "present-app",
            kind: "app",
          },
          "missing-api": {
            path: "missing-api",
            kind: "api",
            remote: "git@example.com:peoplebox/missing-api.git",
          },
        },
      }),
    );

    const result = await showWorkspace({ cwd: workspacePath, json: true, sessionPath });
    const output = JSON.parse(result.message);

    expect(output.repos).toEqual([
      {
        id: "present-app",
        path: "present-app",
        kind: "app",
        availability: "present",
      },
      {
        id: "missing-api",
        path: "missing-api",
        kind: "api",
        availability: "missing",
        remote: "git@example.com:peoplebox/missing-api.git",
      },
    ]);
    expect(result.text).toContain("present-app");
    expect(result.text).toContain("present");
    expect(result.text).toContain("missing-api");
    expect(result.text).toContain("missing");
  });

  it("registers an in-workspace path via weave add in workspace mode", async () => {
    const root = await tempDir();
    const workspacePath = path.join(root, "platform");
    const billing = path.join(workspacePath, "billing");
    const sessionPath = path.join(root, ".cache", "current-session.yml");

    await initWorkspace({
      cwd: root,
      mode: "workspace",
      workspaceName: "platform",
      workspacePath,
      interactive: false,
      yes: true,
      sessionPath,
    });

    await mkdir(billing, { recursive: true });
    await git(billing, ["init"]);
    await git(billing, ["remote", "add", "origin", "git@example.com:peoplebox/billing.git"]);

    const added = await addFolder({
      cwd: workspacePath,
      targetPath: "./billing",
      folderKind: "app",
      sessionPath,
    });

    const workspace = YAML.parse(await readFile(path.join(workspacePath, ".weave", "workspace.yml"), "utf8"));
    const gitignore = await readFile(path.join(workspacePath, ".gitignore"), "utf8");
    const session = await loadCurrentSession(sessionPath);

    expect(added.status).toBe("added");
    expect(workspace.repos.billing).toMatchObject({
      path: "billing",
      kind: "app",
      remote: "git@example.com:peoplebox/billing.git",
    });
    expect(gitignore).toContain("/billing/");
    expect(Object.keys(session?.folders ?? {})).toEqual(["platform"]);
  });

  it("registers a non-git in-workspace folder without remote", async () => {
    const root = await tempDir();
    const workspacePath = path.join(root, "platform");
    const notes = path.join(workspacePath, "shared-notes");
    const sessionPath = path.join(root, ".cache", "current-session.yml");

    await initWorkspace({
      cwd: root,
      mode: "workspace",
      workspaceName: "platform",
      workspacePath,
      interactive: false,
      yes: true,
      sessionPath,
    });

    await mkdir(notes);

    const added = await addFolder({ cwd: workspacePath, targetPath: "./shared-notes", sessionPath });
    const workspace = YAML.parse(await readFile(path.join(workspacePath, ".weave", "workspace.yml"), "utf8"));

    expect(added.status).toBe("added");
    expect(workspace.repos["shared-notes"]).toMatchObject({
      path: "shared-notes",
      kind: "app",
    });
    expect(workspace.repos["shared-notes"].remote).toBeUndefined();
  });

  it("adopts an outside folder into the workspace via weave add", async () => {
    const root = await tempDir();
    const workspacePath = path.join(root, "platform");
    const external = path.join(root, "external-tooling");
    const sessionPath = path.join(root, ".cache", "current-session.yml");

    await initWorkspace({
      cwd: root,
      mode: "workspace",
      workspaceName: "platform",
      workspacePath,
      interactive: false,
      yes: true,
      sessionPath,
    });

    await mkdir(external, { recursive: true });
    await git(external, ["init"]);
    await writeFile(path.join(external, "marker.txt"), "keep\n");

    const added = await addFolder({ cwd: workspacePath, targetPath: "../external-tooling", sessionPath });
    const workspace = YAML.parse(await readFile(path.join(workspacePath, ".weave", "workspace.yml"), "utf8"));
    const movedPath = path.join(workspacePath, "external-tooling");

    expect(added.status).toBe("added");
    await expect(stat(external)).rejects.toThrow();
    await expect(readFile(path.join(movedPath, "marker.txt"), "utf8")).resolves.toBe("keep\n");
    expect(workspace.repos["external-tooling"]).toMatchObject({
      path: "external-tooling",
      kind: "app",
    });
  });

  it("materializes a missing registered workspace repo from a local path without rewriting metadata", async () => {
    const root = await tempDir();
    const workspacePath = path.join(root, "platform");
    const external = path.join(root, "external-tooling");
    const sessionPath = path.join(root, ".cache", "current-session.yml");

    await initWorkspace({
      cwd: root,
      mode: "workspace",
      workspaceName: "platform",
      workspacePath,
      interactive: false,
      yes: true,
      sessionPath,
    });

    await mkdir(external, { recursive: true });
    await git(external, ["init"]);
    await writeFile(path.join(external, "marker.txt"), "keep\n");

    const workspaceYmlPath = path.join(workspacePath, ".weave", "workspace.yml");
    const gitignorePath = path.join(workspacePath, ".gitignore");
    await writeFile(
      workspaceYmlPath,
      YAML.stringify({
        version: 1,
        mode: "workspace",
        name: "platform",
        repos: {
          "external-tooling": {
            path: "external-tooling",
            kind: "app",
            remote: "git@example.com:peoplebox/external-tooling.git",
          },
        },
      }),
    );
    await writeFile(gitignorePath, ".DS_Store\nnode_modules/\n/external-tooling/\n");

    const workspaceBefore = await readFile(workspaceYmlPath, "utf8");
    const gitignoreBefore = await readFile(gitignorePath, "utf8");

    const added = await addFolder({ cwd: workspacePath, targetPath: "../external-tooling", sessionPath });
    const movedPath = path.join(workspacePath, "external-tooling");

    expect(added.status).toBe("added");
    expect(added.message).toContain("Materialized registered repo");
    await expect(stat(external)).rejects.toThrow();
    await expect(readFile(path.join(movedPath, "marker.txt"), "utf8")).resolves.toBe("keep\n");
    await expect(readFile(workspaceYmlPath, "utf8")).resolves.toBe(workspaceBefore);
    await expect(readFile(gitignorePath, "utf8")).resolves.toBe(gitignoreBefore);
  });

  it("clones and registers a repo by git URL via weave add", async () => {
    const root = await tempDir();
    const workspacePath = path.join(root, "platform");
    const source = path.join(root, "source-repo");
    const bare = path.join(root, "billing.git");
    const sessionPath = path.join(root, ".cache", "current-session.yml");

    await mkdir(source, { recursive: true });
    await git(source, ["init"]);
    await writeFile(path.join(source, "README.md"), "# billing\n");
    await git(source, ["add", "README.md"]);
    await git(source, ["commit", "-m", "init"]);
    await git(source, ["clone", "--bare", source, bare]);

    await initWorkspace({
      cwd: root,
      mode: "workspace",
      workspaceName: "platform",
      workspacePath,
      interactive: false,
      yes: true,
      sessionPath,
    });

    const bareUrl = (await realpath(bare)).replace(/\\/g, "/");
    const fileUrl = `file://${bareUrl}`;

    const added = await addFolder({
      cwd: workspacePath,
      targetPath: fileUrl,
      sessionPath,
    });

    const workspace = YAML.parse(await readFile(path.join(workspacePath, ".weave", "workspace.yml"), "utf8"));
    const gitignore = await readFile(path.join(workspacePath, ".gitignore"), "utf8");

    expect(added.status).toBe("added");
    await expect(stat(path.join(workspacePath, "billing"))).resolves.toMatchObject({});
    expect(workspace.repos.billing).toMatchObject({
      path: "billing",
      kind: "app",
      remote: fileUrl,
    });
    expect(gitignore).toContain("/billing/");
  });

  it("materializes a missing registered workspace repo from a git URL without rewriting metadata", async () => {
    const root = await tempDir();
    const workspacePath = path.join(root, "platform");
    const source = path.join(root, "source-repo");
    const bare = path.join(root, "billing.git");
    const sessionPath = path.join(root, ".cache", "current-session.yml");

    await mkdir(source, { recursive: true });
    await git(source, ["init"]);
    await writeFile(path.join(source, "README.md"), "# billing\n");
    await git(source, ["add", "README.md"]);
    await git(source, ["commit", "-m", "init"]);
    await git(source, ["clone", "--bare", source, bare]);

    await initWorkspace({
      cwd: root,
      mode: "workspace",
      workspaceName: "platform",
      workspacePath,
      interactive: false,
      yes: true,
      sessionPath,
    });

    const workspaceYmlPath = path.join(workspacePath, ".weave", "workspace.yml");
    const gitignorePath = path.join(workspacePath, ".gitignore");
    await writeFile(
      workspaceYmlPath,
      YAML.stringify({
        version: 1,
        mode: "workspace",
        name: "platform",
        repos: {
          billing: {
            path: "billing",
            kind: "app",
            remote: "git@example.com:peoplebox/billing.git",
          },
        },
      }),
    );
    await writeFile(gitignorePath, ".DS_Store\nnode_modules/\n/billing/\n");

    const workspaceBefore = await readFile(workspaceYmlPath, "utf8");
    const gitignoreBefore = await readFile(gitignorePath, "utf8");
    const bareUrl = (await realpath(bare)).replace(/\\/g, "/");
    const fileUrl = `file://${bareUrl}`;

    const added = await addFolder({ cwd: workspacePath, targetPath: fileUrl, sessionPath });

    expect(added.status).toBe("added");
    expect(added.message).toContain("Materialized registered repo");
    await expect(stat(path.join(workspacePath, "billing"))).resolves.toMatchObject({});
    await expect(readFile(path.join(workspacePath, "billing", "README.md"), "utf8")).resolves.toBe("# billing\n");
    await expect(readFile(workspaceYmlPath, "utf8")).resolves.toBe(workspaceBefore);
    await expect(readFile(gitignorePath, "utf8")).resolves.toBe(gitignoreBefore);
  });

  it("treats duplicate workspace add as already registered", async () => {
    const root = await tempDir();
    const workspacePath = path.join(root, "platform");
    const billing = path.join(workspacePath, "billing");
    const sessionPath = path.join(root, ".cache", "current-session.yml");

    await initWorkspace({
      cwd: root,
      mode: "workspace",
      workspaceName: "platform",
      workspacePath,
      interactive: false,
      yes: true,
      sessionPath,
    });
    await mkdir(billing);

    const first = await addFolder({ cwd: workspacePath, targetPath: "./billing", sessionPath });
    const second = await addFolder({
      cwd: workspacePath,
      targetPath: "./billing",
      folderId: "billing-copy",
      sessionPath,
    });

    expect(first.status).toBe("added");
    expect(second.status).toBe("already_exists");
  });

  it("refuses git URL weave add when destination already exists", async () => {
    const root = await tempDir();
    const workspacePath = path.join(root, "platform");
    const source = path.join(root, "source-repo");
    const bare = path.join(root, "billing.git");
    const billingDir = path.join(workspacePath, "billing");
    const sessionPath = path.join(root, ".cache", "current-session.yml");

    await mkdir(source, { recursive: true });
    await git(source, ["init"]);
    await writeFile(path.join(source, "README.md"), "# billing\n");
    await git(source, ["add", "README.md"]);
    await git(source, ["commit", "-m", "init"]);
    await git(source, ["clone", "--bare", source, bare]);

    await initWorkspace({
      cwd: root,
      mode: "workspace",
      workspaceName: "platform",
      workspacePath,
      interactive: false,
      yes: true,
      sessionPath,
    });
    await mkdir(billingDir);

    const bareUrl = (await realpath(bare)).replace(/\\/g, "/");
    const fileUrl = `file://${bareUrl}`;

    await expect(addFolder({ cwd: workspacePath, targetPath: fileUrl, sessionPath })).rejects.toThrow(
      /Destination already exists/,
    );
  });

  it("degrades gracefully to repo mode when workspace.yml is malformed", async () => {
    const root = await tempDir();
    const workspacePath = path.join(root, "platform");
    const sessionPath = path.join(root, ".cache", "current-session.yml");

    await initWorkspace({
      cwd: root,
      mode: "workspace",
      workspaceName: "platform",
      workspacePath,
      interactive: false,
      yes: true,
      sessionPath,
    });

    await writeFile(path.join(workspacePath, ".weave", "workspace.yml"), ":\n");

    const result = await showWorkspace({ cwd: workspacePath, json: true, sessionPath });
    const output = JSON.parse(result.message);

    expect(result.status).toBe("ok");
    expect(output.workspace).toBeNull();
    expect(output.repos).toEqual([]);
    expect(result.text).toContain("Folders:");
  });

  it("returns already_initialized in repo mode without re-scaffolding or writing a session", async () => {
    const root = await tempDir();
    const repoPath = path.join(root, "app-repo");
    const sessionPath = path.join(root, ".cache", "current-session.yml");
    await mkdir(repoPath, { recursive: true });
    await mkdir(path.join(repoPath, ".weave"), { recursive: true });
    await writeFile(
      path.join(repoPath, ".weave", "workspace.yml"),
      "version: 1\nmode: repo\nname: app-repo\nrepos: {}\n",
    );

    const isolatedSessionPath = path.join(root, ".cache", "isolated-session.yml");
    const result = await initWorkspace({
      cwd: repoPath,
      interactive: false,
      yes: true,
      sessionPath: isolatedSessionPath,
    });

    expect(result.status).toBe("already_initialized");
    expect(result.mode).toBe("repo");
    expect(result.message).toContain("already initialized");
    expect(result.message).toContain("weave change new");
    await expect(stat(isolatedSessionPath)).rejects.toThrow();
    await expect(stat(path.join(repoPath, "wiki"))).rejects.toThrow();
    await expect(stat(path.join(repoPath, ".weave", "sync.yml"))).rejects.toThrow();
  });

  it("returns already_initialized in workspace mode without moving the repo", async () => {
    const root = await tempDir();
    const workspacePath = path.join(root, "platform");
    const sessionPath = path.join(root, ".cache", "current-session.yml");

    await initWorkspace({
      cwd: root,
      mode: "workspace",
      workspaceName: "platform",
      workspacePath,
      interactive: false,
      yes: true,
      sessionPath,
    });

    const resolvedWorkspacePath = await realpath(workspacePath);
    const isolatedSessionPath = path.join(root, ".cache", "isolated-session.yml");
    const before = await readFile(path.join(workspacePath, ".weave", "workspace.yml"), "utf8");

    const result = await initWorkspace({
      cwd: workspacePath,
      interactive: false,
      yes: true,
      sessionPath: isolatedSessionPath,
    });

    expect(result.status).toBe("already_initialized");
    expect(result.mode).toBe("workspace");
    expect(result.folderPath).toBe(resolvedWorkspacePath);
    await expect(readFile(path.join(workspacePath, ".weave", "workspace.yml"), "utf8")).resolves.toBe(before);
    await expect(stat(isolatedSessionPath)).rejects.toThrow();
  });

  it("returns already_initialized from a nested subdirectory of an initialized workspace", async () => {
    const root = await tempDir();
    const workspacePath = path.join(root, "platform");
    const sessionPath = path.join(root, ".cache", "current-session.yml");

    await initWorkspace({
      cwd: root,
      mode: "workspace",
      workspaceName: "platform",
      workspacePath,
      interactive: false,
      yes: true,
      sessionPath,
    });

    const nested = path.join(workspacePath, "wiki", "changes");
    await mkdir(nested, { recursive: true });
    const isolatedSessionPath = path.join(root, ".cache", "isolated-session.yml");

    const result = await initWorkspace({
      cwd: nested,
      interactive: false,
      yes: true,
      sessionPath: isolatedSessionPath,
    });

    expect(result.status).toBe("already_initialized");
    expect(result.mode).toBe("workspace");
    await expect(stat(isolatedSessionPath)).rejects.toThrow();
  });

  it("succeeds on a fresh workspace-mode clone without weave init (no session)", async () => {
    const root = await tempDir();
    const workspacePath = path.join(root, "platform");
    const sessionPath = path.join(root, ".cache", "current-session.yml");

    await initWorkspace({
      cwd: root,
      mode: "workspace",
      workspaceName: "platform",
      workspacePath,
      interactive: false,
      yes: true,
      sessionPath,
    });

    const isolatedSessionPath = path.join(root, ".cache", "clone-session.yml");
    const resolvedWorkspacePath = await realpath(workspacePath);

    const ws = await showWorkspace({ cwd: workspacePath, json: true, sessionPath: isolatedSessionPath });
    const wsOutput = JSON.parse(ws.message);
    expect(ws.status).toBe("ok");
    expect(wsOutput.workspace).toEqual({
      name: "platform",
      path: resolvedWorkspacePath,
      mode: "workspace",
    });
    expect(wsOutput.session).toBeNull();
    await expect(stat(isolatedSessionPath)).rejects.toThrow();
  });

  it("lazily creates a target-only session when adding to a repo-mode clone with no session", async () => {
    const root = await tempDir();
    const repoPath = path.join(root, "app-repo");
    const initSessionPath = path.join(root, ".cache", "init-session.yml");
    await mkdir(repoPath, { recursive: true });

    await initWorkspace({
      cwd: repoPath,
      mode: "repo",
      interactive: false,
      yes: true,
      folderId: "app-repo",
      sessionPath: initSessionPath,
    });

    const backend = path.join(root, "backend");
    await mkdir(backend);
    const cloneSessionPath = path.join(root, ".cache", "clone-session.yml");

    const added = await addFolder({
      cwd: repoPath,
      targetPath: "../backend",
      folderId: "backend",
      folderKind: "api",
      sessionPath: cloneSessionPath,
      now: new Date("2026-07-21T12:00:00.000Z"),
    });

    expect(added.status).toBe("added");
    const session = await loadCurrentSession(cloneSessionPath);
    const resolvedBackend = await realpath(backend);
    expect(session?.folders.backend).toMatchObject({
      path: resolvedBackend,
      name: "Backend",
      kind: "api",
    });
    expect(Object.keys(session?.folders ?? {})).toEqual(["backend"]);
  });

  it("shows the derived repo root when running weave workspace on a repo-mode clone with no session", async () => {
    const root = await tempDir();
    const repoPath = path.join(root, "app-repo");
    const initSessionPath = path.join(root, ".cache", "init-session.yml");
    await mkdir(repoPath, { recursive: true });

    await initWorkspace({
      cwd: repoPath,
      mode: "repo",
      interactive: false,
      yes: true,
      folderId: "app-repo",
      sessionPath: initSessionPath,
    });

    const cloneSessionPath = path.join(root, ".cache", "clone-session.yml");
    const result = await showWorkspace({ cwd: repoPath, json: true, sessionPath: cloneSessionPath });
    const output = JSON.parse(result.message);
    const resolvedRepoPath = await realpath(repoPath);

    expect(result.status).toBe("ok");
    expect(output.session).toBeNull();
    expect(output.folders).toHaveLength(1);
    expect(output.folders[0]).toMatchObject({
      id: "app-repo",
      path: resolvedRepoPath,
      kind: "app",
    });
    await expect(stat(cloneSessionPath)).rejects.toThrow();
  });

  it("end-to-end fresh-clone workflow works without weave init", async () => {
    const root = await tempDir();
    const workspacePath = path.join(root, "platform");
    const initSessionPath = path.join(root, ".cache", "init-session.yml");

    await initWorkspace({
      cwd: root,
      mode: "workspace",
      workspaceName: "platform",
      workspacePath,
      interactive: false,
      yes: true,
      sessionPath: initSessionPath,
    });

    const cloneSessionPath = path.join(root, ".cache", "clone-session.yml");
    const resolvedWorkspacePath = await realpath(workspacePath);

    const ws = await showWorkspace({ cwd: workspacePath, json: true, sessionPath: cloneSessionPath });
    expect(ws.status).toBe("ok");
    expect(JSON.parse(ws.message).workspace?.path).toBe(resolvedWorkspacePath);
    await expect(stat(cloneSessionPath)).rejects.toThrow();

    const change = await currentChange({ cwd: workspacePath, sessionPath: cloneSessionPath });
    expect(change.status).toBe("ok");
    expect(change.targets).toHaveLength(1);
    expect(change.targets[0].path).toBe(resolvedWorkspacePath);
    expect(change.targets[0].resolution).not.toBe("invalid_active_branch");
    await expect(stat(cloneSessionPath)).rejects.toThrow();
  });
});
