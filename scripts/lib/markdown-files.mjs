// The Markdown the docs checks cover: tracked files except plans, which are removed once their work ships.
import { execFileSync } from "node:child_process";

export function markdownFiles(root) {
  return execFileSync("git", ["ls-files", "-z", "*.md"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((file) => file && !file.startsWith(".claude/plans/"));
}
