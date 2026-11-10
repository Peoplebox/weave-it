import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  guidelineRepos,
  guidelinesFileName,
  repoGuidelinesTemplate,
  resolveGuidelines,
  starterGuidelines,
  writeGuidelinesIfMissing,
} from "../src/lib/review/guidelines.js";

async function tempRoot(): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), "weave-review-guidelines-")));
}

async function writeGuidelines(root: string, relativeDir: string, text: string): Promise<void> {
  await mkdir(path.join(root, relativeDir, ".weave"), { recursive: true });
  await writeFile(path.join(root, relativeDir, ".weave", "coding-guidelines.md"), text);
}

describe("resolveGuidelines", () => {
  it("returns exactly one shared entry in repo mode, even when repos are passed", async () => {
    const root = await tempRoot();
    await writeGuidelines(root, ".", "# Rules\n");

    const resolution = await resolveGuidelines({ checkoutRoot: root, mode: "repo", repos: [{ id: "root", path: "." }, { id: "api", path: "api" }] });

    expect(resolution).toEqual({
      files: [{ scope: "shared", path: ".weave/coding-guidelines.md", status: "present" }],
      missingRepos: [],
    });
  });

  it("lists the shared file plus a present and an absent repo file in workspace mode", async () => {
    const root = await tempRoot();
    await writeGuidelines(root, ".", "# Shared\n");
    await writeGuidelines(root, "api", "# Api\n");
    await mkdir(path.join(root, "web"), { recursive: true });

    const resolution = await resolveGuidelines({
      checkoutRoot: root,
      mode: "workspace",
      repos: [{ id: "api", path: "api" }, { id: "web", path: "./web/" }],
    });

    expect(resolution).toEqual({
      files: [
        { scope: "shared", path: ".weave/coding-guidelines.md", status: "present" },
        { scope: "repo", repo: "api", path: "api/.weave/coding-guidelines.md", status: "present" },
        { scope: "repo", repo: "web", path: "web/.weave/coding-guidelines.md", status: "absent" },
      ],
      missingRepos: [],
    });
  });

  it("marks a missing shared file absent and still resolves", async () => {
    const root = await tempRoot();
    await writeGuidelines(root, "api", "# Api\n");

    const resolution = await resolveGuidelines({ checkoutRoot: root, mode: "workspace", repos: [{ id: "api", path: "api" }] });

    expect(resolution.files[0]).toEqual({ scope: "shared", path: ".weave/coding-guidelines.md", status: "absent" });
    expect(resolution.files[1]).toMatchObject({ repo: "api", status: "present" });
  });

  it("reports repos without a local checkout, or without a registered path, as missing", async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, "api"), { recursive: true });

    const resolution = await resolveGuidelines({
      checkoutRoot: root,
      mode: "workspace",
      repos: [{ id: "api", path: "api" }, { id: "billing", path: "billing" }, { id: "ghost" }],
    });

    expect(resolution.missingRepos).toEqual(["billing", "ghost"]);
    expect(resolution.files.map((file) => file.repo ?? file.scope)).toEqual(["shared", "api"]);
  });

  it("lists a repo at the workspace root once, as the shared file", async () => {
    const root = await tempRoot();

    const resolution = await resolveGuidelines({ checkoutRoot: root, mode: "workspace", repos: [{ id: "root", path: "." }, { id: "root", path: "." }] });

    expect(resolution).toEqual({ files: [{ scope: "shared", path: ".weave/coding-guidelines.md", status: "absent" }], missingRepos: [] });
  });

  it("maps repo ids to registered paths, with root as the workspace root", () => {
    const metadata = { repos: { api: { path: "services/api", kind: "app" }, web: { path: "web", kind: "app" } } };

    expect(guidelineRepos(metadata, ["root", "api", "nope"])).toEqual([{ id: "root", path: "." }, { id: "api", path: "services/api" }, { id: "nope" }]);
    expect(guidelineRepos(metadata)).toEqual([{ id: "api", path: "services/api" }, { id: "web", path: "web" }]);
  });
});

describe("writeGuidelinesIfMissing", () => {
  it("writes the starter shared file once and never overwrites an edited file", async () => {
    const root = await tempRoot();
    const target = { path: path.join(root, guidelinesFileName), scope: "shared" as const };

    await expect(writeGuidelinesIfMissing(target)).resolves.toBe("created");
    await expect(readFile(target.path, "utf8")).resolves.toBe(starterGuidelines());

    await writeFile(target.path, "# Our rules\n");
    await expect(writeGuidelinesIfMissing(target)).resolves.toBe("unchanged");
    await expect(readFile(target.path, "utf8")).resolves.toBe("# Our rules\n");
  });

  it("writes a heading-only repo file, creating the .weave folder", async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, "api"));
    const target = { path: path.join(root, "api", guidelinesFileName), scope: "repo" as const, repo: "api" };

    await expect(writeGuidelinesIfMissing(target)).resolves.toBe("created");
    await expect(readFile(target.path, "utf8")).resolves.toBe(repoGuidelinesTemplate("api"));
    expect(repoGuidelinesTemplate("api").trim().split("\n")).toHaveLength(1);
  });
});

describe("starterGuidelines", () => {
  it("has team-owned sections and says repo files win on conflict", () => {
    const text = starterGuidelines();
    for (const heading of ["## Error handling", "## Security", "## Testing expectations", "## Naming and structure", "## Documentation"]) {
      expect(text).toContain(heading);
    }
    expect(text).toContain("repository's file wins");
    expect(text).toContain("never overwrites it");
  });
});
