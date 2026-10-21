#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Checks that every source file starts with the copyright and license lines. It only reads: nothing here writes a file, so nothing a
// checkout holds (a link, a file swapped in while it runs) can make it change one.
// The files are found by walking the checkout, not by asking git: git would run commands the repository's configuration names.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { finding, guard, report } from "./lib/finding.mjs";
import { commentMarker, headerLines, headerProblem, sourceFiles } from "./lib/license-header.mjs";

guard("license headers");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// What .gitignore keeps out of the repository (build output and tool state), and the frozen copies of old schemas that the migration
// tests compare against, which stay as they are.
const SKIP =
  /^(?:plugin\/dist\/|plugin\/db\/|\.build\/|\.review-tmp\/|\.serena\/|\.stryker-tmp\/|reports\/|server\/migrate-[^/]*\.ts$|server\/test\/fixtures\/[^/]*\.sql$)/;

const files = sourceFiles(root, SKIP);
if (files.length === 0)
  report("license headers", [
    finding({
      where: root,
      what: "no source files found",
      why: "a walk that finds nothing passes while checking nothing",
      fix: "run this from a checkout of the repository",
    }),
  ]);

const fail = [];
for (const file of files) {
  const marker = commentMarker(file);
  const problem = headerProblem(fs.readFileSync(path.join(root, file), "utf8"), marker);
  if (problem)
    fail.push(
      finding({
        where: `${file}:${problem.line}`,
        what: `the license header is missing or changed: this line is not ${JSON.stringify(problem.expected)}`,
        why: "the MIT license asks every copy to carry the copyright and license notice, and each file can be copied alone",
        fix: `start the file with ${headerLines(marker)
          .map((l) => JSON.stringify(l))
          .join(" and ")}, after the shebang line when there is one`,
      }),
    );
}
if (files.length && !report("license headers", fail))
  console.log(`license headers: ${files.length} source files`);
