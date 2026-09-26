import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tarballProblems, trackedDistribution } from "../../scripts/lib/tarball.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tracked = trackedDistribution(root);
const complete = new Set([
  "dist/cli.js",
  "dist/mcp.js",
  "dist/mcp-record.js",
  "dist/capture.js",
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

test("finds files that must not be shipped", () => {
  for (const bad of ["node_modules/x/index.js", ".env", "server/bun.lock", "src/cli.ts"])
    assert.match(tarballProblems(new Set([...complete, bad]), tracked).join("\n"), /must not ship/, bad);
});
