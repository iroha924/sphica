// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// A conflict holds a record back only when both sides could be delivered at all: delivery and read agree, now and as of a past time.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { inTransaction } from "../src/db.ts";
import { deliverableIds } from "../src/deliver.ts";
import { readUnit } from "../src/read.ts";
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

async function save(db: TempDb, p: number, units: unknown[]) {
  const t = target(p);
  return inTransaction(db.ingest, async (trx) => {
    const runId = await openRun(trx, {
      projectId: p,
      origin: t.origin,
      target: "session:s1",
      sessionId: t.sessionId,
      draftId: `d${Math.random()}`,
    });
    return saveRecord(trx, t, runId, await checkRecord(trx, t, { units }), []);
  });
}

test("a conflict with a quarantined record holds nothing back, in either direction, and read says so", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, {
      id: "m1",
      text: "OFF is faster. Decided: use SQLite. Sync is slow. Rows are capped. Cache it.",
    });
    const said = (quote: string) => ({ source: `s${m}`, quote, role: "states" });
    const finding = (key: string, quote: string, extra: Record<string, unknown> = {}) => ({
      key,
      kind: "finding",
      text: key,
      evidence: [said(quote)],
      ...extra,
    });
    const decision = (key: string, evidence: string, extra: Record<string, unknown> = {}) => ({
      key,
      kind: "decision",
      stance: "do",
      text: key,
      evidence: [said(evidence)],
      adoption: [{ source: `s${m}`, quote: "Decided: use SQLite." }],
      ...extra,
    });
    const k = (key: string) => `trace:ext-s1/${key}`;
    await save(db, p, [
      finding("fast", "OFF is faster."),
      decision("sqlite", "Decided: use SQLite."),
      finding("slow", "Sync is slow."),
      // Its quote is not in the message, so it is quarantined
      finding("ghost", "words nobody said"),
      finding("cache", "Cache it."),
    ]);
    await save(db, p, [
      // Quarantined records that say they conflict with sound ones: a finding, and a decision the owner did adopt
      finding("q-finding", "more words nobody said", { conflicts: [k("fast")] }),
      decision("q-decision", "still more words nobody said", { conflicts: [k("sqlite")] }),
      // A sound record that names a quarantined one
      finding("capped", "Rows are capped.", { conflicts: [k("ghost")] }),
      // Two sound records in conflict
      finding("rival", "Sync is slow.", { conflicts: [k("cache")] }),
    ]);
    const row = (key: string) =>
      db.owner.prepare("select id, lifecycle, extraction from unit where key = ?").get(k(key)) as {
        id: number;
        lifecycle: string;
        extraction: string;
      };
    assert.deepEqual(
      ["ghost", "q-finding", "q-decision"].map((key) => row(key).extraction),
      ["quarantined", "quarantined", "quarantined"],
    );
    assert.equal(
      (
        db.owner.prepare("select count(*) as n from unit_link where kind = 'conflicts'").get() as {
          n: number;
        }
      ).n,
      4,
    );

    for (const asOf of [undefined, "2999-01-01T00:00:00.000Z"]) {
      const ids = await deliverableIds(db.reader, p, asOf);
      const delivered = (key: string) => ids.has(row(key).id);
      assert.deepEqual(
        ["fast", "sqlite", "capped", "slow"].map(delivered),
        [true, true, true, true],
        `sound records beside a quarantined one, as of ${asOf ?? "now"}`,
      );
      assert.deepEqual(
        ["rival", "cache"].map(delivered),
        [false, false],
        `two sound records in conflict, as of ${asOf}`,
      );
      assert.deepEqual(["ghost", "q-finding", "q-decision"].map(delivered), [false, false, false]);
    }

    const read = async (key: string) => (await readUnit(db.reader, p, k(key), null)) ?? "";
    for (const key of ["fast", "sqlite", "capped"]) {
      assert.match(await read(key), /Conflicts with .*holds nothing back/, key);
      assert.doesNotMatch(await read(key), /held back from automatic delivery/, key);
    }
    assert.match(await read("cache"), /Conflicts with .*held back from automatic delivery/);
  } finally {
    await db.done();
  }
});
