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

/**
 * Runs `command` with `args`; `problems` says why it did not pass cleanly (empty when it did), beside the run's whole output. `remove`
 * is how the directory goes away, replaced only by tests.
 */
export function runTestsIsolated(
  command,
  args,
  { cwd, env, maxBuffer = 64 * 1024 * 1024, remove = removeTree },
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
          ? `the test run's output passed ${maxBuffer} bytes, so it was stopped`
          : `the test run could not finish: ${r.error.message}`,
      );
    else if (r.signal) result.problems.push(`the test run was stopped by ${r.signal}`);
    else if (r.status !== 0) result.problems.push(`the tests failed (exit ${r.status})`);
    let left;
    try {
      // npm keeps a compile cache in the temp directory, also for a child given only TMPDIR; it is a tool's cache, not a leftover
      left = fs
        .readdirSync(dir)
        .filter((name) => name !== "node-compile-cache")
        .sort();
    } catch (e) {
      result.problems.push(`the run's temp directory ${dir} could not be read: ${e.message}`);
      left = [];
    }
    if (left.length)
      result.problems.push(
        `the tests left ${left.length} entr${left.length === 1 ? "y" : "ies"} in their temp directory: ${left.slice(0, 50).join(", ")}${left.length > 50 ? ", ..." : ""}`,
      );
  } finally {
    try {
      remove(dir);
    } catch (e) {
      // A process a test left running can still be writing there; the run's output and problems must still be shown
      result.problems.push(`the run's temp directory ${dir} could not be removed: ${e.message}`);
    }
  }
  return result;
}
