import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { joinOrRunRefresh, planBackgroundRefresh, readRefresh, runRefresh, type RefreshRecord } from "../src/lib/change-refresh.js";
import { createChange, listChanges } from "../src/lib/changes.js";
import { pathExists } from "../src/lib/files.js";
import { noPromptEnv } from "../src/lib/git.js";

// Lets a test make the refresh's review prune throw; otherwise the real prune runs.
const pruneControl = vi.hoisted(() => ({ fail: false, calls: 0 }));
vi.mock("../src/lib/review/prune.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/review/prune.js")>();
  return {
    ...actual,
    pruneReviews: async (...args: Parameters<typeof actual.pruneReviews>) => {
      pruneControl.calls += 1;
      if (pruneControl.fail) throw new Error("prune exploded");
      return actual.pruneReviews(...args);
    },
  };
});

const execFileAsync = promisify(execFile);
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Weave Test",
  GIT_AUTHOR_EMAIL: "weave@example.com",
  GIT_COMMITTER_NAME: "Weave Test",
  GIT_COMMITTER_EMAIL: "weave@example.com",
};

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv });
  return stdout.trim();
}

interface Fixture {
  base: string;
  repo: string;
  origin: string;
  session: string;
  stateDir: string;
}

async function fixture(): Promise<Fixture> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "weave-refresh-")));
  const origin = path.join(base, "app.git");
  await mkdir(origin);
  await git(origin, ["init", "-q", "--bare", "-b", "main"]);
  const repo = path.join(base, "app");
  await git(base, ["clone", "--quiet", origin, repo]);
  await mkdir(path.join(repo, ".weave"));
  await writeFile(path.join(repo, ".weave", "workspace.yml"), YAML.stringify({ version: 1, mode: "repo", name: "app", checkout: "worktree", repos: {} }));
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "weave"]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);
  await git(repo, ["remote", "set-head", "origin", "main"]);
  return { base, repo, origin, session: path.join(base, "session.yml"), stateDir: path.join(repo, ".git", "weave") };
}

// A second clone that lands work on origin without the first clone's `origin/*` moving.
async function teammate(f: Fixture): Promise<string> {
  const clone = path.join(f.base, "teammate");
  if (!(await pathExists(clone))) await git(f.base, ["clone", "--quiet", f.origin, clone]);
  await git(clone, ["fetch", "-q", "origin"]);
  return clone;
}

async function landedChange(f: Fixture): Promise<{ id: string; branch: string; folder: string }> {
  const created = await createChange({ cwd: f.repo, title: "Login", randomId: () => "a1b2", sessionPath: f.session });
  for (const name of ["one.txt", "two.txt"]) {
    await writeFile(path.join(created.folder!, name), `${name}\n`);
    await git(created.folder!, ["add", "."]);
    await git(created.folder!, ["commit", "-q", "-m", name]);
  }
  await git(created.folder!, ["push", "-q", "-u", "origin", created.branch]);
  // The teammate squash-merges on origin.
  const clone = await teammate(f);
  await git(clone, ["checkout", "-q", "main"]);
  await git(clone, ["pull", "-q", "origin", "main"]);
  await git(clone, ["fetch", "-q", "origin", created.branch]);
  await git(clone, ["merge", "-q", "--squash", `origin/${created.branch}`]);
  await git(clone, ["commit", "-q", "-m", "squash login"]);
  await git(clone, ["push", "-q", "origin", "main"]);
  return { id: created.id, branch: created.branch, folder: created.folder! };
}

async function listWith(f: Fixture, record?: RefreshRecord, refreshing = false) {
  return listChanges({ cwd: f.repo, sessionPath: f.session, refresh: { record: record ?? (await readRefresh(f.stateDir)), refreshing } });
}

beforeEach(() => {
  process.env.WEAVE_NO_BACKGROUND_REFRESH = "1";
  pruneControl.fail = false;
  pruneControl.calls = 0;
});

afterEach(() => {
  delete process.env.WEAVE_NO_BACKGROUND_REFRESH;
});

describe("background refresh", () => {
  it("shows a merge on origin after a refresh, without touching the user's refs", async () => {
    const f = await fixture();
    const change = await landedChange(f);
    await git(f.repo, ["config", "fetch.pruneTags", "true"]);
    const clone = await teammate(f);
    await git(clone, ["tag", "v1"]);
    await git(clone, ["push", "-q", "origin", "v1"]);
    const userRefs = await git(f.repo, ["for-each-ref", "refs/remotes", "refs/tags"]);
    const fetchHead = await readFile(path.join(f.repo, ".git", "FETCH_HEAD"), "utf8").catch(() => "");

    const before = await listWith(f);
    expect(before.targets[0]!.changes.find((item) => item.id === change.id)?.state?.id).toBe("in_progress");

    const run = await runRefresh(f.repo);
    expect(run.outcome).toBe("claimed");
    expect(run.record.repos.root).toMatchObject({ result: "ok", seen: [change.branch] });

    const after = await listWith(f);
    const listed = after.targets[0]!.changes.find((item) => item.id === change.id)!;
    expect(listed.state).toMatchObject({ id: "landed", label: "landed in main (squashed)" });
    expect(listed.repos?.[0]?.target?.ref).toBe("refs/weave/remotes/origin/main");
    expect(listed.labels?.map((label) => label.id)).toContain("local_view_older");
    expect(after.message).toContain("on origin; run git fetch to see it locally");
    expect(after.targets[0]!.freshness).toMatchObject({ refreshing: false, as_of: run.record.repos.root!.last_success_at });
    expect(after.message).toContain("as of last fetch, just now");

    expect(await git(f.repo, ["for-each-ref", "refs/remotes", "refs/tags"])).toBe(userRefs);
    expect(await readFile(path.join(f.repo, ".git", "FETCH_HEAD"), "utf8").catch(() => "")).toBe(fetchHead);
  });

  it("fetches only the change branches this machine knows about", async () => {
    const f = await fixture();
    const clone = await teammate(f);
    await git(clone, ["push", "-q", "origin", "main:change/261101-tttt-teammates"]);
    await createChange({ cwd: f.repo, title: "Mine", randomId: () => "m1n3", sessionPath: f.session });

    await runRefresh(f.repo);

    const refs = await git(f.repo, ["for-each-ref", "--format=%(refname)", "refs/weave/"]);
    expect(refs).toContain("refs/weave/remotes/origin/main");
    expect(refs).not.toContain("teammates");
  });

  it("drops Weave's copy of a branch deleted on origin and says it may have landed", async () => {
    const f = await fixture();
    const created = await createChange({ cwd: f.repo, title: "Login", randomId: () => "a1b2", sessionPath: f.session });
    await writeFile(path.join(created.folder!, "one.txt"), "one\n");
    await git(created.folder!, ["add", "."]);
    await git(created.folder!, ["commit", "-q", "-m", "one"]);
    await git(created.folder!, ["push", "-q", "origin", created.branch]);
    await runRefresh(f.repo);
    expect(await git(f.repo, ["for-each-ref", "--format=%(refname)", `refs/weave/remotes/origin/${created.branch}`])).not.toBe("");

    // Merged on the host with an edit that hides it from merge-tree, then deleted.
    await git(f.origin, ["branch", "-D", created.branch]);
    await runRefresh(f.repo);

    expect(await git(f.repo, ["for-each-ref", "--format=%(refname)", `refs/weave/remotes/origin/${created.branch}`])).toBe("");
    const listed = (await listWith(f)).targets[0]!.changes.find((item) => item.id === created.id)!;
    expect(listed.labels).toEqual(expect.arrayContaining([{ id: "may_have_landed", text: "branch deleted on origin; it may have landed" }]));
  });

  it("records a login failure without prompting, even with a blocking askpass", async () => {
    const f = await fixture();
    const askpass = path.join(f.base, "askpass.sh");
    await writeFile(askpass, "#!/bin/sh\nsleep 30\necho secret\n");
    await chmod(askpass, 0o755);
    await git(f.repo, ["config", "protocol.ext.allow", "always"]);
    await git(f.repo, ["remote", "set-url", "origin", 'ext::sh -c echo% "fatal:% Authentication% failed"% >&2;% exit% 128']);

    const started = Date.now();
    const env = await noPromptEnv(f.repo, { ...process.env, GIT_ASKPASS: askpass, SSH_ASKPASS: askpass });
    expect(env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "false", SSH_ASKPASS: "false", SSH_ASKPASS_REQUIRE: "never", GCM_INTERACTIVE: "never" });
    const run = await runRefresh(f.repo, { env });

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(run.record.repos.root).toMatchObject({ result: "auth" });
    expect((await listWith(f)).message).toContain("couldn't refresh: origin needs a login");
  });

  it("gives up a hanging fetch at the time limit and doesn't block the next one", async () => {
    const f = await fixture();
    await git(f.repo, ["config", "protocol.ext.allow", "always"]);
    await git(f.repo, ["remote", "set-url", "origin", "ext::sh -c sleep% 20"]);

    const started = Date.now();
    const run = await runRefresh(f.repo, { timeoutPerRepoMs: 1_000 });
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(run.record.repos.root).toMatchObject({ result: "timeout" });
    expect(run.record.running).toBeNull();
    expect((await listWith(f)).message).toContain("(last refresh timed out)");

    expect((await runRefresh(f.repo, { timeoutPerRepoMs: 1_000 })).outcome).toBe("claimed");
  }, 30_000);

  it("starts at most one background refresh a minute", async () => {
    const f = await fixture();
    delete process.env.WEAVE_NO_BACKGROUND_REFRESH;
    expect(await planBackgroundRefresh(f.repo)).toEqual({ refreshing: true, spawn: true });

    await runRefresh(f.repo, { throttle: true });
    expect((await runRefresh(f.repo, { throttle: true })).outcome).toBe("throttled");
    expect(await planBackgroundRefresh(f.repo)).toEqual({ refreshing: false, spawn: false });
    expect(await planBackgroundRefresh(f.repo, new Date(Date.now() + 61_000))).toEqual({ refreshing: true, spawn: true });

    process.env.WEAVE_NO_BACKGROUND_REFRESH = "1";
    expect(await planBackgroundRefresh(f.repo, new Date(Date.now() + 61_000))).toEqual({ refreshing: false, spawn: false });
  });

  it("takes over a run whose process died", async () => {
    const f = await fixture();
    await mkdir(f.stateDir, { recursive: true });
    const dead: RefreshRecord = { version: 1, running: { pid: 999_999, started_at: new Date().toISOString(), repos: 1 }, last_started_at: null, repos: {} };
    await writeFile(path.join(f.stateDir, "refresh.json"), JSON.stringify(dead));

    expect((await runRefresh(f.repo)).outcome).toBe("claimed");
  });

  it("joins a running refresh for --fetch instead of starting another", async () => {
    const f = await fixture();
    await mkdir(f.stateDir, { recursive: true });
    const startedAt = new Date().toISOString();
    const running: RefreshRecord = { version: 1, running: { pid: process.pid, started_at: startedAt, repos: 1 }, last_started_at: startedAt, repos: {} };
    await writeFile(path.join(f.stateDir, "refresh.json"), JSON.stringify(running));
    setTimeout(() => {
      void writeFile(path.join(f.stateDir, "refresh.json"), JSON.stringify({ ...running, running: null }));
    }, 300);

    expect(await joinOrRunRefresh(f.repo, { pollMs: 50 })).toBe(true);
    expect((await readRefresh(f.stateDir)).last_started_at).toBe(startedAt);
  });

  it("answers offline from the last fetch and says it couldn't refresh", async () => {
    const f = await fixture();
    await runRefresh(f.repo);
    const lastSuccess = (await readRefresh(f.stateDir)).repos.root!.last_success_at;
    await git(f.repo, ["remote", "set-url", "origin", path.join(f.base, "gone.git")]);

    const run = await runRefresh(f.repo);
    expect(run.record.repos.root).toMatchObject({ result: "unreachable", last_success_at: lastSuccess });
    const listed = await listWith(f);
    expect(listed.message).toContain("as of last fetch, just now (couldn't reach origin)");
    expect(listed.targets[0]!.freshness?.as_of).toBe(lastSuccess);
  });

  it("says a refresh is running and sets refreshing in JSON", async () => {
    const f = await fixture();
    await runRefresh(f.repo);
    const listed = await listWith(f, undefined, true);

    expect(listed.targets[0]!.freshness?.refreshing).toBe(true);
    expect(listed.message).toContain("refreshing now, run again in a few seconds for the latest");
  });

  it("shows no age after a fresh --fetch", async () => {
    const f = await fixture();
    await runRefresh(f.repo);
    const listed = await listChanges({ cwd: f.repo, sessionPath: f.session, refresh: { record: await readRefresh(f.stateDir), refreshing: false, finished: true } });

    expect(listed.message).not.toContain("as of last fetch");
    expect(listed.targets[0]!.freshness).toMatchObject({ refresh_finished: true });
  });

  it("writes the attention snapshot for weave status after a refresh", async () => {
    const f = await fixture();
    await landedChange(f);
    await runRefresh(f.repo);

    const snapshot = JSON.parse(await readFile(path.join(f.stateDir, "attention.json"), "utf8"));
    expect(snapshot).toMatchObject({ total: 1, counts: { landed: 1 } });
  });

  it("prunes a landed change's review refs after its landed check, keeping open changes' refs", async () => {
    const f = await fixture();
    const landed = await landedChange(f);
    const open = await createChange({ cwd: f.repo, title: "Open", randomId: () => "o1o1", sessionPath: f.session });
    for (const id of [landed.id, open.id]) {
      await git(f.repo, ["update-ref", `refs/weave/reviews/${id}/01-slice/start`, "HEAD"]);
    }

    await runRefresh(f.repo);

    expect(pruneControl.calls).toBe(1);
    expect(await git(f.repo, ["for-each-ref", "--format=%(refname)", "refs/weave/reviews/"])).toBe(`refs/weave/reviews/${open.id}/01-slice/start`);
    expect(await git(f.repo, ["for-each-ref", "--format=%(refname)", "refs/weave/remotes/origin/main"])).toBe("refs/weave/remotes/origin/main");
  });

  it("finishes the refresh and writes the attention snapshot when prune throws", async () => {
    const f = await fixture();
    const landed = await landedChange(f);
    await git(f.repo, ["update-ref", `refs/weave/reviews/${landed.id}/01-slice/start`, "HEAD"]);
    pruneControl.fail = true;

    const run = await runRefresh(f.repo);

    expect(pruneControl.calls).toBe(1);
    expect(run.outcome).toBe("claimed");
    expect(run.record.running).toBeNull();
    expect(run.record.repos.root).toMatchObject({ result: "ok", seen: [landed.branch] });
    expect(await readRefresh(f.stateDir)).toEqual(run.record);
    const snapshot = JSON.parse(await readFile(path.join(f.stateDir, "attention.json"), "utf8"));
    expect(snapshot).toMatchObject({ total: 1, counts: { landed: 1 } });
    expect(await git(f.repo, ["for-each-ref", "--format=%(refname)", "refs/weave/reviews/"])).toBe(`refs/weave/reviews/${landed.id}/01-slice/start`);
  });
});
