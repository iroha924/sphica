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
import { bannedNameLines, hasBannedName } from "./lib/banned-name.mjs";
import { finding, report } from "./lib/finding.mjs";

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
  { name: "the old tool name", re: /mitos/i, fix: "write Sphica" },
  // The old name's origin was written in Greek, so searching the Latin spelling would miss it.
  { name: "the origin of the old tool name", re: /μίτος/i, fix: "drop it, or write Sphica" },
  // Only environment variables. Constant names such as the SQL column list (KNOWLEDGE_COLS) are out of scope.
  {
    name: "an old environment variable",
    re: /\bKNOWLEDGE_(DB_URL|ENV_DIR)\b/,
    fix: "use SPHICA_DB or SPHICA_HOME",
  },
  {
    name: "the old config file",
    re: /knowledge\.env/,
    fix: "drop it: Sphica keeps its state under ~/.sphica",
  },
  {
    name: "a removed service",
    re: /\b(Vercel|Neon|Clerk)\b/i,
    fix: "drop it: Sphica runs on a local SQLite database with no hosted service",
  },
];
const OLD_WHY = "the rename left this spelling behind, and a reader takes it for something that still exists";
const BANNED = {
  what: "a banned name appears",
  why: "the name must not appear in the repository or the package, and lib/banned-name.mjs keeps only its hash",
  fix: "remove the name; it has no exceptions",
};

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
    for (const { name, re, fix } of OLD) {
      if (!re.test(line)) continue;
      if (ALLOWED.some((a) => a.file === file && a.pattern.test(line))) continue;
      hits.push(
        finding({
          where: `${file}:${i + 1}`,
          what: `${name} remains: ${line.trim().slice(0, 100)}`,
          why: OLD_WHY,
          fix: `${fix}, or add the line to ALLOWED in ${SELF} with the reason it must stay`,
        }),
      );
    }
  }
}

for (const file of tracked) {
  if (/mitos/i.test(file))
    hits.push(
      finding({
        where: file,
        what: "the file name holds the old tool name",
        why: OLD_WHY,
        fix: "rename the file with git mv, writing sphica, and update what points at it",
      }),
    );
  if (hasBannedName(file))
    hits.push(finding({ where: file, ...BANNED, what: "the file name holds a banned name" }));
  if (skip.test(file) || /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|zip)$/.test(file)) continue;
  // Lockfiles are text and name the package, so unlike the patterns above this check reads them too
  let body = "";
  try {
    body = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const n of bannedNameLines(body)) hits.push(finding({ where: `${file}:${n}`, ...BANNED }));
}

if (!report("names", hits)) console.log(`names: no old spellings remain (${tracked.length} files checked)`);
