// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The audit of rows saved before the quotation rule covered them: it finds them by kind, counts what it cannot check, and changes nothing.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { auditQuotes, KINDS, REPAIR, uncheckedLines } from "../src/audit-quotes.ts";
import { inTransaction } from "../src/db.ts";
import { locate } from "../src/own-words.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { openRun } from "../src/trace.ts";
import { at, dump, insert, message, project, run, tempDb } from "./temp-db.ts";

test("the audit lists rows resting on quoted words by kind, leaves sound rows out, and changes no row", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const text =
      'Use SQLite. Decided. Track the tenant. Come back to it when writes are shared.\nThe vendor wrote "Make that final." and:\n> Take that back.';
    const m = message(db, p, { id: "m1", text });
    const t: Target = {
      projectId: p,
      origin: "trace",
      prefix: "trace:ext-s1/",
      sessionId: "s1",
      root: null,
      sources: null,
    };
    // Rows saved through the checks: an adoption, a reconsider condition, and a field definition, all in the owner's own words
    await inTransaction(db.ingest, async (trx) => {
      const runId = await openRun(trx, {
        projectId: p,
        origin: "trace",
        target: "session:s1",
        sessionId: "s1",
        draftId: "d1",
      });
      const checked = await checkRecord(trx, t, {
        field_defs: [
          {
            name: "tenant",
            type: "text",
            label: "Tenant",
            description: "The tenant affected",
            kinds: ["decision"],
            quote: { source: `s${m}`, quote: "Track the tenant." },
          },
        ],
        units: [
          {
            key: "storage",
            kind: "decision",
            stance: "do",
            text: "Store data in SQLite",
            options: [
              {
                text: "Postgres",
                outcome: "rejected",
                reconsider_when: "when writes are shared",
                reconsider_quote: { source: `s${m}`, quote: "Come back to it when writes are shared." },
              },
            ],
            evidence: [{ source: `s${m}`, quote: "Use SQLite.", role: "states" }],
            adoption: [{ source: `s${m}`, quote: "Decided." }],
          },
          {
            key: "note",
            kind: "finding",
            text: "A note",
            evidence: [{ source: `s${m}`, quote: "Use SQLite.", role: "states" }],
          },
        ],
      });
      assert.deepEqual(checked.errors, []);
      await saveRecord(trx, t, runId, checked, []);
    });
    const unit = Number(db.owner.prepare("select id from unit where key = 'trace:ext-s1/storage'").get()?.id);
    assert.deepEqual(await auditQuotes(db.reader), {
      findings: [],
      read: 3,
      unchecked: { links: 0, withdrawals: 0, resolutions: 0 },
    });

    // Rows as an earlier version saved them: an adoption inside quotation marks, and a retraction whose reason is a block quote
    const inline = locate(text, "Make that final.") ?? [0, 0];
    const block = locate(text, "Take that back.") ?? [0, 0];
    const now = at("2026-09-27T00:00:00Z");
    const quoted = insert(db, "unit_adoption", {
      unit_id: unit,
      route: "owner_statement",
      source_id: m,
      span_start: inline[0],
      span_end: inline[1],
      run_id: run(db, p),
      added_at: now,
    });
    db.owner
      .prepare(
        "update unit_adoption set retracted_at = ?, retraction_reason = 'taken back', retraction_source_id = ?, retraction_span_start = ?, retraction_span_end = ? where id = ?",
      )
      .run(now, m, block[0], block[1], quoted);

    const before = dump(db);
    const audit = await auditQuotes(db.reader);
    assert.deepEqual(dump(db), before);
    assert.deepEqual(audit.findings, [
      {
        project: "o/r",
        what: "trace:ext-s1/storage",
        kind: "adoption",
        row: `unit_adoption ${quoted}`,
        source: m,
        start: inline[0],
        end: inline[1],
        why: "inline",
        live: false,
      },
      {
        project: "o/r",
        what: "trace:ext-s1/storage",
        kind: "retraction reason",
        row: `unit_adoption ${quoted}`,
        source: m,
        start: block[0],
        end: block[1],
        why: "block",
        live: true,
      },
    ]);
    // The sound adoption, the quoted one, its retraction's reason, the condition, and the definition
    assert.equal(audit.read, 5);
    for (const kind of KINDS) assert.ok(REPAIR[kind].length > 0, kind);

    // A withdrawal is counted with or without its reason's message: forgetting the message sets the source to null and leaves the row
    const note = Number(db.owner.prepare("select id from unit where key = 'trace:ext-s1/note'").get()?.id);
    for (const [id, source] of [
      [unit, m],
      [note, null],
    ] as const)
      insert(db, "unit_state", {
        unit_id: id,
        from_state: "active",
        to_state: "withdrawn",
        // A state comes after its unit was created, which was just now
        at: new Date(Date.now() + 1000).toISOString(),
        reason: "withdrawn: no longer holds",
        source_id: source,
        run_id: run(db, p),
      });
    assert.deepEqual((await auditQuotes(db.reader)).unchecked, { links: 0, withdrawals: 2, resolutions: 0 });
  } finally {
    await db.done();
  }
});

test("what cannot be checked is named with what can be done about it, one line per kind that has rows", () => {
  assert.deepEqual(uncheckedLines({ links: 0, withdrawals: 0, resolutions: 0 }), []);
  const lines = uncheckedLines({ links: 2, withdrawals: 1, resolutions: 3 });
  assert.equal(lines.length, 3);
  assert.match(lines[0] ?? "", /^2 links from harvest or glean: .*Read the record's evidence and adoption/);
  assert.match(lines[1] ?? "", /^1 withdrawal: .*cannot be undone: .*under a new key/);
  assert.match(lines[2] ?? "", /^3 resolved conflicts: .*cannot be reopened: .*successor/);
  assert.deepEqual(uncheckedLines({ links: 0, withdrawals: 0, resolutions: 1 }).length, 1);
});
