#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Writes the OSV scan summary to stdout and the job summary, and `status`, `count`, and `line` to the step outputs.
// Usage: node scripts/osv-summary.mjs <results.json> <scanned sha> <scanner exit code, "" when it did not finish>.
// Unreadable or untrusted results are reported, not failed on.

import fs from "node:fs";
import { osvLine, osvSummary } from "./lib/osv-summary.mjs";

const [file, sha, scannerExit] = process.argv.slice(2);
if (!file || !/^[0-9a-f]{40}$/.test(sha ?? "") || scannerExit === undefined)
  throw new Error("pass the results path, the scanned commit's full SHA, and the scanner's exit code");
let text;
try {
  text = fs.readFileSync(file, "utf8");
} catch (error) {
  text = error.code === "ENOENT" ? null : { code: error.code };
}
const summary = osvSummary(text, sha, scannerExit);
process.stdout.write(summary.markdown);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.markdown);
if (process.env.GITHUB_OUTPUT)
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `status=${summary.status}\ncount=${summary.count}\nline=${osvLine(summary, sha)}\n`,
  );
