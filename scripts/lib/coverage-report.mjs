// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Reads the coverage report node --test prints, to tell which source files the percentages were measured over.
// The thresholds alone pass when the pattern matches no file, and never count a file no test loads.

/** The paths of the TypeScript files the report gives a line percentage, as the report's tree spells them ("src/cli/view.ts"). */
export function measuredFiles(output) {
  const paths = new Set();
  // The report is a tree: one more space of indent per directory level
  const dirs = [];
  let inside = false;
  for (const line of output.split(/\r?\n/)) {
    if (line.includes("start of coverage report")) inside = true;
    else if (line.includes("end of coverage report")) inside = false;
    else if (inside) {
      const m = /^\s*(?:ℹ|#) ( *)(\S+)\s+\|\s*([\d.]*)\s*\|/.exec(line);
      if (!m) continue;
      const [, indent, name, percent] = m;
      dirs.length = indent.length;
      if (percent === "") dirs[indent.length] = name;
      else if (name.endsWith(".ts")) paths.add([...dirs, name].join("/"));
    }
  }
  return paths;
}

/** The source files the report does not list, apart from those allowed to hold no code that runs. Paths are spelled as in the report. */
export function unmeasured(output, sourceFiles, typesOnly) {
  const measured = measuredFiles(output);
  return sourceFiles.filter((f) => !measured.has(f) && !typesOnly.includes(f)).sort();
}
