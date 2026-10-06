// The real SQLite database tests use. Created in a temp directory with db/schema.sql applied. **Never touches ~/.sphica.**
// Role connections (reader, ingest, capture) open through the production factory, so the authorizer works as in production.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Kysely } from "kysely";
import type { ReadonlyKysely } from "kysely/readonly";
import { openReader } from "../src/db.ts";
import type { DB } from "../src/db-types.ts";
import { connectWriter, openWriter } from "../src/db-write.ts";

const SCHEMA = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "db", "schema.sql"), "utf8");

export type TempDb = {
  file: string;
  reader: ReadonlyKysely<DB>;
  ingest: Kysely<DB>;
  capture: Kysely<DB>;
  /** A connection without the authorizer, for inserting fixtures and checking from outside the permissions */
  owner: DatabaseSync;
  done: () => Promise<void>;
};

/** schema: the definitions to apply, the current db/schema.sql unless a test needs an earlier revision's */
export function tempDb(schema = SCHEMA): TempDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-db-"));
  const file = path.join(dir, "sphica.db");
  const owner = connectWriter("owner", file, true);
  owner.exec("pragma journal_mode = wal");
  owner.exec(schema);
  const reader = openReader(file);
  const ingest = openWriter("ingest", file);
  const capture = openWriter("capture", file);
  return {
    file,
    reader,
    ingest,
    capture,
    owner,
    done: async () => {
      await Promise.all([reader.destroy(), ingest.destroy(), capture.destroy()]);
      owner.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Runs fn and returns every SQL statement prepared meanwhile, on any connection of this process: what the code really asks the database. */
export async function statements(fn: () => unknown): Promise<string[]> {
  const prepare = DatabaseSync.prototype.prepare;
  const seen: string[] = [];
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, ...args: Parameters<typeof prepare>) {
    seen.push(String(args[0]));
    return prepare.apply(this, args);
  };
  try {
    await fn();
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
  return seen;
}

/** How SQLite would run a statement, on one line. Its parameters are left unbound: the plan depends on the statement, not the values. */
export const plan = (db: TempDb, sql: string): string =>
  db.owner
    .prepare(`explain query plan ${sql}`)
    .all()
    .map((r) => String(r.detail))
    .join(" | ");

/** Fixture time in the form the schema CHECK requires (ISO 8601 UTC with milliseconds). */
export const at = (s: string): string => new Date(s).toISOString();

/** Fixture hash (32 bytes). */
export const hash = (n = 0): Buffer => Buffer.alloc(32, n);

/** Inserts one project and returns its id. */
export function project(db: TempDb, key = "git:github.com/o/r", name = "o/r"): number {
  return Number(
    db.owner.prepare("insert into project (key, name) values (?, ?) returning id").get(key, name)?.id,
  );
}

/**
 * Every row of every table, sorted, with the sequence counters and the full-text indexes' storage tables: what a rolled-back transaction must
 * leave as it found it. Virtual tables are read through their storage tables, and rows are compared whole, so no table needs a rowid.
 */
export function dump(db: TempDb): Record<string, string[]> {
  const tables = db.owner
    .prepare(
      "select name from sqlite_schema where type = 'table' and sql not like 'CREATE VIRTUAL%' order by name",
    )
    .all() as { name: string }[];
  const text = (_: string, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v;
  return Object.fromEntries(
    tables.map(({ name }) => {
      // FTS storage holds integers past 2^53
      const all = db.owner.prepare(`select * from "${name}"`);
      all.setReadBigInts(true);
      return [
        name,
        all
          .all()
          .map((r) => JSON.stringify(r, text))
          .sort(),
      ];
    }),
  );
}

type Values = Record<string, string | number | Buffer | null>;

/** Inserts one row and returns its rowid. **Writes with the owner connection** (it has the tokenizer function, so FTS triggers run as in production). */
export function insert(db: TempDb, table: string, v: Values): number {
  const cols = Object.keys(v);
  const r = db.owner
    .prepare(
      `insert into ${table} (${cols.join(", ")}) values (${cols.map(() => "?").join(", ")}) returning rowid as rowid`,
    )
    .get(...Object.values(v));
  return Number(r?.rowid);
}

/** Inserts one coding session (id as given) and returns its id. */
export function session(db: TempDb, projectId: number, id = "s1", host = "claude-code"): string {
  db.owner
    .prepare(
      "insert into session (id, project_id, host, external_id, started_at) values (?, ?, ?, ?, ?) on conflict do nothing",
    )
    .run(id, projectId, host, `ext-${id}`, at("2026-09-01T00:00:00Z"));
  return id;
}

/** Inserts one session message as a source and returns its id. */
export function message(
  db: TempDb,
  projectId: number,
  v: { id: string; text: string; speaker?: "owner" | "assistant"; sent?: string; session?: string },
): number {
  const s = session(db, projectId, v.session ?? "s1");
  const speaker = v.speaker ?? "owner";
  return insert(db, "source", {
    project_id: projectId,
    kind: "session_message",
    artifact: `session:${s}`,
    external_id: v.id,
    revision: 1,
    session_id: s,
    author_kind: speaker,
    created_at: at(v.sent ?? "2026-09-10T00:00:00Z"),
    available_at: at(v.sent ?? "2026-09-10T00:00:00Z"),
    captured_at: at(v.sent ?? "2026-09-10T00:00:00Z"),
    text: v.text,
    original_bytes: Buffer.byteLength(v.text),
    content_hash: hash(),
    indexed: speaker === "owner" ? 1 : 0,
  });
}

/** Inserts one extraction run and returns its id. */
export function run(db: TempDb, projectId: number, origin = "trace", target = "session:s1"): number {
  return insert(db, "extraction_run", {
    project_id: projectId,
    origin,
    target,
    status: "running",
    started_at: at("2026-09-10T00:00:00Z"),
  });
}

// An active decision adopted by the AI alone, written the way the schema allows: its own reply deciding, an interactive run
export function aiDecided(db: TempDb, p: number, key: string, text: string, anchor?: string) {
  session(db, p, "s1");
  const now = at("2026-09-27T00:00:00Z");
  const reply = insert(db, "source", {
    project_id: p,
    kind: "session_message",
    artifact: "session:s1",
    external_id: `${key}:assistant`,
    revision: 1,
    session_id: "s1",
    turn_id: `${key}-turn`,
    author_kind: "assistant",
    created_at: now,
    captured_at: now,
    text,
    original_bytes: Buffer.byteLength(text),
    content_hash: hash(key.length * 7 + text.length),
    indexed: 0,
  });
  const call = insert(db, "record_call", {
    project_id: p,
    tool: "trace_begin",
    host: "codex",
    caller_session: "x",
    caller_turn: "y",
    mode: "interactive",
    called_at: now,
  });
  const run = insert(db, "extraction_run", {
    project_id: p,
    origin: "trace",
    target: "session:s1",
    session_id: "s1",
    status: "running",
    begin_call_id: call,
    started_at: now,
  });
  const unit = insert(db, "unit", {
    project_id: p,
    key: `trace:ext-s1/${key}`,
    kind: "decision",
    stance: "do",
    text,
    extraction: "supported",
    run_id: run,
    created_at: now,
    content_hash: hash(key.length * 13 + text.length),
  });
  const span = {
    source_id: reply,
    span_start: 0,
    span_end: Buffer.byteLength(text),
    run_id: run,
    added_at: now,
  };
  insert(db, "unit_evidence", { unit_id: unit, role: "decides", ...span });
  insert(db, "unit_adoption", { unit_id: unit, route: "agent", ...span });
  if (anchor)
    insert(db, "unit_anchor", {
      unit_id: unit,
      path: anchor,
      role: "applies_to",
      run_id: run,
      added_at: now,
    });
  for (const [from, to] of [
    [null, "candidate"],
    ["candidate", "active"],
  ] as const)
    insert(db, "unit_state", {
      unit_id: unit,
      from_state: from,
      to_state: to,
      at: now,
      reason: "r",
      run_id: run,
    });
  return unit;
}
