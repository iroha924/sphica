// The test suite's run inside its own temp directory: what it leaves there fails the run, the whole output of a failed run reaches the
// person reading it, and the directory goes away. The real sql:reach check is driven by a fake bun, so no test suite runs inside a test.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runTestsIsolated } from "../../scripts/lib/test-run.mjs";

const ROOT = path.join(import.meta.dirname, "..", "..");
/** A child environment with none of the owner's Sphica paths or git's hook variables */
const childEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.SPHICA_DB;
  delete env.SPHICA_HOME;
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  return env;
};
const node = (script: string, maxBuffer?: number) =>
  runTestsIsolated(process.execPath, ["-e", script], { cwd: ROOT, env: childEnv(), maxBuffer });

test("a clean run passes, its temp directory is the child's TMPDIR, TMP, and TEMP, and npm's compile cache there is no leftover", () => {
  const r = node(
    'const fs = require("node:fs"), os = require("node:os"), path = require("node:path"); fs.mkdirSync(path.join(os.tmpdir(), "node-compile-cache")); console.log(JSON.stringify([os.tmpdir(), process.env.TMP, process.env.TEMP]));',
  );
  assert.deepEqual(r.problems, []);
  assert.deepEqual(JSON.parse(r.stdout), [r.dir, r.dir, r.dir]);
  assert.equal(fs.existsSync(r.dir), false);
});

test("what a run leaves in its temp directory fails it by name, together with a test failure, and is removed", () => {
  const r = node(
    'const fs = require("node:fs"), os = require("node:os"), path = require("node:path"); fs.mkdirSync(path.join(os.tmpdir(), "left-dir")); fs.writeFileSync(path.join(os.tmpdir(), "left.txt"), "x"); process.exitCode = 1;',
  );
  assert.deepEqual(r.problems, [
    "the tests failed (exit 1)",
    "the tests left 2 entries in their temp directory: left-dir, left.txt",
  ]);
  assert.equal(fs.existsSync(r.dir), false);
});

test("a locked directory the run leaves is still removed", () => {
  const r = node(
    'const fs = require("node:fs"), os = require("node:os"), path = require("node:path"); const d = path.join(os.tmpdir(), "locked"); fs.mkdirSync(path.join(d, "inner"), { recursive: true }); fs.chmodSync(path.join(d, "inner"), 0); fs.chmodSync(d, 0);',
  );
  assert.deepEqual(r.problems, ["the tests left 1 entry in their temp directory: locked"]);
  assert.equal(fs.existsSync(r.dir), false);
});

test("a temp directory that cannot be read or removed is reported with the run's output, not thrown", (t) => {
  // The child puts a file where its temp directory was, so the scan fails even for root; the removal is made to fail, as when a leftover
  // process still writes there
  const r = runTestsIsolated(
    process.execPath,
    [
      "-e",
      'const fs = require("node:fs"), dir = require("node:os").tmpdir(); console.log("OUT"); fs.rmdirSync(dir); fs.writeFileSync(dir, "");',
    ],
    {
      cwd: ROOT,
      env: childEnv(),
      remove: () => {
        throw new Error("busy");
      },
    },
  );
  t.after(() => fs.rmSync(r.dir, { force: true }));
  assert.equal(r.stdout.trim(), "OUT");
  assert.equal(r.problems.length, 2, r.problems.join("\n"));
  assert.ok(
    r.problems[0]?.startsWith(`the run's temp directory ${r.dir} could not be read: ENOTDIR`),
    r.problems[0],
  );
  assert.equal(r.problems[1], `the run's temp directory ${r.dir} could not be removed: busy`);
});

test("output past the limit is a problem of its own, not a silent cut", () => {
  const r = node('process.stdout.write("x".repeat(5000));', 1000);
  assert.deepEqual(r.problems, ["the test run's output passed 1000 bytes, so it was stopped"]);
});

test("sql:reach shows a failed run's whole output and leaves no temp directory, with a fake bun standing in for the tests", (t) => {
  const bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-fake-bun-")));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  // 200 KB on each stream, then a tail the check must pass on, then a failure; the fake ends on its own, so it loses nothing itself
  fs.writeFileSync(
    path.join(bin, "bun"),
    `#!${process.execPath}\nconst big = "x".repeat(200 * 1024);\nprocess.stdout.write(big + "\\nTAIL-OUT " + process.env.TMPDIR + "\\n");\nprocess.stderr.write(big + "\\nTAIL-ERR\\n");\nprocess.exitCode = 1;\n`,
    { mode: 0o755 },
  );
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "check-sql-reach.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...childEnv(), PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
  });
  const out = `${r.stdout}${r.stderr}`;
  // Checked without echoing the 400 KB on a failure
  const brief = `${out.length} bytes, ending ${JSON.stringify(out.slice(-120))}`;
  assert.equal(r.status, 1, brief);
  assert.ok(out.includes("TAIL-OUT "), brief);
  assert.ok(out.includes("TAIL-ERR"), brief);
  assert.ok(out.includes("the tests failed (exit 1)"), brief);
  const used = /TAIL-OUT (\S+)/.exec(out)?.[1] ?? "";
  assert.ok(used && !fs.existsSync(used), `the run's temp directory ${used} is gone`);
});
