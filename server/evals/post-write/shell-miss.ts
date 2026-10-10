// The shell-change entry check (M0'): when the agent changed a file through the shell while a record on it was deliverable, did that record
// reach the conversation by the owner's next prompt? Eligibility is as of the call's result, and arrival is read from the transcript.
// Modes: the draw (--db), --evidence, and --measure; labellers only name the calls that changed the path, and the rest is computed here.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { ReadonlyKysely } from "kysely/readonly";
import { openReader } from "../../src/db.ts";
import type { DB } from "../../src/db-types.ts";
import { deliverableIds } from "../../src/deliver.ts";
import { shuffled } from "./replay.ts";
import {
  type Conversation,
  deliveryObserved,
  freeze,
  lastCompact,
  nextHuman,
  readConversation,
  shown,
  turnStart,
} from "./transcript.ts";

const SHELL = new Set(["Bash", "PowerShell"]);
/** How many pairs are drawn at most, how many measured pairs decide, the miss rate the bar is set at, and the turns of the cause report */
const MAX_DRAWN = 150;
const MEASURED = 30;
const BAR = 0.2;
const TURNS = 30;

export type Candidate = {
  session: string;
  external: string;
  turn: string | null;
  path: string;
  unit: number;
  key: string;
  /** When the turn began (the owner's last message before its end) and ended (its last git status snapshot) */
  start: string;
  end: string;
};

/** A cache of the units deliverable as of each time asked */
function deliverableAt(db: ReadonlyKysely<DB>, projectId: number) {
  const seen = new Map<string, Promise<Set<number>>>();
  return (t: string) => {
    if (!seen.has(t)) seen.set(t, deliverableIds(db, projectId, t));
    return seen.get(t) as Promise<Set<number>>;
  };
}

/** Whether the unit had an applies_to anchor on the path at time t */
async function anchoredAt(db: ReadonlyKysely<DB>, unit: number, file: string, t: string): Promise<boolean> {
  const r = await db
    .selectFrom("unit_anchor")
    .select("id")
    .where("unit_id", "=", unit)
    .where("path", "=", file)
    .where("role", "=", "applies_to")
    .where("added_at", "<=", t)
    .where((eb) => eb.or([eb("retired_at", "is", null), eb("retired_at", ">", t)]))
    .executeTakeFirst();
  return r !== undefined;
}

/** Every time in [start, end] at which what is deliverable can change: state, conflict, and adoption history of the project */
async function changesBetween(
  db: ReadonlyKysely<DB>,
  projectId: number,
  start: string,
  end: string,
): Promise<string[]> {
  const within = (t: string | null) => t !== null && t >= start && t <= end;
  const [states, links, adoptions] = await Promise.all([
    db
      .selectFrom("unit_state as s")
      .innerJoin("unit as u", "u.id", "s.unit_id")
      .select("s.at")
      .where("u.project_id", "=", projectId)
      .where("s.at", ">=", start)
      .where("s.at", "<=", end)
      .execute(),
    db
      .selectFrom("unit_link as l")
      .innerJoin("unit as u", "u.id", "l.from_unit")
      .select(["l.added_at", "l.resolved_at"])
      .where("u.project_id", "=", projectId)
      .where("l.kind", "=", "conflicts")
      .execute(),
    db
      .selectFrom("unit_adoption as a")
      .innerJoin("unit as u", "u.id", "a.unit_id")
      .select(["a.added_at", "a.retracted_at"])
      .where("u.project_id", "=", projectId)
      .execute(),
  ]);
  return [
    ...new Set(
      [
        ...states.map((r) => r.at),
        ...links.flatMap((r) => [r.added_at, r.resolved_at]),
        ...adoptions.flatMap((r) => [r.added_at, r.retracted_at]),
      ].filter((t): t is string => within(t)),
    ),
  ].sort();
}

/**
 * Every (session, turn, path, record) of a path git status alone saw change in a Claude Code turn, for the decisions and constraints that
 * were deliverable at some time in the turn (its start, its end, or any change in between) with an applies_to anchor on the path in the
 * turn: the candidates. Whether one was deliverable at the edit itself is decided after labelling, at that call.
 */
export async function population(db: ReadonlyKysely<DB>, projectId: number): Promise<Candidate[]> {
  const changed = await db
    .selectFrom("edit_observation as e")
    .innerJoin("session as s", "s.id", "e.session_id")
    .where("s.project_id", "=", projectId)
    .where("s.host", "=", "claude-code")
    .where("e.via", "=", "status")
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("edit_observation as t")
            .select("t.id")
            .whereRef("t.session_id", "=", "e.session_id")
            .whereRef("t.path", "=", "e.path")
            .where("t.via", "=", "tool")
            .where((eb) =>
              eb(eb.fn.coalesce("t.turn_id", eb.val("")), "=", eb.fn.coalesce("e.turn_id", eb.val(""))),
            ),
        ),
      ),
    )
    .select(["e.session_id as session", "s.external_id as external", "e.turn_id as turn", "e.path"])
    .select((eb) => eb.fn.max("e.observed_at").as("end"))
    .groupBy(["e.session_id", "e.turn_id", "e.path"])
    .orderBy("e.session_id")
    .orderBy("end")
    .orderBy("e.path")
    .execute();
  const at = deliverableAt(db, projectId);
  const out: Candidate[] = [];
  for (const r of changed) {
    const end = String(r.end);
    const began = await db
      .selectFrom("source")
      .select((eb) => eb.fn.max("created_at").as("at"))
      .where("session_id", "=", r.session)
      .where("kind", "=", "session_message")
      .where("author_kind", "=", "owner")
      .where("created_at", "<=", end)
      .executeTakeFirst();
    const start = began?.at ? String(began.at) : end;
    const anchored = await db
      .selectFrom("unit_anchor as a")
      .innerJoin("unit as u", "u.id", "a.unit_id")
      .select(["u.id", "u.key"])
      .where("u.project_id", "=", projectId)
      .where("u.kind", "in", ["decision", "constraint"])
      .where("a.path", "=", r.path)
      .where("a.role", "=", "applies_to")
      .where("a.added_at", "<=", end)
      .where((eb) => eb.or([eb("a.retired_at", "is", null), eb("a.retired_at", ">", start)]))
      .distinct()
      .orderBy("u.id")
      .execute();
    // The anchor's own changes on this path count as moments too: the record must be deliverable and anchored at the same time
    const anchorTimes = await db
      .selectFrom("unit_anchor")
      .select(["added_at", "retired_at"])
      .where("path", "=", r.path)
      .where("role", "=", "applies_to")
      .execute();
    const times = [
      ...new Set([
        start,
        ...(await changesBetween(db, projectId, start, end)),
        ...anchorTimes
          .flatMap((a) => [a.added_at, a.retired_at])
          .filter((t): t is string => !!t && t >= start && t <= end),
        end,
      ]),
    ].sort();
    const sets = await Promise.all(times.map((t) => at(t)));
    const both = async (id: number) => {
      for (const [i, t] of times.entries())
        if (sets[i]?.has(id) && (await anchoredAt(db, id, r.path, t))) return true;
      return false;
    };
    for (const u of anchored)
      if (await both(u.id))
        out.push({
          session: r.session,
          external: r.external,
          turn: r.turn,
          path: r.path,
          unit: u.id,
          key: u.key,
          start,
          end,
        });
  }
  return out;
}

/** The pairs in a seeded order, the first MAX_DRAWN, and for the cause report TURNS turns drawn evenly with one path each */
export function draw(pairs: Candidate[], seed: number): { order: Candidate[]; turns: Candidate[] } {
  const byTurn = new Map<string, Candidate[]>();
  for (const p of pairs) {
    const t = `${p.session}\0${p.turn ?? p.end}`;
    byTurn.set(t, [...(byTurn.get(t) ?? []), p]);
  }
  // A turn, then a path of it, each drawn evenly: a path with many records is no likelier than one with few
  const turns = shuffled([...byTurn.keys()].sort(), seed + 1)
    .slice(0, TURNS)
    .map((t, i) => {
      const inTurn = byTurn.get(t) ?? [];
      const file = shuffled([...new Set(inTurn.map((p) => p.path))].sort(), seed + 2 + i)[0];
      return inTurn.find((p) => p.path === file) as Candidate;
    });
  return { order: shuffled(pairs, seed).slice(0, MAX_DRAWN), turns };
}

/** The successful shell calls that changed the pair's path in its turn ([] for none), or null when the labellers could not settle it */
export type Label = { index: number; calls: string[] | null };

export type Outcome =
  | "not a shell edit"
  | "unresolved"
  | "ineligible"
  | "subagent"
  | "not observed"
  | "no next prompt"
  | "unknown"
  | "shown"
  | "missed";

/** Labels in draw order from 0 with no gap or repeat, each with its calls named or explicitly unresolved */
export function checkLabels(labels: Label[]): void {
  labels.forEach((l, i) => {
    if (l.index !== i)
      throw new Error(`labels must run 0, 1, 2, … without gaps or repeats; found ${l.index} at ${i}`);
    if (l.calls !== null && !(Array.isArray(l.calls) && l.calls.every((c) => typeof c === "string")))
      throw new Error(`label ${i}: calls must be a list of tool_use ids, or null when unresolved`);
  });
}

/**
 * What became of one labelled pair. Of the calls named, the first whose result came when the record was deliverable with its anchor on
 * the path is measured; its window runs from the last compaction before the call to the owner's next prompt, in the conversation that ran it.
 */
export async function outcome(
  db: ReadonlyKysely<DB>,
  projectId: number,
  pair: Candidate,
  label: Label,
  conversations: Conversation[],
): Promise<{ outcome: Outcome; call?: string; at?: string }> {
  if (label.calls === null) return { outcome: "unresolved" };
  if (!label.calls.length) return { outcome: "not a shell edit" };
  const at = deliverableAt(db, projectId);
  // The calls in the order they returned, so the earliest eligible one is measured whatever order the label lists them in
  const named = label.calls.map((id) => {
    const c = conversations.find((x) => x.events.some((e) => e.kind === "call" && e.id === id));
    const call = c?.events.find((e) => e.kind === "call" && e.id === id);
    const result = c?.events.find((e) => e.kind === "result" && e.id === id);
    if (!c || call?.kind !== "call" || result?.kind !== "result" || !result.ok || !result.at)
      throw new Error(
        `label for pair ${label.index}: call ${id} has no successful result in the session's transcripts`,
      );
    if (!SHELL.has(call.name))
      throw new Error(`label for pair ${label.index}: call ${id} is ${call.name}, not a shell call`);
    if (!call.at || call.at < pair.start || call.at > pair.end)
      throw new Error(`label for pair ${label.index}: call ${id} at ${call.at} is outside the pair's turn`);
    return { id, c, call, result, when: result.at as string };
  });
  named.sort((a, b) => a.when.localeCompare(b.when) || a.result.n - b.result.n);
  for (const { id, c, call, result, when } of named) {
    if (!(await at(when)).has(pair.unit) || !(await anchoredAt(db, pair.unit, pair.path, when))) continue;
    const measured = { call: id, at: when };
    if (c.agent !== null) return { outcome: "subagent", ...measured };
    if (!deliveryObserved(c, result.n)) {
      // The turn may have opened at a later line of no known origin, after a delivery; or a line before it that could not be read may
      // have been the delivery that puts it in scope
      const start = turnStart(c, result.n) ?? 0;
      const opened = c.events
        .filter((x) => x.kind === "unknown prompt" && x.n > start && x.n <= result.n)
        .at(-1)?.n;
      const maybe =
        (opened !== undefined && c.events.some((x) => x.kind === "delivery" && x.n < opened)) ||
        c.unreadableLines.some((n) => n < (opened ?? start));
      return { outcome: maybe ? "unknown" : "not observed", ...measured };
    }
    const end = nextHuman(c, result.n);
    // A line after the call that could not be read may have been the owner's next prompt
    if (end === "none")
      return {
        outcome: c.unreadableLines.some((n) => n > call.n) ? "unknown" : "no next prompt",
        ...measured,
      };
    if (end === "unknown") return { outcome: "unknown", ...measured };
    const from = lastCompact(c, call.n);
    if (c.unreadableLines.some((n) => n > from && n < end)) return { outcome: "unknown", ...measured };
    const s = shown(c, from, end, pair.key);
    return { outcome: s === "shown" ? "shown" : s === "not shown" ? "missed" : "unknown", ...measured };
  }
  return { outcome: "ineligible" };
}

/** The 95% Wilson interval of k in n */
export function wilson(k: number, n: number): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const z = 1.959963984540054;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: (c - m) / d, high: (c + m) / d };
}

const verdictOf = (k: number, n: number) => {
  const w = wilson(k, n);
  return n < MEASURED ? "undecided" : w.low >= BAR ? "proceed" : w.high < BAR ? "not adopted" : "undecided";
};

type Decision = {
  drawn: number;
  measured: number;
  missed: number;
  doubtful: number;
  apart: Record<string, number>;
  interval: { low: number; high: number };
  verdict: "proceed" | "not adopted" | "undecided";
};

/**
 * The bar fixed before labelling, on the first MEASURED shown or missed pairs within MAX_DRAWN. An unknown or unresolved pair may be
 * missed, shown, or not countable at all, which also moves where the 30 measured pairs end. Every resolution is followed at once as the
 * set of (measured, missed) states it can reach, and the verdict stands only when every reachable end agrees.
 */
export function decide(outcomes: Outcome[]): Decision {
  const drawnAll = outcomes.slice(0, MAX_DRAWN);
  const doubtful = (o: Outcome) => o === "unknown" || o === "unresolved";
  let states = new Set(["0,0"]);
  for (const o of drawnAll) {
    const next = new Set<string>();
    for (const st of states) {
      const [m, k] = st.split(",").map(Number) as [number, number];
      if (m === MEASURED) {
        next.add(st);
        continue;
      }
      if (o === "shown" || doubtful(o)) next.add(`${m + 1},${k}`);
      if (o === "missed" || doubtful(o)) next.add(`${m + 1},${k + 1}`);
      if ((o !== "shown" && o !== "missed") || doubtful(o)) next.add(st);
    }
    states = next;
  }
  const verdicts = new Set(
    [...states].map((st) => verdictOf(...(st.split(",").map(Number).reverse() as [number, number]))),
  );
  // The numbers reported are one reading: doubtful pairs set aside, which draws the furthest
  let drawn = 0;
  let measured = 0;
  let missed = 0;
  let unsure = 0;
  const apart: Record<string, number> = {};
  for (const o of drawnAll) {
    if (measured === MEASURED) break;
    drawn++;
    if (o === "shown" || o === "missed") {
      measured++;
      if (o === "missed") missed++;
    } else if (doubtful(o)) unsure++;
    else apart[o] = (apart[o] ?? 0) + 1;
  }
  return {
    drawn,
    measured,
    missed,
    doubtful: unsure,
    apart,
    interval: wilson(missed, measured),
    verdict: verdicts.size === 1 ? ([...verdicts][0] as Decision["verdict"]) : "undecided",
  };
}

/** The transcripts of one session: the main conversation and its subagents */
function sessionFiles(dir: string, external: string): string[] {
  const subs = path.join(dir, external, "subagents");
  return [
    `${external}.jsonl`,
    ...(fs.existsSync(subs)
      ? fs
          .readdirSync(subs)
          .filter((f) => f.endsWith(".jsonl"))
          .sort()
          .map((f) => path.join(external, "subagents", f))
      : []),
  ].filter((f) => fs.existsSync(path.join(dir, f)));
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      seed: { type: "string" },
      out: { type: "string" },
      evidence: { type: "string" },
      measure: { type: "string" },
      draw: { type: "string" },
      transcripts: { type: "string" },
      repo: { type: "string" },
      snapshot: { type: "string" },
      from: { type: "string", default: "0" },
      to: { type: "string", default: String(MAX_DRAWN) },
    },
  });
  if (values.evidence) {
    const dir = values.transcripts;
    if (!dir) throw new Error("--transcripts is required");
    const d = JSON.parse(fs.readFileSync(values.evidence, "utf8")) as { order: Candidate[] };
    for (let i = Number(values.from); i < Math.min(Number(values.to), d.order.length); i++) {
      const p = d.order[i] as Candidate;
      console.log(`### ${i} ${p.path} record ${p.key} turn ${p.start} .. ${p.end}`);
      // The calls that name the file are shown whole; the rest of the turn's shell calls are only counted
      const name = path.basename(p.path);
      let others = 0;
      for (const f of sessionFiles(dir, p.external)) {
        const c = readConversation(dir, f);
        for (const e of c.events) {
          if (
            e.kind !== "call" ||
            !["Bash", "PowerShell"].includes(e.name) ||
            !e.at ||
            e.at < p.start ||
            e.at > p.end
          )
            continue;
          const command = String(e.input.command ?? "");
          if (!command.includes(name)) {
            others++;
            continue;
          }
          const r = c.events.find((x) => x.kind === "result" && x.id === e.id);
          const ok = r?.kind === "result" && r.ok ? "ok" : "failed";
          console.log(`  ${e.id} ${c.agent ?? "main"} ${e.at} ${ok}: ${command.slice(0, 4000)}`);
        }
      }
      console.log(`  (${others} other shell calls in the turn do not name ${name})`);
    }
    return;
  }
  if (values.measure) {
    const { draw: drawn, db: file, transcripts: dir, repo, snapshot, out } = values;
    if (!drawn || !file || !dir || !repo || !snapshot || !out)
      throw new Error(
        "--draw, --db, --transcripts, --repo, --snapshot, and --out are required with --measure",
      );
    const d = JSON.parse(fs.readFileSync(drawn, "utf8")) as { order: Candidate[]; projectId: number };
    const labels = (JSON.parse(fs.readFileSync(values.measure, "utf8")) as { labels: Label[] }).labels;
    checkLabels(labels);
    const files = [...new Set(d.order.slice(0, labels.length).flatMap((p) => sessionFiles(dir, p.external)))];
    const conversations = files.map((f) => readConversation(dir, f));
    const inputs = await freeze({ repo, db: file, projectId: d.projectId, out: snapshot, conversations });
    const db = openReader(inputs.snapshot.path);
    try {
      const results = [];
      for (const l of labels) {
        const p = d.order[l.index] as Candidate;
        const mine = conversations.filter((c) => c.session === p.external);
        results.push({
          index: l.index,
          session: p.external,
          turn: p.turn,
          path: p.path,
          key: p.key,
          calls: l.calls,
          ...(await outcome(db, d.projectId, p, l, mine)),
        });
      }
      const decision = decide(results.map((r) => r.outcome));
      fs.writeFileSync(out, `${JSON.stringify({ inputs, results, decision }, null, 2)}\n`);
      console.log(JSON.stringify(decision, null, 2));
    } finally {
      await db.destroy();
    }
    return;
  }
  if (!values.db || !values.seed || !values.out) throw new Error("--db, --seed, and --out are required");
  const db = openReader(values.db);
  try {
    const projects = await db.selectFrom("project").select("id").orderBy("id").execute();
    if (projects.length !== 1 || !projects[0]) throw new Error("the database must hold exactly one project");
    const projectId = projects[0].id;
    const pairs = await population(db, projectId);
    const d = draw(pairs, Number(values.seed));
    fs.writeFileSync(
      values.out,
      `${JSON.stringify({ seed: Number(values.seed), projectId, population: pairs.length, ...d }, null, 2)}\n`,
    );
    console.log(
      `${pairs.length} pairs; ${d.order.length} drawn, ${d.turns.length} turns for the cause report`,
    );
  } finally {
    await db.destroy();
  }
}

if (process.argv[1] && /shell-miss\.(ts|js)$/.test(process.argv[1])) await main();
