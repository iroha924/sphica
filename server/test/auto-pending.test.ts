// Automatic traces against real SQLite: what waits counts every speaker's untraced messages, sessions come oldest first, and a run
// that stops at its page limit is resumed by the next one from the first message still waiting, with earlier messages as context.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { beginGlean, beginTrace, checkText, contextText, pendingText, saveText } from "../src/extract.ts";
import { pendingCount } from "../src/status.ts";
import { pendingSessions, runOf } from "../src/trace.ts";
import { at, message, project, type TempDb, tempDb } from "./temp-db.ts";

// begin sends the recording queue first; it must read an empty queue under a temporary HOME, never the owner's
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-auto-home-"));
const saved = {
  HOME: process.env.HOME,
  SPHICA_DB: process.env.SPHICA_DB,
  SPHICA_HOME: process.env.SPHICA_HOME,
};
before(() => {
  process.env.HOME = home;
  process.env.SPHICA_DB = path.join(home, "none.db");
  delete process.env.SPHICA_HOME;
});
after(() => {
  for (const [k, v] of Object.entries(saved))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  fs.rmSync(home, { recursive: true, force: true });
});

const clock = new Date("2026-09-20T00:00:00Z");

/** Reads every page a run is given, following each page's after. */
async function pages(db: TempDb, run: string, p: number, auto: boolean): Promise<string[]> {
  const out = [await contextText(db.ingest, run, p, null, undefined, auto)];
  for (let m = /after: "(s\d+)"/.exec(out.at(-1) ?? ""); m; m = /after: "(s\d+)"/.exec(out.at(-1) ?? ""))
    out.push(await contextText(db.ingest, run, p, null, m[1], auto));
  return out;
}

const refs = (text: string) => [...text.matchAll(/^## s(\d+) /gm)].map((m) => Number(m[1]));

/** Sources the run's save marked as looked at. */
const marked = async (db: TempDb, draft: string) => {
  const id = (await runOf(db.reader, draft))?.id;
  return db.owner
    .prepare("select source_id from source_processing where run_id = ? order by source_id")
    .all(id ?? -1)
    .map((r) => Number(r.source_id));
};

test("auto pending: a reply captured after a trace waits for the next automatic run, while explicit pending counts only the owner", async () => {
  const db: TempDb = tempDb();
  try {
    const p = project(db);
    message(db, p, { id: "m1", text: "Use SQLite." });
    message(db, p, { id: "m2", text: "Done.", speaker: "assistant", sent: "2026-09-10T00:01:00Z" });
    const run = await beginTrace(db.ingest, p, "s1");
    await pages(db, run, p, false);
    await saveText(db.ingest, run, p, null, { units: [] });
    assert.equal(await pendingText(db.ingest, p, clock), "Every captured session has been traced.");
    assert.equal(
      await pendingText(db.ingest, p, clock, { auto: true }),
      "No recent session waits to be traced.",
    );

    const late = message(db, p, {
      id: "m3",
      text: "I keep the store in one file.",
      speaker: "assistant",
      sent: "2026-09-10T00:02:00Z",
    });
    const auto = await pendingSessions(db.reader, p, "recent", clock, 20, { auto: true });
    assert.deepEqual(
      auto.rows.map((r) => [r.id, Number(r.waiting), Number(r.first)]),
      [["s1", 1, late]],
    );
    assert.equal((await pendingSessions(db.reader, p, "recent", clock)).total, 0);
    assert.deepEqual(await pendingCount(db.reader, p, clock, { auto: true }), { recent: 1, older: 0 });
    assert.deepEqual(await pendingCount(db.reader, p, clock), { recent: 0, older: 0 });
    assert.match(
      await pendingText(db.ingest, p, clock, { auto: true }),
      /^1 session to trace, oldest first[^\n]*auto: true[^\n]*\n- s1 claude-code [^\n]*1 message waiting, starting "I keep the store/,
    );
    assert.equal(await pendingText(db.ingest, p, clock), "Every captured session has been traced.");

    // The next automatic run shows the late reply as its target and the earlier messages as context only
    const next = await beginTrace(db.ingest, p, "s1");
    const [page] = await pages(db, next, p, true);
    assert.match(
      page ?? "",
      /Context: the 2 messages before the first one waiting[^\n]*\n## s\d+ owner[\s\S]*## s\d+ assistant[\s\S]*Targets: the messages this run traces[^\n]*\n## s(\d+) assistant[^\n]*\nI keep the store/,
    );
    await saveText(db.ingest, next, p, null, { units: [] });
    assert.deepEqual(await marked(db, next), [late]);
    assert.equal(
      await pendingText(db.ingest, p, clock, { auto: true }),
      "No recent session waits to be traced.",
    );
  } finally {
    await db.done();
  }
});

test("auto pending: sessions come oldest first, chosen before the limit, and the caller's own session is left out", async () => {
  const db: TempDb = tempDb();
  try {
    const p = project(db);
    const started = { s1: "2026-09-05T00:00:00Z", s2: "2026-09-01T00:00:00Z", s3: "2026-09-03T00:00:00Z" };
    for (const [s, when] of Object.entries(started)) {
      message(db, p, { id: `${s}-m`, text: `Owner in ${s}.`, session: s, sent: "2026-09-10T00:00:00Z" });
      db.owner.prepare("update session set started_at = ? where id = ?").run(at(when), s);
    }
    // The owner came back to s2 last, so an explicit trace lists it first
    message(db, p, { id: "s2-late", text: "Back in s2.", session: "s2", sent: "2026-09-12T00:00:00Z" });

    const auto = await pendingSessions(db.reader, p, "recent", clock, 2, { auto: true });
    assert.deepEqual(
      auto.rows.map((r) => r.id),
      ["s2", "s3"],
    );
    assert.equal(auto.total, 3);
    assert.equal((await pendingSessions(db.reader, p, "recent", clock, 1)).rows[0]?.id, "s2");
    const listed = await pendingText(db.ingest, p, clock, { auto: true, limit: 2 });
    assert.match(listed, /^3 sessions to trace, oldest first[^\n]*\n- s2 [^\n]*\n- s3 [^\n]*\n- and 1 more$/);

    const skip = { host: "claude-code", session: "ext-s2" };
    assert.deepEqual(
      (await pendingSessions(db.reader, p, "recent", clock, 20, { auto: true, skip })).rows.map((r) => r.id),
      ["s3", "s1"],
    );
    assert.deepEqual(await pendingCount(db.reader, p, clock, { auto: true, skip }), { recent: 2, older: 0 });
  } finally {
    await db.done();
  }
});

test("auto pending: a run stopped at the page limit is followed by one that starts where it left off", async () => {
  const db: TempDb = tempDb();
  try {
    const p = project(db);
    // Enough for two runs: the first stops at its page limit, the second reads the rest
    const N = 40;
    const ids = Array.from({ length: N }, (_, i) =>
      message(db, p, {
        id: `m${i}`,
        text: `Message ${i}: ${"a".repeat(1500)}`,
        speaker: i % 2 ? "assistant" : "owner",
        sent: `2026-09-10T00:${String(i).padStart(2, "0")}:00Z`,
      }),
    );

    const first = await beginTrace(db.ingest, p, "s1");
    const read = await pages(db, first, p, true);
    const shown = read.flatMap(refs);
    // Two pages of messages, then the run stops with the rest still waiting; the live records are still given
    assert.ok(read.length >= 2 && read.length <= 3, `${read.length} pages`);
    assert.ok(shown.length > 0 && shown.length < N, `${shown.length} shown`);
    assert.deepEqual(shown, ids.slice(0, shown.length));
    assert.doesNotMatch(read.join("\n"), /Context:/);
    const last = read.at(-1) ?? "";
    assert.match(last, /Live records of this project/);
    assert.match(
      last,
      new RegExp(`This automatic run stops here: ${N - shown.length} later messages are not shown`),
    );
    assert.ok(
      read.every((page) => page.length < 21_000),
      read.map((page) => page.length).join(", "),
    );
    // A page past the limit is never given, so the run cannot read on
    assert.doesNotMatch(last, /after: "s\d+"/);
    await saveText(db.ingest, first, p, null, { units: [] });
    assert.deepEqual(await marked(db, first), shown);
    assert.match(
      await pendingText(db.ingest, p, clock, { auto: true }),
      new RegExp(`- s1 [^\\n]*${N - shown.length} messages waiting, starting "Message ${shown.length}:`),
    );

    const second = await beginTrace(db.ingest, p, "s1");
    const rest = await pages(db, second, p, true);
    const opening = rest[0] ?? "";
    const context = refs(opening.slice(0, opening.indexOf("Targets:")));
    assert.deepEqual(context, shown.slice(-6));
    assert.match(opening, /^Context: the 6 messages before the first one waiting/m);
    assert.match(
      opening,
      new RegExp(`Targets: the messages this run traces, in order:\\n## s${ids[shown.length]} `),
    );
    const targets = rest.flatMap(refs).filter((id) => !context.includes(id));
    assert.deepEqual(targets, ids.slice(shown.length));
    assert.doesNotMatch(rest.join("\n"), /This automatic run stops here/);
    await saveText(db.ingest, second, p, null, { units: [] });
    // Context messages were shown but are not this run's targets, so only the targets are marked
    assert.deepEqual(await marked(db, second), targets);
    assert.equal(
      await pendingText(db.ingest, p, clock, { auto: true }),
      "No recent session waits to be traced.",
    );
  } finally {
    await db.done();
  }
});

test("auto pending: an explicit trace reads as before, and a run keeps the mode it was first read in", async () => {
  const db: TempDb = tempDb();
  try {
    const p = project(db);
    const a = message(db, p, { id: "m1", text: "Use SQLite." });
    const b = message(db, p, { id: "m2", text: "Done.", speaker: "assistant", sent: "2026-09-10T00:01:00Z" });
    const first = await beginTrace(db.ingest, p, "s1");
    await pages(db, first, p, true);
    await saveText(db.ingest, first, p, null, { units: [] });
    const c = message(db, p, { id: "m3", text: "Also keep backups.", sent: "2026-09-10T00:02:00Z" });

    // Explicit: every message from the start, no context or target labels, and no page limit
    const explicit = await beginTrace(db.ingest, p, "s1");
    const page = await contextText(db.ingest, explicit, p, null);
    assert.deepEqual(refs(page), [a, b, c]);
    assert.doesNotMatch(page, /Context:|Targets:|automatic run/);
    assert.match(page, new RegExp(`## s${a} owner .*\\(traced before\\)`));
    await assert.rejects(
      contextText(db.ingest, explicit, p, null, undefined, true),
      /read as an explicit trace; call record_context without auto/,
    );

    const auto = await beginTrace(db.ingest, p, "s1");
    await contextText(db.ingest, auto, p, null, undefined, true);
    await assert.rejects(
      contextText(db.ingest, auto, p, null),
      /read as an automatic trace; pass auto: true/,
    );
    await saveText(db.ingest, auto, p, null, { units: [] });
    const done = await beginTrace(db.ingest, p, "s1");
    assert.match(
      await contextText(db.ingest, done, p, null, undefined, true),
      /^Nothing in this session waits/,
    );

    const glean = await beginGlean(db.ingest, p, "s1");
    await assert.rejects(contextText(db.ingest, glean, p, null, undefined, true), /auto is for trace runs/);
  } finally {
    await db.done();
  }
});

test("auto pending: an automatic trace whose caller cannot be told does nothing, rather than taking a session still being written", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    message(db, p, { id: "m1", text: "Keep it.", session: "s1" });
    assert.match(
      await pendingText(db.ingest, p, new Date(), { auto: true, skip: null }),
      /cannot tell which session called, so the automatic trace does nothing/,
    );
  } finally {
    await db.done();
  }
});

test("auto pending: a page of context alone does not use up the run's pages of targets", async () => {
  const db: TempDb = tempDb();
  try {
    const p = project(db);
    // Six long messages traced before: as context they fill most of the first page
    for (let i = 0; i < 6; i++)
      message(db, p, {
        id: `c${i}`,
        text: `Earlier ${i}: ${"a".repeat(3000)}`,
        sent: `2026-09-10T00:0${i}:00Z`,
      });
    const first = await beginTrace(db.ingest, p, "s1");
    await pages(db, first, p, false);
    await saveText(db.ingest, first, p, null, { units: [] });
    // Each waiting message is too long to share a page with the context, or with another
    const waiting = Array.from({ length: 4 }, (_, i) =>
      message(db, p, {
        id: `w${i}`,
        text: `Later ${i}: ${"b".repeat(15_000)}`,
        sent: `2026-09-10T01:0${i}:00Z`,
      }),
    );
    const second = await beginTrace(db.ingest, p, "s1");
    const read = await pages(db, second, p, true);
    const targets = read.flatMap(refs).filter((id) => waiting.includes(id));
    assert.deepEqual(targets, waiting.slice(0, 2), `${read.length} pages`);
  } finally {
    await db.done();
  }
});

test("auto pending: an automatic run's record must quote a message it traces, not only context", async () => {
  const db: TempDb = tempDb();
  try {
    const p = project(db);
    message(db, p, { id: "m1", text: "The flaky test is caused by a race." });
    const first = await beginTrace(db.ingest, p, "s1");
    await pages(db, first, p, false);
    await saveText(db.ingest, first, p, null, { units: [] });
    message(db, p, { id: "m2", text: "Okay.", speaker: "assistant", sent: "2026-09-10T00:05:00Z" });
    const second = await beginTrace(db.ingest, p, "s1");
    const read = await pages(db, second, p, true);
    const old = refs(read[0] ?? "")[0];
    const record = {
      units: [
        {
          key: "race",
          kind: "finding",
          text: "The flaky test is caused by a race",
          evidence: [{ source: `s${old}`, quote: "The flaky test is caused by a race.", role: "states" }],
        },
      ],
    };
    const checked = await checkText(db.ingest, second, p, null, record);
    assert.equal(checked.ok, false);
    assert.match(checked.text, /quotes only messages earlier runs already looked at/);
    await assert.rejects(
      saveText(db.ingest, second, p, null, record),
      /quotes only messages earlier runs already looked at/,
    );
  } finally {
    await db.done();
  }
});

test("auto pending: an automatic run defines no field from context, and updates work only beside a record of its targets", async () => {
  const db: TempDb = tempDb();
  try {
    const p = project(db);
    message(db, p, { id: "m1", text: "Track severity on every finding." });
    const first = await beginTrace(db.ingest, p, "s1");
    await pages(db, first, p, false);
    await saveText(db.ingest, first, p, null, { units: [] });
    message(db, p, { id: "m2", text: "Okay.", speaker: "assistant", sent: "2026-09-10T00:05:00Z" });
    const second = await beginTrace(db.ingest, p, "s1");
    const read = await pages(db, second, p, true);
    const old = refs(read[0] ?? "")[0];
    const fields = {
      units: [],
      field_defs: [
        {
          name: "severity",
          type: "text",
          label: "Severity",
          description: "How bad",
          kinds: ["finding"],
          quote: { source: `s${old}`, quote: "Track severity on every finding." },
        },
      ],
    };
    const work = {
      units: [],
      work: { key: "w", title: "Severity", goal: "g", current: "c", next: [], status: "active" },
    };
    for (const record of [fields, work]) {
      const checked = await checkText(db.ingest, second, p, null, record);
      assert.equal(checked.ok, false, JSON.stringify(record).slice(0, 40));
      assert.match(checked.text, /automatic run/);
    }
  } finally {
    await db.done();
  }
});
