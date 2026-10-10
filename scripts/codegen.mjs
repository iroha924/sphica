#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Builds kysely types from db/schema.sql and writes them to server/src/db-types.ts.
//
// The source is an in-memory SQLite database with only db/schema.sql applied, not a local database.
// The kysely-codegen CLI requires better-sqlite3, so pass a node:sqlite adapter to the programmatic API instead.
// --check compares the generated text with db-types.ts, stopping commits that change schema.sql without regenerating the types.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { withHeader } from "./lib/license-header.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// kysely and kysely-codegen are server dependencies. Resolve them from there instead of adding root dependencies for a check.
const require = createRequire(path.join(root, "server/package.json"));
// biome-ignore lint/correctness/noUndeclaredDependencies: resolved from server/package.json dependencies
const { Kysely, SqliteDialect } = require("kysely");
// biome-ignore lint/correctness/noUndeclaredDependencies: resolved from server/package.json devDependencies
const { generate, RawExpressionNode, SqliteDialect: GenSqlite } = require("kysely-codegen");
const { adapt } = await import(path.join(root, "server/src/kysely-node-sqlite.ts"));

const OUT = path.join(root, "server/src/db-types.ts");
const check = process.argv.includes("--check");

// Columns stored as JSON strings. On read, JSON_COLUMNS in db.ts turns them back into values; on write, callers pass JSON.stringify output.
// Passing them as plain strings makes kysely-codegen try to parse them with the TypeScript parser and fail (typescript 7 lacks the old API).
const type = (t) => new RawExpressionNode(t);
const array = () => type("ColumnType<string[], string | undefined, string>");
const overrides = {
  columns: {
    "knowledge.refs": array(),
    "knowledge.downsides": array(),
    "work_item.next": array(),
  },
};

const raw = new DatabaseSync(":memory:");
// Triggers and the knowledge_search_text view reference it, so it must be registered with its one argument (type generation never calls it).
raw.function("sphica_terms", (_text) => "");
raw.exec(fs.readFileSync(path.join(root, "db/schema.sql"), "utf8"));
const db = new Kysely({ dialect: new SqliteDialect({ database: adapt(raw) }) });
const generated = await generate({
  db,
  dialect: new GenSqlite(),
  outFile: null,
  // FTS5 virtual tables and shadow tables are not touched from kysely (search uses sql templates).
  excludePattern: "*_fts*",
  overrides,
  logger: { info() {}, warn() {}, error: console.error, debug() {}, success() {}, log() {} },
});
await db.destroy();
const text = withHeader(generated, "//");

const rel = path.relative(root, OUT);
if (check) {
  const now = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (now !== text) {
    console.error(`${rel} does not match db/schema.sql. Regenerate it with \`bun run codegen\``);
    process.exit(1);
  }
  console.log(`${rel} matches db/schema.sql`);
} else {
  fs.writeFileSync(OUT, text);
  console.log(`regenerated ${rel} from db/schema.sql`);
}
