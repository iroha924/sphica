// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Checks the relative links, images, and heading anchors of the tracked Markdown with lychee (offline). Usage: node scripts/check-links.mjs
// Links to this repository's own files on GitHub (README.md uses them, since npm shows it away from the repository) are read as the files
// in this checkout, so their anchors are checked too.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { finding, guard, report } from "./lib/finding.mjs";
import { markdownFiles } from "./lib/markdown-files.mjs";

guard("links");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// `$` in the replacement names a capture group, so one in the checkout's path is doubled to stay literal
const target = pathToFileURL(root).href.replaceAll("$", "$$$$");
const remap = `^https://github\\.com/iroha924/sphica/blob/main/(.*)$ ${target}/$1`;
const files = markdownFiles(root);
// `--` so a file named like an option (--x.md) is read as a file
const r = spawnSync(
  "lychee",
  ["--config", path.join(root, "lychee.toml"), "--remap", remap, "--", ...files],
  {
    cwd: root,
    encoding: "utf8",
  },
);
const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
// lychee exits 2 on links that failed the check, and 1 or 3 when it could not check (missing input, a runtime or config error)
if (r.error?.code === "ENOENT")
  report("links", [
    finding({
      where: "lychee",
      what: "lychee is not on PATH",
      why: "the links of the tracked Markdown cannot be checked without it, and a skipped check stays green (invariant no-silent-skip)",
      fix: "run `mise install`, which installs the lychee version mise.toml pins",
    }),
  ]);
else if (r.status === 2)
  report("links", [
    finding({
      where: "lychee (each link below)",
      what: "lychee found broken links, images, or heading anchors in the tracked Markdown",
      why: "a broken link sends the reader nowhere, and npm shows README.md away from the repository, so its links must hold there too",
      fix: "point each link below at a file or heading that exists, or remove it",
      detail: output,
    }),
  ]);
else if (r.status !== 0)
  report("links", [
    finding({
      where: "lychee",
      what: r.error
        ? `lychee could not start: ${r.error.message}`
        : `lychee could not check the links (exit ${r.status})`,
      why: "the links were not checked, and a check that did not run must not pass (invariant no-silent-skip)",
      fix: "fix the input or lychee.toml setting its output below names",
      detail: output,
    }),
  ]);
else console.log(`links: ${files.length} Markdown files, every relative link, image, and anchor resolves`);
