// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The import finds the repository's logs in both hosts' homes, reads none of a session the database holds or the queue still holds, and
// sphica init --history writes the rest through the capture queue: a second run adds nothing
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import zlib from "node:zlib";
import { readLogs, unrecorded } from "../src/history.ts";
import { sessionId } from "../src/knowledge.ts";
import { fakeGhPath } from "./fake-gh.ts";
import { tempDb } from "./temp-db.ts";
import { tempDir, tmpEnv } from "./temp-dir.ts";

const CLI = path.join(import.meta.dirname, "..", "src", "cli.ts");
const KEY = "git:github.com/o/here";
const git = (...args: string[]) => execFileSync("git", args, { stdio: "ignore" });

/**
 * A home with a repository that has a remote and a worktree beside it, Claude Code logs of the repository, of the worktree, and of another
 * directory, under the config directory `claudeDir` names, and a Codex rollout compressed with zstd
 */
function home(claudeDir = ".claude"): { home: string; repo: string; worktree: string } {
  const home = fs.realpathSync(tempDir("sphica-history-"));
  const repo = path.join(home, "Projects", "here");
  const worktree = path.join(home, "Projects", "here-wt");
  fs.mkdirSync(repo, { recursive: true });
  git("init", "-q", repo);
  git("-C", repo, "remote", "add", "origin", "https://github.com/o/here.git");
  git(
    "-C",
    repo,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
  git("-C", repo, "worktree", "add", "-q", worktree);
  const claude = (dir: string, session: string, cwd: string) => {
    const d = path.join(home, claudeDir, "projects", dir);
    fs.mkdirSync(path.join(d, session, "subagents"), { recursive: true });
    const row = (r: object) =>
      JSON.stringify({ sessionId: session, cwd, gitBranch: "main", entrypoint: "cli", ...r });
    fs.writeFileSync(
      path.join(d, `${session}.jsonl`),
      [
        row({
          type: "user",
          promptId: "p1",
          origin: { kind: "human" },
          timestamp: "2026-11-01T00:00:00.000Z",
          message: { content: "Past prompt" },
        }),
        row({
          type: "assistant",
          timestamp: "2026-11-01T00:00:01.000Z",
          message: {
            id: "m1",
            content: [
              { type: "text", text: "Past reply" },
              {
                type: "tool_use",
                id: "e1",
                name: "Edit",
                input: { file_path: path.join(cwd, "src", "a.ts") },
              },
            ],
          },
        }),
        row({
          type: "user",
          promptId: "p1",
          timestamp: "2026-11-01T00:00:02.000Z",
          message: { content: [{ type: "tool_result", tool_use_id: "e1", content: "ok" }] },
        }),
      ].join("\n"),
    );
    // A subagent's log beside the session is not a session of its own
    fs.writeFileSync(
      path.join(d, session, "subagents", "agent-1.jsonl"),
      row({
        type: "user",
        promptId: "x",
        origin: { kind: "human" },
        timestamp: "2026-11-01T00:00:00.000Z",
        message: { content: "sub" },
      }),
    );
  };
  claude("-here", "c-1", repo);
  claude("-here-wt", "c-3", worktree);
  claude("-elsewhere", "c-2", path.join(home, "elsewhere"));
  const rollout = path.join(home, ".codex", "sessions", "2026", "11", "01");
  fs.mkdirSync(rollout, { recursive: true });
  const codex = [
    {
      type: "session_meta",
      timestamp: "2026-11-01T01:00:00.000Z",
      payload: { id: "x-1", cwd: repo, originator: "codex-tui", source: "vscode", thread_source: "user" },
    },
    {
      type: "event_msg",
      timestamp: "2026-11-01T01:00:01.000Z",
      payload: {
        type: "item_completed",
        turn_id: "t1",
        thread_id: "x-1",
        item: { type: "UserMessage", id: "u1", content: [{ type: "text", text: "Codex prompt" }] },
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-11-01T01:00:02.000Z",
      payload: { type: "task_complete", turn_id: "t1", last_agent_message: "Codex reply" },
    },
  ];
  fs.writeFileSync(
    path.join(rollout, "rollout-2026-11-01T01-00-00-x-1.jsonl.zst"),
    zlib.zstdCompressSync(Buffer.from(codex.map((r) => JSON.stringify(r)).join("\n"))),
  );
  const exec = [
    {
      type: "session_meta",
      timestamp: "2026-11-01T02:00:00.000Z",
      payload: { id: "x-2", cwd: repo, originator: "codex_exec", source: "exec", thread_source: "user" },
    },
  ];
  fs.writeFileSync(
    path.join(rollout, "rollout-2026-11-01T02-00-00-x-2.jsonl.zst"),
    zlib.zstdCompressSync(Buffer.from(JSON.stringify(exec[0]))),
  );
  return { home, repo, worktree };
}

test("logs of the repository and its worktree are found in both homes, with each checkout's own root, and recorded or queued sessions are not read", async () => {
  const { home: h, repo } = home();
  const db = tempDb();
  const sphica = process.env.SPHICA_HOME;
  try {
    const target = { key: KEY, match: KEY, root: repo };
    const homes = { claude: path.join(h, ".claude"), codex: path.join(h, ".codex") };
    const { logs, elsewhere, unreadable } = await readLogs(target, homes);
    assert.deepEqual(logs.map((l) => `${l.host}:${l.session}:${l.excluded ?? "read"}`).sort(), [
      "claude-code:c-1:read",
      "claude-code:c-3:read",
      "codex:x-1:read",
      "codex:x-2:codex exec run",
    ]);
    assert.equal(elsewhere, 1);
    assert.equal(unreadable, 0);
    const edits = (s: string) =>
      logs.find((l) => l.session === s)?.records.flatMap((r) => (r.kind === "edit" ? [r.path] : []));
    assert.deepEqual(edits("c-1"), ["src/a.ts"]);
    assert.deepEqual(edits("c-3"), ["src/a.ts"], "a worktree's edit is relative to the worktree's root");
    const project = Number(
      db.owner.prepare("insert into project (key, name) values (?, 'here') returning id").get(KEY)?.id,
    );
    db.owner
      .prepare(
        "insert into session (id, project_id, host, external_id, branch, started_at) values (?, ?, 'codex', 'x-1', null, ?)",
      )
      .run(sessionId(project, "codex", "x-1"), project, "2026-11-01T01:00:00.000Z");
    // A session live capture has not sent yet waits in the queue
    process.env.SPHICA_HOME = path.join(h, ".sphica");
    fs.mkdirSync(path.join(h, ".sphica", "spool"), { recursive: true });
    fs.writeFileSync(
      path.join(h, ".sphica", "spool", "1.json"),
      JSON.stringify({ v: 2, kind: "message", session: "c-3", project: KEY }),
    );
    const { fresh, known, running } = await unrecorded(db.reader, logs);
    assert.deepEqual(
      fresh.map((l) => l.session),
      ["c-1"],
    );
    assert.equal(known, 1);
    assert.equal(running, 1);
  } finally {
    if (sphica === undefined) delete process.env.SPHICA_HOME;
    else process.env.SPHICA_HOME = sphica;
    await db.done();
  }
});

test("a deleted Claude Code worktree under the root keeps its own root, and an unreadable or broken rollout is counted, not fatal", async () => {
  const { home: h, repo } = home();
  const gone = path.join(repo, ".claude", "worktrees", "w");
  const d = path.join(h, ".claude", "projects", "-gone");
  fs.mkdirSync(d, { recursive: true });
  const row = (r: object) => JSON.stringify({ sessionId: "c-4", cwd: gone, entrypoint: "cli", ...r });
  fs.writeFileSync(
    path.join(d, "c-4.jsonl"),
    [
      row({
        type: "user",
        promptId: "p1",
        origin: { kind: "human" },
        timestamp: "2026-11-01T00:00:00.000Z",
        message: { content: "In a worktree" },
      }),
      row({
        type: "assistant",
        timestamp: "2026-11-01T00:00:01.000Z",
        message: {
          id: "m1",
          content: [
            {
              type: "tool_use",
              id: "e1",
              name: "Write",
              input: { file_path: path.join(gone, "src", "b.ts") },
            },
          ],
        },
      }),
      row({
        type: "user",
        promptId: "p1",
        timestamp: "2026-11-01T00:00:02.000Z",
        message: { content: [{ type: "tool_result", tool_use_id: "e1", content: "ok" }] },
      }),
    ].join("\n"),
  );
  const rollouts = path.join(h, ".codex", "sessions", "2026", "11", "02");
  fs.mkdirSync(rollouts, { recursive: true });
  fs.writeFileSync(path.join(rollouts, "rollout-broken.jsonl.zst"), "not zstd");
  const locked = path.join(rollouts, "rollout-locked.jsonl.zst");
  fs.writeFileSync(locked, zlib.zstdCompressSync(Buffer.from("{}")));
  fs.chmodSync(locked, 0o000);
  try {
    const { logs, unreadable } = await readLogs(
      { key: KEY, match: KEY, root: repo },
      { claude: path.join(h, ".claude"), codex: path.join(h, ".codex") },
    );
    assert.deepEqual(
      logs.find((l) => l.session === "c-4")?.records.flatMap((r) => (r.kind === "edit" ? [r.path] : [])),
      ["src/b.ts"],
    );
    assert.equal(unreadable, 2);
  } finally {
    fs.chmodSync(locked, 0o600);
  }
});

test("Claude Code logs are read from CLAUDE_CONFIG_DIR when it names another config directory", async () => {
  const { home: h, repo } = home("claude-config");
  const { logs } = await readLogs(
    { key: KEY, match: KEY, root: repo },
    { claude: path.join(h, "claude-config"), codex: path.join(h, ".codex") },
  );
  assert.ok(logs.some((l) => l.session === "c-1"));
  const out = execFileSync(process.execPath, [CLI, "init", "--cwd", repo, "--history"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...tmpEnv(),
      PATH: fakeGhPath(),
      HOME: h,
      USERPROFILE: h,
      CLAUDE_CONFIG_DIR: path.join(h, "claude-config"),
    },
    timeout: 60_000,
  });
  assert.match(out, /3 past sessions imported \(6 of 6 messages written\)/, out);
});

test("sphica init --history writes the sessions through the queue, and a second run adds nothing", () => {
  const { home: h, repo } = home();
  const run = (...args: string[]) =>
    execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...tmpEnv(), PATH: fakeGhPath(), HOME: h, USERPROFILE: h },
      timeout: 60_000,
    });
  const plain = run("init", "--cwd", repo);
  assert.match(plain, /past sessions in the hosts' logs can be imported with sphica init --history/);
  const first = run("init", "--cwd", repo, "--history");
  assert.match(
    first,
    /✓ 3 past sessions imported \(6 of 6 messages written\); 1 left out: codex exec run; 1 log of other directories not read/,
    first,
  );
  const db = new DatabaseSync(path.join(h, ".sphica", "sphica.db"), { readOnly: true });
  try {
    const count = () =>
      Number(db.prepare("select count(*) n from source where kind = 'session_message'").get()?.n);
    const owners = db
      .prepare(
        "select text from source where kind = 'session_message' and author_kind = 'owner' order by text",
      )
      .all();
    assert.deepEqual(
      owners.map((r) => r.text),
      ["Codex prompt", "Past prompt", "Past prompt"],
    );
    assert.equal(count(), 6);
    const second = run("init", "--cwd", repo, "--history");
    assert.match(
      second,
      /0 past sessions imported \(0 of 0 messages written\); 3 already recorded, so not read again/,
      second,
    );
    assert.equal(count(), 6);
    assert.doesNotMatch(second, /can be imported with sphica init --history/);
  } finally {
    db.close();
  }
});
