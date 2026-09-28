// Whether db/migrations/0002.sql moves a revision 1 database to revision 2 without losing rows, ending with the same definitions as a
// fresh db/schema.sql. The revision 1 schema is fixtures/schema-rev1.sql (db/schema.sql at v0.5.7, the last revision 1 release).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { connectWriter } from "../src/db-write.ts";
import { sha256 } from "../src/text.ts";

const root = path.join(import.meta.dirname, "..", "..");
const REV1 = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "schema-rev1.sql"), "utf8");
const REV2 = fs.readFileSync(path.join(root, "db", "schema.sql"), "utf8");
const MIGRATION = fs.readFileSync(path.join(root, "db", "migrations", "0002.sql"), "utf8");
const now = new Date("2026-09-20T00:00:00Z").toISOString();

let dir: string;
let open: DatabaseSync[];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-migrate-"));
  open = [];
});
afterEach(() => {
  for (const raw of open) raw.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const create = (name: string, schema: string): DatabaseSync => {
  const raw = connectWriter("owner", path.join(dir, name), true);
  open.push(raw);
  raw.exec("pragma journal_mode = wal");
  raw.exec(schema);
  return raw;
};

/** The steps `sphica init` runs, written out so the SQL itself is tested apart from the code that runs it. */
const migrate = (raw: DatabaseSync) => {
  raw.exec("pragma foreign_keys = off");
  raw.exec("begin immediate");
  raw.exec(MIGRATION);
  assert.deepEqual(raw.prepare("pragma foreign_key_check").all(), []);
  raw.exec("commit");
  raw.exec("pragma foreign_keys = on");
};

/** Table, index, view, and trigger definitions by (type, name). A renamed table's stored SQL quotes its name, so quotes and spacing are dropped. */
const definitions = (raw: DatabaseSync) =>
  new Map(
    (
      raw.prepare("select type, name, sql from sqlite_schema where sql is not null").all() as {
        type: string;
        name: string;
        sql: string;
      }[]
    ).map((r) => [`${r.type} ${r.name}`, r.sql.replaceAll('"', "").replace(/\s+/g, " ").trim()]),
  );

const fill = (raw: DatabaseSync) => {
  const run = (sql: string, ...args: (string | number | Buffer | null)[]) => raw.prepare(sql).run(...args);
  run("insert into project (key, name) values ('git:github.com/o/r', 'o/r')");
  run(
    "insert into session (id, project_id, host, external_id, started_at) values ('s1', 1, 'claude-code', 'e1', ?)",
    now,
  );
  const text = "Use SQLite. Decided.";
  run(
    "insert into source (project_id, kind, artifact, external_id, revision, session_id, author_kind, created_at, available_at, captured_at, text, original_bytes, content_hash, indexed) values (1, 'session_message', 'session:s1', 'm1', 1, 's1', 'owner', ?, ?, ?, ?, ?, ?, 1)",
    now,
    now,
    now,
    text,
    Buffer.byteLength(text),
    sha256(text),
  );
  run(
    "insert into extraction_run (project_id, origin, target, status, started_at) values (1, 'trace', 'session:s1', 'saved', ?)",
    now,
  );
  run(
    "insert into unit (project_id, key, kind, stance, text, extraction, run_id, created_at, content_hash) values (1, 'trace:session:s1/k', 'decision', 'do', 'Use SQLite', 'supported', 1, ?, ?)",
    now,
    sha256("Use SQLite"),
  );
  run(
    "insert into unit_evidence (unit_id, source_id, span_start, span_end, role, run_id, added_at) values (1, 1, 0, 10, 'states', 1, ?)",
    now,
  );
  run(
    "insert into unit_adoption (unit_id, route, source_id, span_start, span_end, run_id, added_at) values (1, 'owner_statement', 1, 12, 20, 1, ?)",
    now,
  );
  run(
    "insert into unit_state (unit_id, from_state, to_state, at, reason, run_id) values (1, null, 'candidate', ?, 'extracted', 1)",
    now,
  );
  run(
    "insert into unit_state (unit_id, from_state, to_state, at, reason, source_id, run_id) values (1, 'candidate', 'active', ?, 'found', 1, 1)",
    now,
  );
};

const TABLES = [
  "project",
  "session",
  "source",
  "extraction_run",
  "unit",
  "unit_evidence",
  "unit_adoption",
  "unit_state",
];
const counts = (raw: DatabaseSync) =>
  TABLES.map((t) => Number((raw.prepare(`select count(*) as n from ${t}`).get() as { n: number }).n));

test("a migrated revision 1 database has the same definitions as a fresh revision 2 database", () => {
  const old = create("old.db", REV1);
  migrate(old);
  const fresh = create("fresh.db", REV2);
  assert.deepEqual(definitions(old), definitions(fresh));
  assert.equal((old.prepare("pragma user_version").get() as { user_version: number }).user_version, 2);
  assert.deepEqual(
    old
      .prepare("pragma integrity_check")
      .all()
      .map((r) => ({ ...r })),
    [{ integrity_check: "ok" }],
  );
});

test("migration keeps every row, the state history, and its ids, and the database keeps working", () => {
  const raw = create("old.db", REV1);
  fill(raw);
  const before = counts(raw);
  const states = raw
    .prepare(
      "select id, unit_id, from_state, to_state, at, reason, source_id, run_id from unit_state order by id",
    )
    .all();
  migrate(raw);
  assert.deepEqual(counts(raw), before);
  assert.deepEqual(
    raw
      .prepare(
        "select id, unit_id, from_state, to_state, at, reason, source_id, run_id from unit_state order by id",
      )
      .all(),
    states,
  );
  assert.deepEqual(
    raw
      .prepare("select distinct forget_id from unit_state")
      .all()
      .map((r) => ({ ...r })),
    [{ forget_id: null }],
  );
  assert.equal(
    (raw.prepare("select lifecycle from unit where id = 1").get() as { lifecycle: string }).lifecycle,
    "active",
  );
  // Ids keep counting up after the rebuild, and the state rules still run
  raw
    .prepare(
      "insert into unit_state (unit_id, from_state, to_state, at, reason, run_id) values (1, 'active', 'candidate', ?, 'r', 1)",
    )
    .run(now);
  assert.equal(Number((raw.prepare("select max(id) as n from unit_state").get() as { n: number }).n), 3);
  assert.throws(
    () =>
      raw
        .prepare(
          "insert into unit_state (unit_id, from_state, to_state, at, reason, run_id) values (1, 'active', 'candidate', ?, 'r', 1)",
        )
        .run(now),
    /current lifecycle/,
  );
  assert.equal(
    Number(
      (
        raw.prepare("select count(*) as n from source_fts where source_fts match 'sqlite'").get() as {
          n: number;
        }
      ).n,
    ),
    1,
  );
});

test("capture writes the same columns at both revisions, and writes into a migrated database", () => {
  const old = create("old.db", REV1);
  const fresh = create("fresh.db", REV2);
  const columns = (raw: DatabaseSync) => raw.prepare("pragma table_info(capture_message)").all();
  assert.deepEqual(columns(old), columns(fresh));
  fill(old);
  migrate(old);
  const capture = connectWriter("capture", path.join(dir, "old.db"));
  open.push(capture);
  const text = "and use WAL";
  capture
    .prepare(
      "insert into capture_message (external_id, session_id, turn_id, speaker, created_at, captured_at, text, truncated, redacted, original_bytes, content_hash) values ('m2', 's1', 't', 'owner', ?, ?, ?, 0, 0, ?, ?)",
    )
    .run(now, now, text, Buffer.byteLength(text), sha256(text));
  assert.equal(Number((old.prepare("select count(*) as n from source").get() as { n: number }).n), 2);
});
