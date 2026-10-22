// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// What happened to each record that was ever active as an AI's decision, read from a real database, and how the labels are counted.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { count, type Labelled, outcomeOf, outcomes, type Row } from "../evals/agent-decisions/outcomes.ts";
import { aiDecided, at, insert, message, project, run, tempDb } from "./temp-db.ts";

const LATER = at("2026-09-28T00:00:00Z");

test("outcomes: each AI decision by what ended it first, then by who adopts it now, with the record that replaced it", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const r = run(db, p);
    const owner = message(db, p, { id: "o1", text: "Adopt it." });
    const move = (unit: number, from: string, to: string) =>
      insert(db, "unit_state", {
        unit_id: unit,
        from_state: from,
        to_state: to,
        at: LATER,
        reason: "r",
        run_id: r,
      });
    const ownerAdopts = (unit: number) =>
      insert(db, "unit_adoption", {
        unit_id: unit,
        route: "owner_statement",
        source_id: owner,
        span_start: 0,
        span_end: 5,
        run_id: r,
        added_at: LATER,
      });
    const kept = aiDecided(db, p, "k", "Keep the cache.");
    const adopted = aiDecided(db, p, "ad", "Pin the runtime version.");
    ownerAdopts(adopted);
    const old = aiDecided(db, p, "old", "Skip the retry on timeouts.");
    const next = aiDecided(db, p, "next", "Retry once on timeouts, then stop.");
    ownerAdopts(next);
    insert(db, "unit_link", {
      from_unit: next,
      to_unit: old,
      kind: "supersedes",
      run_id: r,
      added_at: LATER,
    });
    insert(db, "unit_replacement", { from_unit: next, to_unit: old, run_id: r, started_at: LATER });
    move(old, "active", "superseded");
    // Only an intent: it replaces nothing until it takes effect
    const pending = aiDecided(db, p, "pend", "Cache the token in memory only.");
    insert(db, "unit_link", {
      from_unit: adopted,
      to_unit: pending,
      kind: "supersedes",
      run_id: r,
      added_at: LATER,
    });
    const gone = aiDecided(db, p, "gone", "Drop the fallback path entirely.");
    move(gone, "active", "withdrawn");
    const back = aiDecided(db, p, "backx", "Log every hook call to stderr.");
    db.owner
      .prepare(
        "update unit_adoption set retracted_at = ?, retraction_reason = 'no', retraction_source_id = ?, retraction_span_start = 0, retraction_span_end = 5 where unit_id = ?",
      )
      .run(LATER, owner, back);
    const rows = await outcomes(db.reader, p);
    assert.deepEqual(
      rows.map((x) => [x.key, x.outcome, x.replacedBy]),
      [
        ["trace:ext-s1/k", "unchanged", null],
        ["trace:ext-s1/ad", "owner adopted", null],
        ["trace:ext-s1/old", "replaced", { unit: next, key: "trace:ext-s1/next", authority: "owner" }],
        ["trace:ext-s1/next", "owner adopted", null],
        ["trace:ext-s1/pend", "unchanged", null],
        ["trace:ext-s1/gone", "withdrawn", null],
        ["trace:ext-s1/backx", "taken back", null],
      ],
    );
    assert.equal(rows[0]?.unit, kept);
    assert.deepEqual(await outcomes(db.reader, p + 1), []);
  } finally {
    await db.done();
  }
});

test("outcomes: a record the owner adopted and then replaced counts as replaced", () => {
  assert.equal(outcomeOf({ lifecycle: "superseded", authority: "owner" }), "replaced");
  assert.equal(outcomeOf({ lifecycle: "withdrawn", authority: "owner" }), "withdrawn");
});

test("outcomes: unchanged records are counted by their settled label, and a disagreement is unknown", () => {
  const row = (unit: number, outcome: Row["outcome"]): Row => ({
    unit,
    key: `k${unit}`,
    activeAt: LATER,
    lifecycle: "active",
    authority: "agent",
    outcome,
    replacedBy: null,
  });
  const label = (unit: number, claude: Labelled["claude"], codex: Labelled["codex"]): Labelled => ({
    unit,
    claude,
    claude_reason: "r",
    codex,
    codex_reason: "r",
  });
  const rows = [row(1, "unchanged"), row(2, "unchanged"), row(3, "unchanged"), row(4, "replaced")];
  assert.deepEqual(
    count(rows, [
      label(1, "holds", "holds"),
      label(2, "holds", "no longer holds"),
      label(3, "no longer holds", "no longer holds"),
    ]),
    {
      outcomes: { "owner adopted": 0, replaced: 1, withdrawn: 0, "taken back": 0, unchanged: 3 },
      unchanged: { holds: 1, "no longer holds": 1, unknown: 1 },
    },
  );
  assert.throws(
    () => count(rows, [label(1, "holds", "holds"), label(2, "holds", "holds")]),
    /u3 \(k3\) is unchanged but has no labels/,
  );
  assert.throws(
    () =>
      count(rows, [
        label(1, "holds", "holds"),
        label(2, "holds", "holds"),
        label(3, "holds", "holds"),
        label(4, "holds", "holds"),
      ]),
    /labels for records that are not unchanged: u4/,
  );
});
