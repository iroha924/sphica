// Looks after this machine's database (~/.sphica/sphica.db). The owner runs these locally, with the owner connection (no authorizer).
//
//   sphica init                 creates the database and applies db/schema.sql. Safe to run again (an older revision is migrated)
//   sphica doctor --reindex     rebuilds the full-text index (FTS) when doctor finds it broken

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dbDir } from "./assets.ts";
import { backupDir, backupPath, backups } from "./backups.ts";
import { HOLD_DAYS, HOLD_MAX } from "./capture.ts";
import { indent } from "./cli/view.ts";
import { dbFile, iso, SCHEMA_REVISION, sqliteCode } from "./db.ts";
import { connectWriter } from "./db-write.ts";
import { inline } from "./panel.ts";
import { packageVersionAt, ROOT } from "./plugin.ts";
import { settleForMigration } from "./reconcile.ts";
import { generationOf } from "./sqlite.ts";
import { plural } from "./text.ts";

/** Indented like other CLI output (the db command in cli.ts adds the heading and closing) */
const say = (text: string) => console.log(indent(text));

// assets.ts alone decides where bundled files live (the shipped package and the working tree differ).
const SCHEMA = (): string => path.join(dbDir(), "schema.sql");
/** db/migrations/<revision>.sql moves a database from the revision before it (0002.sql: 1 → 2). */
const MIGRATIONS = (): string => path.join(dbDir(), "migrations");
const MIGRATION = (dir: string, revision: number): string =>
  path.join(dir, `${String(revision).padStart(4, "0")}.sql`);
/** Runs first when present: it lists the rows this revision cannot take in the temp table STOP, and the migration changes nothing. */
const CHECK = (dir: string, revision: number): string =>
  path.join(dir, `${String(revision).padStart(4, "0")}.check.sql`);
/** Temp tables a migration fills: rows it stops on (rule, item), and rows it repaired or removed (rule, item, action). */
const STOP = "sphica_migration_stop";
const NOTE = "sphica_migration_note";

/** How many completed backups a successful migration keeps */
const KEEP = 3;

/**
 * Writes a consistent copy (VACUUM INTO reads through the WAL) to a `.partial` file, puts it back in WAL mode (the copy comes out in rollback
 * mode, where a restored database's readers would block writers), checks it, then names it. Only this run's own `.partial` is removed on failure.
 */
function backUp(raw: DatabaseSync, file: string, from: number): string {
  fs.mkdirSync(backupDir(file), { recursive: true, mode: 0o700 });
  const done = backupPath(file, from);
  const partial = `${done}.partial`;
  try {
    raw.prepare("vacuum into ?").run(partial);
    const look = new DatabaseSync(partial);
    try {
      look.exec("pragma journal_mode = wal");
      const check = look.prepare("pragma quick_check").all() as { quick_check: string }[];
      if (check.length !== 1 || check[0]?.quick_check !== "ok")
        throw new Error(`the copy failed its check (${check.map((c) => c.quick_check).join("; ")})`);
      if (versionOf(look) !== from)
        throw new Error(`the copy is at revision ${versionOf(look)}, not ${from}`);
    } finally {
      look.close();
    }
    fs.renameSync(partial, done);
  } catch (e) {
    for (const f of [partial, `${partial}-wal`, `${partial}-shm`]) fs.rmSync(f, { force: true });
    throw new Error(
      `Could not back up ${file} before migrating it, so nothing was migrated (${(e as Error).message}). Check free space in ${backupDir(file)}.`,
    );
  }
  return done;
}

/**
 * Keeps this run's backup and the KEEP - 1 newest others. Runs only after every migration step committed, so a failing run never removes
 * an older one. A backup that cannot be removed (open in another process on Windows), or a directory that cannot be listed, is left for the next
 * migration; the database is already migrated.
 */
function prune(file: string, kept: string): void {
  let all: string[];
  try {
    all = backups(file);
  } catch {
    return;
  }
  for (const old of all.filter((b) => b !== kept).slice(KEEP - 1))
    try {
      fs.rmSync(old, { force: true });
    } catch {}
}

const versionOf = (raw: DatabaseSync): number =>
  (raw.prepare("pragma user_version").get() as { user_version: number }).user_version;

const SQLITE_BUSY = 5;

type Row = { rule: string; item: string; action?: string };

/** Every row of a migration's temp table, which is then dropped. Read inside the transaction: a rollback takes the table with it. */
function taken(raw: DatabaseSync, table: string): Row[] {
  if (!raw.prepare("select 1 from temp.sqlite_schema where type = 'table' and name = ?").get(table))
    return [];
  const rows = raw.prepare(`select * from temp.${table} order by rule, rowid`).all() as Row[];
  raw.exec(`drop table temp.${table}`);
  return rows;
}

/** One line per row under its rule. The text comes from the database, so each row stays on its own line. */
function listed(rows: Row[]): string {
  const rules = new Map<string, Row[]>();
  for (const r of rows) {
    const of = rules.get(r.rule);
    if (of) of.push(r);
    else rules.set(r.rule, [r]);
  }
  return [...rules]
    .flatMap(([rule, of]) => [
      `${inline(String(rule))}: ${plural(of.length, "row")}`,
      ...of.map((r) => `  ${inline(String(r.item))}${r.action ? ` → ${inline(String(r.action))}` : ""}`),
    ])
    .join("\n");
}

/**
 * Advice for a stop rule whose rows a release did write, so the general advice (fix the rows or forget them) does not fit. Keyed by the
 * rule text the check script writes.
 */
const STOP_ADVICE: Record<string, (revision: number, rows: Row[]) => string> = {
  "projects with records whose keys become one once normalized": (revision, rows) =>
    `Revision ${revision} was not applied: ${plural(rows.length, "project")} with records have keys that become one once normalized (listed below), and this Sphica cannot merge them. Search, read, and the record tools stay unavailable until a Sphica that can merge them migrates this database. Meanwhile capture keeps recording a session whose remote is written as one of the listed keys; a session whose remote is written otherwise is held, and held records are dropped after ${HOLD_DAYS} days or past ${HOLD_MAX} of them. Report the list below at https://github.com/iroha924/sphica/issues. Forgetting sources does not resolve it`,
};

/** A migration's check found rows the new revision cannot take. Nothing of that step was changed. */
class Stop extends Error {
  list: string;
  constructor(revision: number, rows: Row[]) {
    const rules = new Set(rows.map((r) => r.rule));
    const advice = rules.size === 1 ? STOP_ADVICE[String(rows[0]?.rule)] : undefined;
    super(
      advice
        ? advice(revision, rows)
        : `The database has ${plural(rows.length, "row")} that revision ${revision} cannot take, and Sphica writes no such row (listed below). Fix the rows, or forget a listed source with /sphica:forget on the Sphica version that still opens this database, then run \`sphica init\` again`,
    );
    this.list = listed(rows);
  }
}

/**
 * The revision the database is committed at after a failed step, or null when that cannot be told. An open transaction (its rollback
 * failed) would show a revision that closing the connection takes back, so it is not read.
 */
function committed(raw: DatabaseSync): number | null {
  if (raw.isTransaction) return null;
  try {
    return versionOf(raw);
  } catch {
    return null;
  }
}

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

/** Refreshes the planner's statistics after a write that finished. A failure here never fails what already succeeded. */
function optimize(raw: DatabaseSync): void {
  try {
    raw.exec("pragma optimize");
  } catch {}
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
 * Revision 10 judges every record by the rules saves now follow, after its SQL restored what history proves; each change becomes a note.
 * It runs the judge of this release: a later change to the rules comes with its own revision.
 */
function judgeEveryRecord(raw: DatabaseSync): void {
  const runs = new Map(
    (
      raw
        .prepare(
          "select project_id, max(id) as id from extraction_run where origin = 'migration' and target = 'revision:10' group by project_id",
        )
        .all() as { project_id: number; id: number }[]
    ).map((r) => [r.project_id, r.id]),
  );
  const io = {
    all: (sql: string, ...p: (string | number | null)[]) => raw.prepare(sql).all(...p),
    run: (sql: string, ...p: (string | number | null)[]) => void raw.prepare(sql).run(...p),
  };
  for (const [item, action] of settleForMigration(io, runs, iso(Date.now())))
    raw
      .prepare(`insert into temp.${NOTE} (rule, item, action) values ('judged again by revision 10', ?, ?)`)
      .run(item, action);
}

/**
 * Moves the database up to SCHEMA_REVISION, one migration per transaction with foreign keys off (the pragma is ignored inside one) and
 * foreign_key_check empty before each commit; the revision is read under the write lock, so a concurrent init does nothing more.
 * **A backup comes first**: a later step can fail after earlier ones committed, and a committed step can be wrong.
 */
export function migrate(file: string = dbFile(), dir: string = MIGRATIONS()): number {
  return withOwner(file, (raw) => {
    const from = versionOf(raw);
    if (from >= SCHEMA_REVISION) return from;
    const backup = backUp(raw, file, from);
    say(`Backed up: ${backup} (revision ${from})`);
    try {
      for (let r = from + 1; r <= SCHEMA_REVISION; r++) {
        const script = MIGRATION(dir, r);
        if (!fs.existsSync(script))
          throw new Error(
            `This Sphica has no migration script for revision ${r} (${script} is missing). Reinstall sphica (\`npm i -g sphica@${packageVersionAt(ROOT) ?? "latest"}\`), then run \`sphica init\` again.`,
          );
        raw.exec("pragma foreign_keys = off");
        try {
          const notes = immediate(raw, () => {
            if (versionOf(raw) !== r - 1) return [];
            if (fs.existsSync(CHECK(dir, r))) {
              raw.exec(fs.readFileSync(CHECK(dir, r), "utf8"));
              const stops = taken(raw, STOP);
              if (stops.length) throw new Stop(r, stops);
            }
            raw.exec(fs.readFileSync(script, "utf8"));
            if (r === 10) judgeEveryRecord(raw);
            const broken = raw.prepare("pragma foreign_key_check").all().length;
            if (broken)
              throw new Error(
                `Migration to revision ${r} left ${plural(broken, "broken reference")}; nothing was changed`,
              );
            if (versionOf(raw) !== r) throw new Error(`${path.basename(script)} did not set revision ${r}`);
            return taken(raw, NOTE);
          });
          if (notes.length)
            say(
              `Changed while migrating to revision ${r}: ${plural(notes.length, "row")} (the backup keeps them as they were)\n${listed(notes)}`,
            );
        } finally {
          raw.exec("pragma foreign_keys = on");
        }
      }
    } catch (e) {
      const said = (e as Error).message.replace(/\.$/, "");
      const list = e instanceof Stop ? `\n${e.list}` : "";
      const now = committed(raw);
      // No step committed: going back would only lose what capture wrote since the backup, so this run's copy goes and nothing is pruned
      if (now === from) {
        let left = "the backup made for this run was removed";
        try {
          fs.rmSync(backup, { force: true });
        } catch {
          left = `the backup made for this run is still at ${backup}; delete it yourself`;
        }
        const retry =
          sqliteCode(e) === SQLITE_BUSY
            ? " Another process is writing to the database. Run `sphica init` again when it has finished."
            : "";
        throw new Error(
          `${said}. No migration step was committed: the database is still at revision ${from}, and there is no need to replace it with a backup (${left}).${retry}${list}`,
        );
      }
      const base = path.basename(file);
      const state =
        now === null
          ? "The committed revision could not be confirmed after the failure"
          : `The database is now at revision ${now} (this run, or another \`sphica init\` running at the same time, migrated it that far)`;
      throw new Error(
        `${said}. ${state}. The database before migrating is at ${backup} (anything recorded after it was made is not in it). To go back to it, close every session using Sphica, move ${base}, ${base}-wal, and ${base}-shm in ${path.dirname(file)} aside, then copy the backup to ${file}.${list}`,
      );
    }
    optimize(raw);
    prune(file, backup);
    return from;
  });
}

/**
 * Prepares this machine's database. **An existing one is kept**: an older revision is migrated, so it is safe to run again.
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
    else if (got > SCHEMA_REVISION)
      say(
        `Already exists: ${file} (revision ${got}, made by a newer Sphica; this one expects ${SCHEMA_REVISION}. Update sphica.)`,
      );
    else {
      migrate(file);
      say(`Migrated: ${file} (revision ${got} → ${SCHEMA_REVISION})`);
    }
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
        optimize(raw);
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
  | { kind: "bound" }
  | { kind: "already" }
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
  const counts = withOwner(file, (raw) => {
    const n = immediate(raw, () => {
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
    });
    optimize(raw);
    return n;
  });
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
