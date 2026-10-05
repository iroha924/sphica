/**
 * Lifecycles and replacements judged from facts alone (intents to replace, support, adoption, withdrawals), so the result never depends on
 * the order facts were written in. Pure and synchronous: saves and the migration fetch a snapshot and write back only the difference.
 */

export type Lifecycle = "candidate" | "active" | "superseded" | "withdrawn";

export type UnitFacts = {
  id: number;
  kind: string;
  /** The stored lifecycle, or null for a unit this batch creates */
  lifecycle: Lifecycle | null;
  /** An explicit withdrawal, stored or asked for in this batch: final */
  withdrawn: boolean;
  /** extraction = 'supported' and unsourced = 0: a unit that can ever become active */
  sound: boolean;
  /** extraction = 'quarantined': its quote was never found, so it stays a candidate and nothing replaces it */
  quarantined: boolean;
  /** unit_support finds nothing missing */
  supported: boolean;
  /** An unretracted owner_statement or explicit adoption */
  ownerAdopted: boolean;
};

/** A record's intent to replace another (unit_link supersedes); a record has at most one */
export type Intent = { from: number; to: number; addedAt: string };

/** The replacement in effect into a record (an open unit_replacement row) */
export type OpenRow = { from: number; to: number };

export type Snapshot = { units: UnitFacts[]; intents: Intent[]; open: OpenRow[] };

/** Why a unit stays a candidate. Shown to whoever saved it; never stored as a lifecycle */
type Wait =
  | { why: "unsound" }
  | { why: "unsupported" }
  | { why: "no owner adoption" }
  | { why: "place held"; holder: number }
  | { why: "target withdrawn" }
  | { why: "target quarantined" }
  | { why: "kinds" };

export type Judged = {
  lifecycle: Map<number, Lifecycle>;
  /** Target → the successor whose replacement is in effect */
  holders: Map<number, number>;
  waits: Map<number, Wait>;
  /** Why each unit that holds no place could not stand, whatever its lifecycle */
  unstood: Map<number, Wait>;
};

/** A record replaces one of its own kind; a decision and a constraint can replace each other. The schema checks the same pairs */
export const replaceable = (successor: string, old: string): boolean =>
  successor === old ||
  (["decision", "constraint"].includes(successor) && ["decision", "constraint"].includes(old));

const owned = (kind: string) => kind === "decision" || kind === "constraint";

export function judge(s: Snapshot): Judged {
  const units = new Map(s.units.map((u) => [u.id, u]));
  const intentOf = new Map(s.intents.map((i) => [i.from, i]));
  const openInto = new Map(s.open.map((r) => [r.to, r.from]));
  const waits = new Map<number, Wait>();

  // Whether a unit could stand on its own facts. A decision or constraint replacing another needs the owner's or a maintainer's adoption:
  // an AI's adoption, or none, never takes effect on any record
  const unfit = (u: UnitFacts): Wait | null =>
    !u.sound
      ? { why: "unsound" }
      : !u.supported
        ? { why: "unsupported" }
        : owned(u.kind) && intentOf.has(u.id) && !u.ownerAdopted
          ? { why: "no owner adoption" }
          : null;

  // Contenders for each target's one place: fit, not withdrawn, of a kind that may replace it, into a sound target not withdrawn
  const contenders = new Map<number, Intent[]>();
  for (const i of [...intentOf.values()].sort(order)) {
    const from = units.get(i.from);
    const to = units.get(i.to);
    if (!from || !to || from.withdrawn) continue;
    const why: Wait | null =
      unfit(from) ??
      (!replaceable(from.kind, to.kind)
        ? { why: "kinds" }
        : to.withdrawn
          ? { why: "target withdrawn" }
          : to.quarantined
            ? { why: "target quarantined" }
            : null);
    if (why) {
      waits.set(from.id, why);
      continue;
    }
    contenders.set(i.to, [...(contenders.get(i.to) ?? []), i]);
  }

  // The holder keeps the place while it still contends; a free place goes to the intent saved first
  const holders = new Map<number, number>();
  for (const [to, list] of contenders) {
    const kept = openInto.get(to);
    const holder = list.some((i) => i.from === kept) ? (kept as number) : (list[0] as Intent).from;
    holders.set(to, holder);
    for (const i of list) if (i.from !== holder) waits.set(i.from, { why: "place held", holder });
  }
  const holds = new Set(holders.values());

  const lifecycle = new Map<number, Lifecycle>();
  for (const u of s.units) {
    if (u.withdrawn) {
      lifecycle.set(u.id, "withdrawn");
      waits.delete(u.id);
    } else if (holders.has(u.id)) lifecycle.set(u.id, "superseded");
    else if (!unfit(u) && (!intentOf.has(u.id) || holds.has(u.id))) {
      lifecycle.set(u.id, "active");
      waits.delete(u.id);
    } else {
      lifecycle.set(u.id, "candidate");
      if (!waits.has(u.id)) waits.set(u.id, unfit(u) ?? { why: "unsupported" });
    }
  }
  // A superseded unit waits for nothing it can act on; what it waited for is not shown
  // Why a unit cannot stand, kept for every unit: a replaced one that loses its adoption ends its own replacement for that reason
  const unstood = new Map<number, Wait>();
  for (const [id, w] of waits) unstood.set(id, w);
  for (const [id, l] of lifecycle) if (l !== "candidate") waits.delete(id);
  return { lifecycle, holders, waits, unstood };
}

/** The intent saved first, ties by the successor's id: the same input in any order picks the same holder */
function order(a: Intent, b: Intent): number {
  return a.addedAt < b.addedAt ? -1 : a.addedAt > b.addedAt ? 1 : a.from - b.from;
}

type Transition = { unit: number; from: Lifecycle | null; to: Lifecycle };

export type Plan = {
  /** Open rows that end, ended before any row opens: a place is freed before another takes it */
  close: OpenRow[];
  open: OpenRow[];
  /** A new unit's first state is always candidate; a transition into withdrawn comes only from a withdrawal fact */
  transitions: Transition[];
};

/**
 * What to write to move the stored state to the judged one: rows that end, rows that start, then each lifecycle change, in that order,
 * so each state row finds the replacement it needs already there. Throws when facts ask for a change no lifecycle allows.
 */
export function difference(s: Snapshot, j: Judged): Plan {
  const close: OpenRow[] = [];
  const open: OpenRow[] = [];
  const stored = new Map(s.open.map((r) => [r.to, r.from]));
  for (const r of s.open) if (j.holders.get(r.to) !== r.from) close.push(r);
  for (const [to, from] of j.holders) if (stored.get(to) !== from) open.push({ from, to });
  const transitions: Transition[] = [];
  for (const u of s.units) {
    const to = j.lifecycle.get(u.id) as Lifecycle;
    if (u.lifecycle === null) {
      transitions.push({ unit: u.id, from: null, to: "candidate" });
      if (to !== "candidate") transitions.push({ unit: u.id, from: "candidate", to });
      continue;
    }
    if (u.lifecycle === to) continue;
    if (u.lifecycle === "withdrawn") throw new Error(`unit ${u.id} is withdrawn, which is final`);
    if (u.lifecycle === "superseded" && to === "withdrawn")
      throw new Error(`unit ${u.id} is superseded; withdraw what replaced it instead`);
    transitions.push({ unit: u.id, from: u.lifecycle, to });
  }
  return { close, open, transitions };
}
