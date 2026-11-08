import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAttention } from "../src/lib/change-attention.js";
import { recordBases } from "../src/lib/change-bases.js";
import { closeChange, createChange, listChanges, type ListedChange } from "../src/lib/changes.js";

const execFileAsync = promisify(execFile);
const now = new Date("2026-11-08T10:00:00.000Z");
const projectRoot = path.resolve(__dirname, "..");
const cliEntry = path.resolve(projectRoot, "src", "cli.ts");
const tsxBinary = path.resolve(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Weave Test",
  GIT_AUTHOR_EMAIL: "weave@example.com",
  GIT_COMMITTER_NAME: "Weave Test",
  GIT_COMMITTER_EMAIL: "weave@example.com",
};

// Today's `ChangeSummary` keys, which every listed change must keep.
const summaryKeys = [
  "id",
  "slug",
  "title",
  "type",
  "stage",
  "stale",
  "stale_history",
  "artifacts",
  "stress_tests",
  "auto_advance",
  "runs",
  "branch",
  "path",
  "changePath",
  "active",
];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv });
  return stdout.trim();
}

interface RepoFixture {
  base: string;
  repo: string;
  session: string;
}

// A single repo in worktree mode with a bare file-path origin.
async function repoFixture(settings: Record<string, unknown> = {}): Promise<RepoFixture> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-list-")));
  const origin = path.join(base, "app.git");
  await mkdir(origin);
  await git(origin, ["init", "--bare", "-b", "main"]);
  const repo = path.join(base, "app");
  await git(base, ["clone", "--quiet", origin, repo]);
  await mkdir(path.join(repo, ".weave"));
  await writeFile(
    path.join(repo, ".weave", "workspace.yml"),
    YAML.stringify({ version: 1, mode: "repo", name: "app", checkout: "worktree", repos: {}, ...settings }),
  );
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "weave"]);
  await git(repo, ["push", "--quiet", "-u", "origin", "main"]);
  await git(repo, ["remote", "set-head", "origin", "main"]);
  return { base, repo, session: path.join(base, "session.yml") };
}

async function newChange(fixture: RepoFixture, title: string, randomId: string) {
  return createChange({ cwd: fixture.repo, title, now, randomId: () => randomId, sessionPath: fixture.session });
}

// Commits the planning files and one code file in the change folder.
async function commitWork(folder: string, file = "work.txt"): Promise<void> {
  await writeFile(path.join(folder, file), `${file}\n`);
  await git(folder, ["add", "."]);
  await git(folder, ["commit", "-q", "-m", `work ${file}`]);
}

async function squashIntoOrigin(fixture: RepoFixture, branch: string): Promise<void> {
  await git(fixture.repo, ["merge", "-q", "--squash", branch]);
  await git(fixture.repo, ["commit", "-q", "-m", `squash ${branch}`]);
  await git(fixture.repo, ["push", "-q", "origin", "main"]);
}

async function list(fixture: RepoFixture, cwd = fixture.repo, all = false) {
  return listChanges({ cwd, sessionPath: fixture.session, all, now });
}

function find(result: Awaited<ReturnType<typeof listChanges>>, id: string): ListedChange {
  const change = result.targets[0]!.changes.find((item) => item.id === id);
  if (!change) throw new Error(`${id} not listed`);
  return change;
}

beforeEach(() => {
  process.env.WEAVE_NO_BACKGROUND_REFRESH = "1";
});

afterEach(() => {
  delete process.env.WEAVE_TEST_LANDED_BUDGET_MS;
});

describe("weave change list states (worktree mode)", () => {
  it("shows a new change in progress with no commits, the same from any folder", async () => {
    const fixture = await repoFixture();
    const created = await newChange(fixture, "Login", "a1b2");
    const folder = created.folder!;
    await mkdir(path.join(folder, "src", "deep"), { recursive: true });

    const fromMain = await list(fixture);
    const fromFolder = await list(fixture, folder);
    const fromSubfolder = await list(fixture, path.join(folder, "src", "deep"));

    const change = find(fromMain, created.id);
    expect(change.state).toMatchObject({ id: "in_progress", label: "in progress", next: { commands: [] }, needs_attention: false });
    expect(change.labels).toEqual([{ id: "no_commits_yet", text: "no commits yet" }]);
    expect(change).toMatchObject({ folder, slot: 1, planning: { available: true }, active: false });
    for (const key of summaryKeys) expect(change).toHaveProperty(key);
    expect(typeof change.title).toBe("string");

    const ids = (result: typeof fromMain) => result.targets[0]!.changes.map((item) => [item.id, item.state?.id]);
    expect(ids(fromFolder)).toEqual(ids(fromMain));
    expect(ids(fromSubfolder)).toEqual(ids(fromMain));
    // `active` and the target path keep their cwd-based meaning.
    expect(find(fromFolder, created.id).active).toBe(true);
    expect(fromFolder.targets[0]!.path).toBe(folder);
    expect(fromMain.message).toContain(`  ${created.id}  feat  exploration  Login\n    in progress · no commits yet\n    folder: ${folder}  (slot 1)`);
  });

  it("shows a squash-merged change as landed, offers close, and counts it for weave status", async () => {
    const fixture = await repoFixture();
    const created = await newChange(fixture, "Login", "a1b2");
    // Two commits, so the squash can't be mistaken for a one-commit rebase.
    await commitWork(created.folder!);
    await commitWork(created.folder!, "more.txt");
    await squashIntoOrigin(fixture, created.branch);

    const result = await list(fixture);
    const change = find(result, created.id);
    expect(change.state).toMatchObject({
      id: "landed",
      label: "landed in main (squashed)",
      next: { commands: [`weave change close ${created.id}`] },
      needs_attention: true,
    });
    expect(change.repos).toEqual([expect.objectContaining({ id: "root", state: "landed", method: "squashed", target: expect.objectContaining({ branch: "main" }) })]);
    expect(result.message).toContain(`    landed in main (squashed)\n    next: weave change close ${created.id}`);

    const attention = await readAttention(path.join(fixture.repo, ".git", "weave"));
    expect(attention).toMatchObject({ total: 1, counts: { landed: 1 } });
  });

  it("asks to commit or discard uncommitted files before closing a landed change", async () => {
    const fixture = await repoFixture();
    const created = await newChange(fixture, "Login", "a1b2");
    await commitWork(created.folder!);
    await squashIntoOrigin(fixture, created.branch);
    await writeFile(path.join(created.folder!, "scratch.txt"), "wip\n");

    const change = find(await list(fixture), created.id);
    expect(change.labels).toEqual([{ id: "uncommitted_files", count: 1, text: "1 uncommitted file in folder" }]);
    expect(change.state?.next).toEqual({ commands: [], text: `commit or discard the 1 uncommitted file, then weave change close ${created.id}` });
  });

  it("shows a folder deleted by hand as folder missing, with switch when work was committed", async () => {
    const fixture = await repoFixture();
    const created = await newChange(fixture, "Login", "a1b2");
    await commitWork(created.folder!);
    await rm(created.folder!, { recursive: true, force: true });

    const result = await list(fixture);
    const change = find(result, created.id);
    expect(change.state).toMatchObject({
      id: "folder_missing",
      label: `folder missing: not found at ${created.folder}`,
      next: { commands: [`weave change close ${created.id}`, `weave change switch ${created.id}`] },
      needs_attention: true,
    });
    expect(change).toMatchObject({ missing_folder: created.folder, planning: { available: false, reason: "folder missing" }, title: "Login" });
    expect(change).not.toHaveProperty("folder");
    expect(result.message).toContain(`    folder not found at ${created.folder}  (slot 1)`);
  });

  it("offers only close when nothing was committed, and shows the title as unknown", async () => {
    const fixture = await repoFixture();
    const created = await newChange(fixture, "Login", "a1b2");
    await rm(created.folder!, { recursive: true, force: true });

    const result = await list(fixture);
    const change = find(result, created.id);
    expect(change.state).toMatchObject({
      id: "folder_missing",
      note: "nothing was committed, so its planning files can't be recovered",
      next: { commands: [`weave change close ${created.id}`] },
    });
    expect(change).toMatchObject({ title: "", type: "", stage: "", changePath: "", branch: created.branch, slug: "login" });
    expect(result.message).toContain(`  ${created.id}  (title unknown)`);
  });

  it("lists a locked missing folder as kept on purpose and doesn't count it", async () => {
    const fixture = await repoFixture();
    const created = await newChange(fixture, "Login", "a1b2");
    await git(fixture.repo, ["worktree", "lock", created.folder!]);
    await rm(created.folder!, { recursive: true, force: true });

    const change = find(await list(fixture), created.id);
    expect(change.state).toMatchObject({
      id: "folder_missing_kept",
      label: "folder missing (kept on purpose)",
      next: { commands: [], text: `unlock with: git worktree unlock ${created.folder}` },
      needs_attention: false,
    });
    expect(await readAttention(path.join(fixture.repo, ".git", "weave"))).toMatchObject({ total: 0 });
  });

  it("treats a deleted changes folder as folder missing, but an unmounted one as unavailable", async () => {
    const deleted = await repoFixture();
    const one = await newChange(deleted, "Login", "a1b2");
    await rm(path.dirname(one.folder!), { recursive: true, force: true });
    expect(find(await list(deleted), one.id).state?.id).toBe("folder_missing");

    const unmounted = await repoFixture({ worktrees: { root: "../drive/changes" } });
    const two = await newChange(unmounted, "Login", "c3d4");
    await rm(path.join(unmounted.base, "drive"), { recursive: true, force: true });
    const result = await list(unmounted);
    const change = find(result, two.id);
    expect(change.state).toMatchObject({ id: "folder_unavailable", needs_attention: false, next: { commands: [] } });
    expect(result.targets[0]!.unavailable).toEqual({ path: path.join(unmounted.base, "drive", "changes") });
    expect(result.message).toContain(`  change folders unavailable at ${path.join(unmounted.base, "drive", "changes")} (drive not mounted?)`);
    expect(result.message).not.toContain("folder not found");
  });

  it("ignores branches that aren't Weave changes", async () => {
    const fixture = await repoFixture();
    await git(fixture.repo, ["branch", "change/experiment"]);
    await git(fixture.repo, ["branch", "change/261101-zzzz-unknown"]);

    const result = await list(fixture, fixture.repo, true);
    expect(result.targets[0]!.changes.map((change) => change.id)).toEqual([]);
  });

  it("shows closed changes, offering switch only when their status.yml is on the branch", async () => {
    const fixture = await repoFixture();
    const committed = await newChange(fixture, "Login", "a1b2");
    await commitWork(committed.folder!);
    await closeChange({ cwd: fixture.repo, change: committed.id, sessionPath: fixture.session });

    // A closed branch with no committed planning files but a remembered starting branch.
    const bare = "261101-q9q9-bare";
    await git(fixture.repo, ["branch", `change/${bare}`]);
    await git(fixture.repo, ["checkout", "-q", `change/${bare}`]);
    await writeFile(path.join(fixture.repo, "bare.txt"), "bare\n");
    await git(fixture.repo, ["add", "."]);
    await git(fixture.repo, ["commit", "-q", "-m", "bare"]);
    await git(fixture.repo, ["checkout", "-q", "main"]);
    await recordBases(fixture.repo, bare, { root: { base: "origin/main", base_commit: await git(fixture.repo, ["rev-parse", "main"]), source: "created" } });

    const result = await list(fixture);
    expect(find(result, committed.id)).toMatchObject({
      title: "Login",
      planning: { available: false, reason: "no folder" },
      state: { id: "closed_not_landed", label: "closed, work not in main", next: { commands: [`weave change switch ${committed.id}`] } },
    });
    expect(find(result, bare)).toMatchObject({
      title: "",
      state: { id: "closed_not_landed", next: { commands: [], text: `recover the work with: git worktree add <path> change/${bare}` } },
    });
  });

  it("hides done changes unless --all is given", async () => {
    const fixture = await repoFixture();
    const created = await newChange(fixture, "Login", "a1b2");
    await commitWork(created.folder!);
    await squashIntoOrigin(fixture, created.branch);
    await closeChange({ cwd: fixture.repo, change: created.id, sessionPath: fixture.session });

    expect((await list(fixture)).targets[0]!.changes.map((change) => change.id)).not.toContain(created.id);
    expect(find(await list(fixture, fixture.repo, true), created.id).state).toMatchObject({ id: "done", label: "done" });
  });

  it("says still checking when the inline budget runs out", async () => {
    process.env.WEAVE_TEST_LANDED_BUDGET_MS = "-1";
    const fixture = await repoFixture();
    const created = await newChange(fixture, "Login", "a1b2");

    const change = find(await list(fixture), created.id);
    expect(change.landed_check).toEqual({ status: "unchecked", reason: "still checking" });
    expect(change.labels).toEqual(expect.arrayContaining([{ id: "couldnt_check", text: "couldn't check whether this landed: still checking" }]));
  });

  it("supports --all and --json on the command line", async () => {
    const fixture = await repoFixture();
    const created = await newChange(fixture, "Login", "a1b2");

    const result = spawnSync(process.execPath, [tsxBinary, cliEntry, "change", "list", "--all", "--json"], {
      cwd: fixture.repo,
      env: { ...process.env, WEAVE_NO_NOTICES: "1", WEAVE_NO_BACKGROUND_REFRESH: "1" },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.targets[0].changes[0]).toMatchObject({ id: created.id, state: { id: "in_progress" } });
    expect(parsed.targets[0].freshness).toEqual({ refreshing: false, as_of: null });
  }, 30_000);
});

describe("weave change list in a workspace (worktree mode)", () => {
  it("doesn't flag repos a change was never checked out in", async () => {
    const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-list-ws-")));
    const workspace = path.join(base, "acme");
    await mkdir(workspace);
    await git(workspace, ["init", "-q", "-b", "main"]);
    await mkdir(path.join(workspace, ".weave"));
    await writeFile(
      path.join(workspace, ".weave", "workspace.yml"),
      YAML.stringify({ version: 1, mode: "workspace", name: "acme", checkout: "worktree", repos: { api: { path: "api", kind: "app" }, web: { path: "web", kind: "app" } } }),
    );
    await writeFile(path.join(workspace, ".gitignore"), "/api/\n/web/\n");
    await git(workspace, ["add", "."]);
    await git(workspace, ["commit", "-q", "-m", "workspace"]);
    for (const repo of ["api", "web"]) {
      const origin = path.join(base, "origins", `${repo}.git`);
      await mkdir(origin, { recursive: true });
      await git(origin, ["init", "-q", "--bare", "-b", "main"]);
      await git(workspace, ["clone", "--quiet", origin, repo]);
      await writeFile(path.join(workspace, repo, "README.md"), `${repo}\n`);
      await git(path.join(workspace, repo), ["add", "."]);
      await git(path.join(workspace, repo), ["commit", "-q", "-m", "initial"]);
      await git(path.join(workspace, repo), ["push", "-q", "-u", "origin", "main"]);
    }
    const session = path.join(base, "session.yml");
    const created = await createChange({ cwd: workspace, title: "Api only", repos: ["api"], now, randomId: () => "a1b2", sessionPath: session });

    const result = await listChanges({ cwd: workspace, sessionPath: session, now });
    const change = result.targets[0]!.changes.find((item) => item.id === created.id)!;
    expect(change.state?.id).toBe("in_progress");
    expect(change.repos?.map((repo) => repo.id)).toEqual(["root", "api"]);
    const local = YAML.parse(await readFile(path.join(workspace, ".git", "weave", "changes", `${created.id}.yml`), "utf8"));
    expect(local.repos).toEqual(["root", "api"]);
  });
});

describe("weave change list in place", () => {
  it("lists exactly as before, with no new fields", async () => {
    const fixture = await repoFixture({ checkout: "in-place" });
    const created = await newChange(fixture, "Login", "a1b2");

    const result = await list(fixture);
    expect(result.message).toBe(`Changes in ${fixture.repo}\n* ${created.id}  feat  exploration  Login`);
    const change = result.targets[0]!.changes[0]!;
    expect(change).not.toHaveProperty("state");
    expect(change).not.toHaveProperty("labels");
    expect(result.targets[0]).not.toHaveProperty("freshness");
  });
});
