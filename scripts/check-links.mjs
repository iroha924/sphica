// Checks the relative links, images, and heading anchors of the tracked Markdown with lychee (offline). Usage: node scripts/check-links.mjs
// Links to this repository's own files on GitHub (README.md uses them, since npm shows it away from the repository) are read as the files
// in this checkout, so their anchors are checked too.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  if (e.code === "ENOENT")
    console.error("lychee is not on PATH. Run `mise install` (it pins lychee in mise.toml).");
  process.exit(1);
}
