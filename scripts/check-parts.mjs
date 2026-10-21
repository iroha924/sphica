#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Fails unless every part job the check job needs succeeded. check.yml passes the needs context as JSON in NEEDS and the event in EVENT.
// Usage: NEEDS='${{ toJSON(needs) }}' EVENT='${{ github.event_name }}' node scripts/check-parts.mjs <job>...

import process from "node:process";
import { partProblems } from "./lib/check-parts.mjs";
import { finding, guard, report } from "./lib/finding.mjs";

guard("check");

let needs;
try {
  needs = JSON.parse(process.env.NEEDS ?? "");
} catch {
  needs = null;
}
const jobs = process.argv.slice(2);
const problems = partProblems(needs, jobs, process.env.EVENT).map(finding);
if (!report("check", problems)) console.log(`every part succeeded: ${jobs.join(", ")}`);
