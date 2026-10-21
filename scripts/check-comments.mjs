#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Keeps issue numbers, pull request numbers, and plan paths out of SQL comments: a comment states the reason itself.
// JavaScript and TypeScript are checked by the lint rule sphica/comment-refs, with the same table.
// server/test/fixtures/*.sql are frozen copies of old schemas that the migration tests compare against, so they are left as they are.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REFERENCE_RULE, referenceProblems } from "./lib/comment-refs.mjs";
import { finding, report } from "./lib/finding.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every file under dir whose name matches re, as a repository path. */
const filesUnder = (dir, re) =>
  fs
    .readdirSync(path.join(root, dir), { recursive: true })
    .map((f) => `${dir}/${f.split(path.sep).join("/")}`)
    .filter((f) => re.test(f) && !f.includes("/node_modules/"))
    .sort();

const sql = filesUnder("db", /\.sql$/);

const fail = sql.flatMap((file) =>
  referenceProblems(fs.readFileSync(path.join(root, file), "utf8"), "sql").map((p) =>
    finding({
      where: `${file}:${p.line}`,
      what: `the comment points at ${p.reason}: ${p.text}`,
      ...REFERENCE_RULE,
    }),
  ),
);
if (!report("comments", fail))
  console.log(
    `comments: ${sql.length} SQL files (JavaScript and TypeScript are checked by the lint rule sphica/comment-refs)`,
  );
