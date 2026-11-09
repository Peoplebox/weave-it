import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { vi } from "vitest";
import { createProgram } from "../../src/cli.js";

const execFileAsync = promisify(execFile);
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Weave Test",
  GIT_AUTHOR_EMAIL: "weave@example.com",
  GIT_COMMITTER_NAME: "Weave Test",
  GIT_COMMITTER_EMAIL: "weave@example.com",
};

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv });
  return stdout.trim();
}

export interface OpenFixture {
  base: string;
  project: string;
  home: string;
  bin: string;
  tmuxLog: string;
  // Lines the fake `tmux list-panes` prints: session, window id, window name, pane path.
  panes: string;
}

// A repo-mode project with change folders, cloned from a bare origin, plus a fake `tmux`
// on PATH that records its arguments instead of opening anything.
export async function openFixture(): Promise<OpenFixture> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-open-cli-")));
  const origin = path.join(base, "origin.git");
  await mkdir(origin);
  await git(origin, ["init", "--bare", "-b", "main"]);
  const project = path.join(base, "acme");
  await git(base, ["clone", "--quiet", origin, project]);
  await mkdir(path.join(project, ".weave"));
  await writeFile(path.join(project, ".weave", "workspace.yml"), YAML.stringify({ version: 1, mode: "repo", name: "acme", checkout: "worktree", repos: {} }));
  await writeFile(path.join(project, "README.md"), "acme\n");
  await git(project, ["add", "."]);
  await git(project, ["commit", "-m", "init"]);
  await git(project, ["push", "--quiet", "-u", "origin", "main"]);

  const bin = path.join(base, "bin");
  await mkdir(bin);
  const tmuxLog = path.join(base, "tmux.log");
  const panes = path.join(base, "tmux-panes.txt");
  await writeFile(
    path.join(bin, "tmux"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" >> ${JSON.stringify(tmuxLog)}`,
      `printf -- '---\\n' >> ${JSON.stringify(tmuxLog)}`,
      `if [ "$1" = list-panes ] && [ -f ${JSON.stringify(panes)} ]; then cat ${JSON.stringify(panes)}; fi`,
      `if [ "$1" = display-message ]; then echo main; fi`,
      "",
    ].join("\n"),
  );
  await chmod(path.join(bin, "tmux"), 0o755);
  return { base, project, home: path.join(base, "home"), bin, tmuxLog, panes };
}

export async function tmuxCalls(fixture: OpenFixture): Promise<string[][]> {
  try {
    return (await readFile(fixture.tmuxLog, "utf8"))
      .split("---\n")
      .filter(Boolean)
      .map((call) => call.split("\n").filter((line, index, all) => index < all.length - 1 || line !== ""));
  } catch {
    return [];
  }
}

const managedEnv = ["WEAVE_NO_OPEN", "WEAVE_USER_HOME", "WEAVE_SESSION_PATH", "WEAVE_NO_BACKGROUND_REFRESH", "PATH", "TMUX", "HC_TERMINAL_ID", "SSH_CONNECTION", "SSH_TTY", "CLAUDECODE"];

// Runs the CLI in `cwd` with an environment where only the fake tmux can open anything.
export async function runCli(
  fixture: OpenFixture,
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; inTmux?: boolean; noOpen?: boolean } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const saved = Object.fromEntries(managedEnv.map((name) => [name, process.env[name]]));
  const savedCwd = process.cwd();
  const savedExit = process.exitCode;
  for (const name of managedEnv) delete process.env[name];
  Object.assign(process.env, {
    WEAVE_USER_HOME: fixture.home,
    WEAVE_SESSION_PATH: path.join(fixture.base, "session.yml"),
    WEAVE_NO_BACKGROUND_REFRESH: "1",
    PATH: `${fixture.bin}:/usr/bin:/bin`,
    ...(options.inTmux ? { TMUX: "/tmp/fake,1,0" } : {}),
    ...(options.noOpen ? { WEAVE_NO_OPEN: "1" } : {}),
    ...options.env,
  });
  const out: string[] = [];
  const err: string[] = [];
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });
  process.exitCode = 0;
  try {
    process.chdir(cwd);
    const program = createProgram();
    program.exitOverride();
    await program.parseAsync(args, { from: "user" });
    return { stdout: out.join(""), stderr: err.join(""), exitCode: Number(process.exitCode ?? 0) };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
    process.chdir(savedCwd);
    process.exitCode = savedExit;
    for (const name of managedEnv) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

export async function writeSettings(fixture: OpenFixture, settings: unknown): Promise<void> {
  await mkdir(path.join(fixture.home, ".weave"), { recursive: true });
  await writeFile(path.join(fixture.home, ".weave", "settings.yml"), YAML.stringify(settings));
}

export async function readSettings(fixture: OpenFixture): Promise<Record<string, any>> {
  return YAML.parse(await readFile(path.join(fixture.home, ".weave", "settings.yml"), "utf8"));
}
