// The #219 entry check (M0'): of the files a turn changed without an edit tool (seen only by git status at the turn's end) that carry a
// decision or constraint, how many had that record shown to the conversation by the owner's next prompt. Current records replayed on past
// inputs. Whether a change was the agent's own shell edit is labelled from the transcript, never guessed from a command.
// node server/evals/post-write/shell-miss.ts --db <sphica.db> --seed <n> --out <draw.json>
// node server/evals/post-write/shell-miss.ts --decide <labels.json>
import fs from "node:fs";
import { parseArgs } from "node:util";
import type { ReadonlyKysely } from "kysely/readonly";
import { openReader } from "../../src/db.ts";
import type { DB } from "../../src/db-types.ts";
import { shuffled } from "./replay.ts";

/** How many pairs are drawn at most, how many confirmed shell edits decide, and the miss rate the bar is set at */
const MAX_DRAWN = 150;
const CONFIRMED = 30;
const BAR = 0.2;
const TURNS = 30;

export type ShellPair = {
  session: string;
  host: string;
  external: string;
  turn: string | null;
  path: string;
  unit: number;
  key: string;
  at: string;
  /** When the owner next spoke in the session, or null when the session has no later owner message */
  nextPrompt: string | null;
  /** Who was shown the record between the conversation's last restart and the owner's next prompt: "main" or a subagent id */
  shownTo: string[];
};

/** Every (turn, path, record) a status-only change of an anchored path makes, in a fixed order before shuffling */
export async function population(db: ReadonlyKysely<DB>): Promise<ShellPair[]> {
  const rows = await db
    .selectFrom("edit_observation as e")
    .innerJoin("session as s", "s.id", "e.session_id")
    .innerJoin("unit_anchor as a", (j) => j.on("a.path", "=", (eb) => eb.ref("e.path")))
    .innerJoin("unit as u", (j) =>
      j.onRef("u.id", "=", "a.unit_id").onRef("u.project_id", "=", "s.project_id"),
    )
    .where("e.via", "=", "status")
    .where("a.role", "=", "applies_to")
    .where("a.retired_at", "is", null)
    .where("u.lifecycle", "=", "active")
    .where("u.kind", "in", ["decision", "constraint"])
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
    .select([
      "e.session_id as session",
      "s.host",
      "s.external_id as external",
      "e.turn_id as turn",
      "e.path",
      "u.id as unit",
      "u.key",
      "e.observed_at as at",
    ])
    .distinct()
    .orderBy("e.session_id")
    .orderBy("e.observed_at")
    .orderBy("e.path")
    .orderBy("u.id")
    .execute();
  const out: ShellPair[] = [];
  for (const r of rows) {
    const next = await db
      .selectFrom("source")
      .select("created_at")
      .where("session_id", "=", r.session)
      .where("kind", "=", "session_message")
      .where("author_kind", "=", "owner")
      .where("created_at", ">", r.at)
      .orderBy("created_at")
      .limit(1)
      .executeTakeFirst();
    const restart = await db
      .selectFrom("delivery")
      .select("at")
      .where("session_id", "=", r.session)
      .where("agent_id", "is", null)
      .where("event", "=", "session_start")
      .where("reason", "in", ["compact", "clear"])
      .where("at", "<=", r.at)
      .orderBy("at", "desc")
      .limit(1)
      .executeTakeFirst();
    let shown = db
      .selectFrom("delivery as d")
      .innerJoin("delivery_unit as du", "du.delivery_id", "d.id")
      .select("d.agent_id")
      .where("d.session_id", "=", r.session)
      .where("du.unit_id", "=", r.unit)
      .where("d.outcome", "=", "emitted")
      .where("d.at", ">=", restart?.at ?? "");
    if (next) shown = shown.where("d.at", "<", next.created_at);
    const who = await shown.distinct().execute();
    out.push({
      ...r,
      nextPrompt: next?.created_at ?? null,
      shownTo: who.map((w) => w.agent_id ?? "main").sort(),
    });
  }
  return out;
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

export type Label = { index: number; shellEdit: boolean | null; agent?: string | null; missed?: boolean };

/**
 * The bar fixed before labelling: with CONFIRMED confirmed shell edits, a lower bound at or past BAR goes on (to the owner with a plan for
 * the next stage), an upper bound under BAR is not adopted, and anything else, or too few confirmed within MAX_DRAWN, is undecided.
 */
export function decide(labels: Label[]): {
  drawn: number;
  confirmed: number;
  missed: number;
  interval: { low: number; high: number };
  verdict: "proceed" | "not adopted" | "undecided";
} {
  const drawn = [...labels].sort((a, b) => a.index - b.index).slice(0, MAX_DRAWN);
  const confirmed: Label[] = [];
  let used = 0;
  for (const l of drawn) {
    used++;
    if (l.shellEdit === true) confirmed.push(l);
    if (confirmed.length === CONFIRMED) break;
  }
  const missed = confirmed.filter((l) => l.missed === true).length;
  const interval = wilson(missed, confirmed.length);
  const verdict =
    confirmed.length < CONFIRMED
      ? "undecided"
      : interval.low >= BAR
        ? "proceed"
        : interval.high < BAR
          ? "not adopted"
          : "undecided";
  return { drawn: used, confirmed: confirmed.length, missed, interval, verdict };
}

/** The draw: TURNS distinct turns for the cause shares, and the pairs in a seeded random order, the first MAX_DRAWN of them */
export function draw(pairs: ShellPair[], seed: number): { turns: ShellPair[]; order: ShellPair[] } {
  const seen = new Set<string>();
  const turns: ShellPair[] = [];
  for (const p of shuffled(pairs, seed)) {
    const t = `${p.session}\0${p.turn ?? p.at}`;
    if (seen.has(t)) continue;
    seen.add(t);
    turns.push(p);
    if (turns.length === TURNS) break;
  }
  return { turns, order: shuffled(pairs, seed + 1).slice(0, MAX_DRAWN) };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      seed: { type: "string" },
      out: { type: "string" },
      decide: { type: "string" },
    },
  });
  if (values.decide) {
    const labels = JSON.parse(fs.readFileSync(values.decide, "utf8")) as { labels: Label[] };
    console.log(JSON.stringify(decide(labels.labels), null, 2));
    return;
  }
  if (!values.db || !values.seed || !values.out) throw new Error("--db, --seed, and --out are required");
  const db = openReader(values.db);
  try {
    const pairs = await population(db);
    const d = draw(pairs, Number(values.seed));
    fs.writeFileSync(
      values.out,
      `${JSON.stringify({ seed: Number(values.seed), population: pairs.length, ...d }, null, 2)}\n`,
    );
    console.log(`${pairs.length} pairs; ${d.turns.length} turns and ${d.order.length} pairs drawn`);
  } finally {
    await db.destroy();
  }
}

if (process.argv[1] && /shell-miss\.(ts|js)$/.test(process.argv[1])) await main();
