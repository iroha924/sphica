// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The SQL forms chosen during the migration. The lint rule sphica/sql-style applies them to TypeScript, and check-sql.mjs to schema.sql.
// **Types stop neither.** Handwritten result types are never checked against the SQL, and deprecated kysely calls only warn at run
// time and still compile. Left alone, the next code written drifts back to the old form.

// Only connection setup, kysely construction, migrations, and the kysely adapter use node:sqlite directly; other code uses kysely
// so result types come from the schema. Tests may use raw connections to insert fixtures.
const RAW_SQL_OK = new Set([
  "server/src/sqlite.ts",
  "server/src/db.ts",
  "server/src/db-write.ts",
  "server/src/admin.ts",
  "server/src/kysely-node-sqlite.ts",
]);

// Match across newlines. When the formatter wraps arguments, a per-line regex misses the same code.
// There are two ways to get a raw connection (importing node:sqlite, calling the connection functions). Blocking both
// means the call forms (exec, prepare) need not be counted one by one.
const RAW = /from\s+["']node:sqlite["']|\bconnect(?:Reader|Writer)\s*\(/g;

/** REPLACE deletes the conflicting row without telling the authorizer or firing delete triggers, so it bypasses the write limits. */
export const REPLACE = [
  /\.orReplace\s*\(|\.replaceInto\s*\(|\bor\s+replace\b|\breplace\s+into\b|\bconflict\s+replace\b/gi,
  "REPLACE deletes rows the authorizer never sees. Use onConflict(doNothing / doUpdateSet)",
];

const RULES = [
  [RAW, "uses a node:sqlite connection directly. Use kysely (openReader / openWriter)"],
  [/\.orderBy\(\s*\[/g, "orderBy(array) is deprecated. Chain orderBy(expr, 'asc') calls"],
  [
    /\.orderBy\(\s*([`'"])[^`'"]*\s+(?:asc|desc)\1/g,
    "do not embed the direction in the string. Write orderBy(expr, 'desc')",
  ],
  // A constraint's `on conflict replace` in the schema turns every plain insert into one
  REPLACE,
];

/** @param {string} file repository path with forward slashes @returns {{ line: number, why: string }[]} */
export function sqlStyleProblems(file, text) {
  const problems = [];
  for (const [re, why] of RULES) {
    if (re === RAW && (RAW_SQL_OK.has(file) || file.startsWith("server/test/"))) continue;
    for (const m of text.matchAll(re))
      problems.push({ line: text.slice(0, m.index).split("\n").length, why });
  }
  return problems;
}
