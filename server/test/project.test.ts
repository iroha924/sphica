import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  identify,
  localRoots,
  nameLocal,
  normalizeRemote,
  patchPaths,
  relativeTo,
  writePlace,
} from "../src/project.ts";

// These tests swap HOME to protect the real name map. Bun's os.homedir() ignores the swap and would rewrite the real map.
if (process.versions.bun) throw new Error("run these tests with node --test (bun run test)");

test("ssh and https remotes map to the same key", () => {
  const want = "github.com/iroha924/sphica";
  assert.equal(normalizeRemote("git@github.com:iroha924/sphica.git"), want);
  assert.equal(normalizeRemote("https://github.com/iroha924/sphica.git"), want);
  assert.equal(normalizeRemote("https://github.com/iroha924/sphica"), want);
  assert.equal(normalizeRemote("ssh://git@github.com/iroha924/sphica.git"), want);
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
    for (const n of ["one", "two"]) {
      const d = path.join(tmp, n);
      execFileSync("git", ["init", "-q", d], { stdio: "ignore" });
      execFileSync("git", ["-C", d, "remote", "add", "origin", "git@github.com:o/same.git"], {
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

// The record server writes only into the host's workspace: Claude Code names it, Codex starts the server in it
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
