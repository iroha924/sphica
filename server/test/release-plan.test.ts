// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// release:plan classifies what is staged against the base. Edits not staged yet are not counted, so it names them instead of
// answering "none" for them in silence.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./temp-dir.ts";

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts");

// The script resolves the repository from its own path, so it runs from a copy inside the temporary repository
function repo() {
  const dir = fs.realpathSync(tempDir("sphica-release-plan-"));
  const git = (...a: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-C", dir, ...a],
      { encoding: "utf8" },
    ).trim();
  git("init", "-q");
  for (const file of ["release-plan.mjs", "lib/release-scope.mjs", "lib/repo-settings.mjs"]) {
    fs.mkdirSync(path.dirname(path.join(dir, "scripts", file)), { recursive: true });
    fs.copyFileSync(path.join(SCRIPTS, file), path.join(dir, "scripts", file));
  }
  write(dir, "plugin/package.json", JSON.stringify({ name: "sphica", version: "1.0.0" }));
  write(dir, "plugin/.claude-plugin/plugin.json", JSON.stringify({ version: "1.0.0" }));
  write(dir, "plugin/.codex-plugin/plugin.json", JSON.stringify({ version: "1.0.0" }));
  write(
    dir,
    ".claude-plugin/marketplace.json",
    JSON.stringify({
      plugins: [{ name: "sphica", source: { source: "npm", package: "sphica", version: "1.0.0" } }],
    }),
  );
  write(dir, "plugin/skills/a.md", "a");
  write(dir, "docs/notes.md", "n");
  git("add", "-A");
  git("commit", "-qm", "base");
  return { dir, git, base: git("rev-parse", "HEAD") };
}

function write(dir: string, file: string, body: string) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), body);
}

// A gh first on PATH that answers the repository name and both admin settings as on, so no call reaches GitHub
function fakeGh(): string {
  const bin = tempDir("sphica-fake-gh-");
  fs.writeFileSync(
    path.join(bin, "gh"),
    [
      `#!${process.execPath}`,
      "const a = process.argv.slice(2).join(' ');",
      "if (a.startsWith('repo view')) process.stdout.write('o/r\\n');",
      "else if (a === 'api repos/o/r/immutable-releases') process.stdout.write('{\"enabled\":true}');",
      "else if (a === 'api repos/o/r/actions/permissions') process.stdout.write('{\"sha_pinning_required\":true}');",
      "else process.exit(1);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
}

function plan(r: { dir: string; base: string }, ...args: string[]) {
  return spawnSync(
    process.execPath,
    [path.join(r.dir, "scripts", "release-plan.mjs"), "--base", r.base, ...args],
    {
      cwd: r.dir,
      encoding: "utf8",
      env: { ...process.env, PATH: fakeGh() },
    },
  );
}

test("release:plan names the package edits it did not count because they are not staged, and says it compared the index", () => {
  const r = repo();
  const clean = plan(r);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /^release kind: none/m);
  assert.match(clean.stdout, new RegExp(`^compared: ${r.base}\\.\\.index \\(HEAD ${r.base}\\)$`, "m"));
  assert.doesNotMatch(clean.stdout, /not staged/);

  // An edit to a package file, a new package file with a Japanese name, and an edit outside the package, none of them staged
  write(r.dir, "plugin/skills/a.md", "b");
  write(r.dir, "plugin/skills/新しい.md", "c");
  write(r.dir, "docs/notes.md", "m");
  const unstaged = plan(r);
  assert.equal(unstaged.status, 0, unstaged.stderr);
  assert.match(unstaged.stdout, /^release kind: none/m);
  assert.match(unstaged.stdout, /^not staged, not counted \(git add them first\): 2$/m);
  assert.match(unstaged.stdout, /^ {2}plugin\/skills\/a\.md$/m);
  assert.match(unstaged.stdout, /^ {2}plugin\/skills\/新しい\.md$/m);
  assert.doesNotMatch(unstaged.stdout, /docs\/notes\.md/);
  const json = JSON.parse(plan(r, "--json").stdout);
  assert.equal(json.kind, "none");
  assert.equal(json.compared, "index");
  assert.deepEqual(json.unstaged, ["plugin/skills/a.md", "plugin/skills/新しい.md"]);

  // Staged, the edit is counted; an edit made after staging it is still named
  r.git("add", "plugin/skills/a.md", "plugin/skills/新しい.md");
  write(r.dir, "plugin/skills/a.md", "c");
  const partly = plan(r);
  assert.equal(partly.status, 0, partly.stderr);
  assert.match(partly.stdout, /^release kind: plugin$/m);
  assert.match(partly.stdout, /^inputs: plugin\/skills\/a\.md, plugin\/skills\/新しい\.md$/m);
  assert.match(partly.stdout, /^not staged, not counted \(git add them first\): 1$/m);
  assert.deepEqual(JSON.parse(plan(r, "--json").stdout).unstaged, ["plugin/skills/a.md"]);

  r.git("add", "plugin/skills/a.md");
  const staged = plan(r);
  assert.equal(staged.status, 0, staged.stderr);
  assert.match(staged.stdout, /^release kind: plugin$/m);
  assert.doesNotMatch(staged.stdout, /not staged/);
  assert.deepEqual(JSON.parse(plan(r, "--json").stdout).unstaged, []);
});
