import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { createChange, currentChange, knowledgeChange, listChanges, progressChange, statusChange, switchChange, verdictChange } from "../src/lib/changes.js";

const execFileAsync = promisify(execFile);
const testNow = new Date(2026, 4, 22, 10, 0, 0);
const testNowIso = testNow.toISOString();

async function rawTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "weave-it-changes-"));
}

async function tempDir(): Promise<string> {
  const cwd = await rawTempDir();
  await writeWorkspaceMetadata(cwd, "repo");
  await initGit(cwd);
  return cwd;
}

async function writeWorkspaceMetadata(cwd: string, mode: "repo" | "workspace"): Promise<void> {
  await mkdir(path.join(cwd, ".weave"), { recursive: true });
  await writeFile(
    path.join(cwd, ".weave", "workspace.yml"),
    YAML.stringify({
      version: 1,
      mode,
      name: path.basename(cwd),
      repos: {},
    }),
  );
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function initGit(cwd: string): Promise<void> {
  await git(cwd, ["init"]);
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await git(cwd, ["add", "."]);
  await git(cwd, ["-c", "user.name=Weave Test", "-c", "user.email=weave@example.com", "commit", "-m", message]);
}

function sessionPath(cwd: string): string {
  return path.join(cwd, ".session.yml");
}

describe("changes", () => {
  it("requires a non-empty change title", async () => {
    const cwd = await tempDir();

    await expect(createChange({ cwd, title: "   ", sessionPath: sessionPath(cwd) })).rejects.toThrow("Change title is required");
  });

  it("refuses to create changes outside git before writing files", async () => {
    const cwd = await rawTempDir();
    await writeWorkspaceMetadata(cwd, "repo");

    await expect(
      createChange({
        cwd,
        title: "Analytics of reviews",
        type: "feat",
        now: testNow,
        randomId: () => "f3q9",
        sessionPath: sessionPath(cwd),
      }),
    ).rejects.toMatchObject({ code: "not_git" });
    await expect(stat(path.join(cwd, "wiki", "changes", "260522-f3q9-analytics-of-reviews"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates a feature change exploration and checks out its branch", async () => {
    const cwd = await tempDir();

    const result = await createChange({
      cwd,
      title: "Analytics of reviews",
      type: "feat",
      now: testNow,
      randomId: () => "f3q9",
      sessionPath: sessionPath(cwd),
    });
    const changePath = path.join(cwd, "wiki", "changes", "260522-f3q9-analytics-of-reviews");
    const status = YAML.parse(await readFile(path.join(changePath, "status.yml"), "utf8"));
    const exploration = await readFile(path.join(changePath, "exploration.md"), "utf8");
    const explorationFrontmatter = YAML.parse(exploration.split("---")[1]);

    expect(result.id).toBe("260522-f3q9-analytics-of-reviews");
    expect(result.type).toBe("feat");
    expect(result.branch).toBe("change/260522-f3q9-analytics-of-reviews");
    expect(result.targets).toContainEqual(expect.objectContaining({ branchStatus: "created" }));
    expect(result.targets).toContainEqual(expect.objectContaining({ current: true }));
    expect(status).toMatchObject({
      id: "260522-f3q9-analytics-of-reviews",
      slug: "analytics-of-reviews",
      title: "Analytics of reviews",
      type: "feat",
      stage: "exploration",
      branch: "change/260522-f3q9-analytics-of-reviews",
    });
    expect(exploration).toContain("# Analytics Of Reviews");
    expect(exploration).toContain("## PRD Readiness");
    expect(explorationFrontmatter).toMatchObject({
      artifact: "exploration",
      status: "draft",
      owner: "product",
      created_at: testNowIso,
      updated_at: testNowIso,
      reviewed_at: null,
      approved_at: null,
      approved_by: null,
      source: "discussion",
    });
    await expect(stat(path.join(changePath, "sessions"))).resolves.toMatchObject({});
  });

  it("starts non-feature changes at stage `started` with no exploration.md", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);

    const result = await createChange({
      cwd,
      title: "Analytics of reviews",
      type: "fix",
      now: testNow,
      randomId: () => "f3q9",
      sessionPath: session,
    });
    const changePath = path.join(cwd, "wiki", "changes", "260522-f3q9-analytics-of-reviews");
    const status = YAML.parse(await readFile(path.join(changePath, "status.yml"), "utf8"));

    expect(result.type).toBe("fix");
    expect(status).toMatchObject({
      type: "fix",
      stage: "started",
    });
    // Non-feature changes do not scaffold exploration.md but still get sessions/.
    await expect(stat(path.join(changePath, "exploration.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(changePath, "sessions"))).resolves.toMatchObject({});

    // ...and no local session routing state is recorded.
    await expect(stat(session)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads back the `started` stage instead of coercing it to exploration", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);
    await createChange({
      cwd,
      title: "Late bug",
      type: "fix",
      now: testNow,
      randomId: () => "zz12",
      sessionPath: session,
    });

    const current = await currentChange({ cwd, sessionPath: session });
    expect(current.targets[0].current?.stage).toBe("started");
  });

  it("defaults change type to feat", async () => {
    const cwd = await tempDir();

    const result = await createChange({
      cwd,
      title: "Analytics of reviews",
      now: testNow,
      randomId: () => "k9x2",
      sessionPath: sessionPath(cwd),
    });

    const status = YAML.parse(await readFile(path.join(cwd, "wiki", "changes", result.id, "status.yml"), "utf8"));
    expect(result.type).toBe("feat");
    expect(status.type).toBe("feat");
  });

  it("creates and checks out the change branch in git repos", async () => {
    const cwd = await tempDir();
    await initGit(cwd);

    const result = await createChange({
      cwd,
      title: "Change workflow scaffold",
      now: testNow,
      randomId: () => "a7k2",
      sessionPath: sessionPath(cwd),
    });

    expect(result.targets).toContainEqual(expect.objectContaining({ branchStatus: "created" }));
    await expect(git(cwd, ["branch", "--show-current"])).resolves.toBe("change/260522-a7k2-change-workflow-scaffold");
  });

  it("creates a single change id in the cwd-dispatched repo root", async () => {
    const root = await tempDir();
    const app = path.join(root, "app");
    await mkdir(app);

    const result = await createChange({
      cwd: app,
      title: "Review analytics",
      now: testNow,
      randomId: () => "b8ff",
      sessionPath: sessionPath(root),
    });

    expect(result.targets).toHaveLength(1);
    await expect(stat(path.join(root, "wiki", "changes", result.id, "exploration.md"))).resolves.toMatchObject({});
    await expect(stat(path.join(app, "wiki"))).rejects.toThrow();
    expect(result.targets[0].path).toBe(await realpath(root));
  });

  it("retries generated ids instead of overwriting an existing change folder", async () => {
    const cwd = await tempDir();
    const existing = path.join(cwd, "wiki", "changes", "260522-f3q9-analytics-of-reviews");
    await mkdir(existing, { recursive: true });
    const ids = ["f3q9", "z9zz"];

    const result = await createChange({
      cwd,
      title: "Analytics of reviews",
      now: testNow,
      randomId: () => ids.shift() ?? "z9zz",
      sessionPath: sessionPath(cwd),
    });

    expect(result.id).toBe("260522-z9zz-analytics-of-reviews");
    await expect(stat(path.join(cwd, "wiki", "changes", result.id))).resolves.toMatchObject({});
  });

  it("resolves workspace sub-repo cwd to the workspace change root", async () => {
    const workspace = await rawTempDir();
    await writeWorkspaceMetadata(workspace, "workspace");
    await initGit(workspace);
    const billing = path.join(workspace, "billing");
    const nested = path.join(billing, "src");
    await mkdir(nested, { recursive: true });
    const session = sessionPath(workspace);

    const created = await createChange({
      cwd: nested,
      title: "Change workflow scaffold",
      now: testNow,
      randomId: () => "f3q9",
      sessionPath: session,
    });
    const current = await currentChange({ cwd: nested, sessionPath: session });

    expect(created.targets[0].path).toBe(await realpath(workspace));
    expect(current.targets[0]).toMatchObject({ path: await realpath(workspace), current: expect.objectContaining({ id: created.id }) });
    await expect(stat(path.join(workspace, "wiki", "changes", created.id, "exploration.md"))).resolves.toMatchObject({});
    await expect(stat(path.join(billing, "wiki"))).rejects.toThrow();
    await expect(stat(session)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails clearly outside any Weave context", async () => {
    const cwd = await rawTempDir();

    await expect(currentChange({ cwd, sessionPath: sessionPath(cwd) })).rejects.toMatchObject({
      code: "no_weave_context",
    });
    await expect(createChange({ cwd, title: "Outside context", sessionPath: sessionPath(cwd) })).rejects.toMatchObject({
      code: "no_weave_context",
    });
  });

  it("does not record created changes as local session routing state", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);

    const result = await createChange({
      cwd,
      title: "Active change commands",
      now: testNow,
      randomId: () => "w3ye",
      sessionPath: session,
    });
    await expect(stat(session)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.message).toContain("current");
  });

  it("lists changes with the active marker", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);
    const created = await createChange({
      cwd,
      title: "Active change commands",
      now: testNow,
      randomId: () => "w3ye",
      sessionPath: session,
    });

    const result = await listChanges({ cwd, sessionPath: session });

    expect(result.targets[0].changes).toContainEqual(expect.objectContaining({ id: created.id, active: true }));
    expect(result.message).toContain(`* ${created.id}`);
  });

  it("shows current changes from branch state", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);
    const created = await createChange({
      cwd,
      title: "Active change commands",
      now: testNow,
      randomId: () => "w3ye",
      sessionPath: session,
    });

    const result = await currentChange({ cwd, sessionPath: session });

    expect(result.targets[0]).toMatchObject({
      source: "branch",
      resolution: "branch_active",
      current: expect.objectContaining({ id: created.id }),
    });
  });

  it("reads current changes from matching branches without writing current_change", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);
    const created = await createChange({
      cwd,
      title: "Active change commands",
      now: testNow,
      randomId: () => "w3ye",
      sessionPath: session,
    });
    await writeFile(session, YAML.stringify({ version: 1, updated_at: testNow.toISOString(), folders: {} }));

    const result = await currentChange({ cwd, sessionPath: session, now: testNow });
    const parsed = YAML.parse(await readFile(session, "utf8"));

    expect(result.targets[0]).toMatchObject({
      source: "branch",
      resolution: "branch_active",
      saved: false,
      current: expect.objectContaining({ id: created.id }),
    });
    expect(Object.values(parsed.folders)).toEqual([]);
  });

  it("ignores stale current_change when the branch points at another change", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);
    const first = await createChange({ cwd, title: "First change", now: testNow, randomId: () => "a111", sessionPath: session });
    await commitAll(cwd, "first change");
    const second = await createChange({ cwd, title: "Second change", now: testNow, randomId: () => "b222", sessionPath: session });
    await writeFile(
      session,
      YAML.stringify({
        version: 1,
        updated_at: testNow.toISOString(),
        folders: {
          stale: {
            path: cwd,
            name: "Stale",
            kind: "app",
            current_change: {
              id: first.id,
              path: path.join("wiki", "changes", first.id),
              branch: first.branch,
              updated_at: testNow.toISOString(),
            },
          },
        },
      }),
    );

    const result = await currentChange({ cwd, sessionPath: session, now: testNow });

    expect(result.targets[0]).toMatchObject({
      source: "branch",
      resolution: "branch_active",
      current: expect.objectContaining({ id: second.id }),
      branchMatch: "match",
    });
    expect(result.targets[0].mismatch).toBeUndefined();
  });

  it("ignores stale current_change on non-change branches", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);
    const created = await createChange({ cwd, title: "Session stale", now: testNow, randomId: () => "s111", sessionPath: session });
    await commitAll(cwd, "session stale");
    await git(cwd, ["checkout", "-b", "main"]);
    await writeFile(
      session,
      YAML.stringify({
        version: 1,
        updated_at: testNow.toISOString(),
        folders: {
          stale: {
            path: cwd,
            name: "Stale",
            kind: "app",
            current_change: {
              id: created.id,
              path: path.join("wiki", "changes", created.id),
              branch: created.branch,
              updated_at: testNow.toISOString(),
            },
          },
        },
      }),
    );

    const result = await currentChange({ cwd, sessionPath: session, now: testNow });

    expect(result.targets[0]).toMatchObject({
      source: "none",
      resolution: "no_active_change",
    });
    expect(result.targets[0].current).toBeUndefined();
  });

  it("reports invalid active branch when the change folder is missing", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);
    await git(cwd, ["checkout", "-b", "change/260522-miss-missing-change"]);

    const result = await currentChange({ cwd, sessionPath: session, now: testNow });

    expect(result.targets[0]).toMatchObject({
      source: "none",
      resolution: "invalid_active_branch",
      branch: "change/260522-miss-missing-change",
    });
    expect(result.targets[0].current).toBeUndefined();
  });

  it("switches to existing changes by token and blocks dirty worktrees", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);
    await initGit(cwd);
    const first = await createChange({
      cwd,
      title: "First change",
      now: testNow,
      randomId: () => "a111",
      sessionPath: session,
    });
    await commitAll(cwd, "first change");
    const second = await createChange({
      cwd,
      title: "Second change",
      now: testNow,
      randomId: () => "b222",
      sessionPath: session,
    });
    await commitAll(cwd, "second change");

    const switched = await switchChange({ cwd, change: "a111", sessionPath: session, now: testNow });
    await writeFile(path.join(cwd, "dirty.txt"), "dirty\n");

    await expect(switchChange({ cwd, change: second.id, sessionPath: session })).rejects.toThrow("Uncommitted changes");
    expect(switched.change.id).toBe(first.id);
    await expect(git(cwd, ["branch", "--show-current"])).resolves.toBe(first.branch);
  });


  it("reports status for explicit changes without activating them", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);
    const created = await createChange({
      cwd,
      title: "Active change commands",
      now: testNow,
      randomId: () => "w3ye",
      sessionPath: session,
    });

    const result = await statusChange({ cwd, change: created.id, sessionPath: session });

    expect(result.targets[0]).toMatchObject({
      source: "explicit",
      change: expect.objectContaining({ id: created.id }),
      active: true,
    });
  });

  it("records research evidence lanes without moving the change stage", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);
    const created = await createChange({
      cwd,
      title: "Research lanes",
      type: "fix",
      now: testNow,
      randomId: () => "r111",
      sessionPath: session,
    });
    const changePath = path.join(cwd, "wiki", "changes", created.id);
    await writeFile(path.join(changePath, "questions.md"), "# Research Questions\n\n1. How does billing finalise invoices today?\n");

    const questions = await progressChange({ cwd, stage: "questions", sources: ["discussion"], sessionPath: session, now: testNow });
    const research = await progressChange({ cwd, stage: "research", sessionPath: session, now: testNow });
    const status = YAML.parse(await readFile(path.join(changePath, "status.yml"), "utf8"));

    expect(questions.change.stage).toBe("started");
    expect(research.change.stage).toBe("started");
    expect(research.sources).toEqual(["questions"]);
    expect(status).toMatchObject({
      stage: "started",
      artifacts: {
        questions: { sources: ["discussion"] },
        research: { sources: ["questions"] },
      },
    });
  });

  it("keeps the furthest product lane as stage when research is refreshed later", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);
    await createChange({ cwd, title: "Research refresh", now: testNow, randomId: () => "r222", sessionPath: session });

    await progressChange({ cwd, stage: "prd", sources: ["exploration"], sessionPath: session, now: testNow });
    const research = await progressChange({ cwd, stage: "research", sources: ["questions", "codebase"], sessionPath: session, now: testNow });

    expect(research.change.stage).toBe("prd");
  });

  it("propagates staleness from questions through research to lanes that cite research", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);
    await createChange({ cwd, title: "Research staleness", now: testNow, randomId: () => "r333", sessionPath: session });

    await progressChange({ cwd, stage: "questions", sources: ["discussion"], sessionPath: session, now: testNow });
    await progressChange({ cwd, stage: "research", sources: ["questions", "codebase"], sessionPath: session, now: testNow });
    await progressChange({ cwd, stage: "prd", sources: ["exploration", "research"], sessionPath: session, now: testNow });
    await progressChange({ cwd, stage: "architecture", sources: ["prd", "codebase"], sessionPath: session, now: testNow });

    const later = new Date(2026, 4, 22, 11, 0, 0);
    const result = await progressChange({ cwd, stage: "questions", sources: ["discussion"], sessionPath: session, now: later });

    expect(Object.keys(result.change.stale).sort()).toEqual(["architecture", "prd", "research"]);
    expect(result.change.stale.research).toMatchObject({ invalidated_by: "questions" });
    expect(result.change.stage).toBe("architecture");
  });

  it("marks a stress test verdict outdated once its shape changes", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);
    await createChange({ cwd, title: "Verdict freshness", now: testNow, randomId: () => "v111", sessionPath: session });
    await progressChange({ cwd, stage: "exploration", sources: ["discussion"], sessionPath: session, now: testNow });

    const judged = await verdictChange({ cwd, lane: "exploration", verdict: "holds", sessionPath: session, now: testNow });
    expect(judged.stress_test).toMatchObject({ verdict: "holds", outdated: false, artifact_updated_at: testNowIso });

    const later = new Date(2026, 4, 22, 11, 0, 0);
    await progressChange({ cwd, stage: "exploration", sources: ["discussion"], sessionPath: session, now: later });
    const status = await statusChange({ cwd, sessionPath: session });
    const change = status.targets[0]?.change;

    expect(change?.stress_tests.exploration).toMatchObject({ verdict: "holds", outdated: true });
    expect(status.message).toContain("Stress test (exploration): holds (outdated: shape changed since)");
  });

  it("records a waived stress test only with a reason", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);
    await createChange({ cwd, title: "Verdict waiver", now: testNow, randomId: () => "v222", sessionPath: session });

    await expect(
      verdictChange({ cwd, lane: "architecture", verdict: "waived", sessionPath: session, now: testNow }),
    ).rejects.toMatchObject({ code: "missing_reason" });

    const waived = await verdictChange({
      cwd,
      lane: "architecture",
      verdict: "waived",
      reason: "Copy-only change with no design risk",
      sessionPath: session,
      now: testNow,
    });
    expect(waived.stress_test).toMatchObject({ verdict: "waived", reason: "Copy-only change with no design risk", outdated: false });
  });

  it("records source-aware progress metadata without upstream inference", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);
    const created = await createChange({
      cwd,
      title: "Lifecycle state",
      now: testNow,
      randomId: () => "l111",
      sessionPath: session,
    });
    const changePath = path.join(cwd, "wiki", "changes", created.id);
    await writeFile(path.join(changePath, "architecture.md"), "# Architecture\n\nSubstantive architecture.\n");

    const progressed = await progressChange({
      cwd,
      stage: "architecture",
      sources: ["discussion", "codebase"],
      sessionPath: session,
      now: testNow,
    });
    const status = YAML.parse(await readFile(path.join(changePath, "status.yml"), "utf8"));

    expect(progressed.change).toMatchObject({
      id: created.id,
      stage: "architecture",
      stale: {},
      artifacts: {
        architecture: {
          sources: ["discussion", "codebase"],
          updated_at: testNow.toISOString(),
        },
      },
    });
    expect(status).toMatchObject({
      stage: "architecture",
      artifacts: {
        architecture: {
          sources: ["discussion", "codebase"],
          updated_at: testNow.toISOString(),
        },
      },
    });
    expect(status.stale).toBeUndefined();
  });

  it("infers architecture as slices source from substantive folder-mode architecture", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);
    const created = await createChange({
      cwd,
      title: "Folder architecture lifecycle",
      now: testNow,
      randomId: () => "lf01",
      sessionPath: session,
    });
    const changePath = path.join(cwd, "wiki", "changes", created.id);
    const architecturePath = path.join(changePath, "architecture");
    await mkdir(architecturePath);
    await writeFile(path.join(architecturePath, "schema.md"), "# Schema\n\nSubstantive schema design.\n");

    const progressed = await progressChange({
      cwd,
      stage: "slices",
      sessionPath: session,
      now: testNow,
    });
    const status = YAML.parse(await readFile(path.join(changePath, "status.yml"), "utf8"));

    expect(progressed.sources).toEqual(["architecture"]);
    expect(progressed.note).toBeUndefined();
    expect(status.artifacts.slices.sources).toEqual(["architecture"]);
  });

  it("does not infer architecture as slices source from scaffold-only folder-mode architecture", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);
    const created = await createChange({
      cwd,
      title: "Empty folder architecture lifecycle",
      now: testNow,
      randomId: () => "lf02",
      sessionPath: session,
    });
    const changePath = path.join(cwd, "wiki", "changes", created.id);
    const architecturePath = path.join(changePath, "architecture");
    await mkdir(architecturePath);
    await writeFile(path.join(architecturePath, "index.md"), "# Architecture\n");

    const progressed = await progressChange({
      cwd,
      stage: "slices",
      sessionPath: session,
      now: testNow,
    });
    const status = YAML.parse(await readFile(path.join(changePath, "status.yml"), "utf8"));

    expect(progressed.sources).toEqual([]);
    expect(progressed.note).toContain("No sources recorded for slices");
    expect(status.artifacts.slices.sources).toEqual([]);
  });

  it("does not stale direct architecture when PRD progresses", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);
    const created = await createChange({
      cwd,
      title: "Direct architecture",
      now: testNow,
      randomId: () => "l222",
      sessionPath: session,
    });
    const changePath = path.join(cwd, "wiki", "changes", created.id);
    await writeFile(path.join(changePath, "prd.md"), "# PRD\n\nSubstantive PRD.\n");
    await writeFile(path.join(changePath, "architecture.md"), "# Architecture\n\nSubstantive architecture.\n");

    await progressChange({
      cwd,
      stage: "architecture",
      sources: ["discussion", "codebase"],
      sessionPath: session,
      now: testNow,
    });
    const progressed = await progressChange({
      cwd,
      stage: "prd",
      sources: ["exploration"],
      sessionPath: session,
      now: new Date(2026, 4, 22, 11, 0, 0),
    });

    expect(progressed.change.stage).toBe("architecture");
    expect(progressed.change.stale).toEqual({});
  });

  it("stales transitive dependents from recorded artifact sources", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);
    const created = await createChange({
      cwd,
      title: "Transitive lifecycle state",
      now: testNow,
      randomId: () => "l333",
      sessionPath: session,
    });
    const changePath = path.join(cwd, "wiki", "changes", created.id);
    await writeFile(path.join(changePath, "prd.md"), "# PRD\n\nSubstantive PRD.\n");
    await writeFile(path.join(changePath, "architecture.md"), "# Architecture\n\nSubstantive architecture.\n");
    await writeFile(path.join(changePath, "tasks.md"), "# Tasks\n\n- [ ] Build it.\n");

    await progressChange({ cwd, stage: "architecture", sources: ["prd", "codebase"], sessionPath: session, now: testNow });
    await progressChange({ cwd, stage: "slices", sessionPath: session, now: new Date(2026, 4, 22, 10, 30, 0) });
    const progressed = await progressChange({
      cwd,
      stage: "prd",
      sources: ["exploration"],
      sessionPath: session,
      now: new Date(2026, 4, 22, 11, 0, 0),
    });
    const status = YAML.parse(await readFile(path.join(changePath, "status.yml"), "utf8"));

    expect(progressed.change.stage).toBe("slices");
    expect(progressed.change.stale).toMatchObject({
      architecture: { invalidated_by: "prd", invalidated_at: new Date(2026, 4, 22, 11, 0, 0).toISOString() },
      slices: { invalidated_by: "prd", invalidated_at: new Date(2026, 4, 22, 11, 0, 0).toISOString() },
    });
    expect(status.artifacts.slices.sources).toEqual(["architecture"]);
  });

  it("records a no-source note when progress has no sources or default", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);
    const created = await createChange({
      cwd,
      title: "No source progress",
      now: testNow,
      randomId: () => "l444",
      sessionPath: session,
    });
    const changePath = path.join(cwd, "wiki", "changes", created.id);

    const progressed = await progressChange({ cwd, stage: "prd", sessionPath: session, now: testNow });
    const status = YAML.parse(await readFile(path.join(changePath, "status.yml"), "utf8"));

    expect(progressed.sources).toEqual([]);
    expect(progressed.note).toContain("No sources recorded for prd");
    expect(progressed.message).toContain("Note: No sources recorded for prd");
    expect(status.artifacts.prd.sources).toEqual([]);
  });

  it("rejects unknown progress sources before writing status", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);
    const created = await createChange({
      cwd,
      title: "Unknown source",
      now: testNow,
      randomId: () => "l555",
      sessionPath: session,
    });
    const changePath = path.join(cwd, "wiki", "changes", created.id);

    await expect(
      progressChange({ cwd, stage: "architecture", sources: ["prd", "browser"], sessionPath: session, now: testNow }),
    ).rejects.toMatchObject({ code: "unsupported_source" });
    const status = YAML.parse(await readFile(path.join(changePath, "status.yml"), "utf8"));
    expect(status.artifacts).toBeUndefined();
  });

  it("clears only the refreshed stale lane and keeps stage from regressing", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);
    const created = await createChange({
      cwd,
      title: "Refresh lifecycle state",
      now: testNow,
      randomId: () => "l666",
      sessionPath: session,
    });
    const changePath = path.join(cwd, "wiki", "changes", created.id);
    await writeFile(path.join(changePath, "prd.md"), "# PRD\n\nSubstantive PRD.\n");
    await writeFile(path.join(changePath, "architecture.md"), "# Architecture\n\nSubstantive architecture.\n");
    await writeFile(path.join(changePath, "tasks.md"), "# Tasks\n\n- [ ] Build it.\n");

    await progressChange({ cwd, stage: "architecture", sources: ["prd"], sessionPath: session, now: testNow });
    await progressChange({ cwd, stage: "slices", sessionPath: session, now: new Date(2026, 4, 22, 10, 30, 0) });
    await progressChange({ cwd, stage: "prd", sources: ["exploration"], sessionPath: session, now: new Date(2026, 4, 22, 11, 0, 0) });
    const refreshed = await progressChange({
      cwd,
      stage: "architecture",
      sources: ["prd", "codebase"],
      sessionPath: session,
      now: new Date(2026, 4, 22, 11, 30, 0),
    });
    const status = await statusChange({ cwd, sessionPath: session });

    expect(refreshed.change.stage).toBe("slices");
    expect(refreshed.change.stale.prd).toBeUndefined();
    expect(refreshed.change.stale.architecture).toBeUndefined();
    expect(refreshed.change.stale.slices).toMatchObject({ invalidated_by: "architecture" });
    expect(status.message).toContain("Stage: slices");
    expect(status.message).toContain("Stale: slices (invalidated by architecture)");
  });

  it("records knowledge lifecycle metadata without changing stage", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);
    const created = await createChange({
      cwd,
      title: "Knowledge lifecycle",
      now: testNow,
      randomId: () => "k111",
      sessionPath: session,
    });
    await progressChange({ cwd, stage: "architecture", sources: ["prd", "codebase"], sessionPath: session, now: testNow });

    const result = await knowledgeChange({
      cwd,
      status: "updated",
      domains: ["performance-reviews", "performance-reviews"],
      shared: ["approvals"],
      files: ["wiki/knowledge/domains/performance-reviews/index.md", "wiki/knowledge/domains/performance-reviews/index.md"],
      delta: path.join("wiki", "changes", created.id, "knowledge-delta.md"),
      reason: "Updated performance review behavior.",
      sessionPath: session,
      now: new Date(2026, 4, 22, 12, 0, 0),
    });
    const status = YAML.parse(await readFile(path.join(cwd, "wiki", "changes", created.id, "status.yml"), "utf8"));
    const current = await statusChange({ cwd, sessionPath: session });

    expect(result.change.stage).toBe("architecture");
    expect(result.knowledge).toMatchObject({
      status: "updated",
      domains: ["performance-reviews"],
      shared: ["approvals"],
      files: ["wiki/knowledge/domains/performance-reviews/index.md"],
      delta: path.join("wiki", "changes", created.id, "knowledge-delta.md"),
      reason: "Updated performance review behavior.",
    });
    expect(status.stage).toBe("architecture");
    expect(status.knowledge).toMatchObject({
      status: "updated",
      domains: ["performance-reviews"],
      shared: ["approvals"],
      files: ["wiki/knowledge/domains/performance-reviews/index.md"],
    });
    expect(current.message).toContain("Knowledge: updated");
  });

  it("records stale knowledge invalidation and clears it when resolved", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);
    const created = await createChange({
      cwd,
      title: "Knowledge stale",
      now: testNow,
      randomId: () => "k222",
      sessionPath: session,
    });

    const stale = await knowledgeChange({
      cwd,
      status: "stale",
      domains: ["performance-reviews"],
      invalidatedBy: "prd",
      reason: "PRD changed after knowledge update.",
      sessionPath: session,
      now: new Date(2026, 4, 22, 12, 0, 0),
    });
    const resolved = await knowledgeChange({
      cwd,
      status: "none",
      reason: "No durable knowledge impact.",
      sessionPath: session,
      now: new Date(2026, 4, 22, 12, 30, 0),
    });
    const status = YAML.parse(await readFile(path.join(cwd, "wiki", "changes", created.id, "status.yml"), "utf8"));

    expect(stale.knowledge).toMatchObject({
      status: "stale",
      invalidated_by: "prd",
      invalidated_at: new Date(2026, 4, 22, 12, 0, 0).toISOString(),
    });
    expect(resolved.knowledge).toMatchObject({
      status: "none",
      domains: ["performance-reviews"],
      reason: "No durable knowledge impact.",
    });
    expect(resolved.knowledge.invalidated_by).toBeUndefined();
    expect(status.knowledge.invalidated_by).toBeUndefined();
    expect(status.knowledge.invalidated_at).toBeUndefined();
  });

  it("marks resolved knowledge stale when lifecycle progress changes upstream context", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);
    const created = await createChange({
      cwd,
      title: "Knowledge invalidation",
      now: testNow,
      randomId: () => "k333",
      sessionPath: session,
    });
    await knowledgeChange({
      cwd,
      status: "updated",
      domains: ["performance-reviews"],
      files: ["wiki/knowledge/domains/performance-reviews/index.md"],
      reason: "Knowledge updated.",
      sessionPath: session,
      now: testNow,
    });

    const progressed = await progressChange({
      cwd,
      stage: "prd",
      sources: ["exploration"],
      sessionPath: session,
      now: new Date(2026, 4, 22, 13, 0, 0),
    });
    const status = YAML.parse(await readFile(path.join(cwd, "wiki", "changes", created.id, "status.yml"), "utf8"));

    expect(progressed.change.knowledge).toMatchObject({
      status: "stale",
      domains: ["performance-reviews"],
      files: ["wiki/knowledge/domains/performance-reviews/index.md"],
      invalidated_by: "prd",
      invalidated_at: new Date(2026, 4, 22, 13, 0, 0).toISOString(),
    });
    expect(progressed.message).toContain("Knowledge: stale (invalidated by prd)");
    expect(status.knowledge.reason).toBe("prd changed after knowledge was marked updated.");
  });

  it("rejects unsupported knowledge invalidation sources before writing status", async () => {
    const cwd = await tempDir();
    const session = sessionPath(cwd);
    const created = await createChange({
      cwd,
      title: "Bad knowledge source",
      now: testNow,
      randomId: () => "k444",
      sessionPath: session,
    });

    await expect(
      knowledgeChange({ cwd, status: "stale", invalidatedBy: "browser", sessionPath: session, now: testNow }),
    ).rejects.toMatchObject({ code: "unsupported_knowledge_invalidation_source" });
    const status = YAML.parse(await readFile(path.join(cwd, "wiki", "changes", created.id, "status.yml"), "utf8"));
    expect(status.knowledge).toBeUndefined();
  });
});
