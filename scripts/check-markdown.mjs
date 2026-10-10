// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Lints the structure of Markdown with markdownlint-cli2 and the repository's rule set.
// Usage: node scripts/check-markdown.mjs [file...] (no files: every tracked Markdown file)
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isChecked, markdownFiles } from "./lib/markdown-files.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const given = process.argv.slice(2);
const files = given.length ? given.filter(isChecked) : markdownFiles(root);
if (files.length === 0) process.exit(0);
// The package's own entry under node (the .bin launcher does not start on Windows), and every path prefixed with `:`, which makes it
// literal: markdownlint-cli2 reads its arguments as globs, so a name with { } [ ] or # would match other files or none (`--` did not help)
const bin = path.join(root, "server", "node_modules", "markdownlint-cli2", "markdownlint-cli2-bin.mjs");
try {
  execFileSync(
    process.execPath,
    [bin, "--config", path.join(root, ".markdownlint-cli2.jsonc"), ...files.map((file) => `:${file}`)],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
} catch {
  process.exit(1);
}
