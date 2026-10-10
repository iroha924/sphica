#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Checks that SQL is still written in the form chosen during the migration.
//
// **Types stop neither.** Handwritten result types are never checked against the SQL, and deprecated kysely
// calls only warn at run time and still compile. Left alone, the next code written drifts back to the old form.
//
// scripts/codegen.mjs checks drift between the generated types and schema.sql.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const fail = [];

/**
 * Files allowed to use node:sqlite directly: connection setup (sqlite.ts, db-write.ts), kysely construction (db.ts),
 * schema application and migrations (admin.ts), and the adapter passed to kysely. Other app code uses kysely
 * (so result types are inferred from the schema).
 */
const RAW_SQL_OK = new Set([
  "server/src/sqlite.ts",
  "server/src/db.ts",
  "server/src/db-write.ts",
  "server/src/admin.ts",
  "server/src/kysely-node-sqlite.ts",
]);

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });

// Match across newlines. When the formatter wraps arguments, a per-line regex misses the same code.
// There are two ways to get a raw connection (importing node:sqlite, calling the connection functions). Blocking both
// means the call forms (exec, prepare) need not be counted one by one. Tests may use raw connections to insert fixtures.
const RAW = /from\s+["']node:sqlite["']|\bconnect(?:Reader|Writer)\s*\(/g;
const RULES = [
  [RAW, "uses a node:sqlite connection directly. Use kysely (openReader / openWriter)"],
  [/\.orderBy\(\s*\[/g, "orderBy(array) is deprecated. Chain orderBy(expr, 'asc') calls"],
  [
    /\.orderBy\(\s*([`'"])[^`'"]*\s+(?:asc|desc)\1/g,
    "do not embed the direction in the string. Write orderBy(expr, 'desc')",
  ],
  // REPLACE deletes the conflicting row without telling the authorizer or firing delete triggers, so it bypasses the write limits.
  // A constraint's `on conflict replace` in the schema turns every plain insert into one
  [
    /\.orReplace\s*\(|\.replaceInto\s*\(|\bor\s+replace\b|\breplace\s+into\b|\bconflict\s+replace\b/gi,
    "REPLACE deletes rows the authorizer never sees. Use onConflict(doNothing / doUpdateSet)",
  ],
];

const files = [
  ...walk(path.join(root, "server/src")),
  ...walk(path.join(root, "server/test")),
  path.join(root, "db/schema.sql"),
];
for (const file of files) {
  const rel = path.relative(root, file).split(path.sep).join("/");
  const text = fs.readFileSync(file, "utf8");
  for (const [re, why] of RULES) {
    if (re === RAW && (RAW_SQL_OK.has(rel) || rel.startsWith("server/test/"))) continue;
    for (const m of text.matchAll(re)) {
      fail.push(`${rel}:${text.slice(0, m.index).split("\n").length}: ${why}`);
    }
  }
}

if (fail.length) {
  console.error(`SQL style:\n${fail.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(
  `SQL style: raw SQL only in the ${RAW_SQL_OK.size} allowed files, no deprecated orderBy, no REPLACE`,
);
