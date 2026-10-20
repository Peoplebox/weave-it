import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(projectRoot, "scripts", "bump-skill-versions.mjs");

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

async function makeFakeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "weave-bump-"));
  await mkdir(path.join(root, "templates", "skills"), { recursive: true });
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "weave-it", version: "0.2.0" }));

  const scriptSource = await readFile(scriptPath, "utf8");
  await writeFile(path.join(root, "scripts", "bump-skill-versions.mjs"), scriptSource);

  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  return root;
}

async function writeSkill(root: string, name: string, lastChangedIn: string, body = "Body"): Promise<void> {
  const skillDir = path.join(root, "templates", "skills", name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Skill ${name}\nlicense: MIT\nmetadata:\n  author: weave-tools\n  last_changed_in: "${lastChangedIn}"\n---\n\n${body}\n`,
  );
}

async function writeLegacySkill(root: string, name: string, lastChangedIn: string, body = "Body"): Promise<void> {
  const skillDir = path.join(root, "templates", "skills", name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Skill ${name}\nlast_changed_in: ${lastChangedIn}\n---\n\n${body}\n`,
  );
}

function runBump(cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["scripts/bump-skill-versions.mjs"], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function readLastChangedIn(root: string, name: string): Promise<string | null> {
  const content = await readFile(path.join(root, "templates", "skills", name, "SKILL.md"), "utf8");
  const match = /^\s*last_changed_in:\s*"?([^"\n]*)"?$/m.exec(content);
  return match?.[1] ?? null;
}

describe("scripts/bump-skill-versions.mjs", () => {
  it("updates only skills that changed since the previous tag", async () => {
    const root = await makeFakeRepo();
    await writeSkill(root, "weave-explore", "0.1.0", "Original Explore");
    await writeSkill(root, "weave-prd", "0.1.0", "Original PRD");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "initial"]);
    git(root, ["tag", "v0.1.0"]);

    await writeSkill(root, "weave-explore", "0.1.0", "Updated Explore");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "modify explore"]);

    const result = runBump(root);
    expect(result.status).toBe(0);

    expect(await readLastChangedIn(root, "weave-explore")).toBe("0.2.0");
    expect(await readLastChangedIn(root, "weave-prd")).toBe("0.1.0");
  });

  it("bumps every skill when no prior tag is reachable", async () => {
    const root = await makeFakeRepo();
    await writeSkill(root, "weave-explore", "0.1.0");
    await writeSkill(root, "weave-prd", "0.1.0");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "initial"]);

    const result = runBump(root);
    expect(result.status).toBe(0);

    expect(await readLastChangedIn(root, "weave-explore")).toBe("0.2.0");
    expect(await readLastChangedIn(root, "weave-prd")).toBe("0.2.0");
  });

  it("defaults missing last_changed_in to the upcoming version with a warning", async () => {
    const root = await makeFakeRepo();
    const skillDir = path.join(root, "templates", "skills", "weave-no-version");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: weave-no-version\ndescription: Missing\n---\n\nBody\n",
    );
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "initial"]);

    const result = runBump(root);
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/last_changed_in missing/);
    expect(await readLastChangedIn(root, "weave-no-version")).toBe("0.2.0");
  });

  it("moves a legacy top-level last_changed_in under metadata when bumping", async () => {
    const root = await makeFakeRepo();
    await writeLegacySkill(root, "weave-legacy", "0.1.0");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "initial"]);

    const result = runBump(root);
    expect(result.status).toBe(0);

    const content = await readFile(path.join(root, "templates", "skills", "weave-legacy", "SKILL.md"), "utf8");
    expect(content).not.toMatch(/^last_changed_in:/m);
    expect(content).toContain('metadata:\n  last_changed_in: "0.2.0"\n---');
  });

  it("keeps other metadata keys when bumping", async () => {
    const root = await makeFakeRepo();
    await writeSkill(root, "weave-explore", "0.1.0");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "initial"]);

    runBump(root);

    const content = await readFile(path.join(root, "templates", "skills", "weave-explore", "SKILL.md"), "utf8");
    expect(content).toContain('metadata:\n  author: weave-tools\n  last_changed_in: "0.2.0"\n---');
  });

  it("never invokes git commit or git tag (audit by snapshotting git log)", async () => {
    const root = await makeFakeRepo();
    await writeSkill(root, "weave-explore", "0.1.0");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "initial"]);

    const logBefore = execFileSync("git", ["log", "--oneline"], { cwd: root, encoding: "utf8" });
    const tagsBefore = execFileSync("git", ["tag"], { cwd: root, encoding: "utf8" });

    runBump(root);

    const logAfter = execFileSync("git", ["log", "--oneline"], { cwd: root, encoding: "utf8" });
    const tagsAfter = execFileSync("git", ["tag"], { cwd: root, encoding: "utf8" });
    expect(logAfter).toBe(logBefore);
    expect(tagsAfter).toBe(tagsBefore);
  });
});
