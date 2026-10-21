// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Lints the structure of Markdown with markdownlint-cli2 and the repository's rule set.
// Usage: node scripts/check-markdown.mjs [file...] (no files: every tracked Markdown file)
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { finding, guard, report } from "./lib/finding.mjs";
import { isChecked, markdownFiles } from "./lib/markdown-files.mjs";

guard("Markdown");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const given = process.argv.slice(2);
const files = given.length ? given.filter(isChecked) : markdownFiles(root);
if (files.length === 0) process.exit(0);
// The package's own entry under node (the .bin launcher does not start on Windows), and every path prefixed with `:`, which makes it
// literal: markdownlint-cli2 reads its arguments as globs, so a name with { } [ ] or # would match other files or none (`--` did not help)
const bin = path.join(root, "server", "node_modules", "markdownlint-cli2", "markdownlint-cli2-bin.mjs");
const r = spawnSync(
  process.execPath,
  [bin, "--config", path.join(root, ".markdownlint-cli2.jsonc"), ...files.map((file) => `:${file}`)],
  { cwd: root, encoding: "utf8" },
);
const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
// markdownlint-cli2 exits 1 when it linted and found errors, and 2 when it could not lint
if (r.status === 1)
  report("Markdown", [
    finding({
      where: "markdownlint-cli2 (each file:line below)",
      what: "markdownlint found Markdown that renders or links wrong",
      why: ".markdownlint-cli2.jsonc turns on only rules whose failure breaks rendering or links",
      fix: "fix each line below; its rule id (MD042 and the like) is explained in markdownlint's doc/Rules.md",
      detail: output,
    }),
  ]);
else if (r.status !== 0)
  report("Markdown", [
    finding({
      where: "markdownlint-cli2",
      what: r.error
        ? `markdownlint-cli2 could not start: ${r.error.message}`
        : `markdownlint-cli2 could not lint (exit ${r.status})`,
      why: "the Markdown was not checked, and a check that did not run must not pass (invariant no-silent-skip)",
      fix: "run `bun run setup` to install it, and fix the configuration or path its output below names",
      detail: output,
    }),
  ]);
else console.log(`Markdown: ${files.length} file(s), nothing that breaks rendering or links`);
