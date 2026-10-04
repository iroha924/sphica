// Whose decision a record is: the owner's (the owner's or a maintainer's adoption), an AI's (only the AI's own adoption), or no one's yet.
// Read from adoption history alone, so a past time gives the authority a record had then.

import { type SqlBool, sql } from "kysely";
import type { Reads } from "./db.ts";

export type Authority = "owner" | "agent" | "none";

/** How every surface names an authority */
export const AUTHORITY = {
  owner: "the owner's decision",
  agent: "decided by an AI",
  none: "adopted by no one",
} as const;

/** Sphica's own words for records an AI decided, never taken from a record: shown only beside one */
export const AI_DECIDED =
  "A record marked decided by an AI was decided by an AI in an earlier session, not by the owner (unmarked delivered decisions are the owner's): with a concrete reason you may depart from it, saying in your reply which record and why. It never relaxes the owner's rules, public contracts, or approval gates.";

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
 * Records of the project that were ever active as an AI's decision, for evaluating how those decisions held up. A record becomes one when
 * it turns active with only the AI's adoption, or stays active while the owner's adoption is taken back. A later owner adoption,
 * replacement, or withdrawal keeps a record here: those are what the evaluation looks for. Read from state and adoption history alone.
 */
export async function agentHistory(db: Reads, projectId: number): Promise<AgentHistory[]> {
  const units = await db
    .selectFrom("unit as u")
    .where("u.project_id", "=", projectId)
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom("unit_adoption as a")
          .select("a.id")
          .whereRef("a.unit_id", "=", "u.id")
          .where("a.route", "=", "agent"),
      ),
    )
    .select(["u.id", "u.key", "u.content_hash", "u.lifecycle"])
    .orderBy("u.id")
    .execute();
  if (!units.length) return [];
  const ids = units.map((u) => u.id);
  const [states, adoptions] = await Promise.all([
    db
      .selectFrom("unit_state")
      .where("unit_id", "in", ids)
      .select(["unit_id", "to_state", "at"])
      .orderBy("at")
      .orderBy("id")
      .execute(),
    db
      .selectFrom("unit_adoption")
      .where("unit_id", "in", ids)
      .select(["unit_id", "route", "source_id", "span_start", "span_end", "added_at", "retracted_at"])
      .orderBy("id")
      .execute(),
  ]);
  const out: AgentHistory[] = [];
  for (const u of units) {
    const mine = states.filter((s) => s.unit_id === u.id);
    const theirs = adoptions.filter((a) => a.unit_id === u.id);
    // The moments its authority or state can turn it into an AI's active decision
    const moments = [
      ...mine.filter((s) => s.to_state === "active").map((s) => s.at),
      ...theirs.flatMap((a) => (a.route !== "agent" && a.retracted_at ? [a.retracted_at] : [])),
    ].sort();
    for (const at of moments) {
      const state = mine.filter((s) => s.at <= at).at(-1)?.to_state;
      if (state !== "active" || (await authorityOf(db, [u.id], at)).get(u.id) !== "agent") continue;
      out.push({
        id: u.id,
        key: u.key,
        activeAt: at,
        adoptions: theirs
          .filter(
            (a) =>
              a.route === "agent" && a.added_at <= at && (a.retracted_at === null || a.retracted_at > at),
          )
          .map((a) => ({ sourceId: a.source_id, spanStart: a.span_start, spanEnd: a.span_end })),
        contentHash: u.content_hash,
        lifecycle: u.lifecycle,
        authority: "none",
      });
      break;
    }
  }
  const now = await authorityOf(
    db,
    out.map((h) => h.id),
  );
  return out
    .sort((a, b) => (a.activeAt < b.activeAt ? -1 : a.activeAt > b.activeAt ? 1 : a.id - b.id))
    .map((h) => ({ ...h, authority: now.get(h.id) ?? "none" }));
}
