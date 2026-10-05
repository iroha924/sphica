// Lints the structure of the tracked Markdown with markdownlint-cli2 and the repository's rule set. Usage: node scripts/check-markdown.mjs
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { markdownFiles } from "./lib/markdown-files.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "server", "node_modules", ".bin", "markdownlint-cli2");
try {
  execFileSync(bin, ["--config", path.join(root, ".markdownlint-cli2.jsonc"), ...markdownFiles(root)], {
    cwd: root,
    stdio: "inherit",
  });
} catch {
  process.exit(1);
}
