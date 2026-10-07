import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { type Kysely, sql } from "kysely";
import { inRolledBack, inTransaction, openReader, SCHEMA_REVISION } from "../src/db.ts";
import type { DB } from "../src/db-types.ts";
import { connectWriter, INGEST_TRIGGER_WRITES } from "../src/db-write.ts";
import { packageVersionAt, ROOT } from "../src/plugin.ts";
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

// The reader is read-only by type too: a write through it does not compile, so it never reaches the connection that would refuse it
test("a write through the reader's handle is a type error", async () => {
  const r = openReader(db.file);
  try {
    const insert = r.insertInto("project");
    // @ts-expect-error the read-only handle's insertInto is a type error, so the statement cannot be written
    const write = () => insert.values({ key: "git:github.com/o/typed", name: "o/typed" }).execute();
    await assert.rejects(write(), /not authorized|readonly/i);
  } finally {
    await r.destroy();
  }
});

test("the ingest connection can write rows but cannot change the schema", () => {
  assert.equal(
    attempt(ingest, "insert into project (key, name) values ('git:github.com/o/new', 'o/new')"),
    null,
  );
  // A harvest keeps the sources it begins with
  assert.equal(
    attempt(
      ingest,
      "insert into harvest_run_source (run_id, source_id) values (?, (select min(id) from source))",
      run(db, p, "harvest", "pr:1"),
    ),
    null,
  );
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

test("the ingest connection writes a retired anchor's reason but never changes or removes one", () => {
  const r = run(db, p);
  const u = insert(db, "unit", {
    project_id: p,
    key: "retire-reason",
    kind: "finding",
    text: "retire-reason",
    extraction: "supported",
    run_id: r,
    created_at: now,
    content_hash: sha256("retire-reason"),
  });
  const a = insert(db, "unit_anchor", {
    unit_id: u,
    path: "CLAUDE.md",
    role: "applies_to",
    run_id: r,
    added_at: now,
  });
  db.owner.prepare("update unit_anchor set retired_at = ? where id = ?").run(now, a);
  const said = Number(
    (db.owner.prepare("select id from source where external_id = 'm-1'").get() as { id: number }).id,
  );
  assert.equal(
    attempt(
      ingest,
      "insert into unit_anchor_retirement (anchor_id, run_id, source_id, span_start, span_end, added_at) values (?, ?, ?, 0, 3, ?)",
      a,
      r,
      said,
      now,
    ),
    null,
  );
  assert.match(attempt(ingest, "update unit_anchor_retirement set span_end = 6") ?? "", /not authorized/);
  assert.match(attempt(ingest, "delete from unit_anchor_retirement") ?? "", /not authorized/);
});

// The record server reads text anyone wrote. Its connection writes only what its code writes: anything else is refused before it runs
test("the ingest connection is refused every write its code never makes", () => {
  const r = run(db, p);
  db.owner.prepare("update extraction_run set status = 'saved', finished_at = ? where id = ?").run(now, r);
  session(db, p, "s2");
  const refused = [
    ["the full-text index's commands", "insert into unit_fts (unit_fts) values ('delete-all')"],
    ["the full-text index's commands", "insert into source_fts (source_fts) values ('delete-all')"],
    ["a fake full-text row", "insert into source_fts (rowid, lexemes) values (999, 'owner words')"],
    ["removing a full-text row", "delete from unit_fts where rowid = 1"],
    [
      "a session message written directly",
      "insert into source (project_id, kind, artifact, external_id, revision, session_id, author_kind, created_at, captured_at, text, original_bytes, content_hash, indexed) values (1, 'session_message', 'session:s2', 'x', 1, 's2', 'owner', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z', 'forged', 6, zeroblob(32), 1)",
    ],
    ["the schema generation", "delete from sphica_generation"],
    ["a project's key", "update project set key = 'git:github.com/x/y' where id = 1"],
    ["a session", "update session set branch = 'x' where id = 's2'"],
    ["a delivery", "delete from delivery"],
    ["the current work", "delete from work"],
    ["an edit observation", "delete from edit_observation"],
    ["a processing outcome", "delete from source_processing"],
    ["a run", `delete from extraction_run where id = ${r}`],
    ["a unit's revision", "update unit set revision = revision + 1"],
    ["a unit's lifecycle", "update unit set lifecycle = 'active'"],
  ] as const;
  for (const [what, text] of refused) assert.match(attempt(ingest, text) ?? "", /not authorized/, what);
  // The run's status is a column the record server sets: the schema, not the connection, keeps a saved run saved
  assert.match(
    attempt(ingest, `update extraction_run set status = 'running' where id = ${r}`) ?? "",
    /changes once/,
  );
});

// A trigger writes under the connection that fired it. One the ingest connection can fire but whose writes are not listed would fail the
// save that fired it, at run time; this reads every trigger body and compares
test("every trigger an ingest write can fire has its writes listed for the ingest connection", () => {
  const bodies = db.owner
    .prepare(
      "select name, sql from sqlite_schema where type = 'trigger' and name not like 'capture\\_%' escape '\\' order by name",
    )
    .all() as { name: string; sql: string }[];
  assert.ok(bodies.length > 20, `${bodies.length} triggers`);
  const found: Record<string, string[]> = {};
  for (const { name, sql } of bodies) {
    const body = sql.slice(sql.search(/\bbegin\b/i));
    // A way of writing this reader does not know fails here rather than going unlisted
    assert.doesNotMatch(
      body,
      /\breplace\s+into\b|\bon\s+conflict\b[^;]*\bdo\s+update\b|\bupdate\s+or\b|\b(?:into|update|from)\s+["`[]/i,
      name,
    );
    const writes = [
      ...[...body.matchAll(/\binsert\s+(?:or\s+\w+\s+)?into\s+(\w+)/gi)].map((m) => `insert ${m[1]}`),
      ...[...body.matchAll(/\bupdate\s+(\w+)\s+set\b/gi)].map((m) => `update ${m[1]}`),
      ...[...body.matchAll(/\bdelete\s+from\s+(\w+)/gi)].map((m) => `delete ${m[1]}`),
    ];
    if (writes.length) found[name] = [...new Set(writes)].sort();
  }
  const listed = Object.fromEntries(
    Object.entries(INGEST_TRIGGER_WRITES).map(([k, v]) => [k, [...v].sort()]),
  );
  assert.deepEqual(listed, found);
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
      // A raw statement needs kysely's executor, which the read-only type does not show; the connection itself still only reads
    }>`select count(*) as n from source_fts where source_fts match '"自動"'`.execute(
      r as unknown as Kysely<DB>,
    );
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

test("the capture connection logs a delivery with the subagent it ran in through the scoped view", () => {
  const raw = capture();
  try {
    raw
      .prepare(
        "insert into capture_session (id, project_id, host, external_id, branch, started_at) values ('ds', ?, 'claude-code', 'ds', null, ?)",
      )
      .run(p, now);
    for (const agent of [null, "agent-a"])
      raw
        .prepare(
          "insert into capture_delivery_scoped (session_id, agent_id, event, outcome, at, units) values ('ds', ?, 'pre_read', 'emitted', ?, '[]')",
        )
        .run(agent, now);
  } finally {
    raw.close();
  }
  assert.deepEqual(
    db.owner
      .prepare("select agent_id from delivery where session_id = 'ds' order by id")
      .all()
      .map((r) => ({ ...r })),
    [{ agent_id: null }, { agent_id: "agent-a" }],
  );
  assert.match(
    attempt(
      capture,
      "insert into delivery (session_id, agent_id, event, outcome, at) values ('ds', 'agent-a', 'pre_read', 'emitted', '2026-09-12T00:00:00.000Z')",
    ) ?? "",
    /not authorized/,
    "the table itself stays closed",
  );
});

test("the capture connection prunes old deliveries and their units only through the prune view", () => {
  const raw = capture();
  const old = "2026-01-01T00:00:00.000Z";
  try {
    raw
      .prepare(
        "insert into capture_session (id, project_id, host, external_id, branch, started_at) values ('dp', ?, 'claude-code', 'dp', null, ?)",
      )
      .run(p, now);
    raw
      .prepare(
        "insert into capture_delivery_scoped (session_id, agent_id, event, outcome, at, units) values ('dp', null, 'pre_read', 'emitted', ?, '[]')",
      )
      .run(old);
    const id = Number(
      db.owner.prepare("select max(id) as id from delivery where session_id = 'dp'").get()?.id,
    );
    const u = insert(db, "unit", {
      project_id: p,
      key: "trace:session:dp/pruned",
      kind: "finding",
      text: "pruned",
      extraction: "supported",
      run_id: run(db, p),
      created_at: now,
      content_hash: sha256("pruned"),
    });
    db.owner.prepare("insert into delivery_unit (delivery_id, unit_id) values (?, ?)").run(id, u);
    for (const [what, text] of [
      ["a delivery", "delete from delivery"],
      ["a delivery's units", "delete from delivery_unit"],
    ] as const)
      assert.match(attempt(capture, text) ?? "", /not authorized/, what);
    raw.prepare("insert into capture_delivery_prune (cutoff) values (?)").run(now);
  } finally {
    raw.close();
  }
  assert.equal(db.owner.prepare("select count(*) as n from delivery where session_id = 'dp'").get()?.n, 0);
  assert.equal(
    db.owner
      .prepare(
        "select count(*) as n from delivery_unit x left join delivery d on d.id = x.delivery_id where d.id is null",
      )
      .get()?.n,
    0,
  );
});

// Pruning must not change what logging a delivery needs: the delivery views delete nothing, so a capture refused the pruning deletes
// (the authorizer before revision 7) still logs a delivery with its units through both
test("an older capture, which may delete nothing, still logs deliveries with their units through both views", () => {
  const older = () => {
    const set = DatabaseSync.prototype.setAuthorizer;
    DatabaseSync.prototype.setAuthorizer = function (this: DatabaseSync, cb: Parameters<typeof set>[0]) {
      return set.call(this, (action, p1, ...rest) =>
        action === constants.SQLITE_DELETE && (p1 === "delivery" || p1 === "delivery_unit")
          ? constants.SQLITE_DENY
          : (cb as NonNullable<typeof cb>)(action, p1, ...rest),
      );
    } as typeof set;
    try {
      return capture();
    } finally {
      DatabaseSync.prototype.setAuthorizer = set;
    }
  };
  const u = insert(db, "unit", {
    project_id: p,
    key: "trace:session:do/older",
    kind: "finding",
    text: "older",
    extraction: "supported",
    run_id: run(db, p),
    created_at: now,
    content_hash: sha256("older"),
  });
  const raw = older();
  try {
    raw
      .prepare(
        "insert into capture_session (id, project_id, host, external_id, branch, started_at) values ('do', ?, 'claude-code', 'do', null, ?)",
      )
      .run(p, now);
    raw
      .prepare(
        "insert into capture_delivery (session_id, event, outcome, at, units) values ('do', 'pre_read', 'emitted', ?, ?)",
      )
      .run(now, `[${u}]`);
    raw
      .prepare(
        "insert into capture_delivery_scoped (session_id, agent_id, event, outcome, at, units) values ('do', 'agent-a', 'pre_read', 'emitted', ?, ?)",
      )
      .run(now, `[${u}]`);
  } finally {
    raw.close();
  }
  assert.match(
    attempt(older, "insert into capture_delivery_prune (cutoff) values ('2026-01-01T00:00:00.000Z')") ?? "",
    /not authorized/,
    "the wrapper refuses what an older capture could not do",
  );
  assert.deepEqual(
    db.owner
      .prepare(
        "select d.agent_id, x.unit_id from delivery d join delivery_unit x on x.delivery_id = d.id where d.session_id = 'do' order by d.id",
      )
      .all()
      .map((r) => ({ ...r })),
    [
      { agent_id: null, unit_id: u },
      { agent_id: "agent-a", unit_id: u },
    ],
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
  const harvest = run(db, p, "harvest", "pr:1");
  db.owner.prepare("insert into harvest_run_source (run_id, source_id) values (?, ?)").run(harvest, src);
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
  assert.equal(
    db.owner.prepare("select count(*) as n from harvest_run_source where run_id = ?").get(harvest)?.n,
    0,
  );
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
    new RegExp(
      `Run \`npm i -g sphica@${packageVersionAt(ROOT)?.replaceAll(".", "\\.")}\`, then \`sphica init\` to migrate it`,
    ),
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

test("the record server logs record tool calls, and only the hook's capture view writes an observation", () => {
  assert.equal(
    attempt(
      ingest,
      "insert into record_call (project_id, tool, host, caller_session, mode, called_at) values (?, 'trace_begin', 'codex', 'cx', 'interactive', ?)",
      p,
      now,
    ),
    null,
  );
  assert.match(attempt(ingest, "update record_call set mode = 'headless'") ?? "", /not authorized/);
  assert.match(
    attempt(
      ingest,
      "insert into tool_call_observation (host, session_external, tool_use_id, tool_name, owner_turn, observed_at) values ('claude-code', 's', 'toolu_1', 't', 1, ?)",
      now,
    ) ?? "",
    /not authorized/,
  );
  const observe =
    "insert into capture_tool_call (host, session_external, turn_id, tool_use_id, tool_name, owner_turn, observed_at) values ('claude-code', 's', 't1', 'toolu_1', 'mcp__plugin_sphica_record__trace_begin', 1, ?)";
  assert.equal(attempt(capture, observe, now), null);
  assert.match(
    attempt(
      capture,
      "insert into tool_call_observation (host, session_external, tool_use_id, tool_name, owner_turn, observed_at) values ('claude-code', 's', 'toolu_2', 't', 1, ?)",
      now,
    ) ?? "",
    /not authorized/,
  );
  assert.match(
    attempt(
      capture,
      "insert into record_call (project_id, tool, mode, called_at) values (?, 't', 'unknown', ?)",
      p,
      now,
    ) ?? "",
    /not authorized/,
  );
});

// A replacement row is history: a save or a forget starts one and later ends it, and nothing rewrites what started it
test("ingest and forget can start a replacement and set only its end columns", () => {
  const r = run(db, p);
  const finding = (key: string) =>
    insert(db, "unit", {
      project_id: p,
      key: `trace:session:s1/${key}`,
      kind: "finding",
      text: key,
      extraction: "supported",
      run_id: r,
      created_at: now,
      content_hash: sha256(key),
    });
  const old = finding("replaced");
  const next = finding("replacing");
  // A successor takes effect only with its support
  const said = message(db, p, { id: "m-replacing", text: "Replacing it." });
  insert(db, "unit_evidence", {
    unit_id: next,
    source_id: said,
    span_start: 0,
    span_end: 9,
    role: "states",
    run_id: r,
    added_at: now,
  });
  insert(db, "unit_link", { from_unit: next, to_unit: old, kind: "supersedes", run_id: r, added_at: now });
  const batch = insert(db, "forget_batch", { project_id: p, at: now });
  const open = (by: string) =>
    `insert into unit_replacement (from_unit, to_unit, ${by}, started_at) values (${next}, ${old}, ?, '${now}')`;
  const row = `where to_unit = ${old} and ended_at is null`;
  const refusedOn = (connect: () => DatabaseSync, writes: string[]) => {
    for (const write of writes) assert.match(attempt(connect, write) ?? "", /not authorized/, write);
  };
  const others = [
    `update unit_replacement set started_at = '${now}' ${row}`,
    `update unit_replacement set from_unit = ${old} ${row}`,
    `update unit_replacement set to_unit = ${next} ${row}`,
    `delete from unit_replacement where to_unit = ${old}`,
  ];

  assert.equal(attempt(ingest, open("run_id"), r), null);
  refusedOn(ingest, [
    ...others,
    `update unit_replacement set run_id = ${r} ${row}`,
    `update unit_replacement set end_forget_id = ${batch} ${row}`,
  ]);
  assert.equal(
    attempt(
      ingest,
      `update unit_replacement set ended_at = ?, end_reason = 'r', end_run_id = ? ${row}`,
      now,
      r,
    ),
    null,
  );

  assert.equal(attempt(forget, open("forget_id"), batch), null);
  refusedOn(forget, [
    ...others,
    `update unit_replacement set forget_id = ${batch} ${row}`,
    `update unit_replacement set end_run_id = ${r} ${row}`,
  ]);
  assert.equal(
    attempt(
      forget,
      `update unit_replacement set ended_at = ?, end_reason = 'r', end_forget_id = ? ${row}`,
      now,
      batch,
    ),
    null,
  );
  assert.deepEqual(
    db.owner
      .prepare(
        "select run_id is not null as by_run, end_run_id is not null as end_run, forget_id is not null as by_forget, end_forget_id is not null as end_forget from unit_replacement where to_unit = ? order by id",
      )
      .all(old)
      .map((x) => ({ ...x })),
    [
      { by_run: 1, end_run: 1, by_forget: 0, end_forget: 0 },
      { by_run: 0, end_run: 0, by_forget: 1, end_forget: 1 },
    ],
  );
});

// Filtered here: the reader may not call like
const projectKeys = async (q: Pick<Kysely<DB>, "selectFrom">) =>
  (await q.selectFrom("project").select("key").orderBy("key").execute())
    .map((r) => r.key)
    .filter((k) => k.startsWith("local:preview"));

test("a rolled-back transaction shows its writes to fn, commits none, and frees the connection", async () => {
  const seen = await inRolledBack(db.ingest, async (trx) => {
    await trx.insertInto("project").values({ key: "local:preview-1", name: "p" }).execute();
    return projectKeys(trx);
  });
  assert.deepEqual(seen, ["local:preview-1"]);
  assert.deepEqual(await projectKeys(db.ingest), []);
  await assert.rejects(
    inRolledBack(db.ingest, async (trx) => {
      await trx.insertInto("project").values({ key: "local:preview-2", name: "p" }).execute();
      throw new Error("refused inside");
    }),
    /refused inside/,
  );
  assert.deepEqual(await projectKeys(db.ingest), []);
  // The connection is free again: a committing transaction runs on it
  await inTransaction(db.ingest, (trx) =>
    trx.insertInto("project").values({ key: "local:preview-3", name: "p" }).execute(),
  );
  assert.deepEqual(await projectKeys(db.ingest), ["local:preview-3"]);
  db.owner.prepare("delete from project where key like 'local:preview%'").run();
});

test("a rolled-back transaction whose rollback fails after fn succeeded throws instead of returning", async () => {
  await assert.rejects(
    inRolledBack(db.ingest, async (trx) => {
      await trx.insertInto("project").values({ key: "local:preview-4", name: "p" }).execute();
      // Ending the transaction inside fn leaves nothing to roll back, and the write stays
      await sql`commit`.execute(trx);
      return "preview";
    }),
    /no transaction is active/,
  );
  assert.deepEqual(await projectKeys(db.ingest), ["local:preview-4"]);
  db.owner.prepare("delete from project where key like 'local:preview%'").run();
});

test("rolled-back and committing transactions on one connection run one after another, and other connections see only commits", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  let entered: () => void = () => {};
  const inside = new Promise<void>((r) => {
    entered = r;
  });
  const order: string[] = [];
  const preview = inRolledBack(db.ingest, async (trx) => {
    await trx.insertInto("project").values({ key: "local:preview-5", name: "p" }).execute();
    entered();
    await held;
    order.push("preview");
  });
  await inside;
  const save = inTransaction(db.ingest, async (trx) => {
    order.push("save");
    await trx.insertInto("project").values({ key: "local:preview-6", name: "p" }).execute();
  });
  const second = inRolledBack(db.ingest, async () => {
    order.push("second preview");
  });
  // While the preview holds its write, the reader sees only what was committed
  assert.deepEqual(await projectKeys(db.reader), []);
  release();
  await Promise.all([preview, save, second]);
  assert.deepEqual(order, ["preview", "save", "second preview"]);
  assert.deepEqual(await projectKeys(db.reader), ["local:preview-6"]);
  db.owner.prepare("delete from project where key like 'local:preview%'").run();
});
