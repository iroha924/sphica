// Looks after this machine's database (~/.sphica/sphica.db). The owner runs these locally, with the owner connection (no authorizer).
//
//   sphica init                 creates the database and applies db/schema.sql. Safe to run again (an existing one is left alone)
//   sphica db migrate [--yes]   applies db/migrations newer than the database version (user_version)
//   sphica db reindex           rebuilds the full-text index (FTS). Run it after changing the rules of terms() in server/src/text.ts

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { constants as C, DatabaseSync } from "node:sqlite";
import type { Readable, Writable } from "node:stream";
import { confirm, isCancel } from "@clack/prompts";
import { dbDir } from "./assets.ts";
import { indent } from "./cli/view.ts";
import { dbFile, SCHEMA_REVISION } from "./db.ts";
import { connectWriter } from "./db-write.ts";
import { generationOf } from "./sqlite.ts";
import { plural } from "./text.ts";

/** Indented like other CLI output (the db command in cli.ts adds the heading and closing) */
const say = (text: string) => console.log(indent(text));

// assets.ts alone decides where bundled files live (the shipped package and the working tree differ).
const SCHEMA = (): string => path.join(dbDir(), "schema.sql");
const MIGRATIONS = (): string => path.join(dbDir(), "migrations");

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
        `Already exists: ${file} (revision ${got}; this Sphica expects ${SCHEMA_REVISION}. Run \`sphica db migrate\`.)`,
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

/**
 * NNNN in a name is the version after applying it. Name format and duplicates are checked even with nothing to apply (a skipped one never applies once the version moves on).
 */
function pendingMigrations(files: string[], current: number): { revision: number; file: string }[] {
  const all = files
    // Names starting with `.` are OS or editor hidden files (.DS_Store, vim swap files), not misnamed migrations.
    .filter((file) => !file.startsWith("."))
    .map((file) => {
      const revision = file.match(/^(\d{4})_[a-z0-9_]+\.sql$/)?.[1];
      if (!revision)
        throw new Error(`db/migrations/${file} is not named NNNN_<lowercase letters, digits, _>.sql`);
      return { revision: Number(revision), file };
    })
    .sort((a, b) => a.revision - b.revision);
  const seen = new Map<number, string>();
  for (const m of all) {
    const other = seen.get(m.revision);
    if (other)
      throw new Error(`db/migrations has two migrations for revision ${m.revision}: ${other} and ${m.file}`);
    seen.set(m.revision, m.file);
  }
  const pending = all.filter((m) => m.revision > current);
  for (const [i, m] of pending.entries()) {
    if (m.revision !== current + 1 + i)
      throw new Error(`db/migrations has no migration for revision ${current + 1 + i}`);
  }
  return pending;
}

/**
 * The declaration on a migration's first line. Only `-- sphica: foreign_keys=off` is accepted; any other `-- sphica:` throws.
 * **Misreading it and applying with foreign keys on lets a table rebuild cascade-delete child rows.** Leading spaces also count as a declaration.
 * The authorizer in applyMigrations stops undeclared migrations from dropping tables (not judged from the SQL text).
 */
function directiveOf(dir: string, m: { file: string }): "foreign_keys=off" | null {
  const lines = fs.readFileSync(path.join(dir, m.file), "utf8").split(/\r?\n/);
  let found: "foreign_keys=off" | null = null;
  for (const [i, line] of lines.entries()) {
    const d = /^\s*--\s*sphica:\s*(.*?)\s*$/.exec(line)?.[1];
    if (d === undefined) continue;
    if (i !== 0 || d !== "foreign_keys=off")
      throw new Error(`Cannot read the declaration on line ${i + 1} of db/migrations/${m.file}: ${d}`);
    found = d;
  }
  return found;
}

/**
 * Applies migrations newer than the database version and raises user_version per transaction (earlier ones stay if it fails midway, so it can be rerun).
 * Undeclared migrations in a row are applied in one transaction. A migration declaring `-- sphica: foreign_keys=off` runs alone,
 * turning foreign keys off outside the transaction, checks foreign_key_check is empty before commit, and turns them back on (they cannot switch inside a transaction).
 */
export function applyMigrations(
  raw: DatabaseSync,
  files: string[],
  dir: string,
): { revision: number; file: string }[] {
  // Read every declaration before applying. If one cannot be read, nothing is applied.
  const pending = pendingMigrations(files, versionOf(raw));
  const off = new Set(pending.filter((m) => directiveOf(dir, m) !== null).map((m) => m.file));
  const applied: { revision: number; file: string }[] = [];
  for (;;) {
    const next = pendingMigrations(files, versionOf(raw))[0];
    if (!next) return applied;
    const single = off.has(next.file);
    if (single) {
      raw.exec("pragma foreign_keys = off");
      if ((raw.prepare("pragma foreign_keys").get() as { foreign_keys: number }).foreign_keys !== 0)
        throw new Error("Could not turn foreign keys off (inside a transaction)");
    }
    // Undeclared migrations may not drop or rebuild tables (ALTER, including adding columns, belongs in a declared migration).
    // A drop with foreign keys on cascade-deletes child rows, and renaming a parent rewrites children's foreign keys to the backup.
    // It stops on statements SQLite has parsed, so comments or line breaks in between do not slip through.
    if (!single)
      raw.setAuthorizer((action) =>
        action === C.SQLITE_DROP_TABLE || action === C.SQLITE_ALTER_TABLE ? C.SQLITE_DENY : C.SQLITE_OK,
      );
    try {
      const batch = immediate(raw, () => {
        // Read again after taking the lock. If another db migrate advanced it meanwhile, apply the rest from there.
        const now = pendingMigrations(files, versionOf(raw));
        if (now[0]?.file !== next.file) return [];
        const stop = now.findIndex((m) => off.has(m.file));
        const take = single ? [next] : now.slice(0, stop === -1 ? now.length : stop);
        for (const m of take) raw.exec(fs.readFileSync(path.join(dir, m.file), "utf8"));
        if (single) {
          const broken = raw.prepare("pragma foreign_key_check").all();
          if (broken.length)
            throw new Error(`${plural(broken.length, "foreign key reference")} broken after ${next.file}`);
        }
        raw.exec(`pragma user_version = ${(take.at(-1) as { revision: number }).revision}`);
        return take;
      });
      applied.push(...batch);
    } finally {
      if (single) raw.exec("pragma foreign_keys = on");
      else raw.setAuthorizer(null);
    }
  }
}

/** What migrate did. The CLI closes with Stopped only for cancelled (declining is not "done") */
export type Migrated = "applied" | "up-to-date" | "cancelled";

/** Asks in the terminal. No is the default, and Esc, Ctrl-C, and a closed stdin all count as no */
export const askToApply = async (
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<boolean> => {
  // Clack does not settle when its input ends, so a closed input cancels the question (also one that ended before asking)
  const stream = input as Readable;
  if (stream.readableEnded || stream.destroyed) return false;
  const closed = new AbortController();
  const stop = () => closed.abort();
  input.once("end", stop);
  input.once("close", stop);
  try {
    const answer = await confirm({
      message: "Apply these migrations?",
      initialValue: false,
      input: input as Readable,
      output: output as Writable,
      signal: closed.signal,
    });
    return !isCancel(answer) && answer;
  } finally {
    input.off("end", stop);
    input.off("close", stop);
  }
};

/** Row counts of the ordinary tables (not FTS5 or SQLite's own). */
function rowCounts(raw: DatabaseSync): Map<string, number> {
  const tables = raw
    .prepare(
      "select name from sqlite_schema where type = 'table' and name not like 'sqlite\\_%' escape '\\' and sql not like 'create virtual%' and name not like '%\\_fts\\_%' escape '\\'",
    )
    .all() as { name: string }[];
  return new Map(
    tables.map((t) => [
      t.name,
      (raw.prepare(`select count(*) as n from "${t.name}"`).get() as { n: number }).n,
    ]),
  );
}

/** Tables that lost rows, as "table N rows (before → after)". A dropped table counts as 0 after. */
function removed(before: Map<string, number>, after: Map<string, number>): string[] {
  return [...before].flatMap(([t, n]) => {
    const now = after.get(t) ?? 0;
    return now < n ? [`${t} ${plural(n - now, "row")} (${n} → ${now})`] : [];
  });
}

/**
 * Applies the pending migrations to a copy beside the database and returns what they would remove. The copy is deleted afterwards,
 * whether or not it applied.
 */
function preview(file: string, files: string[], dir: string): string[] {
  const copy = `${file}.preview-${crypto.randomBytes(6).toString("hex")}`;
  try {
    withOwner(file, (raw) => raw.prepare("vacuum into ?").run(copy));
    return withOwner(copy, (raw) => {
      const before = rowCounts(raw);
      applyMigrations(raw, files, dir);
      return removed(before, rowCounts(raw));
    });
  } finally {
    for (const f of [copy, `${copy}-wal`, `${copy}-shm`]) fs.rmSync(f, { force: true });
  }
}

/**
 * Applies migrations newer than the database version. See applyMigrations for how.
 * **Lists them for confirmation before applying.** Without a terminal it cannot ask, so `--yes` is required.
 */
const defaultAsk = () => askToApply();

export async function migrate(
  yes: boolean,
  file: string = dbFile(),
  dir: string = MIGRATIONS(),
  ask: () => Promise<boolean> = defaultAsk,
): Promise<Migrated> {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const current = withOwner(file, versionOf);
  const todo = pendingMigrations(files, current);
  if (todo.length === 0) {
    say(`Nothing to apply: ${file} is at revision ${current}`);
    return "up-to-date";
  }
  say(`DB: ${file}`);
  say(`Current revision: ${current}`);
  say(`To apply: ${todo.map((m) => m.file).join(" / ")}`);
  const loses = preview(file, files, dir);
  say(loses.length ? `Would remove: ${loses.join(" / ")}` : "Would remove: nothing");
  if (!yes) {
    if (ask === defaultAsk && !process.stdin.isTTY)
      throw new Error("Add --yes when not running in a terminal");
    if (!(await ask())) return "cancelled";
  }
  const { applied, lost } = withOwner(file, (raw) => {
    const before = rowCounts(raw);
    const applied = applyMigrations(raw, files, dir);
    return { applied, lost: removed(before, rowCounts(raw)) };
  });
  say(`Applied: ${applied.map((m) => m.file).join(" / ") || "none"}`);
  say(lost.length ? `Removed: ${lost.join(" / ")}` : "Removed: nothing");
  say(`${file} is at revision ${withOwner(file, versionOf)}`);
  return "applied";
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

/** Database state for doctor. Everything is read only; no file is modified. */
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
