#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Checks that every source file starts with the copyright and license lines. It only reads: nothing here writes a file, so nothing a
// checkout holds (a link, a file swapped in while it runs) can make it change one.
// The files are found by walking the checkout, not by asking git: git would run commands the repository's configuration names.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commentMarker, headerLines, headerProblem, sourceFiles } from "./lib/license-header.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// What .gitignore keeps out of the repository (build output and tool state), and the frozen copies of old schemas that the migration
// tests compare against, which stay as they are.
const SKIP =
  /^(?:plugin\/dist\/|plugin\/db\/|\.build\/|\.review-tmp\/|\.serena\/|server\/migrate-[^/]*\.ts$|server\/test\/fixtures\/[^/]*\.sql$)/;

const files = sourceFiles(root, SKIP);
if (files.length === 0) {
  console.error("license headers: no source files found. Run this from a checkout of the repository");
  process.exit(1);
}

let count = 0;
for (const file of files) {
  const problem = headerProblem(fs.readFileSync(path.join(root, file), "utf8"), commentMarker(file));
  if (!problem) continue;
  console.error(`${file}: ${problem}`);
  count++;
}
if (count) {
  console.error(
    `\n${count} file(s) lack the header. Start each with these two lines, after the shebang line when there is one (\`--\` in place of \`//\` in SQL):\n  ${headerLines("//").join("\n  ")}`,
  );
  process.exit(1);
}
console.log(`license headers: ${files.length} source files`);
