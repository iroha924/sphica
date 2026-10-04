// The one writer of lifecycles and replacements. Saves change facts, then call reconcile once: it judges the records the facts reach
// (server/src/judge.ts), writes only the difference, and judges again to prove nothing is left over, or throws so the save rolls back.

import { type Kysely, sql } from "kysely";
import { iso, type Reads } from "./db.ts";
import type { DB } from "./db-types.ts";
import { difference, type Judged, judge, type Lifecycle, type OpenRow, type Snapshot } from "./judge.ts";

/** What made this change: a record server run, or the owner forgetting sources */
export type Cause = { runId: number } | { forgetId: number };

/** A writer's words for a unit's change: the reason to show, and the source it rests on */
export type Hint = { reason: string; source: number | null };

export type Asked = {
  /** Withdrawals this batch asks for. One a record of this batch replaces is redundant and not written */
  withdraw?: Map<number, Hint>;
  /** How to word a unit's change when it becomes active */
  hints?: Map<number, Hint>;
  /** What this batch did, put before the reason a unit lost its support */
  because?: string;
};

type Change = { id: number; key: string; before: Lifecycle; after: Lifecycle };

export type Reconciled = {
  changes: Change[];
  /** Why each judged unit that stays a candidate waits, worded for whoever saved it */
  waits: Map<number, string>;
  /** Units waiting because another successor holds their target's place: unit → [target, holder] */
  held: Map<number, [number, number]>;
  /** Withdrawals asked for that a record of this batch made redundant by replacing the unit */
  redundant: number[];
  keys: Map<number, string>;
};

/** A new unit's first state, written with it before anything is judged: every unit starts a candidate */
export async function firstState(
  trx: Kysely<DB>,
  unitId: number,
  reason: string,
  runId: number,
  at: string,
): Promise<void> {
  await trx
    .insertInto("unit_state")
    .values({ unit_id: unitId, from_state: null, to_state: "candidate", at, reason, run_id: runId })
    .execute();
}

/** Every record linked to the seeds by intents to replace, either way: what one of them does can change the others */
async function closure(db: Reads, seeds: number[]): Promise<number[]> {
  const seen = new Set(seeds);
  for (let frontier = [...seen]; frontier.length; ) {
    const links = await db
      .selectFrom("unit_link")
      .select(["from_unit", "to_unit"])
      .where("kind", "=", "supersedes")
      .where((eb) => eb.or([eb("from_unit", "in", frontier), eb("to_unit", "in", frontier)]))
      .execute();
    frontier = [];
    for (const l of links)
      for (const id of [l.from_unit, l.to_unit])
        if (!seen.has(id)) {
          seen.add(id);
          frontier.push(id);
        }
  }
  return [...seen];
}

type Loaded = { snapshot: Snapshot; keys: Map<number, string>; missing: Map<number, string> };

async function load(db: Reads, ids: number[], withdraw: Set<number>): Promise<Loaded> {
  const units = ids.length
    ? await db
        .selectFrom("unit as u")
        .leftJoin("unit_support as s", "s.unit_id", "u.id")
        .select((eb) => [
          "u.id",
          "u.key",
          "u.kind",
          "u.lifecycle",
          "u.extraction",
          "u.unsourced",
          "s.missing",
          eb
            .exists(
              eb.selectFrom("unit_state as t").whereRef("t.unit_id", "=", "u.id").select(sql`1`.as("x")),
            )
            .as("stated"),
          eb
            .exists(
              eb
                .selectFrom("unit_adoption as a")
                .whereRef("a.unit_id", "=", "u.id")
                .where("a.route", "in", ["owner_statement", "explicit"])
                .where("a.retracted_at", "is", null)
                .select(sql`1`.as("x")),
            )
            .as("owned"),
          // The owner's quote a reconsider condition needs before its record first becomes active (the state rules check the same)
          eb
            .exists(
              eb
                .selectFrom("unit_option as o")
                .whereRef("o.unit_id", "=", "u.id")
                .where("o.reconsider_when", "is not", null)
                .where(({ not, exists, selectFrom }) =>
                  not(
                    exists(
                      selectFrom("unit_evidence as e")
                        .innerJoin("source as src", "src.id", "e.source_id")
                        .whereRef("e.option_id", "=", "o.id")
                        .where("e.role", "=", "reconsiders")
                        .where("src.author_kind", "=", "owner")
                        .select(sql`1`.as("x")),
                    ),
                  ),
                )
                .select(sql`1`.as("x")),
            )
            .as("unquoted"),
        ])
        .where("u.id", "in", ids)
        .execute()
    : [];
  const intents = ids.length
    ? await db
        .selectFrom("unit_link")
        .select(["from_unit", "to_unit", "added_at"])
        .where("kind", "=", "supersedes")
        .where("from_unit", "in", ids)
        .execute()
    : [];
  const open = ids.length
    ? await db
        .selectFrom("unit_replacement")
        .select(["from_unit", "to_unit"])
        .where("ended_at", "is", null)
        .where("to_unit", "in", ids)
        .execute()
    : [];
  const keys = new Map(units.map((u) => [u.id, u.key]));
  const missing = new Map<number, string>();
  const snapshot: Snapshot = {
    units: units.map((u) => {
      // A unit with no state yet starts as a candidate, written before anything else
      const lifecycle = Number(u.stated) === 1 ? (u.lifecycle as Lifecycle) : null;
      // Kept active without it (a quote forgotten later leaves the record as it was); never activated without it
      const unquoted = Number(u.unquoted) === 1 && lifecycle !== "active";
      if (u.missing) missing.set(u.id, u.missing);
      else if (unquoted) missing.set(u.id, "a reconsider condition needs a quote of the owner");
      return {
        id: u.id,
        kind: u.kind,
        lifecycle,
        withdrawn: lifecycle === "withdrawn" || withdraw.has(u.id),
        sound: u.extraction === "supported" && u.unsourced === 0,
        quarantined: u.extraction !== "supported",
        supported: u.missing === null && !unquoted,
        ownerAdopted: Number(u.owned) === 1,
      };
    }),
    intents: intents.map((i) => ({ from: i.from_unit, to: i.to_unit, addedAt: i.added_at })),
    open: open.map((r) => ({ from: r.from_unit, to: r.to_unit })),
  };
  return { snapshot, keys, missing };
}

function waitText(
  j: Judged,
  id: number,
  keys: Map<number, string>,
  missing: Map<number, string>,
  target?: number,
): string {
  const w = j.waits.get(id);
  const name = (u: number | undefined) => (u === undefined ? "its target" : (keys.get(u) ?? `u${u}`));
  switch (w?.why) {
    case "unsound":
      return "its quote was not found or its source is gone, so it can never become active";
    case "unsupported":
      return missing.get(id) ?? "its support is not complete";
    case "no owner adoption":
      return "replacing another record needs the owner's or a maintainer's adoption";
    case "place held":
      return `waits: ${name(w.holder)} is in effect as the successor of ${name(target)}`;
    case "target withdrawn":
      return `${name(target)} is withdrawn, so there is nothing to replace`;
    case "target quarantined":
      return `${name(target)} is quarantined (its quote was never found), so it cannot be replaced`;
    case "kinds":
      return `${name(target)} is of a kind this record cannot replace`;
    default:
      return "its support is not complete";
  }
}

/**
 * Judges the records the seeds reach and writes the difference: replacements that end, those that start, then lifecycle changes, so each
 * state row finds the replacement it needs. Throws when the result does not hold up when judged again.
 */
export async function reconcile(
  trx: Kysely<DB>,
  seeds: number[],
  cause: Cause,
  asked: Asked = {},
): Promise<Reconciled> {
  const at = iso(Date.now());
  const ids = await closure(trx, seeds);
  const withdraw = new Map(asked.withdraw ?? []);
  // A record this batch replaces needs no withdrawal: judge without the asked ones first, and drop those that end up superseded
  const first = await load(trx, ids, new Set());
  const without = judge(first.snapshot);
  const redundant = [...withdraw.keys()].filter((id) => without.lifecycle.get(id) === "superseded");
  for (const id of redundant) withdraw.delete(id);
  const { snapshot, keys, missing } = withdraw.size ? await load(trx, ids, new Set(withdraw.keys())) : first;
  const judged = judge(snapshot);
  const plan = difference(snapshot, judged);
  const intentOf = new Map(snapshot.intents.map((i) => [i.from, i.to]));
  const by = "runId" in cause ? { run: cause.runId, forget: null } : { run: null, forget: cause.forgetId };
  const ended = new Map<number, OpenRow>();

  for (const r of plan.close) {
    const now = judged.lifecycle.get(r.from);
    const reason =
      now === "withdrawn"
        ? `${keys.get(r.from)} was withdrawn`
        : judged.holders.has(r.to)
          ? `${keys.get(judged.holders.get(r.to) as number)} took its place`
          : `${keys.get(r.from)} no longer stands: ${waitText(judged, r.from, keys, missing, r.to)}`;
    await trx
      .updateTable("unit_replacement")
      .set({
        ended_at: at,
        end_reason: reason,
        ...(by.run !== null ? { end_run_id: by.run } : { end_forget_id: by.forget }),
      })
      .where("from_unit", "=", r.from)
      .where("to_unit", "=", r.to)
      .where("ended_at", "is", null)
      .execute();
    ended.set(r.to, r);
  }
  for (const r of plan.open)
    await trx
      .insertInto("unit_replacement")
      .values({
        from_unit: r.from,
        to_unit: r.to,
        ...(by.run !== null ? { run_id: by.run } : { forget_id: by.forget }),
        started_at: at,
      })
      .execute();

  const changes: Change[] = [];
  for (const t of plan.transitions) {
    const hint = asked.hints?.get(t.unit);
    const holder = judged.holders.get(t.unit);
    const gone = ended.get(t.unit);
    const reason =
      t.from === null
        ? "first judged"
        : t.to === "withdrawn"
          ? (withdraw.get(t.unit)?.reason ?? "withdrawn")
          : t.to === "superseded"
            ? `superseded by ${keys.get(holder as number)}`
            : t.from === "superseded"
              ? `${gone ? keys.get(gone.from) : "its successor"} no longer replaces it`
              : t.to === "active"
                ? (hint?.reason ?? "support complete")
                : `${asked.because ?? "support lost"}: ${waitText(judged, t.unit, keys, missing, intentOf.get(t.unit))}`;
    const source =
      t.to === "withdrawn"
        ? (withdraw.get(t.unit)?.source ?? null)
        : t.to === "superseded"
          ? (asked.hints?.get(holder as number)?.source ?? null)
          : (hint?.source ?? null);
    await trx
      .insertInto("unit_state")
      .values({
        unit_id: t.unit,
        from_state: t.from,
        to_state: t.to,
        at,
        reason,
        source_id: source,
        run_id: by.run,
        forget_id: by.forget,
      })
      .execute();
    if (t.from !== null)
      changes.push({ id: t.unit, key: keys.get(t.unit) ?? `u${t.unit}`, before: t.from, after: t.to });
  }

  // What was written must judge to itself: anything left over is a rule the writes broke, so the whole save goes back
  const after = await load(trx, ids, new Set());
  const left = difference(after.snapshot, judge(after.snapshot));
  if (left.close.length || left.open.length || left.transitions.length)
    throw new Error(`records did not settle after judging: ${JSON.stringify(left)}`);

  const waits = new Map<number, string>();
  const held = new Map<number, [number, number]>();
  for (const [id, l] of judged.lifecycle) {
    if (l !== "candidate") continue;
    waits.set(id, waitText(judged, id, keys, missing, intentOf.get(id)));
    const w = judged.waits.get(id);
    if (w?.why === "place held") held.set(id, [intentOf.get(id) as number, w.holder]);
  }
  return { changes, waits, held, redundant, keys };
}
