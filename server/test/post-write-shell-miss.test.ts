// The #219 entry check against a real database: which shell-changed files count, whether their records were shown by the owner's next
// prompt, how the draw is fixed by its seed, and the bar on the labelled pairs.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decide,
  draw,
  type Label,
  population,
  type ShellPair,
  wilson,
} from "../evals/post-write/shell-miss.ts";
import { inTransaction } from "../src/db.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { openRun } from "../src/trace.ts";
import { insert, message, project, type TempDb, tempDb } from "./temp-db.ts";

async function save(db: TempDb, p: number, record: unknown) {
  const t: Target = {
    projectId: p,
    origin: "trace",
    prefix: "trace:ext-s1/",
    sessionId: "s1",
    root: null,
    sources: null,
  };
  return inTransaction(db.ingest, async (trx) => {
    const run = await openRun(trx, {
      projectId: p,
      origin: "trace",
      target: "session:s1",
      sessionId: "s1",
      draftId: `d${Math.random()}`,
    });
    return saveRecord(trx, t, run, await checkRecord(trx, t, record), []);
  });
}

const unit = (key: string, source: number, quote: string, extra: Record<string, unknown> = {}) => ({
  key,
  kind: "constraint",
  stance: "do",
  text: quote,
  evidence: [{ source: `s${source}`, quote, role: "states" }],
  adoption: [{ source: `s${source}`, quote }],
  ...extra,
});

test("a shell-changed file counts once per record, and was missed unless the record reached the conversation by the next prompt", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, {
      id: "m0",
      text: "Store every timestamp in UTC. Keep one SQLite file. Dates are tricky.",
    });
    await save(db, p, {
      units: [
        unit("utc", m, "Store every timestamp in UTC.", {
          anchors: [{ path: "src/dates.ts", role: "applies_to" }],
        }),
        unit("sqlite", m, "Keep one SQLite file.", { anchors: [{ path: "src/db.ts", role: "applies_to" }] }),
        {
          key: "tricky",
          kind: "finding",
          text: "Dates are tricky.",
          evidence: [{ source: `s${m}`, quote: "Dates are tricky.", role: "states" }],
          anchors: [{ path: "src/dates.ts", role: "applies_to" }],
        },
      ],
    });
    const id = (key: string) =>
      Number(db.owner.prepare("select id from unit where key = ?").get(`trace:ext-s1/${key}`)?.id);
    const seen = (turn: string, path: string, via: string, at: string) =>
      insert(db, "edit_observation", { session_id: "s1", turn_id: turn, path, via, observed_at: at });
    seen("t1", "src/dates.ts", "status", "2026-10-01T10:00:00.000Z");
    seen("t1", "src/db.ts", "status", "2026-10-01T10:00:00.000Z");
    seen("t1", "src/db.ts", "tool", "2026-10-01T09:59:00.000Z");
    seen("t2", "src/db.ts", "status", "2026-10-01T11:00:00.000Z");
    seen("t2", "README.md", "status", "2026-10-01T11:00:00.000Z");
    message(db, p, { id: "m1", text: "next", sent: "2026-10-01T10:30:00Z" });
    const delivered = (at: string, event: string, reason: string | null, units: number[], agent?: string) => {
      const d = insert(db, "delivery", {
        session_id: "s1",
        event,
        outcome: "emitted",
        reason,
        at,
        ...(agent ? { agent_id: agent } : {}),
      });
      for (const u of units) insert(db, "delivery_unit", { delivery_id: d, unit_id: u });
    };
    delivered("2026-10-01T08:00:00.000Z", "pre_edit", null, [id("utc")]);
    delivered("2026-10-01T09:00:00.000Z", "session_start", "compact", []);
    delivered("2026-10-01T10:40:00.000Z", "pre_edit", null, [id("utc")]);
    delivered("2026-10-01T11:05:00.000Z", "pre_read", null, [id("sqlite")], "ag");

    const pairs = await population(db.reader);
    assert.deepEqual(
      pairs.map((x) => [x.turn, x.path, x.key.replace("trace:ext-s1/", ""), x.nextPrompt, x.shownTo]),
      [
        // Shown before the compaction and again after the next prompt: neither counts
        ["t1", "src/dates.ts", "utc", "2026-10-01T10:30:00.000Z", []],
        // No later owner message: the window stays open, and a subagent's delivery is told apart from the main conversation's
        ["t2", "src/db.ts", "sqlite", null, ["ag"]],
      ],
      "a path an edit tool reported in the same turn, a finding, and an unanchored path never count",
    );

    const many: ShellPair[] = Array.from({ length: 200 }, (_, i) => ({
      ...(pairs[0] as ShellPair),
      turn: `t${i % 40}`,
      unit: i,
    }));
    const a = draw(many, 3);
    assert.deepEqual(a, draw(many, 3), "the same seed draws the same turns and order");
    assert.equal(a.turns.length, 30);
    assert.equal(new Set(a.turns.map((x) => x.turn)).size, 30, "the cause sample has distinct turns");
    assert.equal(a.order.length, 150);
  } finally {
    await db.done();
  }
});

test("the bar decides only on confirmed shell edits, with a Wilson interval fixed before labelling", () => {
  const w = wilson(10, 10);
  assert.ok(Math.abs(w.low - 0.7225) < 1e-4, String(w.low));
  const labels = (missed: number, confirmed: number, others = 0): Label[] => [
    ...Array.from({ length: others }, (_, i) => ({ index: i, shellEdit: false })),
    ...Array.from({ length: confirmed }, (_, i) => ({
      index: others + i,
      shellEdit: true,
      missed: i < missed,
    })),
  ];
  assert.equal(decide(labels(20, 30)).verdict, "proceed");
  assert.equal(decide(labels(1, 30)).verdict, "not adopted");
  assert.equal(decide(labels(6, 30)).verdict, "undecided", "an interval across the bar decides nothing");
  assert.equal(decide(labels(20, 29)).verdict, "undecided", "too few confirmed shell edits decide nothing");
  assert.equal(decide(labels(30, 30, 130)).verdict, "undecided", "only the first 150 drawn pairs count");
  const d = decide(labels(0, 40, 5));
  assert.deepEqual([d.drawn, d.confirmed], [35, 30], "labelling stops at the 30th confirmed pair");
});
