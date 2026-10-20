import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changeCommand } from "../src/commands/change.js";
import { createChange, progressChange } from "../src/lib/changes.js";

const testNow = new Date(2026, 4, 22, 10, 0, 0);

const originalCwd = process.cwd();
const originalSessionEnv = process.env.WEAVE_SESSION_PATH;
const execFileAsync = promisify(execFile);

afterEach(() => {
  process.chdir(originalCwd);
  if (originalSessionEnv === undefined) {
    delete process.env.WEAVE_SESSION_PATH;
  } else {
    process.env.WEAVE_SESSION_PATH = originalSessionEnv;
  }
  process.exitCode = undefined;
});

async function setup(): Promise<{ cwd: string; session: string; changePath: string }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "weave-cli-progress-"));
  await writeWorkspaceMetadata(cwd);
  await initGit(cwd);
  const session = path.join(cwd, ".session.yml");
  const created = await createChange({
    cwd,
    title: "Cli progress",
    now: testNow,
    randomId: () => "cp01",
    sessionPath: session,
  });
  const changePath = path.join(cwd, "wiki", "changes", created.id);
  // The CLI `progress` action reads cwd from process.cwd() and the session from
  // WEAVE_SESSION_PATH, so point both at this temp fixture.
  process.env.WEAVE_SESSION_PATH = session;
  process.chdir(cwd);
  return { cwd, session, changePath };
}

async function initGit(cwd: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd });
}

async function writeWorkspaceMetadata(cwd: string): Promise<void> {
  await mkdir(path.join(cwd, ".weave"), { recursive: true });
  await writeFile(
    path.join(cwd, ".weave", "workspace.yml"),
    YAML.stringify({
      version: 1,
      mode: "repo",
      name: path.basename(cwd),
      repos: {},
    }),
  );
}

async function setupWithDownstream(): Promise<{ cwd: string; session: string; changePath: string }> {
  const fixture = await setup();
  await writeFile(path.join(fixture.changePath, "prd.md"), "# PRD\n\nFirst draft.\n");
  await writeFile(path.join(fixture.changePath, "architecture.md"), "# Architecture\n\nFirst draft.\n");
  await writeFile(path.join(fixture.changePath, "tasks.md"), "# Tasks\n\n- [ ] One.\n");
  await progressChange({ cwd: fixture.cwd, stage: "architecture", sources: ["prd"], sessionPath: fixture.session, now: testNow });
  await progressChange({
    cwd: fixture.cwd,
    stage: "slices",
    sources: ["architecture"],
    sessionPath: fixture.session,
    now: new Date(2026, 4, 22, 10, 30, 0),
  });
  return fixture;
}

async function runChange(args: string[]): Promise<Record<string, unknown>> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  });
  try {
    const command = changeCommand();
    command.exitOverride();
    await command.parseAsync(args, { from: "user" });
  } finally {
    spy.mockRestore();
  }
  return YAML.parse(chunks.join("")) as Record<string, unknown>;
}

async function readStatus(changePath: string): Promise<Record<string, unknown>> {
  return YAML.parse(await readFile(path.join(changePath, "status.yml"), "utf8")) as Record<string, unknown>;
}

describe("change progress CLI flag wiring", () => {
  it("default path advances the lane without the `raw.trim` crash", async () => {
    const { changePath } = await setup();

    const result = await runChange(["progress", "architecture", "--source", "prd", "--json"]);

    expect(result.status).toBe("ok");
    expect(result).not.toMatchObject({ message: "raw.trim is not a function" });
    expect((result.change as Record<string, unknown>).stage).toBe("architecture");

    const status = await readStatus(changePath);
    expect(status.stage).toBe("architecture");
  });

  it("--no-invalidate suppresses downstream stale propagation", async () => {
    const { changePath } = await setupWithDownstream();

    const result = await runChange(["progress", "prd", "--source", "exploration", "--no-invalidate", "--json"]);

    expect(result.status).toBe("ok");
    const status = await readStatus(changePath);
    expect(status.stale ?? {}).toEqual({});
  });

  it("--invalidate marks only the named subset stale", async () => {
    const { changePath } = await setupWithDownstream();

    const result = await runChange(["progress", "prd", "--source", "exploration", "--invalidate", "issues", "--json"]);

    expect(result.status).toBe("ok");
    const status = await readStatus(changePath);
    expect(status.stale as Record<string, unknown>).toMatchObject({ slices: { invalidated_by: "prd" } });
    expect((status.stale as Record<string, unknown>).architecture).toBeUndefined();
  });
});

describe("change verdict CLI wiring", () => {
  it("records a verdict pinned to the lane's latest progress", async () => {
    const { changePath } = await setup();
    await runChange(["progress", "exploration", "--source", "discussion", "--json"]);

    const result = await runChange([
      "verdict",
      "exploration",
      "holds-with-changes",
      "--reason",
      "Leave handling added",
      "--session",
      "wiki/changes/x/sessions/20260522-100000-ab12-exploration-stress-test.md",
      "--json",
    ]);

    expect(result.status).toBe("ok");
    expect(result.stress_test).toMatchObject({ verdict: "holds-with-changes", outdated: false, reason: "Leave handling added" });
    const status = await readStatus(changePath);
    const artifacts = status.artifacts as Record<string, { updated_at: string }>;
    expect(status.stress_tests).toMatchObject({
      exploration: {
        verdict: "holds-with-changes",
        artifact_updated_at: artifacts.exploration.updated_at,
        session: "wiki/changes/x/sessions/20260522-100000-ab12-exploration-stress-test.md",
      },
    });
  });

  it("refuses a waived verdict without a reason", async () => {
    await setup();

    const result = await runChange(["verdict", "exploration", "waived", "--json"]);

    expect(result).toMatchObject({ status: "error" });
    expect(JSON.stringify(result)).toContain("needs --reason");
  });
});

