// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The delivery precision sample on a real database: the population a window pins, and a database that no longer gives it.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { differences, digest, extract, type Population } from "../evals/delivery/sample.ts";
import { at, hash, insert, project, run, session, type TempDb, tempDb } from "./temp-db.ts";

const SCRIPT = path.join(import.meta.dirname, "..", "evals", "delivery", "sample.ts");
const WINDOW = { from: at("2026-10-09T00:00:00Z"), to: at("2026-10-16T00:00:00Z") };

function unit(db: TempDb, p: number, key: string): number {
  return insert(db, "unit", {
    project_id: p,
    key,
    kind: "decision",
    stance: "do",
    text: key,
    extraction: "supported",
    run_id: run(db, p),
    created_at: at("2026-10-01T00:00:00Z"),
    content_hash: hash(key.length),
  });
}

function delivered(db: TempDb, s: string, when: string, units: number[], outcome = "emitted"): number {
  const id = insert(db, "delivery", { session_id: s, event: "pre_read", outcome, at: at(when) });
  for (const u of units) insert(db, "delivery_unit", { delivery_id: id, unit_id: u });
  return id;
}

/** Two projects, rows inside and at the edges of the window, a row that showed nothing, and two rows at one time */
function fixture(db: TempDb) {
  const p = project(db);
  const other = project(db, "git:github.com/o/other", "o/other");
  const s = session(db, p, "s1");
  const t = session(db, other, "s2");
  const [a, b, c] = [unit(db, p, "a"), unit(db, p, "b"), unit(db, other, "c")];
  const before = delivered(db, s, "2026-10-08T23:59:59.999Z", [a]);
  const first = delivered(db, s, "2026-10-09T00:00:00Z", [b, a]);
  const lowId = delivered(db, s, "2026-10-12T00:00:00Z", [b]);
  const highId = delivered(db, s, "2026-10-12T00:00:00Z", [a]);
  delivered(db, s, "2026-10-13T00:00:00Z", [], "nothing");
  delivered(db, t, "2026-10-13T00:00:00Z", [c]);
  const edge = delivered(db, s, "2026-10-16T00:00:00Z", [a]);
  return { p, a, b, before, first, lowId, highId, edge };
}

test("the population is the project's emitted pairs inside the window, ordered by time, delivery, and unit", async () => {
  const db = tempDb();
  try {
    const f = fixture(db);
    assert.deepEqual(await extract(db.reader, f.p, WINDOW), [
      [f.first, f.a],
      [f.first, f.b],
      [f.lowId, f.b],
      [f.highId, f.a],
    ]);
  } finally {
    await db.done();
  }
});

test("a pinned population matches itself and names what a database lost or gained since", async () => {
  const db = tempDb();
  try {
    const f = fixture(db);
    const pairs = await extract(db.reader, f.p, WINDOW);
    const pinned: Population = {
      project: "o/r",
      window: WINDOW,
      condition: "",
      extracted_at: at("2026-10-16T00:00:00Z"),
      size: pairs.length,
      sha256: digest(pairs),
      pairs,
    };
    assert.deepEqual(differences(pinned, pairs), []);
    const lost = differences(pinned, pairs.slice(1));
    assert.equal(lost.length, 1);
    assert.match(
      lost[0] ?? "",
      new RegExp(`^1 pinned pairs are no longer in the database, first ${f.first}:${f.a}$`),
    );
    assert.match(
      differences(pinned, [...pairs, [999, f.a]])[0] ?? "",
      /^1 pairs are in the database but not pinned/,
    );
    assert.deepEqual(differences(pinned, [...pairs].reverse()), [
      "the same pairs come back in another order",
    ]);
    assert.match(differences({ ...pinned, sha256: "0" }, pairs)[0] ?? "", /do not hash to the pinned sha256/);
  } finally {
    await db.done();
  }
});

test("the script pins the population once, and stops with the difference when the database no longer gives it", async () => {
  const db = tempDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-sample-"));
  try {
    const f = fixture(db);
    const population = path.join(dir, "population.json");
    const args = [
      "--db",
      db.file,
      "--project",
      "o/r",
      "--from",
      WINDOW.from,
      "--to",
      WINDOW.to,
      "--population",
      population,
    ];
    const go = () =>
      spawnSync(process.execPath, [SCRIPT, ...args], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: dir },
      });
    const first = go();
    assert.equal(first.status, 0, first.stderr);
    const pinned = JSON.parse(fs.readFileSync(population, "utf8")) as Population;
    assert.equal(pinned.size, 4);
    assert.equal(pinned.sha256, digest(pinned.pairs));
    const again = go();
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /4 pairs, the same as/);
    db.owner.prepare("delete from delivery where id = ?").run(f.highId);
    const changed = go();
    assert.notEqual(changed.status, 0);
    assert.match(
      changed.stderr,
      new RegExp(`1 pinned pairs are no longer in the database, first ${f.highId}:${f.a}`),
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(population, "utf8")), pinned);
  } finally {
    await db.done();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the script names the arguments a mode is missing", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--db", "x.db", "--from", WINDOW.from], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--db needs --project, --to, --population/);
});
