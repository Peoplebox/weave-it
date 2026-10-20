import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { ensureDir, pathExists, writeFileAtomic } from "./files.js";

export type AgentName = "codex" | "cursor" | "claude" | "opencode";
export type AgentSelection = AgentName | "all";
export type ManagedArtifactKind = "skill" | "command" | "resource" | "agent";
export type SkillOperationStatus = "installed" | "unchanged" | "modified" | "updated" | "reset" | "missing";

export interface DefaultSkill {
  name: string;
  description: string;
  lastChangedIn: string;
  sourcePath: string;
  content: string;
  hash: string;
}

export interface DefaultSubagent {
  name: string;
  description: string;
  sourcePath: string;
  content: string;
  hash: string;
}

interface DefaultCommand {
  name: string;
  sourcePath: string;
  content: string;
  hash: string;
}

interface DefaultSkillResource {
  name: string;
  sourcePath: string;
  content: string;
  hash: string;
}

export interface SkillOperationResult {
  agent: AgentName;
  kind: ManagedArtifactKind;
  skill: string;
  path: string;
  status: SkillOperationStatus;
  message: string;
}

export interface SkillOperationSummary {
  status: "ok";
  message: string;
  results: SkillOperationResult[];
}

interface AgentSkillOptions {
  cwd: string;
  agent: AgentSelection;
  templatesDir?: string;
  commandTemplatesDir?: string;
  subagentTemplatesDir?: string;
  now?: Date;
}

interface ResetAgentSkillOptions extends AgentSkillOptions {
  skill?: string;
}

interface DiffAgentSkillOptions extends AgentSkillOptions {
  skill?: string;
}

export interface ManifestEntry {
  path: string;
  source_hash: string;
  installed_hash: string;
  installed_at: string;
  installed_from: string | null;
}

export interface AgentManifestEntries {
  skills?: Record<string, ManifestEntry>;
  commands?: Record<string, ManifestEntry>;
  resources?: Record<string, ManifestEntry>;
  agents?: Record<string, ManifestEntry>;
}

export interface AgentsManifest {
  version: 1;
  installed: Partial<Record<AgentName, AgentManifestEntries>>;
}

interface ConcreteTarget {
  agent: AgentName;
  skillsDir: string;
  commandsDir?: string;
  subagentsDir?: string;
}

interface ManagedArtifact {
  kind: ManagedArtifactKind;
  name: string;
  content: string;
  hash: string;
  lastChangedIn: string | null;
  destination: string;
}

const manifestRelativePath = join(".weave", "agents.yml");

export async function listDefaultSkills(options: { templatesDir?: string } = {}): Promise<DefaultSkill[]> {
  const templatesDir = options.templatesDir ?? (await findDefaultSkillsDir());
  const entries = await readdir(templatesDir, { withFileTypes: true });
  const skills = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readDefaultSkill(entry.name, { templatesDir })),
  );

  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

export async function readDefaultSkill(
  name: string,
  options: { templatesDir?: string } = {},
): Promise<DefaultSkill> {
  validateSkillName(name);

  const templatesDir = options.templatesDir ?? (await findDefaultSkillsDir());
  const sourcePath = join(templatesDir, name, "SKILL.md");
  const content = await readFile(sourcePath, "utf8").catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`Unknown skill: ${name}`);
    }

    throw error;
  });
  const metadata = parseSkillFrontmatter(content, sourcePath);

  if (metadata.name !== name) {
    throw new Error(`Skill frontmatter name mismatch in ${sourcePath}: expected ${name}, got ${metadata.name}`);
  }

  return {
    name: metadata.name,
    description: metadata.description,
    lastChangedIn: metadata.lastChangedIn,
    sourcePath,
    content,
    hash: hashContent(content),
  };
}

export async function installAgentSkills(options: AgentSkillOptions): Promise<SkillOperationSummary> {
  const manifest = await loadAgentsManifest(options.cwd);
  const results: SkillOperationResult[] = [];

  for (const target of resolveAgentTargets(options.cwd, options.agent)) {
    const artifacts = await defaultArtifactsForTarget(target, options);
    for (const artifact of artifacts) {
      results.push(await installArtifact(options.cwd, target.agent, artifact, manifest, options.now ?? new Date()));
    }
  }

  await saveAgentsManifest(options.cwd, manifest);

  return summarize(results);
}

export async function updateAgentSkills(options: AgentSkillOptions): Promise<SkillOperationSummary> {
  const manifest = await loadAgentsManifest(options.cwd);
  const results: SkillOperationResult[] = [];

  for (const target of resolveAgentTargets(options.cwd, options.agent)) {
    const artifacts = await defaultArtifactsForTarget(target, options);
    for (const artifact of artifacts) {
      results.push(await updateArtifact(options.cwd, target.agent, artifact, manifest, options.now ?? new Date()));
    }
  }

  await saveAgentsManifest(options.cwd, manifest);

  return summarize(results);
}

export async function resetAgentSkills(options: ResetAgentSkillOptions): Promise<SkillOperationSummary> {
  const manifest = await loadAgentsManifest(options.cwd);
  const results: SkillOperationResult[] = [];

  for (const target of resolveAgentTargets(options.cwd, options.agent)) {
    const artifacts = await defaultArtifactsForTarget(target, options, options.skill);
    for (const artifact of artifacts) {
      results.push(await resetArtifact(options.cwd, target.agent, artifact, manifest, options.now ?? new Date()));
    }
  }

  await saveAgentsManifest(options.cwd, manifest);

  return summarize(results);
}

export async function diffAgentSkills(options: DiffAgentSkillOptions): Promise<{ status: "ok"; message: string }> {
  const chunks: string[] = [];

  for (const target of resolveAgentTargets(options.cwd, options.agent)) {
    const artifacts = await defaultArtifactsForTarget(target, options, options.skill);
    for (const artifact of artifacts) {
      if (!(await pathExists(artifact.destination))) {
        chunks.push(`Missing ${target.agent}/${artifact.kind}/${artifact.name} at ${relative(options.cwd, artifact.destination)}`);
        continue;
      }

      const installed = await readFile(artifact.destination, "utf8");
      chunks.push(
        formatFullFileDiff(
          relative(options.cwd, artifact.destination),
          `${artifact.kind}:${artifact.name}`,
          installed,
          artifact.content,
        ),
      );
    }
  }

  return {
    status: "ok",
    message: chunks.join("\n"),
  };
}

async function defaultArtifactsForTarget(
  target: ConcreteTarget,
  options: Pick<AgentSkillOptions, "templatesDir" | "commandTemplatesDir" | "subagentTemplatesDir">,
  onlyName?: string,
): Promise<ManagedArtifact[]> {
  const onlySubagent = onlyName ? await maybeReadDefaultSubagent(onlyName, options) : undefined;
  const skills = onlyName
    ? onlySubagent
      ? []
      : [await readDefaultSkill(onlyName, { templatesDir: options.templatesDir })]
    : await listDefaultSkills({ templatesDir: options.templatesDir });
  const artifacts: ManagedArtifact[] = [];

  for (const skill of skills) {
    artifacts.push({
      kind: "skill",
      name: skill.name,
      content: skill.content,
      hash: skill.hash,
      lastChangedIn: skill.lastChangedIn,
      destination: installedSkillPath(target.skillsDir, skill.name),
    });

    const resources = await listDefaultSkillResources(skill);
    for (const resource of resources) {
      artifacts.push({
        kind: "resource",
        name: `${skill.name}/${resource.name}`,
        content: resource.content,
        hash: resource.hash,
        lastChangedIn: skill.lastChangedIn,
        destination: installedSkillResourcePath(target.skillsDir, skill.name, resource.name),
      });
    }
  }

  if (target.agent === "opencode" && target.commandsDir) {
    const commands = onlyName
      ? await maybeReadDefaultOpencodeCommand(onlyName, { commandTemplatesDir: options.commandTemplatesDir })
      : await listDefaultOpencodeCommands({ commandTemplatesDir: options.commandTemplatesDir });

    for (const command of Array.isArray(commands) ? commands : commands ? [commands] : []) {
      artifacts.push({
        kind: "command",
        name: command.name,
        content: command.content,
        hash: command.hash,
        lastChangedIn: null,
        destination: installedOpencodeCommandPath(target.commandsDir, command.name),
      });
    }
  }

  if (target.subagentsDir) {
    const subagents = onlyName
      ? onlySubagent
        ? [onlySubagent]
        : []
      : await listDefaultSubagents({ subagentTemplatesDir: options.subagentTemplatesDir });

    for (const subagent of subagents) {
      artifacts.push({
        kind: "agent",
        name: subagent.name,
        content: subagent.content,
        hash: subagent.hash,
        lastChangedIn: null,
        destination: installedSubagentPath(target.subagentsDir, subagent.name),
      });
    }
  }

  return artifacts;
}

export async function listDefaultSubagents(
  options: { subagentTemplatesDir?: string } = {},
): Promise<DefaultSubagent[]> {
  const subagentTemplatesDir = options.subagentTemplatesDir ?? (await findDefaultSubagentsDir());
  const entries = await readdir(subagentTemplatesDir, { withFileTypes: true }).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  });
  const subagents = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && extname(entry.name) === ".md")
      .map((entry) => readDefaultSubagent(basename(entry.name, ".md"), { subagentTemplatesDir })),
  );

  return subagents.sort((left, right) => left.name.localeCompare(right.name));
}

export async function readDefaultSubagent(
  name: string,
  options: { subagentTemplatesDir?: string } = {},
): Promise<DefaultSubagent> {
  validateSkillName(name);

  const subagentTemplatesDir = options.subagentTemplatesDir ?? (await findDefaultSubagentsDir());
  const sourcePath = join(subagentTemplatesDir, `${name}.md`);
  const content = await readFile(sourcePath, "utf8");
  const metadata = parseSubagentFrontmatter(content, sourcePath);

  if (metadata.name !== name) {
    throw new Error(`Subagent frontmatter name mismatch in ${sourcePath}: expected ${name}, got ${metadata.name}`);
  }

  return {
    name: metadata.name,
    description: metadata.description,
    sourcePath,
    content,
    hash: hashContent(content),
  };
}

async function maybeReadDefaultSubagent(
  name: string,
  options: { subagentTemplatesDir?: string } = {},
): Promise<DefaultSubagent | undefined> {
  return readDefaultSubagent(name, options).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  });
}

async function listDefaultSkillResources(skill: DefaultSkill): Promise<DefaultSkillResource[]> {
  const skillDir = dirname(skill.sourcePath);
  const entries = await readdir(skillDir, { withFileTypes: true });
  const resources = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name !== "SKILL.md")
      .map(async (entry) => {
        validateSkillResourceName(entry.name);
        const sourcePath = join(skillDir, entry.name);
        const content = await readFile(sourcePath, "utf8");
        return {
          name: entry.name,
          sourcePath,
          content,
          hash: hashContent(content),
        };
      }),
  );

  return resources.sort((left, right) => left.name.localeCompare(right.name));
}

async function listDefaultOpencodeCommands(
  options: { commandTemplatesDir?: string } = {},
): Promise<DefaultCommand[]> {
  const commandTemplatesDir = options.commandTemplatesDir ?? (await findDefaultOpencodeCommandsDir());
  const entries = await readdir(commandTemplatesDir, { withFileTypes: true }).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  });
  const commands = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && extname(entry.name) === ".md")
      .map((entry) => readDefaultOpencodeCommand(basename(entry.name, ".md"), { commandTemplatesDir })),
  );

  return commands.sort((left, right) => left.name.localeCompare(right.name));
}

async function readDefaultOpencodeCommand(
  name: string,
  options: { commandTemplatesDir?: string } = {},
): Promise<DefaultCommand> {
  validateSkillName(name);

  const commandTemplatesDir = options.commandTemplatesDir ?? (await findDefaultOpencodeCommandsDir());
  const sourcePath = join(commandTemplatesDir, `${name}.md`);
  const content = await readFile(sourcePath, "utf8");

  return {
    name,
    sourcePath,
    content,
    hash: hashContent(content),
  };
}

async function maybeReadDefaultOpencodeCommand(
  name: string,
  options: { commandTemplatesDir?: string } = {},
): Promise<DefaultCommand | undefined> {
  return readDefaultOpencodeCommand(name, options).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  });
}

async function installArtifact(
  cwd: string,
  agent: AgentName,
  artifact: ManagedArtifact,
  manifest: AgentsManifest,
  now: Date,
): Promise<SkillOperationResult> {
  const relativePath = relative(cwd, artifact.destination);
  await ensureDir(dirname(artifact.destination));

  if (!(await pathExists(artifact.destination))) {
    await writeFile(artifact.destination, artifact.content);
    setManifestEntry(manifest, agent, artifact, relativePath, now);
    return result(agent, artifact, relativePath, "installed", `Installed ${artifact.name} ${artifact.kind} for ${agent}`);
  }

  const currentHash = hashContent(await readFile(artifact.destination, "utf8"));
  const entry = getManifestEntry(manifest, agent, artifact.kind, artifact.name);
  if (currentHash === artifact.hash) {
    setManifestEntry(manifest, agent, artifact, relativePath, now);
    return result(agent, artifact, relativePath, "unchanged", `${artifact.name} ${artifact.kind} already installed for ${agent}`);
  }

  if (entry && currentHash !== entry.installed_hash) {
    return result(agent, artifact, relativePath, "modified", `Skipped modified ${artifact.name} ${artifact.kind} for ${agent}`);
  }

  if (!entry && currentHash !== artifact.hash) {
    return result(agent, artifact, relativePath, "modified", `Skipped existing ${artifact.name} ${artifact.kind} for ${agent}`);
  }

  if (entry && currentHash === entry.installed_hash) {
    await writeFile(artifact.destination, artifact.content);
    setManifestEntry(manifest, agent, artifact, relativePath, now);
    return result(agent, artifact, relativePath, "updated", `Updated ${artifact.name} ${artifact.kind} for ${agent}`);
  }

  setManifestEntry(manifest, agent, artifact, relativePath, now);
  return result(agent, artifact, relativePath, "unchanged", `${artifact.name} ${artifact.kind} already installed for ${agent}`);
}

async function updateArtifact(
  cwd: string,
  agent: AgentName,
  artifact: ManagedArtifact,
  manifest: AgentsManifest,
  now: Date,
): Promise<SkillOperationResult> {
  const relativePath = relative(cwd, artifact.destination);
  const entry = getManifestEntry(manifest, agent, artifact.kind, artifact.name);

  if (!(await pathExists(artifact.destination))) {
    if (!entry && artifact.kind === "resource") {
      await ensureDir(dirname(artifact.destination));
      await writeFile(artifact.destination, artifact.content);
      setManifestEntry(manifest, agent, artifact, relativePath, now);
      return result(agent, artifact, relativePath, "installed", `Installed ${artifact.name} ${artifact.kind} for ${agent}`);
    }

    return result(agent, artifact, relativePath, "missing", `Missing ${artifact.name} ${artifact.kind} for ${agent}`);
  }

  const currentHash = hashContent(await readFile(artifact.destination, "utf8"));
  if (currentHash === artifact.hash) {
    setManifestEntry(manifest, agent, artifact, relativePath, now);
    return result(agent, artifact, relativePath, "unchanged", `${artifact.name} ${artifact.kind} already up to date for ${agent}`);
  }

  if (!entry || currentHash !== entry.installed_hash) {
    return result(agent, artifact, relativePath, "modified", `Skipped modified ${artifact.name} ${artifact.kind} for ${agent}`);
  }

  await writeFile(artifact.destination, artifact.content);
  setManifestEntry(manifest, agent, artifact, relativePath, now);
  return result(agent, artifact, relativePath, "updated", `Updated ${artifact.name} ${artifact.kind} for ${agent}`);
}

async function resetArtifact(
  cwd: string,
  agent: AgentName,
  artifact: ManagedArtifact,
  manifest: AgentsManifest,
  now: Date,
): Promise<SkillOperationResult> {
  const relativePath = relative(cwd, artifact.destination);

  await ensureDir(dirname(artifact.destination));
  await writeFile(artifact.destination, artifact.content);
  setManifestEntry(manifest, agent, artifact, relativePath, now);

  return result(agent, artifact, relativePath, "reset", `Reset ${artifact.name} ${artifact.kind} for ${agent}`);
}

function setManifestEntry(
  manifest: AgentsManifest,
  agent: AgentName,
  artifact: ManagedArtifact,
  relativePath: string,
  now: Date,
): void {
  manifest.installed[agent] ??= {};
  const entries = manifest.installed[agent];
  if (!entries) {
    return;
  }

  const bucket = manifestBucketForKind(artifact.kind);
  entries[bucket] ??= {};
  entries[bucket][artifact.name] = {
    path: relativePath,
    source_hash: artifact.hash,
    installed_hash: artifact.hash,
    installed_at: now.toISOString(),
    installed_from: artifact.lastChangedIn,
  };
}

function getManifestEntry(
  manifest: AgentsManifest,
  agent: AgentName,
  kind: ManagedArtifactKind,
  name: string,
): ManifestEntry | undefined {
  const entries = manifest.installed[agent];
  return entries?.[manifestBucketForKind(kind)]?.[name];
}

function resolveAgentTargets(cwd: string, agent: AgentSelection): ConcreteTarget[] {
  switch (agent) {
    case "codex":
      return [{ agent, skillsDir: join(cwd, ".agents", "skills") }];
    case "cursor":
      return [{ agent, skillsDir: join(cwd, ".agents", "skills") }];
    case "claude":
      return [{ agent, skillsDir: join(cwd, ".claude", "skills"), subagentsDir: join(cwd, ".claude", "agents") }];
    case "opencode":
      return [{ agent, skillsDir: join(cwd, ".agents", "skills"), commandsDir: join(cwd, ".opencode", "commands") }];
    case "all":
      return [
        { agent: "codex", skillsDir: join(cwd, ".agents", "skills") },
        { agent: "cursor", skillsDir: join(cwd, ".agents", "skills") },
        { agent: "claude", skillsDir: join(cwd, ".claude", "skills"), subagentsDir: join(cwd, ".claude", "agents") },
        { agent: "opencode", skillsDir: join(cwd, ".agents", "skills"), commandsDir: join(cwd, ".opencode", "commands") },
      ];
    default:
      throw new Error(`Unsupported agent: ${agent satisfies never}`);
  }
}

function installedSkillPath(skillsDir: string, skillName: string): string {
  return join(skillsDir, skillName, "SKILL.md");
}

function installedSkillResourcePath(skillsDir: string, skillName: string, resourceName: string): string {
  return join(skillsDir, skillName, resourceName);
}

function installedSubagentPath(subagentsDir: string, subagentName: string): string {
  return join(subagentsDir, `${subagentName}.md`);
}

function installedOpencodeCommandPath(commandsDir: string, commandName: string): string {
  return join(commandsDir, `${commandName}.md`);
}

export async function loadAgentsManifest(cwd: string): Promise<AgentsManifest> {
  const manifestPath = join(cwd, manifestRelativePath);

  if (!(await pathExists(manifestPath))) {
    return { version: 1, installed: {} };
  }

  const parsed = YAML.parse(await readFile(manifestPath, "utf8")) as Partial<AgentsManifest> | null;
  const installed = parsed?.installed ?? {};

  for (const agent of Object.keys(installed) as AgentName[]) {
    const buckets = installed[agent];
    if (!buckets) continue;
    for (const bucket of ["skills", "commands", "resources", "agents"] as const) {
      const entries = buckets[bucket];
      if (!entries) continue;
      for (const name of Object.keys(entries)) {
        const entry = entries[name] as Partial<ManifestEntry>;
        entries[name] = {
          path: entry.path ?? "",
          source_hash: entry.source_hash ?? "",
          installed_hash: entry.installed_hash ?? "",
          installed_at: entry.installed_at ?? "",
          installed_from: entry.installed_from ?? null,
        };
      }
    }
  }

  return {
    version: 1,
    installed,
  };
}

async function saveAgentsManifest(cwd: string, manifest: AgentsManifest): Promise<void> {
  const manifestPath = join(cwd, manifestRelativePath);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFileAtomic(manifestPath, YAML.stringify(manifest));
}

function parseSkillFrontmatter(
  content: string,
  sourcePath: string,
): { name: string; description: string; lastChangedIn: string } {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) {
    throw new Error(`Missing frontmatter in ${sourcePath}`);
  }

  const frontmatter = YAML.parse(match[1]) as Partial<{
    name: string;
    description: string;
    metadata: Record<string, unknown>;
    last_changed_in: string | number;
  }>;
  if (!frontmatter.name || !frontmatter.description) {
    throw new Error(`Skill frontmatter in ${sourcePath} must include name and description`);
  }

  // Agent Skills keeps client-specific fields under `metadata`; the top-level
  // `last_changed_in` is the legacy location and is still accepted.
  const lastChangedIn = frontmatter.metadata?.last_changed_in ?? frontmatter.last_changed_in;
  if (lastChangedIn === undefined || lastChangedIn === null || lastChangedIn === "") {
    throw new Error(
      `Skill frontmatter in ${sourcePath} must include metadata.last_changed_in (the weave-it package version of the last skill change)`,
    );
  }

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    lastChangedIn: String(lastChangedIn),
  };
}

function parseSubagentFrontmatter(content: string, sourcePath: string): { name: string; description: string } {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) {
    throw new Error(`Missing frontmatter in ${sourcePath}`);
  }

  const metadata = YAML.parse(match[1]) as Partial<{ name: string; description: string }>;
  if (!metadata.name || !metadata.description) {
    throw new Error(`Subagent frontmatter in ${sourcePath} must include name and description`);
  }

  return { name: metadata.name, description: metadata.description };
}

function formatFullFileDiff(installedPath: string, defaultName: string, installed: string, currentDefault: string): string {
  if (installed === currentDefault) {
    return `No differences for ${installedPath}`;
  }

  const installedLines = splitLines(installed);
  const defaultLines = splitLines(currentDefault);

  return [
    `--- installed:${installedPath}`,
    `+++ default:${defaultName}`,
    ...installedLines.map((line) => `-${line}`),
    ...defaultLines.map((line) => `+${line}`),
  ].join("\n");
}

function splitLines(value: string): string[] {
  return value.endsWith("\n") ? value.slice(0, -1).split("\n") : value.split("\n");
}

function result(
  agent: AgentName,
  artifact: ManagedArtifact,
  path: string,
  status: SkillOperationStatus,
  message: string,
): SkillOperationResult {
  return { agent, kind: artifact.kind, skill: artifact.name, path, status, message };
}

function summarize(results: SkillOperationResult[]): SkillOperationSummary {
  return {
    status: "ok",
    message: results.map((item) => item.message).join("\n"),
    results,
  };
}

function hashContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function findDefaultSkillsDir(): Promise<string> {
  return join(await findTemplatesRoot(), "skills");
}

async function findDefaultSubagentsDir(): Promise<string> {
  return join(await findTemplatesRoot(), "agents");
}

async function findDefaultOpencodeCommandsDir(): Promise<string> {
  return join(await findTemplatesRoot(), "opencode", "commands");
}

async function findTemplatesRoot(): Promise<string> {
  let current = dirname(fileURLToPath(import.meta.url));

  while (true) {
    const candidate = join(current, "templates");
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        throw new Error("Could not locate templates");
      }

      current = parent;
    }
  }
}

function validateSkillName(name: string): void {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`Invalid skill name: ${name}`);
  }
}

function validateSkillResourceName(name: string): void {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*\.(md|ya?ml)$/.test(name)) {
    throw new Error(`Invalid skill resource name: ${name}`);
  }
}

function manifestBucketForKind(kind: ManagedArtifactKind): "skills" | "commands" | "resources" | "agents" {
  switch (kind) {
    case "skill":
      return "skills";
    case "command":
      return "commands";
    case "resource":
      return "resources";
    case "agent":
      return "agents";
    default:
      throw new Error(`Unsupported artifact kind: ${kind satisfies never}`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
