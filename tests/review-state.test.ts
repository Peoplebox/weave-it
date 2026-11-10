import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { changeLockPath, withChangeLock } from "../src/lib/local-state.js";
import {
  adoptChange,
  readChangeReview,
  readSliceReview,
  reviewActivation,
  reviewContextForChangePath,
  updateChangeReview,
  updateSliceReview,
  type ReviewContext,
} from "../src/lib/review/state.js";
import { readWorkspaceMetadata, registerRepoInWorkspaceMetadata } from "../src/lib/workspace-repos.js";

const execFileAsync = promisify(execFile);
const changeId = "261110-abcd-review-state";

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

function tasksMarkdown(statuses: string[]): string {
  const rows = statuses.map((status, index) => `| T${index + 1} | ${status} | afk | root | | Task ${index + 1} | None |`);
  const details = statuses.map((status, index) => `### T${index + 1}: Task ${index + 1}\n\nStatus: ${status}\nRepos: root\n`);
  return [
    "# Tasks",
    "",
    "## Active Task Index",
    "",
    "| ID | Status | Execution | Repos | Owner | Title | Blocked by |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "## root",
    "",
    ...details,
  ].join("\n");
}

function sliceStatus(id: string, dependsOn: string[] = []): string {
  return YAML.stringify({
    version: 1,
    id,
    title: id,
    status: "pending",
    owner: "",
    repos: ["root"],
    depends_on: dependsOn,
    task_summary: { total: 0, done: 0, blocked: 0 },
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
  });
}

async function installReviewSkill(root: string): Promise<void> {
  await writeFile(
    path.join(root, ".weave", "agents.yml"),
    YAML.stringify({
      version: 1,
      installed: {
        claude: {
          skills: {
            "weave-review": {
              path: ".claude/skills/weave-review/SKILL.md",
              source_hash: "sha256:x",
              installed_hash: "sha256:x",
              installed_at: "2026-11-01T00:00:00.000Z",
              installed_from: null,
            },
          },
        },
      },
    }),
  );
}

interface Fixture {
  root: string;
  ctx: ReviewContext;
}

async function fixture(options: {
  git?: boolean;
  installed?: boolean;
  workspace?: Record<string, unknown>;
  slices?: Record<string, string[]>;
} = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-review-state-")));
  if (options.git !== false) {
    await git(root, ["init", "-q"]);
  }
  await mkdir(path.join(root, ".weave"), { recursive: true });
  await writeFile(
    path.join(root, ".weave", "workspace.yml"),
    YAML.stringify({ version: 1, mode: "repo", name: "fixture", repos: {}, ...(options.workspace ?? {}) }),
  );
  if (options.installed !== false) {
    await installReviewSkill(root);
  }
  const changePath = path.join(root, "wiki", "changes", changeId);
  await mkdir(changePath, { recursive: true });
  await writeFile(path.join(changePath, "status.yml"), YAML.stringify({ id: changeId, stage: "slices", updated_at: "2026-11-01T00:00:00.000Z" }));
  for (const [id, statuses] of Object.entries(options.slices ?? { "01-alpha": ["todo"] })) {
    const slicePath = path.join(changePath, "task-slices", id);
    await mkdir(slicePath, { recursive: true });
    await writeFile(path.join(slicePath, "status.yml"), sliceStatus(id));
    await writeFile(path.join(slicePath, "tasks.md"), tasksMarkdown(statuses));
  }
  const ctx = reviewContextForChangePath(changePath);
  if (!ctx) {
    throw new Error("fixture context");
  }
  return { root, ctx };
}

function sliceStatusPath(ctx: ReviewContext, id: string): string {
  return path.join(ctx.changePath, "task-slices", id, "status.yml");
}

describe("withChangeLock", () => {
  it("shares one lock directory between worktrees of a repo", async () => {
    const { root } = await fixture();
    await git(root, ["add", "."]);
    await git(root, ["-c", "user.name=Weave Test", "-c", "user.email=weave@example.com", "commit", "-qm", "init"]);
    const worktree = path.join(await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-review-wt-"))), "wt");
    await git(root, ["worktree", "add", "-q", "-b", "other", worktree]);

    const fromMain = await changeLockPath(root, changeId);
    const fromWorktree = await changeLockPath(worktree, changeId);
    expect(fromMain).toBe(path.join(root, ".git", "weave", "locks", `change-${changeId}`));
    expect(fromWorktree).toBe(fromMain);

    await withChangeLock(worktree, changeId, async () => {
      await expect(stat(fromMain as string)).resolves.toBeTruthy();
    });
    await expect(stat(fromMain as string)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs without a lock and creates no .git folder outside a git repo", async () => {
    const { root, ctx } = await fixture({ git: false });
    expect(await changeLockPath(root, changeId)).toBeUndefined();
    await updateSliceReview(ctx, "01-alpha", () => ({ start_ref: "refs/weave/reviews/x/01-alpha/start" }));
    expect((await readSliceReview(sliceStatusPath(ctx, "01-alpha")))?.start_ref).toBe("refs/weave/reviews/x/01-alpha/start");
    await expect(stat(path.join(root, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("updateSliceReview", () => {
  it("loses no update across twenty concurrent writers", async () => {
    const { ctx } = await fixture();
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        updateSliceReview(ctx, "01-alpha", (current) => ({ ...(current ?? {}), [`key_${index}`]: index })),
      ),
    );
    const review = await readSliceReview(sliceStatusPath(ctx, "01-alpha"));
    for (let index = 0; index < 20; index += 1) {
      expect(review?.[`key_${index}`]).toBe(index);
    }
    expect(typeof review?.updated_at).toBe("string");
  });

  it("leaves every other key in the file as it was", async () => {
    const { ctx } = await fixture();
    const file = sliceStatusPath(ctx, "01-alpha");
    const before = `# kept comment\n${await readFile(file, "utf8")}`;
    await writeFile(file, before);

    await updateSliceReview(ctx, "01-alpha", () => ({ state: "in_review", latest_run: "r1" }));
    const after = await readFile(file, "utf8");
    const { review, ...rest } = YAML.parse(after) as Record<string, unknown>;
    expect(YAML.stringify(rest)).toBe(YAML.stringify(YAML.parse(before)));
    expect(review).toMatchObject({ state: "in_review", latest_run: "r1" });
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain("# kept comment");

    await updateSliceReview(ctx, "01-alpha", () => undefined);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("does not rewrite the file when nothing changes", async () => {
    const { ctx } = await fixture();
    const first = await updateSliceReview(ctx, "01-alpha", () => ({ state: "in_review" }), { now: new Date("2026-11-01T01:00:00Z") });
    const second = await updateSliceReview(ctx, "01-alpha", (current) => current, { now: new Date("2026-11-01T02:00:00Z") });
    expect(second?.updated_at).toBe(first?.updated_at);
  });

  it("reads a malformed block as absent", async () => {
    const { ctx } = await fixture();
    const file = sliceStatusPath(ctx, "01-alpha");
    await writeFile(file, `${await readFile(file, "utf8")}review: just text\n`);
    expect(await readSliceReview(file)).toBeUndefined();
    await writeFile(file, `${sliceStatus("01-alpha")}review:\n  state: unknown_state\n`);
    expect(await readSliceReview(file)).toBeUndefined();
  });

  it("fails for an unknown slice", async () => {
    const { ctx } = await fixture();
    await expect(updateSliceReview(ctx, "09-missing", () => ({}))).rejects.toMatchObject({ code: "slice_not_found" });
  });

  it("updates only the change review key", async () => {
    const { ctx } = await fixture();
    await updateChangeReview(ctx, () => ({ skipped: { reason: "docs only", at: "2026-11-01T00:00:00.000Z" } }));
    const raw = YAML.parse(await readFile(path.join(ctx.changePath, "status.yml"), "utf8")) as Record<string, unknown>;
    expect(raw).toMatchObject({ id: changeId, stage: "slices" });
    expect((await readChangeReview(ctx.changePath))?.skipped?.reason).toBe("docs only");
  });
});

describe("review settings", () => {
  it("defaults enabled to true and slice_rounds to 2", async () => {
    const { root } = await fixture();
    expect((await readWorkspaceMetadata(root))?.review).toEqual({ enabled: true, slice_rounds: 2, models: {} });
  });

  it("parses enabled, slice_rounds and models", async () => {
    const { root } = await fixture({
      workspace: {
        review: { enabled: false, slice_rounds: 3, models: { claude: { cheap: "haiku", mid: "sonnet", most_capable: "opus" } } },
      },
    });
    expect((await readWorkspaceMetadata(root))?.review).toEqual({
      enabled: false,
      slice_rounds: 3,
      models: { claude: { cheap: "haiku", mid: "sonnet", most_capable: "opus" } },
    });
  });

  it("keeps a review key when weave add registers a repo", async () => {
    const { root } = await fixture({ workspace: { review: { enabled: false, slice_rounds: 4 } } });
    await registerRepoInWorkspaceMetadata(root, { id: "api", relativePath: "api", kind: "app" });
    const raw = YAML.parse(await readFile(path.join(root, ".weave", "workspace.yml"), "utf8")) as Record<string, unknown>;
    expect(raw.review).toEqual({ enabled: false, slice_rounds: 4 });
    expect((raw.repos as Record<string, unknown>).api).toMatchObject({ path: "api", kind: "app" });
  });
});

describe("reviewActivation", () => {
  it("is active with the skill installed, review enabled, and the change not skipped", async () => {
    const { root, ctx } = await fixture();
    const activation = await reviewActivation(ctx);
    expect(activation).toEqual({
      active: true,
      enabled: true,
      skipped: false,
      installed: true,
      skill_paths: [path.join(root, ".claude", "skills", "weave-review", "SKILL.md")],
      settings: { slice_rounds: 2, models: {} },
    });
  });

  it("is inactive when review is disabled", async () => {
    const { ctx } = await fixture({ workspace: { review: { enabled: false } } });
    expect(await reviewActivation(ctx)).toMatchObject({ active: false, enabled: false, installed: true });
  });

  it("is inactive when the change is skipped", async () => {
    const { ctx } = await fixture();
    await updateChangeReview(ctx, () => ({ skipped: { reason: "docs only", at: "2026-11-01T00:00:00.000Z" } }));
    expect(await reviewActivation(ctx)).toMatchObject({ active: false, skipped: true, installed: true });
  });

  it("is inactive when no agent has the review skill", async () => {
    const { ctx } = await fixture({ installed: false });
    expect(await reviewActivation(ctx)).toMatchObject({ active: false, installed: false, skill_paths: [] });
  });
});

describe("adoptChange", () => {
  const slices = { "01-alpha": ["done", "not_tested"], "02-beta": ["done", "todo"], "03-gamma": ["done"] };

  it("writes nothing while review is inactive, then stamps ready slices once active", async () => {
    const { root, ctx } = await fixture({ installed: false, slices });
    const changeBefore = await readFile(path.join(ctx.changePath, "status.yml"), "utf8");
    expect(await adoptChange(ctx)).toEqual({ adopted: false, reason: "inactive", stamped: [] });
    expect(await readFile(path.join(ctx.changePath, "status.yml"), "utf8")).toBe(changeBefore);
    expect(await readSliceReview(sliceStatusPath(ctx, "01-alpha"))).toBeUndefined();

    // Installing the skill later makes the first active call adopt.
    await installReviewSkill(root);
    const result = await adoptChange(ctx, { now: new Date("2026-11-10T00:00:00.000Z") });
    expect(result).toEqual({ adopted: true, adopted_at: "2026-11-10T00:00:00.000Z", stamped: ["01-alpha", "03-gamma"] });
  });

  it("stamps predates_review only on ready slices with no review block, and only once", async () => {
    const { ctx } = await fixture({ slices });
    await updateSliceReview(ctx, "03-gamma", () => ({ start_ref: "refs/weave/reviews/c/03-gamma/start" }));
    const first = await adoptChange(ctx, { now: new Date("2026-11-10T00:00:00.000Z") });
    expect(first.stamped).toEqual(["01-alpha"]);
    expect((await readSliceReview(sliceStatusPath(ctx, "01-alpha")))?.state).toBe("predates_review");
    expect(await readSliceReview(sliceStatusPath(ctx, "02-beta"))).toBeUndefined();
    expect((await readSliceReview(sliceStatusPath(ctx, "03-gamma")))?.state).toBeUndefined();
    expect((await readChangeReview(ctx.changePath))?.adopted_at).toBe("2026-11-10T00:00:00.000Z");

    const files = await Promise.all(
      ["status.yml", "task-slices/01-alpha/status.yml", "task-slices/02-beta/status.yml"].map((file) => readFile(path.join(ctx.changePath, file), "utf8")),
    );
    const second = await adoptChange(ctx, { now: new Date("2026-11-11T00:00:00.000Z") });
    expect(second).toMatchObject({ adopted: false, reason: "already_adopted", stamped: [] });
    const filesAfter = await Promise.all(
      ["status.yml", "task-slices/01-alpha/status.yml", "task-slices/02-beta/status.yml"].map((file) => readFile(path.join(ctx.changePath, file), "utf8")),
    );
    expect(filesAfter).toEqual(files);
  });

  it("leaves a slice that becomes ready after adoption unstamped", async () => {
    const { ctx } = await fixture({ slices });
    await adoptChange(ctx);
    await writeFile(path.join(ctx.changePath, "task-slices", "02-beta", "tasks.md"), tasksMarkdown(["done", "done"]));
    await adoptChange(ctx);
    expect(await readSliceReview(sliceStatusPath(ctx, "02-beta"))).toBeUndefined();
  });

  it("does not stamp a slice with a malformed review block", async () => {
    const { ctx } = await fixture({ slices: { "01-alpha": ["done"] } });
    const file = sliceStatusPath(ctx, "01-alpha");
    const malformed = `${await readFile(file, "utf8")}review: hand note\n`;
    await writeFile(file, malformed);
    expect((await adoptChange(ctx)).stamped).toEqual([]);
    expect(await readFile(file, "utf8")).toBe(malformed);
  });
});
