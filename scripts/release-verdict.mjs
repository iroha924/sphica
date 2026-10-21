#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Writes the release verdict for a packed tarball (scripts/lib/release-verdict.mjs). It exits 0 once the verdict is written: whether a
// bump is needed is the version check's call (scripts/check-mcp-version.mjs --verdict).
// Usage: node scripts/release-verdict.mjs --packed <tgz> --base <commit> --out <json>

import fs from "node:fs";
import { parseArgs } from "node:util";
import { verdictLine, writeVerdict } from "./lib/release-verdict.mjs";

const { packed, base, out } = parseArgs({
  options: { packed: { type: "string" }, base: { type: "string" }, out: { type: "string" } },
}).values;
if (!packed || !base || !out) {
  console.error("usage: node scripts/release-verdict.mjs --packed <tgz> --base <commit> --out <json>");
  process.exit(2);
}
const v = await writeVerdict({ packed, base, out, cwd: process.cwd() });
const line = verdictLine(v);
console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
