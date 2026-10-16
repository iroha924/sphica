#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Fails unless every part job the check job needs succeeded. check.yml passes the needs context as JSON in NEEDS.
// Usage: NEEDS='${{ toJSON(needs) }}' node scripts/check-parts.mjs <job>...

import process from "node:process";
import { partProblems } from "./lib/check-parts.mjs";

let needs;
try {
  needs = JSON.parse(process.env.NEEDS ?? "");
} catch {
  needs = null;
}
const problems = partProblems(needs, process.argv.slice(2));
if (problems.length) {
  for (const p of problems) console.error(p);
  process.exitCode = 1;
} else console.log(`every part succeeded: ${process.argv.slice(2).join(", ")}`);
