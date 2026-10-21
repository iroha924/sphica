// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Checks the relative links, images, and heading anchors of the tracked Markdown with lychee (offline). Usage: node scripts/check-links.mjs
// Links to this repository's own files on GitHub (README.md uses them, since npm shows it away from the repository) are read as the files
// in this checkout, so their anchors are checked too.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { finding, report } from "./lib/finding.mjs";
import { markdownFiles } from "./lib/markdown-files.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// `$` in the replacement names a capture group, so one in the checkout's path is doubled to stay literal
const target = pathToFileURL(root).href.replaceAll("$", "$$$$");
const remap = `^https://github\\.com/iroha924/sphica/blob/main/(.*)$ ${target}/$1`;
try {
  // `--` so a file named like an option (--x.md) is read as a file
  execFileSync(
    "lychee",
    ["--config", path.join(root, "lychee.toml"), "--remap", remap, "--", ...markdownFiles(root)],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
} catch (e) {
  report("links", [
    e.code === "ENOENT"
      ? finding({
          where: "lychee",
          what: "lychee is not on PATH",
          why: "the links of the tracked Markdown cannot be checked without it, and a skipped check stays green (invariant no-silent-skip)",
          fix: "run `mise install`, which installs the lychee version mise.toml pins",
        })
      : finding({
          where: "the lychee output above",
          what: "lychee found broken links, images, or heading anchors in the tracked Markdown",
          why: "a broken link sends the reader nowhere, and npm shows README.md away from the repository, so its links must hold there too",
          fix: "point each link lychee names at a file or heading that exists, or remove it",
        }),
  ]);
}
