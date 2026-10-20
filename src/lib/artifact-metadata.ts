import YAML from "yaml";

export type ArtifactName = "questions" | "research" | "exploration" | "prd" | "architecture";
export type ArtifactStatus = "draft" | "reviewed" | "approved";
export type ArtifactOwner = "product" | "engineering";

export const artifactNames: ArtifactName[] = ["questions", "research", "exploration", "prd", "architecture"];

export interface ArtifactFrontmatterOptions {
  artifact: ArtifactName;
  now: Date;
  status?: ArtifactStatus;
  owner?: ArtifactOwner;
  source?: string;
}

export function isArtifactName(value: string | undefined): value is ArtifactName {
  return Boolean(value && (artifactNames as string[]).includes(value));
}

export function artifactFileName(artifact: ArtifactName): string {
  return artifact === "exploration" ? "exploration.md" : `${artifact}.md`;
}

export function defaultArtifactOwner(artifact: ArtifactName): ArtifactOwner {
  return artifact === "exploration" || artifact === "prd" ? "product" : "engineering";
}

export function defaultArtifactSource(artifact: ArtifactName): string {
  if (artifact === "questions" || artifact === "exploration") {
    return "discussion";
  }

  if (artifact === "research") {
    return "questions.md";
  }

  return artifact === "prd" ? "exploration.md" : "prd.md";
}

export function artifactFrontmatter(options: ArtifactFrontmatterOptions): string {
  const artifact = options.artifact;
  const timestamp = options.now.toISOString();
  return `---\n${YAML.stringify({
    artifact,
    status: options.status ?? "draft",
    owner: options.owner ?? defaultArtifactOwner(artifact),
    created_at: timestamp,
    updated_at: timestamp,
    reviewed_at: null,
    approved_at: null,
    approved_by: null,
    source: options.source ?? defaultArtifactSource(artifact),
  })}---\n\n`;
}
