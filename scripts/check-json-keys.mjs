#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Fails on a key repeated in one JSON object in the files Oxfmt formats. Oxlint does not read JSON, and JSON.parse keeps the
// last value without a word, so a second "lint" script or "rules" block would replace the first unseen.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { finding, guard, report } from "./lib/finding.mjs";
import { duplicateKeys } from "./lib/json-keys.mjs";

guard("JSON keys");

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
  duplicateKeys(fs.readFileSync(path.join(root, f), "utf8")).map((d) =>
    finding({
      where: `${f}:${d.line}`,
      what: `"${d.key}" appears a second time in one object`,
      why: "JSON.parse keeps the last value without a word, so the first is replaced unseen",
      fix: `keep one "${d.key}" and merge what the two held into it`,
    }),
  ),
);
if (!report("JSON keys", fail)) console.log(`JSON keys: ${files.length} files, no key repeated in an object`);
