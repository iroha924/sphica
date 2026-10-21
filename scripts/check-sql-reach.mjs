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
import { unmeasured } from "./lib/coverage-report.mjs";
import { coveredSites } from "./lib/coverage.mjs";
import { finding, guard, report } from "./lib/finding.mjs";
import { root } from "./lib/live-harness.mjs";
import { ALLOWED_UNCOVERED, callSites, LIVE_FILES } from "./lib/sql-call-sites.mjs";
import { runTestsIsolated } from "./lib/test-run.mjs";

guard("sql:reach");

// Source files that hold only types: nothing in them runs, so the coverage report never lists them
const TYPES_ONLY = ["src/db-types.ts"];
const SELF = "scripts/check-sql-reach.mjs";
const LEDGER = "scripts/lib/sql-call-sites.mjs";
const UNRUN =
  "SQL that no test runs can hold what SQLite rejects, and neither types nor unit tests notice (invariant real-sqlite-tests)";

// A failure is printed and the process left to end on its own: exiting at once would drop output still waiting in the pipe
export function sqlReach() {
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
    // node --test writes failure details to stdout, so the whole output goes with the first finding
    report(
      "sql:reach",
      r.problems.map((p, i) =>
        finding({
          where: "bun run test",
          ...p,
          why: `${p.why}, and reach is counted only from a clean run`,
          detail: i === 0 ? `${r.stdout}${r.stderr}` : undefined,
        }),
      ),
    );
    return;
  }
  // The test output is hidden on success, so a randomized run shows its seed here to be rerun in the same order
  const seeds = new Set(`${r.stdout}${r.stderr}`.match(/Randomized test order seed: \d+/g));
  for (const s of seeds) console.log(s);

  // The test command's thresholds count only the files a test loaded, and pass at 100% when its pattern matches none
  // Spelled as the report's tree spells them ("src/cli/view.ts"), so two files of one name in different directories stay apart
  const sources = fs
    .readdirSync(path.join(root, "server", "src"), { recursive: true })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `src/${f.split(path.sep).join("/")}`);
  const missing = unmeasured(`${r.stdout}${r.stderr}`, sources, TYPES_ONLY);
  if (!missing) {
    report("sql:reach", [
      finding({
        where: "bun run test",
        what: "the test output does not hold exactly one coverage report",
        why: "which files the coverage thresholds counted cannot be told from it",
        fix: "find the test that prints a coverage report of its own (one that runs node --test with coverage) and quiet it",
      }),
    ]);
    return;
  }
  if (
    report(
      "sql:reach",
      missing.map((f) =>
        finding({
          where: `server/${f}`,
          what: "the coverage report does not list the file",
          why: "the coverage thresholds count only the files a test loaded, so none of its lines are counted",
          fix: `have a test import it, or add it to TYPES_ONLY in ${SELF} if it holds only types`,
        }),
      ),
    )
  )
    return;

  const sites = callSites(root).filter((s) => !LIVE_FILES.some((f) => s.startsWith(`${f}:`)));
  const covered = coveredSites(covDir, root, sites);
  if (covered.size === 0) {
    report("sql:reach", [
      finding({
        where: "scripts/lib/coverage.mjs",
        what: "no reached call site was counted",
        why: "coverage output that cannot be read makes every site look unrun, or hides that none is",
        fix: "check that the test run writes V8 coverage to NODE_V8_COVERAGE and that coveredSites reads it",
      }),
    ]);
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
      ledger.push(
        ...list.map((site) =>
          finding({
            where: site,
            what: "no test runs the SQL at this call site",
            why: UNRUN,
            fix: `run it in a test against a temp database (server/test/temp-db.ts), or, if no test can, add the file with the reason to ALLOWED_UNCOVERED in ${LEDGER}`,
          }),
        ),
      );
    else if (list.length > allowed.uncovered)
      ledger.push(
        finding({
          where: file,
          what: `unrun call sites grew from ${allowed.uncovered} to ${list.length}`,
          why: UNRUN,
          fix: `run the new sites in a test against a temp database (server/test/temp-db.ts), or raise uncovered in ${LEDGER} with the reason`,
          detail: list.join("\n"),
        }),
      );
  }
  for (const a of ALLOWED_UNCOVERED) {
    const now = (byFile.get(a.file) ?? []).length;
    if (now < a.uncovered)
      ledger.push(
        finding({
          where: LEDGER,
          what: `${a.file} allows ${a.uncovered} unrun call sites, but only ${now} are unrun now`,
          why: "an allowance larger than needed would let a site stop being run unseen",
          fix: `lower uncovered for ${a.file} to ${now} in ALLOWED_UNCOVERED`,
        }),
      );
    // Check the total too. A swap that reaches one site and adds another nets zero in the unrun count alone.
    const total = sites.filter((s) => s.startsWith(`${a.file}:`)).length;
    if (total !== a.sites)
      ledger.push(
        finding({
          where: LEDGER,
          what: `${a.file} has ${total} call sites, but ALLOWED_UNCOVERED records ${a.sites}`,
          why: "a change that runs one site and adds an unrun one leaves the unrun count alone, so the total is kept too",
          fix: `check that the added or moved sites are run by tests, then set sites for ${a.file} to ${total}`,
        }),
      );
  }
  if (report("sql:reach", ledger)) return;
  console.log(
    `SQL: tests ran ${sites.length - uncovered.length} / ${sites.length} sites against a real SQLite database` +
      (uncovered.length
        ? ` (the other ${uncovered.length} are listed with reasons in ALLOWED_UNCOVERED)`
        : ""),
  );
}

if (import.meta.main) sqlReach();
