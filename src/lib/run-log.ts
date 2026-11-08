import { open, readFile, stat } from "node:fs/promises";

// Turns one line of a background session's stream-json log into a short, readable line,
// such as `Read src/lib/worktrees.ts` or `Agent weave-locator: find close logic`.
export function formatRunLogLine(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [trimmed];
  }

  switch (event.type) {
    case "system":
      return event.subtype === "init" ? [`Session started${typeof event.model === "string" ? ` (${event.model})` : ""}`] : [];
    case "assistant":
      return contentOf(event).flatMap((part) => {
        if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
          return [`> ${firstLine(part.text, 160)}`];
        }
        if (part.type === "tool_use") {
          return [describeTool(String(part.name), (part.input ?? {}) as Record<string, unknown>)];
        }
        return [];
      });
    case "user":
      return contentOf(event).flatMap((part) =>
        part.type === "tool_result" && part.is_error === true ? [`  ! ${firstLine(resultText(part.content), 160)}`] : [],
      );
    case "result": {
      const seconds = typeof event.duration_ms === "number" ? ` after ${Math.round(event.duration_ms / 1000)}s` : "";
      const lines = [`Finished: ${String(event.subtype ?? "done")}${seconds}${event.is_error === true ? " (error)" : ""}`];
      const denials = Array.isArray(event.permission_denials) ? event.permission_denials.length : 0;
      if (denials > 0) {
        lines.push(`  ! ${denials} tool call${denials === 1 ? " was" : "s were"} blocked because nobody could approve them`);
      }
      return lines;
    }
    default:
      return [];
  }
}

export interface FollowRunLogOptions {
  logPath: string;
  follow: boolean;
  write: (line: string) => void;
  // Polled while following; stop once it returns false.
  stillRunning: () => Promise<boolean>;
  pollMs?: number;
}

export async function printRunLog(options: FollowRunLogOptions): Promise<void> {
  let offset = 0;
  let pending = "";
  const drain = async () => {
    const size = await stat(options.logPath).then((info) => info.size).catch(() => 0);
    if (size <= offset) return;
    const handle = await open(options.logPath, "r");
    try {
      const buffer = Buffer.alloc(size - offset);
      await handle.read(buffer, 0, buffer.length, offset);
      offset = size;
      const lines = (pending + buffer.toString("utf8")).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        for (const formatted of formatRunLogLine(line)) options.write(formatted);
      }
    } finally {
      await handle.close();
    }
  };

  await drain();
  while (options.follow && (await options.stillRunning())) {
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1000));
    await drain();
  }
  await drain();
  for (const formatted of formatRunLogLine(pending)) options.write(formatted);
}

export async function readRunLog(logPath: string): Promise<string[]> {
  const content = await readFile(logPath, "utf8").catch(() => "");
  return content.split("\n").flatMap(formatRunLogLine);
}

function contentOf(event: Record<string, unknown>): Array<Record<string, unknown>> {
  const message = event.message as { content?: unknown } | undefined;
  return Array.isArray(message?.content) ? (message!.content as Array<Record<string, unknown>>) : [];
}

function describeTool(name: string, input: Record<string, unknown>): string {
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return `${name} ${text(input.file_path)}`;
    case "Grep":
    case "Glob":
      return `${name} ${text(input.pattern)}`;
    case "Bash":
      return `Bash ${firstLine(text(input.description) || text(input.command), 140)}`;
    case "Agent":
    case "Task":
      return `Agent ${text(input.subagent_type) || "general"}: ${firstLine(text(input.description), 120)}`;
    case "Skill":
      return `Skill ${text(input.skill) || text(input.name)}`;
    default:
      return name;
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join(" ");
  return "";
}

function firstLine(value: string, max: number): string {
  const line = value.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
