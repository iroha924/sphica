// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The unit entry, driven by a fake bun so no test suite runs inside a test: full mode is sql:reach, tests-only runs the tests without
// coverage and still fails on a failed run or a leftover, and any other mode is refused before anything runs.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.join(import.meta.dirname, "..", "..");

/** Runs scripts/run-unit.mjs with a fake bun first on PATH; the fake writes what it was given to `seen` and runs `body` */
function run(t: { after: (fn: () => void) => void }, mode: string | undefined, body = "") {
  const bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-fake-bun-")));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const seen = path.join(bin, "seen.json");
  fs.writeFileSync(
    path.join(bin, "bun"),
    `#!${process.execPath}\nconst fs = require("node:fs"), os = require("node:os"), path = require("node:path");\nfs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ args: process.argv.slice(2), order: process.env.TEST_ORDER ?? null, coverage: process.env.NODE_V8_COVERAGE ?? null }));\n${body}\n`,
    { mode: 0o755 },
  );
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
  delete env.SPHICA_DB;
  delete env.SPHICA_HOME;
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  env.TEST_ORDER = "--test-randomize";
  env.NODE_V8_COVERAGE = path.join(bin, "inherited-coverage");
  if (mode === undefined) delete env.SPHICA_UNIT_MODE;
  else env.SPHICA_UNIT_MODE = mode;
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "run-unit.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
    env,
  });
  const read = () =>
    fs.existsSync(seen)
      ? (JSON.parse(fs.readFileSync(seen, "utf8")) as {
          args: string[];
          order: string | null;
          coverage: string | null;
        })
      : null;
  return { status: r.status, out: `${r.stdout}${r.stderr}`, seen: read(), inherited: env.NODE_V8_COVERAGE };
}

test("tests-only runs the server tests with coverage turned off after the inherited order, and no coverage directory", (t) => {
  const r = run(t, "tests-only");
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.seen, {
    args: ["run", "--cwd", "server", "test"],
    order: "--test-randomize --no-experimental-test-coverage",
    coverage: null,
  });
  assert.match(r.out, /SQL reach was not counted/);
});

test("tests-only fails on a failed run and on what the run left behind", (t) => {
  const failed = run(t, "tests-only", "process.exitCode = 1;");
  assert.equal(failed.status, 1, failed.out);
  assert.match(failed.out, /the tests failed \(exit 1\)/);
  const left = run(t, "tests-only", 'fs.writeFileSync(path.join(os.tmpdir(), "left.txt"), "x");');
  assert.equal(left.status, 1, left.out);
  assert.match(left.out, /left 1 entry in their temp directory: left\.txt/);
});

test("a mode that is neither full nor tests-only is refused before any test runs", (t) => {
  for (const mode of ["", "tests_only", "off"]) {
    const r = run(t, mode);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /SPHICA_UNIT_MODE is .*\. Why: .*\. Fix: set it to one of full, tests-only/);
    assert.equal(r.seen, null, mode);
  }
});

test("full mode, named or by default, is sql:reach: coverage goes to a directory of its own, and a run that reports none fails", (t) => {
  for (const mode of [undefined, "full"]) {
    const r = run(t, mode);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /does not hold exactly one coverage report/);
    assert.equal(r.seen?.order, "--test-randomize");
    assert.ok(r.seen?.coverage && r.seen.coverage !== r.inherited, String(r.seen?.coverage));
  }
});
