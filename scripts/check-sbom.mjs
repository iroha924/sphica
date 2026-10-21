#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Checks that the SBOM a release built lists every bundled dependency. Usage: node scripts/check-sbom.mjs <sbom.cdx.json>

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fail, report, runCheck } from "./lib/finding.mjs";
import { sbomProblems } from "./lib/sbom.mjs";

await runCheck("SBOM", () => {
  const file = process.argv[2];
  if (!file)
    fail({
      where: "node scripts/check-sbom.mjs",
      what: "no SBOM path was given",
      why: "the check compares one SBOM file with the notices table",
      fix: "run node scripts/check-sbom.mjs <sbom.cdx.json>",
    });
  const root = path.resolve(import.meta.dirname, "..");
  const read = (at, parts) => {
    try {
      return fs.readFileSync(at, "utf8");
    } catch (error) {
      return fail({ ...parts, what: `the file cannot be read: ${error.message}` });
    }
  };
  const notices = read(path.join(root, "plugin", "THIRD_PARTY_NOTICES.md"), {
    where: "plugin/THIRD_PARTY_NOTICES.md",
    why: "the SBOM is compared with the table of bundled packages this file holds",
    fix: "run `bun run bundle`, which writes it from the bundled node_modules",
  });
  const text = read(file, {
    where: file,
    why: "the check compares this SBOM with the notices table",
    fix: "pass the path of the cyclonedx-json file the release workflow's sbom job builds",
  });
  let bom;
  try {
    bom = JSON.parse(text);
  } catch (error) {
    fail({
      where: file,
      what: `the SBOM is not JSON: ${error.message}`,
      why: "the check compares this SBOM with the notices table",
      fix: "pass the cyclonedx-json file the release workflow's sbom job builds",
    });
  }
  if (!report("SBOM", sbomProblems(notices, bom, file)))
    console.log(`SBOM: ${bom.components.length} components, exactly matching the bundled dependencies`);
});
