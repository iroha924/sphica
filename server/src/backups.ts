// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Where `sphica init` keeps the copies it makes before migrating. Kept apart from admin.ts so the record server can name them to the owner
// (forget) without bundling the CLI.

import fs from "node:fs";
import path from "node:path";
import { dbFile } from "./sqlite.ts";

/** Copies made before a migration, next to the database */
export const backupDir = (file: string = dbFile()): string => path.join(path.dirname(file), "backups");

// Named after the database, so two databases in one directory (SPHICA_DB) never count or prune each other's copies
const stem = (file: string): string => path.basename(file).replace(/\.db$/, "");
const pattern = (file: string): RegExp =>
  new RegExp(
    `^${stem(file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.rev\\d+\\.(\\d{8}T\\d{9}Z)\\.\\d+\\.db$`,
  );

/** <database name>.rev<from>.<UTC time to the millisecond>.<pid>.db */
export const backupPath = (file: string, from: number): string =>
  path.join(
    backupDir(file),
    `${stem(file)}.rev${from}.${new Date().toISOString().replace(/[-:.]/g, "")}.${process.pid}.db`,
  );

/** Completed backups, newest first. A `.partial` file is another run still writing (or one that stopped) and is never counted. */
export function backups(file: string = dbFile()): string[] {
  const dir = backupDir(file);
  if (!fs.existsSync(dir)) return [];
  const named = pattern(file);
  return fs
    .readdirSync(dir)
    .filter((f) => named.test(f))
    .sort((a, b) => (named.exec(b)?.[1] ?? "").localeCompare(named.exec(a)?.[1] ?? "") || b.localeCompare(a))
    .map((f) => path.join(dir, f));
}
