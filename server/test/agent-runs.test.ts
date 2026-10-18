// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The proxy count of what the agent-run change would drop from the labelled delivery sample, on a real database and real session logs.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { blockOf, check, judge, type Pair, recipientOf, tally } from "../evals/delivery/agent-runs.ts";
import { at, hash, insert, project, run, session, type TempDb, tempDb } from "./temp-db.ts";
import { tempDir } from "./temp-dir.ts";

const SCRIPT = path.join(import.meta.dirname, "..", "evals", "delivery", "agent-runs.ts");

const pair = (over: Partial<Pair>): Pair => ({
  n: 1,
  delivery: 1,
  unit: 1,
  event: "pre_read",
  reason: null,
  recipient: "claude-main",
  settled: "irrelevant",
  ...over,
});

test("a block drops Codex exec and log-less session starts and reads, and subagent starts, never a dead-end stop", () => {
  assert.equal(blockOf(pair({ recipient: "codex-exec", event: "session_start" })), "agent-run");
  assert.equal(blockOf(pair({ recipient: "codex-no-log", event: "pre_read" })), "agent-run");
  assert.equal(blockOf(pair({ recipient: "codex-exec", event: "pre_read", reason: "command" })), null);
  assert.equal(
    blockOf(pair({ recipient: "codex-no-log", event: "pre_read", reason: "command_context" })),
    null,
  );
  assert.equal(blockOf(pair({ recipient: "codex-exec", event: "pre_edit" })), null);
  assert.equal(blockOf(pair({ recipient: "codex-exec", event: "review" })), null);
  assert.equal(blockOf(pair({ recipient: "codex-tui", event: "session_start" })), null);
  assert.equal(blockOf(pair({ recipient: "codex-other", event: "pre_read" })), null);
  assert.equal(blockOf(pair({ recipient: "claude-subagent", event: "session_start" })), "subagent-start");
  assert.equal(blockOf(pair({ recipient: "codex-child", event: "session_start" })), "subagent-start");
  assert.equal(blockOf(pair({ recipient: "claude-subagent", event: "pre_read" })), null);
  assert.equal(blockOf(pair({ recipient: "claude-main", event: "session_start" })), null);
});

test("the bar adopts a block with no known useful pair and 5 irrelevant, and drops one with any useful pair", () => {
  assert.equal(judge({ useful: 0, irrelevant: 5, unknown: 30 }), "adopted");
  assert.equal(judge({ useful: 0, irrelevant: 4, unknown: 0 }), "undecided");
  assert.equal(judge({ useful: 1, irrelevant: 40, unknown: 0 }), "not adopted");
  const pairs = [
    ...Array.from({ length: 5 }, (_, i) =>
      pair({ n: i + 1, recipient: "codex-exec", event: "session_start" }),
    ),
    pair({ n: 6, recipient: "codex-no-log", settled: "unknown" }),
    pair({ n: 7, recipient: "claude-subagent", event: "session_start", settled: "useful" }),
    pair({ n: 8, recipient: "claude-main", settled: "useful" }),
  ];
  assert.deepEqual(tally(pairs), {
    "agent-run": { useful: 0, irrelevant: 5, unknown: 1, verdict: "adopted" },
    "subagent-start": { useful: 1, irrelevant: 0, unknown: 0, verdict: "not adopted" },
  });
});

/** A Codex session log whose first line is the session's meta, named the way Codex names its rollouts */
function codexLog(dir: string, thread: string, originator: string): string {
  const file = path.join(dir, "sessions", "2026", "10", "10", `rollout-2026-10-10T00-00-00-${thread}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ type: "session_meta", payload: { id: thread, originator, thread_source: "user" } })}\n`,
  );
  return file;
}

test("the recipient is read from the delivery row and the first line of the Codex log that ends in its thread", () => {
  const dir = tempDir("sphica-codex-");
  const files = [
    codexLog(dir, "t-exec", "codex_exec"),
    codexLog(dir, "t-tui", "codex-tui"),
    codexLog(dir, "t-app", "Codex Desktop"),
  ];
  const find = (t: string) => files.find((f) => f.endsWith(`-${t}.jsonl`)) ?? null;
  assert.equal(recipientOf({ host: "claude-code", external_id: "s", agent_id: null }, find), "claude-main");
  assert.equal(
    recipientOf({ host: "claude-code", external_id: "s", agent_id: "a1" }, find),
    "claude-subagent",
  );
  assert.equal(recipientOf({ host: "codex", external_id: "t-exec", agent_id: null }, find), "codex-exec");
  assert.equal(recipientOf({ host: "codex", external_id: "t-tui", agent_id: null }, find), "codex-tui");
  assert.equal(recipientOf({ host: "codex", external_id: "t-app", agent_id: null }, find), "codex-other");
  assert.equal(recipientOf({ host: "codex", external_id: "t-gone", agent_id: null }, find), "codex-no-log");
  assert.equal(recipientOf({ host: "codex", external_id: "t-exec", agent_id: "child" }, find), "codex-child");
});

function delivered(db: TempDb, s: string, event: string, reason: string | null, unit: number): number {
  const id = insert(db, "delivery", {
    session_id: s,
    event,
    outcome: "emitted",
    reason,
    at: at("2026-10-12T00:00:00Z"),
  });
  insert(db, "delivery_unit", { delivery_id: id, unit_id: unit });
  return id;
}

test("extracting from a database and logs writes the pairs and counts that --check recounts, and --check fails on a changed count", async () => {
  const db = tempDb();
  const dir = tempDir("sphica-runs-");
  try {
    const p = project(db);
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
    const codex = path.join(dir, "codex");
    // The helper stores a session's external id as ext-<id>, which a Codex log names
    codexLog(codex, "ext-t-exec", "codex_exec");
    const exec = session(db, p, "t-exec", "codex");
    const main = session(db, p, "s-main");
    const rows = [
      delivered(db, exec, "session_start", "startup", u),
      delivered(db, exec, "pre_read", null, u),
      delivered(db, exec, "pre_read", "command", u),
      delivered(db, main, "pre_read", null, u),
    ];
    const baseline = path.join(dir, "baseline.json");
    fs.writeFileSync(
      baseline,
      JSON.stringify({
        sample: rows.map((delivery, i) => ({
          n: i + 1,
          delivery,
          unit: u,
          settled: i === 3 ? "useful" : "irrelevant",
        })),
      }),
    );
    const out = path.join(dir, "out.json");
    const extract = spawnSync(
      process.execPath,
      [SCRIPT, "--db", db.file, "--codex", codex, "--baseline", baseline, "--out", out],
      { encoding: "utf8" },
    );
    assert.equal(extract.status, 0, extract.stderr);
    const file = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.deepEqual(
      file.pairs.map((x: Pair) => [x.recipient, x.event, x.reason]),
      [
        ["codex-exec", "session_start", "startup"],
        ["codex-exec", "pre_read", null],
        ["codex-exec", "pre_read", "command"],
        ["claude-main", "pre_read", null],
      ],
    );
    assert.deepEqual(file.blocks["agent-run"], {
      useful: 0,
      irrelevant: 2,
      unknown: 0,
      verdict: "undecided",
    });
    assert.deepEqual(check(file), []);
    assert.equal(spawnSync(process.execPath, [SCRIPT, "--check", out]).status, 0);
    file.blocks["agent-run"].irrelevant = 3;
    fs.writeFileSync(out, JSON.stringify(file));
    const changed = spawnSync(process.execPath, [SCRIPT, "--check", out], { encoding: "utf8" });
    assert.equal(changed.status, 1);
    assert.match(changed.stderr, /^agent-run: the pairs give/);
  } finally {
    await db.done();
  }
});

test("extracting stops when a sampled delivery is no longer in the database", async () => {
  const db = tempDb();
  const dir = tempDir("sphica-runs-");
  try {
    const baseline = path.join(dir, "baseline.json");
    fs.writeFileSync(
      baseline,
      JSON.stringify({ sample: [{ n: 1, delivery: 42, unit: 1, settled: "useful" }] }),
    );
    const r = spawnSync(
      process.execPath,
      [SCRIPT, "--db", db.file, "--codex", dir, "--baseline", baseline, "--out", path.join(dir, "out.json")],
      { encoding: "utf8" },
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /delivery 42 \(pair 1\) is no longer in/);
  } finally {
    await db.done();
  }
});
