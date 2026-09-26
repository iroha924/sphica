// Checks the file list of the shipped tarball. Through scripts/check-tarball.mjs, CI check and release use the same list.

import { execFileSync } from "node:child_process";

/** Shipped files the repository tracks. All of them must be in the tarball. */
export function trackedDistribution(root) {
  return execFileSync(
    "git",
    [
      "ls-files",
      "plugin/skills",
      "plugin/hooks",
      "plugin/mcp",
      "plugin/.claude-plugin",
      "plugin/.codex-plugin",
      "plugin/LICENSE",
      "db",
    ],
    { cwd: root, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .map((file) => file.replace(/^plugin\//, ""));
}

/** Problems with the paths in the tarball (without `package/`). Empty means it passes. */
export function tarballProblems(paths, tracked) {
  const problems = [];
  for (const required of new Set([
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
  ]))
    if (!paths.has(required)) problems.push(`tarball is missing ${required}`);
  for (const file of paths)
    if (
      file.includes("node_modules/") ||
      /(^|\/)\.env(?:\.|$)/.test(file) ||
      file.endsWith("bun.lock") ||
      /(^|\/)src\/.+\.(?:ts|tsx)$/.test(file)
    )
      problems.push(`tarball contains a file that must not ship: ${file}`);
  return problems;
}
