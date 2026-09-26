import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { applyMigrations, askToApply, dbInit, inspect, migrate, reindex } from "../src/admin.ts";
import { SCHEMA_REVISION } from "../src/db.ts";
import { connectWriter } from "../src/db-write.ts";
import { at, hash } from "./temp-db.ts";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sphica-admin-"));

/** Runs fn with admin output (console.log) silenced. */
async function quiet<T>(fn: () => T | Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

test("sphica init creates the database in WAL mode with a version and leaves it alone the second time", async () => {
  const file = path.join(tmp(), "nested", "sphica.db");
  await quiet(() => dbInit(file));
  const raw = new DatabaseSync(file, { readOnly: true });
  assert.equal((raw.prepare("pragma journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
  assert.equal(
    (raw.prepare("pragma user_version").get() as { user_version: number }).user_version,
    SCHEMA_REVISION,
  );
  raw.close();
  const w = connectWriter("owner", file);
  w.prepare("insert into project (key, name) values ('git:x/y', 'x/y')").run();
  w.close();
  await quiet(() => dbInit(file));
  const again = new DatabaseSync(file, { readOnly: true });
  assert.equal(
    (again.prepare("select count(*) as n from project").get() as { n: number }).n,
    1,
    "not recreated",
  );
  again.close();
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp")),
    [],
    "no temp file left",
  );
});

// Even if two sphica init runs both see no database, the later one does not replace the first one's database, with its records, by an empty one.
test("sphica init does not replace a database placed just before it", async (t) => {
  const file = path.join(tmp(), "sphica.db");
  await quiet(() => dbInit(file));
  const w = connectWriter("owner", file);
  w.prepare("insert into project (key, name) values ('git:x/y', 'x/y')").run();
  w.close();
  // Reproduces the side that slipped past the existence check.
  t.mock.method(fs, "existsSync", (f: fs.PathLike) =>
    String(f) === file ? false : fs.statSync(f, { throwIfNoEntry: false }) !== undefined,
  );
  await assert.rejects(async () => quiet(() => dbInit(file)), /already exists/);
  t.mock.restoreAll();
  const raw = new DatabaseSync(file, { readOnly: true });
  assert.equal((raw.prepare("select count(*) as n from project").get() as { n: number }).n, 1);
  raw.close();
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp")),
    [],
  );
});

test("uses rename on file systems without hard links", async (t) => {
  const file = path.join(tmp(), "sphica.db");
  t.mock.method(fs, "linkSync", () => {
    throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  });
  await quiet(() => dbInit(file));
  const raw = new DatabaseSync(file, { readOnly: true });
  assert.equal(
    (raw.prepare("pragma user_version").get() as { user_version: number }).user_version,
    SCHEMA_REVISION,
  );
  raw.close();
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp")),
    [],
  );
});

// If another app's database sits under the same name, do not break it by applying the schema on top.
test("sphica init does not overwrite a file that is not a Sphica database", async () => {
  const file = path.join(tmp(), "sphica.db");
  const raw = new DatabaseSync(file);
  raw.exec("create table mine (a)");
  raw.close();
  await assert.rejects(
    quiet(() => dbInit(file)),
    /is not a Sphica database/,
  );
});

test("sphica init leaves a database made by Sphica 0.4 or earlier unchanged and says to move it aside", async () => {
  const file = path.join(tmp(), "sphica.db");
  const raw = new DatabaseSync(file);
  raw.exec("create table project (id integer primary key); pragma user_version = 7");
  raw.close();
  const before = fs.readFileSync(file);
  await assert.rejects(
    quiet(() => dbInit(file)),
    /Sphica 0.4 or earlier.*Move it aside/,
  );
  assert.deepEqual(fs.readFileSync(file), before);
});

test("db reindex rebuilds the full-text index and passes the doctor check", async () => {
  const file = path.join(tmp(), "sphica.db");
  await quiet(() => dbInit(file));
  const w = connectWriter("owner", file);
  w.exec("insert into project (key, name) values ('git:x/y', 'x/y')");
  w.prepare(
    "insert into session (id, project_id, host, external_id, started_at) values ('s', 1, 'codex', 's', ?)",
  ).run(at("2026-09-01T00:00:00Z"));
  w.prepare(
    "insert into source (project_id, kind, artifact, external_id, revision, session_id, author_kind, created_at, captured_at, text, original_bytes, content_hash, indexed) values (1, 'session_message', 'session:s', 'm', 1, 's', 'owner', ?, ?, '索引を作り直す', ?, ?, 1)",
  ).run(at("2026-09-01T00:00:00Z"), at("2026-09-01T00:00:00Z"), Buffer.byteLength("索引を作り直す"), hash());
  w.exec("insert into source_fts (source_fts) values ('delete-all')");
  const count = () =>
    (
      w.prepare("select count(*) as n from source_fts where source_fts match '\"索引\"'").get() as {
        n: number;
      }
    ).n;
  assert.equal(count(), 0);
  await quiet(() => reindex(file));
  assert.equal(count(), 1);
  w.close();
  const x = inspect(file);
  assert.equal(x.revision, SCHEMA_REVISION);
  assert.deepEqual(x.fts, { unit: null, source: null });
  assert.ok(x.bytes > 0);
});

test("db migrate does nothing when there are no migrations to apply", async () => {
  const file = path.join(tmp(), "sphica.db");
  await quiet(() => dbInit(file));
  assert.equal(await quiet(() => migrate(true, file)), "up-to-date");
  assert.equal(inspect(file).revision, SCHEMA_REVISION);
});

// Declining (No, Esc, or EOF all come back as false) applies nothing and says so, so the command cannot close with "done".
test("db migrate applies nothing and reports cancelled when the confirmation is declined", async () => {
  const dir = tmp();
  const file = path.join(dir, "sphica.db");
  await quiet(() => dbInit(file));
  const migrations = path.join(dir, "migrations");
  writeMigrations(migrations, ["create table note (a text) strict;\n"]);
  let asked = 0;
  const decline = async () => {
    asked++;
    return false;
  };
  assert.equal(await quiet(() => migrate(false, file, migrations, decline)), "cancelled");
  assert.equal(asked, 1);
  assert.equal(inspect(file).revision, SCHEMA_REVISION);
  assert.equal(await quiet(() => migrate(false, file, migrations, async () => true)), "applied");
  assert.equal(inspect(file).revision, SCHEMA_REVISION + 1);
});

// The path taken by the shipped CLI. HOME points to a temp directory so the owner's ~/.sphica is untouched.
test("sphica init creates the database in .sphica under HOME", () => {
  const home = tmp();
  execFileSync(process.execPath, [CLI, "init"], {
    env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home },
    stdio: "ignore",
    timeout: 30_000,
  });
  assert.equal(inspect(path.join(home, ".sphica", "sphica.db")).revision, SCHEMA_REVISION);
});

// No aliases for old names. The old `sphica db init` and `sphica check` fail. (`sphica init --cwd <dir>` is valid again: it registers dir.)
test("old command forms are rejected and create no database", () => {
  for (const args of [["db", "init"], ["check"]]) {
    const home = tmp();
    const r = spawnSync(process.execPath, [CLI, ...args], {
      env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.notEqual(r.status, 0, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.equal(fs.existsSync(path.join(home, ".sphica", "sphica.db")), false, args.join(" "));
  }
});

// A failure midway must not leave the first half committed without a version bump (running again would apply it twice).
test("db migrate applies new migrations in one transaction and bumps the version, leaving nothing on failure", async () => {
  const dir = tmp();
  const file = path.join(dir, "sphica.db");
  await quiet(() => dbInit(file));
  const migrations = path.join(dir, "migrations");
  fs.mkdirSync(migrations);
  const next = SCHEMA_REVISION + 1;
  const name = `${String(next).padStart(4, "0")}_add_note.sql`;
  fs.writeFileSync(
    path.join(migrations, name),
    "create table note (a text) strict;\ncreate table broken (;\n",
  );
  await assert.rejects(
    quiet(() => migrate(true, file, migrations)),
    /syntax error/,
  );
  assert.equal(inspect(file).revision, SCHEMA_REVISION);
  const tables = () =>
    new DatabaseSync(file, { readOnly: true })
      .prepare("select name from sqlite_schema where name = 'note'")
      .all().length;
  assert.equal(tables(), 0, "the first half of the DDL is rolled back too");
  fs.writeFileSync(path.join(migrations, name), "create table note (a text) strict;\n");
  await quiet(() => migrate(true, file, migrations));
  assert.equal(inspect(file).revision, next);
  assert.equal(tables(), 1);
});

// A terminal whose input closes mid-question (the other end hung up) must answer no, not wait forever.
test("the migrate confirmation answers no when its input closes", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  output.resume();
  const answer = askToApply(input, output);
  setTimeout(() => input.end(), 50);
  const timeout = new Promise<string>((done) => setTimeout(() => done("still waiting"), 2000).unref());
  assert.equal(await Promise.race([answer, timeout]), false);
});

test("the migrate confirmation answers no when its input ended before it asked", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  output.resume();
  input.resume();
  input.end();
  await new Promise((done) => input.once("end", done));
  const timeout = new Promise<string>((done) => setTimeout(() => done("still waiting"), 2000).unref());
  assert.equal(await Promise.race([askToApply(input, output), timeout]), false);
});

// Without a terminal nobody can answer, so the default question refuses before asking (the test runner's stdin is not a terminal)
test("db migrate without --yes outside a terminal stops before asking", async () => {
  const dir = tmp();
  const file = path.join(dir, "sphica.db");
  await quiet(() => dbInit(file));
  const migrations = path.join(dir, "migrations");
  writeMigrations(migrations, ["create table note (a text) strict;\n"]);
  const timeout = new Promise<string>((done) => setTimeout(() => done("still waiting"), 2000).unref());
  const outcome = quiet(() => migrate(false, file, migrations)).then(
    () => "no error",
    (e: Error) => e.message,
  );
  assert.match(await Promise.race([outcome, timeout]), /Add --yes/);
  assert.equal(inspect(file).revision, SCHEMA_REVISION);
});

// A failure inside a boxed command closes the heading it already printed, instead of opening a second one
test("a boxed command that fails prints its heading once and closes with Stopped", () => {
  const home = tmp();
  const r = spawnSync(process.execPath, [CLI, "db", "reindex"], {
    env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home },
    encoding: "utf8",
    timeout: 30_000,
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.notEqual(r.status, 0, out);
  assert.equal(out.split("\n").filter((l) => l === "sphica db reindex").length, 1, out);
  assert.match(out, /^✗ Stopped$/m, out);
});

/** Runs the CLI with HOME set to home; the repo helpers below make the places init looks at. */
function cli(home: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** A git repository with one commit, and an origin remote when given one */
function repoAt(dir: string, origin?: string): string {
  const repo = path.join(dir, "repo");
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  fs.mkdirSync(repo, { recursive: true });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "README.md"), "# Design\n\nWe keep one SQLite file.\n");
  git("add", ".");
  git("commit", "-qm", "first");
  if (origin) git("remote", "add", "origin", origin);
  return repo;
}

const projectKeys = (home: string): string[] =>
  (
    new DatabaseSync(path.join(home, ".sphica", "sphica.db"), { readOnly: true })
      .prepare("select key from project order by key")
      .all() as { key: string }[]
  ).map((r) => r.key);

test("sphica init in a repository with a remote creates the database and registers it once", () => {
  const home = tmp();
  const repo = repoAt(tmp(), "https://github.com/example/proj.git");
  const first = cli(home, "init", "--cwd", repo);
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /registered/, first.out);
  assert.deepEqual(projectKeys(home), ["git:github.com/example/proj"]);
  const again = cli(home, "init", "--cwd", repo);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /already registered/, again.out);
  assert.deepEqual(projectKeys(home), ["git:github.com/example/proj"]);
});

test("sphica init outside a repository only creates the database", () => {
  const home = tmp();
  const r = cli(home, "init", "--cwd", tmp());
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(projectKeys(home), []);
});

test("sphica init in a repository without a remote asks for --name and registers nothing", () => {
  const home = tmp();
  const repo = repoAt(tmp());
  const r = cli(home, "init", "--cwd", repo);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /sphica init --name <name>/, r.out);
  assert.deepEqual(projectKeys(home), []);
  const named = cli(home, "init", "--cwd", repo, "--name", "notes");
  assert.equal(named.code, 0, named.out);
  assert.deepEqual(projectKeys(home), ["local:notes"]);
  // A different name for the same place is refused, not silently swapped (records stay under the first key)
  const renamed = cli(home, "init", "--cwd", repo, "--name", "other");
  assert.notEqual(renamed.code, 0, renamed.out);
  assert.match(renamed.out, /notes/, renamed.out);
  assert.deepEqual(projectKeys(home), ["local:notes"]);
});

// A subdirectory of a named place belongs to it already. Writing the name again for the subdirectory would give the key two places,
// and harvest skips a project with two places on one machine
test("sphica init --name in a subdirectory of the named place changes nothing", () => {
  const home = tmp();
  const place = fs.realpathSync(tmp());
  fs.mkdirSync(path.join(place, "sub"));
  assert.equal(cli(home, "init", "--cwd", place, "--name", "notes").code, 0);
  const table = path.join(home, ".sphica", "projects.json");
  const before = fs.readFileSync(table, "utf8");
  const r = cli(home, "init", "--cwd", path.join(place, "sub"), "--name", "notes");
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(table, "utf8"), before);
  assert.deepEqual(projectKeys(home), ["local:notes"]);
});

test("sphica init refuses a bad --name before creating anything", () => {
  for (const args of [["--name", "Bad Name"]]) {
    const home = tmp();
    const r = cli(home, "init", "--cwd", tmp(), ...args);
    assert.notEqual(r.code, 0, `${args.join(" ")}: ${r.out}`);
    assert.equal(fs.existsSync(path.join(home, ".sphica", "sphica.db")), false, args.join(" "));
  }
});

// A mistyped --cwd must not pass for a finished setup, and with --name it would register a directory that does not exist
test("sphica init refuses a --cwd that is not a directory before creating anything", () => {
  const file = path.join(tmp(), "file.txt");
  fs.writeFileSync(file, "");
  for (const cwd of [path.join(tmp(), "missing"), file]) {
    const home = tmp();
    const r = cli(home, "init", "--cwd", cwd, "--name", "notes");
    assert.notEqual(r.code, 0, `${cwd}: ${r.out}`);
    assert.match(r.out, /is not a directory/, r.out);
    assert.equal(fs.existsSync(path.join(home, ".sphica", "sphica.db")), false, cwd);
  }
});

test("doctor names the command that sends stuck recordings", () => {
  const home = tmp();
  cli(home, "init");
  fs.mkdirSync(path.join(home, ".sphica", "spool"), { recursive: true });
  fs.writeFileSync(path.join(home, ".sphica", "spool", "1.json"), "{}");
  fs.writeFileSync(
    path.join(home, ".sphica", "capture.json"),
    JSON.stringify({ error: "database is locked" }),
  );
  const r = cli(home, "doctor");
  assert.match(r.out, /sphica capture flush/, r.out);
});

/** Writes migrations numbered from current + 1 into dir. */
function writeMigrations(dir: string, bodies: string[]): string[] {
  fs.mkdirSync(dir, { recursive: true });
  return bodies.map((body, i) => {
    const name = `${String(SCHEMA_REVISION + 1 + i).padStart(4, "0")}_m${i}.sql`;
    fs.writeFileSync(path.join(dir, name), body);
    return name;
  });
}

// A migration that rebuilds a parent table deletes child rows by cascade through DROP's implicit delete while foreign keys are on.
test("a migration declaring foreign_keys=off runs alone with foreign keys off and turns them back on after", async () => {
  const dir = tmp();
  const file = path.join(dir, "sphica.db");
  await quiet(() => dbInit(file));
  const raw = connectWriter("owner", file);
  const migrations = path.join(dir, "migrations");
  const files = writeMigrations(migrations, [
    `create table parent (id integer primary key autoincrement not null, v text not null) strict;
create table child (id integer primary key not null, parent_id integer not null references parent (id) on delete cascade) strict;
insert into parent (v) values ('a');
insert into child (id, parent_id) values (1, 1);`,
    // Leading spaces on line 1 still count as the declaration (missing it would rebuild with foreign keys on)
    `  -- sphica: foreign_keys=off
create table "parent_new" (id integer primary key autoincrement not null, v text not null check (v <> '')) strict;
insert into "parent_new" (id, v) select id, v from parent;
drop table parent;
alter table "parent_new" rename to parent;`,
  ]);
  const applied = applyMigrations(raw, files, migrations);
  assert.deepEqual(
    applied.map((m) => m.revision),
    [SCHEMA_REVISION + 1, SCHEMA_REVISION + 2],
  );
  assert.equal((raw.prepare("pragma foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
  assert.equal(
    (raw.prepare("pragma user_version").get() as { user_version: number }).user_version,
    SCHEMA_REVISION + 2,
  );
  assert.equal(
    (raw.prepare("select count(*) as n from child").get() as { n: number }).n,
    1,
    "child rows remain",
  );
  raw.close();
});

test("when a foreign-keys-off migration fails, it rolls back on the same connection, turns foreign keys back on, and stops at the previous version", async () => {
  const dir = tmp();
  const file = path.join(dir, "sphica.db");
  await quiet(() => dbInit(file));
  const raw = connectWriter("owner", file);
  const migrations = path.join(dir, "migrations");
  const files = writeMigrations(migrations, [
    "create table note (a text) strict;",
    "-- sphica: foreign_keys=off\ncreate table half (a text) strict;\ncreate table broken (;",
  ]);
  assert.throws(() => applyMigrations(raw, files, migrations), /syntax error/);
  assert.equal((raw.prepare("pragma foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
  assert.equal(
    (raw.prepare("pragma user_version").get() as { user_version: number }).user_version,
    SCHEMA_REVISION + 1,
  );
  const has = (t: string) => raw.prepare("select 1 from sqlite_schema where name = ?").get(t) !== undefined;
  assert.ok(has("note"), "the previous migration is committed");
  assert.ok(!has("half"), "the first half of the failed migration is rolled back");
  fs.writeFileSync(
    path.join(migrations, files[1] as string),
    "-- sphica: foreign_keys=off\ncreate table half (a text) strict;",
  );
  applyMigrations(raw, files, migrations);
  assert.equal(
    (raw.prepare("pragma user_version").get() as { user_version: number }).user_version,
    SCHEMA_REVISION + 2,
  );
  raw.close();
});

// Misreading the declaration and applying with foreign keys on deletes child rows that should stay. Unreadable declarations stop before applying.
test("stops without applying anything on an unknown declaration or one not on line 1", async () => {
  for (const body of [
    "-- sphica: foreign_keys=of\ncreate table x (a text) strict;",
    "create table x (a text) strict;\n-- sphica: foreign_keys=off",
    // Leading spaces still count as the declaration (reading it as absent would rebuild tables with foreign keys on)
    "create table x (a text) strict;\n  -- sphica: foreign_keys=off",
  ]) {
    const dir = tmp();
    const file = path.join(dir, "sphica.db");
    await quiet(() => dbInit(file));
    const raw = connectWriter("owner", file);
    const files = writeMigrations(path.join(dir, "migrations"), [body]);
    assert.throws(() => applyMigrations(raw, files, path.join(dir, "migrations")), /declaration/, body);
    assert.equal(
      (raw.prepare("pragma user_version").get() as { user_version: number }).user_version,
      SCHEMA_REVISION,
    );
    raw.close();
  }
});

// Dropping a table without the declaration deletes child rows by cascade with foreign keys on. Regardless of formatting
// (comments, newlines), stop when SQLite actually tries to delete, leaving nothing behind. drop table inside a comment is fine.
test("a migration without the declaration cannot drop or rebuild tables however it is written, and drop inside a comment passes", async () => {
  for (const drop of [
    "drop table parent;",
    "DROP /* rebuild */ TABLE parent;",
    "DROP -- rebuild\nTABLE parent;",
    // Renaming the parent rewrites child foreign keys to point to the renamed table, and dropping that deletes the children
    "alter table parent rename to parent_old;\ncreate table parent (id integer primary key not null) strict;\ninsert into parent select * from parent_old;\ndelete from parent_old;",
  ]) {
    const dir = tmp();
    const file = path.join(dir, "sphica.db");
    await quiet(() => dbInit(file));
    const raw = connectWriter("owner", file);
    raw.exec(`create table parent (id integer primary key not null) strict;
create table child (id integer primary key not null, parent_id integer not null references parent (id) on delete cascade) strict;
insert into parent (id) values (1);
insert into child (id, parent_id) values (1, 1);`);
    const migrations = path.join(dir, "migrations");
    const files = writeMigrations(migrations, [drop]);
    assert.throws(() => applyMigrations(raw, files, migrations), /not authorized/, drop);
    assert.equal((raw.prepare("select count(*) as n from child").get() as { n: number }).n, 1, drop);
    raw.close();
  }
  const dir = tmp();
  const file = path.join(dir, "sphica.db");
  await quiet(() => dbInit(file));
  const raw = connectWriter("owner", file);
  const migrations = path.join(dir, "migrations");
  const files = writeMigrations(migrations, [
    "/* DROP TABLE parent */\ncreate table note (id integer) strict; -- DROP TABLE parent",
  ]);
  applyMigrations(raw, files, migrations);
  assert.equal(
    (raw.prepare("pragma user_version").get() as { user_version: number }).user_version,
    SCHEMA_REVISION + 1,
  );
  raw.close();
});

// Before asking, db migrate shows what the migrations would remove (measured on a copy), and afterwards what they removed.
test("db migrate shows the rows it would remove before asking, leaving the database untouched, and what it removed", async () => {
  const dir = tmp();
  const file = path.join(dir, "sphica.db");
  await quiet(() => dbInit(file));
  const w = connectWriter("owner", file);
  w.exec("insert into project (key, name) values ('git:a/b', 'a/b'), ('git:c/d', 'c/d'), ('git:e/f', 'e/f')");
  w.close();
  const migrations = path.join(dir, "migrations");
  writeMigrations(migrations, ["delete from project where key <> 'git:a/b';\n"]);
  const lines: string[] = [];
  const log = console.log;
  console.log = (s: string) => lines.push(String(s));
  let seen = "";
  try {
    const outcome = await migrate(false, file, migrations, async () => {
      seen = lines.join("\n");
      assert.equal(inspect(file).revision, SCHEMA_REVISION, "the preview does not touch the database");
      return true;
    });
    assert.equal(outcome, "applied");
  } finally {
    console.log = log;
  }
  assert.match(seen, /Would remove: project 2 rows \(3 → 1\)/);
  assert.match(lines.join("\n"), /Removed: project 2 rows \(3 → 1\)/);
  // Only the database and its journal remain: the preview copy is gone
  assert.deepEqual(leftovers(dir), []);
});

/** Files beside the database other than itself, its journal, and the migrations */
const leftovers = (dir: string) =>
  fs.readdirSync(dir).filter((f) => !/^sphica\.db(-wal|-shm)?$/.test(f) && f !== "migrations");

test("a migration that fails in the preview stops before asking and leaves no copy behind", async () => {
  const dir = tmp();
  const file = path.join(dir, "sphica.db");
  await quiet(() => dbInit(file));
  const migrations = path.join(dir, "migrations");
  writeMigrations(migrations, ["insert into no_such_table values (1);\n"]);
  let asked = false;
  await assert.rejects(
    quiet(() =>
      migrate(false, file, migrations, async () => {
        asked = true;
        return true;
      }),
    ),
    /no such table/,
  );
  assert.equal(asked, false);
  assert.equal(inspect(file).revision, SCHEMA_REVISION);
  assert.deepEqual(leftovers(dir), []);
});
