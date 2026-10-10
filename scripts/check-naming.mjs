#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Checks that no old names remain. **A rename is not a one-time job.** Spellings you thought were gone
// come back in code and documents written later.
//
// Generated files (plugin/dist, plugin/db) are untracked and out of scope.
// **Exceptions go here with a reason.** Without one, the next reader cannot tell whether it is safe to remove.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { bannedNameLines, hasBannedName } from "./lib/banned-name.mjs";

/** Spellings allowed to remain, with the reason. */
const ALLOWED = [
  {
    // A record of a problem actually hit in the past, not a description of the current setup.
    file: ".github/workflows/check.yml",
    pattern: /actually hit on Vercel/,
  },
  {
    // A real case that a bulk replace missed. The old name itself is the subject, so removing the spelling would break the example.
    file: ".claude/agents/review-shipping.md",
    pattern: /μίτος|mcp__plugin_mitos_mitos__/,
  },
];

const OLD = [
  { name: "old tool name", re: /mitos/i },
  // The old name's origin was written in Greek, so searching the Latin spelling would miss it.
  { name: "origin of the old tool name", re: /μίτος/i },
  // Only environment variables. Constant names such as the SQL column list (KNOWLEDGE_COLS) are out of scope.
  { name: "old environment variable", re: /\bKNOWLEDGE_(DB_URL|ENV_DIR)\b/ },
  { name: "old config file", re: /knowledge\.env/ },
  { name: "removed service", re: /\b(Vercel|Neon|Clerk)\b/i },
];

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n");
// This check holds the spellings it looks for as patterns, so it would always match itself.
const SELF = "scripts/check-naming.mjs";
const skip = /^(plugin\/dist|plugin\/db)\//;
const binary = /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|zip|lock)$/;

const hits = [];
for (const file of tracked) {
  if (file === SELF || skip.test(file) || binary.test(file)) continue;
  let body;
  try {
    body = fs.readFileSync(file, "utf8");
  } catch {
    continue; // such as a symlink with a missing target. Only the name is checked here
  }
  const lines = body.split("\n");
  for (const [i, line] of lines.entries()) {
    for (const { name, re } of OLD) {
      if (!re.test(line)) continue;
      if (ALLOWED.some((a) => a.file === file && a.pattern.test(line))) continue;
      hits.push(`${file}:${i + 1}  ${name}: ${line.trim().slice(0, 100)}`);
    }
  }
}

for (const file of tracked) {
  if (/mitos/i.test(file)) hits.push(`${file}  old tool name in the file name`);
  if (hasBannedName(file)) hits.push(`${file}  banned name in the file name`);
  if (skip.test(file) || /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|zip)$/.test(file)) continue;
  // Lockfiles are text and name the package, so unlike the patterns above this check reads them too
  let body = "";
  try {
    body = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const n of bannedNameLines(body)) hits.push(`${file}:${n}  banned name`);
}

if (hits.length) {
  console.error(`old names remain in ${hits.length} places.\n`);
  console.error(hits.slice(0, 40).join("\n"));
  if (hits.length > 40) console.error(`\n…and ${hits.length - 40} more`);
  console.error(
    "\nIf there is a reason to keep a pattern hit, add it with the reason to ALLOWED in scripts/check-naming.mjs. the banned name has no exceptions.",
  );
  process.exit(1);
}

console.log(`names: no old spellings remain (${tracked.length} files checked)`);
