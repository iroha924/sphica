#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Commit message check. `node scripts/check-commit-msg.mjs <file>` for the commit-msg hook,
// `--range <base>..<head>` for CI (hooks can be skipped, so CI checks what was actually committed),
// `--pre-push` with Git's pre-push lines on stdin (checks the stored messages of the refs being pushed).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { commitMessageProblems } from "./lib/commit-msg.mjs";

const args = process.argv.slice(2);

/** Stored messages of the commits `git log <revs>` lists. */
function stored(revs) {
  // Read the objects a push sends, not a `git replace` view of them. Fields and commits are NUL-separated:
  // a message cannot contain NUL, so its text cannot shift the fields. No buffer cap: long branches are valid pushes.
  const out = execFileSync("git", ["--no-replace-objects", "log", "-z", "--format=%H%x00%P%x00%B", ...revs], {
    encoding: "utf8",
    maxBuffer: Number.POSITIVE_INFINITY,
  }).split("\0");
  const commits = [];
  for (let i = 0; i + 2 < out.length; i += 3) {
    const sha = (out[i] ?? "").replace(/^\n/, "");
    const parents = out[i + 1] ?? "";
    commits.push({
      sha,
      name: sha.slice(0, 7),
      body: out[i + 2] ?? "",
      merge: parents.split(" ").length > 1,
    });
  }
  return commits;
}

/** Whether any remote-tracking ref exists to tell new commits from ones already pushed. */
function hasRemoteRefs() {
  return (
    execFileSync("git", ["for-each-ref", "--count=1", "refs/remotes"], { encoding: "utf8" }).trim() !== ""
  );
}

/** Commits each pushed branch adds: those on neither the remote's old tip nor any remote-tracking ref. */
function pushed(stdin) {
  const seen = new Map();
  for (const line of stdin.split("\n")) {
    const [, local, ref, remote] = line.trim().split(/\s+/);
    // A deletion pushes no commits, and notes and other metadata refs hold commits Git writes itself.
    if (!local || /^0+$/.test(local) || !/^refs\/(heads|tags)\//.test(ref ?? "")) continue;
    let known = remote !== undefined && !/^0+$/.test(remote);
    if (known) {
      try {
        execFileSync("git", ["cat-file", "-e", `${remote}^{commit}`], { stdio: "ignore" });
      } catch {
        known = false; // the remote moved to a commit not fetched here
      }
    }
    if (!known && !hasRemoteRefs()) {
      // With no base, the whole history would be checked and old messages would block a valid push. CI checks it instead.
      console.log(`commit messages: ${local.slice(0, 7)} skipped (no remote-tracking refs to compare with)`);
      continue;
    }
    // Commits merged in from another remote branch (main with messages from before the rule) are already pushed.
    for (const m of stored([local, ...(known ? [`^${remote}`] : []), "--not", "--remotes"]))
      seen.set(m.sha, m);
  }
  return [...seen.values()];
}

const messages =
  args[0] === "--range"
    ? stored([args[1] ?? ""])
    : args[0] === "--pre-push"
      ? pushed(fs.readFileSync(0, "utf8"))
      : [
          {
            name: "this commit",
            body: fs.readFileSync(args[0] ?? "", "utf8"),
            merge: mergeInProgress(),
            hook: true,
          },
        ];

/** Git's comment character for templates (core.commentChar), `#` when unset or `auto`. */
function commentChar() {
  try {
    const c = execFileSync("git", ["config", "core.commentChar"], { encoding: "utf8" }).trim();
    return c && c !== "auto" ? c : "#";
  } catch {
    return "#";
  }
}

/** Git's commit.cleanup, `default` when unset. */
function cleanupMode() {
  try {
    return execFileSync("git", ["config", "commit.cleanup"], { encoding: "utf8" }).trim() || "default";
  } catch {
    return "default";
  }
}

/** `git merge` leaves MERGE_HEAD while it waits for the message. */
function mergeInProgress() {
  try {
    const dir = execFileSync("git", ["rev-parse", "--git-dir"], { encoding: "utf8" }).trim();
    return fs.existsSync(path.join(dir, "MERGE_HEAD"));
  } catch {
    return false;
  }
}

// Read once: one `git config` per commit made a 300-commit push take about 10 seconds.
const comment = commentChar();
const cleanup = cleanupMode();
let failed = 0;
for (const m of messages) {
  const problems = commitMessageProblems(m.body, {
    merge: m.merge,
    hook: m.hook === true,
    commentChar: comment,
    cleanup,
  });
  if (!problems.length) continue;
  failed++;
  // A fetched commit's subject is outside text: control characters must not rewrite the terminal.
  const subject = [...(m.body.split("\n")[0] ?? "")]
    .map((ch) => {
      const n = ch.codePointAt(0) ?? 0;
      return n < 0x20 || (n >= 0x7f && n <= 0x9f) ? "?" : ch;
    })
    .join("");
  console.error(`${m.name}: ${subject}`);
  for (const p of problems) console.error(`  - ${p}`);
}
if (failed) process.exit(1);
console.log(`commit messages: ${messages.length} checked`);
