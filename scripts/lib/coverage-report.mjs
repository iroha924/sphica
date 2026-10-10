// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Reads the coverage report node --test prints, to tell which source files the percentages were measured over.
// The thresholds alone pass when the pattern matches no file, and never count a file no test loads.

import { stripVTControlCharacters } from "node:util";

const START = /^(?:ℹ|#) start of coverage report$/;
const END = /^(?:ℹ|#) end of coverage report$/;

/**
 * The paths of the TypeScript files the report gives a line percentage, as the report's tree spells them ("src/cli/view.ts"), or null
 * when the output does not hold exactly one report: a second one is something a test printed, and which is the real one cannot be told.
 */
export function measuredFiles(output) {
  const lines = stripVTControlCharacters(output).split(/\r?\n/);
  const starts = lines.flatMap((line, i) => (START.test(line) ? [i] : []));
  const ends = lines.flatMap((line, i) => (END.test(line) ? [i] : []));
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) return null;
  const paths = new Set();
  // The report is a tree: one more space of indent per directory level
  const dirs = [];
  for (const line of lines.slice(starts[0] + 1, ends[0])) {
    const m = /^(?:ℹ|#) ( *)(\S+)\s+\|\s*([\d.]*)\s*\|/.exec(line);
    if (!m) continue;
    const [, indent, name, percent] = m;
    dirs.length = indent.length;
    if (percent === "") dirs[indent.length] = name;
    else if (name.endsWith(".ts")) paths.add([...dirs, name].join("/"));
  }
  return paths;
}

/**
 * The source files the report does not list, apart from those allowed to hold no code that runs, or null when the output does not
 * hold exactly one report. Paths are spelled as in the report.
 */
export function unmeasured(output, sourceFiles, typesOnly) {
  const measured = measuredFiles(output);
  if (!measured) return null;
  return sourceFiles.filter((f) => !measured.has(f) && !typesOnly.includes(f)).sort();
}
