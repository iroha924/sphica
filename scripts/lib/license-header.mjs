// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The copyright and license lines every source file starts with, and the check that a file has them.

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
  const lines = source.split("\n");
  const at = lines[0]?.startsWith("#!") ? 1 : 0;
  const [copyright, license] = headerLines(marker);
  if (lines[at] !== copyright) return `line ${at + 1} is not "${copyright}"`;
  if (lines[at + 1] !== license) return `line ${at + 2} is not "${license}"`;
  return null;
}

/** The source with the header added, unchanged when it already has it. A blank line separates the header from what follows. */
export function withHeader(source, marker) {
  if (headerProblem(source, marker) === null) return source;
  const lines = source.split("\n");
  const shebang = lines[0]?.startsWith("#!") ? [lines.shift()] : [];
  const rest = lines[0] === "" ? lines : ["", ...lines];
  return [...shebang, ...headerLines(marker), ...rest].join("\n");
}
