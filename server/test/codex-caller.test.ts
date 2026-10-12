// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Codex's record tool calls as Codex 0.162.1 was measured to send them, through the record server as a host calls it: which calls may
// adopt the AI's own decision, and which may trace on their own.

import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { recordWorld } from "./record-world.ts";
import { at, hash, insert, message, session } from "./temp-db.ts";

type World = Awaited<ReturnType<typeof recordWorld>>;

/** The owner's own thread, a turn a person started in the terminal */
const own = (sessionId: string, turn: string, over: Record<string, unknown> = {}) => ({
  "x-codex-turn-metadata": {
    session_id: `ext-${sessionId}`,
    thread_id: `ext-${sessionId}`,
    turn_id: turn,
    turn_trigger: "user",
    thread_source: "user",
    ...over,
  },
});
/** A thread spawned in that session: the parent's session id and trigger, its own thread id and turn */
const child = (sessionId: string) =>
  own(sessionId, "child-turn", {
    thread_id: "child-thread",
    thread_source: "subagent",
    parent_thread_id: `ext-${sessionId}`,
    subagent_kind: "thread_spawn",
  });

/** A captured Codex session with the owner's request and one reply of the AI deciding something, in turn t1 */
const decided = (w: World, sessionId: string, text: string) => {
  session(w.db, w.p, sessionId, "codex");
  message(w.db, w.p, { id: `${sessionId}-o1`, text: "Tidy the export.", session: sessionId });
  const now = at("2026-09-10T00:01:00Z");
  return insert(w.db, "source", {
    project_id: w.p,
    kind: "session_message",
    artifact: `session:${sessionId}`,
    external_id: `${sessionId}-t1:assistant`,
    revision: 1,
    session_id: sessionId,
    turn_id: "t1",
    author_kind: "assistant",
    created_at: now,
    captured_at: now,
    text,
    original_bytes: Buffer.byteLength(text),
    content_hash: hash(text.length),
    indexed: 0,
  });
};
const aiDecision = (key: string, source: number, quote: string) => ({
  units: [
    {
      key,
      kind: "decision",
      stance: "dont",
      text: quote,
      evidence: [{ source: `s${source}`, quote, role: "decides" }],
      adoption: [{ source: `s${source}`, quote }],
    },
  ],
});
const QUOTE = "I keep the export as one function.";
const lifeOf = (w: World, sessionId: string, key: string) =>
  w.db.owner.prepare("select lifecycle from unit where key = ?").get(`trace:ext-${sessionId}/${key}`)
    ?.lifecycle;
const calls = (w: World) =>
  w.db.owner
    .prepare("select tool, host, caller_session, caller_turn, mode, mode_raw from record_call order by id")
    .all()
    .map((r) => ({ ...r }));
const runOf = (text: string) => /^run: (\S+)/.exec(text)?.[1] ?? "";
/** Traces a session with the given caller on each call and saves the AI's decision from its reply */
const traced = async (
  w: World,
  sessionId: string,
  by: { begin: Record<string, unknown>; save: Record<string, unknown> },
) => {
  const source = decided(w, sessionId, QUOTE);
  const run = runOf((await w.reply("trace_begin", { session: sessionId }, by.begin)).text);
  assert.ok(run, "the trace began");
  return w.reply("record_save", { run, record: aiDecision("one-function", source, QUOTE) }, by.save);
};

test("Codex: a trace begun and saved from the owner's own thread adopts the AI's decision from another turn, and each call is logged once", async () => {
  const w = await recordWorld("codex-own");
  try {
    const saved = await traced(w, "s1", { begin: own("s1", "t9"), save: own("s1", "t9") });
    assert.ok(!saved.isError, saved.text);
    assert.equal(lifeOf(w, "s1", "one-function"), "active");
    assert.equal(w.db.owner.prepare("select route from unit_adoption").get()?.route, "agent");
    assert.deepEqual(calls(w), [
      {
        tool: "trace_begin",
        host: "codex",
        caller_session: "ext-s1",
        caller_turn: "t9",
        mode: "interactive",
        mode_raw: "user",
      },
      {
        tool: "record_save",
        host: "codex",
        caller_session: "ext-s1",
        caller_turn: "t9",
        mode: "interactive",
        mode_raw: "user",
      },
    ]);
  } finally {
    await w.done();
  }
});

test("Codex: the reply of the turn that ran the trace is never adopted", async () => {
  const w = await recordWorld("codex-own-turn");
  try {
    // The trace runs in t1, the turn whose reply it quotes
    const saved = await traced(w, "s1", { begin: own("s1", "t1"), save: own("s1", "t1") });
    assert.match(saved.text, /comes from a turn that ran a record tool/);
    assert.equal(lifeOf(w, "s1", "one-function"), "candidate");
    assert.equal(w.db.owner.prepare("select count(*) as n from unit_adoption").get()?.n, 0);
  } finally {
    await w.done();
  }
});

test("Codex: a child thread, codex exec, a recovered turn, or another session on either call keeps the decision a candidate", async () => {
  const w = await recordWorld("codex-not-own");
  try {
    const cases: [string, { begin: Record<string, unknown>; save: Record<string, unknown> }][] = [
      [
        "exec-begin",
        { begin: own("exec-begin", "t9", { turn_trigger: "exec" }), save: own("exec-begin", "t9") },
      ],
      [
        "exec-save",
        { begin: own("exec-save", "t9"), save: own("exec-save", "t9", { turn_trigger: "exec" }) },
      ],
      [
        "recovered",
        { begin: own("recovered", "t9"), save: own("recovered", "t9", { turn_trigger: "daemon_recovery" }) },
      ],
      [
        "no-source",
        { begin: own("no-source", "t9", { thread_source: undefined }), save: own("no-source", "t9") },
      ],
      [
        "no-thread",
        { begin: own("no-thread", "t9"), save: own("no-thread", "t9", { thread_id: undefined }) },
      ],
      ["child-begin", { begin: child("child-begin"), save: own("child-begin", "t9") }],
      ["child-save", { begin: own("child-save", "t9"), save: child("child-save") }],
    ];
    for (const [id, by] of cases) {
      const saved = await traced(w, id, by);
      assert.ok(!saved.isError, `${id}: ${saved.text}`);
      assert.equal(lifeOf(w, id, "one-function"), "candidate", id);
    }
    // Begun in one session and saved from another: the save itself is refused
    const elsewhere = await traced(w, "other", { begin: own("other", "t9"), save: own("elsewhere", "t9") });
    assert.ok(elsewhere.isError);
    assert.match(elsewhere.text, /This run was begun in another session/);
    assert.equal(lifeOf(w, "other", "one-function"), undefined);
    assert.equal(w.db.owner.prepare("select count(*) as n from unit_adoption").get()?.n, 0);
  } finally {
    await w.done();
  }
});

test("Codex: a check from the owner's own thread says the decision would be active, and a save from another caller still keeps it a candidate", async () => {
  const w = await recordWorld("codex-check-save");
  try {
    const source = decided(w, "s1", QUOTE);
    const run = runOf((await w.reply("trace_begin", { session: "s1" }, own("s1", "t9"))).text);
    const record = aiDecision("one-function", source, QUOTE);
    const checked = await w.reply("record_check", { run, record }, own("s1", "t9"));
    assert.match(checked.text, /would be active/);
    const saved = await w.reply("record_save", { run, record }, own("s1", "t9", { turn_trigger: "exec" }));
    assert.ok(!saved.isError, saved.text);
    assert.equal(lifeOf(w, "s1", "one-function"), "candidate");
  } finally {
    await w.done();
  }
});

test("Codex: once a child thread has called a record tool, no reply of its parent session is adopted, earlier ones included", async () => {
  const w = await recordWorld("codex-child-first");
  try {
    const source = decided(w, "s1", QUOTE);
    // The child's turn is none of the parent's, so the call is logged without a turn
    assert.ok(!(await w.reply("trace_pending", {}, child("s1"))).isError);
    assert.deepEqual(calls(w), [
      {
        tool: "trace_pending",
        host: "codex",
        caller_session: "ext-s1",
        caller_turn: null,
        mode: "unknown",
        mode_raw: "user:subagent",
      },
    ]);
    const run = runOf((await w.reply("trace_begin", { session: "s1" }, own("s1", "t9"))).text);
    const saved = await w.reply(
      "record_save",
      { run, record: aiDecision("one-function", source, QUOTE) },
      own("s1", "t9"),
    );
    assert.ok(!saved.isError, saved.text);
    assert.equal(lifeOf(w, "s1", "one-function"), "candidate");
    assert.equal(w.db.owner.prepare("select count(*) as n from unit_adoption").get()?.n, 0);
  } finally {
    await w.done();
  }
});

test("Codex: a call refused for the shape of its arguments runs nothing and is not logged", async () => {
  const w = await recordWorld("codex-refused");
  try {
    decided(w, "s1", QUOTE);
    const refused = await w.reply("trace_begin", { session: 17 }, own("s1", "t9"));
    assert.ok(refused.isError);
    assert.deepEqual(calls(w), []);
    assert.equal(w.db.owner.prepare("select count(*) as n from extraction_run").get()?.n, 0);
  } finally {
    await w.done();
  }
});

test("Codex: the automatic trace list goes only to the owner's own thread, and leaves the calling session out", async () => {
  const w = await recordWorld("codex-auto");
  try {
    for (const id of ["s1", "s2"]) {
      session(w.db, w.p, id, "codex");
      message(w.db, w.p, {
        id: `${id}-o1`,
        text: "Tidy the export.",
        session: id,
        sent: new Date().toISOString(),
      });
    }
    const listed = await w.reply("trace_pending", { auto: true }, own("s1", "t9"));
    assert.ok(!listed.isError, listed.text);
    assert.match(listed.text, /^- s2 codex /m);
    assert.doesNotMatch(listed.text, /^- s1 /m);
    for (const by of [
      child("s1"),
      own("s1", "t9", { turn_trigger: "exec" }),
      own("s1", "t9", { turn_trigger: "daemon_recovery" }),
      own("s1", "t9", { thread_source: undefined }),
    ]) {
      const stopped = await w.reply("trace_pending", { auto: true }, by);
      assert.match(stopped.text, /the automatic trace does nothing this time/);
      assert.doesNotMatch(stopped.text, /^- s2 /m);
    }
    // Asked for by the owner, the list is the same whoever calls
    assert.match((await w.reply("trace_pending", {}, child("s1"))).text, /^- s2 codex /m);
  } finally {
    await w.done();
  }
});

test("Claude Code: the automatic trace list does not depend on the mode the server read", async () => {
  // No entrypoint in the server's environment: the mode is unknown, and the list is refused only when the calling session is unknown
  const w = await recordWorld("claude-auto");
  try {
    session(w.db, w.p, "s2");
    message(w.db, w.p, {
      id: "s2-o1",
      text: "Tidy the export.",
      session: "s2",
      sent: new Date().toISOString(),
    });
    const listed = await w.reply("trace_pending", { auto: true });
    assert.match(listed.text, /Sphica cannot tell which session called/);
    assert.equal(calls(w)[0]?.mode, "unknown");
  } finally {
    await w.done();
  }
});
