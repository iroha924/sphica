// Opens a connection by role for one CLI command and closes it after.
import type { Kysely } from "kysely";
import { openReader, type Role } from "../db.ts";
import type { DB } from "../db-types.ts";
import { openWriter } from "../db-write.ts";

export async function withDb<T>(
  role: Exclude<Role, "owner">,
  fn: (db: Kysely<DB>) => Promise<T>,
): Promise<T> {
  const db = role === "reader" ? openReader() : openWriter(role);
  try {
    return await fn(db);
  } finally {
    await db.destroy().catch(() => {});
  }
}
