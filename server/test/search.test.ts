// Search and read against real SQLite: a hit must hold most of the question's subject words, a superseded hit brings its successor,
// and read shows the exact cited words with who said them and each anchor checked in a working tree.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkAnchor, locate } from "../src/anchors.ts";
import { inTransaction } from "../src/db.ts";
import { readSource, readUnit } from "../src/read.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { searchSources, searchUnits } from "../src/search.ts";
import { openRun } from "../src/trace.ts";
import { message, project, type TempDb, tempDb } from "./temp-db.ts";

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
    assert.deepEqual(await keys("pnpm", { lifecycles: ["superseded"] }), ["trace:ext-s1/pnpm"]);
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
    const text = (await readUnit(db.reader, p, "trace:ext-s1/storage", root)) ?? "";
    for (const want of [
      /decision do, active/,
      /Why: サーバーは要らない/,
      /- Postgres: rejected, because server\n {2}- s\d+ session_message session:s1, the owner, .* \(rejects\): "サーバーは要らない"/,
      /\(owner_statement\): "SQLite にしよう。"/,
      /src\/db\.ts open \(applies_to\): located at line 2/,
      /src\/gone\.ts \(applies_to\): missing — needs review/,
      /Conflicts with trace:ext-s1\/q \(unresolved\)/,
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
    assert.match((await readSource(db.reader, p, `s${m}`)) ?? "", /session_message session:s1, by the owner/);
    assert.equal(await readSource(db.reader, p, "s999"), null);
    // A long source reads in parts: the first says where the rest starts, and reading from there ends with the text's end
    const long = message(db, p, { id: "long", text: `${"a".repeat(70 * 1024)}THE END` });
    const first = (await readSource(db.reader, p, `s${long}`)) ?? "";
    const next = /read s(\d+)@(\d+) for the rest/.exec(first);
    assert.ok(next, first.slice(-200));
    const rest = (await readSource(db.reader, p, `s${next?.[1]}@${next?.[2]}`)) ?? "";
    assert.match(rest, /THE END$/);
    assert.equal(first.includes("THE END"), false);
    assert.equal(await readSource(db.reader, p, "x"), null);
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
        decision("npm", m, "It installs faster."),
      ],
    });
    // A record, an anchor, and a link that came after the as-of time below
    const run0 = Number(db.owner.prepare("select id from extraction_run limit 1").get()?.id);
    db.owner.exec("update unit set created_at = '2099-01-01T00:00:00.000Z' where key = 'trace:ext-s1/npm'");
    db.owner
      .prepare(
        "insert into unit_anchor (unit_id, path, role, run_id, added_at) select id, 'later.json', 'applies_to', ?, '2099-01-01T00:00:00.000Z' from unit where key = 'trace:ext-s1/pnpm'",
      )
      .run(run0);
    db.owner
      .prepare(
        "insert into unit_link (from_unit, to_unit, kind, run_id, added_at) select a.id, b.id, 'implements', ?, '2099-01-01T00:00:00.000Z' from unit a, unit b where a.key = 'trace:ext-s1/npm' and b.key = 'trace:ext-s1/pnpm'",
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
    assert.doesNotMatch(before, /later\.json|Implemented by/);
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
