// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Reads the coverage report node --test prints, to tell which source files the percentages were measured over.
// The thresholds alone pass when the pattern matches no file, and never count a file no test loads.

/** The names of the TypeScript files the report lists with a line percentage. */
export function measuredFiles(output) {
  const names = new Set();
  let inside = false;
  for (const line of output.split(/\r?\n/)) {
    if (line.includes("start of coverage report")) inside = true;
    else if (line.includes("end of coverage report")) inside = false;
    else if (inside) {
      const m = /^\s*(?:ℹ|#)\s+(\S+\.ts)\s+\|\s+[\d.]+\s+\|/.exec(line);
      if (m) names.add(m[1]);
    }
  }
  return names;
}

/** The source files the report does not list, apart from those allowed to hold no code that runs. */
export function unmeasured(output, sourceFiles, typesOnly) {
  const measured = measuredFiles(output);
  return sourceFiles.filter((f) => !measured.has(f) && !typesOnly.includes(f)).sort();
}
