#!/usr/bin/env node
// Counts whether the SQL call sites in server/src ran against a real SQLite database in tests.
//
// **Type checks and unit tests let SQL that never runs pass.** Tests really run SQL against SQLite in a temp directory,
// so a call site that ran was accepted by SQLite, including syntax, constraints, and the authorizer. This checks only
// whether each site ran, and lists the ones that did not as file:line.
//
// Reach is counted with V8 coverage (scripts/lib/coverage.mjs, the same tool as the child process lane).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { coveredSites } from "./lib/coverage.mjs";
import { root } from "./lib/live-harness.mjs";
import { ALLOWED_UNCOVERED, callSites, LIVE_FILES } from "./lib/sql-call-sites.mjs";

const covDir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-sql-reach-"));
process.on("exit", () => fs.rmSync(covDir, { recursive: true, force: true }));

// Counting and testing happen in one command. Separately, a change of order alone could count runs that never happened and go green.
const r = spawnSync("bun", ["run", "--cwd", "server", "test"], {
  cwd: root,
  env: { ...process.env, NODE_V8_COVERAGE: covDir },
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (r.status !== 0) {
  // node --test writes failure details to stdout.
  console.error("tests fail, so reach cannot be counted. Fix `bun run test` first.\n");
  console.error(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  process.exit(1);
}
// The test output is hidden on success, so a randomized run shows its seed here to be rerun in the same order
const seeds = new Set(`${r.stdout ?? ""}${r.stderr ?? ""}`.match(/Randomized test order seed: \d+/g));
for (const s of seeds) console.log(s);

const sites = callSites(root).filter((s) => !LIVE_FILES.some((f) => s.startsWith(`${f}:`)));
const covered = coveredSites(covDir, root, sites);
if (covered.size === 0) {
  console.error("no reached sites were counted. Coverage output may be broken.");
  process.exit(1);
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
  process.exit(1);
}
console.log(
  `SQL: tests ran ${sites.length - uncovered.length} / ${sites.length} sites against a real SQLite database` +
    (uncovered.length ? ` (the other ${uncovered.length} are listed with reasons in ALLOWED_UNCOVERED)` : ""),
);
