// Whether db/migrations/ moves an older database to the current revision without losing rows, ending with the same definitions as a
// fresh db/schema.sql. fixtures/schema-rev1.sql is db/schema.sql at v0.5.7 (the last revision 1 release), fixtures/schema-rev2.sql at v0.6.3, fixtures/schema-rev3.sql at v0.6.7, fixtures/schema-rev4.sql at v0.6.14.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { migrate as migrateFile } from "../src/admin.ts";
import { SCHEMA_REVISION } from "../src/db.ts";
import { connectWriter } from "../src/db-write.ts";
import { sha256 } from "../src/text.ts";

const root = path.join(import.meta.dirname, "..", "..");
const REV1 = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "schema-rev1.sql"), "utf8");
const REV2 = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "schema-rev2.sql"), "utf8");
const REV3 = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "schema-rev3.sql"), "utf8");
const REV4 = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "schema-rev4.sql"), "utf8");
const CURRENT = fs.readFileSync(path.join(root, "db", "schema.sql"), "utf8");
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

const files = new Map<DatabaseSync, string>();
const create = (name: string, schema: string): DatabaseSync => {
  const raw = connectWriter("owner", path.join(dir, name), true);
  open.push(raw);
  files.set(raw, path.join(dir, name));
  raw.exec("pragma journal_mode = wal");
  raw.exec(schema);
  return raw;
};

/** Migrates the way `sphica init` does, and returns what it printed. raw stays open, as a session's connection does during init. */
const migrate = (raw: DatabaseSync): string => {
  const said: string[] = [];
  const log = console.log;
  console.log = (t: string) => said.push(t);
  try {
    migrateFile(files.get(raw) ?? "");
  } finally {
    console.log = log;
  }
  return said.join("\n");
};

/**
 * Table, index, view, and trigger definitions by (type, name). A renamed table's stored SQL quotes its name, so quotes and spacing are dropped.
 * The planner's statistics tables are left out: a finished migration refreshes them, and a fresh database has none yet.
 */
const definitions = (raw: DatabaseSync) =>
  new Map(
    (
      raw
        .prepare(
          "select type, name, sql from sqlite_schema where sql is not null and name not like 'sqlite_stat%'",
        )
        .all() as {
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
    "insert into unit_option (unit_id, position, text, outcome, why) values (1, 1, 'Postgres', 'rejected', 'a server')",
  );
  run(
    "insert into unit_evidence (unit_id, option_id, source_id, span_start, span_end, role, run_id, added_at) values (1, 1, 1, 0, 10, 'rejects', 1, ?)",
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
  "unit_option",
  "unit_evidence",
  "unit_adoption",
  "unit_state",
];
const counts = (raw: DatabaseSync) =>
  TABLES.map((t) => Number((raw.prepare(`select count(*) as n from ${t}`).get() as { n: number }).n));

for (const [from, schema] of [
  [1, REV1],
  [2, REV2],
  [3, REV3],
  [4, REV4],
] as const)
  test(`a migrated revision ${from} database has the same definitions as a fresh current database`, () => {
    const old = create("old.db", schema);
    migrate(old);
    const fresh = create("fresh.db", CURRENT);
    assert.deepEqual(definitions(old), definitions(fresh));
    assert.equal(
      (old.prepare("pragma user_version").get() as { user_version: number }).user_version,
      SCHEMA_REVISION,
    );
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

// Capture checks only the generation, so it keeps writing into a database of an older revision until init migrates it
const CAPTURE_VIEWS = ["capture_session", "capture_message", "capture_edit", "capture_delivery"];
for (const [from, schema] of [
  [1, REV1],
  [2, REV2],
  [3, REV3],
  [4, REV4],
] as const)
  test(`every capture view has the same columns at revision ${from} as now`, () => {
    const old = create("old.db", schema);
    const fresh = create("fresh.db", CURRENT);
    for (const view of CAPTURE_VIEWS) {
      const columns = (raw: DatabaseSync) => raw.prepare(`pragma table_info(${view})`).all();
      assert.notDeepEqual(columns(fresh), [], `${view} exists now`);
      assert.deepEqual(columns(old), columns(fresh), view);
    }
  });

test("a fixture of every earlier revision is kept, each at its own revision", () => {
  const current = Number(/pragma user_version = (\d+);/.exec(CURRENT)?.[1]);
  const kept = fs
    .readdirSync(path.join(import.meta.dirname, "fixtures"))
    .filter((f) => /^schema-rev\d+\.sql$/.test(f));
  assert.deepEqual(
    kept.sort(),
    Array.from({ length: current - 1 }, (_, i) => `schema-rev${i + 1}.sql`).sort(),
  );
  for (const [from, schema] of [
    [1, REV1],
    [2, REV2],
    [3, REV3],
    [4, REV4],
  ] as const)
    assert.match(schema, new RegExp(`pragma user_version = ${from};`));
});

test("capture writes into a migrated database", () => {
  const old = create("old.db", REV1);
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

test("migration keeps unit_state's id counter, so an id once used is never handed out again", () => {
  const raw = create("old.db", REV1);
  fill(raw);
  // A unit removed with its states leaves the counter above the highest id left
  raw
    .prepare(
      "insert into unit (project_id, key, kind, text, extraction, run_id, created_at, content_hash) values (1, 'gone', 'finding', 'gone', 'supported', 1, ?, ?)",
    )
    .run(now, sha256("gone"));
  raw
    .prepare(
      "insert into unit_state (unit_id, from_state, to_state, at, reason, run_id) values (2, null, 'candidate', ?, 'r', 1)",
    )
    .run(now);
  raw.prepare("delete from unit where id = 2").run();
  migrate(raw);
  raw
    .prepare(
      "insert into unit_state (unit_id, from_state, to_state, at, reason, run_id) values (1, 'active', 'candidate', ?, 'r', 1)",
    )
    .run(now);
  assert.equal(Number((raw.prepare("select max(id) as n from unit_state").get() as { n: number }).n), 4);
});

// A rebuilt table is copied column by column: a column left out, or two swapped, would keep every count and still lose what was recorded
test("migrating revision 4 keeps every column of every row", () => {
  const raw = create("old.db", REV4);
  fill(raw);
  raw
    .prepare(
      "update extraction_run set session_id = 's1', reason = 'why', input_bytes = 42, draft_id = 'draft', finished_at = ?",
    )
    .run(new Date("2026-09-21T00:00:00Z").toISOString());
  const tables = (
    raw
      .prepare(
        "select name from sqlite_schema where type = 'table' and sql not like 'CREATE VIRTUAL%' and name not like '%\\_fts\\_%' escape '\\' and name not like 'sqlite\\_%' escape '\\' order by name",
      )
      .all() as { name: string }[]
  ).map((t) => t.name);
  assert.ok(tables.includes("extraction_run") && tables.length >= 25, tables.join(" "));
  const rows = () =>
    new Map(
      tables.map((t) => [
        t,
        raw
          .prepare(`select * from ${t} order by rowid`)
          .all()
          .map((r) => ({ ...r })),
      ]),
    );
  const before = rows();
  assert.ok(Object.values(before.get("extraction_run")?.[0] ?? {}).every((v) => v !== null));
  migrate(raw);
  assert.deepEqual(rows(), before);
});

// Revision 4 let a superseded unit outlive its successor. It goes back to candidate, through a state the migration itself writes
test("migrating revision 4 puts a superseded unit whose successor is withdrawn back to candidate, and says so", () => {
  const raw = create("old.db", REV4);
  fill(raw);
  const run = (sql: string, ...args: (string | number | Buffer | null)[]) => raw.prepare(sql).run(...args);
  const finding = (key: string) =>
    run(
      "insert into unit (project_id, key, kind, text, extraction, run_id, created_at, content_hash) values (1, ?, 'finding', ?, 'supported', 1, ?, ?)",
      key,
      key,
      now,
      sha256(key),
    );
  const move = (unit: number, from: string | null, to: string) =>
    run(
      "insert into unit_state (unit_id, from_state, to_state, at, reason, run_id) values (?, ?, ?, ?, 'r', 1)",
      unit,
      from,
      to,
      now,
    );
  const supersedes = (from: number, to: number) =>
    run(
      "insert into unit_link (from_unit, to_unit, kind, run_id, added_at) values (?, ?, 'supersedes', 1, ?)",
      from,
      to,
      now,
    );
  // 2 was replaced by 3, which was withdrawn. 4 was replaced by 5, which is still a candidate: that one stays superseded
  for (const key of ["left", "gone", "kept", "waiting"]) finding(key);
  for (const [old, next] of [
    [2, 3],
    [4, 5],
  ] as const) {
    move(old, null, "candidate");
    move(next, null, "candidate");
    supersedes(next, old);
    move(old, "candidate", "superseded");
  }
  move(3, "candidate", "withdrawn");
  const revision = (unit: number) =>
    Number(
      (raw.prepare("select revision from unit where id = ?").get(unit) as { revision: number }).revision,
    );
  const before = revision(2);
  const said = migrate(raw);
  assert.deepEqual(
    raw
      .prepare("select id, lifecycle from unit order by id")
      .all()
      .map((u) => [u.id, u.lifecycle]),
    [
      [1, "active"],
      [2, "candidate"],
      [3, "withdrawn"],
      [4, "superseded"],
      [5, "candidate"],
    ],
  );
  assert.equal(revision(2), before + 1);
  assert.deepEqual(
    {
      ...raw
        .prepare(
          "select s.from_state, s.to_state, s.reason, r.origin, r.target, r.status, r.project_id from unit_state s join extraction_run r on r.id = s.run_id where s.unit_id = 2 order by s.id desc limit 1",
        )
        .get(),
    },
    {
      from_state: "superseded",
      to_state: "candidate",
      reason: "schema revision 5: a superseded record whose successors are all withdrawn, or that has none",
      origin: "migration",
      target: "revision:5",
      status: "saved",
      project_id: 1,
    },
  );
  assert.equal(
    Number(
      (
        raw.prepare("select count(*) as n from extraction_run where origin = 'migration'").get() as {
          n: number;
        }
      ).n,
    ),
    1,
  );
  assert.match(
    said,
    /Changed while migrating to revision 5: 1 row[^\n]*\n\s*a superseded record whose successors are all withdrawn, or that has none: 1 row\n\s*unit 2 left \(superseded\) → back to candidate/,
  );
  // The unit is judged again like any candidate, and the rules of revision 5 apply to it
  move(2, "candidate", "withdrawn");
  assert.throws(() => move(2, "withdrawn", "candidate"), /not a lifecycle change/);
});

// Rebuilding a table drops its counter with it. A counter can be above every id left: the highest rows were removed, or all of them
test("migrating revision 4 keeps the id counter of every table, so an id once used is never handed out again", () => {
  const raw = create("old.db", REV4);
  fill(raw);
  const counted = (
    raw
      .prepare("select name from sqlite_schema where type = 'table' and sql like '%autoincrement%'")
      .all() as {
      name: string;
    }[]
  ).map((t) => t.name);
  assert.ok(counted.includes("extraction_run") && counted.length > 10, counted.join(" "));
  for (const name of counted) {
    const had = raw.prepare("update sqlite_sequence set seq = seq + 7 where name = ?").run(name).changes;
    if (!had) raw.prepare("insert into sqlite_sequence (name, seq) values (?, 7)").run(name);
  }
  const counters = () =>
    raw
      .prepare("select name, seq from sqlite_sequence order by name")
      .all()
      .map((r) => [r.name, r.seq]);
  const before = counters();
  migrate(raw);
  assert.deepEqual(counters(), before);
  const run = raw
    .prepare(
      "insert into extraction_run (project_id, origin, target, status, started_at) values (1, 'trace', 'session:s1', 'running', ?) returning id",
    )
    .get(now) as { id: number };
  assert.equal(run.id, 9, "the run made before was 1, and the counter stood at 8");
});

test("migrating revision 2 keeps options and evidence with their ids, and a rejected option then takes a reconsider condition", () => {
  const raw = create("old.db", REV2);
  fill(raw);
  const rows = (sql: string) =>
    raw
      .prepare(sql)
      .all()
      .map((r) => ({ ...r }));
  const options = rows("select id, unit_id, position, text, outcome, why from unit_option order by id");
  const evidence = rows("select * from unit_evidence order by id");
  migrate(raw);
  assert.deepEqual(
    rows("select id, unit_id, position, text, outcome, why from unit_option order by id"),
    options,
  );
  assert.deepEqual(rows("select * from unit_evidence order by id"), evidence);
  // The saved decision stays active and searchable, and a new unit's rejected option carries a condition quoted from the owner
  assert.equal(
    (raw.prepare("select lifecycle from unit where id = 1").get() as { lifecycle: string }).lifecycle,
    "active",
  );
  const run = (sql: string, ...args: (string | number | Buffer | null)[]) => raw.prepare(sql).run(...args);
  run(
    "insert into unit (project_id, key, kind, stance, text, extraction, run_id, created_at, content_hash) values (1, 'trace:session:s1/k2', 'decision', 'do', 'Use WAL', 'supported', 1, ?, ?)",
    now,
    sha256("Use WAL"),
  );
  run(
    "insert into unit_option (unit_id, position, text, outcome, reconsider_when) values (2, 1, 'rollback journal', 'rejected', 'if WAL breaks on a network drive')",
  );
  run(
    "insert into unit_evidence (unit_id, option_id, source_id, span_start, span_end, role, run_id, added_at) values (2, 2, 1, 0, 10, 'reconsiders', 1, ?)",
    now,
  );
  assert.equal(Number((raw.prepare("select max(id) as n from unit_evidence").get() as { n: number }).n), 3);
});

test("migrating revision 3 keeps the saved unit searchable, and a new unit then takes a field value found by search", () => {
  const raw = create("old.db", REV3);
  fill(raw);
  migrate(raw);
  const hits = (word: string) =>
    raw
      .prepare("select rowid from unit_fts where unit_fts match ? order by rowid")
      .all(`"${word}"`)
      .map((r) => Number(r.rowid));
  assert.deepEqual(hits("sqlite"), [1]);
  const run = (sql: string, ...args: (string | number | Buffer | null)[]) => raw.prepare(sql).run(...args);
  run(
    "insert into field_def (project_id, name, type, label, description, source_id, span_start, span_end, run_id, added_at) values (1, 'tenant', 'text', 'Tenant', 'The tenant affected', 1, 0, 10, 1, ?)",
    now,
  );
  run(
    "insert into unit (project_id, key, kind, stance, text, extraction, run_id, created_at, content_hash) values (1, 'trace:session:s1/k2', 'decision', 'do', 'Use WAL', 'supported', 1, ?, ?)",
    now,
    sha256("Use WAL"),
  );
  run(
    "insert into unit_field (unit_id, field_def_id, value, source_id, span_start, span_end, run_id, added_at) values (2, 1, 'acme', 1, 0, 10, 1, ?)",
    now,
  );
  assert.deepEqual(hits("acme"), [2]);
});
