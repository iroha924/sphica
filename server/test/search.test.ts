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

async function save(db: TempDb, p: number, record: unknown, root: string | null = null) {
  const t: Target = { projectId: p, origin: "trace", prefix: "trace:ext-s1/", sessionId: "s1", root };
  return inTransaction(db.ingest, async (trx) => {
    const runId = await openRun(trx, {
      projectId: p,
      origin: "trace",
      target: "session:s1",
      sessionId: "s1",
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
    assert.deepEqual(await keys("pnpm installs", { path: "package.json" }), [
      "trace:ext-s1/npm",
      "trace:ext-s1/pnpm",
    ]);
    assert.deepEqual(await keys("pnpm installs", { path: "other.json" }), []);
    assert.deepEqual(await keys("のはを"), []);
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
    assert.match((await readSource(db.reader, p, `s${m}`)) ?? "", /session_message session:s1, by the owner/);
    assert.equal(await readSource(db.reader, p, "s999"), null);
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
    assert.equal(checkAnchor(null, { path: "a.ts", symbol: null, line_start: null }).state, "unknown");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
