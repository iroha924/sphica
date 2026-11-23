// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The import finds the repository's logs in both hosts' homes, reads none of a session the database holds, and sphica init --history
// writes the rest through the capture queue: a second run adds nothing
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import zlib from "node:zlib";
import { readLogs, unrecorded } from "../src/history.ts";
import { sessionId } from "../src/knowledge.ts";
import { fakeGhPath } from "./fake-gh.ts";
import { tempDb } from "./temp-db.ts";
import { tmpEnv } from "./temp-dir.ts";

const CLI = path.join(import.meta.dirname, "..", "src", "cli.ts");
const KEY = "git:github.com/o/here";

/** A home with a repository that has a remote, a Claude Code log of it, a log of another directory, and a Codex rollout compressed with zstd */
function home(): { home: string; repo: string } {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-history-")));
  const repo = path.join(home, "Projects", "here");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/o/here.git"], {
    stdio: "ignore",
  });
  const claude = (dir: string, session: string, cwd: string) => {
    const d = path.join(home, ".claude", "projects", dir);
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
          message: { id: "m1", content: [{ type: "text", text: "Past reply" }] },
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
  return { home, repo };
}

test("the repository's logs are found in both homes, and a session the database holds is not read again", async () => {
  const { home: h, repo } = home();
  const db = tempDb();
  try {
    const target = { key: KEY, match: KEY, root: repo };
    const homes = { claude: path.join(h, ".claude"), codex: path.join(h, ".codex") };
    const { logs, elsewhere, unreadable } = readLogs(target, homes);
    assert.deepEqual(logs.map((l) => `${l.host}:${l.session}`).sort(), ["claude-code:c-1", "codex:x-1"]);
    assert.equal(elsewhere, 1);
    assert.equal(unreadable, 0);
    const project = Number(
      db.owner.prepare("insert into project (key, name) values (?, 'here') returning id").get(KEY)?.id,
    );
    db.owner
      .prepare(
        "insert into session (id, project_id, host, external_id, branch, started_at) values (?, ?, 'codex', 'x-1', null, ?)",
      )
      .run(sessionId(project, "codex", "x-1"), project, "2026-11-01T01:00:00.000Z");
    const { fresh, known } = await unrecorded(db.reader, logs);
    assert.deepEqual(
      fresh.map((l) => l.session),
      ["c-1"],
    );
    assert.equal(known, 1);
  } finally {
    await db.done();
    fs.rmSync(h, { recursive: true, force: true });
  }
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
  try {
    const plain = run("init", "--cwd", repo);
    assert.match(plain, /past sessions in the hosts' logs can be imported with sphica init --history/);
    const first = run("init", "--cwd", repo, "--history");
    assert.match(first, /2 past sessions imported \(4 of 4 messages written\)/, first);
    const db = new DatabaseSync(path.join(h, ".sphica", "sphica.db"), { readOnly: true });
    const count = () =>
      Number(db.prepare("select count(*) n from source where kind = 'session_message'").get()?.n);
    const owners = db
      .prepare(
        "select text from source where kind = 'session_message' and author_kind = 'owner' order by text",
      )
      .all();
    assert.deepEqual(
      owners.map((r) => r.text),
      ["Codex prompt", "Past prompt"],
    );
    assert.equal(count(), 4);
    const second = run("init", "--cwd", repo, "--history");
    assert.match(
      second,
      /0 past sessions imported \(0 of 0 messages written\); 2 already recorded, so not read again/,
      second,
    );
    assert.equal(count(), 4);
    assert.doesNotMatch(second, /can be imported with sphica init --history/);
    db.close();
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
});
