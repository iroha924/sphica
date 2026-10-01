// Opens a connection by role for one CLI command and closes it after.
import type { Kysely } from "kysely";
import type { ReadonlyKysely } from "kysely/readonly";
import { openReader, type Role } from "../db.ts";
import type { DB } from "../db-types.ts";
import { openWriter } from "../db-write.ts";

export async function withDb<T>(role: "reader", fn: (db: ReadonlyKysely<DB>) => Promise<T>): Promise<T>;
export async function withDb<T>(
  role: Exclude<Role, "owner" | "reader">,
  fn: (db: Kysely<DB>) => Promise<T>,
): Promise<T>;
export async function withDb<T>(role: Exclude<Role, "owner">, fn: (db: never) => Promise<T>): Promise<T> {
  // The overloads give each caller its handle's type; underneath both are the same kind of kysely, closed the same way
  const db = role === "reader" ? (openReader() as unknown as Kysely<DB>) : openWriter(role);
  try {
    return await fn(db as never);
  } finally {
    await db.destroy().catch(() => {});
  }
}
