// The delivery view against real SQLite: the logged rows of one project and period only, main and subagent told apart as the log allows,
// the records delivered most, example sessions, and a reply that keeps its limits and closing lines within READ_BUDGET however long the keys.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { iso } from "../src/db.ts";
import { DELIVERY_LIMITS, DELIVERY_LIMITS_TEXT, deliveryOverview } from "../src/delivery-view.ts";
import { framed } from "../src/frame.ts";
import { READ_BUDGET } from "../src/read.ts";
import { bytes } from "../src/text.ts";
import { hash, insert, project, run, session, type TempDb, tempDb } from "./temp-db.ts";

const NOW = new Date("2026-10-07T00:00:00Z");
const ago = (hours: number) => iso(NOW.getTime() - hours * 60 * 60 * 1000);

const dbs: TempDb[] = [];
after(() => Promise.all(dbs.map((d) => d.done())));
const fresh = () => {
  const db = tempDb();
  dbs.push(db);
  return db;
};

let hashes = 0;
function unit(db: TempDb, p: number, key: string, kind = "finding"): number {
  return insert(db, "unit", {
    project_id: p,
    key,
    kind,
    stance: kind === "decision" || kind === "constraint" ? "do" : null,
    text: `Text of ${key}`,
    extraction: "supported",
    run_id: run(db, p),
    created_at: ago(1000),
    content_hash: hash(++hashes % 256),
  });
}

function delivery(
  db: TempDb,
  s: string,
  v: {
    at: string;
    event?: string;
    outcome?: string;
    reason?: string | null;
    agent?: string | null;
    path?: string | null;
    omitted?: number;
    units?: number[];
  },
): number {
  const id = insert(db, "delivery", {
    session_id: s,
    agent_id: v.agent ?? null,
    event: v.event ?? "pre_read",
    outcome: v.outcome ?? "emitted",
    reason: v.reason ?? null,
    path: v.path ?? null,
    eligible: v.omitted ?? 0,
    omitted: v.omitted ?? 0,
    at: v.at,
  });
  for (const u of v.units ?? []) insert(db, "delivery_unit", { delivery_id: id, unit_id: u });
  return id;
}

test("counts the project's logged rows in the period by event, outcome, and main or subagent", async () => {
  const db = fresh();
  const p = project(db);
  const q = project(db, "git:github.com/o/other", "o/other");
  const s1 = session(db, p, "s1");
  const a = unit(db, p, "trace:s1/a");
  const b = unit(db, p, "trace:s1/b");
  const other = session(db, q, "q1");
  const elsewhere = unit(db, q, "trace:q1/elsewhere");

  delivery(db, s1, { at: ago(1), units: [a] });
  delivery(db, s1, { at: ago(2), omitted: 3 });
  delivery(db, s1, { at: ago(3), agent: "agent-1", units: [a], omitted: 1 });
  delivery(db, s1, { at: ago(4), event: "session_start", reason: "subagent", units: [b] });
  delivery(db, s1, { at: ago(5), event: "session_start", reason: "startup", omitted: 2 });
  delivery(db, s1, { at: ago(6), event: "prompt", outcome: "nothing" });
  // Outside the period: before it, at its end (the end is open), and another project's
  delivery(db, s1, { at: ago(24 * 7 + 1), units: [b] });
  delivery(db, s1, { at: iso(NOW), units: [b] });
  delivery(db, other, { at: ago(1), units: [elsewhere] });

  const out = await deliveryOverview(db.reader, p, 7, NOW);
  assert.ok(out.includes(`Period: from ${ago(24 * 7)} up to ${iso(NOW)} (UTC).`), out);
  assert.ok(out.includes(`Oldest delivery still logged for this project: ${ago(24 * 7 + 1)}.`), out);
  const table = out.split("\n").filter((l) => /^\| [a-z_]+ \| [a-z]+ \|/.test(l) && !l.startsWith("| event"));
  assert.deepEqual(table, [
    "| pre_read | emitted | 2 | 1 | 0 | 1 | 4 |",
    "| prompt | nothing | 1 | 0 | 0 | - | 0 |",
    "| session_start | emitted | 1 | 0 | 1 | 1 | 2 |",
  ]);
  assert.ok(!out.includes("elsewhere"), out);
  // The limits say how rows without an agent id were counted, the subagent start included
  assert.ok(
    out.includes(
      "- Rows without an agent id count as main, as the host reported them, except a subagent start logged without one: subagent, id unknown.",
    ),
    out,
  );
});

test("ranks records by sessions, then deliveries, and names the events they came through", async () => {
  const db = fresh();
  const p = project(db);
  const [s1, s2] = [session(db, p, "s1"), session(db, p, "s2")];
  const wide = unit(db, p, "trace:s1/wide", "decision");
  const often = unit(db, p, "trace:s1/often");
  const once = unit(db, p, "trace:s1/once");
  delivery(db, s1, { at: ago(1), units: [wide, often] });
  delivery(db, s2, { at: ago(2), event: "pre_edit", units: [wide] });
  delivery(db, s1, { at: ago(3), units: [often] });
  delivery(db, s1, { at: ago(4), event: "prompt", units: [often] });
  delivery(db, s1, { at: ago(5), units: [once] });

  const out = await deliveryOverview(db.reader, p, 7, NOW);
  const lines = out.split("\n").filter((l) => l.startsWith("- trace:"));
  assert.deepEqual(lines.slice(0, 3), [
    `- trace:s1/wide (u${wide}, decision, candidate now): 2 sessions, 2 deliveries, via pre_edit, pre_read`,
    `- trace:s1/often (u${often}, finding, candidate now): 1 session, 3 deliveries, via pre_read, prompt`,
    `- trace:s1/once (u${once}, finding, candidate now): 1 session, 1 delivery, via pre_read`,
  ]);
});

test("shows the most recent sessions with each delivery's time, event, agent, path, and keys", async () => {
  const db = fresh();
  const p = project(db);
  const [old, recent] = [session(db, p, "old"), session(db, p, "recent")];
  const units = Array.from({ length: DELIVERY_LIMITS.keys + 2 }, (_, i) => unit(db, p, `trace:s/k${i}`));
  delivery(db, old, { at: ago(30), units: [units[0] ?? 0] });
  delivery(db, recent, { at: ago(3), path: "src/a.ts", units });
  delivery(db, recent, {
    at: ago(2),
    agent: "agent-7",
    event: "session_start",
    reason: "subagent",
    units: [units[1] ?? 0],
  });
  delivery(db, recent, { at: ago(1), outcome: "emitted" });

  const out = await deliveryOverview(db.reader, p, 7, NOW);
  const examples = out.slice(out.indexOf("## Example sessions"), out.indexOf("## Limits"));
  assert.ok(
    examples.indexOf("### claude-code session ext-recent") <
      examples.indexOf("### claude-code session ext-old"),
    examples,
  );
  const named = units
    .slice(0, DELIVERY_LIMITS.keys)
    .map((u, i) => `trace:s/k${i} (u${u})`)
    .join(", ");
  assert.ok(examples.includes(`- ${ago(3)} pre_read, main src/a.ts: ${named} (+2 more)`), examples);
  assert.ok(
    examples.includes(`- ${ago(2)} session_start, subagent agent-7: trace:s/k1 (u${units[1]})`),
    examples,
  );
  // A delivery that logged no record is counted, not listed
  assert.ok(!examples.includes(ago(1)), examples);
});

test("an empty period says so, with its limits", async () => {
  const db = fresh();
  const p = project(db);
  const out = await deliveryOverview(db.reader, p, 1, NOW);
  assert.ok(out.includes("No delivery was logged for this project in this period."), out);
  assert.ok(out.includes("No record was delivered in this period."), out);
  assert.ok(out.includes("Oldest delivery still logged for this project: none."), out);
  for (const l of DELIVERY_LIMITS_TEXT) assert.ok(out.includes(l), out);
});

test("long multibyte keys, paths, and agent ids in every section stay within READ_BUDGET, keeping the limits and closing", async () => {
  const db = fresh();
  const p = project(db);
  const long = (s: string) => `${s}${"決定".repeat(200)}`;
  const units = Array.from({ length: 40 }, (_, i) => unit(db, p, long(`trace:s/${i}-`)));
  for (let s = 0; s < 10; s++) {
    const id = session(db, p, long(`s${s}-`));
    for (let d = 0; d < 20; d++)
      delivery(db, id, {
        at: ago(s * 24 + d / 10),
        // 200 bytes, the most the schema takes
        agent: d % 2 ? `agent-${"決".repeat(64)}` : null,
        path: long("src/"),
        units: units.slice(d, d + 12),
      });
  }
  const out = await deliveryOverview(db.reader, p, 30, NOW);
  assert.ok(bytes(framed(out)) <= READ_BUDGET, `${bytes(framed(out))} bytes`);
  for (const l of DELIVERY_LIMITS_TEXT) assert.ok(out.includes(l), out);
  assert.ok(out.endsWith("Change a record only through /sphica:trace, with the owner's words."), out);
  assert.match(out, /more delivered records? not shown/);
  assert.match(
    out,
    /more sessions? delivered records in this period, not shown|more deliver(y|ies) with records in this session not shown/,
  );
});
