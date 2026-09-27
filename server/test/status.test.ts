// What status reports: captured and extracted counts, sessions still waiting for trace, and work in progress.
import assert from "node:assert/strict";
import { test } from "node:test";
import { inTransaction } from "../src/db.ts";
import { status } from "../src/status.ts";
import { sha256 } from "../src/text.ts";
import { at, insert, message, project, run, type TempDb, tempDb } from "./temp-db.ts";

const now = at("2026-09-27T00:00:00Z");
const unit = (db: TempDb, p: number, key: string, v: Record<string, string | number | null> = {}) =>
  insert(db, "unit", {
    project_id: p,
    key,
    kind: "finding",
    text: key,
    extraction: "supported",
    run_id: run(db, p),
    created_at: now,
    content_hash: sha256(key),
    ...v,
  });

test("status counts captured and extracted records and names the sessions not traced yet", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const traced = message(db, p, { id: "m1", text: "決めた", session: "s1" });
    message(db, p, { id: "m2", text: "まだ trace していない", session: "s2" });
    message(db, p, { id: "m3", text: "AI の返事だけ", session: "s3", speaker: "assistant" });
    const r = run(db, p);
    insert(db, "source_processing", { source_id: traced, run_id: r, outcome: "units" });
    const done = unit(db, p, "active-one");
    db.owner
      .prepare(
        "insert into unit_evidence (unit_id, source_id, span_start, span_end, role, run_id, added_at) values (?, ?, 0, 3, 'states', (select run_id from unit where id = ?), ?)",
      )
      .run(done, traced, done, now);
    for (const [from, to] of [
      [null, "candidate"],
      ["candidate", "active"],
    ] as const)
      db.owner
        .prepare(
          "insert into unit_state (unit_id, from_state, to_state, at, reason, run_id) values (?, ?, ?, ?, 'r', (select run_id from unit where id = ?))",
        )
        .run(done, from, to, now, done);
    unit(db, p, "waiting");
    unit(db, p, "odd", { extraction: "quarantined", extraction_reason: "quote not found" });
    insert(db, "work", {
      project_id: p,
      key: "w",
      title: "CSV を作り直す",
      goal: "g",
      current: "途中",
      status: "active",
      updated_at: now,
    });
    const out = await status(db.reader, p, "o/r");
    assert.match(out, /Captured: 3 sessions, 3 sources\./);
    assert.match(
      out,
      /1 active record, 1 candidate not active yet \(waiting for adoption or evidence\), 1 quarantined record/,
    );
    // s2 has an owner message nobody has looked at; s3 has only an assistant reply, so there is nothing to trace
    assert.match(out, /1 session not traced yet/);
    assert.match(out, /- CSV を作り直す \(active\): 途中/);
  } finally {
    await db.done();
  }
});

test("status of an empty project says there is nothing waiting and no work", async () => {
  const db = tempDb();
  try {
    const out = await status(db.reader, project(db), "o/r");
    assert.match(out, /Every captured session has been traced\./);
    assert.match(out, /No work in progress\./);
  } finally {
    await db.done();
  }
});

test("a failed transaction rolls back everything it wrote and rethrows the original error", async () => {
  const db = tempDb();
  try {
    await assert.rejects(
      inTransaction(db.ingest, async (trx) => {
        await trx.insertInto("project").values({ key: "git:github.com/o/tx", name: "o/tx" }).execute();
        throw new Error("stop here");
      }),
      /stop here/,
    );
    assert.equal(
      db.owner.prepare("select count(*) as n from project where key = 'git:github.com/o/tx'").get()?.n,
      0,
    );
  } finally {
    await db.done();
  }
});
