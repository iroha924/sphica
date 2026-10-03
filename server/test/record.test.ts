// Checking and saving records against real SQLite: quotes become spans of retained text, adoption follows who spoke, and lifecycle
// moves only when the schema's activation rules pass.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { locate, locateIn, masksSymbol, masksSymbolIn, readRepoText } from "../src/anchors.ts";
import { inTransaction } from "../src/db.ts";
import { beginTrace, checkText, contextText, saveText } from "../src/extract.ts";
import { readUnit } from "../src/read.ts";
import { checkRecord, finishRun, repoPath, saveRecord, type Target, valueInQuote } from "../src/record.ts";
import { liveUnits, openRun, pendingSessions, runOf, sessionEdits, sessionSources } from "../src/trace.ts";
import { at, hash, insert, message, project, type TempDb, tempDb } from "./temp-db.ts";

const now = at("2026-09-27T00:00:00Z");

/** A third-party source on a pull request. */
const prSource = (
  db: TempDb,
  p: number,
  v: { id: string; kind: string; text: string; login: string; assoc: string; event?: string },
) =>
  insert(db, "source", {
    project_id: p,
    kind: v.kind,
    artifact: "pr:12",
    external_id: v.id,
    revision: 1,
    author_kind: "person",
    author_login: v.login,
    author_association: v.assoc,
    event_kind: v.event ?? null,
    created_at: now,
    captured_at: now,
    text: v.text,
    original_bytes: Buffer.byteLength(v.text),
    content_hash: hash(),
    indexed: 1,
  });

const target = (p: number, sessionId: string | null = "s1"): Target => ({
  projectId: p,
  origin: "trace",
  prefix: "trace:ext-s1/",
  sessionId,
  root: null,
  sources: null,
});

async function save(db: TempDb, t: Target, record: unknown, looked: number[] = []) {
  return inTransaction(db.ingest, async (trx) => {
    const runId = await openRun(trx, {
      projectId: t.projectId,
      origin: t.origin,
      target: "session:s1",
      sessionId: t.sessionId,
      draftId: `d${Math.random()}`,
    });
    const checked = await checkRecord(trx, t, record);
    return { checked, saved: await saveRecord(trx, t, runId, checked, looked) };
  });
}

const state = (db: TempDb, key: string) =>
  db.owner.prepare("select lifecycle, extraction, extraction_reason from unit where key = ?").get(key);

// The clock can step back between begin and save, and a run never finishes before it started
test("a run whose start is later than the clock finishes at its start", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const later = "2999-01-01T00:00:00.000Z";
    const runId = insert(db, "extraction_run", {
      project_id: p,
      origin: "trace",
      target: "x",
      status: "running",
      started_at: later,
    });
    await finishRun(db.ingest, runId);
    assert.deepEqual(
      { ...db.owner.prepare("select status, finished_at from extraction_run where id = ?").get(runId) },
      { status: "saved", finished_at: later },
    );
  } finally {
    await db.done();
  }
});

test("an anchor given twice in a record is kept once, since a record holds one live anchor per place", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "ここを見る。" });
    const { checked } = await save(
      db,
      target(p),
      {
        units: [
          {
            key: "twice",
            kind: "finding",
            text: "ここを見る",
            evidence: [{ source: `s${m}`, quote: "ここを見る。", role: "states" }],
            anchors: [
              { path: "a.ts", role: "applies_to" },
              { path: "a.ts", role: "applies_to" },
              { path: "a.ts", role: "evidence" },
            ],
          },
        ],
      },
      [m],
    );
    assert.ok(
      checked.problems.some((x) => /the anchor on a\.ts appears twice; left out/.test(x)),
      checked.problems.join(" | "),
    );
    assert.deepEqual(
      db.owner
        .prepare("select role from unit_anchor order by id")
        .all()
        .map((r) => r.role),
      ["applies_to", "evidence"],
    );
  } finally {
    await db.done();
  }
});

test("an anchor's excerpt is masked before it is cut, and a symbol masking swallows is not kept", async () => {
  const db = tempDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-anchor-"));
  try {
    // Only the quoted assignment names it a key, and its closing quote lies past the 200-character cut
    const key = "Zq9x".repeat(60);
    fs.writeFileSync(
      path.join(root, "config.ts"),
      `export const apiKey = "${key}"; // ${"x".repeat(10)}\n-----BEGIN PRIVATE KEY-----\nkeyBody\n-----END PRIVATE KEY-----\n// keyBody is also named here, outside the key, yet its copy inside the key keeps it out\nexport const API_KEY =\n  tokenValue123abc; // configMarker\n// tokenValue123abc is also mentioned here\nSECRET_TOKEN=redacted\nconst url = "postgres://app:localdev@localhost/app"; const local = 1;\n`,
    );
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "設定の鍵はここにある。" });
    await save(
      db,
      { ...target(p), root },
      {
        units: [
          {
            key: "config",
            kind: "finding",
            text: "設定の鍵はここにある",
            evidence: [{ source: `s${m}`, quote: "設定の鍵はここにある。", role: "states" }],
            anchors: [
              { path: "config.ts", symbol: "apiKey", role: "applies_to" },
              { path: "config.ts", symbol: "keyBody", role: "applies_to" },
              { path: "config.ts", symbol: "configMarker", role: "applies_to" },
              // A symbol that is itself a key, by shape or because the file shows it only inside masked text, is dropped
              { path: "config.ts", symbol: "tokenValue123abc", role: "applies_to" },
              { path: "config.ts", symbol: " tokenValue123abc ", role: "applies_to" },
              { path: "config.ts", symbol: `sk-${"b2".repeat(15)}`, role: "applies_to" },
              // Also when the value shows unmasked elsewhere, or when it reads like the placeholder itself
              { path: "config.ts", symbol: "redacted", role: "applies_to" },
              // An ordinary name whose letters also sit inside masked text is kept: only whole names count
              { path: "config.ts", symbol: "local", role: "applies_to" },
            ],
          },
        ],
      },
      [m],
    );
    const all = db.owner.prepare("select path, symbol, excerpt from unit_anchor order by id").all() as {
      path: string;
      symbol: string | null;
      excerpt: string | null;
    }[];
    // Anchors whose symbol masking swallows keep their path, so the record is still delivered, once: identical rows could not be told apart
    assert.deepEqual(
      all.map((a) => a.symbol),
      ["apiKey", null, "configMarker", "local"],
    );
    assert.ok(all.every((a) => a.path === "config.ts"));
    const got = all.filter((a) => a.symbol);
    assert.doesNotMatch(got[0]?.excerpt ?? "", /Zq9x/);
    assert.match(got[0]?.excerpt ?? "", /^export const apiKey = "\[redacted\]"/);
    // The key name is on the line before: the line alone does not look like a key, but the whole file masks it
    assert.equal(got[1]?.excerpt, "[redacted]");
  } finally {
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Only the path-only anchors left behind by a masked symbol are merged; ones the record gives with their own lines all stay
test("path-only anchors with their own lines are all kept, and a merged fallback is reported", async () => {
  const db = tempDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-dedupe-"));
  try {
    fs.writeFileSync(path.join(root, "c.ts"), "API_KEY=abc123def456\na\nb\nc\nd\n");
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "ここを見る。" });
    const { checked } = await save(
      db,
      { ...target(p), root },
      {
        units: [
          {
            key: "lines",
            kind: "finding",
            text: "ここを見る",
            evidence: [{ source: `s${m}`, quote: "ここを見る。", role: "states" }],
            anchors: [
              // A fallback given before the path-only anchor it matches merges all the same
              { path: "c.ts", lines: [4, 5], symbol: `sk-${"e5".repeat(15)}`, role: "applies_to" },
              { path: "c.ts", lines: [2, 2], role: "applies_to" },
              { path: "c.ts", lines: [4, 5], role: "applies_to" },
              // A reversed range is the same place once saved
              { path: "c.ts", lines: [5, 4], symbol: `sk-${"f6".repeat(15)}`, role: "applies_to" },
              { path: "c.ts", lines: [5, 5], role: "applies_to" },
              { path: "c.ts", symbol: `sk-${"c3".repeat(15)}`, role: "applies_to" },
              { path: "c.ts", symbol: `sk-${"d4".repeat(15)}`, role: "applies_to" },
            ],
          },
        ],
      },
      [m],
    );
    const rows = db.owner.prepare("select symbol, line_start, line_end from unit_anchor order by id").all();
    assert.deepEqual(
      rows.map((r) => [r.symbol, r.line_start, r.line_end]),
      [
        [null, 2, 2],
        [null, 4, 5],
        [null, 5, 5],
        [null, null, null],
      ],
    );
    assert.ok(
      checked.problems.some((x) => /another path-only anchor on c\.ts/.test(x)),
      checked.problems.join("\n"),
    );
  } finally {
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The file can change between the check and the save: the symbol is checked again as it is stored
test("an anchor symbol that became a key after the check is stored without it", async () => {
  const db = tempDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-recheck-"));
  try {
    fs.writeFileSync(path.join(root, "c.ts"), "const tokenValue123abc = loadConfig();\n");
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "ここを見る。" });
    const t = { ...target(p), root };
    await inTransaction(db.ingest, async (trx) => {
      const runId = await openRun(trx, {
        projectId: p,
        origin: t.origin,
        target: "session:s1",
        sessionId: t.sessionId,
        draftId: "d-recheck",
      });
      const checked = await checkRecord(trx, t, {
        units: [
          {
            key: "recheck",
            kind: "finding",
            text: "ここを見る",
            evidence: [{ source: `s${m}`, quote: "ここを見る。", role: "states" }],
            anchors: [{ path: "c.ts", symbol: "tokenValue123abc", role: "applies_to" }],
          },
        ],
      });
      fs.writeFileSync(path.join(root, "c.ts"), "API_KEY=tokenValue123abc\n");
      await saveRecord(trx, t, runId, checked, [m]);
    });
    assert.deepEqual(
      db.owner
        .prepare("select path, symbol from unit_anchor")
        .all()
        .map((r) => [r.path, r.symbol]),
      [["c.ts", null]],
    );
  } finally {
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A file masked on every line must not make the symbol check pair every match with every placeholder
test("masksSymbol stays fast on a large file masked on every line", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-masks-"));
  try {
    fs.writeFileSync(path.join(root, "big.ts"), "API_KEY=abc123def456 // loadConfig\n".repeat(55_000));
    const started = performance.now();
    assert.equal(masksSymbol(root, "big.ts", "loadConfig"), false);
    // A one-letter symbol in a near-limit file: matches are counted, not collected
    fs.writeFileSync(path.join(root, "min.ts"), "a ".repeat(1_048_575));
    assert.equal(masksSymbol(root, "min.ts", "a"), false);
    assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)} ms`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Masking a key can leave a new whole name right after its placeholder; that one must not stand in for the occurrence it swallowed
test("masksSymbol does not count a name that only a placeholder's edge made whole", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-edge-"));
  try {
    fs.writeFileSync(
      path.join(root, "c.ts"),
      `API_KEY=tokenValue123abc\nAIza${"a".repeat(35)}tokenValue123abc\n`,
    );
    assert.equal(masksSymbol(root, "c.ts", "tokenValue123abc"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A file Sphica cannot scan (too large, binary) gives no context to clear a symbol, so the symbol is treated as masked
test("masksSymbol treats a symbol in a file it cannot scan as masked", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-unscanned-"));
  try {
    fs.writeFileSync(path.join(root, "big.txt"), `API_KEY=abc123def456\n${"x".repeat(2 * 1024 * 1024)}`);
    fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([0x61, 0, 0x62]));
    assert.equal(masksSymbol(root, "big.txt", "abc123def456"), true);
    assert.equal(masksSymbol(root, "bin.dat", "loadConfig"), true);
    // A file not there yet has no context either way: only the symbol's own shape counts
    assert.equal(masksSymbol(root, "later.ts", "loadConfig"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Save judges a symbol on text it read once before taking the write lock; the answers must match reading the file each time
test("masksSymbolIn and locateIn on text read once agree with the reading functions, and the hash tells a changed file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-read-once-"));
  try {
    const files: Record<string, string | Buffer> = {
      "c.ts": `API_KEY=tokenValue123abc\nAIza${"a".repeat(35)}tokenValue123abc\n`,
      "a.ts": "import x;\nconst open = 1;\n",
      "big.txt": `API_KEY=abc123def456\n${"x".repeat(2 * 1024 * 1024)}`,
      "bin.dat": Buffer.from([0x61, 0, 0x62]),
    };
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, name), body);
    const cases: [string, string][] = [
      ["c.ts", "tokenValue123abc"],
      ["a.ts", "open"],
      ["a.ts", " open "],
      ["a.ts", "missing"],
      ["big.txt", "abc123def456"],
      ["bin.dat", "loadConfig"],
      ["later.ts", "loadConfig"],
      ["../out.ts", "open"],
    ];
    for (const [rel, symbol] of cases) {
      const read = readRepoText(root, rel);
      assert.equal(masksSymbolIn(read.text, symbol), masksSymbol(root, rel, symbol), `${rel} ${symbol}`);
      assert.deepEqual(locateIn(read.text, symbol), locate(root, rel, symbol), `${rel} ${symbol}`);
    }
    assert.deepEqual(readRepoText(null, "a.ts"), { text: null, hash: "absent" });
    assert.equal(readRepoText(root, "later.ts").hash, "absent");
    assert.equal(readRepoText(root, "bin.dat").hash, "unreadable");
    const before = readRepoText(root, "a.ts").hash;
    // Same length, so a size check alone would not see it
    fs.writeFileSync(path.join(root, "a.ts"), "import y;\nconst open = 1;\n");
    assert.notEqual(readRepoText(root, "a.ts").hash, before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Save looks the symbol up again after the check, so the file may have changed in between: a line inside a key is still not kept
test("locate does not keep a line inside a private key as an anchor's excerpt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-locate-"));
  try {
    fs.writeFileSync(
      path.join(root, "key.pem"),
      "-----BEGIN PRIVATE KEY-----\nkeyBody\n-----END PRIVATE KEY-----\n",
    );
    assert.deepEqual(locate(root, "key.pem", "keyBody"), { line: 2, excerpt: "[redacted: private key]" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an owner's directive becomes an active decision whose spans cut the quoted bytes, with a rejected option", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, {
      id: "m1",
      text: "保存先は Postgres じゃなくて SQLite にしよう。サーバーは要らない。",
    });
    const other = message(db, p, { id: "m2", text: "了解です。", speaker: "assistant" });
    const { saved } = await save(
      db,
      target(p),
      {
        units: [
          {
            key: "storage",
            kind: "decision",
            stance: "do",
            text: "保存先は SQLite",
            options: [
              {
                text: "Postgres",
                outcome: "rejected",
                evidence: [{ source: `s${m}`, quote: "サーバーは要らない" }],
              },
            ],
            evidence: [{ source: `s${m}`, quote: "SQLite にしよう。", role: "states" }],
            adoption: [{ source: `s${m}`, quote: "SQLite にしよう。" }],
            anchors: [{ path: "./src/db.ts", symbol: "open", role: "applies_to" }],
            aliases: ["データベース", "storage", "storage"],
          },
        ],
        work: { key: "w", title: "保存先", goal: "決める", current: "決めた", status: "done" },
      },
      [m, other],
    );
    assert.deepEqual(saved.active, ["trace:ext-s1/storage"]);
    const ev = db.owner
      .prepare(
        "select e.role, e.option_id is not null as opt, substr(cast(s.text as blob), e.span_start + 1, e.span_end - e.span_start) as cut from unit_evidence e join source s on s.id = e.source_id order by e.id",
      )
      .all()
      .map((r) => [r.role, r.opt, Buffer.from(r.cut as Uint8Array).toString("utf8")]);
    assert.deepEqual(ev, [
      ["rejects", 1, "サーバーは要らない"],
      ["states", 0, "SQLite にしよう。"],
    ]);
    assert.equal(db.owner.prepare("select route from unit_adoption").get()?.route, "owner_statement");
    assert.equal(db.owner.prepare("select path from unit_anchor").get()?.path, "src/db.ts");
    assert.equal(db.owner.prepare("select terms from unit_alias").get()?.terms, '["データベース","storage"]');
    assert.equal(db.owner.prepare("select status from work").get()?.status, "done");
    assert.deepEqual(
      db.owner
        .prepare("select source_id, outcome from source_processing order by source_id")
        .all()
        .map((r) => [r.source_id, r.outcome]),
      [
        [m, "units"],
        [other, "no_unit"],
      ],
    );
    // The caller marks the run saved, once every write of the save is done
    assert.equal(db.owner.prepare("select status from extraction_run").get()?.status, "running");
  } finally {
    await db.done();
  }
});

test("a rejected option keeps the reconsider condition the owner stated, quoted from the owner, and check refuses any other", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, {
      id: "m1",
      text: "Postgres はやめて SQLite にしよう。レプリカが要るようになったら Postgres をもう一度考える。",
    });
    const ai = message(db, p, {
      id: "m2",
      text: "複数台で書くなら Postgres を再検討できます。",
      speaker: "assistant",
    });
    const decision = (key: string, option: Record<string, unknown>) => ({
      key,
      kind: "decision",
      stance: "do",
      text: "保存先は SQLite",
      options: [{ text: "Postgres", outcome: "rejected", ...option }],
      evidence: [{ source: `s${m}`, quote: "SQLite にしよう。", role: "states" }],
      adoption: [{ source: `s${m}`, quote: "SQLite にしよう。" }],
    });
    const condition = {
      reconsider_when: "レプリカが要るようになったら",
      reconsider_quote: { source: `s${m}`, quote: "レプリカが要るようになったら Postgres をもう一度考える" },
    };
    const { saved } = await save(db, target(p), { units: [decision("storage", condition)] }, [m]);
    assert.deepEqual(saved.active, ["trace:ext-s1/storage"]);
    assert.deepEqual(
      { ...db.owner.prepare("select outcome, reconsider_when from unit_option").get() },
      { outcome: "rejected", reconsider_when: "レプリカが要るようになったら" },
    );
    const quoted = db.owner
      .prepare(
        "select e.role, e.option_id is not null as opt, substr(cast(s.text as blob), e.span_start + 1, e.span_end - e.span_start) as cut from unit_evidence e join source s on s.id = e.source_id where e.role = 'reconsiders'",
      )
      .all()
      .map((r) => [r.role, r.opt, Buffer.from(r.cut as Uint8Array).toString("utf8")]);
    assert.deepEqual(quoted, [["reconsiders", 1, "レプリカが要るようになったら Postgres をもう一度考える"]]);

    // read shows the condition under its option with the owner's words, and after the quote is retracted, as unsupported
    const shown = async () => (await readUnit(db.reader, p, "trace:ext-s1/storage", null)) ?? "";
    assert.match(
      await shown(),
      /- Postgres: rejected\n {2}Reconsider when: レプリカが要るようになったら \(the owner's words are quoted below\)\n {2}- s\d+ .*\(reconsiders\): "レプリカが要るようになったら Postgres をもう一度考える"/,
    );
    db.owner
      .prepare(
        "update unit_evidence set retracted_at = ?, retraction_reason = 'misread', retraction_source_id = ?, retraction_span_start = 0, retraction_span_end = 3 where role = 'reconsiders'",
      )
      .run(new Date().toISOString(), m);
    assert.match(
      await shown(),
      /Reconsider when: レプリカが要るようになったら \[unsupported: its owner quote was retracted or forgotten/,
    );
    assert.equal(state(db, "trace:ext-s1/storage")?.lifecycle, "active");

    // The condition is part of what the record says; a record without one keeps the hash it had before conditions existed
    const plain = await save(db, target(p), { units: [decision("plain", {})] }, [m]);
    assert.deepEqual(plain.saved.active, ["trace:ext-s1/plain"]);
    const hashes = db.owner
      .prepare("select content_hash from unit order by id")
      .all()
      .map((r) => Buffer.from(r.content_hash as Uint8Array).toString("hex"));
    assert.notEqual(hashes[0], hashes[1]);
    assert.equal(
      hashes[1],
      createHash("sha256")
        .update(JSON.stringify(["保存先は SQLite", null, null, null, [["Postgres", "rejected", null]]]))
        .digest("hex"),
    );

    const refused = async (option: Record<string, unknown>, why: RegExp) => {
      const checked = await checkRecord(db.ingest, target(p), { units: [decision("x", option)] });
      assert.match(checked.errors.join("\n"), why);
    };
    await refused({ reconsider_when: "レプリカが要るようになったら" }, /go together/);
    await refused({ reconsider_quote: condition.reconsider_quote }, /go together/);
    await refused({ ...condition, outcome: "chosen" }, /only on a rejected option/);
    await refused(
      { ...condition, reconsider_quote: { source: `s${ai}`, quote: "Postgres を再検討できます" } },
      /must quote the owner/,
    );
    await refused(
      { evidence: [{ source: `s${m}`, quote: "レプリカが要る", role: "reconsiders" }] },
      /Invalid option/,
    );

    // A condition whose words are not in the message is refused: the agent fixes the quote or leaves the condition out
    await refused(
      { ...condition, reconsider_quote: { source: `s${m}`, quote: "言っていない条件" } },
      /reconsider_quote not found in s\d+/,
    );
  } finally {
    await db.done();
  }
});

test("a quote missing from the text quarantines the unit, and a unit without evidence is quarantined too", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "zod を使うかは未定。" });
    const { saved } = await save(db, target(p), {
      units: [
        {
          key: "zod",
          kind: "decision",
          stance: "do",
          text: "zod を使う",
          evidence: [{ source: `s${m}`, quote: "zod を使うことに決めた。", role: "states" }],
          adoption: [{ source: `s${m}`, quote: "決めた" }],
        },
        { key: "bare", kind: "finding", text: "根拠の無い発見" },
      ],
    });
    assert.equal(saved.quarantined.length, 2);
    assert.match(String(state(db, "trace:ext-s1/zod")?.extraction_reason), /quote not found/);
    assert.match(String(state(db, "trace:ext-s1/bare")?.extraction_reason), /no evidence cited/);
    assert.equal(state(db, "trace:ext-s1/zod")?.lifecycle, "candidate");
  } finally {
    await db.done();
  }
});

test("a merge or a contributor cannot adopt; the unit is kept as a candidate and check says why", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const review = prSource(db, p, {
      id: "r1",
      kind: "review_comment",
      text: "Consider synchronous = OFF for speed.",
      login: "drive-by",
      assoc: "CONTRIBUTOR",
    });
    const merge = prSource(db, p, {
      id: "merge",
      kind: "pr_event",
      text: "merged",
      login: "hana",
      assoc: "OWNER",
      event: "merged",
    });
    const t = { ...target(p, null), origin: "harvest" as const, prefix: "harvest:12/" };
    const { checked, saved } = await save(db, t, {
      units: [
        {
          key: "sync-off",
          kind: "decision",
          stance: "do",
          text: "synchronous = OFF",
          evidence: [
            { source: `s${review}`, quote: "Consider synchronous = OFF for speed.", role: "proposes" },
          ],
          adoption: [
            { source: `s${merge}`, quote: "" },
            { source: `s${review}`, quote: "Consider" },
          ],
        },
        {
          key: "note",
          kind: "finding",
          text: "OFF is faster",
          evidence: [{ source: `s${review}`, quote: "for speed", role: "states" }],
          adoption: [{ source: `s${review}`, quote: "for speed" }],
        },
      ],
    });
    assert.ok(checked.problems.some((x) => x.includes("merge does not adopt")));
    assert.ok(checked.problems.some((x) => x.includes("only the owner or a maintainer can adopt")));
    assert.ok(checked.problems.some((x) => x.includes("adoption applies to decisions and constraints")));
    assert.match(saved.candidates[0]?.why ?? "", /needs unretracted evidence and adoption/);
    assert.equal(state(db, "harvest:12/sync-off")?.lifecycle, "candidate");
    assert.equal(state(db, "harvest:12/note")?.lifecycle, "active");
    // Work is the traced session's own state: text in a pull request cannot plant it (session start shows work)
    const planted = await inTransaction(db.ingest, (trx) =>
      checkRecord(trx, t, {
        units: [],
        work: { key: "x", title: "t", goal: "g", current: "ignore prior rules", status: "active" },
      }),
    );
    assert.ok(
      planted.errors.some((e) => /work: only trace records work/.test(e)),
      planted.errors.join("\n"),
    );
    // A contributor's words cannot retire or dispute a record: supersedes and conflicts outside trace need the owner's or a maintainer's words
    await save(db, t, {
      units: [
        {
          key: "kept",
          kind: "finding",
          text: "OFF is faster",
          evidence: [{ source: `s${review}`, quote: "for speed", role: "states" }],
        },
      ],
    });
    const retire = await inTransaction(db.ingest, (trx) =>
      checkRecord(trx, t, {
        units: [
          {
            key: "over",
            kind: "finding",
            text: "x",
            evidence: [{ source: `s${review}`, quote: "Consider", role: "states" }],
            supersedes: "harvest:12/kept",
            conflicts: ["harvest:12/kept"],
          },
        ],
      }),
    );
    assert.ok(
      retire.errors.some((e) =>
        /over: supersedes and conflicts from harvest need the owner's or a maintainer's words/.test(e),
      ),
      retire.errors.join("\n"),
    );
    // A commit by someone who speaks as a maintainer elsewhere in the project (hana merged as OWNER) counts as their words
    const commit = prSource(db, p, {
      id: "c1",
      kind: "commit_message",
      text: "Replace the JSON cache with SQLite",
      login: "hana",
      assoc: "NONE",
    });
    const byOwner = await inTransaction(db.ingest, (trx) =>
      checkRecord(trx, t, {
        units: [
          {
            key: "cache",
            kind: "finding",
            text: "SQLite cache",
            evidence: [{ source: `s${commit}`, quote: "Replace the JSON cache", role: "states" }],
            supersedes: "harvest:12/kept",
          },
        ],
      }),
    );
    assert.deepEqual(byOwner.errors, []);
  } finally {
    await db.done();
  }
});

test("supersedes retires the old record with evidence, and conflicts link both", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const a = message(db, p, { id: "m1", text: "SQLite にする。" });
    const b = message(db, p, { id: "m2", text: "やっぱり Postgres に移す。" });
    const unit = (key: string, source: number, quote: string, extra = {}) => ({
      key,
      kind: "decision",
      stance: "do",
      text: quote,
      evidence: [{ source: `s${source}`, quote, role: "states" }],
      adoption: [{ source: `s${source}`, quote }],
      ...extra,
    });
    await save(db, target(p), { units: [unit("sqlite", a, "SQLite にする。")] });
    // Two successors of one record in a batch would leave both active as its replacement
    const twice = await inTransaction(db.ingest, (trx) =>
      checkRecord(trx, target(p), {
        units: [
          unit("pg1", b, "やっぱり Postgres に移す。", { supersedes: "trace:ext-s1/sqlite" }),
          unit("pg2", b, "やっぱり Postgres に移す。", { supersedes: "trace:ext-s1/sqlite" }),
        ],
      }),
    );
    assert.ok(
      twice.errors.some((e) =>
        /pg2: another record in this save already supersedes trace:ext-s1\/sqlite/.test(e),
      ),
      twice.errors.join("\n"),
    );
    const { saved } = await save(db, target(p), {
      units: [unit("postgres", b, "やっぱり Postgres に移す。", { supersedes: "trace:ext-s1/sqlite" })],
    });
    assert.deepEqual(saved.superseded, ["trace:ext-s1/sqlite"]);
    const last = db.owner
      .prepare(
        "select to_state, source_id from unit_state where unit_id = (select id from unit where key = 'trace:ext-s1/sqlite') order by id desc",
      )
      .get();
    assert.deepEqual([last?.to_state, last?.source_id], ["superseded", b]);
    await save(db, target(p), {
      units: [
        {
          key: "maybe",
          kind: "question",
          text: "どちらか",
          evidence: [{ source: `s${b}`, quote: "Postgres", role: "states" }],
          conflicts: ["trace:ext-s1/postgres"],
        },
      ],
    });
    assert.equal(
      db.owner.prepare("select count(*) as n from unit_link where kind = 'conflicts'").get()?.n,
      1,
    );
  } finally {
    await db.done();
  }
});

test("check refuses malformed records, reused keys, stance mistakes, foreign sources, and unknown links", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const other = project(db, "git:github.com/o/other", "o/other");
    const theirs = message(db, other, { id: "x", text: "他のプロジェクトの発言", session: "s9" });
    const m = message(db, p, { id: "m1", text: "決めた。" });
    await save(db, target(p), {
      units: [
        {
          key: "k",
          kind: "finding",
          text: "t",
          evidence: [{ source: `s${m}`, quote: "決めた", role: "states" }],
        },
      ],
    });
    const check = (record: unknown) => inTransaction(db.ingest, (trx) => checkRecord(trx, target(p), record));
    assert.match((await check({ units: "x" })).errors.join(), /units/);
    const c = await check({
      units: [
        {
          key: "k",
          kind: "finding",
          text: "t",
          evidence: [{ source: `s${theirs}`, quote: "他", role: "states" }],
        },
        { key: "d", kind: "decision", text: "no stance", revisit_when: "later" },
        { key: "d", kind: "finding", text: "dup", supersedes: "trace:ext-s1/none", conflicts: ["nope"] },
        {
          key: "a",
          kind: "finding",
          text: "a",
          anchors: [{ path: "../x", role: "applies_to" }],
          aliases: ["x".repeat(41)],
        },
      ],
    });
    for (const want of [
      /already recorded/,
      new RegExp(`s${theirs}: not a source of this project`),
      /stance is required/,
      /revisit_when goes only with stance defer/,
      /appears twice/,
      /not a record of this project/,
    ])
      assert.ok(
        c.errors.some((e) => want.test(e)),
        `${want}: ${c.errors.join(" | ")}`,
      );
    assert.ok(c.problems.some((x) => /not inside the repository/.test(x)));
    assert.ok(c.problems.some((x) => /aliases must be 1 to 40/.test(x)));
    await assert.rejects(
      inTransaction(db.ingest, (trx) => saveRecord(trx, target(p), 1, c, [])),
      /not valid/,
    );
  } finally {
    await db.done();
  }
});

test("an evidence anchor without a commit cites this session's edit observation of the path", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "toCsv を直した。" });
    insert(db, "edit_observation", {
      session_id: "s1",
      turn_id: "t1",
      path: "src/export.ts",
      via: "tool",
      observed_at: now,
    });
    await save(db, target(p), {
      units: [
        {
          key: "csv",
          kind: "implementation",
          text: "toCsv を直した",
          evidence: [{ source: `s${m}`, quote: "toCsv を直した。", role: "implements" }],
          anchors: [{ path: "src/export.ts", symbol: "toCsv", role: "evidence" }],
        },
      ],
    });
    assert.equal(state(db, "trace:ext-s1/csv")?.lifecycle, "active");
  } finally {
    await db.done();
  }
});

test("trace reads pending sessions, a draft's run, a session's messages and edits, and live records", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "やること" });
    message(db, p, { id: "m2", text: "返事", speaker: "assistant" });
    message(db, p, { id: "m3", text: "返事だけ", speaker: "assistant", session: "s2" });
    insert(db, "edit_observation", {
      session_id: "s1",
      turn_id: "t1",
      path: "a.ts",
      via: "status",
      observed_at: now,
    });
    const pending = await pendingSessions(db.reader, p, "recent", new Date("2026-09-20T00:00:00Z"));
    assert.deepEqual(
      pending.rows.map((r) => [r.id, Number(r.waiting), Number(r.first)]),
      [["s1", 1, m]],
    );
    const runId = await openRun(db.ingest, {
      projectId: p,
      origin: "trace",
      target: "session:s1",
      sessionId: "s1",
      draftId: "dx",
    });
    assert.equal((await runOf(db.reader, "dx"))?.id, runId);
    assert.equal(await runOf(db.reader, "none"), null);
    assert.deepEqual(
      (await sessionSources(db.reader, "s1")).map((s) => [s.author_kind, Number(s.looked)]),
      [
        ["owner", 0],
        ["assistant", 0],
      ],
    );
    assert.deepEqual(await sessionEdits(db.reader, "s1"), [{ path: "a.ts", via: "status", turn_id: "t1" }]);
    assert.deepEqual(await liveUnits(db.reader, p), []);
  } finally {
    await db.done();
  }
});

test("a trace or harvest run cites only the sources it was given; another session's words are refused", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const mine = message(db, p, { id: "m1", text: "Use SQLite." });
    const theirs = message(db, p, { id: "m2", text: "Use Postgres.", session: "s2" });
    const record = (source: number, quote: string) => ({
      units: [
        {
          key: "db",
          kind: "decision",
          stance: "do",
          text: quote,
          evidence: [{ source: `s${source}`, quote, role: "states" }],
          adoption: [{ source: `s${source}`, quote }],
        },
      ],
    });
    const scoped: Target = { ...target(p), sources: [mine] };
    const refused = await checkRecord(db.reader, scoped, record(theirs, "Use Postgres."));
    assert.ok(
      refused.errors.some((e) => e.includes(`s${theirs}: not a source of this run`)),
      refused.errors.join(" | "),
    );
    assert.deepEqual((await checkRecord(db.reader, scoped, record(mine, "Use SQLite."))).errors, []);
  } finally {
    await db.done();
  }
});

test("an implementation's commit anchor counts only when that commit holds the path in the repository", async () => {
  const db = tempDb();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-commit-")));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
        encoding: "utf8",
      }).trim();
    git("init", "-q");
    fs.writeFileSync(path.join(root, "db.ts"), "export const open = () => 1;\n");
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "db");
    const real = git("rev-parse", "HEAD");
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "open を足した。" });
    const built = (key: string, commit: string, file = "db.ts") => ({
      units: [
        {
          key,
          kind: "implementation",
          text: "open を足した",
          evidence: [{ source: `s${m}`, quote: "open を足した。", role: "states" }],
          anchors: [{ path: file, role: "evidence", commit }],
        },
      ],
    });
    const t: Target = { ...target(p), root };
    const forged = await save(db, t, built("forged", "0".repeat(40)));
    assert.deepEqual(forged.saved.active, [], "an unknown commit is not code evidence");
    assert.ok(
      forged.checked.problems.some((x) => /commit .* does not hold db\.ts/.test(x)),
      forged.checked.problems.join(" | "),
    );
    assert.deepEqual((await save(db, t, built("elsewhere", real, "missing.ts"))).saved.active, []);
    assert.deepEqual(
      (await save(db, t, built("folder", real, "src"))).saved.active,
      [],
      "a folder is not a file",
    );
    assert.deepEqual((await save(db, t, built("real", real))).saved.active, ["trace:ext-s1/real"]);
  } finally {
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an older session traced after a newer one never overwrites the newer work state", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const older = message(db, p, { id: "m1", text: "まだ途中。" });
    const newer = message(db, p, { id: "m2", text: "終わった。", session: "s2" });
    db.owner.prepare("update session set started_at = ? where id = 's2'").run(at("2026-09-05T00:00:00Z"));
    const work = (status: string, current: string) => ({
      units: [],
      work: { key: "w", title: "移行", goal: "終える", current, status },
    });
    const run = (sessionId: string) => ({ ...target(p, sessionId), prefix: `trace:ext-${sessionId}/` });
    // trace_pending lists the newest session first, so it is traced first
    await save(db, run("s2"), work("done", "終わった"), [newer]);
    await save(db, run("s1"), work("active", "まだ途中"), [older]);
    assert.deepEqual(
      { ...db.owner.prepare("select status, current from work where key = 'w'").get() },
      { status: "done", current: "終わった" },
    );
  } finally {
    await db.done();
  }
});

test("a traced work item carries its session's branch", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "途中。" });
    db.owner.prepare("update session set branch = 'feature/x' where id = 's1'").run();
    await save(
      db,
      target(p),
      { units: [], work: { key: "w", title: "移行", goal: "終える", current: "途中", status: "active" } },
      [m],
    );
    assert.equal(db.owner.prepare("select branch from work where key = 'w'").get()?.branch, "feature/x");
  } finally {
    await db.done();
  }
});

// A path the filesystem cannot open would make every later read of the record fail
test("anchor problem: a missing path, a directory, or a symbol not in the file is reported, and the anchor is still saved", async () => {
  const db = tempDb();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-anchor-")));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
        encoding: "utf8",
      }).trim();
    git("init", "-q");
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(
      path.join(root, "src", "dates.ts"),
      "export const toStored = (d: Date) => d.toISOString();\n",
    );
    fs.writeFileSync(path.join(root, "src", "legacy.ts"), "export const old = 1;\n");
    fs.writeFileSync(path.join(root, "logo.bin"), Buffer.from([1, 0, 2]));
    git("add", "-A");
    git("commit", "-qm", "first");
    const commit = git("rev-parse", "HEAD");
    // legacy.ts is deleted in this session; the commit still holds it
    fs.rmSync(path.join(root, "src", "legacy.ts"));
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "日付の保存は toStored にまとめた。" });
    for (const rel of ["src/legacy.ts", "src/dates.ts"])
      insert(db, "edit_observation", {
        session_id: "s1",
        turn_id: "t1",
        path: rel,
        via: "tool",
        observed_at: now,
      });
    const unit = (key: string, anchor: Record<string, string>) => ({
      key,
      kind: "implementation",
      text: "日付の保存は toStored にまとめた",
      evidence: [{ source: `s${m}`, quote: "日付の保存は toStored にまとめた。", role: "implements" }],
      anchors: [anchor],
    });
    const problemsOf = async (t: Target, key: string, anchor: Record<string, string>) => {
      const { checked } = await save(db, t, { units: [unit(key, anchor)] });
      return checked.problems.filter((x) => x.includes("anchor") || x.includes("symbol"));
    };
    const t: Target = { ...target(p), root };

    const missing = await problemsOf(t, "missing", { path: "src/date.ts", role: "applies_to" });
    assert.equal(missing.length, 1, missing.join(" | "));
    assert.match(missing[0] ?? "", /anchor path src\/date\.ts is not in the working tree/);
    assert.match(
      String(db.owner.prepare("select path from unit_anchor where path = 'src/date.ts'").get()?.path),
      /src\/date\.ts/,
      "the anchor is kept",
    );
    assert.match(
      (await problemsOf(t, "folder", { path: "src", role: "applies_to" })).join(" | "),
      /anchor path src is a directory; anchor a file/,
    );
    assert.match(
      (await problemsOf(t, "typo", { path: "src/dates.ts", symbol: "toStore", role: "evidence" })).join(
        " | ",
      ),
      /symbol "toStore" is not found in src\/dates\.ts/,
      "an edited file is still checked for its symbol",
    );
    assert.match(
      (await problemsOf(t, "applies", { path: "src/legacy.ts", role: "applies_to" })).join(" | "),
      /anchor path src\/legacy\.ts is not in the working tree/,
      "only evidence of a deleted file is exempt",
    );

    // Right, or not checkable here: no anchor problem
    for (const [key, anchor, tt] of [
      ["right", { path: "src/dates.ts", symbol: "toStored", role: "applies_to" }, t],
      ["deleted", { path: "src/legacy.ts", role: "evidence" }, t],
      ["held", { path: "src/legacy.ts", symbol: "gone", role: "applies_to", commit }, t],
      ["binary", { path: "logo.bin", role: "applies_to" }, t],
      ["no-root", { path: "src/date.ts", symbol: "toStore", role: "applies_to" }, target(p)],
    ] as const)
      assert.deepEqual(await problemsOf(tt, key, anchor), [], key);
  } finally {
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an anchor path holding a NUL or other control character is refused", () => {
  assert.equal(repoPath("src/a.ts"), "src/a.ts");
  assert.equal(repoPath("x\0y"), null);
  assert.equal(repoPath("x\ny"), null);
});

test("an integer value must be a whole number written in the quote; other types must be written as they are", () => {
  assert.equal(valueInQuote("integer", "320", "p95=320ms after the fix"), true);
  assert.equal(valueInQuote("integer", "95", "p95=320ms after the fix"), false);
  assert.equal(valueInQuote("integer", "-5", "p95=-5 now"), true);
  assert.equal(valueInQuote("integer", "5", "p95=-5 now"), false);
  assert.equal(valueInQuote("integer", "1", "it took 1.5 s"), false);
  assert.equal(valueInQuote("integer", "1", "about 1e3 rows"), false);
  assert.equal(valueInQuote("integer", "5", "+5 retries"), true);
  assert.equal(valueInQuote("integer", "3", "レイテンシは3件だけ"), true);
  // A sign that an identifier runs into is not the number's own, and the digits after it are not a number either
  assert.equal(valueInQuote("integer", "5", "x-5"), false);
  assert.equal(valueInQuote("integer", "-5", "x-5"), false);
  assert.equal(valueInQuote("integer", "95", "β95=320ms"), false);
  assert.equal(valueInQuote("integer", "95", "ｐ95=320ms"), false);
  assert.equal(valueInQuote("integer", "320", "ｐ95=320ms"), true);
  for (const quote of ["x−5", "x＋5", "x－5"])
    assert.equal(valueInQuote("integer", "5", quote), false, quote);
  assert.equal(valueInQuote("integer", "95", "β\u030195"), false);
  // A grouped number is one number: 1,000 is 1000, never 1
  assert.equal(valueInQuote("integer", "1", "1,000 records"), false);
  assert.equal(valueInQuote("integer", "1000", "1,000 records"), true);
  assert.equal(valueInQuote("integer", "2", "steps 1,2 failed"), true);
  // An enum value or a date stands on its own: not inside a longer word or number, while kana and kanji need no space around it
  assert.equal(valueInQuote("enum", "no", "not ready"), false);
  assert.equal(valueInQuote("enum", "do", "undo this change"), false);
  assert.equal(valueInQuote("enum", "no", "the answer is no."), true);
  assert.equal(valueInQuote("enum", "high", "重要度はhighで"), true);
  assert.equal(valueInQuote("date", "2026-10-01", "due 2026-10-012"), false);
  assert.equal(valueInQuote("text", "acme", "acmecorp"), true);
  assert.equal(valueInQuote("enum", "high", "severity High"), false);
  assert.equal(valueInQuote("date", "2026-10-01", "due 2026-10-01"), true);
  assert.equal(valueInQuote("date", "2026-10-01", "due Oct 1"), false);
  assert.equal(valueInQuote("text", "テナント A", "影響はテナント A だけ"), true);
});

test("trace defines a field from the owner's words and fills values only with quotes that write them", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const owner = message(db, p, {
      id: "m1",
      text: "これから決定には tenant を記録して。acme の p95 が 320ms だったので Redis にする。",
    });
    const ai = message(db, p, { id: "m2", text: "Shall I also track severity?", speaker: "assistant" });
    const run = await beginTrace(db.ingest, p, "s1");
    const tenant = {
      name: "tenant",
      type: "text",
      label: "Tenant",
      description: "The tenant affected",
      kinds: ["decision"],
      quote: { source: `s${owner}`, quote: "tenant を記録して" },
    };
    const decision = (fields: unknown[], key = "redis") => ({
      key,
      kind: "decision",
      stance: "do",
      text: "Redis にする",
      evidence: [{ source: `s${owner}`, quote: "Redis にする", role: "states" }],
      adoption: [{ source: `s${owner}`, quote: "Redis にする" }],
      fields,
    });
    const refused = async (record: unknown, why: RegExp) => {
      const c = await checkText(db.ingest, run, p, null, record);
      assert.equal(c.ok, false, c.text);
      assert.match(c.text, why);
    };
    await refused(
      { field_defs: [{ ...tenant, quote: { source: `s${ai}`, quote: "track severity" } }], units: [] },
      /quote must be the owner's/,
    );
    await refused({ field_defs: [tenant, tenant], units: [] }, /defined twice/);
    await refused({ field_defs: [{ ...tenant, type: "enum" }], units: [] }, /enum goes with type enum/);
    await refused(
      {
        field_defs: [],
        units: [decision([{ name: "tenant", value: "acme", quote: { source: `s${owner}`, quote: "acme" } }])],
      },
      /not a field of this project/,
    );
    await refused(
      {
        field_defs: [tenant],
        units: [
          decision([
            { name: "tenant", value: "globex", quote: { source: `s${owner}`, quote: "acme の p95" } },
          ]),
        ],
      },
      /not written in the quote/,
    );
    await refused(
      {
        field_defs: [tenant],
        units: [
          decision([{ name: "tenant", value: "acme", quote: { source: `s${owner}`, quote: "acme の p96" } }]),
        ],
      },
      /quote not found/,
    );
    await refused(
      {
        field_defs: [tenant],
        units: [
          {
            ...decision([]),
            kind: "finding",
            stance: undefined,
            adoption: [],
            fields: [{ name: "tenant", value: "acme", quote: { source: `s${owner}`, quote: "acme" } }],
          },
        ],
      },
      /applies to decision, not finding/,
    );

    const saved = await saveText(db.ingest, run, p, null, {
      field_defs: [
        tenant,
        {
          ...tenant,
          name: "p95",
          type: "integer",
          label: "p95",
          kinds: [],
          quote: { source: `s${owner}`, quote: "p95" },
        },
      ],
      units: [
        decision([
          { name: "tenant", value: "acme", quote: { source: `s${owner}`, quote: "acme の p95" } },
          { name: "p95", value: "320", quote: { source: `s${owner}`, quote: "p95 が 320ms" } },
        ]),
      ],
    });
    assert.match(saved, /trace:ext-s1\/redis active/);
    const rows = db.owner
      .prepare(
        "select d.name, f.value from unit_field f join field_def d on d.id = f.field_def_id order by f.id",
      )
      .all()
      .map((r) => ({ ...r }));
    assert.deepEqual(rows, [
      { name: "tenant", value: "acme" },
      { name: "p95", value: "320" },
    ]);
    // A later run sees the definitions and cannot define them again
    const next = await beginTrace(db.ingest, p, "s1");
    const context = await contextText(db.ingest, next, p, null);
    assert.match(context, /- tenant \(text; decision\) Tenant: The tenant affected/);
    assert.match(context, /- p95 \(integer; every kind\) p95: The tenant affected/);
    const again = await checkText(db.ingest, next, p, null, { field_defs: [tenant], units: [] });
    assert.match(again.text, /already defined in this project/);
    const typed = await checkText(db.ingest, next, p, null, {
      units: [
        decision([{ name: "p95", value: "3.2", quote: { source: `s${owner}`, quote: "320ms" } }], "second"),
      ],
    });
    assert.match(typed.text, /an integer is an optional minus sign and digits/);
  } finally {
    await db.done();
  }
});

test("a record that only defines a field marks its source as used, and harvest cannot write fields", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const owner = message(db, p, { id: "m1", text: "Track the tenant on decisions." });
    const def = {
      name: "tenant",
      type: "text",
      label: "Tenant",
      description: "The tenant affected",
      quote: { source: `s${owner}`, quote: "Track the tenant" },
    };
    const harvest = await checkRecord(
      db.ingest,
      { ...target(p), origin: "harvest" },
      { field_defs: [def], units: [] },
    );
    assert.deepEqual(harvest.errors, ["field_defs and fields: only trace records fields"]);
    await save(db, target(p), { field_defs: [def], units: [] }, [owner]);
    assert.deepEqual(
      { ...db.owner.prepare("select outcome from source_processing where source_id = ?").get(owner) },
      { outcome: "units" },
    );
    assert.equal(Number(db.owner.prepare("select count(*) as n from field_def").get()?.n), 1);
  } finally {
    await db.done();
  }
});
