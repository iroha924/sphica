// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Finds keys repeated in one JSON object, which JSON.parse accepts by keeping the last. Comments (JSONC) are skipped.
// Only valid JSON is expected: the formatter fails on anything else first. In valid JSON the string before a colon is a key.

/** @param {string} text @returns {{ line: number, key: string }[]} */
export function duplicateKeys(text) {
  const found = [];
  const objects = [];
  let line = 1;
  let last = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") line++;
    else if (c === "/" && text[i + 1] === "/") {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      line += text.slice(i, stop).split("\n").length - 1;
      i = stop - 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      last = { line, key: JSON.parse(text.slice(i, j + 1)) };
      i = j;
    } else if (c === "{") objects.push(new Set());
    else if (c === "[") objects.push(null);
    else if (c === "}" || c === "]") objects.pop();
    else if (c === ":" && last !== null) {
      const keys = objects.at(-1);
      if (keys?.has(last.key)) found.push(last);
      keys?.add(last.key);
      last = null;
    }
  }
  return found;
}
