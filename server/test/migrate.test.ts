// Whether db/migrations/ moves an older database to the current revision without losing rows, ending with the same definitions as a
// fresh db/schema.sql. fixtures/schema-rev1.sql is db/schema.sql at v0.5.7 (the last revision 1 release), fixtures/schema-rev2.sql at v0.6.3, fixtures/schema-rev3.sql at v0.6.7, fixtures/schema-rev4.sql at v0.6.14, fixtures/schema-rev5.sql at v0.6.16.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { migrate as migrateFile } from "../src/admin.ts";
import { SCHEMA_REVISION } from "../src/db.ts";
import { connectWriter, openWriter } from "../src/db-write.ts";
import { beginGlean, beginTrace, saveText } from "../src/extract.ts";
import { sha256 } from "../src/text.ts";

const root = path.join(import.meta.dirname, "..", "..");
const REV1 = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "schema-rev1.sql"), "utf8");
const REV2 = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "schema-rev2.sql"), "utf8");
const REV3 = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "schema-rev3.sql"), "utf8");
const REV4 = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "schema-rev4.sql"), "utf8");
const REV5 = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "schema-rev5.sql"), "utf8");
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
  [5, REV5],
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
  [5, REV5],
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
    [5, REV5],
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

test("migrating revision 5 keeps every delivery and its units in the main conversation, and both capture views write", () => {
  const raw = create("old.db", REV5);
  fill(raw);
  raw
    .prepare(
      "insert into delivery (session_id, event, outcome, reason, path, eligible, omitted, chars, at) values ('s1', 'pre_read', 'emitted', null, 'src/db.ts', 2, 1, 40, ?)",
    )
    .run(now);
  raw.prepare("insert into delivery_unit (delivery_id, unit_id) values (1, 1)").run();
  const rows = (r: DatabaseSync) =>
    r
      .prepare(
        "select id, session_id, event, outcome, reason, path, eligible, omitted, chars, at from delivery order by id",
      )
      .all()
      .map((x) => ({ ...x }));
  const before = rows(raw);
  migrate(raw);
  assert.deepEqual(rows(raw).slice(0, 1), before);
  assert.deepEqual(
    raw
      .prepare("select agent_id from delivery")
      .all()
      .map((x) => ({ ...x })),
    [{ agent_id: null }],
  );
  assert.deepEqual(
    raw
      .prepare("select delivery_id, unit_id from delivery_unit")
      .all()
      .map((x) => ({ ...x })),
    [{ delivery_id: 1, unit_id: 1 }],
  );
  const capture = connectWriter("capture", path.join(dir, "old.db"));
  open.push(capture);
  capture
    .prepare(
      "insert into capture_delivery (session_id, event, outcome, eligible, at, units) values ('s1', 'pre_read', 'emitted', 1, ?, '[1]')",
    )
    .run(now);
  capture
    .prepare(
      "insert into capture_delivery_scoped (session_id, agent_id, event, outcome, eligible, at, units) values ('s1', 'agent-a', 'pre_read', 'emitted', 1, ?, '[1]')",
    )
    .run(now);
  assert.deepEqual(
    raw
      .prepare(
        "select d.agent_id, x.unit_id from delivery d join delivery_unit x on x.delivery_id = d.id where d.id > 1 order by d.id",
      )
      .all()
      .map((x) => ({ ...x })),
    [
      { agent_id: null, unit_id: 1 },
      { agent_id: "agent-a", unit_id: 1 },
    ],
  );
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
      "update extraction_run set session_id = 's1', input_bytes = 42, draft_id = 'draft', finished_at = ?",
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
      tables
        .filter((t) => raw.prepare("select 1 from sqlite_schema where type = 'table' and name = ?").get(t))
        .map((t) => [
          t,
          raw
            .prepare(`select * from ${t} order by rowid`)
            .all()
            .map((r) => ({ ...r })),
        ]),
    );
  const before = rows();
  // The run's reason is the one column revision 5 drops, and was never written
  assert.ok(
    Object.entries(before.get("extraction_run")?.[0] ?? {}).every(([k, v]) => v !== null || k === "reason"),
  );
  migrate(raw);
  const after = rows();
  // Columns revision 5 drops are left out of the comparison, and so are tables it drops
  for (const [table, list] of before) {
    const now = after.get(table);
    if (!now) continue;
    const columns = new Set(Object.keys(now[0] ?? list[0] ?? {}));
    assert.deepEqual(
      now,
      list.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => columns.has(k)))),
      table,
    );
  }
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
  // 2 was replaced by 3, which was withdrawn. 4 was replaced by 5, which is still a candidate: that one stays superseded.
  // 6 points only at 7, a quarantined unit that can never become active: 6 comes back too
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
  finding("alone");
  run(
    "insert into unit (project_id, key, kind, text, extraction, extraction_reason, run_id, created_at, content_hash) values (1, 'quarantined', 'finding', 'q', 'quarantined', 'quote not found', 1, ?, ?)",
    now,
    sha256("quarantined"),
  );
  move(6, null, "candidate");
  move(7, null, "candidate");
  supersedes(7, 6);
  move(6, "candidate", "superseded");
  const revision = (unit: number) =>
    Number(
      (raw.prepare("select revision from unit where id = ?").get(unit) as { revision: number }).revision,
    );
  const before = revision(2);
  // Runs 2 to 8 were made and removed: the migration's own run takes the next id, not one of theirs
  run("update sqlite_sequence set seq = 8 where name = 'extraction_run'");
  const said = migrate(raw);
  assert.deepEqual(
    raw
      .prepare("select id, origin from extraction_run order by id")
      .all()
      .map((r) => [r.id, r.origin]),
    [
      [1, "trace"],
      [9, "migration"],
    ],
  );
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
      [6, "candidate"],
      [7, "candidate"],
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
    /Changed while migrating to revision 5: 2 rows[^\n]*\n\s*a superseded record whose successors are all withdrawn, or that has none: 2 rows\n\s*unit 2 left \(superseded\) → back to candidate\n\s*unit 6 alone \(superseded\) → back to candidate/,
  );
  // The unit is judged again like any candidate, and the rules of revision 5 apply to it
  move(2, "candidate", "withdrawn");
  assert.throws(() => move(2, "withdrawn", "candidate"), /not a lifecycle change/);
});

// Revision 4 let an observation or an anchor spell a path two ways, or hold a control character. Revision 5 takes one spelling
test("migrating revision 4 removes observations and anchors with a path revision 5 refuses, and keeps a comment without its path", () => {
  const raw = create("old.db", REV4);
  fill(raw);
  const run = (sql: string, ...args: (string | number | Buffer | null)[]) => raw.prepare(sql).run(...args);
  run(
    "insert into edit_observation (session_id, turn_id, path, via, observed_at) values ('s1', 't', 'src//a.ts', 'tool', ?)",
    now,
  );
  run(
    "insert into unit_anchor (unit_id, path, role, edit_observation_id, run_id, added_at) values (1, 'src//a.ts', 'applies_to', 1, 1, ?)",
    now,
  );
  run(
    "insert into unit_anchor (unit_id, path, role, run_id, added_at) values (1, 'src/fine.ts', 'applies_to', 1, ?)",
    now,
  );
  // The code refuses every control character, C1 included
  run(
    "insert into unit_anchor (unit_id, path, role, run_id, added_at) values (1, ?, 'applies_to', 1, ?)",
    "src/a\u0085.ts",
    now,
  );
  const text = "look here";
  run(
    "insert into source (project_id, kind, artifact, external_id, revision, author_kind, created_at, captured_at, text, original_bytes, content_hash, indexed, path, line_start, line_end) values (1, 'review_comment', 'pr:1', 'review_comment:1', 1, 'person', ?, ?, ?, ?, ?, 1, ?, 3, 4)",
    now,
    now,
    text,
    Buffer.byteLength(text),
    sha256(text),
    "src/a\u0001.ts",
  );
  const said = migrate(raw);
  assert.equal(
    Number((raw.prepare("select count(*) as n from edit_observation").get() as { n: number }).n),
    0,
  );
  assert.deepEqual(
    raw
      .prepare("select path from unit_anchor")
      .all()
      .map((r) => r.path),
    ["src/fine.ts"],
  );
  assert.deepEqual(
    {
      ...raw
        .prepare("select path, line_start, line_end, text from source where kind = 'review_comment'")
        .get(),
    },
    { path: null, line_start: null, line_end: null, text },
  );
  for (const rule of [
    "an anchor whose path revision 5 refuses: 2 rows",
    "an edit observation whose path revision 5 refuses: 1 row",
    "a source whose path revision 5 refuses: 1 row",
  ])
    assert.ok(said.includes(rule), said);
});

// A file excerpt's path is its identity, and only the owner's forget removes a source: the migration stops and names it
test("migrating revision 4 stops, changing nothing, when a file excerpt has a path revision 5 refuses", () => {
  const raw = create("old.db", REV4);
  fill(raw);
  const text = "line";
  raw
    .prepare(
      "insert into source (project_id, kind, artifact, external_id, revision, author_kind, created_at, captured_at, text, original_bytes, content_hash, indexed, path, line_start, line_end, commit_sha, blob_sha) values (1, 'file_excerpt', 'file:a', 'file:src\u0001a.ts@x#L1-1', 1, 'person', ?, ?, ?, ?, ?, 1, ?, 1, 1, ?, ?)",
    )
    .run(
      now,
      now,
      text,
      Buffer.byteLength(text),
      sha256(text),
      "src\u0001a.ts",
      "a".repeat(40),
      "b".repeat(40),
    );
  const before = raw.prepare("select count(*) as n from source").get();
  assert.throws(
    () => migrate(raw),
    (e: Error) =>
      /a file excerpt whose path revision 5 refuses \(forget it to go on\): 1 row\n\s*source 2 file:src.?a\.ts@x#L1-1/.test(
        e.message,
      ) && /No migration step was committed: the database is still at revision 4/.test(e.message),
  );
  assert.equal((raw.prepare("pragma user_version").get() as { user_version: number }).user_version, 4);
  assert.deepEqual(raw.prepare("select count(*) as n from source").get(), before);
});

// The repairs run while the migration holds the write lock, with the indexes dropped: they must not slow down faster than the rows grow
test("migrating revision 4 with many anchors, edit observations, and evidence and nothing to repair takes time in proportion to them", () => {
  const raw = create("old.db", REV4);
  fill(raw);
  raw.exec(
    "with recursive n(i) as (select 1 union all select i + 1 from n where i < 20000) insert into edit_observation (session_id, turn_id, path, via, observed_at) select 's1', null, 'p' || i || '.ts', 'tool', '2026-09-20T00:00:00.000Z' from n",
  );
  // Spread over many records, as a real database is: one record's search text holds all its anchors
  raw.exec(
    "with recursive n(i) as (select 1 union all select i + 1 from n where i < 5000) insert into unit (project_id, key, kind, text, extraction, run_id, created_at, content_hash) select 1, 'k' || i, 'finding', 'f' || i, 'supported', 1, '2026-09-20T00:00:00.000Z', zeroblob(32) from n",
  );
  raw.exec(
    "with recursive n(i) as (select 1 union all select i + 1 from n where i < 20000) insert into unit_anchor (unit_id, path, role, run_id, added_at) select 2 + i % 5000, 'p' || i || '.ts', 'applies_to', 1, '2026-09-20T00:00:00.000Z' from n",
  );
  raw.exec(
    "with recursive n(i) as (select 0 union all select i + 1 from n where i < 19999) insert into unit_evidence (unit_id, source_id, span_start, span_end, role, run_id, added_at) select 2 + i % 5000, 1, 0, 3, case i / 5000 when 0 then 'states' when 1 then 'proposes' when 2 then 'rejects' else 'explains' end, 1, '2026-09-20T00:00:00.000Z' from n",
  );
  const started = performance.now();
  const said = migrate(raw);
  const took = performance.now() - started;
  assert.doesNotMatch(said, /Changed while migrating/);
  // Measured: 0.3 seconds here; 7 seconds when each evidence row looked for its duplicates alone, 22 when each anchor did
  assert.ok(took < 3000, `took ${Math.round(took)} ms`);
});

// Revision 4 let small values through that revision 5 refuses. Each takes the nearest value revision 5 accepts, and is listed
test("migrating revision 4 repairs the small values revision 5 refuses, and lists each", () => {
  const raw = create("old.db", REV4);
  fill(raw);
  const run = (sql: string, ...args: (string | number | Buffer | null)[]) => raw.prepare(sql).run(...args);
  const later = new Date("2026-09-21T00:00:00Z").toISOString();
  const text = "日本語で決めた。";
  run(
    "insert into source (project_id, kind, artifact, external_id, revision, session_id, author_kind, created_at, captured_at, text, original_bytes, content_hash, indexed, url) values (1, 'session_message', 'session:s1', 'm2', 1, 's1', 'assistant', ?, ?, ?, ?, ?, 1, 'javascript:alert(1)')",
    now,
    now,
    text,
    Buffer.byteLength(text),
    sha256(text),
  );
  run(
    "insert into source (project_id, kind, artifact, external_id, revision, author_kind, created_at, captured_at, text, original_bytes, content_hash, indexed, line_end) values (1, 'pr_comment', 'pr:1', 'c1', 1, 'person', ?, ?, 'x', 1, ?, 1, 4)",
    now,
    now,
    sha256("x"),
  );
  // Unit 1's evidence cuts the first character (bytes 0-2) at byte 1, and its adoption was retracted before it was added
  // A retracted row citing the whole words, then a live one that cut them: widened, they cite the same words, and the live one stays
  run(
    "insert into unit_evidence (unit_id, source_id, span_start, span_end, role, run_id, added_at, retracted_at, retraction_reason, retraction_source_id, retraction_span_start, retraction_span_end) values (1, 2, 0, 6, 'explains', 1, ?, ?, 'r', 1, 0, 3)",
    now,
    later,
  );
  run(
    "insert into unit_evidence (unit_id, source_id, span_start, span_end, role, run_id, added_at) values (1, 2, 1, 6, 'explains', 1, ?)",
    now,
  );
  run(
    "insert into unit_adoption (unit_id, route, source_id, span_start, span_end, run_id, added_at) values (1, 'owner_statement', 1, 0, 3, 1, ?)",
    now,
  );
  run(
    "update unit_adoption set retracted_at = ?, retraction_reason = 'r', retraction_source_id = 1, retraction_span_start = 0, retraction_span_end = 3 where id = 1",
    new Date("2026-01-01T00:00:00Z").toISOString(),
  );
  run(
    "insert into unit (project_id, key, kind, text, extraction, run_id, created_at, content_hash) values (1, 'late', 'finding', 'late', 'supported', 1, ?, ?)",
    now,
    sha256("late"),
  );
  run(
    "insert into unit_state (unit_id, from_state, to_state, at, reason, run_id) values (2, null, 'candidate', ?, 'r', 1)",
    new Date("2026-01-01T00:00:00Z").toISOString(),
  );
  run(
    "update extraction_run set finished_at = ? where id = 1",
    new Date("2026-01-01T00:00:00Z").toISOString(),
  );
  // An anchor written already retired and pointing at itself: revision 4 took it
  run(
    "insert into unit_anchor (id, unit_id, path, role, run_id, added_at, retired_at, replaced_by) values (7, 1, 'a.ts', 'applies_to', 1, ?, ?, 7)",
    now,
    later,
  );
  run(
    "insert into unit_alias (unit_id, terms, content_hash, run_id, added_at) values (1, '[\"x\"]', ?, 1, ?)",
    sha256("other"),
    now,
  );
  // Two adoptions of one unit, one cutting the first character: widened, they are the same, and the adoption table keeps its spans unique
  run(
    "insert into source (project_id, kind, artifact, external_id, revision, session_id, author_kind, created_at, captured_at, text, original_bytes, content_hash, indexed) values (1, 'session_message', 'session:s1', 'm3', 1, 's1', 'owner', ?, ?, ?, ?, ?, 1)",
    now,
    now,
    text,
    Buffer.byteLength(text),
    sha256(`${text}3`),
  );
  const said3 = Number(
    (raw.prepare("select id from source where external_id = 'm3'").get() as { id: number }).id,
  );
  for (const start of [0, 1])
    run(
      "insert into unit_adoption (unit_id, route, source_id, span_start, span_end, run_id, added_at) values (1, 'owner_statement', ?, ?, 6, 1, ?)",
      said3,
      start,
      now,
    );
  const said = migrate(raw);
  const one = (sql: string) => ({ ...(raw.prepare(sql).get() as object) });
  assert.deepEqual(
    raw
      .prepare("select span_start, span_end from unit_adoption where source_id = ?")
      .all(said3)
      .map((r) => [r.span_start, r.span_end]),
    [[0, 6]],
  );
  assert.deepEqual(one("select url, indexed from source where id = 2"), { url: null, indexed: 0 });
  assert.deepEqual(one("select line_start, line_end from source where id = 3"), {
    line_start: null,
    line_end: null,
  });
  assert.deepEqual(one("select span_start, span_end, retracted_at from unit_evidence where source_id = 2"), {
    span_start: 0,
    span_end: 6,
    retracted_at: null,
  });
  assert.deepEqual(one("select retracted_at = added_at as same from unit_adoption where id = 1"), {
    same: 1,
  });
  assert.deepEqual(one("select at from unit_state where unit_id = 2"), { at: now });
  assert.deepEqual(one("select finished_at = started_at as same from extraction_run where id = 1"), {
    same: 1,
  });
  assert.deepEqual(one("select replaced_by from unit_anchor"), { replaced_by: null });
  assert.deepEqual(one("select count(*) as n from unit_alias"), { n: 0 });
  for (const rule of [
    "a run that finished before it started: 1 row",
    "an end line without a start line: 1 row",
    "a web address that is not http or https: 1 row",
    "an assistant reply in the search index: 1 row",
    "a state dated before its record was made: 1 row",
    "an anchor replaced by itself or by another record's anchor: 1 row",
    "an alias set bound to other words than its record's: 1 row",
    "a retraction dated before what it retracts: 1 row",
    "adoption citing the same words twice after widening: 1 row",
    "a span that cuts a character (evidence): 1 row",
    "evidence citing the same words twice after widening: 1 row",
  ])
    assert.ok(said.includes(rule), `${rule}\n${said}`);
});

// Rows with values no release of this generation wrote were written outside Sphica: the migration stops, names every one, and changes nothing
test("migrating revision 4 stops on values no release wrote, and lists every row", () => {
  const raw = create("old.db", REV4);
  fill(raw);
  const run = (sql: string, ...args: (string | number | Buffer | null)[]) => raw.prepare(sql).run(...args);
  run(
    "insert into source (project_id, kind, artifact, external_id, revision, author_kind, event_kind, created_at, captured_at, text, original_bytes, content_hash, indexed) values (1, 'pr_event', 'pr:1', 'pr:1#closed', 1, 'person', 'closed', ?, ?, 'closed', 6, ?, 0)",
    now,
    now,
    sha256("closed"),
  );
  run(
    "insert into extraction_run (project_id, origin, target, status, reason, started_at) values (1, 'trace', 't', 'failed', 'timeout', ?)",
    now,
  );
  run("insert into source_processing (source_id, run_id, outcome) values (1, 2, 'capped')");
  run(
    "insert into unit (project_id, key, kind, text, extraction, run_id, created_at, content_hash) values (1, 'impl', 'implementation', 'impl', 'supported', 1, ?, ?)",
    now,
    sha256("impl"),
  );
  run(
    "insert into unit_link (from_unit, to_unit, kind, run_id, added_at) values (2, 1, 'implements', 1, ?)",
    now,
  );
  run(
    "insert into external_reference (project_id, url, owner_source_id, span_start, span_end, added_at) values (1, 'https://notes.example/x', 1, 0, 3, ?)",
    now,
  );
  run(
    "update unit_evidence set retracted_at = ?, retraction_reason = 'r', retraction_source_id = 1, retraction_span_start = -1, retraction_span_end = 3 where id = 1",
    now,
  );
  const tables = ["source", "extraction_run", "source_processing", "unit_link", "external_reference"];
  const count = () =>
    tables.map((t) => Number((raw.prepare(`select count(*) as n from ${t}`).get() as { n: number }).n));
  const before = count();
  assert.throws(
    () => migrate(raw),
    (e: Error) =>
      [
        /a pull request event other than a merge: 1 row\n\s*source \d+ \(closed\)/,
        /an extraction run that failed, was capped, or carries a reason: 1 row\n\s*run 2 \(failed\)/,
        /a source processing outcome that failed or was capped: 1 row\n\s*source 1 in run 2 \(capped\)/,
        /an implements link between records: 1 row\n\s*unit 2 implements unit 1/,
        /an unfetched reference \(revision 5 has no table for it\): 1 row\n\s*reference 1 https:\/\/notes\.example\/x/,
        /a retraction span starting before its text: 1 row\n\s*evidence 1 of unit 1/,
      ].every((re) => re.test(e.message)) && /still at revision 4/.test(e.message),
  );
  assert.equal((raw.prepare("pragma user_version").get() as { user_version: number }).user_version, 4);
  assert.deepEqual(count(), before);
});

// Revision 4 counted an edit outside any turn once per send, and let a record hold two live anchors on one place
test("migrating revision 4 removes repeated edit observations and retires repeated live anchors, and says so", () => {
  const raw = create("old.db", REV4);
  fill(raw);
  const run = (sql: string, ...args: (string | number | Buffer | null)[]) => raw.prepare(sql).run(...args);
  for (let i = 0; i < 2; i++)
    run(
      "insert into edit_observation (session_id, turn_id, tool_event_id, path, via, observed_at) values ('s1', null, 'e', 'src/a.ts', 'tool', ?)",
      now,
    );
  const anchor = () =>
    Number(
      (
        raw
          .prepare(
            "insert into unit_anchor (unit_id, path, symbol, role, edit_observation_id, run_id, added_at) values (1, 'src/a.ts', 'open', 'applies_to', 2, 1, ?) returning id",
          )
          .get(now) as { id: number }
      ).id,
    );
  const older = anchor();
  const newer = anchor();
  const said = migrate(raw);
  assert.deepEqual(
    raw
      .prepare("select id from edit_observation")
      .all()
      .map((r) => r.id),
    [1],
  );
  assert.deepEqual(
    raw
      .prepare(
        "select id, edit_observation_id, retired_at is not null as retired, replaced_by from unit_anchor order by id",
      )
      .all()
      .map((r) => [r.id, r.edit_observation_id, r.retired, r.replaced_by]),
    [
      [older, 1, 1, newer],
      [newer, 1, 0, null],
    ],
  );
  assert.match(
    said,
    /an edit observation recorded twice: 1 row\n\s*observation 2 of src\/a\.ts in session s1 → removed; observation 1 stays/,
  );
  assert.match(
    said,
    new RegExp(
      `two live anchors of a record on one place: 1 row\\n\\s*anchor ${older} of unit 1 on src/a\\.ts → retired; anchor ${newer} stays`,
    ),
  );
});

// Revision 4 let a record have several live successors, of any kind. Revision 5 keeps one: an active one first, then the newest
test("migrating revision 4 keeps one live successor of a record and removes links between kinds that cannot replace each other", () => {
  const raw = create("old.db", REV4);
  fill(raw);
  const run = (sql: string, ...args: (string | number | Buffer | null)[]) => raw.prepare(sql).run(...args);
  const made = (key: string, kind: string, ...states: [string | null, string][]) => {
    run(
      "insert into unit (project_id, key, kind, stance, text, extraction, run_id, created_at, content_hash) values (1, ?, ?, ?, ?, 'supported', 1, ?, ?)",
      key,
      kind,
      ["decision", "constraint"].includes(kind) ? "do" : null,
      key,
      now,
      sha256(key),
    );
    const id = Number((raw.prepare("select id from unit where key = ?").get(key) as { id: number }).id);
    for (const [from, to] of states)
      run(
        "insert into unit_state (unit_id, from_state, to_state, at, reason, run_id) values (?, ?, ?, ?, 'r', 1)",
        id,
        from,
        to,
        now,
      );
    return id;
  };
  const supersedes = (from: number, to: number) =>
    run(
      "insert into unit_link (from_unit, to_unit, kind, run_id, added_at) values (?, ?, 'supersedes', 1, ?)",
      from,
      to,
      now,
    );
  // Unit 1 (a decision) has four successors: a withdrawn one, two candidates, and a finding
  const gone = made("gone", "decision", [null, "candidate"], ["candidate", "withdrawn"]);
  const older = made("older", "decision", [null, "candidate"]);
  const newer = made("newer", "constraint", [null, "candidate"]);
  const finding = made("finding", "finding", [null, "candidate"]);
  for (const u of [gone, older, newer, finding]) supersedes(u, 1);
  // A quarantined successor can never become active: it holds no place and keeps its link
  run(
    "insert into unit (project_id, key, kind, stance, text, extraction, extraction_reason, run_id, created_at, content_hash) values (1, 'quarantined', 'decision', 'do', 'q', 'quarantined', 'quote not found', 1, ?, ?)",
    now,
    sha256("quarantined"),
  );
  const quarantined = Number(
    (raw.prepare("select id from unit where key = 'quarantined'").get() as { id: number }).id,
  );
  supersedes(quarantined, 1);
  const said = migrate(raw);
  assert.deepEqual(
    raw
      .prepare("select from_unit from unit_link where to_unit = 1 and kind = 'supersedes' order by from_unit")
      .all()
      .map((r) => r.from_unit),
    [gone, newer, quarantined],
  );
  assert.match(
    said,
    /a supersedes link between records of kinds that cannot replace each other: 1 row\n\s*unit \d+ finding supersedes unit 1 [^\n]* → link removed/,
  );
  assert.match(
    said,
    /a second successor of a record whose first successor is not withdrawn: 1 row\n\s*unit \d+ older supersedes unit 1 [^\n]* → link removed/,
  );
  // The rule holds from here on: the live successor keeps its place
  const another = made("another", "decision", [null, "candidate"]);
  assert.throws(() => supersedes(another, 1), /already has a successor that is not withdrawn/);
});

// Revision 4 kept a decision active on an option's evidence alone. Revision 5 counts only the unit's own, and the migration applies that once
test("migrating revision 4 puts an active unit without its own support back to candidate, and says so", () => {
  const raw = create("old.db", REV4);
  fill(raw);
  const run = (sql: string, ...args: (string | number | Buffer | null)[]) => raw.prepare(sql).run(...args);
  // Unit 1 has evidence of its own and on its option. Retracting its own leaves the option's, which revision 4 accepted
  run(
    "update unit_evidence set retracted_at = ?, retraction_reason = 'wrong', retraction_source_id = 1, retraction_span_start = 0, retraction_span_end = 3 where unit_id = 1 and option_id is null",
    now,
  );
  assert.equal(
    (raw.prepare("select lifecycle from unit where id = 1").get() as { lifecycle: string }).lifecycle,
    "active",
  );
  const said = migrate(raw);
  assert.deepEqual(
    {
      ...raw
        .prepare(
          "select u.lifecycle, s.from_state, s.to_state, s.reason, r.origin from unit u join unit_state s on s.unit_id = u.id join extraction_run r on r.id = s.run_id where u.id = 1 order by s.id desc limit 1",
        )
        .get(),
    },
    {
      lifecycle: "candidate",
      from_state: "active",
      to_state: "candidate",
      reason: "schema revision 5: an active record without the support an active record needs",
      origin: "migration",
    },
  );
  assert.match(
    said,
    /an active record without the support an active record needs: 1 row\n\s*unit 1 trace:session:s1\/k \(active\) → back to candidate/,
  );
  assert.throws(
    () =>
      run(
        "insert into unit_state (unit_id, from_state, to_state, at, reason, run_id) values (1, 'candidate', 'active', ?, 'r', 1)",
        now,
      ),
    /needs unretracted evidence and adoption/,
  );
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
  // A table revision 5 drops takes its counter with it
  const kept = new Set(
    (raw.prepare("select name from sqlite_schema where type = 'table'").all() as { name: string }[]).map(
      (t) => t.name,
    ),
  );
  assert.deepEqual(
    counters(),
    before.filter(([name]) => kept.has(String(name))),
  );
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

// One revision 4 database with rows in every table, a row each repair meets, and counters above the highest ids: after the migration the
// same database takes a trace, a glean, and a capture, and finds by search what it held
test("a populated revision 4 database migrates and keeps working: rows, ids, search, the record server, and capture", async () => {
  const raw = create("old.db", REV4);
  fill(raw);
  const run = (sql: string, ...args: (string | number | Buffer | null)[]) => raw.prepare(sql).run(...args);
  const id = (sql: string) => Number((raw.prepare(sql).get() as { id: number }).id);
  run(
    "insert into owner_identity (provider, external_id, login, bound_at) values ('github', '42', 'hana', ?)",
    now,
  );
  run(
    "insert into artifact_link (project_id, from_artifact, to_artifact, kind) values (1, 'pr:7', 'issue:3', 'closes')",
  );
  run("insert into forget_batch (project_id, at) values (1, ?)", now);
  run(
    "insert into source_forgotten (source_id, project_id, artifact, kind, external_id, revision, content_hash, batch_id) values (99, 1, 'session:s1', 'session_message', 'gone', 1, ?, 1)",
    sha256("gone"),
  );
  run(
    "insert into edit_observation (session_id, turn_id, tool_event_id, path, via, observed_at) values ('s1', 't1', 'e1', 'src/db.ts', 'tool', ?)",
    now,
  );
  run("insert into source_processing (source_id, run_id, outcome) values (1, 1, 'units')");
  run(
    "insert into unit_anchor (unit_id, path, symbol, role, edit_observation_id, run_id, added_at) values (1, 'src/db.ts', 'open', 'applies_to', 1, 1, ?)",
    now,
  );
  run(
    "insert into unit_alias (unit_id, terms, content_hash, run_id, added_at) values (1, '[\"storage\"]', (select content_hash from unit where id = 1), 1, ?)",
    now,
  );
  // A second record with a field value, conflicting with the first
  run(
    "insert into field_def (project_id, name, type, label, description, source_id, span_start, span_end, run_id, added_at) values (1, 'tenant', 'text', 'Tenant', 'Who it affects', 1, 0, 3, 1, ?)",
    now,
  );
  run(
    "insert into unit (project_id, key, kind, text, extraction, run_id, created_at, content_hash) values (1, 'trace:session:s1/k2', 'finding', 'Decided', 'supported', 1, ?, ?)",
    now,
    sha256("Decided"),
  );
  run(
    "insert into unit_field (unit_id, field_def_id, value, source_id, span_start, span_end, run_id, added_at) values (2, 1, 'acme', 1, 0, 3, 1, ?)",
    now,
  );
  run(
    "insert into unit_evidence (unit_id, source_id, span_start, span_end, role, run_id, added_at) values (2, 1, 12, 20, 'states', 1, ?)",
    now,
  );
  run(
    "insert into unit_state (unit_id, from_state, to_state, at, reason, run_id) values (2, null, 'candidate', ?, 'r', 1)",
    now,
  );
  run(
    "insert into unit_link (from_unit, to_unit, kind, run_id, added_at) values (2, 1, 'conflicts', 1, ?)",
    now,
  );
  run(
    "insert into work (project_id, key, title, goal, current, next, status, run_id, updated_at) values (1, 'w', 'Work', 'Goal', 'Now', '[]', 'active', 1, ?)",
    now,
  );
  run(
    "insert into delivery (session_id, event, outcome, eligible, at) values ('s1', 'prompt', 'emitted', 1, ?)",
    now,
  );
  run("insert into delivery_unit (delivery_id, unit_id) values (1, 1)");
  // One row a repair meets: a superseded record whose successor was withdrawn
  run(
    "insert into unit (project_id, key, kind, text, extraction, run_id, created_at, content_hash) values (1, 'trace:session:s1/old', 'finding', 'Older', 'supported', 1, ?, ?)",
    now,
    sha256("Older"),
  );
  const old = id("select id from unit where key = 'trace:session:s1/old'");
  run(
    "insert into unit_state (unit_id, from_state, to_state, at, reason, run_id) values (?, null, 'candidate', ?, 'r', 1)",
    old,
    now,
  );
  run(
    "insert into unit_link (from_unit, to_unit, kind, run_id, added_at) values (2, ?, 'supersedes', 1, ?)",
    old,
    now,
  );
  run(
    "insert into unit_state (unit_id, from_state, to_state, at, reason, run_id) values (?, 'candidate', 'superseded', ?, 'r', 1)",
    old,
    now,
  );
  run(
    "insert into unit_state (unit_id, from_state, to_state, at, reason, run_id) values (2, 'candidate', 'withdrawn', ?, 'r', 1)",
    now,
  );
  // Every table holds a row, and every counter stands above its highest id
  const tables = (
    raw
      .prepare(
        "select name from sqlite_schema where type = 'table' and sql not like 'CREATE VIRTUAL%' and name not glob '*_fts_*' and name not glob 'sqlite_*' and name <> 'external_reference'",
      )
      .all() as { name: string }[]
  ).map((t) => t.name);
  const count = (t: string) =>
    Number((raw.prepare(`select count(*) as n from ${t}`).get() as { n: number }).n);
  assert.deepEqual(
    tables.filter((t) => count(t) === 0),
    [],
    "every table holds a row",
  );
  run("update sqlite_sequence set seq = seq + 5");
  const counters = new Map(
    (raw.prepare("select name, seq from sqlite_sequence").all() as { name: string; seq: number }[]).map(
      (r) => [r.name, r.seq],
    ),
  );
  const before = new Map(tables.map((t) => [t, count(t)]));
  const said = migrate(raw);
  // Only the repair changed anything: the withdrawn successor's record is a candidate again, through a state the migration wrote
  assert.match(said, /a superseded record whose successors are all withdrawn, or that has none: 1 row/);
  const after = new Map(tables.map((t) => [t, count(t)]));
  const grew = [...after].filter(([t, n]) => n !== before.get(t));
  assert.deepEqual(grew, [
    ["extraction_run", (before.get("extraction_run") ?? 0) + 1],
    ["unit_state", (before.get("unit_state") ?? 0) + 1],
  ]);
  for (const [name, seq] of counters)
    if (name !== "external_reference")
      assert.ok(
        Number(
          (raw.prepare("select seq from sqlite_sequence where name = ?").get(name) as { seq: number }).seq,
        ) >= seq,
        name,
      );
  assert.equal(
    Number(
      (raw.prepare("select id from extraction_run where origin = 'migration'").get() as { id: number }).id,
    ),
    (counters.get("extraction_run") ?? 0) + 1,
  );
  // Search finds what the database held
  const hits = (table: string, word: string) =>
    (
      raw.prepare(`select rowid from ${table} where ${table} match ?`).all(`"${word}"`) as { rowid: number }[]
    ).map((r) => Number(r.rowid));
  assert.deepEqual(hits("unit_fts", "acme"), [2]);
  assert.deepEqual(hits("unit_fts", "storage"), [1]);
  assert.deepEqual(hits("source_fts", "sqlite"), [1]);
  // The record server writes into it through its own connection, and so does capture
  const saved = {
    HOME: process.env.HOME,
    SPHICA_DB: process.env.SPHICA_DB,
    SPHICA_HOME: process.env.SPHICA_HOME,
  };
  process.env.HOME = dir;
  process.env.SPHICA_DB = path.join(dir, "none.db");
  delete process.env.SPHICA_HOME;
  const ingest = openWriter("ingest", path.join(dir, "old.db"));
  try {
    const out = await saveText(ingest, await beginTrace(ingest, 1, "s1"), 1, null, {
      units: [
        {
          key: "wal",
          kind: "finding",
          text: "SQLite",
          evidence: [{ source: "s1", quote: "Use SQLite.", role: "states" }],
        },
      ],
    });
    assert.match(out, /wal active/);
    const key = /(\S+\/wal) active/.exec(out)?.[1] ?? "";
    const revision = Number(
      (raw.prepare("select revision from unit where key = ?").get(key) as { revision: number } | undefined)
        ?.revision,
    );
    const glean = await saveText(ingest, await beginGlean(ingest, 1, "s1"), 1, null, {
      ops: [{ op: "withdraw", unit: key, revision, reason_source: "s1", reason_quote: "Decided." }],
    });
    assert.match(glean, new RegExp(`${key.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}: withdrawn`));
    assert.equal(
      (raw.prepare("select lifecycle from unit where key = ?").get(key) as { lifecycle: string }).lifecycle,
      "withdrawn",
    );
  } finally {
    await ingest.destroy();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const capture = connectWriter("capture", path.join(dir, "old.db"));
  open.push(capture);
  const text = "and use WAL";
  capture
    .prepare(
      "insert into capture_message (external_id, session_id, turn_id, speaker, created_at, captured_at, text, truncated, redacted, original_bytes, content_hash) values ('m9', 's1', 't', 'owner', ?, ?, ?, 0, 0, ?, ?)",
    )
    .run(now, now, text, Buffer.byteLength(text), sha256(text));
  assert.deepEqual(hits("source_fts", "wal"), [id("select id from source where external_id = 'm9'")]);
});
