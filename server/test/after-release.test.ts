// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The after-release counts of holding back delivery to agent-started runs: held starts, runs it missed, and pairs per interactive
// session, on a real database.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { type Conversation, summarize } from "../evals/delivery/after-release.ts";
import { at, hash, insert, project, run, session, tempDb } from "./temp-db.ts";
import { tempDir } from "./temp-dir.ts";

const SCRIPT = path.join(import.meta.dirname, "..", "evals", "delivery", "after-release.ts");

const row = (over: Partial<Conversation["rows"][number]> = {}): Conversation["rows"][number] => ({
  event: "pre_read",
  outcome: "emitted",
  reason: null,
  units: 1,
  ...over,
});

test("a window counts held starts, missed runs, subagent starts that still carried records, and pairs per interactive session", () => {
  const conversations: Conversation[] = [
    // Two interactive sessions: 3 pairs over 2 sessions
    { recipient: "claude-main", rows: [row({ event: "session_start", reason: "startup", units: 2 })] },
    { recipient: "codex-tui", rows: [row()] },
    // A held claude -p run and a held codex exec run
    { recipient: "claude-main", rows: [row({ event: "session_start", outcome: "suppressed", units: 0 })] },
    { recipient: "codex-exec", rows: [row({ event: "session_start", outcome: "suppressed", units: 0 })] },
    // A codex exec run that still got its start and a read; its dead-end stop and edit do not count as missed
    {
      recipient: "codex-exec",
      rows: [
        row({ event: "session_start", reason: "startup", units: 3 }),
        row(),
        row({ reason: "command" }),
        row({ event: "pre_edit" }),
      ],
    },
    // A log-less run that got nothing but an edit is not missed
    { recipient: "codex-no-log", rows: [row({ event: "pre_edit" })] },
    // A subagent start with only the search line, and one that still carried records
    { recipient: "claude-subagent", rows: [row({ event: "session_start", reason: "subagent", units: 0 })] },
    { recipient: "codex-child", rows: [row({ event: "session_start", units: 2 })] },
  ];
  const s = summarize(conversations);
  assert.equal(s.conversations["claude-main"], 2);
  assert.equal(s.conversations["codex-exec"], 2);
  assert.deepEqual(s.held, { "claude-main": 1, "codex-exec": 1 });
  assert.deepEqual(s.not_held, { conversations: 1, pairs: 4 });
  assert.deepEqual(s.subagent_starts, { total: 2, with_records: 1, pairs: 2 });
  // A held claude -p run is not an interactive session, since it shows that a person does not run it
  assert.deepEqual(s.interactive, { conversations: 2, pairs: 3, per_conversation: 1.5 });
  assert.equal(s.pairs.total, 3 + 3 + 1 + 1 + 1 + 1 + 2);
});

test("a window with no interactive session reports no per-session rate rather than dividing by zero", () => {
  const s = summarize([{ recipient: "codex-exec", rows: [row()] }]);
  assert.deepEqual(s.interactive, { conversations: 0, pairs: 0, per_conversation: null });
});

/** A Codex session log whose first line is the session's meta, named the way Codex names its rollouts */
function codexLog(dir: string, thread: string, originator: string): void {
  const file = path.join(dir, "sessions", "2026", "10", "20", `rollout-2026-10-20T00-00-00-${thread}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ type: "session_meta", payload: { id: thread, originator, thread_source: "user" } })}\n`,
  );
}

test("the script reads each window from the database and the Codex logs, and leaves rows outside every window and other projects out", async () => {
  const db = tempDb();
  const dir = tempDir("sphica-after-");
  try {
    const p = project(db);
    const other = project(db, "git:github.com/o/other", "o/other");
    const u = insert(db, "unit", {
      project_id: p,
      key: "k",
      kind: "decision",
      stance: "do",
      text: "k",
      extraction: "supported",
      run_id: run(db, p),
      created_at: at("2026-10-01T00:00:00Z"),
      content_hash: hash(1),
    });
    const log = (s: string, v: Record<string, unknown>, units: number[] = []) => {
      const id = insert(db, "delivery", { session_id: s, outcome: "emitted", ...v });
      for (const unit of units) insert(db, "delivery_unit", { delivery_id: id, unit_id: unit });
    };
    const codex = path.join(dir, "codex");
    // The helper stores a session's external id as ext-<id>, which a Codex log names
    codexLog(codex, "ext-t-exec", "codex_exec");
    codexLog(codex, "ext-t-tui", "codex-tui");
    const main = session(db, p, "s-main");
    const exec = session(db, p, "t-exec", "codex");
    const tui = session(db, p, "t-tui", "codex");
    const elsewhere = session(db, other, "s-other");
    const before = "2026-10-10T00:00:00Z";
    const after = "2026-10-20T00:00:00Z";
    log(main, { event: "session_start", reason: "startup", at: at(before) }, [u]);
    log(exec, { event: "session_start", reason: "startup", at: at(before) }, [u]);
    log(main, { event: "session_start", reason: "startup", at: at(after) }, [u]);
    log(main, { event: "session_start", reason: "subagent", agent_id: "a1", at: at(after) });
    log(exec, { event: "session_start", reason: "startup", outcome: "suppressed", at: at(after) });
    log(tui, { event: "pre_read", at: at(after) }, [u]);
    // Outside both windows, and another project's row inside one
    log(main, { event: "pre_read", at: at("2026-10-17T00:00:00Z") }, [u]);
    log(elsewhere, { event: "pre_read", at: at(after) }, [u]);
    const out = path.join(dir, "out.json");
    const r = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "--db",
        db.file,
        "--project",
        "git:github.com/o/r",
        "--codex",
        codex,
        "--window",
        "2026-10-09T00:00:00Z/2026-10-16T00:00:00Z",
        "--window",
        "2026-10-19T00:00:00Z/2026-10-26T00:00:00Z",
        "--out",
        out,
      ],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    const file = JSON.parse(fs.readFileSync(out, "utf8"));
    const [b, a] = file.windows;
    assert.deepEqual(b.window, { from: "2026-10-09T00:00:00.000Z", to: "2026-10-16T00:00:00.000Z" });
    assert.deepEqual(b.summary.interactive, { conversations: 1, pairs: 1, per_conversation: 1 });
    assert.deepEqual(b.summary.not_held, { conversations: 1, pairs: 1 });
    assert.deepEqual(a.summary.held, { "codex-exec": 1 });
    assert.deepEqual(a.summary.not_held, { conversations: 0, pairs: 0 });
    assert.deepEqual(a.summary.subagent_starts, { total: 1, with_records: 0, pairs: 0 });
    assert.deepEqual(a.summary.interactive, { conversations: 2, pairs: 2, per_conversation: 1 });
    assert.equal(a.summary.pairs.total, 2);
  } finally {
    await db.done();
  }
});

test("the script refuses a window that does not parse or runs backwards, and an unknown project", async () => {
  const db = tempDb();
  try {
    project(db);
    const dir = tempDir("sphica-after-");
    const args = (window: string, key = "git:github.com/o/r") => [
      SCRIPT,
      "--db",
      db.file,
      "--project",
      key,
      "--codex",
      dir,
      "--window",
      window,
      "--out",
      path.join(dir, "out.json"),
    ];
    const run1 = (a: string[]) => spawnSync(process.execPath, a, { encoding: "utf8" });
    assert.match(run1(args("2026-10-09")).stderr, /from\/to/);
    assert.match(run1(args("2026-10-16T00:00:00Z/2026-10-09T00:00:00Z")).stderr, /before/);
    assert.match(run1(args("2026-10-09T00:00:00Z/2026-10-16T00:00:00Z", "git:x")).stderr, /no project/);
    assert.equal(fs.existsSync(path.join(dir, "out.json")), false);
  } finally {
    await db.done();
  }
});
