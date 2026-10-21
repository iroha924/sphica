#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Runs the Oxfmt that server pins on the sources and the JSON at the root and in server/, or on the given files among them.
// Oxfmt reads glob arguments as filters over the directories given, so the scope is decided here instead.
// It is started with node and its script, never a .cmd shim, so this runs the same on Windows.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "server/package.json"));
const oxfmt = path.join(path.dirname(require.resolve("oxfmt/package.json")), "bin", "oxfmt");

const DIRS = ["server/src", "server/test", "server/evals", "scripts"];
const json = (dir) =>
  fs
    .readdirSync(path.join(root, dir))
    .filter((f) => f.endsWith(".json"))
    .map((f) => (dir === "." ? f : `${dir}/${f}`));
const inScope = (file) =>
  /^[^/]+\.json$|^server\/[^/]+\.json$/.test(file) ||
  (DIRS.some((d) => file.startsWith(`${d}/`)) && /\.(?:ts|mts|mjs|json)$/.test(file));

const args = process.argv.slice(2);
// A value after a separate flag would be read as a file here, and a file outside the scope leaves nothing to format
const valued = args.find((a) =>
  ["-c", "--config", "--ignore-path", "--threads", "--stdin-filepath", "--migrate"].includes(a),
);
if (valued) {
  console.error(`oxfmt.mjs: write ${valued}=<value> as one argument`);
  process.exit(2);
}
const flags = args.filter((a) => a.startsWith("-"));
const files = args
  .filter((a) => !a.startsWith("-"))
  .map((f) => path.relative(root, path.resolve(f)).split(path.sep).join("/"));
const targets = files.length ? files.filter(inScope) : [...DIRS, ...json("."), ...json("server")];
if (targets.length === 0) process.exit(0);
const r = spawnSync(process.execPath, [oxfmt, "--no-error-on-unmatched-pattern", ...flags, ...targets], {
  cwd: root,
  stdio: "inherit",
});
if (r.error) throw r.error;
process.exit(r.status ?? 1);
