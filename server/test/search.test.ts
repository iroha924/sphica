// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Search and read against real SQLite: a hit must hold most of the question's subject words, a superseded hit brings its successor,
// and read shows the exact cited words with who said them and each anchor checked in a working tree.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkAnchor, locate } from "../src/anchors.ts";
import { askedBefore } from "../src/asked.ts";
import { inTransaction } from "../src/db.ts";
import { readRefs, readUnit } from "../src/read.ts";
import { reconcile } from "../src/reconcile.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { searchSources, searchUnits } from "../src/search.ts";
import { openRun } from "../src/trace.ts";
import { at, hash, insert, message, plan, project, run, statements, type TempDb, tempDb } from "./temp-db.ts";

async function save(db: TempDb, p: number, record: unknown, root: string | null = null, sessionId = "s1") {
  const t: Target = {
    projectId: p,
    origin: "trace",
    prefix: `trace:ext-${sessionId}/`,
    sessionId,
    root,
    sources: null,
  };
  return inTransaction(db.ingest, async (trx) => {
    const runId = await openRun(trx, {
      projectId: p,
      origin: "trace",
      target: `session:${sessionId}`,
      sessionId,
      draftId: `d${Math.random()}`,
    });
    return saveRecord(trx, t, runId, await checkRecord(trx, t, record), []);
  });
}

const decision = (key: string, source: number, quote: string, extra: Record<string, unknown> = {}) => ({
  key,
  kind: "decision",
  stance: "do",
  text: quote,
  evidence: [{ source: `s${source}`, quote, role: "states" }],
  adoption: [{ source: `s${source}`, quote }],
  ...extra,
});

test("search keeps records holding most of the question's words, filters them, and brings a superseded hit's successor", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const a = message(db, p, {
      id: "m1",
      text: "Use pnpm for installs. Two package managers confused contributors.",
    });
    const b = message(db, p, { id: "m2", text: "Go back to npm." });
    const c = message(db, p, { id: "m3", text: "CI runs on every push." });
    await save(db, p, {
      units: [
        decision("pnpm", a, "Use pnpm for installs.", {
          options: [{ text: "yarn", outcome: "rejected", why: "Two package managers confused contributors" }],
          anchors: [{ path: "package.json", role: "applies_to" }],
          aliases: ["パッケージ管理"],
        }),
        {
          key: "ci",
          kind: "finding",
          text: "CI runs on every push",
          evidence: [{ source: `s${c}`, quote: "CI runs on every push.", role: "states" }],
        },
      ],
    });
    await save(db, p, {
      units: [decision("npm", b, "Go back to npm.", { supersedes: "trace:ext-s1/pnpm" })],
    });
    const keys = async (question: string, extra = {}) =>
      (await searchUnits(db.reader, p, { question, limit: 10, ...extra })).hits.map((h) => h.key);
    assert.deepEqual(await keys("package manager"), ["trace:ext-s1/npm", "trace:ext-s1/pnpm"]);
    const r = await searchUnits(db.reader, p, { question: "which CI provider do we use", limit: 10 });
    assert.deepEqual([r.hits.length, r.weaker, r.terms], [0, 1, ["ci", "provider"]]);
    assert.deepEqual(await keys("パッケージ管理"), ["trace:ext-s1/npm", "trace:ext-s1/pnpm"]);
    const alias = (await searchUnits(db.reader, p, { question: "パッケージ管理", limit: 10 })).hits.find(
      (h) => h.key.endsWith("pnpm"),
    );
    assert.equal(alias?.aliasOnly, true);
    assert.deepEqual(await keys("CI push", { kinds: ["finding"] }), ["trace:ext-s1/ci"]);
    assert.deepEqual(await keys("CI push", { kinds: ["decision"] }), []);
    assert.deepEqual(await keys("pnpm", { lifecycles: ["active"] }), []);
    // Kind and lifecycle filters hold for successors too; a path filter still brings the successor of a record anchored there
    const found = await statements(async () => {
      assert.deepEqual(await keys("pnpm", { lifecycles: ["superseded"] }), ["trace:ext-s1/pnpm"]);
    });
    // A superseded hit's successor is found through the index of open replacement rows by the record they replace
    const successors = found.filter((s) => s.includes('"unit_replacement"'));
    assert.ok(successors.length > 0);
    for (const s of successors) assert.match(plan(db, s), /SEARCH h USING INDEX unit_replacement_place/, s);
    assert.deepEqual(
      await keys("pnpm", { kinds: ["finding", "decision"], lifecycles: ["superseded", "active"] }),
      ["trace:ext-s1/npm", "trace:ext-s1/pnpm"],
    );
    assert.deepEqual(await keys("pnpm installs", { path: "package.json" }), [
      "trace:ext-s1/npm",
      "trace:ext-s1/pnpm",
    ]);
    assert.deepEqual(await keys("pnpm installs", { path: "other.json" }), []);
    assert.deepEqual(await keys("のはを"), []);
    // A term naming an anchored path or symbol exactly is a strong hit even among many other words
    assert.deepEqual(await keys("package.json installs convention history rationale owner"), [
      "trace:ext-s1/npm",
      "trace:ext-s1/pnpm",
    ]);
    const sources = await searchSources(db.reader, p, "package managers", 5);
    assert.deepEqual([sources.hits.map((h) => h.id), sources.weaker], [[a], 0]);
    assert.deepEqual((await searchSources(db.reader, p, "を", 5)).hits, []);
    assert.equal((await searchSources(db.reader, p, "push provider nightly", 5)).weaker, 1);
  } finally {
    await db.done();
  }
});

test("read shows cited words and who said them, links, history, and each anchor checked in the working tree", async () => {
  const db = tempDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-read-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "db.ts"), "// db\nexport function open() {}\n");
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "保存先は SQLite にしよう。サーバーは要らない。" });
    await save(
      db,
      p,
      {
        units: [
          decision("storage", m, "SQLite にしよう。", {
            why: "サーバーは要らない",
            options: [
              {
                text: "Postgres",
                outcome: "rejected",
                why: "server",
                evidence: [{ source: `s${m}`, quote: "サーバーは要らない" }],
              },
            ],
            anchors: [
              { path: "src/db.ts", symbol: "open", role: "applies_to" },
              { path: "src/gone.ts", role: "applies_to" },
            ],
          }),
          {
            key: "maybe",
            kind: "decision",
            stance: "defer",
            text: "後で",
            revisit_when: "来年",
            evidence: [{ source: `s${m}`, quote: "保存先", role: "states" }],
          },
        ],
      },
      root,
    );
    await save(db, p, {
      units: [
        {
          key: "q",
          kind: "question",
          text: "q",
          evidence: [{ source: `s${m}`, quote: "保存先", role: "states" }],
          conflicts: ["trace:ext-s1/storage"],
        },
      ],
    });
    let text = "";
    const read = await statements(async () => {
      text = (await readUnit(db.reader, p, "trace:ext-s1/storage", root)) ?? "";
    });
    // Reading a record finds its links from either end by index
    const links = read.filter((s) => s.includes('"unit_link"'));
    assert.ok(links.length > 0);
    for (const s of links) assert.doesNotMatch(plan(db, s), /SCAN l\b/, s);
    for (const want of [
      /decision do, active/,
      /Why: サーバーは要らない/,
      /- Postgres: rejected, because server\n {2}- s\d+ session_message session:s1, the owner, .* \(rejects\): "サーバーは要らない"/,
      /\(owner_statement\): "SQLite にしよう。"/,
      /src\/db\.ts open \(applies_to\): located at line 2/,
      /src\/gone\.ts \(applies_to\): missing — needs review/,
      /Conflicts with trace:ext-s1\/q \(unresolved: still delivered, since only the owner's words hold the owner's decision back\)/,
      /History: candidate .*; active/,
    ])
      assert.match(text, want);
    fs.writeFileSync(path.join(root, "src", "db.ts"), "// db\n\nexport function open() {}\n");
    assert.match(
      (await readUnit(db.reader, p, "trace:ext-s1/storage", root)) ?? "",
      /open \(applies_to\): moved at line 3/,
    );
    const id = db.owner.prepare("select id from unit where key = 'trace:ext-s1/maybe'").get()?.id;
    assert.match(
      (await readUnit(db.reader, p, `u${id}`, null)) ?? "",
      /Revisit when: 来年[\s\S]*Adoption:\n {2}none/,
    );
    assert.equal(await readUnit(db.reader, p, "nope", null), null);
    // A key without its origin prefix reads the record when it names exactly one
    assert.match(
      (await readUnit(db.reader, p, "ext-s1/storage", root)) ?? "",
      /^trace:ext-s1\/storage \(u\d+/,
    );
    assert.match(await readRefs(db.reader, p, [`s${m}`], null), /session_message session:s1, by the owner/);
    assert.match(await readRefs(db.reader, p, ["s999"], null), /s999: not found in this project/);
    // A long source reads in parts: the first says where the rest starts, and reading from there ends with the text's end
    const long = message(db, p, { id: "long", text: `${"a".repeat(70 * 1024)}THE END` });
    const first = await readRefs(db.reader, p, [`s${long}`], null);
    let rest = first;
    for (let n = 0; n < 10; n++) {
      const next = /read (s\d+@\d+) for the rest/.exec(rest);
      if (!next) break;
      rest = await readRefs(db.reader, p, [next[1] ?? ""], null);
    }
    assert.ok(/read s\d+@\d+ for the rest/.test(first), first.slice(-200));
    assert.match(rest, /THE END\n<\/past-records/);
    assert.equal(first.includes("THE END"), false);
    assert.match(await readRefs(db.reader, p, ["x"], null), /x: not found in this project/);
  } finally {
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("anchors are located, moved, missing, or unknown, and a symbol only matches as a whole identifier", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-anchor-"));
  try {
    fs.writeFileSync(path.join(root, "a.ts"), "export function openStore() {}\nconst open = 1;\n");
    fs.writeFileSync(path.join(root, "bin"), Buffer.from([0, 1, 2]));
    assert.deepEqual(locate(root, "a.ts", "open"), { line: 2, excerpt: "const open = 1;" });
    assert.equal(locate(null, "a.ts", "open"), null);
    assert.equal(locate(root, "bin", "x"), null);
    const check = (p: string, symbol: string | null, line: number | null) =>
      checkAnchor(root, { path: p, symbol, line_start: line }).state;
    assert.equal(check("a.ts", "open", 2), "located");
    assert.equal(check("a.ts", "open", 1), "moved");
    assert.equal(check("a.ts", "close", 1), "missing");
    assert.equal(check("a.ts", null, null), "located");
    assert.equal(check("none.ts", null, null), "missing");
    assert.equal(check("bin", "x", null), "unknown");
    assert.equal(check("../outside", null, null), "unknown");
    // A name that only starts with two dots is inside the repository
    fs.mkdirSync(path.join(root, "..config"));
    fs.writeFileSync(path.join(root, "..config", "c.ts"), "const open = 1;\n");
    assert.equal(check("..config/c.ts", "open", 1), "located");
    assert.equal(checkAnchor(null, { path: "a.ts", symbol: null, line_start: null }).state, "unknown");
    // A symlinked directory inside the repository must not let an anchor read a file outside it
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "private"), "SECRET_TOKEN = 1\n");
      fs.symlinkSync(outside, path.join(root, "link"));
      assert.equal(locate(root, "link/private", "SECRET_TOKEN"), null);
      assert.equal(check("link/private", "SECRET_TOKEN", null), "unknown");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("another project's many matches never crowd out this project's hit", async () => {
  const db = tempDb();
  try {
    const other = project(db, "git:github.com/o/other", "o/other");
    const mine = project(db);
    const said = message(db, other, { id: "x", text: "Retry budget stays fixed.", session: "o1" });
    // A record holds at most 50 units, so the 210 go in five records
    for (let b = 0; b < 5; b++)
      await save(
        db,
        other,
        {
          units: Array.from({ length: 42 }, (_, n) =>
            decision(`r${b}-${n}`, said, "Retry budget stays fixed."),
          ),
        },
        null,
        "o1",
      );
    for (let n = 0; n < 210; n++)
      message(db, other, { id: `x${n}`, text: `Retry budget note ${n}.`, session: "o1" });
    const m = message(db, mine, { id: "m", text: "Retry budget is three.", session: "m1" });
    await save(db, mine, { units: [decision("mine", m, "Retry budget is three.")] }, null, "m1");
    const units = await searchUnits(db.reader, mine, { question: "retry budget", limit: 5 });
    assert.deepEqual(
      units.hits.map((h) => h.key),
      ["trace:ext-m1/mine"],
    );
    // Matches a filter drops (other kinds here) never crowd out the one it keeps
    const many = message(db, mine, { id: "q", text: "Retry budget is ten.", session: "m1" });
    for (let b = 0; b < 5; b++)
      await save(
        db,
        mine,
        { units: Array.from({ length: 42 }, (_, n) => decision(`q${b}-${n}`, many, "Retry budget is ten.")) },
        null,
        "m1",
      );
    const found = message(db, mine, { id: "f", text: "Retry budget ran out twice.", session: "m1" });
    await save(
      db,
      mine,
      {
        units: [
          {
            key: "finding",
            kind: "finding",
            text: "Retry budget ran out twice.",
            evidence: [{ source: `s${found}`, quote: "Retry budget ran out twice.", role: "states" }],
          },
        ],
      },
      null,
      "m1",
    );
    assert.deepEqual(
      (
        await searchUnits(db.reader, mine, { question: "retry budget", kinds: ["finding"], limit: 5 })
      ).hits.map((h) => h.key),
      ["trace:ext-m1/finding"],
    );
    const sources = await searchSources(db.reader, mine, "retry budget", 5);
    assert.deepEqual(
      sources.hits.map((h) => h.id).sort((a, b) => a - b),
      [m, many, found].sort((a, b) => a - b),
      "this project's three messages, none of the other project's 210",
    );
  } finally {
    await db.done();
  }
});

test("reading as of a past time shows no retraction made after it", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "Use pnpm. It installs faster." });
    await save(db, p, {
      units: [
        decision("pnpm", m, "Use pnpm.", {
          evidence: [
            { source: `s${m}`, quote: "Use pnpm.", role: "states" },
            { source: `s${m}`, quote: "It installs faster.", role: "explains" },
          ],
          anchors: [{ path: "package.json", role: "applies_to" }],
        }),
      ],
    });
    // A record, an anchor, and a link that came after the as-of time below
    const run0 = Number(db.owner.prepare("select id from extraction_run limit 1").get()?.id);
    db.owner
      .prepare(
        "insert into unit (project_id, key, kind, text, extraction, run_id, created_at, content_hash) values (?, 'trace:ext-s1/npm', 'finding', 'npm', 'supported', ?, '2099-01-01T00:00:00.000Z', zeroblob(32))",
      )
      .run(p, run0);
    db.owner
      .prepare(
        "insert into unit_anchor (unit_id, path, role, run_id, added_at) select id, 'later.json', 'applies_to', ?, '2099-01-01T00:00:00.000Z' from unit where key = 'trace:ext-s1/pnpm'",
      )
      .run(run0);
    db.owner
      .prepare(
        "insert into unit_link (from_unit, to_unit, kind, run_id, added_at) select a.id, b.id, 'conflicts', ?, '2099-01-01T00:00:00.000Z' from unit a, unit b where a.key = 'trace:ext-s1/npm' and b.key = 'trace:ext-s1/pnpm'",
      )
      .run(run0);
    // One of two pieces of evidence is retracted, dated after the as-of time below
    db.owner.exec(
      "update unit_evidence set retracted_at = '2099-01-01T00:00:00.000Z', retraction_reason = 'later mistake', retraction_source_id = source_id, retraction_span_start = span_start, retraction_span_end = span_end where role = 'explains'",
    );
    // A withdrawal dated after the as-of time too
    const run = Number(
      db.owner.prepare("select run_id from unit_state order by id desc limit 1").get()?.run_id,
    );
    db.owner
      .prepare(
        "insert into unit_state (unit_id, from_state, to_state, at, reason, run_id) select id, 'active', 'withdrawn', '2099-01-02T00:00:00.000Z', 'later withdrawal', ? from unit where key = 'trace:ext-s1/pnpm'",
      )
      .run(run);
    const asOf = new Date(Date.now() + 60_000).toISOString();
    const before = (await readUnit(db.reader, p, "trace:ext-s1/pnpm", null, asOf)) ?? "";
    assert.match(before, /Use pnpm\./);
    assert.doesNotMatch(before, /retracted|later mistake|withdrawn|later withdrawal/);
    assert.match(before, /decision do, active/);
    assert.match(before, /package\.json/);
    assert.doesNotMatch(before, /later\.json|Conflicts with/);
    assert.equal(await readUnit(db.reader, p, "trace:ext-s1/npm", null, asOf), null);
    assert.match(
      (await readUnit(db.reader, p, "trace:ext-s1/pnpm", null)) ?? "",
      /\[retracted: later mistake\]/,
    );
  } finally {
    await db.done();
  }
});

test("a strong match ranked past the first 200 candidates is found, and a search says where it stopped", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const filler = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
    // Short texts holding two of four words rank ahead of a long one holding three
    const weak = (n: number) => (n % 2 ? "retry budget retry budget." : "cache warm cache warm.");
    for (let n = 0; n < 210; n++) message(db, p, { id: `w${n}`, text: weak(n), session: "s1" });
    const strong = message(db, p, {
      id: "strong",
      text: `${filler} retry budget cache ${filler}`,
      session: "s1",
    });
    const sources = await searchSources(db.reader, p, "retry budget cache warm", 5);
    assert.deepEqual(
      { hits: sources.hits.map((h) => h.id), stopped: sources.stopped },
      { hits: [strong], stopped: false },
    );
    // Units: the same shape, five records of 42 weak units ahead of one strong unit
    const both = message(db, p, {
      id: "both",
      text: "retry budget retry budget. cache warm cache warm.",
      session: "s1",
    });
    for (let b = 0; b < 5; b++)
      await save(db, p, {
        units: Array.from({ length: 42 }, (_, n) =>
          decision(`w${b}-${n}`, both, n % 2 ? "retry budget retry budget." : "cache warm cache warm."),
        ),
      });
    // A long record holding three of the four words, quoted from the middle of the long message
    const tail = Array.from({ length: 100 }, (_, i) => `word${i + 200}`).join(" ");
    const lead = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    await save(db, p, { units: [decision("strong", strong, `${tail} retry budget cache ${lead}`)] });
    const units = await searchUnits(db.reader, p, { question: "retry budget cache warm", limit: 5 });
    assert.deepEqual(
      { hits: units.hits.map((h) => h.key), stopped: units.stopped },
      { hits: ["trace:ext-s1/strong"], stopped: false },
    );
    // Past the cap of 600 sources the search stops and says so
    for (let n = 210; n < 700; n++) message(db, p, { id: `w${n}`, text: weak(n), session: "s1" });
    const capped = await searchSources(db.reader, p, "retry budget cache warm", 5);
    assert.deepEqual(
      { read: capped.weaker + capped.hits.length, stopped: capped.stopped },
      { read: 600, stopped: true },
      "the message holding all four words is one of the 600 read",
    );
    assert.deepEqual(
      capped.hits.map((h) => h.id),
      [both],
    );
  } finally {
    await db.done();
  }
});

test("a source search stops once the text it read reaches 64 MiB", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const mib = `retry budget ${"x".repeat(1024 * 1024 - 13)}`;
    for (let n = 0; n < 70; n++) message(db, p, { id: `big${n}`, text: `${mib}${n}`, session: "s1" });
    const r = await searchSources(db.reader, p, "retry budget cache warm", 5);
    assert.equal(r.stopped, true);
    assert.equal(r.weaker, 64);
  } finally {
    await db.done();
  }
});

// Each page is a separate statement, so a write between two pages must not shift the next page past a candidate
test("a source removed between two pages of a search makes it skip no other candidate", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const filler = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
    // 50 short weak candidates rank first and the long strong one last
    const weak = (n: number) =>
      n % 2 ? "retry budget retry budget retry budget." : "cache warm cache warm cache warm.";
    const first = message(db, p, { id: "w0", text: weak(0) });
    for (let n = 1; n < 50; n++) message(db, p, { id: `w${n}`, text: weak(n) });
    const strong = message(db, p, {
      id: "strong",
      text: `${filler(1000)} retry budget cache ${filler(1000)}`,
    });
    const plain = await searchSources(db.reader, p, "retry budget cache warm", 5);
    assert.deepEqual(
      plain.hits.map((h) => h.id),
      [strong],
      "the strong one is found without a write",
    );
    let removed = false;
    const reader = db.reader.withPlugin({
      transformQuery: (a) => a.node,
      transformResult: async (a) => {
        // Right after the first statement, the best-ranked candidate goes away (forget does this)
        if (!removed) {
          removed = true;
          db.owner.prepare("delete from source where id = ?").run(first);
        }
        return a.result;
      },
    });
    const r = await searchSources(reader, p, "retry budget cache warm", 5);
    assert.ok(removed);
    assert.deepEqual(
      r.hits.map((h) => h.id),
      [strong],
    );
  } finally {
    await db.done();
  }
});

// The order is taken first and rows are read after, so what changed in between must not slip past the filters or the cap
test("a record withdrawn after the order was taken is not an active hit, and a source removed near the cap still says the search stopped", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m", text: "Retry budget stays fixed." });
    await save(db, p, { units: [decision("retry", m, "Retry budget stays fixed.")] });
    const afterFirst = (write: () => void) => {
      let done = false;
      return db.reader.withPlugin({
        transformQuery: (a) => a.node,
        transformResult: async (a) => {
          if (!done) {
            done = true;
            write();
          }
          return a.result;
        },
      });
    };
    const withdrawn = afterFirst(() =>
      db.owner
        .prepare(
          "insert into unit_state (unit_id, from_state, to_state, at, reason, run_id) select id, 'active', 'withdrawn', ?, 'withdrawn meanwhile', (select run_id from unit_state order by id desc limit 1) from unit where key = 'trace:ext-s1/retry'",
        )
        .run(new Date().toISOString()),
    );
    const active = await searchUnits(withdrawn, p, {
      question: "retry budget",
      lifecycles: ["active"],
      limit: 5,
    });
    assert.deepEqual(
      active.hits.map((h) => h.key),
      [],
    );
    // 601 weak sources and a strong one ranked last; the best-ranked goes away right after the order is taken
    const weak = (n: number) => (n % 2 ? "retry budget retry budget." : "cache warm cache warm.");
    const firstWeak = message(db, p, { id: "w0", text: weak(0), session: "s2" });
    for (let n = 1; n < 601; n++) message(db, p, { id: `w${n}`, text: weak(n), session: "s2" });
    const filler = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
    message(db, p, { id: "strong", text: `${filler} retry budget cache ${filler}`, session: "s2" });
    const removed = afterFirst(() => db.owner.prepare("delete from source where id = ?").run(firstWeak));
    const r = await searchSources(removed, p, "retry budget cache warm", 5);
    assert.equal(
      db.owner.prepare("select id from source where id = ?").get(firstWeak),
      undefined,
      "it was removed",
    );
    assert.equal(r.read, 600, "the 601st taken is read in place of the removed one");
    assert.equal(r.stopped, true, "a candidate past the ones read remains");
  } finally {
    await db.done();
  }
});

// A record replaced twice still leads to the one that holds now, not to the one in between
test("a hit replaced twice brings the live record at the end of the chain", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const a = message(db, p, { id: "m1", text: "Use pnpm for installs." });
    const b = message(db, p, { id: "m2", text: "Go back to npm." });
    const c = message(db, p, { id: "m3", text: "Move to bun." });
    await save(db, p, { units: [decision("pnpm", a, "Use pnpm for installs.")] });
    await save(db, p, {
      units: [decision("npm", b, "Go back to npm.", { supersedes: "trace:ext-s1/pnpm" })],
    });
    await save(db, p, { units: [decision("bun", c, "Move to bun.", { supersedes: "trace:ext-s1/npm" })] });
    const r = await searchUnits(db.reader, p, { question: "pnpm installs", limit: 10 });
    assert.deepEqual(
      r.hits.map((h) => [h.key, h.successorOf ?? null]),
      [
        ["trace:ext-s1/bun", "trace:ext-s1/pnpm"],
        ["trace:ext-s1/pnpm", null],
      ],
    );
    const middle = (await readUnit(db.reader, p, "trace:ext-s1/npm", null)) ?? "";
    assert.match(middle, /decision do, superseded/);
    assert.match(middle, /Supersedes trace:ext-s1\/pnpm \(in effect since \S+Z\)/);
    assert.match(middle, /Superseded by trace:ext-s1\/bun \(since \S+Z\)/);

    // The middle record loses the owner's adoption: bun still replaces it, but its own replacement of pnpm ends and pnpm comes back
    const npm = Number(db.owner.prepare("select id from unit where key = 'trace:ext-s1/npm'").get()?.id);
    db.owner
      .prepare(
        "update unit_adoption set retracted_at = ?, retraction_reason = 'taken back', retraction_source_id = source_id, retraction_span_start = span_start, retraction_span_end = span_end where unit_id = ?",
      )
      .run(new Date().toISOString(), npm);
    await settle(db, p, [npm]);
    const after = await searchUnits(db.reader, p, { question: "pnpm installs", limit: 10 });
    assert.deepEqual(
      after.hits.map((h) => [h.key, h.lifecycle, h.successorOf ?? null]),
      [["trace:ext-s1/pnpm", "active", null]],
    );
    const now = (await readUnit(db.reader, p, "trace:ext-s1/npm", null)) ?? "";
    assert.match(now, /Supersedes trace:ext-s1\/pnpm \(not in effect\)/);
    assert.match(now, /Replaced trace:ext-s1\/pnpm from \S+Z to \S+Z: trace:ext-s1\/npm no longer stands: /);
    assert.match(now, /Superseded by trace:ext-s1\/bun \(since/);
    assert.match(
      (await readUnit(db.reader, p, "trace:ext-s1/pnpm", null)) ?? "",
      /decision do, active[\s\S]*Was superseded by trace:ext-s1\/npm from \S+Z to \S+Z: /,
    );
  } finally {
    await db.done();
  }
});

/** Judges the given records again after facts changed under them, the way a save ends; withdraw names records to withdraw. */
const settle = (db: TempDb, p: number, ids: number[], withdraw: number[] = []) => {
  const runId = run(db, p);
  return inTransaction(db.ingest, (trx) =>
    reconcile(
      trx,
      ids,
      { runId },
      { withdraw: new Map(withdraw.map((id) => [id, { reason: "the owner withdrew it", source: null }])) },
    ),
  );
};
const tick = async () => {
  await new Promise((r) => setTimeout(r, 5));
  const t = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 5));
  return t;
};

test("read tells a replacement in effect, a period that ended, and a waiting proposal apart, now and as of a past time", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const a = message(db, p, { id: "m1", text: "Use SQLite." });
    const b = message(db, p, { id: "m2", text: "Maybe Postgres." });
    const c = message(db, p, { id: "m3", text: "Move to DuckDB." });
    await save(db, p, { units: [decision("sqlite", a, "Use SQLite.")] });
    // Nobody adopted it: it waits, and the save says why
    const proposed = await save(db, p, {
      units: [
        {
          key: "postgres",
          kind: "decision",
          stance: "do",
          text: "Maybe Postgres.",
          evidence: [{ source: `s${b}`, quote: "Maybe Postgres.", role: "proposes" }],
          supersedes: "trace:ext-s1/sqlite",
        },
      ],
    });
    assert.deepEqual(proposed.candidates, [
      {
        key: "trace:ext-s1/postgres",
        why: "an active decision or constraint needs unretracted evidence and adoption",
      },
    ]);
    const before = await tick();
    await save(db, p, {
      units: [decision("duckdb", c, "Move to DuckDB.", { supersedes: "trace:ext-s1/sqlite" })],
    });
    const during = await tick();
    assert.deepEqual(
      (await searchUnits(db.reader, p, { question: "SQLite", limit: 10 })).hits.map((h) => [
        h.key,
        h.successorOf ?? null,
      ]),
      [
        ["trace:ext-s1/duckdb", "trace:ext-s1/sqlite"],
        ["trace:ext-s1/sqlite", null],
      ],
    );
    const duckdb = Number(
      db.owner.prepare("select id from unit where key = 'trace:ext-s1/duckdb'").get()?.id,
    );
    await settle(db, p, [duckdb], [duckdb]);
    const after = await tick();
    const row = db.owner.prepare("select started_at, ended_at, end_reason from unit_replacement").all();
    assert.equal(row.length, 1);
    const { started_at: from, ended_at: to } = row[0] as { started_at: string; ended_at: string };
    assert.ok(
      before < from && from < during && during < to && to < after,
      JSON.stringify({ before, from, during, to, after }),
    );

    const read = async (key: string, asOf?: string) => (await readUnit(db.reader, p, key, null, asOf)) ?? "";
    const proposal = /Replacement proposed by trace:ext-s1\/postgres \(candidate\)/;
    const sqlite = {
      before: await read("trace:ext-s1/sqlite", before),
      during: await read("trace:ext-s1/sqlite", during),
      after: await read("trace:ext-s1/sqlite", after),
      now: await read("trace:ext-s1/sqlite"),
    };
    // Before: the later successor's intent did not exist yet, and only the waiting proposal shows
    assert.match(sqlite.before, /decision do, active/);
    assert.match(sqlite.before, proposal);
    assert.doesNotMatch(sqlite.before, /duckdb/);
    // During: the open row is the replacement in effect; the proposal still waits beside it
    assert.match(sqlite.during, /decision do, superseded/);
    assert.match(sqlite.during, new RegExp(`Superseded by trace:ext-s1/duckdb \\(since ${from}\\)`));
    assert.match(sqlite.during, proposal);
    assert.doesNotMatch(sqlite.during, /Was superseded/);
    // After, and now: the period ended with its reason, and the record came back
    for (const text of [sqlite.after, sqlite.now]) {
      assert.match(text, /decision do, active/);
      assert.match(
        text,
        new RegExp(
          `Was superseded by trace:ext-s1/duckdb from ${from} to ${to}: trace:ext-s1/duckdb was withdrawn`,
        ),
      );
      assert.doesNotMatch(text, /Superseded by/);
      assert.match(text, proposal);
    }
    // Each successor's own intent, and whether it is in effect at the time read
    assert.match(
      await read("trace:ext-s1/duckdb", during),
      new RegExp(`Supersedes trace:ext-s1/sqlite \\(in effect since ${from}\\)`),
    );
    const gone = await read("trace:ext-s1/duckdb");
    assert.match(gone, /Supersedes trace:ext-s1\/sqlite \(not in effect\)/);
    assert.match(gone, new RegExp(`Replaced trace:ext-s1/sqlite from ${from} to ${to}: `));
    assert.match(
      await read("trace:ext-s1/postgres", during),
      /Supersedes trace:ext-s1\/sqlite \(not in effect: trace:ext-s1\/duckdb is in effect as its successor\)/,
    );
    assert.match(await read("trace:ext-s1/postgres"), /Supersedes trace:ext-s1\/sqlite \(not in effect\)\n/);
    // The withdrawn successor no longer stands for the record, and the waiting proposal never did
    assert.deepEqual(
      (await searchUnits(db.reader, p, { question: "SQLite", limit: 10 })).hits.map((h) => [
        h.key,
        h.successorOf ?? null,
      ]),
      [["trace:ext-s1/sqlite", null]],
    );
  } finally {
    await db.done();
  }
});

// Earlier owner messages: only the owner's own words, outside the sessions the caller names, narrowed before the caps, all of them
test("an owner-message search keeps only the owner's words outside the named sessions, before the caps, and returns every match", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const sessionOf = (id: number) =>
      String(db.owner.prepare("select session_id from source where id = ?").get(id)?.session_id);
    // 601 matches in the current session rank first and must not use up the cap
    const here = message(db, p, { id: "h0", text: "retry budget retry budget.", session: "now" });
    for (let n = 1; n < 601; n++)
      message(db, p, { id: `h${n}`, text: "retry budget retry budget.", session: "now" });
    const filler = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const earlier = [0, 1, 2].map((n) =>
      message(db, p, {
        id: `e${n}`,
        text: `${filler} what is the retry budget ${filler}`,
        session: `old${n}`,
      }),
    );
    insert(db, "source", {
      project_id: p,
      kind: "pr_body",
      artifact: "pr:1",
      external_id: "pr-1",
      revision: 1,
      author_kind: "person",
      created_at: at("2026-09-10T00:00:00Z"),
      available_at: at("2026-09-10T00:00:00Z"),
      captured_at: at("2026-09-10T00:00:00Z"),
      text: "retry budget in the pull request",
      original_bytes: 32,
      content_hash: hash(1),
      indexed: 1,
    });
    const r = await searchSources(db.reader, p, "retry budget", Number.POSITIVE_INFINITY, {
      notSessions: [sessionOf(here)],
    });
    assert.deepEqual(
      r.hits.map((h) => h.id).sort((x, y) => x - y),
      earlier,
    );
    assert.deepEqual(
      r.hits.map((h) => h.session),
      r.hits.map((h) => sessionOf(h.id)),
    );
    assert.equal(r.stopped, false);
  } finally {
    await db.done();
  }
});

// A replacement that was never adopted is not what holds now
test("the chain skips a replacement that stayed a candidate", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const a = message(db, p, { id: "m1", text: "Use pnpm for installs." });
    const b = message(db, p, { id: "m2", text: "Go back to npm." });
    const c = message(db, p, { id: "m3", text: "Maybe yarn." });
    await save(db, p, { units: [decision("pnpm", a, "Use pnpm for installs.")] });
    await save(db, p, {
      units: [decision("npm", b, "Go back to npm.", { supersedes: "trace:ext-s1/pnpm" })],
    });
    // No adoption: it stays a candidate
    await save(db, p, {
      units: [
        {
          key: "yarn",
          kind: "decision",
          stance: "do",
          text: "Maybe yarn.",
          evidence: [{ source: `s${c}`, quote: "Maybe yarn.", role: "proposes" }],
          supersedes: "trace:ext-s1/npm",
        },
      ],
    });
    // A record holds one live successor at a time, so npm stays the answer while yarn waits for adoption
    const lifecycle = db.owner
      .prepare("select lifecycle from unit where key = 'trace:ext-s1/yarn'")
      .get()?.lifecycle;
    assert.equal(lifecycle, "candidate");
    const r = await searchUnits(db.reader, p, { question: "pnpm installs", limit: 10 });
    assert.deepEqual(
      r.hits.map((h) => h.key),
      ["trace:ext-s1/npm", "trace:ext-s1/pnpm"],
    );
  } finally {
    await db.done();
  }
});

test("a rejected option's reconsider condition is searchable by its own words", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, {
      id: "m1",
      text: "Use SQLite. If we ever need replicas, look at Postgres again.",
    });
    await save(db, p, {
      units: [
        decision("storage", m, "Use SQLite.", {
          options: [
            {
              text: "Postgres",
              outcome: "rejected",
              reconsider_when: "when read replicas become necessary",
              reconsider_quote: {
                source: `s${m}`,
                quote: "If we ever need replicas, look at Postgres again.",
              },
            },
          ],
        }),
      ],
    });
    const hits = await searchUnits(db.reader, p, { question: "read replicas", limit: 10 });
    assert.deepEqual(
      hits.hits.map((h) => h.key),
      ["trace:ext-s1/storage"],
    );
  } finally {
    await db.done();
  }
});

test("read shows each field value with the words it was quoted from and who said them", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "Track the tenant. acme is slow, so cache in Redis." });
    await save(db, p, {
      field_defs: [
        {
          name: "tenant",
          type: "text",
          label: "Tenant",
          description: "The tenant affected",
          quote: { source: `s${m}`, quote: "Track the tenant." },
        },
      ],
      units: [
        decision("cache", m, "cache in Redis.", {
          fields: [{ name: "tenant", value: "acme", quote: { source: `s${m}`, quote: "acme is slow" } }],
        }),
      ],
    });
    const text = (await readUnit(db.reader, p, "trace:ext-s1/cache", null)) ?? "";
    assert.match(
      text,
      new RegExp(
        `Fields:\\n  - tenant: acme \\(s${m} session_message session:s1, the owner, [0-9T:.Z-]+\\): "acme is slow"`,
      ),
    );
  } finally {
    await db.done();
  }
});

test("each hit carries only its own options and anchors, the limit cuts the hits, and aliasOnly needs every term from aliases", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const a = message(db, p, { id: "m1", text: "Cache covers on disk. Decided." });
    const b = message(db, p, { id: "m2", text: "Cache ratings in memory. Decided." });
    await save(db, p, {
      units: [
        decision("covers", a, "Cache covers on disk.", {
          options: [{ text: "memory", outcome: "rejected", why: "covers are large" }],
          anchors: [{ path: "src/covers.ts", role: "applies_to" }],
          aliases: ["thumbnail store"],
        }),
        decision("ratings", b, "Cache ratings in memory.", {
          options: [{ text: "disk", outcome: "rejected", why: "ratings change often" }],
          anchors: [{ path: "src/ratings.ts", role: "applies_to" }],
        }),
      ],
    });
    const { hits } = await searchUnits(db.reader, p, { question: "cache", limit: 10 });
    const of = (key: string) => hits.find((h) => h.key === `trace:ext-s1/${key}`);
    assert.deepEqual(
      of("covers")?.options.map((o) => o.text),
      ["memory"],
    );
    assert.deepEqual(
      of("ratings")?.anchors.map((x) => x.path),
      ["src/ratings.ts"],
    );
    assert.equal((await searchUnits(db.reader, p, { question: "cache", limit: 1 })).hits.length, 1);
    const alias = (await searchUnits(db.reader, p, { question: "thumbnail store", limit: 10 })).hits;
    assert.equal(alias.find((h) => h.key.endsWith("/covers"))?.aliasOnly, true);
    const mixed = (await searchUnits(db.reader, p, { question: "cache thumbnail", limit: 10 })).hits;
    assert.equal(mixed.find((h) => h.key.endsWith("/covers"))?.aliasOnly, false);
  } finally {
    await db.done();
  }
});

test("search query plan: the statements that rank candidates start from the full-text index under every filter", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const ranked: string[] = [];
    const take = async (fn: () => unknown) =>
      ranked.push(
        ...(await statements(fn)).filter(
          (s) => /from (unit|source)_fts/.test(s) && /order by "f"\."rank"/.test(s),
        ),
      );
    const question = "cache covers";
    await take(() => searchUnits(db.reader, p, { question, limit: 5 }));
    await take(() =>
      searchUnits(db.reader, p, { question, limit: 5, kinds: ["decision"], lifecycles: ["active"] }),
    );
    await take(() => searchUnits(db.reader, p, { question, limit: 5, path: "src/x.ts" }));
    await take(() =>
      searchUnits(db.reader, p, {
        question,
        limit: 5,
        kinds: ["decision"],
        lifecycles: ["active"],
        path: "src/x.ts",
      }),
    );
    await take(() => searchSources(db.reader, p, question, 5));
    await take(() => askedBefore(db.reader, p, { question, limit: 5, notSessions: ["s1", "s2"] }));
    assert.ok(ranked.length >= 6, "each search ranks candidates");
    // Driven by the project's rows instead, MATCH runs once per row and a search slows with the project's size
    for (const s of ranked) assert.match(plan(db, s), /^SCAN (unit|source)_fts VIRTUAL TABLE/, s);
  } finally {
    await db.done();
  }
});

test("search drops a folded question word and matches a plural identifier whole, but not a path segment alone", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const a = message(db, p, { id: "m1", text: "Sanitize strips control characters from paths." });
    const b = message(db, p, { id: "m2", text: "Load the reading list in one query." });
    const c = message(db, p, { id: "m3", text: "Keep x small." });
    await save(db, p, {
      units: [
        decision("sanitize", a, "Sanitize strips control characters from paths."),
        decision("users", b, "Load the reading list in one query.", {
          anchors: [{ path: "src/users.ts", symbol: "getUsers", role: "applies_to" }],
        }),
        decision("small", c, "Keep x small.", { anchors: [{ path: "src/x.ts", role: "applies_to" }] }),
      ],
    });
    const keys = async (question: string) =>
      (await searchUnits(db.reader, p, { question, limit: 10 })).hits.map((h) => h.key);
    assert.deepEqual(await keys("what does sanitize do"), ["trace:ext-s1/sanitize"]);
    // The anchored symbol named exactly is a strong match on its own, plural or not
    assert.deepEqual(await keys("getUsers retry backoff jitter"), ["trace:ext-s1/users"]);
    // One segment of an anchored path is not the identifier
    const r = await searchUnits(db.reader, p, { question: "src retry backoff jitter", limit: 10 });
    assert.deepEqual([r.hits.length, r.weaker], [0, 2]);
  } finally {
    await db.done();
  }
});

test("search path filter takes ./ as anchors do and refuses a path that is not repository-relative", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const a = message(db, p, { id: "m1", text: "Cache covers on disk." });
    await save(db, p, {
      units: [
        decision("covers", a, "Cache covers on disk.", {
          anchors: [{ path: "src/x.ts", role: "applies_to" }],
        }),
      ],
    });
    const search = (question: string, path: string) =>
      searchUnits(db.reader, p, { question, limit: 10, path });
    assert.deepEqual(
      (await search("cache covers", "./src/x.ts")).hits.map((h) => h.key),
      ["trace:ext-s1/covers"],
    );
    for (const bad of ["/repo/src/x.ts", "../src/x.ts", "src\\x.ts", "", "   "]) {
      const r = await search("cache covers", bad);
      assert.deepEqual([r.hits.length, typeof r.refused], [0, "string"], bad);
    }
    // Checked before the question's words, so a question with none still hears about the path
    assert.equal(typeof (await search("the", "/abs")).refused, "string");
  } finally {
    await db.done();
  }
});

test("an identifier in a question counts once, whole, and a part of an identifier in a record finds it", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const a = message(db, p, { id: "m1", text: "connectreader opens the database read only." });
    const b = message(db, p, { id: "m2", text: "MAX_UPLOAD_BYTES is 2 MB." });
    const c = message(db, p, { id: "m3", text: "__MAX_COVER_UPLOAD_BYTES caps a cover at 1 MB." });
    const d = message(db, p, { id: "m4", text: "SQLite_get reads one row." });
    await save(db, p, {
      units: [
        decision("open", a, "connectreader opens the database read only."),
        decision("upload", b, "MAX_UPLOAD_BYTES is 2 MB."),
        decision("cover", c, "__MAX_COVER_UPLOAD_BYTES caps a cover at 1 MB."),
        decision("get", d, "SQLite_get reads one row."),
      ],
    });
    const keys = async (question: string) =>
      (await searchUnits(db.reader, p, { question, limit: 10 })).hits.map((h) => h.key);
    // The question's parts would make the record hold one term in three
    assert.deepEqual(await keys("connectReader"), ["trace:ext-s1/open"]);
    // Shared parts (max, upload, byte) do not make another identifier strong
    assert.deepEqual(await keys("MAX_COVER_UPLOAD_BYTES"), ["trace:ext-s1/cover"]);
    assert.deepEqual(await keys("cover upload"), ["trace:ext-s1/cover"]);
    assert.deepEqual(await keys("sqlite"), ["trace:ext-s1/get"]);
  } finally {
    await db.done();
  }
});

test("read says when a replacement's history before revision 10 was not recorded, rather than calling it a proposal", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "Use SQLite. Use Postgres." });
    await save(db, p, { units: [decision("sqlite", m, "Use SQLite.")] });
    await save(db, p, { units: [decision("pg", m, "Use Postgres.", { supersedes: "trace:ext-s1/sqlite" })] });
    const id = (key: string) => Number(db.owner.prepare("select id from unit where key = ?").get(key)?.id);
    // The update to revision 10 marks an intent it could not date
    db.owner
      .prepare(
        "insert into unit_replacement_gap (from_unit, to_unit, run_id) select ?, ?, run_id from unit where id = ?",
      )
      .run(id("trace:ext-s1/pg"), id("trace:ext-s1/sqlite"), id("trace:ext-s1/pg"));
    const old = (await readUnit(db.reader, p, "trace:ext-s1/sqlite", null)) ?? "";
    assert.match(old, /Superseded by trace:ext-s1\/pg \(since /);
    assert.match(
      old,
      /Superseded by trace:ext-s1\/pg at some time: its history before the update to revision 10 was not recorded/,
    );
    assert.doesNotMatch(old, /Replacement proposed by/);
    const successor = (await readUnit(db.reader, p, "trace:ext-s1/pg", null)) ?? "";
    assert.match(
      successor,
      /Supersedes trace:ext-s1\/sqlite: its history before the update to revision 10 was not recorded/,
    );
  } finally {
    await db.done();
  }
});

test("read says whether an unresolved conflict holds the record back from delivery, apart from withdrawing it", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "Use SQLite. Use UTC. Use local time." });
    const ai = message(db, p, { id: "m2", text: "Postgres would scale better.", speaker: "assistant" });
    await save(db, p, { units: [decision("sqlite", m, "Use SQLite."), decision("utc", m, "Use UTC.")] });
    await save(db, p, {
      units: [
        {
          key: "pg",
          kind: "decision",
          stance: "do",
          text: "Postgres",
          evidence: [{ source: `s${ai}`, quote: "Postgres would scale better.", role: "proposes" }],
          conflicts: ["trace:ext-s1/sqlite"],
        },
        decision("local", m, "Use local time.", { conflicts: ["trace:ext-s1/utc"] }),
      ],
    });
    assert.match(
      (await readUnit(db.reader, p, "trace:ext-s1/sqlite", null)) ?? "",
      /Conflicts with trace:ext-s1\/pg \(unresolved: still delivered, since only the owner's words hold the owner's decision back\)/,
    );
    assert.match(
      (await readUnit(db.reader, p, "trace:ext-s1/utc", null)) ?? "",
      /Conflicts with trace:ext-s1\/local \(unresolved: held back from automatic delivery until resolved, not withdrawn\)/,
    );
  } finally {
    await db.done();
  }
});
