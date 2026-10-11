// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

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

/**
 * PATH with a gh that answers for one issue of any repository: its body, and `comments` comments of `text` each. It counts its calls
 * in the file it returns, one line each.
 */
export function fakeIssueGh(number: number, comments: number, text: string): { path: string; calls: string } {
  const bin = tempDir("sphica-fake-gh-");
  const calls = path.join(bin, "calls");
  const person = { login: "someone", id: 7, type: "User" };
  const issue = {
    number,
    title: "An issue",
    body: "The body.",
    user: person,
    author_association: "CONTRIBUTOR",
    html_url: `https://github.com/o/r/issues/${number}`,
    created_at: "2026-09-10T00:00:00Z",
  };
  const comment = (i: number) => ({
    id: 1000 + i,
    body: `${i} ${text}`,
    user: person,
    author_association: "CONTRIBUTOR",
    html_url: `https://github.com/o/r/issues/${number}#issuecomment-${1000 + i}`,
    created_at: "2026-09-10T00:00:00Z",
  });
  fs.writeFileSync(
    path.join(bin, "gh"),
    [
      `#!${process.execPath}`,
      'const fs = require("node:fs");',
      "const a = process.argv.slice(2);",
      `fs.appendFileSync(${JSON.stringify(calls)}, a.join(" ") + "\\n");`,
      `const issue = ${JSON.stringify(issue)};`,
      `const comments = ${JSON.stringify(Array.from({ length: comments }, (_, i) => comment(i)))};`,
      `if (a[0] !== "api") process.exit(1);`,
      `if (a[1].endsWith("/issues/${number}")) process.stdout.write(JSON.stringify(issue));`,
      `else if (a[1].includes("/issues/${number}/comments")) process.stdout.write(JSON.stringify([comments]));`,
      "else process.exit(1);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { path: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, calls };
}
