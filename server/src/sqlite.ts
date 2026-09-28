// Where the database file lives, and the read-only connection. **Writing connections live only in db-write.ts.**
// The modules are split so that interfaces reading untrusted text (MCP, search) cannot reach a
// writing connection, and scripts/check-architecture.mjs enforces the import direction.
//
// This guards against sphica's own code writing by mistake or because untrusted text told it to. It is not an
// OS permission boundary (a process running as the same OS user can rewrite the database file directly).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { constants as C, DatabaseSync } from "node:sqlite";

/** Schema generation (the `sphica_generation` table). A database of another generation is refused without being changed. */
const SCHEMA_GENERATION = 2;
/** Revision within the generation. Keep it equal to `pragma user_version` at the end of db/schema.sql. */
export const SCHEMA_REVISION = 2;

/** Connection roles: owner applies the schema, reader only reads, ingest imports, capture records conversations (append only). */
export type Role = "owner" | "reader" | "ingest" | "capture" | "forget";

/**
 * Where Sphica keeps its files (~/.sphica). `SPHICA_HOME` moves all of them, for tests and for measuring a host without touching
 * the owner's queue; `SPHICA_DB` moves only the database. Neither is documented in the README.
 */
export const sphicaHome = (): string => process.env.SPHICA_HOME || path.join(os.homedir(), ".sphica");

/** The database file. */
export const dbFile = (): string => process.env.SPHICA_DB || path.join(sphicaHome(), "sphica.db");

/**
 * Whether Node has the APIs the permission boundary needs. **Never continue in a weaker state.** npm may only warn
 * about `engines`, so every entry point (MCP, recording, CLI) checks this (setAuthorizer is v24.10,
 * enableDefensive is v24.12).
 */
export function requireRuntime(): void {
  const proto = DatabaseSync.prototype as unknown as Record<string, unknown>;
  if (typeof proto.setAuthorizer !== "function" || typeof proto.enableDefensive !== "function")
    throw new Error(`Sphica needs Node 24.15 or later (this is ${process.version}). Upgrade Node.`);
}

/** Never create a missing database silently (an empty file looks like "no records"). Only `sphica init` creates it. */
export function requireFile(file: string): void {
  if (!fs.existsSync(file)) throw new Error(`No database at ${file}. Create it with \`sphica init\`.`);
}

/**
 * Settings applied right after opening. **Run these before the authorizer** (after it, the authorizer rejects the
 * PRAGMAs). `enableDefensive` stops direct writes to the FTS5 shadow tables. The owner has no reason to write them
 * either, so every connection enables it (node:sqlite enables it by default; this keeps it on if the default changes).
 */
export function prepare(raw: DatabaseSync, check: "generation" | "revision" | "none"): void {
  raw.enableDefensive(true);
  raw.exec("pragma foreign_keys = on");
  // How long concurrent imports and recordings wait for each other. On timeout this fails with SQLITE_BUSY, and
  // recording retries on its next send.
  raw.exec("pragma busy_timeout = 5000");
  if (check === "none") return;
  checkGeneration(raw);
  if (check === "generation") return;
  const got = (raw.prepare("pragma user_version").get() as { user_version: number } | undefined)
    ?.user_version;
  if (got === SCHEMA_REVISION) return;
  throw new Error(
    `The database schema is revision ${got}, but this Sphica expects revision ${SCHEMA_REVISION}. ` +
      ((got ?? 0) < SCHEMA_REVISION
        ? "Update the sphica CLI (`npm i -g sphica`), then run `sphica init` to migrate it (records are kept)."
        : "Update sphica."),
  );
}

/**
 * The schema generation of an open database. Older generations have no `sphica_generation` table. **Never change such a file**:
 * it is the owner's data, and the only way forward is to move it aside and create a new one.
 */
export function generationOf(raw: DatabaseSync): number | null {
  // biome-ignore format: one line keeps raw.prepare( where the SQL ledger (scripts/lib/sql-call-sites.mjs) finds it
  const has = raw.prepare("select 1 from sqlite_schema where type = 'table' and name = 'sphica_generation'").get();
  if (!has) {
    const any = raw.prepare("select 1 from sqlite_schema where type = 'table' and name = 'project'").get();
    return any ? 1 : null;
  }
  return (
    (raw.prepare("select generation from sphica_generation").get() as { generation: number } | undefined)
      ?.generation ?? null
  );
}

function checkGeneration(raw: DatabaseSync): void {
  const got = generationOf(raw);
  if (got === SCHEMA_GENERATION) return;
  if (got === null) throw new Error("The database has no sphica schema. Create it with `sphica init`.");
  throw new Error(
    got < SCHEMA_GENERATION
      ? "The database was made by Sphica 0.4 or earlier, and this Sphica cannot read it. Move it aside (it is left unchanged), then run `sphica init`."
      : "The database was made by a newer Sphica. Update sphica.",
  );
}

/** Functions readers may call. **Add one only when a test fails** (every SQL statement runs against a real database in tests). */
const READER_FUNCTIONS = new Set([
  "bm25",
  "coalesce",
  "count",
  "instr",
  "json_array_length",
  "json_extract",
  "json_group_array",
  "json_object",
  "length",
  "lower",
  "match",
  "max",
  "min",
  "substr",
]);

/** Internal queries FTS5 makes to read its own index. They arrive outside any trigger (triggerOrView is null). */
export const SHADOW = /^(unit|source)_fts_(data|idx|docsize|config)$/;

/**
 * A read-only connection. It opens with `readOnly`, so SQLite rejects writes, and the authorizer stops DDL, ATTACH,
 * virtual table creation, and functions not on the list. `sphica_terms` is not registered (FTS search does not need
 * the tokenizer function).
 */
export function connectReader(file: string = dbFile()): DatabaseSync {
  requireRuntime();
  requireFile(file);
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    prepare(raw, "revision");
  } catch (e) {
    raw.close();
    throw e;
  }
  raw.setAuthorizer((action, p1, p2) => {
    if (action === C.SQLITE_READ || action === C.SQLITE_SELECT || action === C.SQLITE_RECURSIVE)
      return C.SQLITE_OK;
    if (action === C.SQLITE_FUNCTION)
      return READER_FUNCTIONS.has((p2 ?? "").toLowerCase()) ? C.SQLITE_OK : C.SQLITE_DENY;
    // FTS5 checks data_version each time it reads the index (a pragma with no value that changes nothing).
    if (action === C.SQLITE_PRAGMA && p1 === "data_version" && p2 === null) return C.SQLITE_OK;
    return C.SQLITE_DENY;
  });
  return raw;
}
