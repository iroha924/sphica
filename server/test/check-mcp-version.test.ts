import "./isolate-home.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "check-mcp-version.mjs",
);

function repo(): { dir: string; git: (...a: string[]) => string; done: () => void } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-version-")));
  const git = (...a: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-C", dir, ...a],
      { encoding: "utf8" },
    ).trim();
  git("init", "-q");
  return { dir, git, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function write(dir: string, file: string, body: string) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), body);
}

function bump(dir: string, version: string) {
  write(dir, "plugin/package.json", JSON.stringify({ name: "sphica", version }));
  // The version lives in source (putting it directly in the entry too makes Claude Code silently prefer plugin.json).
  write(
    dir,
    ".claude-plugin/marketplace.json",
    JSON.stringify({
      plugins: [{ name: "sphica", source: { source: "npm", package: "sphica", version } }],
    }),
  );
  write(dir, "plugin/.claude-plugin/plugin.json", JSON.stringify({ version }));
  write(dir, "plugin/.codex-plugin/plugin.json", JSON.stringify({ version }));
}

function bumpPackage(dir: string, version: string) {
  write(dir, "plugin/package.json", JSON.stringify({ name: "sphica", version }));
}

function check(dir: string, ...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
}

// In CI the index equals HEAD right after checkout, so without a base commit the check always passes.
test("with a base, fails a range that changes the plugin afterwards without a version bump", () => {
  const r = repo();
  try {
    bump(r.dir, "1.0.0");
    write(r.dir, "plugin/skills/a.md", "a");
    write(r.dir, "README.ja.md", "r");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    const base = r.git("rev-parse", "HEAD");

    write(r.dir, "plugin/skills/a.md", "b");
    r.git("commit", "-qam", "change only the plugin");
    const missed = check(r.dir, "--base", base);
    assert.equal(missed.status, 1, missed.stderr);
    assert.match(missed.stderr, /plugin\/skills\/a\.md/);

    bump(r.dir, "1.0.1");
    r.git("commit", "-qam", "bump the version");
    const bumped = check(r.dir, "--base", base);
    assert.equal(bumped.status, 0, bumped.stderr);

    const head = r.git("rev-parse", "HEAD");
    write(r.dir, "README.ja.md", "s");
    r.git("commit", "-qam", "change only non-plugin files");
    const other = check(r.dir, "--base", head);
    assert.equal(other.status, 0, other.stderr);
  } finally {
    r.done();
  }
});

test("without a base, compares staged plugin changes with the HEAD version", () => {
  const r = repo();
  try {
    bump(r.dir, "1.0.0");
    write(r.dir, "plugin/skills/a.md", "a");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");

    write(r.dir, "plugin/skills/a.md", "b");
    const unstaged = check(r.dir);
    assert.equal(unstaged.status, 0, unstaged.stderr);

    r.git("add", "-A");
    assert.equal(check(r.dir).status, 1);

    // If the version bump is not staged, the commit does not include it.
    bump(r.dir, "1.0.1");
    assert.equal(check(r.dir).status, 1);

    bump(r.dir, "1.0.1");
    r.git("add", "-A");
    const bumped = check(r.dir);
    assert.equal(bumped.status, 0, bumped.stderr);
  } finally {
    r.done();
  }
});

test("even for server.ts, once shipped only via npm, bumping only the npm package version fails and matching the plugin channel passes", () => {
  const r = repo();
  try {
    bump(r.dir, "1.0.0");
    write(r.dir, "server/src/server.ts", "a");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    const base = r.git("rev-parse", "HEAD");

    write(r.dir, "server/src/server.ts", "b");
    bumpPackage(r.dir, "1.0.1");
    r.git("add", "-A");
    const packageOnly = check(r.dir, "--base", base);
    assert.equal(packageOnly.status, 1, packageOnly.stderr);
    assert.match(packageOnly.stderr, /were not bumped together/);

    bump(r.dir, "1.0.1");
    r.git("add", "-A");
    const bumped = check(r.dir, "--base", base);
    assert.equal(bumped.status, 0, bumped.stderr);
  } finally {
    r.done();
  }
});

test("fails a commit that changes only the marketplace source without a version bump", () => {
  const r = repo();
  try {
    bump(r.dir, "1.0.0");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    const base = r.git("rev-parse", "HEAD");
    write(
      r.dir,
      ".claude-plugin/marketplace.json",
      JSON.stringify({
        plugins: [{ name: "sphica", source: { source: "npm", package: "sphica-fork", version: "1.0.0" } }],
      }),
    );
    r.git("commit", "-qam", "change only the source");
    const missed = check(r.dir, "--base", base);
    assert.equal(missed.status, 1, missed.stderr);
    assert.match(missed.stderr, /marketplace\.json/);
  } finally {
    r.done();
  }
});

test("fails a commit that lowers the version, even without shipped changes", () => {
  const r = repo();
  try {
    bump(r.dir, "1.2.0");
    write(r.dir, "plugin/skills/a.md", "a");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    const base = r.git("rev-parse", "HEAD");

    bump(r.dir, "1.1.9");
    r.git("commit", "-qam", "lower only the version");
    const down = check(r.dir, "--base", base);
    assert.equal(down.status, 1, down.stderr);
    assert.match(down.stderr, /version goes down/);

    write(r.dir, "plugin/skills/a.md", "b");
    r.git("commit", "-qam", "change shipped files too");
    const changed = check(r.dir, "--base", base);
    assert.equal(changed.status, 1, changed.stderr);

    // Compare as numbers (as strings, 1.10.0 < 1.9.0)
    bump(r.dir, "1.10.0");
    r.git("commit", "-qam", "bump");
    const up = check(r.dir, "--base", base);
    assert.equal(up.status, 0, up.stderr);
  } finally {
    r.done();
  }
});

test("a commit that only bumps all 4 versions together is not counted as a shipped change and passes", () => {
  const r = repo();
  try {
    bump(r.dir, "1.0.0");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    const base = r.git("rev-parse", "HEAD");
    bump(r.dir, "1.0.1");
    r.git("commit", "-qam", "version only");
    const only = check(r.dir, "--base", base);
    assert.equal(only.status, 0, only.stderr);
  } finally {
    r.done();
  }
});

test("without a base, a work branch compares against its fork point from main (one bump in the branch covers later commits)", () => {
  const r = repo();
  try {
    bump(r.dir, "1.0.0");
    write(r.dir, "plugin/skills/a.md", "a");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    const base = r.git("rev-parse", "HEAD");
    r.git("branch", "-M", "main");
    r.git("update-ref", "refs/remotes/origin/main", "HEAD");

    r.git("switch", "-q", "-c", "feature");
    write(r.dir, "plugin/skills/a.md", "b");
    bump(r.dir, "1.0.1");
    r.git("add", "-A");
    r.git("commit", "-qm", "change and bump");

    write(r.dir, "plugin/skills/a.md", "c");
    r.git("add", "-A");
    const next = check(r.dir);
    assert.equal(next.status, 0, next.stderr);

    // If main shipped the same version after the fork, fail until the branch goes above it (CI compares with the current main)
    r.git("reset", "-q", "--hard");
    r.git("switch", "-q", "main");
    bump(r.dir, "1.0.1");
    write(r.dir, "plugin/skills/b.md", "main");
    r.git("add", "-A");
    r.git("commit", "-qm", "main ships the same number");
    r.git("switch", "-q", "feature");
    write(r.dir, "plugin/skills/a.md", "c2");
    r.git("add", "-A");
    assert.equal(check(r.dir).status, 1);
    r.git("reset", "-q", "--hard");
    // A branch that does not change shipped files is not blocked even when main has moved ahead
    r.git("switch", "-q", "-c", "docs", base);
    write(r.dir, "README.ja.md", "ja");
    r.git("add", "-A");
    const docs = check(r.dir);
    assert.equal(docs.status, 0, docs.stderr);
    r.git("reset", "-q", "--hard");
    r.git("switch", "-q", "feature");

    // Lowering the version within a branch fails even if it stays above the fork point
    bump(r.dir, "1.0.2");
    r.git("add", "-A");
    r.git("commit", "-qm", "bump again");
    bump(r.dir, "1.0.1");
    r.git("add", "-A");
    assert.equal(check(r.dir).status, 1);

    // Fail if the branch never bumped the version
    r.git("reset", "-q", "--hard");
    r.git("switch", "-q", "-c", "other", "main");
    write(r.dir, "plugin/skills/a.md", "d");
    r.git("add", "-A");
    assert.equal(check(r.dir).status, 1);

    // On main, compare with HEAD as before
    r.git("reset", "-q", "--hard");
    r.git("switch", "-q", "main");
    write(r.dir, "plugin/skills/a.md", "e");
    r.git("add", "-A");
    assert.equal(check(r.dir).status, 1);
  } finally {
    r.done();
  }
});

// Versions order within one package name. A renamed package starts its own line, so a range from the old name may start lower.
test("a range that renames the package may start its versions over, and a lower version under the same name still fails", () => {
  const r = repo();
  try {
    bump(r.dir, "3.0.0");
    write(r.dir, "plugin/package.json", JSON.stringify({ name: "old-name", version: "3.0.0" }));
    write(r.dir, "plugin/skills/a.md", "a");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    const base = r.git("rev-parse", "HEAD");

    bump(r.dir, "0.1.0");
    write(r.dir, "plugin/skills/a.md", "b");
    r.git("add", "-A");
    const staged = check(r.dir);
    assert.equal(staged.status, 0, staged.stderr);
    r.git("commit", "-qm", "rename and start over");
    const renamed = check(r.dir, "--base", base);
    assert.equal(renamed.status, 0, renamed.stderr);

    bump(r.dir, "0.0.9");
    r.git("add", "-A");
    const lower = check(r.dir);
    assert.equal(lower.status, 1, "a lower version under the new name still fails");
    assert.match(lower.stderr, /goes down from 0\.1\.0 to 0\.0\.9/);
  } finally {
    r.done();
  }
});
