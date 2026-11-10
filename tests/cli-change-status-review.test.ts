import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { installAgentSkills } from "../src/lib/agent-skills.js";
import { createChange, statusChange } from "../src/lib/changes.js";
import { buildStatus } from "../src/lib/status.js";

const execFileAsync = promisify(execFile);
const testNow = new Date(2026, 10, 10, 10, 0, 0);
const originalSessionEnv = process.env.WEAVE_SESSION_PATH;
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Weave Test",
  GIT_AUTHOR_EMAIL: "weave@example.com",
  GIT_COMMITTER_NAME: "Weave Test",
  GIT_COMMITTER_EMAIL: "weave@example.com",
};

afterEach(() => {
  if (originalSessionEnv === undefined) {
    delete process.env.WEAVE_SESSION_PATH;
  } else {
    process.env.WEAVE_SESSION_PATH = originalSessionEnv;
  }
});

function taskTable(statuses: string[]): string {
  return [
    "# Tasks",
    "",
    "## Active Task Index",
    "",
    "| ID | Status | Execution | Repos | Owner | Title | Blocked by |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...statuses.map((status, index) => `| T${index + 1} | ${status} | afk | root | | Task ${index + 1} | None |`),
    "",
  ].join("\n");
}

interface Fixture {
  root: string;
  changePath: string;
  changeStatus: string;
  session: string;
}

// A repo-mode Weave root in a temporary git repo with one change. `installed` registers the
// review skill in `.weave/agents.yml`; `fullInstall` installs every bundled skill for claude.
async function setup(options: { installed?: boolean; enabled?: boolean; fullInstall?: boolean } = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-change-status-review-")));
  await mkdir(path.join(root, ".weave"), { recursive: true });
  await writeFile(
    path.join(root, ".weave", "workspace.yml"),
    YAML.stringify({ version: 1, mode: "repo", name: "fixture", repos: {}, ...(options.enabled === false ? { review: { enabled: false } } : {}) }),
  );
  if (options.fullInstall) {
    await installAgentSkills({ cwd: root, agent: "claude" });
  } else if (options.installed) {
    await writeFile(
      path.join(root, ".weave", "agents.yml"),
      YAML.stringify({ version: 1, installed: { claude: { skills: { "weave-review": { path: ".claude/skills/weave-review/SKILL.md" } } } } }),
    );
  }
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(path.join(root, ".gitignore"), "/.session.yml\n");
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: root, env: gitEnv });
  await execFileAsync("git", ["add", "-A"], { cwd: root, env: gitEnv });
  await execFileAsync("git", ["commit", "-q", "-m", "initial"], { cwd: root, env: gitEnv });
  const session = path.join(root, ".session.yml");
  const created = await createChange({ cwd: root, title: "Status review", now: testNow, randomId: () => "cs09", sessionPath: session });
  const changePath = path.join(root, "wiki", "changes", created.id);
  process.env.WEAVE_SESSION_PATH = session;
  return { root, changePath, changeStatus: path.join(changePath, "status.yml"), session };
}

async function setChangeReview(fixture: Fixture, review: Record<string, unknown> | undefined): Promise<void> {
  const status = YAML.parse(await readFile(fixture.changeStatus, "utf8")) as Record<string, unknown>;
  if (review === undefined) delete status.review;
  else status.review = review;
  await writeFile(fixture.changeStatus, YAML.stringify(status));
}

async function addSlice(fixture: Fixture, id: string, statuses: string[], review?: Record<string, unknown>): Promise<void> {
  const slicePath = path.join(fixture.changePath, "task-slices", id);
  await mkdir(slicePath, { recursive: true });
  await writeFile(
    path.join(slicePath, "status.yml"),
    YAML.stringify({
      version: 1,
      id,
      title: id,
      status: "pending",
      owner: "",
      repos: ["root"],
      depends_on: [],
      task_summary: { total: 0, done: 0, blocked: 0 },
      ...(review ? { review } : {}),
    }),
  );
  await writeFile(path.join(slicePath, "slice.md"), `# ${id}\n`);
  await writeFile(path.join(slicePath, "tasks.md"), taskTable(statuses));
}

async function changeStatus(fixture: Fixture): Promise<{ text: string; change: Record<string, any> }> {
  const result = await statusChange({ cwd: fixture.root, sessionPath: fixture.session });
  return { text: result.message, change: result.targets[0].change as unknown as Record<string, any> };
}

function lineKeys(text: string): string[] {
  return text.split("\n").map((line) => line.split(":")[0]);
}

const adopted = { adopted_at: testNow.toISOString() };

describe("weave change status: review lines", () => {
  it("renders each slice state in PRD wording, the final state, and the JSON review object", async () => {
    const fixture = await setup({ installed: true });
    await setChangeReview(fixture, adopted);
    await addSlice(fixture, "01-none", ["done"]);
    await addSlice(fixture, "02-in", ["done"], { state: "in_review" });
    await addSlice(fixture, "03-clean", ["done"], { state: "reviewed" });
    await addSlice(fixture, "04-rulings", ["done"], { state: "reviewed_with_rulings", counts: { open_rulings: 1 } });
    await addSlice(fixture, "05-wait", ["done"], { state: "waiting_on_person" });
    await addSlice(fixture, "06-stale", ["done"], { state: "reviewed", fingerprint: { root: { "src/a.ts": "0".repeat(40) } } });
    await addSlice(fixture, "07-open", ["todo"]);

    const { text, change } = await changeStatus(fixture);
    const review = text.split("\n").find((line) => line.startsWith("Review: "));
    expect(review).toBe(
      "Review: slice 01 tasks done, not reviewed · slice 02 in review · slice 03 reviewed · slice 04 reviewed (1 ruling) · " +
        "slice 05 waiting on you: plan problem · slice 06 reviewed, out of date (code changed) · slice 07 tasks open · final: not started",
    );
    // The review lines follow the stress-test lines and come before auto-advance.
    const keys = lineKeys(text);
    expect(keys.indexOf("Review")).toBe(keys.indexOf("Auto-advance") - 1);
    expect(text).not.toContain("Verdict:");

    expect(change.review).toMatchObject({ active: true, inactive_cause: null, skipped: null, final: { state: "not_started", verdict: null } });
    expect(change.review.slices.find((slice: { id: string }) => slice.id === "06-stale")).toMatchObject({
      stored_state: "reviewed",
      effective_state: "out_of_date",
      out_of_date_reasons: ["code_changed"],
    });
    expect(change.review.slices.find((slice: { id: string }) => slice.id === "04-rulings").counts).toMatchObject({ open_rulings: 1 });
  });

  it("is read-only: a slice finished before adoption shows as predates review without writing", async () => {
    const fixture = await setup({ installed: true });
    await addSlice(fixture, "01-old", ["done"]);
    const before = await readFile(fixture.changeStatus, "utf8");
    const { text } = await changeStatus(fixture);
    expect(text).toContain("Review: slice 01 predates review · final: not started");
    expect(await readFile(fixture.changeStatus, "utf8")).toBe(before);
    expect(YAML.parse(await readFile(path.join(fixture.changePath, "task-slices", "01-old", "status.yml"), "utf8")).review).toBeUndefined();
  });

  it("renders all three verdicts with the parked count, open rulings, partial reviews, and out of date", async () => {
    const fixture = await setup({ installed: true });
    await addSlice(fixture, "01-done", ["done"], { state: "reviewed" });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ state: "ready_to_merge" }, "Verdict: ready to merge"],
      [{ state: "ready_with_parked_items", counts: { parked_items: 4, open_rulings: 2 } }, "Verdict: ready with parked items (4) · 2 rulings"],
      [{ state: "not_ready", counts: { plan_problems_open: 1 } }, "Verdict: not ready: waiting on you"],
      [{ state: "not_ready", partial: true }, "Verdict: not ready: partial review"],
      [{ state: "ready_to_merge", fingerprint: { root: { "src/a.ts": "0".repeat(40) } } }, "Verdict: ready to merge, out of date (code changed)"],
    ];
    for (const [block, expected] of cases) {
      await setChangeReview(fixture, { ...adopted, ...block });
      const { text, change } = await changeStatus(fixture);
      expect(text).toContain("Review: slice 01 reviewed · final: done");
      expect(text.split("\n").find((line) => line.startsWith("Verdict: "))).toBe(expected);
      expect(change.review.final.verdict).toBe(block.state);
    }
    const { change } = await changeStatus(fixture);
    expect(change.review.final).toMatchObject({ out_of_date: true, out_of_date_reasons: ["code_changed"] });
  });

  it("shows review skipped with its reason, and the workspace switch as skipped", async () => {
    const skipped = await setup({ installed: true });
    await addSlice(skipped, "01-a", ["done"]);
    await setChangeReview(skipped, { ...adopted, skipped: { reason: "docs only", at: testNow.toISOString() } });
    const result = await changeStatus(skipped);
    expect(result.text.split("\n").filter((line) => /^(Review|Verdict):/.test(line))).toEqual(["Review: skipped (docs only)"]);
    expect(result.change.review).toMatchObject({
      active: false,
      inactive_cause: "change_skipped",
      skipped: { reason: "docs only" },
      slices: [{ id: "01-a", effective_state: "skipped" }],
      final: { state: "skipped" },
    });

    const off = await setup({ installed: true, enabled: false });
    await addSlice(off, "01-a", ["done"], { state: "reviewed" });
    const offResult = await changeStatus(off);
    expect(offResult.text).toContain("Review: skipped (review is off for this workspace)");
    expect(offResult.change.review).toMatchObject({ inactive_cause: "workspace_off", slices: [{ effective_state: "skipped", stored_state: "reviewed" }] });
    expect(offResult.change.review.final.state).not.toBe("skipped");
  });

  it("shows stored states only when the skill is not installed but review data exists", async () => {
    const fixture = await setup();
    await addSlice(fixture, "01-a", ["done"], { state: "reviewed" });
    await addSlice(fixture, "02-b", ["done"]);
    const { text, change } = await changeStatus(fixture);
    expect(text).toContain("Review: slice 01 reviewed\n");
    expect(change.review).toMatchObject({ active: false, inactive_cause: "skill_not_installed", final: { state: null } });
    expect(change.review.slices.map((slice: { effective_state: unknown }) => slice.effective_state)).toEqual(["reviewed", null]);
  });

  it("shows review unreadable and keeps going when review data cannot be read", async () => {
    const fixture = await setup({ installed: true });
    await addSlice(fixture, "01-a", ["done"]);
    // A file where the task-slices folder should be makes the slice listing fail.
    await rm(path.join(fixture.changePath, "task-slices"), { recursive: true });
    await writeFile(path.join(fixture.changePath, "task-slices"), "not a folder\n");
    const { text, change } = await changeStatus(fixture);
    expect(text).toContain("Review: unreadable");
    expect(text).toContain("Branch match:");
    expect(change.review).toMatchObject({ unreadable: true });
  });
});

describe("weave status: review line", () => {
  it("shows the verdict of the active change, and the JSON review object", async () => {
    const fixture = await setup({ installed: true });
    await addSlice(fixture, "01-done", ["done"], { state: "reviewed" });
    await setChangeReview(fixture, { ...adopted, state: "ready_with_parked_items", counts: { parked_items: 3 } });
    const status = await buildStatus({ cwd: fixture.root, npmLatest: null, env: { WEAVE_NO_NOTICES: "1" } as NodeJS.ProcessEnv });
    const id = path.basename(fixture.changePath);
    expect(status.message).toContain(`Review (${id}): verdict: ready with parked items (3)`);
    expect(status.review).toMatchObject({ change: id, active: true, final: { verdict: "ready_with_parked_items" } });
  });

  it("summarises slice states before the final review", async () => {
    const fixture = await setup({ installed: true });
    await setChangeReview(fixture, adopted);
    await addSlice(fixture, "01-a", ["done"], { state: "reviewed" });
    await addSlice(fixture, "02-b", ["done"], { state: "reviewed_with_rulings", counts: { open_rulings: 2 } });
    await addSlice(fixture, "03-c", ["done"]);
    const status = await buildStatus({ cwd: fixture.root, npmLatest: null, env: { WEAVE_NO_NOTICES: "1" } as NodeJS.ProcessEnv });
    expect(status.message).toContain(
      `Review (${path.basename(fixture.changePath)}): 1 reviewed · 1 reviewed with rulings · 1 tasks done, not reviewed · final: not started`,
    );
  });

  it("has no review line and review: null outside any change", async () => {
    const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-status-outside-")));
    const status = await buildStatus({ cwd: outside, npmLatest: null, env: { WEAVE_NO_NOTICES: "1" } as NodeJS.ProcessEnv });
    expect(status.review).toBeNull();
    expect(status.message).not.toContain("Review (");
  });

  it("lists the skills_available notice under Notices", async () => {
    const fixture = await setup({ fullInstall: true });
    const manifestPath = path.join(fixture.root, ".weave", "agents.yml");
    const manifest = YAML.parse(await readFile(manifestPath, "utf8")) as { installed: { claude: { skills: Record<string, unknown> } } };
    delete manifest.installed.claude.skills["weave-capture"];
    await writeFile(manifestPath, YAML.stringify(manifest));
    const status = await buildStatus({ cwd: fixture.root, npmLatest: null, env: {} as NodeJS.ProcessEnv });
    expect(status.notices.map((notice) => notice.kind)).toContain("skills_available");
    const lines = status.message.split("\n");
    const header = lines.findIndex((line) => line.startsWith("Notices ("));
    expect(header).toBeGreaterThan(-1);
    expect(lines.slice(header + 1)).toContain(
      "- [skills_available] Bundled skills not installed for claude: weave-capture. Run 'weave agent install claude' to add them.",
    );
  });
});

describe("regression: no review data and review inactive", () => {
  const expectedKeys = ["Status in /x", "Title", "Type", "Stage", "Auto-advance", "Branch", "Path", "Active", "Branch match", "Source"];

  for (const [name, options] of [
    ["the skill is not installed", {}],
    ["the workspace switch is off", { installed: true, enabled: false }],
  ] as const) {
    it(`leaves weave change status and weave status unchanged when ${name}`, async () => {
      const fixture = await setup(options);
      await addSlice(fixture, "01-a", ["done"]);
      await addSlice(fixture, "02-b", ["todo"]);
      const before = await readFile(fixture.changeStatus, "utf8");
      const { text, change } = await changeStatus(fixture);
      expect(text).not.toMatch(/^(Review|Verdict):/m);
      expect(lineKeys(text).map((key, index) => (index === 0 ? "Status in /x" : key))).toEqual(expectedKeys);
      expect(change).not.toHaveProperty("review");
      expect(await readFile(fixture.changeStatus, "utf8")).toBe(before);

      const status = await buildStatus({ cwd: fixture.root, npmLatest: null, env: { WEAVE_NO_NOTICES: "1" } as NodeJS.ProcessEnv });
      expect(status.review).toBeNull();
      expect(status.message).not.toContain("Review (");
    });
  }
});
