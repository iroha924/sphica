// The one writer of lifecycles and replacements. Saves change facts, then call reconcile once: it judges the records the facts reach
// (server/src/judge.ts), writes only the difference, and judges again to prove nothing is left over, or throws so the save rolls back.

import { type Kysely, sql } from "kysely";
import { iso, type Reads } from "./db.ts";
import type { DB } from "./db-types.ts";
import { difference, type Judged, judge, type Lifecycle, type Plan, type Snapshot } from "./judge.ts";

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

/** A unit's stored facts as both readers fetch them */
type UnitRow = {
  id: number;
  key: string;
  kind: string;
  lifecycle: string;
  extraction: string;
  unsourced: number;
  missing: string | null;
  stated: number;
  owned: number;
  unquoted: number;
  /** Ever active: a reconsider condition's quote is needed only to become active the first time */
  ever: number;
};
type Rows = {
  units: UnitRow[];
  intents: { from_unit: number; to_unit: number; added_at: string }[];
  open: { from_unit: number; to_unit: number }[];
};
type Loaded = { snapshot: Snapshot; keys: Map<number, string>; missing: Map<number, string> };

function snapshotOf(rows: Rows, withdraw: Set<number>): Loaded {
  const keys = new Map(rows.units.map((u) => [u.id, u.key]));
  const missing = new Map<number, string>();
  const snapshot: Snapshot = {
    units: rows.units.map((u) => {
      // A unit with no state yet starts as a candidate, written before anything else
      const lifecycle = Number(u.stated) === 1 ? (u.lifecycle as Lifecycle) : null;
      // Needed only to become active the first time: a quote forgotten later leaves the record as it was
      const unquoted = Number(u.unquoted) === 1 && Number(u.ever) === 0;
      if (u.missing) missing.set(u.id, u.missing);
      else if (unquoted) missing.set(u.id, "a reconsider condition needs a quote of the owner");
      return {
        id: u.id,
        kind: u.kind,
        lifecycle,
        withdrawn: lifecycle === "withdrawn" || withdraw.has(u.id),
        sound: u.extraction === "supported" && Number(u.unsourced) === 0,
        quarantined: u.extraction !== "supported",
        supported: u.missing === null && !unquoted,
        ownerAdopted: Number(u.owned) === 1,
      };
    }),
    intents: rows.intents.map((i) => ({ from: i.from_unit, to: i.to_unit, addedAt: i.added_at })),
    open: rows.open.map((r) => ({ from: r.from_unit, to: r.to_unit })),
  };
  return { snapshot, keys, missing };
}

function waitText(j: Judged, id: number, l: Loaded, target?: number): string {
  const w = j.waits.get(id) ?? j.unstood.get(id);
  const name = (u: number | undefined) => (u === undefined ? "its target" : (l.keys.get(u) ?? `u${u}`));
  switch (w?.why) {
    case "unsound":
      return "its quote was not found or its source is gone, so it can never become active";
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
      return l.missing.get(id) ?? "its support is not complete";
  }
}

/** One write, worded: replacements that end, those that start, then lifecycle changes, in that order */
type Write =
  | { op: "close"; from: number; to: number; reason: string }
  | { op: "open"; from: number; to: number }
  | {
      op: "state";
      unit: number;
      from: Lifecycle | null;
      to: Lifecycle;
      reason: string;
      source: number | null;
    };

type Planned = {
  judged: Judged;
  loaded: Loaded;
  writes: Write[];
  redundant: number[];
  intentOf: Map<number, number>;
};

/** What to write, decided from one snapshot before anything is written. A withdrawal of a record this batch replaces is dropped */
function planOf(rows: Rows, asked: Asked): Planned {
  const withdraw = new Map(asked.withdraw ?? []);
  // A withdrawal is redundant when the record ends up replaced with every other withdrawal of the batch applied, so withdrawing a record
  // and the successor that would replace it withdraws both
  const asking = [...withdraw.keys()];
  const redundant = asking.filter(
    (id) =>
      judge(snapshotOf(rows, new Set(asking.filter((other) => other !== id))).snapshot).lifecycle.get(id) ===
      "superseded",
  );
  for (const id of redundant) withdraw.delete(id);
  const loaded = snapshotOf(rows, new Set(withdraw.keys()));
  const judged = judge(loaded.snapshot);
  const plan: Plan = difference(loaded.snapshot, judged);
  const { keys } = loaded;
  const intentOf = new Map(loaded.snapshot.intents.map((i) => [i.from, i.to]));
  const writes: Write[] = [];
  const ended = new Map<number, number>();
  for (const r of plan.close) {
    const reason =
      judged.lifecycle.get(r.from) === "withdrawn"
        ? `${keys.get(r.from)} was withdrawn`
        : judged.holders.has(r.to)
          ? `${keys.get(judged.holders.get(r.to) as number)} took its place`
          : `${keys.get(r.from)} no longer stands: ${waitText(judged, r.from, loaded, r.to)}`;
    writes.push({ op: "close", from: r.from, to: r.to, reason });
    ended.set(r.to, r.from);
  }
  for (const r of plan.open) writes.push({ op: "open", from: r.from, to: r.to });
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
              ? `${gone !== undefined ? keys.get(gone) : "its successor"} no longer replaces it`
              : t.to === "active"
                ? (hint?.reason ?? "support complete")
                : `${asked.because ?? "support lost"}: ${waitText(judged, t.unit, loaded, intentOf.get(t.unit))}`;
    const source =
      t.to === "withdrawn"
        ? (withdraw.get(t.unit)?.source ?? null)
        : t.to === "superseded"
          ? (asked.hints?.get(holder as number)?.source ?? null)
          : (hint?.source ?? null);
    writes.push({ op: "state", unit: t.unit, from: t.from, to: t.to, reason, source });
  }
  return { judged, loaded, writes, redundant, intentOf };
}

function settled(p: Planned): Reconciled {
  const changes: Change[] = p.writes.flatMap((w) =>
    w.op === "state" && w.from !== null
      ? [{ id: w.unit, key: p.loaded.keys.get(w.unit) ?? `u${w.unit}`, before: w.from, after: w.to }]
      : [],
  );
  const waits = new Map<number, string>();
  const held = new Map<number, [number, number]>();
  for (const [id, l] of p.judged.lifecycle) {
    if (l !== "candidate") continue;
    waits.set(id, waitText(p.judged, id, p.loaded, p.intentOf.get(id)));
    const w = p.judged.waits.get(id);
    if (w?.why === "place held") held.set(id, [p.intentOf.get(id) as number, w.holder]);
  }
  return { changes, waits, held, redundant: p.redundant, keys: p.loaded.keys };
}

/** What was written must judge to itself: anything left over is a rule the writes broke, so the whole batch goes back */
function proveSettled(rows: Rows): void {
  const after = snapshotOf(rows, new Set()).snapshot;
  const left = difference(after, judge(after));
  if (left.close.length || left.open.length || left.transitions.length)
    throw new Error(`records did not settle after judging: ${JSON.stringify(left)}`);
}

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

async function rowsOf(db: Reads, ids: number[]): Promise<Rows> {
  if (!ids.length) return { units: [], intents: [], open: [] };
  const units = await db
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
        .exists(eb.selectFrom("unit_state as t").whereRef("t.unit_id", "=", "u.id").select(sql`1`.as("x")))
        .as("stated"),
      eb
        .exists(
          eb
            .selectFrom("unit_state as t")
            .whereRef("t.unit_id", "=", "u.id")
            .where("t.to_state", "=", "active")
            .select(sql`1`.as("x")),
        )
        .as("ever"),
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
    .execute();
  const intents = await db
    .selectFrom("unit_link")
    .select(["from_unit", "to_unit", "added_at"])
    .where("kind", "=", "supersedes")
    .where("from_unit", "in", ids)
    .execute();
  const open = await db
    .selectFrom("unit_replacement")
    .select(["from_unit", "to_unit"])
    .where("ended_at", "is", null)
    .where("to_unit", "in", ids)
    .execute();
  return {
    units: units.map((u) => ({
      ...u,
      unsourced: Number(u.unsourced),
      stated: Number(u.stated),
      ever: Number(u.ever),
      owned: Number(u.owned),
      unquoted: Number(u.unquoted),
    })),
    intents,
    open,
  };
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
  const planned = planOf(await rowsOf(trx, ids), asked);
  const by = "runId" in cause ? { run_id: cause.runId } : { forget_id: cause.forgetId };
  const endBy = "runId" in cause ? { end_run_id: cause.runId } : { end_forget_id: cause.forgetId };
  for (const w of planned.writes) {
    if (w.op === "close")
      await trx
        .updateTable("unit_replacement")
        .set({ ended_at: at, end_reason: w.reason, ...endBy })
        .where("from_unit", "=", w.from)
        .where("to_unit", "=", w.to)
        .where("ended_at", "is", null)
        .execute();
    else if (w.op === "open")
      await trx
        .insertInto("unit_replacement")
        .values({ from_unit: w.from, to_unit: w.to, ...by, started_at: at })
        .execute();
    else
      await trx
        .insertInto("unit_state")
        .values({
          unit_id: w.unit,
          from_state: w.from,
          to_state: w.to,
          at,
          reason: w.reason,
          source_id: w.source,
          ...by,
        })
        .execute();
  }
  proveSettled(await rowsOf(trx, ids));
  return settled(planned);
}

/** The statements the migration runs on its own connection: what it reads, and what it writes */
export type MigrationIO = {
  all: (sql: string, ...params: (string | number | null)[]) => unknown[];
  run: (sql: string, ...params: (string | number | null)[]) => void;
};

const UNITS_SQL = `select u.id, u.key, u.kind, u.lifecycle, u.extraction, u.unsourced, s.missing,
  exists (select 1 from unit_state t where t.unit_id = u.id) as stated,
  exists (select 1 from unit_state t where t.unit_id = u.id and t.to_state = 'active') as ever,
  exists (select 1 from unit_adoption a where a.unit_id = u.id and a.route in ('owner_statement', 'explicit')
    and a.retracted_at is null) as owned,
  exists (select 1 from unit_option o where o.unit_id = u.id and o.reconsider_when is not null and not exists (
    select 1 from unit_evidence e join source src on src.id = e.source_id
    where e.option_id = o.id and e.role = 'reconsiders' and src.author_kind = 'owner')) as unquoted
from unit u left join unit_support s on s.unit_id = u.id where u.project_id = ? order by u.id`;
const INTENTS_SQL = `select l.from_unit, l.to_unit, l.added_at from unit_link l join unit u on u.id = l.from_unit
where l.kind = 'supersedes' and u.project_id = ?`;
const OPEN_SQL = `select r.from_unit, r.to_unit from unit_replacement r join unit u on u.id = r.to_unit
where r.ended_at is null and u.project_id = ?`;

/**
 * The migration to revision 10 judges every record of each project the same way saves do, on the migration's own connection, and returns
 * one line per change for the migration notes. runs names the migration run of each project.
 */
export function settleForMigration(
  io: MigrationIO,
  runs: Map<number, number>,
  at: string,
): [string, string][] {
  const notes: [string, string][] = [];
  for (const [project, run] of runs) {
    // A record no release saved (one with no state at all) is left as it is: no save would ever judge it
    const rowsNow = (): Rows => {
      const units = (io.all(UNITS_SQL, project) as UnitRow[]).filter((u) => Number(u.stated) === 1);
      const ids = new Set(units.map((u) => u.id));
      return {
        units,
        intents: (io.all(INTENTS_SQL, project) as Rows["intents"]).filter(
          (i) => ids.has(i.from_unit) && ids.has(i.to_unit),
        ),
        open: (io.all(OPEN_SQL, project) as Rows["open"]).filter(
          (r) => ids.has(r.from_unit) && ids.has(r.to_unit),
        ),
      };
    };
    const planned = planOf(rowsNow(), {});
    const key = (id: number) => planned.loaded.keys.get(id) ?? `u${id}`;
    for (const w of planned.writes) {
      if (w.op === "close") {
        io.run(
          "update unit_replacement set ended_at = ?, end_reason = ?, end_run_id = ? where from_unit = ? and to_unit = ? and ended_at is null",
          at,
          w.reason,
          run,
          w.from,
          w.to,
        );
        notes.push([`${key(w.from)} → ${key(w.to)}`, `replacement ended: ${w.reason}`]);
      } else if (w.op === "open") {
        io.run(
          "insert into unit_replacement (from_unit, to_unit, run_id, started_at) values (?, ?, ?, ?)",
          w.from,
          w.to,
          run,
          at,
        );
        notes.push([
          `${key(w.from)} → ${key(w.to)}`,
          "in effect from this update (earlier history not recorded)",
        ]);
      } else {
        io.run(
          "insert into unit_state (unit_id, from_state, to_state, at, reason, source_id, run_id) values (?, ?, ?, ?, ?, ?, ?)",
          w.unit,
          w.from,
          w.to,
          at,
          `revision 10: ${w.reason}`,
          w.source,
          run,
        );
        notes.push([key(w.unit), `${w.from ?? "no state"} → ${w.to}: ${w.reason}`]);
      }
    }
    proveSettled(rowsNow());
  }
  return notes;
}
