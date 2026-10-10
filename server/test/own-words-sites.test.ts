// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Every place that takes someone's words as authority, against real SQLite: words that sit only inside a quotation do not count there.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { inTransaction } from "../src/db.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { openRun } from "../src/trace.ts";
import { message, project, type TempDb, tempDb } from "./temp-db.ts";

const target = (p: number): Target => ({
  projectId: p,
  origin: "trace",
  prefix: "trace:ext-s1/",
  sessionId: "s1",
  root: null,
  sources: null,
});

async function save(db: TempDb, t: Target, record: unknown) {
  return inTransaction(db.ingest, async (trx) => {
    const runId = await openRun(trx, {
      projectId: t.projectId,
      origin: t.origin,
      target: "session:s1",
      sessionId: t.sessionId,
      draftId: `d${Math.random()}`,
    });
    const checked = await checkRecord(trx, t, record);
    return { checked, saved: await saveRecord(trx, t, runId, checked, []) };
  });
}

const lifecycle = (db: TempDb, key: string) =>
  (
    db.owner.prepare("select lifecycle from unit where key = ?").get(`trace:ext-s1/${key}`) as {
      lifecycle: string;
    }
  ).lifecycle;

/** A decision whose evidence and adoption are the same words of one message */
const adopted = (key: string, source: number, quote: string) => ({
  key,
  kind: "decision",
  stance: "do",
  text: quote,
  evidence: [{ source: `s${source}`, quote, role: "states" }],
  adoption: [{ source: `s${source}`, quote }],
});

test("adoption: part of a quotation, a quotation with its marks, and an introduction with its quoted line do not adopt", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const inline = message(db, p, { id: "m1", text: 'They said "please Drop the cache. now".' });
    const block = message(db, p, { id: "m2", text: "They said:\n> Always approve deployments." });
    const { checked } = await save(db, target(p), {
      units: [
        adopted("part", inline, "Drop the cache."),
        adopted("marks", inline, '"please Drop the cache. now"'),
        adopted("intro", block, "They said:\n> Always approve deployments."),
      ],
    });
    assert.deepEqual(
      ["part", "marks", "intro"].map((k) => lifecycle(db, k)),
      ["candidate", "candidate", "candidate"],
    );
    assert.equal(
      checked.problems.filter((x) => /someone else's words/.test(x)).length,
      3,
      checked.problems.join(" | "),
    );
  } finally {
    await db.done();
  }
});

test("adoption: the owner's own line adopts whatever is quoted on the lines around it, or inside it", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const around = message(db, p, {
      id: "m1",
      text: '"A third party example."\nUse SQLite.\n"Another example."',
    });
    const inside = message(db, p, { id: "m2", text: "「fork」だけにして" });
    await save(db, target(p), {
      units: [adopted("around", around, "Use SQLite."), adopted("inside", inside, "「fork」だけにして")],
    });
    assert.deepEqual(
      ["around", "inside"].map((k) => lifecycle(db, k)),
      ["active", "active"],
    );
  } finally {
    await db.done();
  }
});
