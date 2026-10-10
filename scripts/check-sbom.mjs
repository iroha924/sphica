#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Checks that the SBOM a release built lists every bundled dependency. Usage: node scripts/check-sbom.mjs <sbom.cdx.json>

import fs from "node:fs";
import path from "node:path";
import { sbomProblems } from "./lib/sbom.mjs";

const file = process.argv[2];
if (!file) throw new Error("pass the SBOM path");
const root = path.resolve(import.meta.dirname, "..");
const notices = fs.readFileSync(path.join(root, "plugin", "THIRD_PARTY_NOTICES.md"), "utf8");
const bom = JSON.parse(fs.readFileSync(file, "utf8"));
const problems = sbomProblems(notices, bom);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`SBOM: ${bom.components.length} components, exactly matching the bundled dependencies`);
