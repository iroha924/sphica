// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Runs the test suite with a fresh temp directory of its own as TMPDIR, TMP, and TEMP, and reports what the run left there. A run that
// fails, is stopped, or overflows its output is a problem like a leftover, and the directory is removed whatever happened.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Removes a tree even where a test locked a directory it made: each directory is opened again first (links are never followed) */
function removeTree(dir) {
  const open = (d) => {
    fs.chmodSync(d, 0o700);
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      if (fs.lstatSync(full).isDirectory()) open(full);
    }
  };
  open(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

const UNFINISHED = "a run that did not finish proves nothing about the tests";
const LEFTOVERS = "a test that leaves files behind can make a later test pass or fail by chance";

/**
 * Runs `command` with `args`; `problems` says why it did not pass cleanly, each with why it matters and the fix (empty when it did), beside the run's whole output. `remove`
 * is how the directory goes away, and `uid` the user the tests run as, both replaced only by tests.
 */
export function runTestsIsolated(
  command,
  args,
  { cwd, env, maxBuffer = 64 * 1024 * 1024, remove = removeTree, uid = process.getuid?.() },
) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-test-run-")));
  const result = { stdout: "", stderr: "", problems: [], dir };
  try {
    const r = spawnSync(command, args, {
      cwd,
      env: { ...env, TMPDIR: dir, TMP: dir, TEMP: dir },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer,
    });
    result.stdout = r.stdout ?? "";
    result.stderr = r.stderr ?? "";
    if (r.error)
      result.problems.push(
        r.error.code === "ENOBUFS"
          ? {
              what: `the test run's output passed ${maxBuffer} bytes, so it was stopped`,
              why: UNFINISHED,
              fix: "find the test that prints that much in the output below and make it quieter",
            }
          : {
              what: `the test run could not finish: ${r.error.message}`,
              why: UNFINISHED,
              fix: `check that ${command} starts (run \`mise install\` for the pinned tools)`,
            },
      );
    else if (r.signal)
      result.problems.push({
        what: `the test run was stopped by ${r.signal}`,
        why: UNFINISHED,
        fix: "run `bun run test` to see where it stops: a test may hang or run out of memory",
      });
    else if (r.status !== 0) {
      result.problems.push({
        what: `the tests failed (exit ${r.status})`,
        why: "a failing test means the change broke what that test checks",
        fix: "fix each test marked `not ok` in the output below",
      });
      // Root reads and removes a file whatever its mode, so the tests that make one unreadable or unremovable fail without a word on why
      if (uid === 0)
        result.problems.push({
          what: "the tests ran as root",
          why: "root reads and removes files whatever their permissions, so the tests that make a file unreadable or unremovable fail as root alone",
          fix: "run the tests as a normal user, as CI does; a failure that remains as a normal user is the change's",
        });
    }
    let left;
    try {
      // npm keeps a compile cache in the temp directory, also for a child given only TMPDIR; it is a tool's cache, not a leftover
      left = fs
        .readdirSync(dir)
        .filter((name) => name !== "node-compile-cache")
        .sort();
    } catch (e) {
      result.problems.push({
        what: `the run's temp directory ${dir} could not be read: ${e.message}`,
        why: LEFTOVERS,
        fix: "check that the system temp directory can be read and written",
      });
      left = [];
    }
    if (left.length)
      result.problems.push({
        what: `the tests left ${left.length} entr${left.length === 1 ? "y" : "ies"} in their temp directory: ${left.slice(0, 50).join(", ")}${left.length > 50 ? ", ..." : ""}`,
        why: LEFTOVERS,
        fix: "have the test that writes each entry remove it, with tempDir from server/test/temp-dir.ts",
      });
  } finally {
    try {
      remove(dir);
    } catch (e) {
      // A process a test left running can still be writing there; the run's output and problems must still be shown
      result.problems.push({
        what: `the run's temp directory ${dir} could not be removed: ${e.message}`,
        why: "a process a test left running may still be writing there",
        fix: "have the test wait for or stop each process it starts",
      });
    }
  }
  return result;
}
