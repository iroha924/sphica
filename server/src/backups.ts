// Where `sphica init` keeps the copies it makes before migrating. Kept apart from admin.ts so the record server can name them to the owner
// (forget) without bundling the CLI.

import fs from "node:fs";
import path from "node:path";
import { dbFile } from "./sqlite.ts";

/** Copies made before a migration, next to the database: sphica.rev<from>.<UTC time to the millisecond>.<pid>.db */
export const backupDir = (file: string = dbFile()): string => path.join(path.dirname(file), "backups");
const BACKUP = /^sphica\.rev\d+\.(\d{8}T\d{9}Z)\.\d+\.db$/;

/** Completed backups, newest first. A `.partial` file is another run still writing (or one that stopped) and is never counted. */
export function backups(file: string = dbFile()): string[] {
  const dir = backupDir(file);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => BACKUP.test(f))
    .sort(
      (a, b) => (BACKUP.exec(b)?.[1] ?? "").localeCompare(BACKUP.exec(a)?.[1] ?? "") || b.localeCompare(a),
    )
    .map((f) => path.join(dir, f));
}
