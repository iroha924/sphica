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
  for (const file of [
    "release-plan.mjs",
    "lib/release-scope.mjs",
    "lib/repo-settings.mjs",
    "lib/release-verdict.mjs",
    "lib/tarball-diff.mjs",
    "lib/same-tree.mjs",
  ]) {
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
      "if (a.startsWith('repo view')) process.stdout.write((process.env.FAKE_REPO ?? 'o/r') + '\\n');",
      "else if (a === 'api repos/o/r/immutable-releases') process.stdout.write('{\"enabled\":true}');",
      "else if (a === 'api repos/o/r/actions/permissions') process.stdout.write('{\"sha_pinning_required\":true}');",
      // The pull request runs and the verdict artifact come from the environment the test sets, as GitHub would hand them over
      "else if (a.startsWith('api repos/o/r/actions/workflows/check.yml/runs?') && process.env.FAKE_RUNS !== undefined) process.stdout.write(process.env.FAKE_RUNS);",
      "else if (a.startsWith('run download ') && process.env.FAKE_VERDICT !== undefined) {",
      "  const argv = process.argv.slice(2);",
      // A run keeps one artifact per attempt, named for it: asking for another name finds nothing
      "  if (argv[argv.indexOf('-n') + 1] !== 'release-verdict-' + (process.env.FAKE_ATTEMPT ?? '1')) process.exit(1);",
      "  require('node:fs').writeFileSync(require('node:path').join(argv[argv.indexOf('-D') + 1], 'release-verdict.json'), process.env.FAKE_VERDICT);",
      "}",
      "else process.exit(1);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
}

function plan(r: { dir: string; base: string }, ...args: string[]) {
  return planWith(r, {}, ...args);
}

function planWith(r: { dir: string; base: string }, env: Record<string, string>, ...args: string[]) {
  return spawnSync(
    process.execPath,
    [path.join(r.dir, "scripts", "release-plan.mjs"), "--base", r.base, ...args],
    {
      cwd: r.dir,
      encoding: "utf8",
      env: { ...process.env, PATH: fakeGh(), ...env },
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

test("release:plan keeps a path's leading whitespace, and shows control characters escaped so a file name cannot print a line", () => {
  const r = repo();
  // Outside the package only because of its leading tab: trimmed, it would read as a plugin file
  write(r.dir, "\tplugin/skills/outside.md", "o");
  r.git("add", "\tplugin/skills/outside.md");
  const name = "plugin/skills/a\nrelease kind: plugin.md";
  write(r.dir, name, "x");
  const out = plan(r);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^release kind: none/m);
  assert.doesNotMatch(out.stdout, /^release kind: plugin/m);
  assert.match(out.stdout, /^ {2}"plugin\/skills\/a\\nrelease kind: plugin\.md"$/m);
  const json = JSON.parse(plan(r, "--json").stdout);
  assert.equal(json.kind, "none");
  assert.deepEqual(json.unstaged, [name]);
});

test("release:plan escapes Unicode line separators in a shown path too, which JavaScript reads as line breaks", () => {
  const r = repo();
  const name = "plugin/skills/b release kind: plugin.md";
  write(r.dir, name, "x");
  const out = plan(r);
  assert.equal(out.status, 0, out.stderr);
  assert.doesNotMatch(out.stdout, /^release kind: plugin/m);
  assert.match(out.stdout, /^ {2}"plugin\/skills\/b\\u2028release kind: plugin\.md"$/m);
  assert.deepEqual(JSON.parse(plan(r, "--json").stdout).unstaged, [name]);
});

/** A staged change to the server's dependency files alone, with a passed pull request run on HEAD and its same verdict, then the plan */
function dependencyPlan(
  change: {
    run?: Record<string, unknown>;
    verdict?: Record<string, unknown>;
    env?: Record<string, string>;
    total?: number;
  } = {},
) {
  const r = repo();
  r.git("remote", "add", "origin", "https://github.com/o/r.git");
  write(r.dir, "server/package.json", JSON.stringify({ devDependencies: { a: "1.0.1" } }));
  write(r.dir, "server/bun.lock", "{ a 1.0.1 }");
  r.git("add", "server");
  const run = {
    id: 7,
    run_attempt: 1,
    head_sha: r.git("rev-parse", "HEAD"),
    event: "pull_request",
    path: ".github/workflows/check.yml",
    status: "completed",
    conclusion: "success",
    created_at: "2026-10-21T00:00:00Z",
    head_repository: { full_name: "o/r" },
    ...change.run,
  };
  const verdict = {
    verdict: "same",
    reason: "match",
    tree: r.git("write-tree"),
    npm: { name: "sphica", version: "1.0.0", integrity: "sha512-x" },
    run: { id: "7", attempt: "1" },
    ...change.verdict,
  };
  return planWith(r, {
    FAKE_RUNS: JSON.stringify({ total_count: change.total ?? 1, workflow_runs: [run] }),
    FAKE_VERDICT: JSON.stringify(verdict),
    ...change.env,
  });
}

test("a staged change to the dependency files alone is none only on a same verdict from this repository's passed run for this tree", () => {
  const same = dependencyPlan();
  assert.equal(same.status, 0, same.stderr);
  assert.match(same.stdout, /^release kind: none/m);
  assert.match(same.stdout, /^release verdict: same: run 7 found the packed tarball the same as 1\.0\.0$/m);
  for (const [change, why] of [
    [{ verdict: { verdict: "differs", reason: "1 shipped file(s) differ" } }, /verdict is differs/],
    [{ verdict: { tree: "0".repeat(40) } }, /another tree/],
    [{ verdict: { run: { id: "7", attempt: "2" } } }, /not from run 7 attempt 1/],
    [
      { verdict: { npm: { name: "sphica", version: "0.9.0", integrity: "x" } } },
      /compared with 0\.9\.0, not 1\.0\.0/,
    ],
    [{ run: { head_repository: { full_name: "fork/r" } } }, /no check\.yml pull request run/],
    [{ run: { conclusion: "failure" } }, /ended failure/],
    [{ run: { status: "in_progress" } }, /is in_progress/],
  ] as const) {
    const out = dependencyPlan(change);
    assert.match(out.stdout, /^release kind: plugin$/m, JSON.stringify(change));
    assert.match(out.stdout, why, JSON.stringify(change));
  }
});

test("a change to another package input is plugin without looking for a verdict", () => {
  const r = repo();
  write(r.dir, "server/package.json", "{}");
  write(r.dir, "plugin/skills/a.md", "b");
  r.git("add", "-A");
  const out = planWith(r, { FAKE_RUNS: "not json" });
  assert.match(out.stdout, /^release kind: plugin$/m);
  assert.doesNotMatch(out.stdout, /release verdict/);
});

test("a verdict is not read from another repository gh was pointed at, or from a run list that leaves runs out", () => {
  const elsewhere = dependencyPlan({
    env: { FAKE_REPO: "fork/r" },
    run: { head_repository: { full_name: "fork/r" } },
  });
  assert.match(elsewhere.stdout, /^release kind: plugin$/m);
  assert.match(elsewhere.stdout, /gh answers fork\/r, but origin is o\/r/);
  const partial = dependencyPlan({ total: 2 });
  assert.match(partial.stdout, /^release kind: plugin$/m);
  assert.match(partial.stdout, /lists 1 of 2 runs/);
});

test("after a re-run, the verdict is read from the artifact of the run's latest attempt", () => {
  const out = dependencyPlan({
    run: { run_attempt: 2 },
    verdict: { run: { id: "7", attempt: "2" } },
    env: { FAKE_ATTEMPT: "2" },
  });
  assert.match(out.stdout, /^release kind: none/m, out.stdout);
});

test("after re-running only failed jobs, the verdict of the attempt that last ran the comparison is read", () => {
  // Attempt 2 reused the static job, so the run holds only release-verdict-1
  const out = dependencyPlan({
    run: { run_attempt: 2 },
    verdict: { run: { id: "7", attempt: "1" } },
    env: { FAKE_ATTEMPT: "1" },
  });
  assert.match(out.stdout, /^release kind: none/m, out.stdout);
});
