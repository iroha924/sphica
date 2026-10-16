#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Runs the unit tests. By default (SPHICA_UNIT_MODE unset or full) this is sql:reach: the tests with coverage, then whether every SQL
// call site ran. SPHICA_UNIT_MODE=tests-only runs the same tests without coverage, for the CI line that leaves counting to another line.

import process from "node:process";
import { sqlReach } from "./check-sql-reach.mjs";
import { root } from "./lib/live-harness.mjs";
import { runTestsIsolated } from "./lib/test-run.mjs";

const MODES = ["full", "tests-only"];

// A failure is printed and the process left to end on its own: exiting at once would drop output still waiting in the pipe
function main() {
  const mode = process.env.SPHICA_UNIT_MODE ?? "full";
  if (!MODES.includes(mode)) {
    console.error(`SPHICA_UNIT_MODE is ${JSON.stringify(mode)}; it must be one of ${MODES.join(", ")}`);
    process.exitCode = 1;
  } else if (mode === "full") sqlReach();
  else testsOnly();
}

function testsOnly() {
  // The test command takes TEST_ORDER after its coverage flags, so a later flag turns coverage off. Node copies NODE_V8_COVERAGE from
  // process.env into every child's environment that lacks it, so it is removed here, not only from the child's copy
  delete process.env.NODE_V8_COVERAGE;
  const env = {
    ...process.env,
    TEST_ORDER: `${process.env.TEST_ORDER ?? ""} --no-experimental-test-coverage`.trim(),
  };
  const r = runTestsIsolated("bun", ["run", "--cwd", "server", "test"], { cwd: root, env });
  if (r.problems.length) {
    console.error(`${r.stdout}${r.stderr}`);
    for (const p of r.problems) console.error(`  ${p}`);
    process.exitCode = 1;
    return;
  }
  for (const s of new Set(`${r.stdout}${r.stderr}`.match(/Randomized test order seed: \d+/g))) console.log(s);
  console.log(
    "unit: the tests passed without coverage; SQL reach was not counted (SPHICA_UNIT_MODE=tests-only)",
  );
}

main();
