#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Counts whether the SQL call sites in server/src ran against a real SQLite database in tests.
//
// **Type checks and unit tests let SQL that never runs pass.** Tests really run SQL against SQLite in a temp directory,
// so a call site that ran was accepted by SQLite, including syntax, constraints, and the authorizer. This checks only
// whether each site ran, and lists the ones that did not as file:line.
//
// Reach is counted with V8 coverage (scripts/lib/coverage.mjs, the same tool as the child process lane).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { coveredSites } from "./lib/coverage.mjs";
import { unmeasured } from "./lib/coverage-report.mjs";
import { root } from "./lib/live-harness.mjs";
import { ALLOWED_UNCOVERED, callSites, LIVE_FILES } from "./lib/sql-call-sites.mjs";
import { runTestsIsolated } from "./lib/test-run.mjs";

// Source files that hold only types: nothing in them runs, so the coverage report never lists them
const TYPES_ONLY = ["db-types.ts"];

// A failure is printed and the process left to end on its own: exiting at once would drop output still waiting in the pipe
function main() {
  const covDir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-sql-reach-"));
  try {
    reach(covDir);
  } finally {
    fs.rmSync(covDir, { recursive: true, force: true });
  }
}

function reach(covDir) {
  // Counting and testing happen in one command. Separately, a change of order alone could count runs that never happened and go green.
  // The tests run in a temp directory of their own, so anything a test leaves behind fails the run by name
  const r = runTestsIsolated("bun", ["run", "--cwd", "server", "test"], {
    cwd: root,
    env: { ...process.env, NODE_V8_COVERAGE: covDir },
  });
  if (r.problems.length) {
    // node --test writes failure details to stdout.
    console.error("tests did not pass cleanly, so reach cannot be counted. Fix `bun run test` first.\n");
    console.error(`${r.stdout}${r.stderr}`);
    for (const p of r.problems) console.error(`  ${p}`);
    process.exitCode = 1;
    return;
  }
  // The test output is hidden on success, so a randomized run shows its seed here to be rerun in the same order
  const seeds = new Set(`${r.stdout}${r.stderr}`.match(/Randomized test order seed: \d+/g));
  for (const s of seeds) console.log(s);

  // The test command's thresholds count only the files a test loaded, and pass at 100% when its pattern matches none
  const sources = fs
    .readdirSync(path.join(root, "server", "src"), { recursive: true })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.basename(f));
  const missing = unmeasured(`${r.stdout}${r.stderr}`, sources, TYPES_ONLY);
  if (missing.length) {
    console.error(
      `the coverage report does not list ${missing.length} of ${sources.length} files in server/src, so the thresholds did not count them:\n  ${missing.join("\n  ")}`,
    );
    console.error(
      "\nHave a test load each file, or add one that holds only types to TYPES_ONLY in scripts/check-sql-reach.mjs.",
    );
    process.exitCode = 1;
    return;
  }

  const sites = callSites(root).filter((s) => !LIVE_FILES.some((f) => s.startsWith(`${f}:`)));
  const covered = coveredSites(covDir, root, sites);
  if (covered.size === 0) {
    console.error("no reached sites were counted. Coverage output may be broken.");
    process.exitCode = 1;
    return;
  }
  const uncovered = sites.filter((s) => !covered.has(s));
  const byFile = new Map();
  for (const s of uncovered) {
    const file = s.slice(0, s.lastIndexOf(":"));
    byFile.set(file, [...(byFile.get(file) ?? []), s]);
  }

  const ledger = [];
  for (const [file, list] of [...byFile].sort()) {
    const allowed = ALLOWED_UNCOVERED.find((a) => a.file === file);
    if (!allowed)
      ledger.push(`${file}: ${list.length} sites are not run by any test\n    ${list.join("\n    ")}`);
    else if (list.length > allowed.uncovered)
      ledger.push(
        `${file}: unrun call sites grew from ${allowed.uncovered} to ${list.length}\n    ${list.join("\n    ")}`,
      );
  }
  for (const a of ALLOWED_UNCOVERED) {
    const now = (byFile.get(a.file) ?? []).length;
    if (now < a.uncovered)
      ledger.push(`${a.file}: unrun call sites dropped to ${now}. Lower the count in ALLOWED_UNCOVERED`);
    // Check the total too. A swap that reaches one site and adds another nets zero in the unrun count alone.
    const total = sites.filter((s) => s.startsWith(`${a.file}:`)).length;
    if (total !== a.sites)
      ledger.push(`${a.file}: call sites changed from ${a.sites} to ${total}. Review ALLOWED_UNCOVERED`);
  }
  if (ledger.length) {
    console.error("some call sites never run their SQL.\n");
    for (const l of ledger) console.error(`  ${l}`);
    console.error(
      "\nIf one cannot be run, add it with a reason to ALLOWED_UNCOVERED in scripts/lib/sql-call-sites.mjs.",
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `SQL: tests ran ${sites.length - uncovered.length} / ${sites.length} sites against a real SQLite database` +
      (uncovered.length
        ? ` (the other ${uncovered.length} are listed with reasons in ALLOWED_UNCOVERED)`
        : ""),
  );
}

main();
