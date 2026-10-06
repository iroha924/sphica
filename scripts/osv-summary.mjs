#!/usr/bin/env node
// Writes the OSV scan summary to stdout and the job summary, and `status`, `count`, and `line` to the step outputs.
// Usage: node scripts/osv-summary.mjs <results.json> <scanned sha>. Unreadable results are reported, not failed on.

import fs from "node:fs";
import { osvLine, osvSummary } from "./lib/osv-summary.mjs";

const [file, sha] = process.argv.slice(2);
if (!file || !/^[0-9a-f]{40}$/.test(sha ?? ""))
  throw new Error("pass the results path and the scanned commit's full SHA");
let text = null;
try {
  text = fs.readFileSync(file, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const summary = osvSummary(text, sha);
process.stdout.write(summary.markdown);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.markdown);
if (process.env.GITHUB_OUTPUT)
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `status=${summary.status}\ncount=${summary.count}\nline=${osvLine(summary, sha)}\n`,
  );
