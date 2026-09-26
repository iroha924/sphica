#!/usr/bin/env node
// Checks that the read MCP server has no write connection (server/src/db-write.ts); writes go through the record server (mcp-record.ts).
//
// **Connection roles are separated by import direction.** If imports from a reader entry reach db-write.ts, text it reads
// could steer it into writing (the execution boundary in CLAUDE.md and AGENTS.md). Neither types nor the authorizer stop this: once a write
// connection is open, the authorizer allows that role's writes.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
/** Read-only interfaces. No module reachable from these may import the write connection. */
const READERS = ["server/src/mcp.ts"];
const WRITER = "server/src/db-write.ts";

// Four forms: `import x from`, `export ... from`, side-effect-only `import "..."`, and `import(...)`.
const IMPORT =
  /(?:import|export)\s[^;]*?from\s+["'](\.[^"']+)["']|import\s+["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)/g;
const rel = (abs) => path.relative(root, abs).split(path.sep).join("/");

/** Modules reachable from an entry, each with the module that first imported it. */
function reach(entry) {
  const via = new Map([[entry, null]]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    const text = fs.readFileSync(path.join(root, file), "utf8");
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3];
      const next = rel(path.resolve(path.dirname(path.join(root, file)), spec));
      if (!next.startsWith("server/src/") || via.has(next)) continue;
      via.set(next, file);
      queue.push(next);
    }
  }
  return via;
}

const fail = [];
for (const entry of READERS) {
  if (!fs.existsSync(path.join(root, entry))) {
    fail.push(`${entry} does not exist. Fix READERS in check-architecture.mjs`);
    continue;
  }
  const via = reach(entry);
  if (!via.has(WRITER)) continue;
  const chain = [];
  for (let at = WRITER; at; at = via.get(at)) chain.unshift(at);
  fail.push(`${entry} reaches the write connection: ${chain.join(" → ")}`);
}
// If the import regex broke and matched nothing, the check would pass while looking at nothing. Confirm each entry imports a src module.
for (const entry of READERS)
  if (fs.existsSync(path.join(root, entry)) && reach(entry).size < 3)
    fail.push(`cannot follow the imports of ${entry}`);

if (fail.length) {
  console.error(`reader boundary:\n${fail.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
const count = new Set(READERS.flatMap((e) => [...reach(e).keys()])).size;
console.log(
  `reader boundary: none of the ${count} modules reachable from ${READERS.join(" / ")} import the write connection`,
);
