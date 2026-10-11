// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The audit of rows saved before the quotation rule covered them: it finds them by kind, counts what it cannot check, and changes nothing.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Audit, auditClosing, auditQuotes, auditSections } from "../src/audit-quotes.ts";
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

    // The report names each finding under its kind, with where it is, why, whether it still has effect, and what can be done
    const sections = auditSections(audit);
    assert.deepEqual(
      sections.map((lines) => lines[0]),
      [
        "adoption: 1",
        "retraction reason: 1",
        "Not checked, since their words are not kept: no such rows (links from harvest or glean, withdrawals, resolved conflicts)",
      ],
    );
    assert.equal(
      sections[0]?.[1],
      `  o/r trace:ext-s1/storage (unit_adoption ${quoted}): s${m} bytes ${inline[0]}-${inline[1]} sit inside quotation marks; retracted, kept as history`,
    );
    assert.match(sections[0]?.[2] ?? "", /^ {2}What you can do: .*retract_adoption/);
    assert.match(sections[1]?.[1] ?? "", /touch a block quote or fenced code; in effect$/);
    assert.match(sections[1]?.[2] ?? "", /^ {2}What you can do: a retraction cannot be undone/);
    assert.match(
      auditClosing(audit),
      /^2 of 5 rows rest on words the quotation rule refuses\. Nothing was changed\./,
    );

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
  const audit = (unchecked: Audit["unchecked"]): Audit => ({ findings: [], read: 1, unchecked });
  const last = (unchecked: Audit["unchecked"]) => auditSections(audit(unchecked)).at(-1) ?? [];
  assert.equal(last({ links: 0, withdrawals: 0, resolutions: 0 }).length, 1);
  const lines = last({ links: 2, withdrawals: 1, resolutions: 3 });
  assert.equal(lines.length, 4);
  assert.equal(lines[0], "Not checked, since their words are not kept:");
  assert.match(
    lines[1] ?? "",
    /^ {2}2 links from harvest or glean: .*Read the record's evidence and adoption/,
  );
  assert.match(lines[2] ?? "", /^ {2}1 withdrawal: .*cannot be undone: .*under a new key/);
  assert.match(lines[3] ?? "", /^ {2}3 resolved conflicts: .*cannot be reopened: .*successor/);
  assert.equal(last({ links: 0, withdrawals: 0, resolutions: 1 }).length, 2);
  assert.match(auditClosing(audit({ links: 0, withdrawals: 0, resolutions: 0 })), /^0 of 1 row rest/);
});

test("the advice on a reconsider condition warns that a retraction takes the record's own evidence of the same words", () => {
  const audit: Audit = {
    findings: [
      {
        project: "o/r",
        what: "trace:x/storage",
        kind: "reconsider condition",
        row: "unit_evidence 4",
        source: 3,
        start: 0,
        end: 4,
        why: "inline",
        live: true,
      },
    ],
    read: 1,
    unchecked: { links: 0, withdrawals: 0, resolutions: 0 },
  };
  const advice = auditSections(audit)[0]?.at(-1) ?? "";
  assert.match(advice, /retract_evidence/);
  assert.match(advice, /every piece of the record's evidence that cites the same words/);
  assert.match(advice, /save a successor/);
});

test("a name from the database cannot start a line of the report", () => {
  const audit: Audit = {
    findings: [
      {
        project: "o/r\n\u2713 0 of 0 rows",
        what: "trace:x/\u001b[2Jkey",
        kind: "field definition",
        row: "field_def 1",
        source: 3,
        start: 0,
        end: 4,
        why: "inline",
        live: true,
      },
    ],
    read: 1,
    unchecked: { links: 0, withdrawals: 0, resolutions: 0 },
  };
  const lines = auditSections(audit).flat();
  assert.ok(
    lines.every((l) => !l.includes("\n") && !l.includes("\u001b")),
    lines.join("|"),
  );
});
