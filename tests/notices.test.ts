import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { installAgentSkills } from "../src/lib/agent-skills.js";
import { detectAvailableSkills, detectSkillDrift, gatherNotices, isNewerVersion } from "../src/lib/notices.js";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "weave-notices-"));
}

describe("notices", () => {
  it("returns an empty array when no drift, no newer npm version, and no env overrides", async () => {
    const cwd = await tempDir();
    await installAgentSkills({ cwd, agent: "claude" });

    const notices = await gatherNotices({
      cwd,
      packageVersion: "0.1.0",
      npmLatest: "0.1.0",
      env: { ...process.env, WEAVE_NO_NOTICES: undefined } as NodeJS.ProcessEnv,
    });

    expect(notices).toEqual([]);
  });

  it("emits a package_outdated notice when npm latest is newer than installed", async () => {
    const cwd = await tempDir();
    await installAgentSkills({ cwd, agent: "claude" });

    const notices = await gatherNotices({
      cwd,
      packageVersion: "0.1.0",
      npmLatest: "0.2.0",
    });

    const outdated = notices.find((notice) => notice.kind === "package_outdated");
    expect(outdated).toBeDefined();
    expect(outdated?.details).toMatchObject({ installed: "0.1.0", latest: "0.2.0" });
  });

  it("does not emit a package_outdated notice when npm latest is older or equal", async () => {
    const cwd = await tempDir();
    await installAgentSkills({ cwd, agent: "claude" });

    const equal = await gatherNotices({ cwd, packageVersion: "0.2.0", npmLatest: "0.2.0" });
    const older = await gatherNotices({ cwd, packageVersion: "0.2.0", npmLatest: "0.1.5" });

    expect(equal.find((notice) => notice.kind === "package_outdated")).toBeUndefined();
    expect(older.find((notice) => notice.kind === "package_outdated")).toBeUndefined();
  });

  it("emits a skills_modified notice when an installed skill file is edited locally", async () => {
    const cwd = await tempDir();
    await installAgentSkills({ cwd, agent: "claude" });
    const installedPath = path.join(cwd, ".claude", "skills", "weave-explore", "SKILL.md");
    await writeFile(installedPath, "custom user edit\n");

    const notices = await gatherNotices({
      cwd,
      packageVersion: "0.1.0",
      npmLatest: "0.1.0",
    });
    const modified = notices.find((notice) => notice.kind === "skills_modified");

    expect(modified).toBeDefined();
    expect(modified?.details).toMatchObject({
      skills: expect.arrayContaining([
        expect.objectContaining({ agent: "claude", name: "weave-explore" }),
      ]),
    });
  });

  it("emits a skills_outdated notice when the bundled last_changed_in differs from installed_from", async () => {
    const cwd = await tempDir();
    const templatesDir = path.join(cwd, "templates", "skills");
    const skillDir = path.join(templatesDir, "weave-explore");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: weave-explore\ndescription: First\nlast_changed_in: 0.1.0\n---\n\nFirst\n",
    );

    await installAgentSkills({ cwd, agent: "claude", templatesDir });

    await writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: weave-explore\ndescription: First\nlast_changed_in: 0.2.0\n---\n\nFirst\n",
    );

    const installedPath = path.join(cwd, ".claude", "skills", "weave-explore", "SKILL.md");
    await writeFile(
      installedPath,
      "---\nname: weave-explore\ndescription: First\nlast_changed_in: 0.1.0\n---\n\nFirst\n",
    );

    const notices = await gatherNotices({
      cwd,
      packageVersion: "0.2.0",
      npmLatest: "0.2.0",
      templatesDir,
    });
    const outdated = notices.find((notice) => notice.kind === "skills_outdated");

    expect(outdated).toBeDefined();
    expect(outdated?.details).toMatchObject({
      skills: expect.arrayContaining([
        expect.objectContaining({
          agent: "claude",
          name: "weave-explore",
          installed_from: "0.1.0",
          current: "0.2.0",
        }),
      ]),
    });
  });

  it("returns an empty array when WEAVE_NO_NOTICES=1 even with drift present", async () => {
    const cwd = await tempDir();
    await installAgentSkills({ cwd, agent: "claude" });
    await writeFile(path.join(cwd, ".claude", "skills", "weave-explore", "SKILL.md"), "custom\n");

    const notices = await gatherNotices({
      cwd,
      packageVersion: "0.1.0",
      npmLatest: "9.9.9",
      env: { WEAVE_NO_NOTICES: "1" } as NodeJS.ProcessEnv,
    });

    expect(notices).toEqual([]);
  });

  it("detectSkillDrift surfaces both modified and outdated lanes separately", async () => {
    const cwd = await tempDir();
    const templatesDir = path.join(cwd, "templates", "skills");
    const exploreDir = path.join(templatesDir, "weave-explore");
    const captureDir = path.join(templatesDir, "weave-capture");
    await mkdir(exploreDir, { recursive: true });
    await mkdir(captureDir, { recursive: true });
    await writeFile(
      path.join(exploreDir, "SKILL.md"),
      "---\nname: weave-explore\ndescription: Explore\nlast_changed_in: 0.1.0\n---\n\nExplore\n",
    );
    await writeFile(
      path.join(captureDir, "SKILL.md"),
      "---\nname: weave-capture\ndescription: Capture\nlast_changed_in: 0.1.0\n---\n\nCapture\n",
    );

    await installAgentSkills({ cwd, agent: "claude", templatesDir });

    await writeFile(
      path.join(captureDir, "SKILL.md"),
      "---\nname: weave-capture\ndescription: Capture\nlast_changed_in: 0.2.0\n---\n\nCapture\n",
    );
    await writeFile(path.join(cwd, ".claude", "skills", "weave-explore", "SKILL.md"), "custom\n");

    const drift = await detectSkillDrift({ cwd, templatesDir });

    expect(drift.modified.map((entry) => entry.name)).toEqual(["weave-explore"]);
    expect(drift.outdated.map((entry) => entry.name)).toEqual(["weave-capture"]);
  });

  it("emits one skills_available notice naming a bundled skill a configured agent has not installed", async () => {
    const cwd = await tempDir();
    await installAgentSkills({ cwd, agent: "claude" });
    const manifestPath = path.join(cwd, ".weave", "agents.yml");
    const manifest = YAML.parse(await readFile(manifestPath, "utf8")) as { installed: { claude: { skills: Record<string, unknown> } } };
    delete manifest.installed.claude.skills["weave-explore"];
    await writeFile(manifestPath, YAML.stringify(manifest));

    const notices = await gatherNotices({ cwd, packageVersion: "0.1.0", npmLatest: "0.1.0", env: {} as NodeJS.ProcessEnv });
    const available = notices.filter((notice) => notice.kind === "skills_available");
    expect(available).toEqual([
      {
        kind: "skills_available",
        message: "Bundled skills not installed for claude: weave-explore. Run 'weave agent install claude' to add them.",
        details: { agents: { claude: ["weave-explore"] } },
      },
    ]);
  });

  it("lists every agent that is missing bundled skills in the one notice", async () => {
    const cwd = await tempDir();
    const templatesDir = path.join(cwd, "templates", "skills");
    for (const name of ["weave-capture", "weave-review"]) {
      await mkdir(path.join(templatesDir, name), { recursive: true });
      await writeFile(path.join(templatesDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\nlast_changed_in: 0.1.0\n---\n\nBody\n`);
    }
    await installAgentSkills({ cwd, agent: "claude", templatesDir });
    await installAgentSkills({ cwd, agent: "codex", templatesDir });
    const manifestPath = path.join(cwd, ".weave", "agents.yml");
    const manifest = YAML.parse(await readFile(manifestPath, "utf8")) as { installed: Record<string, { skills: Record<string, unknown> }> };
    delete manifest.installed.claude.skills["weave-review"];
    delete manifest.installed.codex.skills["weave-review"];
    await writeFile(manifestPath, YAML.stringify(manifest));

    expect(await detectAvailableSkills({ cwd, templatesDir })).toEqual({ claude: ["weave-review"], codex: ["weave-review"] });
    const notice = (await gatherNotices({ cwd, packageVersion: "0.1.0", templatesDir, env: {} as NodeJS.ProcessEnv })).find(
      (entry) => entry.kind === "skills_available",
    );
    expect(notice?.message).toBe(
      "Bundled skills not installed for claude: weave-review; codex: weave-review. Run 'weave agent install claude' and 'weave agent install codex' to add them.",
    );
  });

  it("emits no skills_available notice for a complete manifest, no manifest, or WEAVE_NO_NOTICES=1", async () => {
    const complete = await tempDir();
    await installAgentSkills({ cwd: complete, agent: "claude" });
    const none = await tempDir();
    const empty = await tempDir();
    await mkdir(path.join(empty, ".weave"), { recursive: true });
    await writeFile(path.join(empty, ".weave", "agents.yml"), "version: 1\ninstalled: {}\n");
    for (const cwd of [complete, none, empty]) {
      const notices = await gatherNotices({ cwd, packageVersion: "0.1.0", npmLatest: "0.1.0", env: {} as NodeJS.ProcessEnv });
      expect(notices.filter((notice) => notice.kind === "skills_available")).toEqual([]);
    }

    const partial = await tempDir();
    await installAgentSkills({ cwd: partial, agent: "claude" });
    const manifestPath = path.join(partial, ".weave", "agents.yml");
    const manifest = YAML.parse(await readFile(manifestPath, "utf8")) as { installed: { claude: { skills: Record<string, unknown> } } };
    delete manifest.installed.claude.skills["weave-explore"];
    await writeFile(manifestPath, YAML.stringify(manifest));
    expect(await gatherNotices({ cwd: partial, packageVersion: "0.1.0", env: { WEAVE_NO_NOTICES: "1" } as NodeJS.ProcessEnv })).toEqual([]);
  });

  it("isNewerVersion compares semver-shaped strings predictably", () => {
    expect(isNewerVersion("0.2.0", "0.1.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.1.0", "0.2.0")).toBe(false);
    expect(isNewerVersion("garbage", "0.1.0")).toBe(false);
  });
});
