// Uses the database (one SQLite file) through kysely. **There are no credentials.** Connection roles split permissions (sqlite.ts and db-write.ts).
// Only what readers also use lives here. openWriter, which opens writing connections, is in db-write.ts.

import type { DatabaseSync } from "node:sqlite";
import { Kysely, ParseJSONResultsPlugin, SqliteDialect, sql } from "kysely";
import type { ReadonlyKysely } from "kysely/readonly";
import type { DB } from "./db-types.ts";
import { adapt } from "./kysely-node-sqlite.ts";
import { connectReader, dbFile } from "./sqlite.ts";

export { dbFile, type Role, SCHEMA_REVISION } from "./sqlite.ts";

/**
 * Columns whose JSON strings are turned back into values. **Filtered by name.** The default check tries to read every string wrapped
 * in `[` or `{` as JSON, turning messages whose body is `[]` or `[1] …` into arrays. Columns not listed stay strings.
 * The columns (`refs`, `downsides`, `next`) and nested columns built with `jsonArrayFrom`.
 */
const JSON_COLUMNS = new Set(["next"]);

const TOP_LEVEL = /^\$\[\d+\]\."([^"]+)"$/;

const parseJson = new ParseJSONResultsPlugin({
  shouldParse: (_value, jsonPath) => JSON_COLUMNS.has(jsonPath.match(TOP_LEVEL)?.[1] ?? ""),
});

/**
 * kysely around a connection. **The connection opens on the first query.** Opening at startup would stop MCP from starting just because the database is missing.
 * A failed open is not remembered; the next query opens again (kysely's driver init does this).
 */
export function kyselyOn(connect: () => DatabaseSync): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new SqliteDialect({ database: async () => adapt(connect()) }),
    plugins: [parseJson],
  });
}

/**
 * What a reading function takes: only the query starters that read. The read-only connection's handle and a writing one both fit, and
 * neither can be written through from inside the function.
 */
export type Reads = Pick<ReadonlyKysely<DB>, "selectFrom" | "fn" | "dynamic">;

/** A read-only connection, used by the read MCP server, the delivery hooks, and the projects in `doctor`. */
export function openReader(file: string = dbFile()): ReadonlyKysely<DB> {
  return kyselyOn(() => connectReader(file)) as unknown as ReadonlyKysely<DB>;
}

/**
 * Opens a writing transaction. **Starts with `begin immediate`** (takes the write lock first). The default `begin` starts as a
 * read and, when upgrading to write, fails with SQLITE_BUSY without waiting for busy_timeout if another writer is active.
 * On failure it rolls back and rethrows the original error. There is one connection, so fn must not run queries in parallel.
 */
export async function inTransaction<T>(db: Kysely<DB>, fn: (trx: Kysely<DB>) => Promise<T>): Promise<T> {
  return db.connection().execute(async (c) => {
    await sql`begin immediate`.execute(c);
    try {
      const out = await fn(c);
      await sql`commit`.execute(c);
      return out;
    } catch (e) {
      // If rollback itself throws, the original cause would be lost.
      await sql`rollback`.execute(c).catch(() => {});
      throw e;
    }
  });
}

/** The time format written to the database (ISO 8601 UTC, to milliseconds). The schema CHECK rejects anything else. */
export const iso = (d: Date | string | number): string => {
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) throw new RangeError(`Not a readable time: ${String(d)}`);
  return t.toISOString();
};

/** The primary result code of a SQLite failure (node:sqlite puts the extended code in errcode). null for non-SQLite failures. */
export function sqliteCode(e: unknown): number | null {
  const x = e as { code?: unknown; errcode?: unknown };
  return x?.code === "ERR_SQLITE_ERROR" && typeof x.errcode === "number" ? x.errcode & 0xff : null;
}
