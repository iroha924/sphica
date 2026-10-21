#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Fails on a key repeated in one JSON object in the files Oxfmt formats. Oxlint does not read JSON, and JSON.parse keeps the
// last value without a word, so a second "lint" script or "rules" block would replace the first unseen.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { duplicateKeys } from "./lib/json-keys.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const json = (dir, recursive) =>
  fs
    .readdirSync(path.join(root, dir), { recursive })
    .map((f) => path.join(dir, f).split(path.sep).join("/"))
    .filter((f) => f.endsWith(".json") && !f.includes("/node_modules/"));
const files = [
  ...json(".", false),
  ...json("server", false),
  ...["server/src", "server/test", "server/evals", "scripts"].flatMap((d) => json(d, true)),
];

const fail = files.flatMap((f) =>
  duplicateKeys(fs.readFileSync(path.join(root, f), "utf8")).map(
    (d) => `${f}:${d.line}: "${d.key}" appears twice in one object`,
  ),
);
if (fail.length) {
  console.error(`${fail.join("\n")}\n\nKeep one of each key: JSON.parse silently keeps the last.`);
  process.exit(1);
}
console.log(`JSON keys: ${files.length} files, no key repeated in an object`);
