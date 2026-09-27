import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dbInit, inspect, reindex } from "../src/admin.ts";
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

test("reindex rebuilds the full-text index and passes the doctor check", async () => {
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

// A reindex that fails midway leaves the index as it was instead of half rebuilt
test("reindex that fails rolls back and rethrows", async () => {
  const dir = tmp();
  const file = path.join(dir, "sphica.db");
  await quiet(() => dbInit(file));
  const raw = new DatabaseSync(file);
  raw.exec("drop table source_fts");
  raw.close();
  await assert.rejects(
    quiet(() => reindex(file)),
    /source_fts/,
  );
});

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
  for (const args of [
    ["db", "init"],
    ["check"],
    ["trace", "pending"],
    ["capture", "flush"],
    ["project", "list"],
  ]) {
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
test("a boxed command that fails prints its heading once and closes with Stopped", () => {
  const home = tmp();
  const r = spawnSync(process.execPath, [CLI, "doctor", "--reindex"], {
    env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home },
    encoding: "utf8",
    timeout: 30_000,
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.notEqual(r.status, 0, out);
  assert.equal(out.split("\n").filter((l) => l === "sphica doctor --reindex").length, 1, out);
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

test("doctor says stuck recordings are sent again after the next turn", () => {
  const home = tmp();
  cli(home, "init");
  fs.mkdirSync(path.join(home, ".sphica", "spool"), { recursive: true });
  fs.writeFileSync(path.join(home, ".sphica", "spool", "1.json"), "{}");
  fs.writeFileSync(
    path.join(home, ".sphica", "capture.json"),
    JSON.stringify({ error: "database is locked" }),
  );
  const r = cli(home, "doctor");
  assert.match(r.out, /sent again after the next turn/, r.out);
});
