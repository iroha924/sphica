// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The copyright and license lines every source file starts with, the check that a file has them, and which files are source files.

import fs from "node:fs";
import path from "node:path";

const COPYRIGHT = "Copyright (c) 2026 iroha924 and contributors";
const LICENSE_ID = "SPDX-License-Identifier: MIT";

/** The comment marker of a source file by its path, or null when the file is not one the header goes in. */
export function commentMarker(file) {
  if (/\.(?:ts|mts|mjs|js)$/.test(file)) return "//";
  if (/\.sql$/.test(file)) return "--";
  return null;
}

/** The two header lines for a comment marker. */
export const headerLines = (marker) => [`${marker} ${COPYRIGHT}`, `${marker} ${LICENSE_ID}`];

/** What is wrong with a file's header, or null. The header is the first two lines, after a shebang line when there is one. */
export function headerProblem(source, marker) {
  // A checkout with CRLF line endings has the same header
  const lines = source.split(/\r?\n/);
  const at = lines[0]?.startsWith("#!") ? 1 : 0;
  const [copyright, license] = headerLines(marker);
  if (lines[at] !== copyright) return `line ${at + 1} is not "${copyright}"`;
  if (lines[at + 1] !== license) return `line ${at + 2} is not "${license}"`;
  return null;
}

/**
 * The source with the header added, unchanged when it already has it. Only the header and a blank line after it are inserted: every
 * other byte stays, so a file with mixed line endings keeps them. The header takes the ending of the file's first line.
 */
export function withHeader(source, marker) {
  if (headerProblem(source, marker) === null) return source;
  const firstBreak = source.indexOf("\n");
  const eol = firstBreak > 0 && source[firstBreak - 1] === "\r" ? "\r\n" : "\n";
  const shebangEnd = source.startsWith("#!") ? (firstBreak < 0 ? source.length : firstBreak + 1) : 0;
  let shebang = source.slice(0, shebangEnd);
  if (shebang && !shebang.endsWith("\n")) shebang += eol;
  const rest = source.slice(shebangEnd);
  const blank = /^\r?\n/.test(rest) || rest === "" ? "" : eol;
  return `${shebang}${headerLines(marker).join(eol)}${eol}${blank}${rest}`;
}

/**
 * The source files under the given directories of root, as repository paths. Symbolic links are left out, files and directories alike:
 * a link is not a source file, and writing a header through one would change whatever it points at.
 */
export function sourceFiles(root, dirs, skip) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isSymbolicLink() || entry.name === "node_modules") continue;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile() && commentMarker(rel) && !skip.test(rel)) found.push(rel);
    }
  };
  for (const dir of dirs) if (fs.existsSync(path.join(root, dir))) walk(dir);
  return found.sort();
}
