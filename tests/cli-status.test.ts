import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { installAgentSkills } from "../src/lib/agent-skills.js";
import { createChange } from "../src/lib/changes.js";

const projectRoot = path.resolve(__dirname, "..");
const cliEntry = path.resolve(projectRoot, "src", "cli.ts");
const tsxBinary = path.resolve(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");

interface CliResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): CliResult {
  const result = spawnSync(
    process.execPath,
    [tsxBinary, cliEntry, ...args],
    {
      cwd,
      env: { ...process.env, WEAVE_NO_NOTICES: undefined, ...env },
      encoding: "utf8",
    },
  );
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "weave-status-"));
}

describe("weave status", () => {
  it("reports not-in-repo when run outside a Weave-managed folder", () => {
    const result = runCli(["status", "--json"], os.tmpdir());

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({ status: "ok", inRepo: false, skills: [] });
    expect(parsed.notices).toEqual([]);
  });

  it("returns ok with empty skills when in a Weave repo with no installed skills", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, ".weave-marker"), "");
    const weaveDir = path.join(cwd, ".weave");
    await import("node:fs/promises").then((mod) => mod.mkdir(weaveDir, { recursive: true }));
    await writeFile(path.join(weaveDir, "agents.yml"), "version: 1\ninstalled: {}\n");

    const result = runCli(["status", "--json"], cwd);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({ status: "ok", inRepo: true, skills: [] });
  });

  it("lists installed skills with state=current after a fresh install", async () => {
    const cwd = await tempDir();
    await installAgentSkills({ cwd, agent: "claude" });

    const result = runCli(["status", "--json"], cwd);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.skills.length).toBeGreaterThan(0);
    for (const row of parsed.skills) {
      expect(row.state).toBe("current");
      expect(row.installed_from).toMatch(/^\d+\.\d+\.\d+/);
      expect(row.current).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it("marks an installed skill as state=modified after a local edit", async () => {
    const cwd = await tempDir();
    await installAgentSkills({ cwd, agent: "claude" });
    await writeFile(path.join(cwd, ".claude", "skills", "weave-explore", "SKILL.md"), "custom\n");

    const result = runCli(["status", "--json"], cwd);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const explore = parsed.skills.find((row: { name: string }) => row.name === "weave-explore");
    expect(explore?.state).toBe("modified");
  });

  it("renders a readable text summary by default", async () => {
    const cwd = await tempDir();
    await installAgentSkills({ cwd, agent: "claude" });

    const result = runCli(["status"], cwd);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("weave-it");
    expect(result.stdout).toContain("Installed skills:");
    expect(result.stdout).toContain("Notices:");
  });

  it("suppresses notices entirely when WEAVE_NO_NOTICES=1 is set", async () => {
    const cwd = await tempDir();
    await installAgentSkills({ cwd, agent: "claude" });
    await writeFile(path.join(cwd, ".claude", "skills", "weave-explore", "SKILL.md"), "custom\n");

    const result = runCli(["status", "--json"], cwd, { WEAVE_NO_NOTICES: "1" });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.notices).toEqual([]);
  });
});

describe("weave status attention line", () => {
  const execFileAsync = promisify(execFile);
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
  const git = (cwd: string, args: string[]) => execFileAsync("git", args, { cwd, env: gitEnv }).then(({ stdout }) => stdout.trim());

  async function worktreeRepo(checkout: "worktree" | "in-place" = "worktree"): Promise<{ repo: string; folder: string }> {
    const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-status-attn-")));
    const origin = path.join(base, "app.git");
    await mkdir(origin);
    await git(origin, ["init", "-q", "--bare", "-b", "main"]);
    const repo = path.join(base, "app");
    await git(base, ["clone", "--quiet", origin, repo]);
    await mkdir(path.join(repo, ".weave"));
    await writeFile(path.join(repo, ".weave", "workspace.yml"), YAML.stringify({ version: 1, mode: "repo", name: "app", checkout, repos: {} }));
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-q", "-m", "weave"]);
    await git(repo, ["push", "-q", "-u", "origin", "main"]);
    const created = await createChange({ cwd: repo, title: "Login", randomId: () => "a1b2", sessionPath: path.join(base, "session.yml") });
    return { repo, folder: created.folder ?? repo };
  }

  async function writeSnapshot(repo: string, counts: Record<string, number>): Promise<void> {
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    await mkdir(path.join(repo, ".git", "weave"), { recursive: true });
    await writeFile(
      path.join(repo, ".git", "weave", "attention.json"),
      JSON.stringify({ version: 1, computed_at: "2026-11-08T10:00:00.000Z", facts_at: "2026-11-08T10:00:00.000Z", total, counts }),
    );
  }

  it("shows the count with each state, the same from the main checkout, a change folder, and a subfolder", async () => {
    const { repo, folder } = await worktreeRepo();
    await writeSnapshot(repo, { landed: 1, folder_missing: 1 });
    const sub = path.join(folder, "wiki");

    for (const cwd of [repo, folder, sub]) {
      const result = runCli(["status"], cwd, { WEAVE_NO_NOTICES: "1" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("2 changes need attention (1 landed, 1 folder missing). Run 'weave change list'.");
    }
    const json = JSON.parse(runCli(["status", "--json"], folder, { WEAVE_NO_NOTICES: "1" }).stdout);
    expect(json.changes_attention).toEqual({ total: 2, counts: { landed: 1, folder_missing: 1 }, computed_at: "2026-11-08T10:00:00.000Z" });
  }, 60_000);

  it("leaves out zero counts and uses the singular", async () => {
    const { repo } = await worktreeRepo();
    await writeSnapshot(repo, { landed: 1 });

    expect(runCli(["status"], repo, { WEAVE_NO_NOTICES: "1" }).stdout).toContain("1 change needs attention (1 landed). Run 'weave change list'.");
  }, 30_000);

  it("adds nothing when nothing needs attention or nothing has been worked out", async () => {
    const { repo } = await worktreeRepo();
    const before = runCli(["status", "--json"], repo, { WEAVE_NO_NOTICES: "1" });
    expect(JSON.parse(before.stdout).changes_attention).toBeNull();
    expect(runCli(["status"], repo, { WEAVE_NO_NOTICES: "1" }).stdout).not.toContain("need attention");

    await writeSnapshot(repo, {});
    expect(runCli(["status"], repo, { WEAVE_NO_NOTICES: "1" }).stdout).not.toContain("need attention");
  }, 30_000);

  it("stays out of in-place repos", async () => {
    const { repo } = await worktreeRepo("in-place");
    await writeSnapshot(repo, { landed: 1 });

    const json = JSON.parse(runCli(["status", "--json"], repo, { WEAVE_NO_NOTICES: "1" }).stdout);
    expect(json.changes_attention).toBeNull();
  }, 30_000);
});
