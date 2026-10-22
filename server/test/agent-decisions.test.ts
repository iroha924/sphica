// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// What happened to each record that was ever active as an AI's decision, read from a real database, and how the labels are counted.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { count, type Labelled, outcomeOf, outcomes, type Row } from "../evals/agent-decisions/outcomes.ts";
import { aiDecided, at, insert, message, project, run, tempDb } from "./temp-db.ts";

const SCRIPT = path.join(import.meta.dirname, "..", "evals", "agent-decisions", "outcomes.ts");

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
      outcomes: {
        "owner adopted": 0,
        replaced: 1,
        withdrawn: 0,
        "taken back": 0,
        deactivated: 0,
        unchanged: 3,
      },
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

test("outcomes: a record moved back to a candidate while the AI's adoption stays is deactivated, not unchanged", () => {
  assert.equal(outcomeOf({ lifecycle: "candidate", authority: "agent" }), "deactivated");
  assert.equal(outcomeOf({ lifecycle: "candidate", authority: "owner" }), "deactivated");
  assert.equal(outcomeOf({ lifecycle: "candidate", authority: "none" }), "taken back");
});

test("outcomes: labels outside the fixed set, missing a model's label, or given twice for one record are refused", () => {
  const rows: Row[] = [
    {
      unit: 1,
      key: "k1",
      activeAt: LATER,
      lifecycle: "active",
      authority: "agent",
      outcome: "unchanged",
      replacedBy: null,
    },
  ];
  const good = { unit: 1, claude: "holds", claude_reason: "r", codex: "holds", codex_reason: "r" };
  const bad = (over: object) => [{ ...good, ...over }] as unknown as Labelled[];
  assert.throws(
    () => count(rows, bad({ claude: "hold", codex: "hold" })),
    /u1: claude's label "hold" is not one of/,
  );
  assert.throws(() => count(rows, bad({ codex: undefined })), /u1: codex's label undefined is not one of/);
  assert.throws(() => count(rows, bad({ codex_reason: "" })), /u1: codex's label has no reason/);
  assert.throws(
    () => count(rows, [...bad({}), ...bad({ codex: "unknown" })]),
    /u1 is labelled more than once/,
  );
});

test("outcomes: the command refuses to write its output over the database it reads", async () => {
  const db = tempDb();
  try {
    project(db);
    const before = fs.readFileSync(db.file);
    const ran = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "--db",
        db.file,
        "--project",
        "git:github.com/o/r",
        "--out",
        path.join(path.dirname(db.file), ".", path.basename(db.file)),
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(ran.status, 0);
    assert.match(ran.stderr, /--out is the database --db reads/);
    assert.ok(fs.readFileSync(db.file).equals(before));
  } finally {
    await db.done();
  }
});
