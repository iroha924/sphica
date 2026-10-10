// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

import "./isolate-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BUNDLE_ENTRIES, tarballProblems, trackedDistribution } from "../../scripts/lib/tarball.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tracked = trackedDistribution(root);
const complete = new Set([
  ...BUNDLE_ENTRIES.map((entry) => `dist/${entry}.js`),
  "db/schema.sql",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  "package.json",
  "THIRD_PARTY_NOTICES.md",
  "README.md",
  ...tracked,
]);

test("passes when everything shipped is present, and finds missing tracked manifests, Skills, and hooks", () => {
  assert.deepEqual(tarballProblems(complete, tracked), []);
  for (const must of [
    ".codex-plugin/plugin.json",
    "hooks/hooks.json",
    "skills/trace/SKILL.md",
    "README.md",
  ]) {
    assert.ok(
      tracked.includes(must) || must.startsWith(".codex") || must === "README.md",
      `${must} is shipped`,
    );
    const missing = new Set([...complete].filter((f) => f !== must));
    assert.ok(tarballProblems(missing, tracked).includes(`tarball is missing ${must}`), must);
  }
});

test("every program the build bundles has to be in the tarball", () => {
  // The build keeps its own list: changing scripts/bundle.mjs ships a release, so the check reads it instead of sharing one
  const built = /^const ENTRIES = (\[[^\]]*\]);$/m.exec(
    fs.readFileSync(path.join(root, "scripts", "bundle.mjs"), "utf8"),
  )?.[1];
  assert.ok(built, "scripts/bundle.mjs no longer spells its entries as `const ENTRIES = [...]`");
  assert.deepEqual([...BUNDLE_ENTRIES].sort(), (JSON.parse(built) as string[]).sort());
  for (const entry of BUNDLE_ENTRIES) {
    const file = `dist/${entry}.js`;
    const missing = new Set([...complete].filter((f) => f !== file));
    assert.deepEqual(tarballProblems(missing, tracked), [`tarball is missing ${file}`]);
  }
});

test("finds files that must not be shipped", () => {
  for (const bad of ["node_modules/x/index.js", ".env", "server/bun.lock", "src/cli.ts"])
    assert.match(tarballProblems(new Set([...complete, bad]), tracked).join("\n"), /must not ship/, bad);
});
