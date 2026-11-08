import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { readAttention } from "../src/lib/change-attention.js";
import { closeChange, createChange, listChanges, setupChange, statusChange, switchChange } from "../src/lib/changes.js";
import { readBases } from "../src/lib/change-bases.js";
import { pathExists } from "../src/lib/files.js";
import { prepareTasks } from "../src/lib/task-prepare.js";
import { registerRepoInWorkspaceMetadata } from "../src/lib/workspace-repos.js";

const execFileAsync = promisify(execFile);
const now = new Date("2026-11-07T10:00:00.000Z");
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Weave Test",
  GIT_AUTHOR_EMAIL: "weave@example.com",
  GIT_COMMITTER_NAME: "Weave Test",
  GIT_COMMITTER_EMAIL: "weave@example.com",
};

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv });
  return stdout.trim();
}

async function tempRoot(): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), "weave-worktrees-")));
}

interface Fixture {
  base: string;
  workspace: string;
  sessionPath: string;
}

// A workspace repo with two registered repos, each cloned from its own bare origin.
async function workspaceFixture(options: { checkout?: "worktree" | "in-place"; commitWeave?: boolean } = {}): Promise<Fixture> {
  const base = await tempRoot();
  const workspace = path.join(base, "acme");
  await mkdir(workspace);
  await git(workspace, ["init", "-b", "main"]);
  await mkdir(path.join(workspace, ".weave"));
  await writeFile(
    path.join(workspace, ".weave", "workspace.yml"),
    YAML.stringify({
      version: 1,
      mode: "workspace",
      name: "acme",
      checkout: options.checkout ?? "worktree",
      repos: {
        api: { path: "api", kind: "app", copy: [".env"], setup: "echo \"slot=$WEAVE_SLOT repo=$WEAVE_REPO_ID\" > setup-ran.txt" },
        web: { path: "web", kind: "app" },
      },
    }),
  );
  await writeFile(path.join(workspace, ".gitignore"), "/api/\n/web/\n");
  if (options.commitWeave !== false) {
    await git(workspace, ["add", "."]);
  } else {
    await git(workspace, ["add", ".gitignore"]);
  }
  await git(workspace, ["commit", "-m", "workspace"]);

  for (const repo of ["api", "web"]) {
    const origin = path.join(base, "origins", `${repo}.git`);
    await mkdir(origin, { recursive: true });
    await git(origin, ["init", "--bare", "-b", "main"]);
    await git(workspace, ["clone", "--quiet", origin, repo]);
    const repoPath = path.join(workspace, repo);
    await writeFile(path.join(repoPath, "README.md"), `${repo}\n`);
    await writeFile(path.join(repoPath, ".gitignore"), ".env\nsetup-ran.txt\n");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", `${repo} initial`]);
    await git(repoPath, ["push", "--quiet", "-u", "origin", "main"]);
  }
  await writeFile(path.join(workspace, "api", ".env"), "SECRET=local\n");

  return { base, workspace, sessionPath: path.join(base, "session.yml") };
}

async function readStatus(changePath: string): Promise<Record<string, unknown>> {
  return YAML.parse(await readFile(path.join(changePath, "status.yml"), "utf8")) as Record<string, unknown>;
}

async function pushFromSecondClone(fixture: Fixture, repo: string, message: string): Promise<string> {
  const clone = path.join(fixture.base, `${repo}-second`);
  await git(fixture.base, ["clone", "--quiet", path.join(fixture.base, "origins", `${repo}.git`), clone]);
  await writeFile(path.join(clone, "later.txt"), `${message}\n`);
  await git(clone, ["add", "."]);
  await git(clone, ["commit", "-m", message]);
  await git(clone, ["push", "--quiet", "origin", "main"]);
  return git(clone, ["rev-parse", "HEAD"]);
}

describe("worktree checkouts", () => {
  it("creates a change folder with a worktree per repo and leaves the main checkouts alone", async () => {
    const fixture = await workspaceFixture();
    // Someone's unfinished work in the main checkouts must not move or leak into the change.
    await writeFile(path.join(fixture.workspace, "api", "wip.txt"), "uncommitted\n");
    await git(path.join(fixture.workspace, "web"), ["checkout", "-b", "feature/someone-else"]);
    await writeFile(path.join(fixture.workspace, "web", "feature.txt"), "feature\n");
    await git(path.join(fixture.workspace, "web"), ["add", "."]);
    await git(path.join(fixture.workspace, "web"), ["commit", "-m", "unrelated work"]);
    const latestApi = await pushFromSecondClone(fixture, "api", "pushed after the clone");

    const created = await createChange({ cwd: fixture.workspace, title: "Login", now, randomId: () => "a1b2", sessionPath: fixture.sessionPath });

    const folder = path.join(fixture.base, "acme.changes", created.id);
    expect(created).toMatchObject({ checkout: "worktree", folder, slot: 1, copied: [path.join("api", ".env")] });
    expect(created.repos?.map((repo) => [repo.id, repo.status])).toEqual([
      ["root", "created"],
      ["api", "created"],
      ["web", "created"],
    ]);
    for (const repo of [".", "api", "web"]) {
      expect(await git(path.join(folder, repo), ["branch", "--show-current"])).toBe(created.branch);
    }
    // Starts from the freshly fetched remote default branch, not whatever was checked out.
    expect(await git(path.join(folder, "api"), ["rev-parse", "HEAD"])).toBe(latestApi);
    expect(await pathExists(path.join(folder, "web", "feature.txt"))).toBe(false);
    expect(await pathExists(path.join(folder, "api", "wip.txt"))).toBe(false);
    expect(await readFile(path.join(folder, "api", ".env"), "utf8")).toBe("SECRET=local\n");

    expect(await git(fixture.workspace, ["branch", "--show-current"])).toBe("main");
    expect(await git(path.join(fixture.workspace, "web"), ["branch", "--show-current"])).toBe("feature/someone-else");
    expect(await git(path.join(fixture.workspace, "api"), ["status", "--porcelain"])).toBe("?? wip.txt");

    const status = await readStatus(path.join(folder, "wiki", "changes", created.id));
    expect(status.checkout).toMatchObject({
      mode: "worktree",
      repos: {
        root: { path: ".", base: "main" },
        api: { path: "api", base: "origin/main", base_commit: latestApi },
        web: { path: "web", base: "origin/main" },
      },
    });
  });

  it("starts one repo from another branch, even one that only exists on origin", async () => {
    const fixture = await workspaceFixture();
    const clone = path.join(fixture.base, "api-teammate");
    await git(fixture.base, ["clone", "--quiet", path.join(fixture.base, "origins", "api.git"), clone]);
    await git(clone, ["checkout", "-b", "feature/x"]);
    await writeFile(path.join(clone, "feature.txt"), "teammate work\n");
    await git(clone, ["add", "."]);
    await git(clone, ["commit", "-m", "teammate work"]);
    await git(clone, ["push", "--quiet", "origin", "feature/x"]);
    const featureCommit = await git(clone, ["rev-parse", "HEAD"]);

    const created = await createChange({
      cwd: fixture.workspace,
      title: "Login",
      repoBases: { api: "feature/x" },
      now,
      randomId: () => "a1b2",
      sessionPath: fixture.sessionPath,
    });

    expect(created.repos?.map((repo) => [repo.id, repo.base])).toEqual([
      ["root", "main"],
      ["api", "origin/feature/x"],
      ["web", "origin/main"],
    ]);
    expect(await git(path.join(created.folder!, "api"), ["rev-parse", "HEAD"])).toBe(featureCommit);
  });

  it("blocks a shared base that one repo does not have, and says how to scope it", async () => {
    const fixture = await workspaceFixture();
    await git(path.join(fixture.workspace, "api"), ["branch", "feature/x"]);

    await expect(
      createChange({ cwd: fixture.workspace, title: "Login", base: "feature/x", now, randomId: () => "a1b2", sessionPath: fixture.sessionPath }),
    ).rejects.toThrow(/feature\/x was not found in root[\s\S]*--base <repo>=feature\/x/);
    expect(await pathExists(path.join(fixture.base, "acme.changes"))).toBe(false);
  });

  it("refuses to create anything when the Weave setup is not committed on the base branch", async () => {
    const fixture = await workspaceFixture({ commitWeave: false });

    await expect(
      createChange({ cwd: fixture.workspace, title: "Login", now, randomId: () => "a1b2", sessionPath: fixture.sessionPath }),
    ).rejects.toMatchObject({ code: "worktree_blocked" });
    expect(await pathExists(path.join(fixture.base, "acme.changes"))).toBe(false);
    expect(await git(path.join(fixture.workspace, "api"), ["branch", "--list", "change/*"])).toBe("");
  });

  it("removes every worktree and branch it created when a later repo fails", async () => {
    const fixture = await workspaceFixture();
    const hook = path.join(fixture.workspace, "web", ".git", "hooks", "post-checkout");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);

    await expect(
      createChange({ cwd: fixture.workspace, title: "Login", now, randomId: () => "a1b2", sessionPath: fixture.sessionPath }),
    ).rejects.toMatchObject({ code: "worktree_failed" });

    expect(await pathExists(path.join(fixture.base, "acme.changes", "261107-a1b2-login"))).toBe(false);
    for (const repo of [fixture.workspace, path.join(fixture.workspace, "api"), path.join(fixture.workspace, "web")]) {
      expect(await git(repo, ["branch", "--list", "change/*"])).toBe("");
      expect((await git(repo, ["worktree", "list"])).split("\n")).toHaveLength(1);
    }
  });

  it("limits worktrees to the requested repos and adds the rest later through prepare", async () => {
    const fixture = await workspaceFixture();
    const created = await createChange({ cwd: fixture.workspace, title: "Login", repos: ["api"], now, randomId: () => "a1b2", sessionPath: fixture.sessionPath });
    expect(created.repos?.map((repo) => repo.id)).toEqual(["root", "api"]);

    const prepared = await prepareTasks({ cwd: created.folder!, now, sessionPath: fixture.sessionPath });

    expect(prepared.status).toBe("ok");
    expect(prepared.repos.map((repo) => [repo.id, repo.branch_status])).toEqual([
      ["api", "already_active"],
      ["web", "created"],
    ]);
    expect(await git(path.join(created.folder!, "web"), ["branch", "--show-current"])).toBe(created.branch);
  });

  it("lists change folders from the main checkout and reopens them without switching branches", async () => {
    const fixture = await workspaceFixture();
    const login = await createChange({ cwd: fixture.workspace, title: "Login", now, randomId: () => "a1b2", sessionPath: fixture.sessionPath });
    const billing = await createChange({ cwd: fixture.workspace, title: "Billing", now, randomId: () => "c3d4", sessionPath: fixture.sessionPath });

    const listed = await listChanges({ cwd: fixture.workspace, sessionPath: fixture.sessionPath });
    expect(listed.targets[0]!.changes.map((change) => [change.id, change.folder, change.slot])).toEqual(
      expect.arrayContaining([
        [login.id, login.folder, 1],
        [billing.id, billing.folder, 2],
      ]),
    );

    const switched = await switchChange({ cwd: fixture.workspace, change: "a1b2", sessionPath: fixture.sessionPath });
    expect(switched.folder).toBe(login.folder);
    expect(switched.repos?.every((repo) => repo.status === "reused")).toBe(true);
    expect(await git(fixture.workspace, ["branch", "--show-current"])).toBe("main");
  });

  it("opens a teammate's pushed change that this machine has never seen", async () => {
    const fixture = await workspaceFixture();
    const rootOrigin = path.join(fixture.base, "origins", "root.git");
    await mkdir(rootOrigin, { recursive: true });
    await git(rootOrigin, ["init", "--bare", "-b", "main"]);
    await git(fixture.workspace, ["remote", "add", "origin", rootOrigin]);
    await git(fixture.workspace, ["push", "--quiet", "-u", "origin", "main"]);

    // The teammate clones the workspace, starts a change, commits, and pushes root and api.
    const teammate = path.join(fixture.base, "teammate", "acme");
    await git(fixture.base, ["clone", "--quiet", rootOrigin, teammate]);
    for (const repo of ["api", "web"]) {
      await git(teammate, ["clone", "--quiet", path.join(fixture.base, "origins", `${repo}.git`), repo]);
    }
    const theirs = await createChange({ cwd: teammate, title: "Billing export", now, randomId: () => "t3am", sessionPath: path.join(fixture.base, "teammate.yml") });
    await writeFile(path.join(theirs.folder!, "api", "export.ts"), "export {};\n");
    for (const repo of [".", "api"]) {
      await git(path.join(theirs.folder!, repo), ["add", "."]);
      await git(path.join(theirs.folder!, repo), ["commit", "-m", "billing export"]);
      await git(path.join(theirs.folder!, repo), ["push", "--quiet", "-u", "origin", theirs.branch]);
    }

    const opened = await switchChange({ cwd: fixture.workspace, change: "t3am", sessionPath: fixture.sessionPath });

    expect(opened.change).toMatchObject({ id: theirs.id, title: "Billing export" });
    expect(opened.repos?.map((repo) => [repo.id, repo.status, repo.base])).toEqual([
      ["root", "created", undefined],
      ["api", "created", undefined],
      ["web", "created", "origin/main"],
    ]);
    expect(await readFile(path.join(opened.folder!, "api", "export.ts"), "utf8")).toBe("export {};\n");
    expect(await git(path.join(opened.folder!, "api"), ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(`origin/${theirs.branch}`);
    expect(await git(path.join(opened.folder!, "web"), ["branch", "--show-current"])).toBe(theirs.branch);
    expect(await git(fixture.workspace, ["branch", "--show-current"])).toBe("main");
  });

  it("reopens a closed change from its kept branches", async () => {
    const fixture = await workspaceFixture();
    const created = await createChange({ cwd: fixture.workspace, title: "Login", now, randomId: () => "a1b2", sessionPath: fixture.sessionPath });
    await git(created.folder!, ["add", "."]);
    await git(created.folder!, ["commit", "-m", "change files"]);
    await closeChange({ cwd: fixture.workspace, change: created.id, sessionPath: fixture.sessionPath });

    const reopened = await switchChange({ cwd: fixture.workspace, change: "login", sessionPath: fixture.sessionPath });

    expect(reopened.folder).toBe(created.folder);
    expect(reopened.change.title).toBe("Login");
    expect(await pathExists(path.join(created.folder!, "wiki", "changes", created.id, "status.yml"))).toBe(true);
  });

  it("refuses to open a change branch that has no change files", async () => {
    const fixture = await workspaceFixture();
    await git(fixture.workspace, ["branch", "change/261107-zzzz-empty"]);

    await expect(switchChange({ cwd: fixture.workspace, change: "zzzz", sessionPath: fixture.sessionPath })).rejects.toMatchObject({ code: "not_a_change_branch" });
    expect(await pathExists(path.join(fixture.base, "acme.changes"))).toBe(false);
  });

  it("closes a change by removing its worktrees, keeping branches, and freeing its slot", async () => {
    const fixture = await workspaceFixture();
    const created = await createChange({ cwd: fixture.workspace, title: "Login", now, randomId: () => "a1b2", sessionPath: fixture.sessionPath });
    const folder = created.folder!;

    await expect(closeChange({ cwd: folder, change: created.id, sessionPath: fixture.sessionPath })).rejects.toMatchObject({ code: "worktree_blocked" });
    await writeFile(path.join(folder, "api", "unsaved.txt"), "work\n");
    await expect(closeChange({ cwd: fixture.workspace, change: created.id, sessionPath: fixture.sessionPath })).rejects.toThrow(/uncommitted change/);
    expect(await pathExists(path.join(folder, "api", "unsaved.txt"))).toBe(true);

    await git(path.join(folder, "api"), ["add", "."]);
    await git(path.join(folder, "api"), ["commit", "-m", "work"]);
    await git(folder, ["add", "."]);
    await git(folder, ["commit", "-m", "change files"]);
    const closed = await closeChange({ cwd: fixture.workspace, change: created.id, sessionPath: fixture.sessionPath });

    expect(closed.removed).toEqual(["api", "web", "root"]);
    expect(closed.branches.every((branch) => !branch.pushed)).toBe(true);
    expect(await pathExists(folder)).toBe(false);
    expect(await git(path.join(fixture.workspace, "api"), ["branch", "--list", created.branch])).toContain(created.branch);
    // The remembered starting branch outlives the folder.
    expect(await readBases(path.join(fixture.workspace, ".git", "weave"), created.id)).toMatchObject({ repos: { api: { source: "created" } } });

    const next = await createChange({ cwd: fixture.workspace, title: "Next", now, randomId: () => "e5f6", sessionPath: fixture.sessionPath });
    expect(next.slot).toBe(1);
  });

  it("remembers each repo's starting branch outside the change folder", async () => {
    const fixture = await workspaceFixture();
    const latestApi = await pushFromSecondClone(fixture, "api", "pushed after the clone");
    const created = await createChange({ cwd: fixture.workspace, title: "Login", now, randomId: () => "a1b2", sessionPath: fixture.sessionPath });

    const bases = await readBases(path.join(fixture.workspace, ".git", "weave"), created.id);
    expect(bases?.repos).toMatchObject({
      root: { base: "main", source: "created" },
      api: { base: "origin/main", base_commit: latestApi, source: "created" },
      web: { base: "origin/main", source: "created" },
    });
  });

  it("runs setup only after a person approves the exact command", async () => {
    const fixture = await workspaceFixture();
    const created = await createChange({ cwd: fixture.workspace, title: "Login", now, randomId: () => "a1b2", sessionPath: fixture.sessionPath });
    const cwd = created.folder!;

    const pending = await setupChange({ cwd, sessionPath: fixture.sessionPath });
    expect(pending.status).toBe("needs_approval");
    expect(pending.pending_approval.map((item) => item.repo)).toEqual(["api"]);
    await expect(setupChange({ cwd, approve: true, sessionPath: fixture.sessionPath })).rejects.toMatchObject({ code: "approval_needs_terminal" });
    expect((await setupChange({ cwd, approve: true, confirm: async () => false, sessionPath: fixture.sessionPath })).status).toBe("declined");

    const ran = await setupChange({ cwd, approve: true, confirm: async () => true, sessionPath: fixture.sessionPath });
    expect(ran.status).toBe("ok");
    expect(await readFile(path.join(cwd, "api", "setup-ran.txt"), "utf8")).toBe("slot=1 repo=api\n");
    expect((await setupChange({ cwd, sessionPath: fixture.sessionPath })).status).toBe("nothing_to_run");
  });

  it("gives a single repo its own change folder in repo mode", async () => {
    const base = await tempRoot();
    const origin = path.join(base, "app.git");
    await mkdir(origin);
    await git(origin, ["init", "--bare", "-b", "main"]);
    const repo = path.join(base, "app");
    await git(base, ["clone", "--quiet", origin, repo]);
    await mkdir(path.join(repo, ".weave"));
    await writeFile(path.join(repo, ".weave", "workspace.yml"), YAML.stringify({ version: 1, mode: "repo", name: "app", checkout: "worktree", repos: {} }));
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "weave"]);
    await git(repo, ["push", "--quiet", "-u", "origin", "main"]);

    const created = await createChange({ cwd: repo, title: "Login", now, randomId: () => "a1b2", sessionPath: path.join(base, "session.yml") });

    expect(created.folder).toBe(path.join(base, "app.changes", created.id));
    expect(created.repos?.map((item) => [item.id, item.base])).toEqual([["root", "origin/main"]]);
    expect(await git(repo, ["branch", "--show-current"])).toBe("main");
    expect(await pathExists(path.join(created.folder!, "wiki", "changes", created.id, "exploration.md"))).toBe(true);
  });

  it("keeps worktree settings when another repo is registered", async () => {
    const fixture = await workspaceFixture();
    await registerRepoInWorkspaceMetadata(fixture.workspace, { id: "docs", relativePath: "docs", kind: "docs" });

    const raw = YAML.parse(await readFile(path.join(fixture.workspace, ".weave", "workspace.yml"), "utf8"));
    expect(raw.checkout).toBe("worktree");
    expect(raw.repos.api).toMatchObject({ copy: [".env"], setup: expect.stringContaining("WEAVE_SLOT") });
    expect(raw.repos.docs).toEqual({ path: "docs", kind: "docs" });
  });
});

describe("missing change folders", () => {
  async function committedChange(fixture: Fixture, title: string, randomId: string) {
    const created = await createChange({ cwd: fixture.workspace, title, now, randomId: () => randomId, sessionPath: fixture.sessionPath });
    for (const repo of ["api", "web", "."]) {
      await writeFile(path.join(created.folder!, repo, `${randomId}.txt`), "work\n");
      await git(path.join(created.folder!, repo), ["add", "."]);
      await git(path.join(created.folder!, repo), ["commit", "-m", "work"]);
    }
    return created;
  }

  it("closes a hand-deleted folder: clears leftovers, keeps branches, frees the slot, and warns", async () => {
    const fixture = await workspaceFixture();
    const created = await committedChange(fixture, "Login", "a1b2");
    await rm(created.folder!, { recursive: true, force: true });

    const closed = await closeChange({ cwd: fixture.workspace, change: created.id, sessionPath: fixture.sessionPath });

    expect(closed.removed).toEqual(["api", "web", "root"]);
    expect(closed.warnings).toEqual(["if you moved this folder, move it back first; closing stops tracking it"]);
    expect(closed.message).toContain("Warning: if you moved this folder");
    for (const repo of [".", "api", "web"]) {
      const cwd = path.join(fixture.workspace, repo);
      expect(await git(cwd, ["worktree", "list", "--porcelain"])).not.toContain(created.branch);
      // The branch is no longer blocked: it can be checked out and deleted.
      await git(cwd, ["checkout", "-q", created.branch]);
      await git(cwd, ["checkout", "-q", "-"]);
    }
    await git(path.join(fixture.workspace, "web"), ["branch", "-D", created.branch]);
    expect(await readBases(path.join(fixture.workspace, ".git", "weave"), created.id)).toBeDefined();
    const next = await createChange({ cwd: fixture.workspace, title: "Next", now, randomId: () => "e5f6", sessionPath: fixture.sessionPath });
    expect(next.slot).toBe(1);
  });

  it("leaves other changes' leftover records alone when closing", async () => {
    const fixture = await workspaceFixture();
    const one = await committedChange(fixture, "Login", "a1b2");
    const two = await committedChange(fixture, "Billing", "c3d4");
    await rm(one.folder!, { recursive: true, force: true });
    await rm(two.folder!, { recursive: true, force: true });

    await closeChange({ cwd: fixture.workspace, change: one.id, sessionPath: fixture.sessionPath });

    expect(await git(path.join(fixture.workspace, "api"), ["worktree", "list", "--porcelain"])).toContain(two.branch);
  });

  it("closes after git already cleared its own record", async () => {
    const fixture = await workspaceFixture();
    const created = await committedChange(fixture, "Login", "a1b2");
    await rm(created.folder!, { recursive: true, force: true });
    for (const repo of [".", "api", "web"]) await git(path.join(fixture.workspace, repo), ["worktree", "prune"]);

    const listed = await listChanges({ cwd: fixture.workspace, sessionPath: fixture.sessionPath });
    expect(listed.targets[0]!.changes.find((change) => change.id === created.id)?.state?.id).toBe("folder_missing");

    const closed = await closeChange({ cwd: fixture.workspace, change: created.id, sessionPath: fixture.sessionPath });
    expect(closed.removed).toEqual([]);
    expect(await pathExists(path.join(fixture.workspace, ".git", "weave", "changes", `${created.id}.yml`))).toBe(false);
  });

  it("refuses to close a folder kept on purpose, or while change folders are unavailable", async () => {
    const fixture = await workspaceFixture();
    const created = await committedChange(fixture, "Login", "a1b2");
    await git(path.join(fixture.workspace, "api"), ["worktree", "lock", path.join(created.folder!, "api")]);
    await expect(closeChange({ cwd: fixture.workspace, change: created.id, sessionPath: fixture.sessionPath })).rejects.toMatchObject({
      code: "worktree_locked",
      message: expect.stringContaining("git worktree unlock"),
    });
    await git(path.join(fixture.workspace, "api"), ["worktree", "unlock", path.join(created.folder!, "api")]);

    // An unmounted drive: the changes root and its parent are both gone.
    const mounted = path.join(fixture.base, "drive");
    await mkdir(mounted);
    await rename(path.join(fixture.base, "acme.changes"), path.join(mounted, "acme.changes"));
    const raw = YAML.parse(await readFile(path.join(fixture.workspace, ".weave", "workspace.yml"), "utf8"));
    raw.worktrees = { ...(raw.worktrees ?? {}), root: "../drive/acme.changes" };
    await writeFile(path.join(fixture.workspace, ".weave", "workspace.yml"), YAML.stringify(raw));
    const stateFile = path.join(fixture.workspace, ".git", "weave", "changes", `${created.id}.yml`);
    const state = YAML.parse(await readFile(stateFile, "utf8"));
    await writeFile(stateFile, YAML.stringify({ ...state, folder: path.join(mounted, "acme.changes", created.id) }));
    await rename(mounted, path.join(fixture.base, "drive-unmounted"));

    await expect(closeChange({ cwd: fixture.workspace, change: created.id, sessionPath: fixture.sessionPath })).rejects.toMatchObject({
      code: "changes_unavailable",
    });
  });

  it("recreates a missing folder with switch, keeping its slot when free and resetting setup", async () => {
    const fixture = await workspaceFixture();
    const created = await committedChange(fixture, "Login", "a1b2");
    await rm(created.folder!, { recursive: true, force: true });

    const reopened = await switchChange({ cwd: fixture.workspace, change: created.id, sessionPath: fixture.sessionPath });

    expect(reopened.folder).toBe(created.folder);
    expect(reopened.change.slot).toBe(1);
    expect(reopened.slot_changed).toBeUndefined();
    expect(reopened.setup_reset).toEqual(["root", "api", "web"]);
    expect(await readFile(path.join(created.folder!, "api", "a1b2.txt"), "utf8")).toBe("work\n");
    expect(await pathExists(path.join(created.folder!, "wiki", "changes", created.id, "status.yml"))).toBe(true);
  });

  it("gives a recreated folder a new slot when its old one was taken", async () => {
    const fixture = await workspaceFixture();
    const created = await committedChange(fixture, "Login", "a1b2");
    await rm(created.folder!, { recursive: true, force: true });
    const other = await createChange({ cwd: fixture.workspace, title: "Billing", now, randomId: () => "c3d4", sessionPath: fixture.sessionPath });
    expect(other.slot).toBe(1);

    const reopened = await switchChange({ cwd: fixture.workspace, change: created.id, sessionPath: fixture.sessionPath });

    expect(reopened.slot_changed).toEqual({ from: 1, to: 2 });
    expect(reopened.change.slot).toBe(2);
    expect(reopened.message).toContain("Slot changed: 1 was taken");
  });

  it("drops a recreated repo's setup record but keeps approvals", async () => {
    const fixture = await workspaceFixture();
    const created = await committedChange(fixture, "Login", "a1b2");
    const stateFile = path.join(fixture.workspace, ".git", "weave", "changes", `${created.id}.yml`);
    const state = YAML.parse(await readFile(stateFile, "utf8"));
    await writeFile(stateFile, YAML.stringify({ ...state, setup: { api: { hash: "x", completed_at: now.toISOString() } } }));
    await writeFile(path.join(fixture.workspace, ".git", "weave", "approved-setup.yml"), YAML.stringify({ approved: ["kept"] }));
    await rm(created.folder!, { recursive: true, force: true });

    await switchChange({ cwd: fixture.workspace, change: created.id, sessionPath: fixture.sessionPath });

    expect(YAML.parse(await readFile(stateFile, "utf8")).setup ?? {}).toEqual({});
    expect(YAML.parse(await readFile(path.join(fixture.workspace, ".git", "weave", "approved-setup.yml"), "utf8"))).toEqual({ approved: ["kept"] });
  });

  it("recreates a folder after it was moved away", async () => {
    const fixture = await workspaceFixture();
    const created = await committedChange(fixture, "Login", "a1b2");
    await rename(created.folder!, path.join(fixture.base, "moved-away"));

    const reopened = await switchChange({ cwd: fixture.workspace, change: created.id, sessionPath: fixture.sessionPath });
    expect(reopened.repos?.every((repo) => repo.status === "created")).toBe(true);
  });

  it("removes nothing when a later repo blocks switch", async () => {
    const fixture = await workspaceFixture();
    const created = await committedChange(fixture, "Login", "a1b2");
    await rm(created.folder!, { recursive: true, force: true });
    // web's leftover record is locked, so switch must stop before touching root or api.
    await git(path.join(fixture.workspace, "web"), ["worktree", "lock", path.join(created.folder!, "web")]);

    await expect(switchChange({ cwd: fixture.workspace, change: created.id, sessionPath: fixture.sessionPath })).rejects.toMatchObject({
      code: "worktree_blocked",
    });
    expect(await git(path.join(fixture.workspace, "api"), ["worktree", "list", "--porcelain"])).toContain(created.branch);
  });

  it("says folder missing, not not-found, when asked about a missing-folder change", async () => {
    const fixture = await workspaceFixture();
    const created = await committedChange(fixture, "Login", "a1b2");
    await rm(created.folder!, { recursive: true, force: true });

    await expect(statusChange({ cwd: fixture.workspace, change: created.id, sessionPath: fixture.sessionPath })).rejects.toMatchObject({
      code: "folder_missing",
      message: expect.stringContaining("weave change list"),
    });
  });

  it("runs every next step the list offers for missing and closed changes", async () => {
    const fixture = await workspaceFixture();
    const missing = await committedChange(fixture, "Login", "a1b2");
    await rm(missing.folder!, { recursive: true, force: true });
    const closed = await committedChange(fixture, "Billing", "c3d4");
    await closeChange({ cwd: fixture.workspace, change: closed.id, sessionPath: fixture.sessionPath });

    const listed = await listChanges({ cwd: fixture.workspace, sessionPath: fixture.sessionPath });
    const commandsFor = (id: string) => listed.targets[0]!.changes.find((change) => change.id === id)?.state?.next.commands ?? [];
    expect(commandsFor(missing.id)).toEqual([`weave change close ${missing.id}`, `weave change switch ${missing.id}`]);
    expect(commandsFor(closed.id)).toEqual([`weave change switch ${closed.id}`]);

    // switch first (it needs the leftovers), then close the recreated folder, then reopen the closed one.
    await switchChange({ cwd: fixture.workspace, change: missing.id, sessionPath: fixture.sessionPath });
    await closeChange({ cwd: fixture.workspace, change: missing.id, sessionPath: fixture.sessionPath });
    await switchChange({ cwd: fixture.workspace, change: closed.id, sessionPath: fixture.sessionPath });
  }, 30_000);

  it("drops a closed change from weave status right away", async () => {
    const fixture = await workspaceFixture();
    const created = await committedChange(fixture, "Login", "a1b2");
    await rm(created.folder!, { recursive: true, force: true });
    await listChanges({ cwd: fixture.workspace, sessionPath: fixture.sessionPath });
    const stateDir = path.join(fixture.workspace, ".git", "weave");
    expect(await readAttention(stateDir)).toMatchObject({ total: 1, counts: { folder_missing: 1 } });

    await closeChange({ cwd: fixture.workspace, change: created.id, sessionPath: fixture.sessionPath });

    expect(await readAttention(stateDir)).toMatchObject({ total: 0 });
  });
});

describe("in-place checkouts", () => {
  it("refuses to stack a new change on another change branch unless a base is given", async () => {
    const fixture = await workspaceFixture({ checkout: "in-place" });
    await createChange({ cwd: fixture.workspace, title: "First", now, randomId: () => "a1b2", sessionPath: fixture.sessionPath });

    await expect(
      createChange({ cwd: fixture.workspace, title: "Second", now, randomId: () => "c3d4", sessionPath: fixture.sessionPath }),
    ).rejects.toMatchObject({ code: "stacked_change" });
    const second = await createChange({ cwd: fixture.workspace, title: "Second", base: "main", now, randomId: () => "c3d4", sessionPath: fixture.sessionPath });
    expect(await git(fixture.workspace, ["merge-base", "--is-ancestor", "main", second.branch]).then(() => true)).toBe(true);
  });

  it("blocks prepare when a repo sits on an unrelated branch", async () => {
    const fixture = await workspaceFixture({ checkout: "in-place" });
    await createChange({ cwd: fixture.workspace, title: "Login", now, randomId: () => "a1b2", sessionPath: fixture.sessionPath });
    await git(path.join(fixture.workspace, "web"), ["checkout", "-b", "feature/someone-else"]);

    const prepared = await prepareTasks({ cwd: fixture.workspace, now, sessionPath: fixture.sessionPath });

    expect(prepared.status).toBe("blocked");
    expect(prepared.blockers).toEqual([expect.objectContaining({ target: "web", reason: expect.stringContaining("feature/someone-else") })]);
    expect(await git(path.join(fixture.workspace, "api"), ["branch", "--show-current"])).toBe("main");
  });

  it("switches back repos already moved when a later repo cannot switch", async () => {
    const fixture = await workspaceFixture({ checkout: "in-place" });
    const created = await createChange({ cwd: fixture.workspace, title: "Login", now, randomId: () => "a1b2", sessionPath: fixture.sessionPath });
    // Another worktree holds the branch in web, so `git checkout` fails there.
    await git(path.join(fixture.workspace, "web"), ["branch", created.branch]);
    await git(path.join(fixture.workspace, "web"), ["worktree", "add", path.join(fixture.base, "web-elsewhere"), created.branch]);

    const prepared = await prepareTasks({ cwd: fixture.workspace, now, sessionPath: fixture.sessionPath });

    expect(prepared.status).toBe("blocked");
    expect(prepared.blockers[0]).toMatchObject({ target: "web", reason: expect.stringContaining("switched back") });
    expect(await git(path.join(fixture.workspace, "api"), ["branch", "--show-current"])).toBe("main");
    expect(await git(path.join(fixture.workspace, "api"), ["branch", "--list", created.branch])).toBe("");
  });

  it("prepares a repo registered through a symlink and blocks on unreadable repos", async () => {
    const fixture = await workspaceFixture({ checkout: "in-place" });
    const real = path.join(fixture.base, "web-real");
    await execFileAsync("mv", [path.join(fixture.workspace, "web"), real]);
    await symlink(real, path.join(fixture.workspace, "web"));
    await createChange({ cwd: fixture.workspace, title: "Login", now, randomId: () => "a1b2", sessionPath: fixture.sessionPath });

    const prepared = await prepareTasks({ cwd: fixture.workspace, now, sessionPath: fixture.sessionPath });
    expect(prepared.repos.find((repo) => repo.id === "web")?.branch_status).toBe("created");

    await writeFile(path.join(fixture.workspace, "api", ".git", "config"), "[broken\n", { flag: "a" });
    const blocked = await prepareTasks({ cwd: fixture.workspace, now, sessionPath: fixture.sessionPath });
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockers).toEqual([expect.objectContaining({ target: "api", reason: expect.stringContaining("git could not read") })]);
  });
});
