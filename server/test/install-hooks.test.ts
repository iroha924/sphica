// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// install-hooks.mjs against a throwaway repository and a worktree of it, with a fake lefthook that writes the path of the tree it was
// started from into the shared hook, as the real one writes its binary's path.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { tempDir } from "./temp-dir.ts";

const SCRIPT = path.join(import.meta.dirname, "..", "..", "scripts", "install-hooks.mjs");
const FAKE = `const fs = require("node:fs");
const path = require("node:path");
if (process.argv[2] !== "install") process.exit(2);
if (process.env.FAKE_LEFTHOOK_FAIL) process.exit(3);
const hooks = require("node:child_process").execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks"], { encoding: "utf8" }).trim();
fs.mkdirSync(hooks, { recursive: true });
fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\\n" + process.cwd() + "/server/node_modules/lefthook\\n");
`;

/** A repository with a fake lefthook, and a worktree of it with its own */
function repos() {
  const dir = fs.realpathSync(tempDir("sphica-hooks-"));
  const main = path.join(dir, "main");
  const git = (cwd: string, ...a: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a],
      {
        cwd,
        encoding: "utf8",
      },
    );
  fs.mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  git(main, "commit", "-q", "--allow-empty", "-m", "initial");
  const worktree = path.join(dir, "wt");
  git(main, "worktree", "add", "-q", worktree);
  for (const tree of [main, worktree]) {
    const bin = path.join(tree, "server", "node_modules", "lefthook", "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "index.js"), FAKE);
  }
  return { main, worktree, hook: path.join(main, ".git", "hooks", "pre-commit") };
}

const install = (cwd: string, env: Record<string, string | undefined> = {}) => {
  const e: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete e[k];
  // The shell running the tests may itself run inside a git hook; only the variables a test sets reach the script
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) if (!(k in env)) delete e[k];
  return spawnSync(process.execPath, [SCRIPT], { cwd, env: e, encoding: "utf8" });
};
const hash = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test("from the main working tree the hooks are installed, pointing at that tree", () => {
  const { main, hook } = repos();
  const r = install(main, { CI: undefined });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(hook, "utf8"), new RegExp(`${main}/server/node_modules/lefthook`));
});

test("in CI nothing is installed", () => {
  const { main, hook } = repos();
  const r = install(main, { CI: "true" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /not installed in CI/);
  assert.equal(fs.existsSync(hook), false);
});

test("from a worktree the shared hooks stay as they are, and none are made", () => {
  const { main, worktree, hook } = repos();
  const none = install(worktree, { CI: undefined });
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /not installed from the worktree/);
  assert.equal(fs.existsSync(hook), false);
  assert.equal(install(main, { CI: undefined }).status, 0);
  const before = hash(hook);
  const again = install(worktree, { CI: undefined });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(hash(hook), before);
});

test("a failed install, or a directory outside any repository, fails setup", () => {
  const { main } = repos();
  const failed = install(main, { CI: undefined, FAKE_LEFTHOOK_FAIL: "1" });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /lefthook install ended with 3/);
  const outside = install(fs.realpathSync(tempDir("sphica-no-repo-")), { CI: undefined });
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /cannot tell whether this is the main working tree/);
});

test("git variables a hook passes on, naming the main repository, do not make a worktree install", () => {
  const { main, worktree, hook } = repos();
  assert.equal(install(main, { CI: undefined }).status, 0);
  const before = hash(hook);
  const r = install(worktree, {
    CI: undefined,
    GIT_DIR: path.join(main, ".git"),
    GIT_WORK_TREE: main,
    GIT_INDEX_FILE: path.join(main, ".git", "index"),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /not installed from the worktree/);
  assert.equal(hash(hook), before);
});
