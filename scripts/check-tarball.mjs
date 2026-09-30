#!/usr/bin/env node
// Checks an npm pack tarball the way users receive it (run by CI check and release). Usage: node scripts/check-tarball.mjs <tgz>
// It checks the file list (scripts/lib/tarball.mjs), that the version matches the repository, that the CLI starts outside the repository and creates a database in a temp HOME,
// and that an older database gets the version-naming notice from the delivery hook and a backup before init migrates it

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hasBannedName } from "./lib/banned-name.mjs";
import { tarballProblems, trackedDistribution } from "./lib/tarball.mjs";

const tgz = process.argv[2] && path.resolve(process.argv[2]);
if (!tgz) throw new Error("pass the tarball path");
const root = path.resolve(import.meta.dirname, "..");
const paths = new Set(
  execFileSync("tar", ["tzf", tgz], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !f.endsWith("/"))
    .map((f) => f.replace(/^package\//, "")),
);
const problems = tarballProblems(paths, trackedDistribution(root));
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}

// **Extract outside the repository.** Inside it, a wrong bundle would still resolve by walking up and pass.
const out = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-tarball-"));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-home-"));
// Do not pass SPHICA_DB or SPHICA_HOME, which point to the owner's database, to the child (only the temp HOME database is created,
// and the fake gh's account must never be bound in the owner's)
const parentEnv = { ...process.env };
delete parentEnv.SPHICA_DB;
delete parentEnv.SPHICA_HOME;
// init reads the signed-in account through gh: a fake gh first on PATH answers, so the runner's gh never reaches api.github.com
const bin = path.join(home, "fake-gh");
fs.mkdirSync(bin);
fs.writeFileSync(
  path.join(bin, "gh"),
  `#!${process.execPath}\nconst a = process.argv.slice(2);\nif (a[0] === "api" && a[1] === "user") process.stdout.write('{"id":42,"login":"hana"}');\nelse process.exit(1);\n`,
  { mode: 0o755 },
);
parentEnv.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
try {
  execFileSync("tar", ["xzf", tgz, "-C", out]);
  const pkg = path.join(out, "package");
  const cli = (...args) =>
    execFileSync(process.execPath, [path.join(pkg, "dist", "cli.js"), ...args], {
      cwd: out,
      encoding: "utf8",
      env: { ...parentEnv, HOME: home, USERPROFILE: home },
    });
  const version = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).version;
  const expected = JSON.parse(fs.readFileSync(path.join(root, "plugin", "package.json"), "utf8")).version;
  if (version !== expected)
    throw new Error(`tarball is ${version}, but the repository version is ${expected} (stale tarball)`);
  const named = cli("--version").trim().split(/\s+/)[0];
  if (named !== version)
    throw new Error(`the tarball CLI reported ${named}, but the package version is ${version}`);
  cli("--help");
  cli("doctor", "--help");
  const init = cli("init");
  if (!fs.existsSync(path.join(home, ".sphica", "sphica.db")))
    throw new Error("init did not create a database");
  if (!/GitHub account hana \(id 42\) bound as the owner/.test(init))
    throw new Error(`init did not bind the GitHub account gh answered\n${init}`);
  // doctor can exit 1 on this machine's plugin install state; only its GitHub owner line is checked here
  let doctor;
  try {
    doctor = cli("doctor");
  } catch (e) {
    doctor = `${e.stdout ?? ""}`;
  }
  if (!/✓ GitHub owner\s+hana \(id 42\)/.test(doctor))
    throw new Error(`doctor did not show the bound GitHub account\n${doctor}`);
  // After a plugin update the database can be a revision behind. The shipped hook names the CLI version to install, and that version's init
  // backs the database up before migrating it
  const behind = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-behind-"));
  try {
    const schemas = path.join(root, "server", "test", "fixtures");
    const older = Math.max(
      ...fs.readdirSync(schemas).map((f) => Number(/^schema-rev(\d+)\.sql$/.exec(f)?.[1] ?? 0)),
    );
    fs.mkdirSync(path.join(behind, ".sphica"));
    const file = path.join(behind, ".sphica", "sphica.db");
    const raw = new DatabaseSync(file);
    raw.exec("pragma journal_mode = wal");
    raw.exec(fs.readFileSync(path.join(schemas, `schema-rev${older}.sql`), "utf8"));
    // Records the shipped migration must carry over: a project, a session, and one message of the owner. The index triggers need the
    // tokenizer to compile; this stand-in is never used for the index, which the migration rebuilds with the real one
    raw.function("sphica_terms", (text) => String(text ?? ""));
    const when = "2026-09-01T00:00:00.000Z";
    raw.exec(
      `insert into project (key, name) values ('git:github.com/example/behind', 'example/behind');
       insert into session (id, project_id, host, external_id, started_at) values ('s1', 1, 'claude-code', 'e1', '${when}');`,
    );
    raw
      .prepare(
        "insert into source (project_id, kind, artifact, external_id, revision, session_id, author_kind, created_at, captured_at, text, original_bytes, content_hash, indexed) values (1, 'session_message', 'session:s1', 'm1', 1, 's1', 'owner', ?, ?, 'Use SQLite.', 11, zeroblob(32), 0)",
      )
      .run(when, when);
    raw.close();
    const repo = path.join(behind, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/example/behind.git"], { cwd: repo });
    const env = { ...parentEnv, HOME: behind, USERPROFILE: behind };
    const said = execFileSync(process.execPath, [path.join(pkg, "dist", "deliver.js")], {
      cwd: repo,
      encoding: "utf8",
      env,
      input: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: `tarball-${process.pid}-${Date.now()}`,
        cwd: repo,
      }),
    });
    if (!said.includes(`npm i -g sphica@${version}\``))
      throw new Error(
        `the delivery hook did not name sphica@${version} for a revision ${older} database\n${said}`,
      );
    const migrated = execFileSync(process.execPath, [path.join(pkg, "dist", "cli.js"), "init"], {
      cwd: out,
      encoding: "utf8",
      env,
    });
    if (
      !/Backed up: /.test(migrated) ||
      !new RegExp(`Migrated: .*\\(revision ${older} → \\d+\\)`).test(migrated)
    )
      throw new Error(`init did not back up and migrate a revision ${older} database\n${migrated}`);
    const [backup] = fs.readdirSync(path.join(behind, ".sphica", "backups"));
    const copy = new DatabaseSync(path.join(behind, ".sphica", "backups", backup ?? ""), { readOnly: true });
    const at = copy.prepare("pragma user_version").get().user_version;
    copy.close();
    if (at !== older) throw new Error(`the backup is at revision ${at}, not ${older}`);
    const after = new DatabaseSync(path.join(behind, ".sphica", "sphica.db"), { readOnly: true });
    const now = after.prepare("pragma user_version").get().user_version;
    const kept = after.prepare("select count(*) as n from source where external_id = 'm1'").get().n;
    after.close();
    if (now <= older || kept !== 1)
      throw new Error(`the migrated database is at revision ${now} with ${kept} of its 1 message`);
  } finally {
    fs.rmSync(behind, { recursive: true, force: true });
  }
  const filesIn = (dir) =>
    fs
      .readdirSync(dir, { withFileTypes: true, recursive: true })
      .filter((e) => e.isFile())
      .map((e) => path.join(e.parentPath, e.name));
  const banned = filesIn(pkg).filter(
    (f) => hasBannedName(path.relative(pkg, f)) || hasBannedName(fs.readFileSync(f, "latin1")),
  );
  if (banned.length)
    throw new Error(
      `the tarball has the banned name in ${banned.map((f) => path.relative(pkg, f)).join(", ")}`,
    );
  // The package ships no web UI (the UI is the terminal). Assets left here mean bundle forgot to remove them
  if (fs.existsSync(path.join(pkg, "dist", "dashboard")))
    throw new Error("tarball still contains dist/dashboard");
  console.log(
    `tarball: ${paths.size} files matching the shipped list. CLI ${version} started, created a database, bound the GitHub account, and backed up and migrated an older database the hook named the version for`,
  );
} finally {
  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}
