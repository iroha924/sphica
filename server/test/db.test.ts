import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { sql } from "kysely";
import { openReader, SCHEMA_REVISION } from "../src/db.ts";
import { connectWriter } from "../src/db-write.ts";
import { connectReader } from "../src/sqlite.ts";
import { sha256 } from "../src/text.ts";
import { at, hash, insert, message, project, run, session, type TempDb, tempDb } from "./temp-db.ts";

let db: TempDb;
let p: number;
before(() => {
  db = tempDb();
  p = project(db);
  message(db, p, { id: "m-1", text: "持ち主の秘密の本文" });
});
after(() => db.done());

/** Opens a connection, runs one SQL statement, and returns the failure message (null on success). */
function attempt(
  open: () => DatabaseSync,
  text: string,
  ...args: (string | number | Buffer | null)[]
): string | null {
  const raw = open();
  try {
    raw.prepare(text).run(...args);
    return null;
  } catch (e) {
    return (e as Error).message;
  } finally {
    raw.close();
  }
}

const reader = () => connectReader(db.file);
const ingest = () => connectWriter("ingest", db.file);
const capture = () => connectWriter("capture", db.file);
const now = at("2026-09-12T00:00:00Z");

// Writing with mismatched versions silently shifts column meanings. The code and schema versions must be equal.
test("the schema revision the code expects equals user_version in db/schema.sql", () => {
  const text = fs.readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8");
  assert.equal(Number(text.match(/pragma user_version = (\d+);/)?.[1]), SCHEMA_REVISION);
});

test("a database of an older generation, a newer revision, or no schema is refused and left unchanged", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-old-"));
  const old = path.join(dir, "old.db");
  const raw = new DatabaseSync(old);
  raw.exec("create table project (id integer primary key); pragma user_version = 7");
  raw.close();
  const before = fs.readFileSync(old);
  for (const open of [
    () => connectReader(old),
    () => connectWriter("ingest", old),
    () => connectWriter("capture", old),
  ])
    assert.throws(open, /Sphica 0.4 or earlier.*Move it aside/);
  assert.deepEqual(fs.readFileSync(old), before, "the old database is not changed");
  const newer = path.join(dir, "newer.db");
  const n = new DatabaseSync(newer);
  n.exec(
    `create table sphica_generation (generation integer); insert into sphica_generation values (2); pragma user_version = ${SCHEMA_REVISION + 1}`,
  );
  n.close();
  assert.throws(() => connectReader(newer), /Update sphica/);
  const empty = path.join(dir, "empty.db");
  new DatabaseSync(empty).close();
  assert.throws(() => connectReader(empty), /sphica init/);
});

// An empty file would look like zero records. Only `sphica init` creates the database.
test("a missing database is not created, and it stops", () => {
  const missing = path.join(os.tmpdir(), `sphica-missing-${process.pid}.db`);
  assert.throws(() => connectReader(missing), /sphica init/);
  assert.throws(() => connectWriter("capture", missing), /sphica init/);
  assert.equal(fs.existsSync(missing), false);
});

test("the MCP and search connection can read but not write", async () => {
  const r = openReader(db.file);
  try {
    assert.equal((await r.selectFrom("source").select("text").execute())[0]?.text, "持ち主の秘密の本文");
  } finally {
    await r.destroy();
  }
  assert.match(attempt(reader, "delete from source") ?? "", /readonly|not authorized/);
  assert.match(attempt(reader, "create table x (a)") ?? "", /readonly|not authorized/);
  assert.match(attempt(reader, "attach database ':memory:' as x") ?? "", /not authorized/);
  assert.match(attempt(reader, "select load_extension('x')") ?? "", /not authorized/);
});

test("the ingest connection can write rows but cannot change the schema", () => {
  assert.equal(attempt(ingest, "update project set name = 'o/r2' where id = ?", p), null);
  for (const ddl of [
    "create table x (a)",
    "drop table unit_anchor",
    "alter table project add column x text",
    "create index x on project (name)",
    "attach database ':memory:' as x",
    "create virtual table x using fts5(a)",
    "pragma user_version = 99",
    "pragma foreign_keys = off",
  ])
    assert.match(attempt(ingest, ddl) ?? "", /not authorized/, ddl);
});

// The record server holds an ingest connection; if it could bind an identity, text it reads could make itself the owner's words.
test("the ingest connection cannot bind, change, or remove an owner identity", () => {
  db.owner
    .prepare(
      "insert into owner_identity (provider, external_id, login, bound_at) values ('github', '5', 'me', ?)",
    )
    .run(now);
  try {
    for (const write of [
      "insert into owner_identity (provider, external_id, login, bound_at) values ('github', '6', 'x', ?)",
      "update owner_identity set external_id = '6' where external_id = '5' and bound_at <> ?",
      "delete from owner_identity where bound_at <> ?",
    ])
      assert.match(attempt(ingest, write, now) ?? "", /not authorized/, write);
    assert.deepEqual(
      db.owner
        .prepare("select external_id from owner_identity")
        .all()
        .map((r) => r.external_id),
      ["5"],
    );
  } finally {
    db.owner.exec("delete from owner_identity");
  }
});

// The capture connection cannot read or modify existing rows, even if a recorded conversation tries to steer it.
test("the capture connection writes only through its views, and FTS is filled by the same statement", async () => {
  assert.equal(
    attempt(
      capture,
      "insert into capture_session (id, project_id, host, external_id, branch, started_at) values ('cap', ?, 'codex', 'cap', null, ?)",
      p,
      now,
    ),
    null,
  );
  const text = "自動記録で入れた発言";
  assert.equal(
    attempt(
      capture,
      `insert into capture_message (external_id, session_id, turn_id, speaker, created_at, captured_at, text, truncated, redacted,
         original_bytes, content_hash) values ('e', 'cap', 't', 'owner', ?, ?, ?, 0, 0, ?, ?)`,
      now,
      now,
      text,
      Buffer.byteLength(text),
      sha256(text),
    ),
    null,
  );
  assert.equal(
    attempt(
      capture,
      "insert into capture_edit (session_id, turn_id, tool_event_id, path, via, observed_at) values ('cap', 't', 'x', 'a.ts', 'tool', ?)",
      now,
    ),
    null,
  );
  // Edits of a session that is not in this database are dropped
  assert.equal(
    attempt(
      capture,
      "insert into capture_edit (session_id, turn_id, tool_event_id, path, via, observed_at) values ('無い', 't', 'x', 'a.ts', 'tool', ?)",
      now,
    ),
    null,
  );
  const r = openReader(db.file);
  try {
    const hit = await sql<{
      n: number;
    }>`select count(*) as n from source_fts where source_fts match '"自動"'`.execute(r);
    assert.equal(hit.rows[0]?.n, 1, "stored in FTS");
    assert.equal(
      (await r.selectFrom("edit_observation").selectAll().where("session_id", "=", "無い").execute()).length,
      0,
    );
  } finally {
    await r.destroy();
  }
});

// The delivery hooks log what they sent through capture; the view's trigger uses functions capture may not call itself
test("the capture connection logs a delivery with its units through the view", () => {
  const raw = capture();
  try {
    raw
      .prepare(
        "insert into capture_session (id, project_id, host, external_id, branch, started_at) values ('dl', ?, 'claude-code', 'dl', null, ?)",
      )
      .run(p, now);
    raw
      .prepare(
        "insert into capture_delivery (session_id, event, outcome, at, units) values ('dl', 'session_start', 'nothing', ?, '[]')",
      )
      .run(now);
  } finally {
    raw.close();
  }
  assert.equal(db.owner.prepare("select count(*) as n from delivery where session_id = 'dl'").get()?.n, 1);
  assert.match(
    attempt(capture, "select coalesce(1, 2)") ?? "",
    /not authorized/,
    "outside the trigger the functions stay denied",
  );
});

test("the capture connection cannot touch base tables, units, other sources, or FTS, and cannot read text", () => {
  session(db, p, "s-other");
  const runId = run(db, p);
  const denied: [string, ...(string | number | Buffer | null)[]][] = [
    [
      "insert into source (project_id, kind, artifact, external_id, revision, session_id, author_kind, created_at, captured_at, text, original_bytes, content_hash, indexed) values (?, 'session_message', 'x', 'x', 1, 's-other', 'owner', ?, ?, 'b', 1, ?, 1)",
      p,
      now,
      now,
      hash(),
    ],
    ["update source set text = 'x'"],
    ["delete from source"],
    [
      "insert into unit (project_id, key, kind, text, extraction, run_id, created_at, content_hash) values (?, 'k', 'finding', 'b', 'supported', ?, ?, ?)",
      p,
      runId,
      now,
      hash(),
    ],
    [
      "insert into unit_adoption (unit_id, route, source_id, span_start, span_end, run_id, added_at) values (1, 'owner_statement', 1, 0, 1, 1, '2026-09-12T00:00:00.000Z')",
    ],
    ["select text from source"],
    ["select text from unit"],
    ["select lexemes from source_fts"],
    // FTS internal tables hold index terms as is. Reads by FTS5 itself are allowed; reads from statements this connection builds are denied
    ["select id, block from source_fts_data"],
    ["select id, block from unit_fts_data"],
    ["select * from source_fts_idx"],
    ["delete from source_fts"],
    ["insert into source_fts (rowid, lexemes) values (999, 'x')"],
    ["attach database ':memory:' as x"],
    ["create virtual table x using fts5(a)"],
    ["pragma foreign_keys = off"],
  ];
  for (const [text, ...args] of denied)
    assert.match(attempt(capture, text, ...args) ?? "", /not authorized|prohibited/, text);
  // The view derives the author from the speaker and refuses anyone else
  assert.match(
    attempt(
      capture,
      "insert into capture_message (external_id, session_id, turn_id, speaker, created_at, captured_at, text, truncated, redacted, original_bytes, content_hash) values ('p', 's-other', 't', 'person', ?, ?, 'x', 0, 0, 1, ?)",
      now,
      now,
      hash(),
    ) ?? "",
    /owner or assistant/,
  );
  // Only Claude Code and Codex sessions can be created (the host CHECK rejects anything else)
  assert.match(
    attempt(
      capture,
      "insert into capture_session (id, project_id, host, external_id, started_at) values ('gh', ?, 'github', 'o/r#1', ?)",
      p,
      now,
    ) ?? "",
    /CHECK constraint failed/,
  );
});

// The ingest and owner authorizers cannot tell writes to FTS5 shadow tables from FTS5's own writes. defensive mode stops them.
test("no write connection can modify FTS internal tables directly", () => {
  for (const open of [ingest, capture, () => connectWriter("owner", db.file)])
    for (const text of [
      "insert into source_fts_docsize (id, sz) values (999, x'00')",
      "delete from unit_fts_data",
      "update source_fts_config set v = 0",
    ])
      assert.match(attempt(open, text) ?? "", /may not be modified|not authorized/, text);
});

// A connection without the registration (such as the sqlite3 CLI) would silently leave rows missing from the index.
test("a connection without the tokenizer function cannot write sources or units", () => {
  const raw = new DatabaseSync(db.file);
  try {
    raw.exec("pragma foreign_keys = on");
    assert.throws(
      () => message({ ...db, owner: raw }, p, { id: "nofn", text: "b" }),
      /no such function: sphica_terms/,
    );
    const runId = insert({ ...db, owner: raw }, "extraction_run", {
      project_id: p,
      origin: "trace",
      target: "x",
      status: "running",
      started_at: now,
    });
    assert.throws(
      () =>
        insert({ ...db, owner: raw }, "unit", {
          project_id: p,
          key: "nofn",
          kind: "finding",
          text: "b",
          extraction: "supported",
          run_id: runId,
          created_at: now,
          content_hash: hash(),
        }),
      /no such function: sphica_terms/,
    );
  } finally {
    raw.close();
  }
});

const forget = () => connectWriter("forget", db.file);

// The record server's extraction tools hold ingest. Only forget may remove sources or write what was removed.
test("the ingest connection cannot remove a source or write a forget batch or tombstone", () => {
  const id = message(db, p, { id: "m-ingest", text: "kept by ingest" });
  for (const write of [
    "delete from source where id = ?",
    "insert into forget_batch (project_id, at) values (?, '2026-09-12T00:00:00.000Z')",
    "insert into source_forgotten (source_id, project_id, artifact, kind, external_id, revision, content_hash, batch_id) values (?, 1, 'a', 'k', 'e', 1, zeroblob(32), 1)",
  ])
    assert.match(
      attempt(ingest, write, write.startsWith("insert into forget") ? p : id) ?? "",
      /not authorized/,
      write,
    );
  assert.equal(db.owner.prepare("select count(*) as n from source where id = ?").get(id)?.n, 1);
});

test("the forget connection removes a source with what cites it, and cannot write anything else", () => {
  const src = message(db, p, { id: "m-forget", text: "a secret to forget" });
  const r = run(db, p);
  const u = insert(db, "unit", {
    project_id: p,
    key: "trace:session:s1/forget",
    kind: "finding",
    text: "found",
    extraction: "supported",
    run_id: r,
    created_at: now,
    content_hash: sha256("found"),
  });
  insert(db, "unit_evidence", {
    unit_id: u,
    source_id: src,
    span_start: 0,
    span_end: 1,
    role: "states",
    run_id: r,
    added_at: now,
  });
  db.owner
    .prepare(
      "insert into unit_state (unit_id, from_state, to_state, at, reason, run_id) values (?, null, 'candidate', ?, 'r', ?)",
    )
    .run(u, now, r);
  db.owner
    .prepare(
      "insert into unit_state (unit_id, from_state, to_state, at, reason, source_id, run_id) values (?, 'candidate', 'active', ?, 'r', ?, ?)",
    )
    .run(u, now, src, r);
  const raw = forget();
  try {
    raw.exec("pragma secure_delete = on");
    raw.exec("begin immediate");
    const batch = Number(
      raw.prepare("insert into forget_batch (project_id, at) values (?, ?) returning id").get(p, now)?.id,
    );
    raw
      .prepare(
        "insert into source_forgotten (source_id, project_id, artifact, kind, external_id, revision, content_hash, batch_id) select id, project_id, artifact, kind, external_id, revision, content_hash, ? from source where id = ?",
      )
      .run(batch, src);
    raw.prepare("delete from source where id = ?").run(src);
    raw
      .prepare(
        "insert into unit_state (unit_id, from_state, to_state, at, reason, forget_id) values (?, 'active', 'candidate', ?, 'forgotten', ?)",
      )
      .run(u, now, batch);
    raw.exec("commit");
    raw.exec("insert into source_fts (source_fts) values ('optimize')");
    raw.prepare("pragma wal_checkpoint(TRUNCATE)").get();
  } finally {
    raw.close();
  }
  assert.equal(db.owner.prepare("select lifecycle from unit where id = ?").get(u)?.lifecycle, "candidate");
  assert.equal(db.owner.prepare("select count(*) as n from unit_evidence where unit_id = ?").get(u)?.n, 0);
  for (const write of [
    "insert into source (project_id, kind, artifact, external_id, revision, author_kind, created_at, captured_at, text, original_bytes, content_hash, indexed) values (1, 'pr_body', 'pr:1', 'x', 1, 'person', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z', 'x', 1, zeroblob(32), 0)",
    "delete from unit",
    "update project set name = 'x'",
    "insert into owner_identity (provider, external_id, bound_at) values ('github', '9', '2026-09-12T00:00:00.000Z')",
    "delete from session",
    "create table x (a)",
    "pragma foreign_keys = off",
    "pragma user_version = 9",
  ])
    assert.match(attempt(forget, write) ?? "", /not authorized/, write);
});

test("the forget connection refuses a database of an older revision", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-forget-"));
  const file = path.join(dir, "old.db");
  const raw = new DatabaseSync(file);
  raw.exec(
    `create table sphica_generation (generation integer); insert into sphica_generation values (2); pragma user_version = ${SCHEMA_REVISION - 1}`,
  );
  raw.close();
  assert.throws(
    () => connectWriter("forget", file),
    /Update the sphica CLI .*then run `sphica init` to migrate it/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// The record server's code never deletes evidence or adoption, so ingest cannot use the forget exception in the no-delete triggers
test("the ingest connection cannot delete evidence or adoption, even a retracted row whose reason was forgotten", () => {
  for (const write of ["delete from unit_evidence where id = -1", "delete from unit_adoption where id = -1"])
    assert.match(attempt(ingest, write) ?? "", /not authorized/, write);
});

test("the forget connection keeps secure_delete on and changes only the unit and state columns the forget writes", () => {
  for (const write of [
    "pragma secure_delete = off",
    "pragma secure_delete = 0",
    "update unit set no_code_surface = 'changed' where id = -1",
    "update unit set text = 'changed' where id = -1",
    "update unit_state set reason = 'changed' where id = -1",
  ])
    assert.match(attempt(forget, write) ?? "", /not authorized/, write);
  for (const allowed of [
    "pragma secure_delete = on",
    "update unit set revision = revision + 1 where id = -1",
  ])
    assert.equal(attempt(forget, allowed), null, allowed);
});
