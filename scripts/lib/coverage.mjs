// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Reads the lines a child process actually ran from V8 coverage.
//
// SQL that runs inside a child process cannot be counted from the parent, so read
// `NODE_V8_COVERAGE` instead. Node strips type annotations without shifting positions, so line numbers
// match the `.ts` source (measured: a function on line 4 showed up as lines 4-6 with count=0).

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

/** Byte offset of the first non-space character on the line, used to test whether it is inside a range. */
function offsetOfLine(text, line) {
  let at = 0;
  for (let i = 1; i < line; i++) {
    const nl = text.indexOf("\n", at);
    if (nl < 0) return -1;
    at = nl + 1;
  }
  const end = text.indexOf("\n", at);
  const body = text.slice(at, end < 0 ? undefined : end);
  const lead = body.length - body.trimStart().length;
  return body.trim() === "" ? -1 : at + lead;
}

/**
 * Reads coverage under `covDir` and returns the `sites` (`server/src/foo.ts:12`) that actually ran.
 *
 * Ranges nest. **Count by the innermost range.** Even if the outer function ran once,
 * a branch inside with count 0 did not run. Using the wider range counts unrun lines as run.
 */
export function coveredSites(covDir, root, sites) {
  const byFile = new Map();
  for (const site of sites) {
    const i = site.lastIndexOf(":");
    const file = site.slice(0, i);
    byFile.set(file, [...(byFile.get(file) ?? []), Number(site.slice(i + 1))]);
  }

  const source = new Map();
  const offsets = new Map();
  for (const [file, lines] of byFile) {
    const abs = path.join(root, file);
    const text = fs.readFileSync(abs, "utf8");
    source.set(abs, text);
    for (const line of lines) offsets.set(`${file}:${line}`, offsetOfLine(text, line));
  }

  // Collect the innermost range count for each site. The same file runs in several processes,
  // so a site counts as run if any of them has count > 0.
  const best = new Map();
  if (!fs.existsSync(covDir)) return new Set();
  for (const name of fs.readdirSync(covDir)) {
    if (!name.endsWith(".json")) continue;
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(covDir, name), "utf8"));
    } catch {
      continue; // a file still being written
    }
    for (const entry of doc.result ?? []) {
      if (!entry.url?.startsWith("file://")) continue;
      const abs = url.fileURLToPath(entry.url);
      if (!source.has(abs)) continue;
      const rel = path.relative(root, abs).split(path.sep).join("/");
      for (const line of byFile.get(rel) ?? []) {
        const site = `${rel}:${line}`;
        const at = offsets.get(site);
        if (at < 0) continue;
        let inner = null;
        for (const fn of entry.functions ?? []) {
          for (const r of fn.ranges ?? []) {
            if (r.startOffset <= at && at < r.endOffset) {
              if (!inner || r.endOffset - r.startOffset < inner.endOffset - inner.startOffset) inner = r;
            }
          }
        }
        if (inner && inner.count > 0) best.set(site, true);
      }
    }
  }
  return new Set([...best.keys()]);
}
