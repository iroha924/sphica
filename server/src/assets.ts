// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Where the bundled runtime files (the database schema and migrations) live.
//
// **Never search from cwd.** Hooks start with the project being edited as cwd, and the CLI runs from anywhere.
// The reference point is always the location of this running file.
//
// There are two layouts.
//   shipped        <package>/db as seen from <package>/dist/cli.js (package.json `files` puts it next to dist)
//   working tree   the repository's db as seen from server/src/assets.ts
// bun build resolves import.meta.url to its runtime value, so the bundle still knows where it is.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = (): string => path.dirname(fileURLToPath(import.meta.url));

/** Returns the first candidate that contains the marker file. */
function locate(marker: string, candidates: string[]): string | null {
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, marker))) return dir;
  }
  return null;
}

/**
 * The bundled database files (schema.sql and, if present, migrations).
 * **Throws when they are missing.** Falling back to a default would look like an empty schema was applied.
 */
export function dbDir(from = here()): string {
  const dir = locate("schema.sql", [path.join(from, "..", "db"), path.join(from, "..", "..", "db")]);
  if (!dir) {
    throw new Error(
      "The bundled database schema (db/schema.sql) is missing. The package is broken or was not bundled.",
    );
  }
  return dir;
}
