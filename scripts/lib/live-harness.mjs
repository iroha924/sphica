// Plumbing for running the shipped entry points as child processes against a real database.
//
// The parent owns the timeout and termination. Tests connecting to a database, which `.claude/rules/verification.md` forbids,
// came from pools held open that never returned. With a child process, the parent can take that responsibility from outside.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

export const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..");

/** Time limit for a child process. Past it, the child is killed and that counts as a check failure. */
const TIMEOUT_MS = 120_000;

/** A throwaway project. It gets a git remote so the project key is stable. */
export function makeRepo(dir, remote = "https://github.com/example/live.git", name = "repo") {
  const repo = path.join(dir, name);
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("remote", "add", "origin", remote);
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  // english-exempt: Japanese document fixture committed to the temp repository
  fs.writeFileSync(path.join(repo, "docs/design.md"), "# 設計\n\n判断の理由をここに書く。\n");
  // english-exempt: Japanese document fixture committed to the temp repository
  fs.writeFileSync(path.join(repo, "README.md"), "# live\n\n検査のためのプロジェクト。\n");
  git("add", "-A");
  git("commit", "-qm", "docs");
  return repo;
}

/**
 * Installs a fake `gh` answering the REST paths harvest reads (`gh api repos/<repo>/<path>`) with one merged pull request.
 * It never reaches GitHub. A comment carries terminal control sequences, to check that context output drops them.
 */
export function fakeGh(dir) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env node
const argv = process.argv.slice(2);
const where = (argv[1] ?? "").replace(/^repos\\/[^/]+\\/[^/]+\\//, "").split("?")[0];
const user = { login: "someone", id: 7, type: "User" };
const at = (h) => \`2026-09-01T0\${h}:00:00Z\`;
const answers = {
  "pulls/1": { number: 1, title: "First", body: "Use the real database for checks.", html_url: "https://example.invalid/1",
    created_at: at(0), merged_at: at(5), merged_by: user, user, author_association: "OWNER" },
  "issues/1/comments": [{ id: 11, body: "Checked \\u001b[2J\\u001b]0;pwn\\u0007\\rhere", user, author_association: "CONTRIBUTOR", created_at: at(1), html_url: "u" }],
  "pulls/1/reviews": [],
  "pulls/1/comments": [],
  "pulls/1/commits": [{ sha: "0123456789abcdef0123456789abcdef01234567", author: user, commit: { message: "fix: check on the real database", author: { date: at(2) } } }],
};
if (!(where in answers)) { process.stderr.write(\`fake gh: no answer for \${argv[1]}\\n\`); process.exit(1); }
process.stdout.write(JSON.stringify(argv.includes("--slurp") ? [answers[where]] : answers[where]));
`,
    { mode: 0o755 },
  );
}

/**
 * The child process environment. The database is ~/.sphica/sphica.db in the temp HOME (created by `sphica init`).
 * No GitHub key is passed.
 */
function childEnv(dir, covDir, extra = {}) {
  const env = { ...process.env, ...extra };
  // **Swap home.** Otherwise the child uses the owner's ~/.sphica.
  // `capture flush` reads the queue in ~/.sphica/spool and deletes what it sent (measured: it sent the owner's
  // 4 unsent items to the throwaway database and removed them from the spool). Changing only the database path does not close this.
  env.HOME = dir;
  env.USERPROFILE = dir;
  // If the parent's SPHICA_DB remained, the child would open that database instead of the temp HOME one.
  for (const k of ["SPHICA_DB", "GITHUB_TOKEN"]) delete env[k];
  // Host sessions leak in from the parent. With both present the CLI stops because it cannot tell which host it is,
  // so keep only what the check passes.
  for (const k of ["CODEX_THREAD_ID", "CODEX_SESSION_ID"]) delete env[k];
  if (!("CLAUDE_CODE_SESSION_ID" in extra)) delete env.CLAUDE_CODE_SESSION_ID;
  // Capture decides whether a turn is the owner's from the parent session. A leftover parent value would conflict with the
  // session the check passes, and nothing would be queued (measured: the hook exited 0 with an empty spool).
  if (!("SPHICA_PARENT_SESSION" in extra)) delete env.SPHICA_PARENT_SESSION;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return {
    ...env,
    NODE_V8_COVERAGE: covDir,
    PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`,
  };
}

/** Runs the CLI once. Failures do not stop it (the goal is reach, and callers judge success). */
export function runCli(args, dir, covDir, { cwd = root, ...extra } = {}) {
  const r = spawnSync("node", [path.join(root, "server/src/cli.ts"), ...args], {
    cwd,
    env: childEnv(dir, covDir, extra),
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, timedOut: r.signal === "SIGTERM" };
}

/**
 * Runs the capture hook once. The spool lives under home, so this relies on childEnv
 * swapping home (so the owner's queue is never read).
 */
export function runHook(input, dir, covDir, extra = {}) {
  const r = spawnSync("node", [path.join(root, "server/src/capture.ts")], {
    cwd: extra.cwd ?? root,
    env: childEnv(dir, covDir, extra),
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Creates a temp directory and deletes it afterwards. */
export async function withTempDir(fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-live-")));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
