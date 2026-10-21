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

/** check-sql.mjs applies this rule alone to schema.sql */
export const REPLACE = {
  re: /\.orReplace\s*\(|\.replaceInto\s*\(|\bor\s+replace\b|\breplace\s+into\b|\bconflict\s+replace\b/gi,
  what: "REPLACE is used",
  why: "REPLACE deletes the conflicting row without the authorizer seeing it or a delete trigger firing, so it slips past the write limits",
  fix: "use onConflict with doNothing or doUpdateSet (`on conflict do nothing` / `do update` in SQL)",
};

const RULES = [
  {
    re: RAW,
    what: "a node:sqlite connection is used directly",
    why: "only kysely gives result types from the schema, and a raw connection's rows are typed by hand and never checked",
    fix: "use kysely through openReader or openWriter",
  },
  {
    re: /\.orderBy\(\s*\[/g,
    what: "orderBy is given an array",
    why: "kysely deprecates the form and only warns at run time, so it compiles until a release removes it",
    fix: "chain orderBy(expr, 'asc') calls, one per column",
  },
  {
    re: /\.orderBy\(\s*([`'"])[^`'"]*\s+(?:asc|desc)\1/g,
    what: "the sort direction is written inside the orderBy string",
    why: "kysely deprecates the form and only warns at run time, so it compiles until a release removes it",
    fix: "write orderBy(expr, 'desc') with the direction as its own argument",
  },
  // A constraint's `on conflict replace` in the schema turns every plain insert into one
  REPLACE,
];

/** @param {string} file repository path with forward slashes @returns {{ line: number, what: string, why: string, fix: string }[]} */
export function sqlStyleProblems(file, text) {
  const problems = [];
  for (const { re, what, why, fix } of RULES) {
    if (re === RAW && (RAW_SQL_OK.has(file) || file.startsWith("server/test/"))) continue;
    for (const m of text.matchAll(re))
      problems.push({ line: text.slice(0, m.index).split("\n").length, what, why, fix });
  }
  return problems;
}
