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

export function tempDb(): TempDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-db-"));
  const file = path.join(dir, "sphica.db");
  const owner = connectWriter("owner", file, true);
  owner.exec("pragma journal_mode = wal");
  owner.exec(SCHEMA);
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
