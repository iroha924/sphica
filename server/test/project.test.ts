import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { migrate } from "../src/admin.ts";
import { connectWriter } from "../src/db-write.ts";
import {
  hostWorkspace,
  identify,
  localRoots,
  nameLocal,
  normalizeKey,
  normalizeRemote,
  patchPaths,
  projectId,
  relativeTo,
  writePlace,
} from "../src/project.ts";
import { tempDb } from "./temp-db.ts";

// These tests swap HOME to keep the name map apart; SPHICA_HOME would win over it and point at the shell's directory
delete process.env.SPHICA_HOME;

// These tests swap HOME to protect the real name map. Bun's os.homedir() ignores the swap and would rewrite the real map.
if (process.versions.bun) throw new Error("run these tests with node --test (bun run test)");

test("ssh and https remotes map to the same key", () => {
  const want = "github.com/iroha924/sphica";
  assert.equal(normalizeRemote("git@github.com:iroha924/sphica.git"), want);
  assert.equal(normalizeRemote("https://github.com/iroha924/sphica.git"), want);
  assert.equal(normalizeRemote("https://github.com/iroha924/sphica"), want);
  assert.equal(normalizeRemote("ssh://git@github.com/iroha924/sphica.git"), want);
});

// A host differing only in case, or a github.com owner or repository differing only in case, is the same repository
test("remotes differing only in case map to one key", () => {
  for (const url of [
    "git@GitHub.COM:O/R.git",
    "ssh://git@GitHub.COM/O/R.git",
    "git://GitHub.COM/O/R.git",
    "https://GitHub.COM/O/R.git",
    "https://github.com/o/r",
  ])
    assert.equal(normalizeRemote(url), "github.com/o/r", url);
  // Other hosts may tell paths apart by case, so only their host is folded
  assert.equal(normalizeRemote("git@GitLab.Example:Team/Repo.git"), "gitlab.example/Team/Repo");
  assert.equal(normalizeRemote("ssh://git@HOST"), "host");
});

test("normalizeKey folds ASCII only, is idempotent, and leaves local keys alone", () => {
  const cases: [string, string][] = [
    ["git:GitHub.COM/O/R", "git:github.com/o/r"],
    ["git:github.com/o/r", "git:github.com/o/r"],
    ["git:GitLab.Example/Team/Repo", "git:gitlab.example/Team/Repo"],
    ["git:HOST", "git:host"],
    // Non-ASCII letters keep their case, as SQLite's lower() does
    ["git:BÜCHER.example/X", "git:bÜcher.example/X"],
    ["local:my-notes", "local:my-notes"],
  ];
  for (const [key, want] of cases) {
    assert.equal(normalizeKey(key), want, key);
    assert.equal(normalizeKey(want), want, `${want} again`);
  }
});

// The key is stored in plain text. Cutting at the first @ leaves a fragment when the password contains @.
test("credentials embedded in a remote never reach the key", () => {
  for (const url of [
    "https://user:ghp_secret@github.com/o/r.git",
    "https://user:tok@en@github.com/o/r",
    "https://user:p@ss@github.com/o/r.git",
    "https://x-access-token:AKIAsecret/withslash@github.com/o/r.git",
    "https://user:pass@host:2222/o/r.git",
  ]) {
    const got = normalizeRemote(url) ?? "";
    for (const leak of ["ghp_secret", "AKIAsecret", "tok", "p@ss", "pass", "@"]) {
      assert.ok(!got.includes(leak), `${url} → ${got} still contains ${leak}`);
    }
  }
  // A port is not part of the identity. Keeping it would split one repository into two projects.
  assert.equal(normalizeRemote("https://user:pass@host:2222/o/r.git"), "host/o/r");
  assert.equal(normalizeRemote("git@gitlab.com:org/team/repo.git"), "gitlab.com/org/team/repo");
  assert.equal(normalizeRemote(""), null);
});

function repo(remote: string | null): { dir: string; done: () => void } {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-project-")));
  const dir = path.join(tmp, "repo");
  fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  if (remote) execFileSync("git", ["-C", dir, "remote", "add", "origin", remote], { stdio: "ignore" });
  return { dir, done: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

// If relative paths were based on a subdirectory, the same file would be recorded under different paths.
test("the root and key are the same from any subdirectory", () => {
  const r = repo("https://github.com/o/r.git");
  try {
    for (const d of [r.dir, path.join(r.dir, "a"), path.join(r.dir, "a", "b")]) {
      const got = identify(d);
      assert.equal(got?.key, "git:github.com/o/r");
      assert.equal(got?.root, r.dir, d);
      assert.equal(got?.name, "o/r");
    }
  } finally {
    r.done();
  }
});

// Capture spools the key as the remote is written, so a database whose keys are not normalized yet still finds its project
test("identify returns the key as the remote is written beside the normalized one", () => {
  const r = repo("git@GitHub.COM:O/R.git");
  try {
    const got = identify(r.dir);
    assert.equal(got?.key, "git:github.com/o/r");
    assert.equal(got?.legacyKey, "git:GitHub.COM/O/R");
    assert.equal(got?.name, "o/r");
  } finally {
    r.done();
  }
});

// Conversations from a place with no remote or name are not guessed into some project.
test("a place with no remote or name is not a project", () => {
  const r = repo(null);
  try {
    assert.equal(identify(r.dir), null);
    assert.equal(identify(os.tmpdir()), null);
  } finally {
    r.done();
  }
});

test("relative paths are from the root, and paths outside it are null", () => {
  assert.equal(relativeTo("/w/repo", "/w/repo/server/src/db.ts"), "server/src/db.ts");
  assert.equal(relativeTo("/w/repo", "src/db.ts", "/w/repo/server"), "server/src/db.ts");
  assert.equal(relativeTo("/w/repo", "/w/other/x.ts"), null);
  // The database refuses a path with a control character, so an edit of such a file is not recorded
  assert.equal(relativeTo("/w/repo", "/w/repo/src/a\u0007b.ts"), null);
  assert.equal(relativeTo("/w/repo", "../x.ts"), null);
  assert.equal(relativeTo("/w/repo", "/w/repo"), null);
  // A name starting with `..` is inside the root.
  assert.equal(relativeTo("/w/repo", "/w/repo/..config/a.ts"), "..config/a.ts");
  assert.equal(relativeTo("/w/repo", "/w/repo/..."), "...");
});

// Treating it as empty and writing back would erase every other project name.
test("a broken name map stops instead of being skipped, and places with a remote get no name", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-map-")));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  const r = repo(null);
  try {
    fs.mkdirSync(path.join(home, ".sphica"));
    fs.writeFileSync(path.join(home, ".sphica", "projects.json"), '{"/x": "a",');
    assert.throws(() => nameLocal(r.dir, "notes"), /is not a valid JSON project table/);
    assert.throws(() => identify(r.dir), /is not a valid JSON project table/);
    for (const invalid of [{ relative: "notes" }, { "/x": 123 }, { "/x": null }, { "/x": "INVALID" }]) {
      fs.writeFileSync(path.join(home, ".sphica", "projects.json"), JSON.stringify(invalid));
      assert.throws(() => identify(r.dir), /is not a valid JSON project table/);
    }
    fs.rmSync(path.join(home, ".sphica", "projects.json"));
    const remote = repo("git@github.com:o/r.git");
    try {
      assert.throws(() => nameLocal(remote.dir, "notes"), /has a git remote/);
    } finally {
      remote.done();
    }
    assert.equal(nameLocal(r.dir, "notes").key, "local:notes");
  } finally {
    r.done();
    process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// With two clones of the same remote, the sync would silently pick whichever sorts first.
test("does not choose when two locations share a key", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-roots-")));
  // Keep this machine's name map out (named projects would mix into found).
  const realHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    // Remotes differing only in case are one repository, so the two places share a key
    for (const [n, remote] of [
      ["one", "git@github.com:o/same.git"],
      ["two", "https://GitHub.com/O/Same.git"],
    ] as const) {
      const d = path.join(tmp, n);
      execFileSync("git", ["init", "-q", d], { stdio: "ignore" });
      execFileSync("git", ["-C", d, "remote", "add", "origin", remote], {
        stdio: "ignore",
      });
    }
    const solo = path.join(tmp, "solo");
    execFileSync("git", ["init", "-q", solo], { stdio: "ignore" });
    execFileSync("git", ["-C", solo, "remote", "add", "origin", "git@github.com:o/solo.git"], {
      stdio: "ignore",
    });
    const { found, ambiguous } = localRoots([tmp]);
    assert.equal(found.get("git:github.com/o/solo"), solo);
    assert.equal(found.has("git:github.com/o/same"), false);
    assert.deepEqual(ambiguous.get("git:github.com/o/same")?.sort(), [
      path.join(tmp, "one"),
      path.join(tmp, "two"),
    ]);
    assert.deepEqual([...localRoots(["/no/such/dir"]).found], []);
  } finally {
    process.env.HOME = realHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Taking paths from the patch body (file contents) would let written text claim any path.
test("reads edited files of a Codex patch only from the 4 header forms", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: server/src/db.ts",
    "@@",
    "-*** Update File: not/a/header.ts",
    "+x",
    "*** Add File: docs/new.md",
    "+*** Delete File: also/not.ts",
    "*** Delete File: old.ts",
    "*** Update File: a.ts",
    "*** Move to: b.ts",
    "*** End Patch",
  ].join("\n");
  assert.deepEqual(patchPaths(patch), ["server/src/db.ts", "docs/new.md", "old.ts", "a.ts", "b.ts"]);
});

// The record server writes only into the host's workspace: Claude Code names it in the environment, Codex in each call
test("a write's project is the workspace; a cwd argument naming another project is refused", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-bound-")));
  try {
    const repo = (name: string) => {
      const dir = path.join(base, name);
      fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
      execFileSync("git", ["init", "-q", dir]);
      execFileSync("git", ["-C", dir, "remote", "add", "origin", `https://github.com/o/${name}.git`]);
      return dir;
    };
    const a = repo("a");
    const b = repo("b");
    assert.equal(writePlace(a, undefined)?.key, "git:github.com/o/a");
    assert.equal(writePlace(a, path.join(a, "sub"))?.key, "git:github.com/o/a");
    assert.throws(() => writePlace(a, b), /o\/b is not the workspace this session writes to \(o\/a\)/);
    assert.equal(writePlace(path.join(base, "none"), undefined), null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the workspace Codex names in a call is read only from a file URL in its sandbox state", () => {
  const dir = path.join(os.tmpdir(), "a b");
  const named = (sandboxCwd: unknown) => hostWorkspace({ "codex/sandbox-state-meta": { sandboxCwd } });
  assert.equal(named(pathToFileURL(dir).href), dir);
  assert.equal(named(dir), null);
  assert.equal(named("https://example.test/x"), null);
  assert.equal(named(1), null);
  assert.equal(hostWorkspace(undefined), null);
  assert.equal(hostWorkspace({ sandboxCwd: pathToFileURL(dir).href }), null);
});

// The migration and the key triggers fold keys in SQL; a key either side folds differently would be refused, or split one project in two
test("normalizeKey and the database's key rules agree (parity)", () => {
  const keys = [
    "git:GitHub.COM/O/R",
    "git:github.com/O/r/Sub",
    "git:GitLab.Example/Team/Repo",
    "git:HOST",
    "git:Host.Example",
    "git:BÜCHER.example/X",
    "git:bücher.example/Ä",
    "git:github.com/Ä/B",
    "git:example.com:2222/O",
  ];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-parity-"));
  try {
    const old = connectWriter("owner", path.join(tmp, "old.db"), true);
    const fresh = connectWriter("owner", path.join(tmp, "fresh.db"), true);
    try {
      const root = path.join(import.meta.dirname, "..", "..");
      old.exec(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "schema-rev7.sql"), "utf8"));
      fresh.exec(fs.readFileSync(path.join(root, "db", "schema.sql"), "utf8"));
      keys.forEach((k, i) => {
        // Distinct names keep the keys from colliding: a suffix that folds to itself
        const key = `${k}-${i}`;
        old.prepare("insert into project (key, name) values (?, 'x')").run(key);
        const canonical = normalizeKey(key);
        fresh.prepare("insert into project (key, name) values (?, 'x')").run(canonical);
        if (canonical !== key)
          assert.throws(
            () => fresh.prepare("insert into project (key, name) values (?, 'x')").run(key),
            /the project key is not normalized/,
            key,
          );
      });
      const log = console.log;
      console.log = () => {};
      try {
        migrate(path.join(tmp, "old.db"));
      } finally {
        console.log = log;
      }
      const migrated = old
        .prepare("select key from project order by id")
        .all()
        .map((r) => r.key);
      assert.deepEqual(
        migrated,
        keys.map((k, i) => normalizeKey(`${k}-${i}`)),
      );
    } finally {
      old.close();
      fresh.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The read and record servers look a session's project up by identify's key: a mixed-case remote finds the project init registered
test("a mixed-case remote finds the project registered under the normalized key", async () => {
  const r = repo("ssh://git@GitHub.COM/O/R.git");
  const db = tempDb();
  try {
    db.owner.exec("insert into project (key, name) values ('git:github.com/o/r', 'o/r')");
    const place = identify(r.dir);
    assert.equal(await projectId(db.reader, place?.key ?? ""), 1);
  } finally {
    await db.done();
    r.done();
  }
});
