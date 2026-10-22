#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Runs the Oxlint that server pins, with its type-aware rules, on the given files or on every linted directory.
// Oxlint looks for tsgolint only beside the working directory, and the tools are installed under server/, so its path is passed in.
// Both are started with node and the native file, never a .cmd shim, so this runs the same on Windows.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "server/package.json"));
const oxlint = path.join(path.dirname(require.resolve("oxlint/package.json")), "bin", "oxlint");
const tsgolint = require.resolve(
  `@oxlint-tsgolint/${process.platform}-${process.arch}/tsgolint${process.platform === "win32" ? ".exe" : ""}`,
);

const args = process.argv.slice(2);
const targets = args.some((a) => !a.startsWith("-"))
  ? []
  : ["server/src", "server/test", "server/evals", "scripts", "pane"];
const r = spawnSync(process.execPath, [oxlint, "--type-aware", "--deny-warnings", ...args, ...targets], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, OXLINT_TSGOLINT_PATH: tsgolint },
});
if (r.error) throw r.error;
process.exit(r.status ?? 1);
