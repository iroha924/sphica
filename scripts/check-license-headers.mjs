#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Checks that every source file starts with the copyright and license lines. `--fix` adds them where they are missing.
// The files are found by walking the source directories, not by asking git: git would run commands the repository's configuration names.
// server/test/fixtures/*.sql are frozen copies of old schemas that the migration tests compare against, so they are left as they are.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commentMarker, headerProblem, sourceFiles, withHeader } from "./lib/license-header.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fix = process.argv.includes("--fix");
const DIRS = ["server/src", "server/test", "server/evals", "scripts", "db"];
const FROZEN = /^server\/test\/fixtures\/.*\.sql$/;

const files = sourceFiles(root, DIRS, FROZEN);
if (files.length === 0) {
  console.error("license headers: no source files found. Run this from a checkout of the repository");
  process.exit(1);
}

let count = 0;
for (const file of files) {
  const full = path.join(root, file);
  const source = fs.readFileSync(full, "utf8");
  const marker = commentMarker(file);
  const problem = headerProblem(source, marker);
  if (!problem) continue;
  if (fix) fs.writeFileSync(full, withHeader(source, marker));
  else console.error(`${file}: ${problem}`);
  count++;
}
if (fix) console.log(`license headers: added to ${count} of ${files.length} source files`);
else if (count) {
  console.error(
    `\n${count} file(s) lack the header. Add it with \`node scripts/check-license-headers.mjs --fix\``,
  );
  process.exit(1);
} else console.log(`license headers: ${files.length} source files`);
