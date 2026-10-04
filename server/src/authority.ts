// Whose decision a record is: the owner's (the owner's or a maintainer's adoption), an AI's (only the AI's own adoption), or no one's yet.
// Read from adoption history alone, so a past time gives the authority a record had then.

import { type SqlBool, sql } from "kysely";
import type { Reads } from "./db.ts";

export type Authority = "owner" | "agent" | "none";

/** Whether the unit at `unit` (a column reference) is the owner's decision now: an unretracted owner_statement or explicit adoption */
export const ownerAdopted = (unit: string) =>
  sql<SqlBool>`exists (select 1 from unit_adoption a where a.unit_id = ${sql.ref(unit)}
    and a.route in ('owner_statement', 'explicit') and a.retracted_at is null)`;

/** The authority of each unit as of `asOf` (now when omitted). Owner outranks agent: an AI never overrides what the owner adopted */
export async function authorityOf(db: Reads, ids: number[], asOf?: string): Promise<Map<number, Authority>> {
  const out = new Map<number, Authority>(ids.map((id) => [id, "none"]));
  if (!ids.length) return out;
  const at = asOf ?? "9999";
  const rows = await db
    .selectFrom("unit_adoption")
    .select(["unit_id", "route"])
    .where("unit_id", "in", ids)
    .where("added_at", "<=", at)
    .where((eb) => eb.or([eb("retracted_at", "is", null), eb("retracted_at", ">", at)]))
    .execute();
  for (const r of rows) {
    if (r.route === "agent") {
      if (out.get(r.unit_id) === "none") out.set(r.unit_id, "agent");
    } else out.set(r.unit_id, "owner");
  }
  return out;
}
