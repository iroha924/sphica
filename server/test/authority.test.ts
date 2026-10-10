// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentHistory, authorityOf } from "../src/authority.ts";
import { readUnit } from "../src/read.ts";
import { sha256 } from "../src/text.ts";
import { at, insert, message, project, session, type TempDb, tempDb } from "./temp-db.ts";

const T0 = at("2026-09-20T00:00:00Z");
const T1 = at("2026-09-21T00:00:00Z");
const T2 = at("2026-09-22T00:00:00Z");
const T3 = at("2026-09-23T00:00:00Z");

// A decision with the AI's own adoption, made the way the schema allows one: its reply deciding, a decides quote, an interactive run
function agentAdopted(db: TempDb, p: number, key: string) {
  session(db, p, "s1");
  const reply = insert(db, "source", {
    project_id: p,
    kind: "session_message",
    artifact: "session:s1",
    external_id: `${key}:assistant`,
    revision: 1,
    session_id: "s1",
    turn_id: `${key}-turn`,
    author_kind: "assistant",
    created_at: T0,
    captured_at: T0,
    text: "I keep it as is.",
    original_bytes: 16,
    content_hash: sha256(key),
    indexed: 0,
  });
  const call = insert(db, "record_call", {
    project_id: p,
    tool: "trace_begin",
    host: "codex",
    caller_session: "other",
    caller_turn: "t",
    mode: "interactive",
    called_at: T0,
  });
  const run = insert(db, "extraction_run", {
    project_id: p,
    origin: "trace",
    target: "session:s1",
    session_id: "s1",
    status: "running",
    begin_call_id: call,
    started_at: T0,
  });
  const unit = insert(db, "unit", {
    project_id: p,
    key,
    kind: "decision",
    stance: "do",
    text: key,
    extraction: "supported",
    run_id: run,
    created_at: T0,
    content_hash: sha256(`${key}-text`),
  });
  insert(db, "unit_evidence", {
    unit_id: unit,
    source_id: reply,
    span_start: 0,
    span_end: 3,
    role: "decides",
    run_id: run,
    added_at: T0,
  });
  insert(db, "unit_adoption", {
    unit_id: unit,
    route: "agent",
    source_id: reply,
    span_start: 0,
    span_end: 3,
    run_id: run,
    added_at: T1,
  });
  return { unit, run };
}

test("authority: the owner outranks an AI, both read from adoption history as of any time", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const owner = message(db, p, { id: "o1", text: "Keep it as is.", sent: "2026-09-19T00:00:00Z" });
    const { unit, run } = agentAdopted(db, p, "keep");
    const none = insert(db, "unit", {
      project_id: p,
      key: "plain",
      kind: "decision",
      stance: "do",
      text: "plain",
      extraction: "supported",
      run_id: run,
      created_at: T0,
      content_hash: sha256("plain"),
    });
    assert.deepEqual(Object.fromEntries(await authorityOf(db.reader, [unit, none])), {
      [unit]: "agent",
      [none]: "none",
    });
    assert.equal((await authorityOf(db.reader, [unit], T0)).get(unit), "none", "before the AI adopted it");
    assert.match(
      (await readUnit(db.reader, p, "keep", null)) ?? "",
      /^keep \(u\d+, revision \d+\): decision do, candidate, decided by an AI/,
    );
    // The owner adopts it later: the owner's decision from then on, an AI's before
    insert(db, "unit_adoption", {
      unit_id: unit,
      route: "owner_statement",
      source_id: owner,
      span_start: 0,
      span_end: 4,
      run_id: run,
      added_at: T2,
    });
    assert.equal((await authorityOf(db.reader, [unit], T1)).get(unit), "agent");
    assert.equal((await authorityOf(db.reader, [unit])).get(unit), "owner");
    assert.match((await readUnit(db.reader, p, "keep", null)) ?? "", /, the owner's decision/);
    // The owner takes it back: an AI's again, never more than the AI's own adoption gives
    db.owner
      .prepare(
        "update unit_adoption set retracted_at = ?, retraction_reason = 'no', retraction_source_id = ?, retraction_span_start = 0, retraction_span_end = 4 where unit_id = ? and route = 'owner_statement'",
      )
      .run(T3, owner, unit);
    assert.equal((await authorityOf(db.reader, [unit], T2)).get(unit), "owner");
    assert.equal((await authorityOf(db.reader, [unit])).get(unit), "agent");
    assert.deepEqual(await authorityOf(db.reader, []), new Map());
  } finally {
    await db.done();
  }
});

test("agent history: records ever active as an AI's decision stay listed after the owner adopts or the AI's adoption is taken back", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const owner = message(db, p, { id: "o1", text: "Keep it as is.", sent: "2026-09-19T00:00:00Z" });
    const move = (unit: number, run: number, from: string | null, to: string, when: string) =>
      insert(db, "unit_state", {
        unit_id: unit,
        from_state: from,
        to_state: to,
        at: when,
        reason: "r",
        run_id: run,
      });
    const adoptByOwner = (unit: number, run: number, when: string) =>
      insert(db, "unit_adoption", {
        unit_id: unit,
        route: "owner_statement",
        source_id: owner,
        span_start: 0,
        span_end: 4,
        run_id: run,
        added_at: when,
      });
    // Active as the AI's, adopted by the owner later
    const kept = agentAdopted(db, p, "kept");
    move(kept.unit, kept.run, null, "candidate", T0);
    move(kept.unit, kept.run, "candidate", "active", T1);
    adoptByOwner(kept.unit, kept.run, T2);
    // Active as the AI's, then the AI's adoption taken back
    const dropped = agentAdopted(db, p, "dropped");
    move(dropped.unit, dropped.run, null, "candidate", T0);
    move(dropped.unit, dropped.run, "candidate", "active", T1);
    db.owner
      .prepare(
        "update unit_adoption set retracted_at = ?, retraction_reason = 'no', retraction_source_id = ?, retraction_span_start = 0, retraction_span_end = 4 where unit_id = ? and route = 'agent'",
      )
      .run(T3, owner, dropped.unit);
    move(dropped.unit, dropped.run, "active", "candidate", T3);
    // The owner's before it was ever active: never an AI's decision in effect
    const owners = agentAdopted(db, p, "owners");
    adoptByOwner(owners.unit, owners.run, T0);
    move(owners.unit, owners.run, null, "candidate", T0);
    move(owners.unit, owners.run, "candidate", "active", T1);
    // Never active
    agentAdopted(db, p, "waiting");
    const listed = await agentHistory(db.reader, p);
    assert.deepEqual(
      listed.map((h) => [h.key, h.activeAt, h.lifecycle, h.authority, h.adoptions.length]),
      [
        ["kept", T1, "active", "owner", 1],
        ["dropped", T1, "candidate", "none", 1],
      ],
    );
    assert.ok(listed[0]?.contentHash.equals(sha256("kept-text")));
    assert.deepEqual(await agentHistory(db.reader, p + 1), []);
  } finally {
    await db.done();
  }
});

test("agent history: a record still active when the owner's adoption is taken back becomes an AI's decision then", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const owner = message(db, p, { id: "o1", text: "Keep it as is.", sent: "2026-09-19T00:00:00Z" });
    const both = agentAdopted(db, p, "both");
    insert(db, "unit_adoption", {
      unit_id: both.unit,
      route: "owner_statement",
      source_id: owner,
      span_start: 0,
      span_end: 4,
      run_id: both.run,
      added_at: T0,
    });
    for (const [from, to, when] of [
      [null, "candidate", T0],
      ["candidate", "active", T1],
    ] as const)
      insert(db, "unit_state", {
        unit_id: both.unit,
        from_state: from,
        to_state: to,
        at: when,
        reason: "r",
        run_id: both.run,
      });
    assert.deepEqual(await agentHistory(db.reader, p), [], "the owner's decision while active");
    db.owner
      .prepare(
        "update unit_adoption set retracted_at = ?, retraction_reason = 'no', retraction_source_id = ?, retraction_span_start = 0, retraction_span_end = 4 where unit_id = ? and route = 'owner_statement'",
      )
      .run(T2, owner, both.unit);
    assert.deepEqual(
      (await agentHistory(db.reader, p)).map((h) => [h.key, h.activeAt, h.lifecycle, h.authority]),
      [["both", T2, "active", "agent"]],
    );
  } finally {
    await db.done();
  }
});
