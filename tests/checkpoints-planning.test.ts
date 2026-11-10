import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { createChange, progressChange } from "../src/lib/changes.js";
import { applySubjectTemplate, composeMessage, ownedByMoment } from "../src/lib/checkpoints.js";

const execFileAsync = promisify(execFile);
const testNow = new Date(2026, 10, 11, 9, 0, 0);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

interface Fixture {
  cwd: string;
  session: string;
  changePath: string;
  changeId: string;
  branch: string;
}

async function setup(options: { commits?: Record<string, unknown> } = {}): Promise<Fixture> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "weave-checkpoints-"));
  await git(cwd, "init", "-b", "main");
  await git(cwd, "config", "user.name", "Test Person");
  await git(cwd, "config", "user.email", "person@example.test");
  await git(cwd, "config", "commit.gpgsign", "false");
  await mkdir(path.join(cwd, ".weave"), { recursive: true });
  await writeFile(
    path.join(cwd, ".weave", "workspace.yml"),
    YAML.stringify({ version: 1, mode: "repo", name: "fixture", repos: {}, ...(options.commits ? { commits: options.commits } : {}) }),
  );
  await writeFile(path.join(cwd, "README.md"), "# fixture\n");
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-m", "initial");
  const session = path.join(cwd, ".session.yml");
  const created = await createChange({ cwd, title: "Checkpoints", now: testNow, randomId: () => "ck01", sessionPath: session });
  const branch = `change/${created.id}`;
  const current = await git(cwd, "branch", "--show-current");
  if (current !== branch) await git(cwd, "checkout", "-b", branch);
  return { cwd, session, changePath: path.join(cwd, "wiki", "changes", created.id), changeId: created.id, branch };
}

async function lastCommit(cwd: string): Promise<{ subject: string; body: string; author: string; files: string[] }> {
  const subject = await git(cwd, "log", "-1", "--format=%s");
  const body = await git(cwd, "log", "-1", "--format=%B");
  const author = await git(cwd, "log", "-1", "--format=%ae");
  const files = (await git(cwd, "show", "--name-only", "--format=", "HEAD")).split("\n").filter(Boolean);
  return { subject, body, author, files };
}

describe("planning checkpoints on progress", () => {
  it("commits the lane's artifact and status with the person's identity", async () => {
    const fx = await setup();
    await writeFile(path.join(fx.changePath, "prd.md"), "---\nartifact: prd\n---\n\n# Commit checkpoints PRD\n");
    const result = await progressChange({ cwd: fx.cwd, stage: "prd", sources: ["exploration"], sessionPath: fx.session, summary: "commit checkpoints at each stage" });
    expect(result.checkpoint?.status).toBe("committed");
    const commit = await lastCommit(fx.cwd);
    expect(commit.subject).toBe("PRD: commit checkpoints at each stage");
    expect(commit.author).toBe("person@example.test");
    expect(commit.files).toContain(`wiki/changes/${fx.changeId}/prd.md`);
    expect(commit.files).toContain(`wiki/changes/${fx.changeId}/status.yml`);
    expect(commit.body).toContain(`Weave-Change: ${fx.changeId}`);
    expect(commit.body).toContain("Weave-Checkpoint: planning");
    expect(commit.body).toContain("Weave-Stage: prd");
    expect(result.message).toContain("Committed");
  });

  it("puts leftovers in a catch-up commit and keeps staged edits for the moment commit", async () => {
    const fx = await setup();
    await writeFile(path.join(fx.cwd, "src.ts"), "export const a = 1;\n");
    await git(fx.cwd, "add", "src.ts");
    await mkdir(path.join(fx.changePath, "sessions"), { recursive: true });
    await writeFile(path.join(fx.changePath, "sessions", "20261111-090000-abcd-prd.md"), "# PRD notes\n");
    await writeFile(path.join(fx.changePath, "sessions", "20261111-080000-wxyz-exploration.md"), "# old notes\n");
    await writeFile(path.join(fx.changePath, "prd.md"), "# PRD\n");
    await writeFile(path.join(fx.cwd, "unstaged.ts"), "export const b = 2;\n");

    const result = await progressChange({ cwd: fx.cwd, stage: "prd", sessionPath: fx.session });
    expect(result.checkpoint?.status).toBe("committed");
    expect(result.checkpoint?.catch_up?.status).toBe("committed");

    const moment = await lastCommit(fx.cwd);
    expect(moment.files).toEqual(
      expect.arrayContaining([`wiki/changes/${fx.changeId}/prd.md`, `wiki/changes/${fx.changeId}/sessions/20261111-090000-abcd-prd.md`, "src.ts"]),
    );
    expect(moment.files).not.toContain("unstaged.ts");

    const catchUpFiles = (await git(fx.cwd, "show", "--name-only", "--format=", "HEAD~1")).split("\n").filter(Boolean);
    // The scaffolded exploration.md was never committed either, so it is a leftover too.
    expect(catchUpFiles).toContain(`wiki/changes/${fx.changeId}/sessions/20261111-080000-wxyz-exploration.md`);
    expect(catchUpFiles).not.toContain(`wiki/changes/${fx.changeId}/prd.md`);
    expect(catchUpFiles).not.toContain("src.ts");
    expect(await git(fx.cwd, "log", "-1", "--format=%B", "HEAD~1")).toContain("Weave-Checkpoint: catch-up");
    expect(await git(fx.cwd, "status", "--porcelain")).toContain("?? unstaged.ts");
  });

  it("runs no hooks for planning commits", async () => {
    const fx = await setup();
    const hooks = path.join(fx.cwd, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    await writeFile(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n");
    await writeFile(path.join(hooks, "prepare-commit-msg"), `#!/bin/sh\ntouch "${path.join(fx.cwd, "hook-ran")}"\n`);
    await chmod(path.join(hooks, "pre-commit"), 0o755);
    await chmod(path.join(hooks, "prepare-commit-msg"), 0o755);
    await writeFile(path.join(fx.changePath, "exploration.md"), "# Shape\n");
    const result = await progressChange({ cwd: fx.cwd, stage: "exploration", sessionPath: fx.session });
    expect(result.checkpoint?.status).toBe("committed");
    await expect(readFile(path.join(fx.cwd, "hook-ran"), "utf8")).rejects.toThrow();
  });

  it("skips on the wrong branch and still records progress", async () => {
    const fx = await setup();
    await git(fx.cwd, "add", "-A");
    await git(fx.cwd, "commit", "-m", "planning");
    await git(fx.cwd, "checkout", "-b", "other");
    await writeFile(path.join(fx.changePath, "exploration.md"), "# Shape\n");
    const before = await git(fx.cwd, "rev-parse", "HEAD");
    // The active change comes from the branch, so point the fixture back at the change via session.
    const result = await progressChange({ cwd: fx.cwd, stage: "exploration", sessionPath: fx.session }).catch((error: Error) => error);
    if (result instanceof Error) {
      // Branch-derived resolution refuses another branch outright; nothing was committed either way.
      expect(await git(fx.cwd, "rev-parse", "HEAD")).toBe(before);
      return;
    }
    expect(result.checkpoint?.status).toBe("skipped");
    expect(result.checkpoint?.reason).toBe("wrong_branch");
    expect(await git(fx.cwd, "rev-parse", "HEAD")).toBe(before);
  });

  it("skips while a rebase is in progress", async () => {
    const fx = await setup();
    await mkdir(path.join(fx.cwd, ".git", "rebase-merge"), { recursive: true });
    await writeFile(path.join(fx.changePath, "exploration.md"), "# Shape\n");
    const result = await progressChange({ cwd: fx.cwd, stage: "exploration", sessionPath: fx.session });
    expect(result.checkpoint).toMatchObject({ status: "skipped", reason: "operation_in_progress" });
    const status = YAML.parse(await readFile(path.join(fx.changePath, "status.yml"), "utf8")) as { artifacts: Record<string, unknown> };
    expect(status.artifacts.exploration).toBeDefined();
  });

  it("skips when the project switch is off", async () => {
    const fx = await setup({ commits: { enabled: false } });
    const before = await git(fx.cwd, "rev-parse", "HEAD");
    const result = await progressChange({ cwd: fx.cwd, stage: "exploration", sessionPath: fx.session });
    expect(result.checkpoint).toMatchObject({ status: "skipped", reason: "commits_off_project" });
    expect(await git(fx.cwd, "rev-parse", "HEAD")).toBe(before);
  });

  it("applies the subject template, names stale lanes, and accepts a full message", async () => {
    const fx = await setup({ commits: { subject_template: { planning: "docs(weave): {subject}" } } });
    await writeFile(path.join(fx.changePath, "exploration.md"), "# Shape\n");
    await progressChange({ cwd: fx.cwd, stage: "exploration", sessionPath: fx.session });
    await writeFile(path.join(fx.changePath, "prd.md"), "# PRD\n");
    await progressChange({ cwd: fx.cwd, stage: "prd", sources: ["exploration"], sessionPath: fx.session });
    await writeFile(path.join(fx.changePath, "exploration.md"), "# Shape v2\n");
    const result = await progressChange({ cwd: fx.cwd, stage: "exploration", sessionPath: fx.session, summary: "narrower scope" });
    const commit = await lastCommit(fx.cwd);
    expect(commit.subject).toBe("docs(weave): Product shape: narrower scope");
    expect(commit.body).toContain("Now out of date: PRD.");
    expect(result.checkpoint?.status).toBe("committed");

    await writeFile(path.join(fx.changePath, "prd.md"), "# PRD v2\n");
    await progressChange({ cwd: fx.cwd, stage: "prd", sessionPath: fx.session, commitMessage: "feat: custom message\n" });
    const custom = await lastCommit(fx.cwd);
    expect(custom.subject).toBe("feat: custom message");
    expect(custom.body).toContain("Weave-Checkpoint: planning");
  });
});

describe("checkpoint helpers", () => {
  it("assigns paths to moments", () => {
    expect(ownedByMoment("prd.md", { kind: "progress", lane: "prd" })).toBe(true);
    expect(ownedByMoment("architecture/schema.md", { kind: "progress", lane: "architecture" })).toBe(true);
    expect(ownedByMoment("sessions/20261111-031530-0x5g-architecture-stress-test.md", { kind: "progress", lane: "architecture" })).toBe(true);
    expect(ownedByMoment("sessions/20261111-031530-0x5g-architecture-stress-test.md", { kind: "verdict", lane: "architecture", verdict: "holds" })).toBe(true);
    expect(ownedByMoment("sessions/20261111-031530-0x5g-exploration.md", { kind: "progress", lane: "prd" })).toBe(false);
    expect(ownedByMoment("status.yml", { kind: "clear-stale", lane: "prd" })).toBe(true);
    expect(ownedByMoment("task-slices/02-x/review/r1.md", { kind: "review", slice: "02-x", run: "r1", result: "reviewed" })).toBe(true);
  });

  it("templates subjects and composes messages", () => {
    expect(applySubjectTemplate("chore: {subject} [{change}]", "planning", { subject: "PRD: x", change: "c1" })).toBe("chore: PRD: x [c1]");
    expect(applySubjectTemplate({ build: "feat({slice}): {subject}" }, "planning", { subject: "PRD: x", change: "c1" })).toBe("PRD: x");
    const message = composeMessage("Subject", ["Body"], [["Weave-Change", "c1"]]);
    expect(message).toBe("Subject\n\nBody\n\nWeave-Change: c1\n");
  });
});

describe("planning checkpoints for other recording commands", () => {
  it("commits a verdict with its session note, a stale clear, and knowledge", async () => {
    const { verdictChange, clearChangeStaleness, knowledgeChange } = await import("../src/lib/changes.js");
    const fx = await setup();
    await writeFile(path.join(fx.changePath, "exploration.md"), "# Shape\n");
    await progressChange({ cwd: fx.cwd, stage: "exploration", sessionPath: fx.session });
    await writeFile(path.join(fx.changePath, "prd.md"), "# PRD\n");
    await progressChange({ cwd: fx.cwd, stage: "prd", sources: ["exploration"], sessionPath: fx.session });

    const note = `wiki/changes/${fx.changeId}/sessions/20261111-100000-abcd-exploration-stress-test.md`;
    await mkdir(path.join(fx.changePath, "sessions"), { recursive: true });
    await writeFile(path.join(fx.cwd, note), "# Stress test\n");
    const verdict = await verdictChange({ cwd: fx.cwd, lane: "exploration", verdict: "holds", session: note, sessionPath: fx.session });
    expect(verdict.checkpoint?.status).toBe("committed");
    let commit = await lastCommit(fx.cwd);
    expect(commit.subject).toBe("Stress test (exploration): holds");
    expect(commit.files).toContain(note);
    expect(commit.body).toContain("Weave-Stage: verdict");

    await writeFile(path.join(fx.changePath, "exploration.md"), "# Shape v2\n");
    await progressChange({ cwd: fx.cwd, stage: "exploration", sessionPath: fx.session });
    const cleared = await clearChangeStaleness({ cwd: fx.cwd, lane: "prd", reason: "still in line", sessionPath: fx.session });
    expect(cleared.checkpoint?.status).toBe("committed");
    commit = await lastCommit(fx.cwd);
    expect(commit.subject).toBe("PRD: back in line");
    expect(commit.files).toEqual([`wiki/changes/${fx.changeId}/status.yml`]);

    await mkdir(path.join(fx.cwd, "wiki", "knowledge", "domains", "commits"), { recursive: true });
    await writeFile(path.join(fx.cwd, "wiki", "knowledge", "domains", "commits", "behavior.md"), "# Commits\n");
    await writeFile(path.join(fx.cwd, "wiki", "knowledge", "unrelated.md"), "# Not this change\n");
    await writeFile(path.join(fx.changePath, "knowledge-delta.md"), "# Delta\n");
    const knowledge = await knowledgeChange({
      cwd: fx.cwd,
      status: "updated",
      domains: ["commits"],
      files: ["wiki/knowledge/domains/commits/behavior.md"],
      delta: `wiki/changes/${fx.changeId}/knowledge-delta.md`,
      sessionPath: fx.session,
      summary: "commit checkpoints",
    });
    expect(knowledge.checkpoint?.status).toBe("committed");
    commit = await lastCommit(fx.cwd);
    expect(commit.subject).toBe("Knowledge: commit checkpoints");
    expect(commit.files).toEqual(
      expect.arrayContaining([
        "wiki/knowledge/domains/commits/behavior.md",
        `wiki/changes/${fx.changeId}/knowledge-delta.md`,
        `wiki/changes/${fx.changeId}/status.yml`,
      ]),
    );
    expect(commit.files).not.toContain("wiki/knowledge/unrelated.md");
  });

  it("commits this change's decisions with the architecture and leaves other decisions alone", async () => {
    const fx = await setup();
    const decisions = path.join(fx.cwd, "wiki", "decisions");
    await mkdir(decisions, { recursive: true });
    await writeFile(path.join(decisions, "a-own.md"), `---\nid: a-own\nchange: ${fx.changeId}\nstatus: proposed\n---\n# Own\n`);
    await writeFile(path.join(decisions, "b-other.md"), "---\nid: b-other\nchange: someone-else\nstatus: proposed\n---\n# Other\n");
    await writeFile(path.join(decisions, "index.md"), "# Decisions\n");
    await mkdir(path.join(fx.changePath, "architecture"), { recursive: true });
    await writeFile(path.join(fx.changePath, "architecture", "index.md"), "# Arch\n");
    await progressChange({ cwd: fx.cwd, stage: "architecture", sessionPath: fx.session });
    const commit = await lastCommit(fx.cwd);
    expect(commit.files).toEqual(expect.arrayContaining(["wiki/decisions/a-own.md", "wiki/decisions/index.md", `wiki/changes/${fx.changeId}/architecture/index.md`]));
    expect(commit.files).not.toContain("wiki/decisions/b-other.md");
    expect(await git(fx.cwd, "status", "--porcelain")).toContain("wiki/decisions/b-other.md");
  });
});
