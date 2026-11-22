// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// GitHub links an issue to a pull request from a closing keyword followed by an issue reference anywhere in the body, without reading
// the sentence, and the release run closes every linked issue. So a keyword and a reference may stand together only on a line of their own.

const KEYWORD = String.raw`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)`;
const REF = String.raw`(?:(?:[\w.-]+\/[\w.-]+)?#\d+|https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+)`;
const SEP = String.raw`(?::[ \t]*|[ \t]+)`;
const CLOSING = new RegExp(String.raw`\b${KEYWORD}${SEP}${REF}`, "gi");
const ALONE = new RegExp(String.raw`^[ \t]*${KEYWORD}${SEP}${REF}[ \t]*$`, "i");

/**
 * Closing keywords with an issue reference outside a line of their own, with their 1-based line in the body as given.
 * @param {string} body
 * @returns {{ line: number, text: string }[]}
 */
export function strayClosingRefs(body) {
  // Blank out HTML comments but keep their newlines, so line numbers stay those of the body
  const text = body.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, " "));
  const found = [];
  text.split("\n").forEach((line, i) => {
    if (ALONE.test(line)) return;
    for (const m of line.matchAll(CLOSING)) found.push({ line: i + 1, text: m[0] });
  });
  return found;
}
