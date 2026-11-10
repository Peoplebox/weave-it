import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { createChange } from "../src/lib/changes.js";
import type { ChangeType } from "../src/lib/changes.js";
import {
  buildSlicePackage,
  labelForeignFiles,
  mostCapableLineThreshold,
  nextRunNumber,
  parseFileAnchors,
  parseTaskEvidence,
  sliceModelLevel,
} from "../src/lib/review/package.js";
import { SnapshotBoundary } from "../src/lib/review/boundary.js";
import { reviewContextForChangePath, type ReviewContext } from "../src/lib/review/state.js";

const execFileAsync = promisify(execFile);
const testNow = new Date(2026, 10, 10, 10, 0, 0);
const originalCwd = process.cwd();
const originalSessionEnv = process.env.WEAVE_SESSION_PATH;
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Weave Test",
  GIT_AUTHOR_EMAIL: "weave@example.com",
  GIT_COMMITTER_NAME: "Weave Test",
  GIT_COMMITTER_EMAIL: "weave@example.com",
};

afterEach(() => {
  process.chdir(originalCwd);
  if (originalSessionEnv === undefined) {
    delete process.env.WEAVE_SESSION_PATH;
  } else {
    process.env.WEAVE_SESSION_PATH = originalSessionEnv;
  }
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv });
  return stdout.trim();
}

// Adapted from a real slice's tasks.md: T1 done with a human check, T2 not_tested, T3 invalid, and a
// `Human check:` line outside `### Verification` that must not count.
const realSliceTasks = `---
artifact: tasks
slice: 04-slice-review-package
status: draft
---

# Tasks: Slice review package

## Active Task Index

| ID | Status | Execution | Repos | Owner | Title | Blocked by |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | done | afk | root | | Parse task evidence | None |
| T2 | not_tested | afk | root | | Assemble the slice diff | None |
| T3 | invalid | afk | root | | Build the context manifest | T1, T2 |

## root

### T1: Parse task evidence

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- \`src/lib/review/package.ts\` (C: \`parseTaskEvidence\`)
- \`templates/skills/weave-slices/tasks-template.md\` (M)

### What to build

Human check: this line is in the build notes and must not count.

### Acceptance Criteria

- [x] A \`Human check:\` line anywhere except under \`### Verification\` is not counted.

### Verification

- Automated tests: \`npx vitest run tests/review-package.test.ts\`
- Human check: open the package in an editor and confirm it reads well
- 2026-11-10: 12 tests passed.

### T2: Assemble the slice diff

Status: not_tested
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- src/lib/review/ (M: diff assembly)

### What to build

Diff assembly.

### Verification

- Automated tests: could not run, git missing in the sandbox.

### T3: Build the context manifest

Status: invalid
Owner:
Repos: root
Execution: afk
Blocked by: T1, T2
Files:
- \`src/commands/review.ts\` (M)

### Verification

- Human check: ignored because the task is invalid

## QA Findings

None.

## Verification

- Human check: change-level notes are not a task's verification.
`;

describe("parseTaskEvidence", () => {
  it("classifies untested and invalid tasks and reads human checks only under ### Verification", () => {
    const evidence = parseTaskEvidence(realSliceTasks);
    expect(evidence.untested).toEqual([{ id: "T2", title: "Assemble the slice diff", status: "not_tested" }]);
    expect(evidence.humanChecks).toEqual([{ task: "T1", step: "open the package in an editor and confirm it reads well" }]);
    expect(evidence.evidence).toEqual([
      { task: "T1", lines: ["- Automated tests: `npx vitest run tests/review-package.test.ts`", "- 2026-11-10: 12 tests passed."] },
      { task: "T2", lines: ["- Automated tests: could not run, git missing in the sandbox."] },
    ]);
  });

  it("prefers the index status over a stale detail status", () => {
    const stale = realSliceTasks.replace("| T1 | done |", "| T1 | not_tested |");
    expect(parseTaskEvidence(stale).untested.map((task) => task.id)).toEqual(["T1", "T2"]);
  });

  it("reads Files: anchors of active tasks", () => {
    expect(parseFileAnchors(realSliceTasks)).toEqual([
      { path: "src/lib/review/package.ts", repos: ["root"] },
      { path: "templates/skills/weave-slices/tasks-template.md", repos: ["root"] },
      { path: "src/lib/review/", repos: ["root"] },
    ]);
  });
});

describe("labelForeignFiles", () => {
  const slice = {
    repos: ["root", "api"],
    anchors: [
      { path: "src/lib/review/", repos: ["root"] },
      { path: "src/cli.ts", repos: [] },
      { path: "api/server/routes", repos: ["api"] },
    ],
  };

  it("owns files under an anchor and labels the rest foreign", () => {
    const files = [
      { repo: "root", path: "src/lib/review/package.ts" },
      { repo: "root", path: "src/cli.ts" },
      { repo: "root", path: "src/cli.tsx" },
      { repo: "root", path: "src/lib/other.ts" },
      { repo: "api", path: "server/routes/users.ts", repoDir: "api" },
      { repo: "api", path: "src/lib/review/x.ts", repoDir: "api" },
      { repo: "web", path: "src/cli.ts", repoDir: "web" },
    ];
    const { owned, foreign } = labelForeignFiles(files, slice);
    expect(owned.map((file) => `${file.repo}:${file.path}`)).toEqual(["root:src/lib/review/package.ts", "root:src/cli.ts", "api:server/routes/users.ts"]);
    expect(foreign.map((file) => `${file.repo}:${file.path}`)).toEqual([
      "root:src/cli.tsx",
      "root:src/lib/other.ts",
      "api:src/lib/review/x.ts",
      "web:src/cli.ts",
    ]);
  });
});

describe("sliceModelLevel and nextRunNumber", () => {
  it("raises the model level above the size threshold", () => {
    expect(sliceModelLevel(mostCapableLineThreshold)).toBe("mid");
    expect(sliceModelLevel(mostCapableLineThreshold + 1)).toBe("most_capable");
  });

  it("allocates one more than the highest run seen in refs, files, and run ids", () => {
    expect(nextRunNumber([])).toBe(1);
    expect(nextRunNumber(["start", "r2/end", "r10/round1-start"])).toBe(11);
    expect(nextRunNumber(["r3.report.md", "r4-round1.patch", "r1.package.md", "review.md"])).toBe(5);
    expect(nextRunNumber(["r7"])).toBe(8);
  });
});

// --- packages built in a temporary repo --------------------------------------------------------

const readyTasks = `# Tasks

## Active Task Index

| ID | Status | Execution | Repos | Owner | Title | Blocked by |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | done | afk | root | | Owned work | None |

### T1: Owned work

Status: done
Repos: root
Files:
- \`src/owned/\` (C)

### Verification

- Automated tests passed.
`;

async function setup(type: ChangeType, extra: { decisions?: Record<string, string[]> } = {}): Promise<{ root: string; ctx: ReviewContext }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-review-package-")));
  await mkdir(path.join(root, ".weave"), { recursive: true });
  await writeFile(path.join(root, ".weave", "workspace.yml"), YAML.stringify({ version: 1, mode: "repo", name: "fixture", repos: {} }));
  await writeFile(
    path.join(root, ".weave", "agents.yml"),
    YAML.stringify({ version: 1, installed: { claude: { skills: { "weave-review": { path: ".claude/skills/weave-review/SKILL.md" } } } } }),
  );
  await mkdir(path.join(root, "wiki", "decisions"), { recursive: true });
  for (const [id, appliesTo] of Object.entries(extra.decisions ?? {})) {
    const [status, ...patterns] = appliesTo;
    await writeFile(
      path.join(root, "wiki", "decisions", `${id}.md`),
      `---\nid: ${id}\ntitle: Decision ${id}\nstatus: ${status}\ndate: 2026-11-10\napplies_to:\n${patterns.map((pattern) => `  - ${pattern}`).join("\n")}\nsupersedes: []\n---\n\n# Decision ${id}\n`,
    );
  }
  await mkdir(path.join(root, "src", "owned"), { recursive: true });
  await writeFile(path.join(root, "src", "owned", "a.ts"), "export const a = 1;\n");
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "initial"]);

  const session = path.join(root, ".session.yml");
  const created = await createChange({ cwd: root, title: "Package", type, now: testNow, randomId: () => "pk01", sessionPath: session });
  process.env.WEAVE_SESSION_PATH = session;
  process.chdir(root);
  const changePath = path.join(root, "wiki", "changes", created.id);
  const slicePath = path.join(changePath, "task-slices", "01-work");
  await mkdir(slicePath, { recursive: true });
  await writeFile(path.join(slicePath, "status.yml"), YAML.stringify({ version: 1, id: "01-work", title: "Work", status: "done", repos: ["root"], depends_on: [] }));
  await writeFile(path.join(slicePath, "tasks.md"), readyTasks);
  await writeFile(path.join(slicePath, "slice.md"), "# Work\n");
  const ctx = reviewContextForChangePath(changePath);
  if (!ctx) throw new Error("bad fixture");
  return { root, ctx };
}

describe("buildSlicePackage manifest", () => {
  it("lists PRD, architecture, slice.md, matching accepted decisions, and absent shared guidelines for a feat change", async () => {
    const { root, ctx } = await setup("feat", {
      decisions: {
        "261110-aaaa": ["accepted", "src/owned/**"],
        "261110-bbbb": ["proposed", "src/owned/**"],
        "261110-cccc": ["accepted", "docs/**"],
      },
    });
    await mkdir(path.join(ctx.changePath, "architecture"), { recursive: true });
    await writeFile(path.join(ctx.changePath, "prd.md"), "# PRD\n");
    await writeFile(path.join(ctx.changePath, "architecture", "schema.md"), "# Schema\n");
    await writeFile(path.join(ctx.changePath, "architecture", "index.md"), "# Index\n");
    await writeFile(path.join(root, "src", "owned", "a.ts"), "export const a = 2;\n");

    const result = await buildSlicePackage(ctx, "01", { now: testNow });
    const text = await readFile(result.package_path, "utf8");
    const changeDir = `wiki/changes/${ctx.changeId}`;
    expect(text).toContain(`- PRD: \`${changeDir}/prd.md\``);
    expect(text.indexOf(`${changeDir}/architecture/index.md`)).toBeLessThan(text.indexOf(`${changeDir}/architecture/schema.md`));
    expect(text).toContain(`- Slice: \`${changeDir}/task-slices/01-work/slice.md\``);
    expect(text).toContain("`261110-aaaa`: Decision 261110-aaaa (`wiki/decisions/261110-aaaa.md`)");
    expect(text).not.toContain("261110-bbbb");
    expect(text).not.toContain("261110-cccc");
    expect(text).toContain("- Shared: no shared guidelines found (`.weave/coding-guidelines.md` is absent)");
    expect(text).toContain("### Task evidence (claims to verify)");
    expect(text).toContain("- Automated tests passed.");
  });

  it("lists findings.md for a fix change and exploration.md for a chore change", async () => {
    const fix = await setup("fix");
    await writeFile(path.join(fix.ctx.changePath, "findings.md"), "# Findings\n");
    const fixText = await readFile((await buildSlicePackage(fix.ctx, "01", { now: testNow })).package_path, "utf8");
    expect(fixText).toContain(`- Findings: \`wiki/changes/${fix.ctx.changeId}/findings.md\``);
    expect(fixText).not.toContain("prd.md");
    expect(fixText).not.toContain("Architecture:");

    const chore = await setup("chore");
    await mkdir(path.join(chore.ctx.changePath, "architecture"), { recursive: true });
    await writeFile(path.join(chore.ctx.changePath, "architecture", "index.md"), "# Index\n");
    const choreText = await readFile((await buildSlicePackage(chore.ctx, "01", { now: testNow })).package_path, "utf8");
    expect(choreText).toContain(`- Exploration: \`wiki/changes/${chore.ctx.changeId}/exploration.md\``);
    expect(choreText).toContain(`- Architecture: \`wiki/changes/${chore.ctx.changeId}/architecture/index.md\``);
    expect(choreText).not.toContain("findings.md");
  });

  it("lists a present shared guidelines file, keeps the package out of git status, and writes --out", async () => {
    const { root, ctx } = await setup("feat");
    await writeFile(path.join(root, ".weave", "coding-guidelines.md"), "# Coding guidelines\n");
    await git(root, ["add", ".weave/coding-guidelines.md"]);
    await git(root, ["commit", "-q", "-m", "guidelines"]);
    const statusBefore = await git(root, ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"]);

    const result = await buildSlicePackage(ctx, "01", { now: testNow });
    expect(result.package_path).toBe(path.join(root, ".weave", "tmp", "reviews", ctx.changeId, "01-work", "r1.package.md"));
    expect(await readFile(path.join(root, ".weave", "tmp", ".gitignore"), "utf8")).toBe("*\n");
    expect(await readFile(result.package_path, "utf8")).toContain("- Shared: `.weave/coding-guidelines.md`");
    // Only the slice status.yml changed (it gained its review block); the package stays invisible.
    const statusAfter = await git(root, ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"]);
    expect(statusAfter).toBe(statusBefore);
    expect(statusAfter).not.toContain(".weave/tmp");

    const out = path.join(root, "elsewhere", "pkg.md");
    const second = await buildSlicePackage(ctx, "01", { now: testNow, out });
    expect(second.run_id).toBe("01-work/r2");
    expect(second.package_path).toBe(out);
    expect(await readFile(out, "utf8")).toContain("# Review package: 01-work/r2");
    expect(await readFile(path.join(root, ".weave", "tmp", "reviews", ctx.changeId, "01-work", "r2.package.md"), "utf8")).toContain(out);
  });

  it("keeps wiki/changes out of the diff and counts lines for the size hint", async () => {
    const { root, ctx } = await setup("feat");
    await new SnapshotBoundary().create({ repoPath: root, ref: `refs/weave/reviews/${ctx.changeId}/01-work/start` });
    await writeFile(path.join(ctx.changePath, "task-slices", "01-work", "status.yml"), YAML.stringify({ version: 1, id: "01-work", title: "Work", status: "done", repos: ["root"], depends_on: [], review: { start_ref: `refs/weave/reviews/${ctx.changeId}/01-work/start` } }));
    const big = Array.from({ length: mostCapableLineThreshold + 10 }, (_, index) => `export const v${index} = ${index};`).join("\n");
    await writeFile(path.join(root, "src", "owned", "big.ts"), `${big}\n`);
    await writeFile(path.join(ctx.changePath, "notes.md"), "planning edit\n");

    const result = await buildSlicePackage(ctx, "01", { now: testNow });
    expect(result).toMatchObject({ fallback_base: null, foreign_files: 0, model_level: "most_capable", size_hint: { files: 1, lines: mostCapableLineThreshold + 10 } });
    const text = await readFile(result.package_path, "utf8");
    const diffSections = text.slice(0, text.indexOf("## Context"));
    expect(diffSections).not.toContain("wiki/changes/");
    expect(diffSections).not.toContain("notes.md");
    expect(diffSections).toContain("src/owned/big.ts");
  });
});
