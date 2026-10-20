#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(moduleDir, "..");
const templatesDir = join(projectRoot, "templates", "skills");
const packageJsonPath = join(projectRoot, "package.json");

async function main() {
  const upcomingVersion = await readUpcomingVersion();
  const previousTag = readPreviousTag();
  const skillNames = await listSkillNames();
  const updated = [];
  const skipped = [];
  const warned = [];

  for (const skill of skillNames) {
    const skillPath = join(templatesDir, skill, "SKILL.md");
    const content = await readFile(skillPath, "utf8");
    const frontmatter = parseFrontmatter(content);
    if (!frontmatter) {
      console.warn(`warn: ${skill}: missing frontmatter; skipping`);
      warned.push(skill);
      continue;
    }

    const changed = previousTag === null || skillChangedSince(previousTag, skillPath);
    if (!changed) {
      skipped.push({ skill, reason: "no diff since tag" });
      continue;
    }

    const currentLastChangedIn = frontmatter.last_changed_in;
    if (currentLastChangedIn === undefined) {
      console.warn(`warn: ${skill}: last_changed_in missing; defaulting to ${upcomingVersion}`);
      warned.push(skill);
    }

    const newContent = applyLastChangedIn(content, upcomingVersion);
    if (newContent === content) {
      skipped.push({ skill, reason: "already at upcoming version" });
      continue;
    }
    await writeFile(skillPath, newContent);
    updated.push(skill);
  }

  console.log(`Upcoming version: ${upcomingVersion}`);
  console.log(`Previous tag: ${previousTag ?? "(none reachable; treating every skill as new)"}`);
  console.log(`Updated (${updated.length}): ${updated.join(", ") || "(none)"}`);
  if (skipped.length > 0) {
    console.log(`Skipped (${skipped.length}):`);
    for (const entry of skipped) console.log(`  - ${entry.skill}: ${entry.reason}`);
  }
  if (warned.length > 0) {
    console.log(`Warnings on (${warned.length}): ${warned.join(", ")}`);
  }
}

async function readUpcomingVersion() {
  const parsed = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (typeof parsed?.version !== "string") {
    throw new Error("package.json is missing a string `version` field");
  }
  return parsed.version;
}

function readPreviousTag() {
  try {
    return execFileSync("git", ["describe", "--tags", "--abbrev=0"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function skillChangedSince(previousTag, skillPath) {
  try {
    const diff = execFileSync(
      "git",
      ["diff", `${previousTag}..HEAD`, "--", skillPath],
      { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return diff.length > 0;
  } catch {
    return true;
  }
}

async function listSkillNames() {
  const entries = await readdir(templatesDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function parseFrontmatter(content) {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split("\n")) {
    const fieldMatch = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line);
    if (fieldMatch) {
      fields[fieldMatch[1]] = fieldMatch[2].trim();
    }
    // `last_changed_in` lives under the Agent Skills `metadata` map.
    const nestedMatch = /^\s+last_changed_in:\s*(.*)$/.exec(line);
    if (nestedMatch) {
      fields.last_changed_in = nestedMatch[1].trim();
    }
  }
  return fields;
}

function applyLastChangedIn(content, version) {
  const frontmatterMatch = /^(---\n)([\s\S]*?)(\n---)/.exec(content);
  if (!frontmatterMatch) return content;
  const block = frontmatterMatch[2];
  const nestedLine = `  last_changed_in: "${version}"`;

  // Drop the legacy top-level field; the version is written under `metadata`.
  let lines = block.split("\n").filter((line) => !/^last_changed_in:\s*/.test(line));
  const nestedIndex = lines.findIndex((line) => /^\s+last_changed_in:\s*/.test(line));
  if (nestedIndex !== -1) {
    lines[nestedIndex] = nestedLine;
  } else {
    const metadataIndex = lines.findIndex((line) => /^metadata:\s*$/.test(line));
    if (metadataIndex !== -1) {
      let insertAt = metadataIndex + 1;
      while (insertAt < lines.length && /^\s+\S/.test(lines[insertAt])) insertAt += 1;
      lines.splice(insertAt, 0, nestedLine);
    } else {
      lines = [...lines, "metadata:", nestedLine];
    }
  }

  const updatedBlock = lines.join("\n");
  return updatedBlock === block ? content : content.replace(block, updatedBlock);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
