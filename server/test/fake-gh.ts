// A gh first on PATH for child processes that run sphica init: init reads the signed-in account, and a test must never reach
// api.github.com with the owner's own login. POSIX only (a shebang script); verify does not run on Windows.
import fs from "node:fs";
import path from "node:path";
import { tempDir } from "./temp-dir.ts";

/** PATH with a gh that answers `gh api user` as user, or exits 1 like a signed-out gh when none is given. */
export function fakeGhPath(user?: { id: number; login: string }): string {
  const bin = tempDir("sphica-fake-gh-");
  const answer = user ? `process.stdout.write(${JSON.stringify(JSON.stringify(user))});` : "process.exit(1);";
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!${process.execPath}\nconst a = process.argv.slice(2);\nif (a[0] === "api" && a[1] === "user") { ${answer} } else process.exit(1);\n`,
    { mode: 0o755 },
  );
  return `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
}
