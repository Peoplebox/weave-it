import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./files.js";
import { withStateLock, writeFileAtomic } from "./local-state.js";

// `.git/weave/attention.json`: the last worked-out count of changes needing attention, for
// `weave status`, which never runs git itself.
export interface AttentionSnapshot {
  version: 1;
  computed_at: string;
  // When the facts behind it were gathered; an older snapshot never replaces a newer one.
  facts_at: string;
  total: number;
  counts: Record<string, number>;
}

export function attentionFile(stateDir: string): string {
  return path.join(stateDir, "attention.json");
}

export async function readAttention(stateDir: string): Promise<AttentionSnapshot | undefined> {
  const file = attentionFile(stateDir);
  if (!(await pathExists(file))) return undefined;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<AttentionSnapshot>;
    if (parsed.version !== 1 || typeof parsed.total !== "number" || !parsed.counts) return undefined;
    return {
      version: 1,
      computed_at: String(parsed.computed_at ?? ""),
      facts_at: String(parsed.facts_at ?? ""),
      total: parsed.total,
      counts: parsed.counts,
    };
  } catch {
    return undefined;
  }
}

// Writes the snapshot unless a newer one is already there. Returns whether it was written.
export async function writeAttention(
  mainRoot: string,
  snapshot: { total: number; counts: Record<string, number>; factsAt: string },
  now: Date = new Date(),
): Promise<boolean> {
  return withStateLock(mainRoot, async (stateDir) => {
    const existing = await readAttention(stateDir);
    if (existing && existing.facts_at && existing.facts_at > snapshot.factsAt) return false;
    const next: AttentionSnapshot = {
      version: 1,
      computed_at: now.toISOString(),
      facts_at: snapshot.factsAt,
      total: snapshot.total,
      counts: snapshot.counts,
    };
    await writeFileAtomic(attentionFile(stateDir), JSON.stringify(next));
    return true;
  });
}
