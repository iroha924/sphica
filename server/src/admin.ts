// Looks after this machine's database (~/.sphica/sphica.db). The owner runs these locally, with the owner connection (no authorizer).
//
//   sphica init                 creates the database and applies db/schema.sql. Safe to run again (an existing one is left alone)
//   sphica doctor --reindex     rebuilds the full-text index (FTS). Run it after changing the rules of terms() in server/src/text.ts

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dbDir } from "./assets.ts";
import { indent } from "./cli/view.ts";
import { dbFile, iso, SCHEMA_REVISION } from "./db.ts";
import { connectWriter } from "./db-write.ts";
import { generationOf } from "./sqlite.ts";
import { plural } from "./text.ts";

/** Indented like other CLI output (the db command in cli.ts adds the heading and closing) */
const say = (text: string) => console.log(indent(text));

// assets.ts alone decides where bundled files live (the shipped package and the working tree differ).
const SCHEMA = (): string => path.join(dbDir(), "schema.sql");

const versionOf = (raw: DatabaseSync): number =>
  (raw.prepare("pragma user_version").get() as { user_version: number }).user_version;

/** Runs fn in a transaction that takes the write lock first. On failure it rolls back and rethrows the original error. */
function immediate<T>(raw: DatabaseSync, fn: () => T): T {
  raw.exec("begin immediate");
  try {
    const out = fn();
    raw.exec("commit");
    return out;
  } catch (e) {
    raw.exec("rollback");
    throw e;
  }
}

/** Opens a connection, runs fn, and always closes it. */
function withOwner<T>(file: string, fn: (raw: DatabaseSync) => T, create = false): T {
  const raw = connectWriter("owner", file, create);
  try {
    return fn(raw);
  } finally {
    raw.close();
  }
}

/**
 * Prepares this machine's database. **An existing one is left alone**, so it is safe to run again.
 * The schema is applied to a temporary file before it is put in place (stopping midway never leaves a half-applied database).
 * If the destination is already taken, it stops without placing it.
 */
export function dbInit(file: string = dbFile()): void {
  if (fs.existsSync(file)) {
    // Look without changing anything: another generation is refused, and a file that is not Sphica's is never touched
    const look = new DatabaseSync(file, { readOnly: true });
    let generation: number | null;
    try {
      generation = generationOf(look);
    } finally {
      look.close();
    }
    if (generation === null)
      throw new Error(
        `${file} is not a Sphica database (no schema). Move it to another name, then run this again.`,
      );
    const got = withOwner(file, versionOf);
    if (got === SCHEMA_REVISION) say(`Already exists: ${file} (revision ${got})`);
    else
      say(
        `Already exists: ${file} (revision ${got}; this Sphica expects ${SCHEMA_REVISION}. Move it aside, then run \`sphica init\`.)`,
      );
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  try {
    withOwner(
      tmp,
      (raw) => {
        // WAL is a setting stored in the database file, so it need not be set per connection. Readers (MCP) do not wait for writers (imports).
        raw.exec("pragma journal_mode = wal");
        raw.exec(fs.readFileSync(SCHEMA(), "utf8"));
        if (versionOf(raw) !== SCHEMA_REVISION)
          throw new Error(
            `db/schema.sql has user_version ${versionOf(raw)}, but the code expects ${SCHEMA_REVISION}`,
          );
      },
      true,
    );
    // rename replaces a database already in place. link stops with EEXIST when the destination is taken (the later of two concurrent inits).
    // File systems without hard links (FAT, exFAT) fall back to rename. Copying is not used: stopping midway leaves a partial database.
    try {
      fs.linkSync(tmp, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST" || fs.existsSync(file))
        throw new Error(
          `${file} already exists (another sphica init created it first). Run this again to check it.`,
        );
      fs.renameSync(tmp, file);
    }
  } finally {
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
  }
  say(`Created: ${file} (revision ${SCHEMA_REVISION})`);
}

export type Binding =
  | { kind: "bound" | "already" }
  | { kind: "other"; id: string; login: string | null }
  | { kind: "skipped"; revision: number };

/**
 * Binds the GitHub account gh is signed in to as the owner, only when none is bound yet. Another account is reported, never added:
 * switching gh to someone else's account must not give their words the owner's weight. A database of another revision is left alone.
 */
export function bindOwner(user: { id: number; login: string }, file: string = dbFile()): Binding {
  return withOwner(file, (raw) =>
    // The revision is read under the write lock, so it cannot change between the check and the insert
    immediate(raw, (): Binding => {
      const revision = versionOf(raw);
      if (revision !== SCHEMA_REVISION) return { kind: "skipped", revision };
      const bound = raw
        .prepare(
          "select external_id, login from owner_identity where provider = 'github' order by external_id = ? desc, bound_at, external_id limit 1",
        )
        .get(String(user.id)) as { external_id: string; login: string | null } | undefined;
      if (!bound) {
        raw
          .prepare(
            "insert into owner_identity (provider, external_id, login, bound_at) values ('github', ?, ?, ?)",
          )
          .run(String(user.id), user.login, iso(Date.now()));
        return { kind: "bound" };
      }
      return bound.external_id === String(user.id)
        ? { kind: "already" }
        : { kind: "other", id: bound.external_id, login: bound.login };
    }),
  );
}

/**
 * Rebuilds the full-text index. **A PR changing the rules of terms() adds this to its release steps.**
 * Changing the rules leaves existing rows indexed with the old rules, and they stop matching query terms.
 */
export function reindex(file: string = dbFile()): void {
  const counts = withOwner(file, (raw) =>
    immediate(raw, () => {
      raw.exec("insert into unit_fts (unit_fts) values ('delete-all')");
      raw.exec(
        "insert into unit_fts (rowid, body, ident, alias) select id, body, ident, alias from unit_search_text",
      );
      raw.exec("insert into source_fts (source_fts) values ('delete-all')");
      raw.exec(
        "insert into source_fts (rowid, lexemes) select id, sphica_terms(text) from source where indexed = 1",
      );
      const n = (sql: string) => (raw.prepare(sql).get() as { n: number }).n;
      return {
        units: n("select count(*) as n from unit"),
        sources: n("select count(*) as n from source where indexed = 1"),
      };
    }),
  );
  say(`Rebuilt the index: ${plural(counts.units, "unit")}, ${plural(counts.sources, "source")}`);
}

/** Database state for doctor. Nothing is modified, but the full-text integrity check is an FTS command that needs the owner connection. */
export type Inspection = {
  revision: number;
  /** Sizes of the database and WAL files (bytes) */
  bytes: number;
  /** integrity-check of the full-text index. The reason text when broken */
  fts: { unit: string | null; source: string | null };
};

export function inspect(file: string = dbFile()): Inspection {
  const size = (f: string) => (fs.existsSync(f) ? fs.statSync(f).size : 0);
  return withOwner(file, (raw) => {
    const check = (table: string): string | null => {
      try {
        raw.exec(`insert into ${table} (${table}, rank) values ('integrity-check', 1)`);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    };
    return {
      revision: versionOf(raw),
      bytes: size(file) + size(`${file}-wal`),
      fts: { unit: check("unit_fts"), source: check("source_fts") },
    };
  });
}
