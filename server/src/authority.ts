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

export type AgentHistory = {
  id: number;
  key: string;
  /** When it first became active as an AI's decision, with the AI's adoptions in effect then */
  activeAt: string;
  adoptions: { sourceId: number; spanStart: number; spanEnd: number }[];
  /** A unit's text never changes, so its hash now is its hash then */
  contentHash: Buffer;
  lifecycle: string;
  authority: Authority;
};

/**
 * Records of the project that were ever active as an AI's decision, for evaluating how those decisions held up. A later owner adoption,
 * replacement, or withdrawal keeps a record here: those are what the evaluation looks for. Read from state and adoption history alone.
 */
export async function agentHistory(db: Reads, projectId: number): Promise<AgentHistory[]> {
  const activations = await db
    .selectFrom("unit_state as s")
    .innerJoin("unit as u", "u.id", "s.unit_id")
    .where("u.project_id", "=", projectId)
    .where("s.to_state", "=", "active")
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom("unit_adoption as a")
          .select("a.id")
          .whereRef("a.unit_id", "=", "u.id")
          .where("a.route", "=", "agent"),
      ),
    )
    .select(["u.id", "u.key", "u.content_hash", "u.lifecycle", "s.at"])
    .orderBy("s.at")
    .orderBy("s.id")
    .execute();
  const out = new Map<number, AgentHistory>();
  for (const a of activations) {
    if (out.has(a.id) || (await authorityOf(db, [a.id], a.at)).get(a.id) !== "agent") continue;
    const adoptions = await db
      .selectFrom("unit_adoption")
      .where("unit_id", "=", a.id)
      .where("route", "=", "agent")
      .where("added_at", "<=", a.at)
      .where((eb) => eb.or([eb("retracted_at", "is", null), eb("retracted_at", ">", a.at)]))
      .select(["source_id", "span_start", "span_end"])
      .orderBy("id")
      .execute();
    out.set(a.id, {
      id: a.id,
      key: a.key,
      activeAt: a.at,
      adoptions: adoptions.map((x) => ({
        sourceId: x.source_id,
        spanStart: x.span_start,
        spanEnd: x.span_end,
      })),
      contentHash: a.content_hash,
      lifecycle: a.lifecycle,
      authority: "none",
    });
  }
  const now = await authorityOf(db, [...out.keys()]);
  return [...out.values()].map((h) => ({ ...h, authority: now.get(h.id) ?? "none" }));
}
