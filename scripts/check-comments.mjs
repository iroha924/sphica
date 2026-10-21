#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Keeps issue numbers, pull request numbers, and plan paths out of SQL comments: a comment states the reason itself.
// JavaScript and TypeScript are checked by the lint rule sphica/comment-refs, with the same table.
// server/test/fixtures/*.sql are frozen copies of old schemas that the migration tests compare against, so they are left as they are.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { referenceProblems } from "./lib/comment-refs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every file under dir whose name matches re, as a repository path. */
const filesUnder = (dir, re) =>
  fs
    .readdirSync(path.join(root, dir), { recursive: true })
    .map((f) => `${dir}/${f.split(path.sep).join("/")}`)
    .filter((f) => re.test(f) && !f.includes("/node_modules/"))
    .sort();

const sql = filesUnder("db", /\.sql$/);

let count = 0;
for (const file of sql) {
  for (const p of referenceProblems(fs.readFileSync(path.join(root, file), "utf8"), "sql")) {
    console.error(`${file}:${p.line}: ${p.reason}: ${p.text}`);
    count++;
  }
}
if (count) {
  console.error(
    `\n${count} problem(s). Write the reason in the comment instead of pointing at where it was discussed.`,
  );
  process.exit(1);
}
console.log(
  `comments: ${sql.length} SQL files (JavaScript and TypeScript are checked by the lint rule sphica/comment-refs)`,
);
