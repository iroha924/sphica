// Ledger of call sites that run SQL. Names the ones the checks do not reach as `file:line`.
//
// **Line numbers are never stored.** Both the static scan and the observation come from the same working tree at run time. Only
// "how many sites in this file may stay unreached" and the reason are stored, so shifted lines do not break it.

import fs from "node:fs";
import path from "node:path";

// Counts both kysely execution and raw SQL passed to node:sqlite. Missing the latter would leave schema application, migrations,
// and connection setup off the ledger while it looks complete. Variables holding a node:sqlite connection are named `raw`
// (counting just `.exec(` would also catch RegExp#exec).
const SITE = /\.(?:execute|executeTakeFirst|executeTakeFirstOrThrow)\s*\(|\braw\.(?:exec|prepare)\s*\(/;
// `.execute(fn)` for transactions and connections builds no SQL. The queries inside are separate call sites.
const NOT_A_QUERY = /\.(?:transaction|connection)\(\)\s*\.execute\s*\(/;
// The adapter that hands node:sqlite to kysely. Every query passes through it, so counting it would collapse everything into one site.
const ADAPTER = "server/src/kysely-node-sqlite.ts";

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });

/** Returns the SQL call sites in `server/src` as `server/src/foo.ts:12`. */
export function callSites(root) {
  const out = [];
  for (const file of walk(path.join(root, "server/src")).sort()) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (rel === ADAPTER) continue;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (SITE.test(line) && !NOT_A_QUERY.test(line)) out.push(`${rel}:${i + 1}`);
    });
  }
  return out;
}

/**
 * Files covered by the child process lane (scripts/check-sql-live.mjs). Tests have no seam to inject a db, and
 * starting the shipped entry point in a child process also exercises connection roles and cleanup.
 */
export const LIVE_FILES = ["server/src/cli.ts", "server/src/capture.ts"];

/** Call sites the child process lane cannot reach either, with the reason. One site per line. */
export const ALLOWED_UNREACHED = [];

/**
 * The number of call sites tests cannot run, with the reason. LIVE_FILES are all covered by the child process lane,
 * so they never appear here. `sites` is the file's total call site count, kept to catch a swap that reaches one site
 * while adding another.
 */
export const ALLOWED_UNCOVERED = [];
