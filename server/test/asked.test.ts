// Earlier owner messages against real SQLite: what records quote each one, whether a decision was recorded, the same turn as context,
// and a matter asked across sessions with no recorded decision.
import assert from "node:assert/strict";
import { test } from "node:test";
import { askedBefore, askedText } from "../src/asked.ts";
import { inTransaction } from "../src/db.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { openRun } from "../src/trace.ts";
import { at, hash, insert, project, session, type TempDb, tempDb } from "./temp-db.ts";

/** One message of a session turn, owner by default. */
function said(
  db: TempDb,
  p: number,
  v: { id: string; text: string; session: string; turn: string; speaker?: "owner" | "assistant" },
): number {
  const s = session(db, p, v.session);
  const speaker = v.speaker ?? "owner";
  return insert(db, "source", {
    project_id: p,
    kind: "session_message",
    artifact: `session:${s}`,
    external_id: v.id,
    revision: 1,
    session_id: s,
    turn_id: v.turn,
    author_kind: speaker,
    created_at: at("2026-09-10T00:00:00Z"),
    available_at: at("2026-09-10T00:00:00Z"),
    captured_at: at("2026-09-10T00:00:00Z"),
    text: v.text,
    original_bytes: Buffer.byteLength(v.text),
    content_hash: hash(),
    indexed: speaker === "owner" ? 1 : 0,
  });
}

/** Saves a record from a trace of one session; `looked` are the sources that trace looked at. */
async function save(db: TempDb, p: number, sessionId: string, record: unknown, looked: number[]) {
  const t: Target = {
    projectId: p,
    origin: "trace",
    prefix: `trace:${sessionId}/`,
    sessionId,
    root: null,
    sources: null,
  };
  return inTransaction(db.ingest, async (trx) => {
    const run = await openRun(trx, {
      projectId: p,
      origin: "trace",
      target: `session:${sessionId}`,
      sessionId,
      draftId: `d${Math.random()}`,
    });
    return saveRecord(trx, t, run, await checkRecord(trx, t, record), looked);
  });
}

const decided = (key: string, source: number, quote: string, extra: Record<string, unknown> = {}) => ({
  key,
  kind: "decision",
  stance: "do",
  text: quote,
  evidence: [{ source: `s${source}`, quote, role: "states" }],
  adoption: [{ source: `s${source}`, quote }],
  ...extra,
});

async function world() {
  const db = tempDb();
  const p = project(db);
  // A: decided, then replaced twice
  const a1 = said(db, p, {
    id: "a1",
    text: "Use pnpm as the package manager for installs.",
    session: "A",
    turn: "t1",
  });
  const a2 = said(db, p, { id: "a2", text: "Go back to npm.", session: "A", turn: "t2" });
  const a3 = said(db, p, { id: "a3", text: "Move to bun.", session: "A", turn: "t3" });
  await save(db, p, "A", { units: [decided("pnpm", a1, "Use pnpm as the package manager for installs.")] }, [
    a1,
  ]);
  await save(db, p, "A", { units: [decided("npm", a2, "Go back to npm.", { supersedes: "trace:A/pnpm" })] }, [
    a2,
  ]);
  await save(db, p, "A", { units: [decided("bun", a3, "Move to bun.", { supersedes: "trace:A/npm" })] }, [
    a3,
  ]);
  // B: traced, nothing recorded
  const b1 = said(db, p, {
    id: "b1",
    text: "Which package manager do installs use?",
    session: "B",
    turn: "t1",
  });
  await save(db, p, "B", { units: [] }, [b1]);
  // C: never traced
  const c1 = said(db, p, {
    id: "c1",
    text: "The package manager installs are slow.",
    session: "C",
    turn: "t1",
  });
  // D: only a finding quotes the message; a record quotes the assistant's reply in the same turn
  const d1 = said(db, p, {
    id: "d1",
    text: "Installs with the package manager took ten minutes.",
    session: "D",
    turn: "t1",
  });
  const d2 = said(db, p, {
    id: "d2",
    text: "The CI cache was cold.",
    session: "D",
    turn: "t1",
    speaker: "assistant",
  });
  await save(
    db,
    p,
    "D",
    {
      units: [
        {
          key: "slow",
          kind: "finding",
          text: "Installs took ten minutes.",
          evidence: [
            {
              source: `s${d1}`,
              quote: "Installs with the package manager took ten minutes.",
              role: "states",
            },
          ],
        },
        {
          key: "cache",
          kind: "finding",
          text: "The CI cache was cold.",
          evidence: [{ source: `s${d2}`, quote: "The CI cache was cold.", role: "explains" }],
        },
      ],
    },
    [d1, d2],
  );
  return { db, p, ids: { a1, b1, c1, d1, d2 } };
}

test("earlier owner messages show what quotes them, the live record after replacements, and say when no decision was recorded", async () => {
  const w = await world();
  try {
    const r = await askedBefore(w.db.reader, w.p, {
      question: "package manager installs",
      limit: 10,
      notSessions: [],
    });
    const byId = new Map(r.messages.map((e) => [e.message.id, e]));
    const a = byId.get(w.ids.a1);
    assert.deepEqual(
      a?.led.map((u) => [u.key, u.lifecycle, u.now.map((n) => n.key)]),
      [["trace:A/pnpm", "superseded", ["trace:A/bun"]]],
    );
    assert.equal(a?.decided, true);
    assert.deepEqual([byId.get(w.ids.b1)?.decided, byId.get(w.ids.b1)?.traced], [false, true]);
    assert.deepEqual([byId.get(w.ids.c1)?.decided, byId.get(w.ids.c1)?.traced], [false, false]);
    const d = byId.get(w.ids.d1);
    assert.equal(d?.decided, false, "a finding is not a decision");
    assert.deepEqual(
      d?.context.map((c) => [c.key, c.speaker, c.role]),
      [["trace:D/cache", "assistant", "explains"]],
    );
    assert.equal(d?.reply, w.ids.d2);
    assert.equal(r.repeats, null, "session A recorded a decision");
    const text = askedText(r);
    assert.match(text, /^Earlier owner messages matching: /);
    assert.doesNotMatch(text, /question/i);
    assert.match(text, /- trace:A\/pnpm \(decision, superseded; now trace:A\/bun \(active\)\)/);
    const block = (id: number) => text.split("\n\n").find((b) => b.startsWith(`## s${id}:`)) ?? "";
    assert.match(block(w.ids.b1), /\nNo recorded decision\.$/);
    assert.match(block(w.ids.c1), /\nNo recorded decision\. Not traced yet: run \/sphica:trace C\.$/);
    assert.match(
      block(w.ids.d1),
      /Same turn \(context, not necessarily the answer\):\n- trace:D\/cache \(finding, active\): quotes the assistant \(explains\)/,
    );
    assert.match(block(w.ids.d1), new RegExp(`Reply: s${w.ids.d2} \\(read it with read\\)`));
    assert.doesNotMatch(block(w.ids.a1), /No recorded decision/);
    // Filters narrow what is shown, never whether a decision was recorded
    const findings = await askedBefore(w.db.reader, w.p, {
      question: "package manager installs",
      limit: 10,
      notSessions: [],
      kinds: ["finding"],
    });
    const a1 = askedText(findings)
      .split("\n\n")
      .find((b) => b.startsWith(`## s${w.ids.a1}:`));
    assert.match(a1 ?? "", /1 tied record hidden by the filters\./);
    assert.doesNotMatch(a1 ?? "", /No recorded decision/);
  } finally {
    await w.db.done();
  }
});

test("a matter asked in several sessions with no recorded decision lists them, counted past the shown limit", async () => {
  const w = await world();
  try {
    // Without session A and D, the matter was asked in B (traced) and C (not traced) and never decided
    const r = await askedBefore(w.db.reader, w.p, {
      question: "package manager installs",
      limit: 1,
      notSessions: ["A", "D"],
    });
    assert.equal(r.messages.length, 1, "one shown");
    assert.deepEqual(r.repeats, { untraced: ["C"], traced: ["B"] });
    assert.match(
      askedText(r),
      /Asked in 2 sessions with no recorded decision:\n- not traced yet: C \(run \/sphica:trace with each\)\n- traced: B/,
    );
    // The current session is left out
    assert.ok(r.messages.every((e) => !["A", "D"].includes(e.message.session ?? "")));
    // With the decided session in view, nothing is listed as repeated
    const all = await askedBefore(w.db.reader, w.p, {
      question: "package manager installs",
      limit: 1,
      notSessions: ["D"],
    });
    assert.equal(all.repeats, null);
    assert.doesNotMatch(askedText(all), /Asked in/);
  } finally {
    await w.db.done();
  }
});
