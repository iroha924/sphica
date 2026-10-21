#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Checks that db/schema.sql holds no REPLACE. TypeScript is checked by the lint rule sphica/sql-style, from the same table.
// scripts/codegen.mjs checks drift between the generated types and schema.sql.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { REPLACE } from "./lib/sql-style.mjs";

const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const text = fs.readFileSync(path.join(root, "db/schema.sql"), "utf8");
const [re, why] = REPLACE;
const fail = [...text.matchAll(re)].map(
  (m) => `db/schema.sql:${text.slice(0, m.index).split("\n").length}: ${why}`,
);

if (fail.length) {
  console.error(`SQL style:\n${fail.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(
  "SQL style: no REPLACE in db/schema.sql (TypeScript is checked by the lint rule sphica/sql-style)",
);
