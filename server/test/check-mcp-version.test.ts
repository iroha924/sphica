// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

import "./isolate-home.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertFindings } from "./finding-shape.ts";

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
    assertFindings(missed.stderr, "check-mcp-version");

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

test("a change to README.md alone needs no version bump, staged on main or in a range, and one made with a shipped file still does", () => {
  const r = repo();
  try {
    r.git("checkout", "-q", "-B", "main");
    bump(r.dir, "1.0.0");
    write(r.dir, "README.md", "a");
    write(r.dir, "plugin/skills/a.md", "a");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    const base = r.git("rev-parse", "HEAD");

    write(r.dir, "README.md", "b");
    r.git("add", "-A");
    const staged = check(r.dir);
    assert.equal(staged.status, 0, staged.stderr);
    r.git("commit", "-qm", "change only the README");
    const ranged = check(r.dir, "--base", base);
    assert.equal(ranged.status, 0, ranged.stderr);

    const readme = r.git("rev-parse", "HEAD");
    write(r.dir, "README.md", "c");
    write(r.dir, "plugin/skills/a.md", "b");
    r.git("add", "-A");
    const mixed = check(r.dir);
    assert.equal(mixed.status, 1, mixed.stderr);
    // The README is not the file the failure names
    assert.match(mixed.stderr, /^plugin\/skills\/a\.md: 1 package input\(s\) changed/m);
    assert.doesNotMatch(mixed.stderr, /README/);
    r.git("commit", "-qm", "change the README and the plugin");
    assert.equal(check(r.dir, "--base", readme).status, 1);
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
    // Only the npm package name changes: every version still agrees, so only the input check can catch it
    const market = JSON.parse(fs.readFileSync(path.join(r.dir, ".claude-plugin/marketplace.json"), "utf8"));
    market.plugins[0].source.package = "sphica-fork";
    write(r.dir, ".claude-plugin/marketplace.json", JSON.stringify(market));
    r.git("commit", "-qam", "change only the source");
    const missed = check(r.dir, "--base", base);
    assert.equal(missed.status, 1, missed.stderr);
    assert.match(missed.stderr, /\.claude-plugin\/marketplace\.json.*were not bumped together/);
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

/** A repository at 1.0.0 whose next commit changes only the server's dependency files, unless more files are given */
function dependencyChange(r: ReturnType<typeof repo>, more: Record<string, string> = {}) {
  bump(r.dir, "1.0.0");
  write(r.dir, "server/package.json", JSON.stringify({ devDependencies: { a: "1.0.0" } }));
  write(r.dir, "server/bun.lock", "{ a 1.0.0 }");
  r.git("add", "-A");
  r.git("commit", "-qm", "base");
  const base = r.git("rev-parse", "HEAD");
  write(r.dir, "server/package.json", JSON.stringify({ devDependencies: { a: "1.0.1" } }));
  write(r.dir, "server/bun.lock", "{ a 1.0.1 }");
  for (const [file, body] of Object.entries(more)) write(r.dir, file, body);
  r.git("add", "-A");
  r.git("commit", "-qm", "dev dependency");
  return base;
}

/** A verdict file as scripts/release-verdict.mjs writes it, for the repository's HEAD and the given base unless overridden */
function verdictFile(r: ReturnType<typeof repo>, base: string, fields: Record<string, unknown> = {}) {
  // Inside .git: out of the tree and the index the check reads, and removed with the repository
  const file = path.join(r.dir, ".git", "verdict.json");
  const v = {
    verdict: "same",
    reason: "match",
    paths: [],
    tree: r.git("rev-parse", "HEAD^{tree}"),
    base,
    npm: { name: "sphica", version: "1.0.0", integrity: "sha512-x" },
    ...fields,
  };
  fs.writeFileSync(file, JSON.stringify(v));
  return file;
}

test("a dependency-only change still needs a bump by default, and --defer-deps leaves it to CI", () => {
  const r = repo();
  try {
    const base = dependencyChange(r);
    // A work branch: on main nothing is deferred
    r.git("checkout", "-qb", "work");
    const plain = check(r.dir, "--base", base);
    assert.equal(plain.status, 1, plain.stdout);
    assert.match(plain.stderr, /server\/(package\.json|bun\.lock)/);
    const deferred = check(r.dir, "--base", base, "--defer-deps");
    assert.equal(deferred.status, 0, deferred.stderr);
    assert.match(deferred.stdout, /CI compares the packed tarball/);
  } finally {
    r.done();
  }
});

test("--defer-deps and a same verdict do not cover a change to any other package input", () => {
  const r = repo();
  try {
    const base = dependencyChange(r, { "server/src/a.ts": "export {};\n" });
    assert.equal(check(r.dir, "--base", base, "--defer-deps").status, 1);
    assert.equal(check(r.dir, "--base", base, "--verdict", verdictFile(r, base)).status, 1);
  } finally {
    r.done();
  }
});

test("--verdict lets a dependency-only change through only on same, for this tree and this base", () => {
  const r = repo();
  try {
    const base = dependencyChange(r);
    const same = check(r.dir, "--base", base, "--verdict", verdictFile(r, base));
    assert.equal(same.status, 0, same.stderr);
    assert.match(same.stdout, /matches the last release/);
    for (const [fields, why] of [
      [{ verdict: "differs", reason: "1 shipped file(s) differ" }, /verdict is differs/],
      [{ verdict: "unknown", reason: "sphica@1.0.0 is not published" }, /verdict is unknown/],
      [{ tree: "0".repeat(40) }, /another tree/],
      [
        { npm: { name: "sphica", version: "0.9.0", integrity: "x" } },
        /compared with 0\.9\.0, not the base's 1\.0\.0/,
      ],
    ] as const) {
      const res = check(r.dir, "--base", base, "--verdict", verdictFile(r, base, fields));
      assert.equal(res.status, 1, JSON.stringify(fields));
      assert.match(res.stderr, why);
      assert.match(res.stderr, /were not bumped together/);
    }
    const missing = check(r.dir, "--base", base, "--verdict", path.join(r.dir, "absent.json"));
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /cannot be read/);
  } finally {
    r.done();
  }
});

test("a bumped dependency change passes with a verdict that is not same", () => {
  const r = repo();
  try {
    const base = dependencyChange(r);
    bump(r.dir, "1.0.1");
    r.git("commit", "-qam", "bump");
    const res = check(r.dir, "--base", base, "--verdict", verdictFile(r, base, { verdict: "unknown" }));
    assert.equal(res.status, 0, res.stderr);
  } finally {
    r.done();
  }
});

test("a same verdict for HEAD does not cover a dependency change staged after it", () => {
  const r = repo();
  try {
    const base = dependencyChange(r);
    const verdict = verdictFile(r, base);
    write(r.dir, "server/bun.lock", "{ a 1.0.2, b 1.0.0 }");
    r.git("add", "server/bun.lock");
    const res = check(r.dir, "--base", base, "--verdict", verdict);
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stderr, /another tree/);
  } finally {
    r.done();
  }
});

test("neither --defer-deps nor a same verdict lets npm and the plugin channel versions part", () => {
  const r = repo();
  try {
    const base = dependencyChange(r);
    bumpPackage(r.dir, "1.0.1");
    r.git("commit", "-qam", "bump npm alone");
    for (const flag of [["--defer-deps"], ["--verdict", verdictFile(r, base)]]) {
      const res = check(r.dir, "--base", base, ...flag);
      assert.equal(res.status, 1, `${flag[0]}: ${res.stdout}`);
    }
  } finally {
    r.done();
  }
});

test("on main, --defer-deps does not defer: a direct commit there has no pull request CI to decide", () => {
  const r = repo();
  try {
    r.git("checkout", "-qB", "main");
    const base = dependencyChange(r);
    write(r.dir, "server/bun.lock", "{ a 1.0.2 }");
    r.git("add", "server/bun.lock");
    const res = check(r.dir, "--defer-deps");
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stderr, /were not bumped together/);
    assert.ok(base);
  } finally {
    r.done();
  }
});
