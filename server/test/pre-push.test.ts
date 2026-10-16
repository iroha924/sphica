// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The pre-push hook: Git's lines are read strictly, an update of main runs verify and any other push runs check, and a bad commit message
// or line stops the push before either runs. The end-to-end cases push from a throwaway repository with a fake bun.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pushLines, scriptFor } from "../../scripts/lib/pre-push.mjs";

const ROOT = path.join(import.meta.dirname, "..", "..");
const A = "a".repeat(40);
const B = "b".repeat(40);
const Z = "0".repeat(40);

test("Git's four fields are read whatever the local side names, and anything else is refused by line", () => {
  const { lines } = pushLines(
    [
      `refs/heads/x ${A} refs/heads/x ${B}`,
      `HEAD~1 ${A} refs/heads/y ${Z}`,
      `(delete) ${Z} refs/heads/old ${B}`,
      `refs/tags/v1 ${A} refs/tags/v1 ${Z}`,
      `refs/heads/s ${"c".repeat(64)} refs/heads/s ${"0".repeat(64)}`,
      "",
    ].join("\n"),
  );
  assert.equal(lines?.length, 5);
  assert.deepEqual(lines?.[1], { localRef: "HEAD~1", localOid: A, remoteRef: "refs/heads/y", remoteOid: Z });
  for (const bad of [
    `refs/heads/x ${A} refs/heads/x ${B}\nfoo`,
    `refs/heads/x ${A} refs/heads/x`,
    `refs/heads/x ${A} refs/heads/x ${B} extra`,
    `refs/heads/x ${A.slice(1)} refs/heads/x ${B}`,
    `refs/heads/x ${A} heads/x ${B}`,
    `refs/heads/x  ${A} refs/heads/x ${B}`,
  ])
    assert.match(pushLines(bad).bad ?? "", /^line \d+ is not/, bad);
});

test("only an update of main runs verify; a branch, a tag, or deleting main runs check", () => {
  const line = (local: string, oid: string, remote: string) => ({
    localRef: local,
    localOid: oid,
    remoteRef: remote,
    remoteOid: B,
  });
  assert.equal(scriptFor([line("HEAD", A, "refs/heads/main")]), "verify");
  assert.equal(
    scriptFor([line("refs/heads/x", A, "refs/heads/x"), line("HEAD", A, "refs/heads/main")]),
    "verify",
  );
  assert.equal(scriptFor([line("refs/heads/x", A, "refs/heads/x")]), "check");
  assert.equal(scriptFor([line("refs/tags/main", A, "refs/tags/main")]), "check");
  assert.equal(scriptFor([line("(delete)", Z, "refs/heads/main")]), "check");
  assert.equal(scriptFor([]), "check");
});

/** A repository with a remote-tracking main and a branch on top, whose last commit has `message` */
function repository(t: { after: (fn: () => void) => void }, message: string) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-pre-push-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd: dir,
      env,
      encoding: "utf8",
    }).trim();
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "chore: start");
  const base = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", base);
  git("commit", "-q", "--allow-empty", "-m", message);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const seen = path.join(dir, "seen.json");
  fs.writeFileSync(
    path.join(bin, "bun"),
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ args: process.argv.slice(2), gitDir: process.env.GIT_DIR ?? null }));\n`,
    { mode: 0o755 },
  );
  const push = (stdin: string) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "pre-push.mjs")], {
      cwd: dir,
      input: stdin,
      encoding: "utf8",
      // A hook gets GIT_DIR from git; it must not reach what the hook runs
      env: { ...env, GIT_DIR: path.join(dir, ".git"), PATH: `${bin}${path.delimiter}${env.PATH ?? ""}` },
    });
    const ran = fs.existsSync(seen) ? JSON.parse(fs.readFileSync(seen, "utf8")) : null;
    fs.rmSync(seen, { force: true });
    return { status: r.status, out: `${r.stdout}${r.stderr}`, ran };
  };
  return { head: git("rev-parse", "HEAD"), base, push };
}

test("a push from a repository runs check for a branch and verify for main, without git's variables", (t) => {
  const repo = repository(t, "feat: add a thing");
  const branch = repo.push(`refs/heads/x ${repo.head} refs/heads/x ${Z}\n`);
  assert.equal(branch.status, 0, branch.out);
  assert.deepEqual(branch.ran, { args: ["run", "check"], gitDir: null });
  assert.match(branch.out, /commit messages: 1 checked/);
  const main = repo.push(`refs/heads/main ${repo.head} refs/heads/main ${repo.base}\n`);
  assert.equal(main.status, 0, main.out);
  assert.deepEqual(main.ran, { args: ["run", "verify"], gitDir: null });
});

test("a bad commit message or a malformed line stops the push before anything runs", (t) => {
  const repo = repository(t, "added a thing");
  const bad = repo.push(`refs/heads/x ${repo.head} refs/heads/x ${Z}\n`);
  assert.equal(bad.status, 1, bad.out);
  assert.match(bad.out, /added a thing/);
  assert.equal(bad.ran, null);
  const malformed = repo.push(`refs/heads/x ${repo.head} refs/heads/x ${Z}\nnot a line\n`);
  assert.equal(malformed.status, 1, malformed.out);
  assert.match(malformed.out, /line 2 is not/);
  assert.equal(malformed.ran, null);
});
