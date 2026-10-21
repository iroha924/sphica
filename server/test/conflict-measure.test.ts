// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The offline conflict evaluation's measures and verdict, computed from labels and candidate ids alone; the public baseline's allowlist;
// --recount, which counts a public baseline again and fails when it does not come out as written; the pinned population, drawn from
// a real SQLite database and checked against its own seed and hashes; and the labels, held to that population.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  type Bars,
  type Baseline,
  decide,
  digest,
  type Labels,
  type Prompt,
  promptLines,
  publicJson,
  reached,
  summarize,
  wilson,
} from "../evals/conflict/measure.ts";
import {
  assemble,
  buildLabels,
  checkHeldOut,
  checkLabels,
  checkTune,
  measure,
  overlapOf,
  type Pair,
  pairsToLabel,
  pinned,
  type Review,
  recount,
  type Tune,
  type Written,
} from "../evals/conflict/run.ts";
import {
  build,
  checkPopulation,
  extractOrdinary,
  extractRecords,
  fileSha,
  type Population,
  readKey,
  splitRecords,
  textMac,
} from "../evals/conflict/sample.ts";
import { inTransaction } from "../src/db.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { openRun } from "../src/trace.ts";
import { message, project, type TempDb, tempDb } from "./temp-db.ts";
import { tempDir, tmpEnv } from "./temp-dir.ts";

const METHODS = ["B0", "B1b", "B2"];
const KEY = "ab".repeat(32);
const none = { candidates: [], shown: [], cut: [] };
let n = 0;

/** A held-out prompt every method gave nothing, with what the test changes */
function prompt(over: Partial<Prompt> = {}): Prompt {
  n += 1;
  return {
    id: `p${n}`,
    mac: digest(`p${n}`),
    group: "positive",
    split: "held_out",
    lang: "ja",
    override: false,
    writer: "codex",
    overlap: "none",
    call: "keep",
    undecidable: false,
    conflict: [7],
    related: [],
    labels: {},
    results: Object.fromEntries(METHODS.map((m) => [m, none])),
    ...over,
  };
}
const shows = (ids: number[]) => ({ candidates: ids, shown: ids, cut: [] });
const ordinary = (over: Partial<Prompt> = {}) =>
  prompt({ group: "ordinary", writer: "owner", call: null, conflict: [], overlap: null, ...over });

const BARS: Bars = {
  minPositivePerLanguage: 2,
  minOrdinary: 40,
  maxUndecidable: 0.1,
  minShown: 0.6,
  minGainOverB0: 0.2,
  maxUnrelatedUpper: 0.1,
};

test("Wilson's interval at 95% matches the published values and says nothing of an empty group", () => {
  assert.deepEqual(wilson(5, 10), { k: 5, n: 10, rate: 0.5, low: 0.2366, high: 0.7634 });
  assert.deepEqual(wilson(0, 10), { k: 0, n: 10, rate: 0, low: 0, high: 0.2775 });
  assert.deepEqual(wilson(10, 10), { k: 10, n: 10, rate: 1, low: 0.7225, high: 1 });
  assert.deepEqual(wilson(0, 0), { k: 0, n: 0, rate: null, low: null, high: null });
});

test("a positive prompt is shown when any record of its conflict set is shown, and otherwise dropped at the first stage it missed", () => {
  const p = prompt({ conflict: [7, 8] });
  assert.equal(reached(p, { candidates: [1, 8], shown: [1, 8], cut: [] }), "shown");
  assert.equal(reached(p, { candidates: [1, 7], shown: [1], cut: [] }), "chars");
  assert.equal(reached(p, { candidates: [1, 2, 3, 7], shown: [1, 2, 3], cut: [] }), "rank");
  assert.equal(reached(p, { candidates: [1], shown: [1], cut: [7] }), "limit");
  assert.equal(reached(p, { candidates: [1], shown: [1], cut: [2] }), "none");
});

test("the summary counts three stages, drop reasons, and gains and losses over B0, leaving out dropped and undecidable prompts", () => {
  const ps = [
    prompt({ results: { B0: shows([7]), B1b: shows([7]), B2: none } }),
    prompt({
      results: { B0: none, B1b: shows([7]), B2: { candidates: [1, 2, 3, 7], shown: [1, 2], cut: [] } },
    }),
    prompt({
      lang: "en",
      override: true,
      results: { B0: none, B1b: none, B2: { candidates: [], shown: [], cut: [7] } },
    }),
    prompt({ call: "drop", results: { B0: none, B1b: shows([7]), B2: shows([7]) } }),
    prompt({ undecidable: true, results: { B0: none, B1b: shows([7]), B2: shows([7]) } }),
    prompt({ split: "tune", results: { B0: none, B1b: shows([7]), B2: shows([7]) } }),
    prompt({ group: "hard_negative", conflict: [], results: { B0: none, B1b: shows([3]), B2: none } }),
    ordinary({
      labels: { "3": "unrelated", "4": "conflict" },
      results: { B0: none, B1b: shows([3]), B2: shows([4]) },
    }),
    ordinary({ labels: { "5": "undecidable" }, results: { B0: none, B1b: shows([5]), B2: none } }),
  ];
  const s = summarize(ps, METHODS, "held_out");
  assert.deepEqual(s.counts, {
    positive: { ja: { kept: 2, dropped: 1, undecidable: 1 }, en: { kept: 1, dropped: 0, undecidable: 0 } },
    hard_negative: { kept: 1, dropped: 0, undecidable: 0 },
    ordinary: { kept: 1, undecidable: 1 },
  });
  const b1 = s.methods.B1b;
  const b2 = s.methods.B2;
  assert.equal(b1?.positive.all.shown.k, 2);
  assert.equal(b1?.positive.all.shown.n, 3);
  assert.deepEqual(b1?.positive.ja.shown.k, 2);
  assert.deepEqual(b1?.positive.override.shown, wilson(0, 1));
  assert.deepEqual(b1?.vs_b0, { gained: 1, lost: 0 });
  assert.deepEqual(b2?.vs_b0, { gained: 0, lost: 1 });
  assert.deepEqual(b2?.drops, { none: 1, limit: 1, rank: 1, chars: 0 });
  assert.deepEqual(
    [b2?.positive.all.candidate.k, b2?.positive.all.top3.k, b2?.positive.all.shown.k],
    [1, 0, 0],
  );
  assert.deepEqual(b1?.ordinary_unrelated, wilson(1, 1));
  assert.deepEqual(
    b1?.ordinary_unrelated_if_undecided,
    wilson(2, 2),
    "the left-out prompt counts when its record is taken as unrelated",
  );
  assert.deepEqual(b2?.ordinary_unrelated_if_undecided, wilson(0, 2));
  assert.deepEqual(
    [b2?.ordinary_unrelated.k, b2?.ordinary_conflicts],
    [0, 1],
    "a real conflict is not counted unrelated",
  );
  assert.deepEqual(b1?.hard_negative_shown, wilson(1, 1));

  assert.throws(
    () => summarize([ordinary({ results: { B0: shows([9]), B1b: none, B2: none } })], METHODS, "held_out"),
    /shows record 9, which has no label/,
  );
  assert.throws(() => summarize([prompt({ call: null })], METHODS, "held_out"), /no review call yet/);
  assert.throws(() => summarize([prompt()], ["B1b"], "held_out"), /must include B0/);
});

/** Enough prompts to clear the bars: B1b shows 3 of 4 positives in each language, B0 shows 1, and n ordinary prompts show nothing */
function passing(ordinaryCount = 40): Prompt[] {
  const out: Prompt[] = [];
  for (const lang of ["ja", "en"] as const)
    for (let i = 0; i < 4; i++)
      out.push(
        prompt({
          lang,
          results: {
            B0: i === 0 ? shows([7]) : none,
            B1b: i < 3 ? shows([7]) : none,
            B2: i === 0 ? shows([7]) : none,
          },
        }),
      );
  for (let i = 0; i < ordinaryCount; i++) out.push(ordinary());
  return out;
}

test("the verdict holds first, then advances a method only when it clears every bar", () => {
  const verdict = (ps: Prompt[], bars = BARS, judged = ["B1b", "B2"]) =>
    decide(summarize(ps, METHODS, "held_out"), bars, judged);
  assert.deepEqual(verdict(passing()), { verdict: "advance", reasons: [], passing: ["B1b"] });
  assert.equal(verdict(passing(), BARS, ["B2"]).verdict, "not_now", "a method not judged never advances");
  assert.deepEqual(verdict(passing(), { ...BARS, minPositivePerLanguage: 5 }), {
    verdict: "hold",
    reasons: ["too_few_positive_ja", "too_few_positive_en"],
    passing: [],
  });
  const undecided = [...passing(), ...Array.from({ length: 5 }, () => ordinary({ undecidable: true }))];
  assert.deepEqual(verdict(undecided).reasons, ["undecidable_ordinary"]);
  assert.deepEqual(verdict(passing(39)).reasons, ["too_few_ordinary"]);

  // B1b loses the one positive B0 showed
  const lost = passing().map((p, i) => (i === 0 ? { ...p, results: { ...p.results, B1b: none } } : p));
  assert.deepEqual(verdict(lost), { verdict: "not_now", reasons: [], passing: [] });
  // One unrelated record shown in 40 ordinary prompts lifts the upper bound past 10%
  const noisy = passing().map((p, i) =>
    i === 8 ? { ...p, labels: { "3": "unrelated" as const }, results: { ...p.results, B1b: shows([3]) } } : p,
  );
  assert.equal(verdict(noisy).verdict, "not_now");
  // 4 of 8 shown is short of 60%, though still 2 more than B0 and none lost
  const short = passing().map((p, i) =>
    i === 1 || i === 2 ? { ...p, results: { ...p.results, B1b: none } } : p,
  );
  assert.equal(verdict(short).verdict, "not_now");
});

function baseline(ps: Prompt[], over: Partial<Baseline> = {}): Baseline {
  const methods = { B0: {}, B1b: { alias: "terms" as const }, B2: { search: 10 } };
  const summary = summarize(ps, Object.keys(methods), "held_out");
  return {
    issue: 260,
    measured_at: "2026-10-21",
    review: "cross_model",
    labelling: { pairs: 0, first_agree: 0, second_agree: 0, undecidable: 0 },
    inputs: {
      db_sha256: digest("db"),
      prompts_sha256: digest("prompts"),
      population_sha256: digest("population"),
    },
    methods,
    bars: BARS,
    synthetic_text_public: false,
    prompts: ps,
    summary,
    judged: ["B1b", "B2"],
    verdict: decide(summary, BARS, ["B1b", "B2"]),
    ...over,
  };
}

test("the public baseline holds only allowlisted keys and values, and never the owner's own prompts", () => {
  const b = baseline(passing());
  assert.doesNotThrow(() => publicJson(b));
  const withText = (i: number, text: string, open: boolean) =>
    baseline(
      passing().map((p, j) => (j === i ? { ...p, text } : p)),
      { synthetic_text_public: open },
    );
  assert.throws(
    () => publicJson(withText(0, "SQLite をやめて Postgres に", false)),
    /only when the owner allowed it/,
  );
  assert.doesNotThrow(() => publicJson(withText(0, "SQLite をやめて Postgres に", true)));
  assert.throws(() => publicJson(withText(8, "今日の作業を続けて", true)), /never published/);
  assert.throws(
    () => publicJson({ ...b, note: "the owner said ..." } as Baseline),
    /baseline\.note: a key outside the allowlist/,
  );
  const first = b.prompts[0] as Prompt;
  const one = (p: Partial<Prompt>) => ({ ...b, prompts: [{ ...first, ...p }, ...b.prompts.slice(1)] });
  assert.throws(() => publicJson(one({ id: "move to Postgres" })), /prompts\[0\]\.id/);
  assert.throws(
    () => publicJson(one({ labels: { "move to Postgres": "related" } })),
    /a key outside the allowlist/,
  );
  assert.throws(() => publicJson(one({ mac: "Postgres" })), /prompts\[0\]\.mac/);
  assert.throws(
    () => publicJson({ ...b, verdict: { ...b.verdict, reasons: ["the owner wants Postgres"] } }),
    /verdict\.reasons\[0\]/,
  );
});

test("the public files put each prompt on one line and read back as written", () => {
  const b = baseline(passing());
  const text = promptLines({ chosen: "B1b", baseline: b });
  assert.deepEqual(JSON.parse(text), { chosen: "B1b", baseline: b });
  const lines = text.split("\n").filter((l) => l.includes('"mac"'));
  assert.equal(lines.length, b.prompts.length, "one line per prompt");
  assert.ok(lines.every((l) => l.trim().startsWith('{"id"')));
});

test("--recount counts the public baseline again from labels and ids alone, and fails when it does not come out as written", () => {
  const dir = tempDir("sphica-conflict-recount-");
  const file = path.join(dir, "baseline.json");
  const b = baseline(passing());
  fs.writeFileSync(file, publicJson(b));
  assert.deepEqual(recount(JSON.parse(fs.readFileSync(file, "utf8"))), { verdict: b.verdict, differs: [] });
  const run = () =>
    spawnSync(
      process.execPath,
      [path.join(import.meta.dirname, "..", "evals", "conflict", "run.ts"), "--recount", file],
      {
        encoding: "utf8",
        env: { ...tmpEnv(), PATH: process.env.PATH ?? "", HOME: dir, USERPROFILE: dir },
      },
    );
  const ok = run();
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /advance \(B1b\), as written/);

  const changed = structuredClone(b);
  for (const i of [1, 2]) (changed.prompts[i] as Prompt).results.B1b = none;
  fs.writeFileSync(file, publicJson(changed));
  const bad = run();
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /the summary and verdict counted again differ/);
  changed.summary = summarize(changed.prompts, Object.keys(changed.methods), "held_out");
  fs.writeFileSync(file, publicJson(changed));
  const stale = run();
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /the verdict counted again differ/, "B1b now shows 4 of 8, short of 60%");
});

async function save(db: TempDb, p: number, units: unknown[]) {
  const t: Target = {
    projectId: p,
    origin: "trace",
    prefix: "trace:ext-s1/",
    sessionId: "s1",
    root: null,
    sources: null,
  };
  await inTransaction(db.ingest, async (trx) => {
    const run = await openRun(trx, {
      projectId: p,
      origin: "trace",
      target: "session:s1",
      sessionId: "s1",
      draftId: `d${Math.random()}`,
    });
    return saveRecord(trx, t, run, await checkRecord(trx, t, { units }), []);
  });
}

const decided = (key: string, source: number, extra: Record<string, unknown> = {}) => ({
  key,
  kind: "decision",
  stance: "dont",
  text: `Rule ${key}`,
  evidence: [{ source: `s${source}`, quote: "Rules.", role: "states" }],
  adoption: [{ source: `s${source}`, quote: "Rules." }],
  ...extra,
});
const rejected = (text: string) => ({ options: [{ text, outcome: "rejected" }] });

/** Four dont decisions (two with a rejected option), four other records with one, a dont constraint, a candidate, and prompts */
async function fixture(db: TempDb): Promise<{ p: number; id: (key: string) => number }> {
  const p = project(db);
  const m = message(db, p, { id: "m1", text: "Rules." });
  await save(db, p, [
    decided("d1", m),
    decided("d2", m),
    decided("d3", m, rejected("Postgres")),
    decided("d4", m, rejected("MySQL")),
    ...["o1", "o2", "o3", "o4"].map((k) => decided(k, m, { stance: "do", ...rejected(`Option ${k}`) })),
    decided("c1", m, { kind: "constraint" }),
    {
      key: "maybe",
      kind: "decision",
      stance: "dont",
      text: "Maybe not",
      evidence: [{ source: `s${m}`, quote: "Rules.", role: "proposes" }],
    },
  ]);
  for (const s of ["a", "b", "c", "d"])
    for (const t of [1, 2])
      message(db, p, {
        id: `${s}${t}:owner:h`,
        text: `Prompt ${s}${t}`,
        sent: `2026-10-0${t + 2}T00:00:00Z`,
        session: uuid(s),
      });
  const a = { sent: "2026-10-03T00:00:00Z", session: uuid("a") };
  message(db, p, { id: "a3:ask:call:h", text: "Yes", ...a });
  message(db, p, { id: "a4:owner:h", text: "<task-notification> done", ...a });
  message(db, p, { id: "a8:owner:h", text: "Another Claude session sent a message: done", ...a });
  message(db, p, { id: "a5:owner:h", text: "Before", ...a, sent: "2026-09-30T23:59:59Z" });
  message(db, p, { id: "a6:owner:h", text: "At the end", ...a, sent: "2026-10-10T00:00:00Z" });
  message(db, p, { id: "a7:assistant", text: "Done", ...a, speaker: "assistant" });
  db.owner
    .prepare(
      "insert into session (id, project_id, host, external_id, started_at) values (?, ?, 'codex', ?, ?)",
    )
    .run(uuid("e"), p, uuid("f"), "2026-10-20T00:00:00.000Z");
  const id = (key: string) =>
    Number(db.owner.prepare("select id from unit where key = ?").get(`trace:ext-s1/${key}`)?.id);
  return { p, id };
}

/** Session ids as the hosts give them */
const uuid = (c: string) => `00000000-0000-4000-8000-00000000000${c}`;
const WINDOW = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-10T00:00:00.000Z" };
const PER = { dont: 1, rejected: 2, ordinary: 2 };

test("the population takes deliverable dont decisions and rejected options, and the window's own prompts without answers or injected text", async () => {
  const db = tempDb();
  try {
    const { p, id } = await fixture(db);
    const r = await extractRecords(db.reader, p);
    assert.equal(r.deliverable, 9, "the candidate is not deliverable");
    assert.deepEqual(r.dont, ["d1", "d2", "d3", "d4"].map(id), "a dont constraint is not a dont decision");
    assert.deepEqual(
      r.rejected.map(([u]) => u),
      ["d3", "d4", "o1", "o2", "o3", "o4"].map(id),
    );
    const o = await extractOrdinary(db.reader, p, WINDOW);
    assert.deepEqual([o.found, o.excluded], [11, { ask_answer: 1, injected: 2 }]);
    assert.deepEqual(
      o.rows.map((x) => x.text),
      ["a", "b", "c", "d"].map((s) => `Prompt ${s}1`).concat(["a", "b", "c", "d"].map((s) => `Prompt ${s}2`)),
    );
  } finally {
    await db.done();
  }
});

test("the population splits by record and by session from its seed, and its check finds any change and any text", async () => {
  const db = tempDb();
  const dir = tempDir("sphica-conflict-population-");
  try {
    await fixture(db);
    const opts = {
      project: "git:github.com/o/r",
      seed: 7,
      window: WINDOW,
      per: PER,
      evals: [`codex:${uuid("f")}`],
      takenAt: "2026-10-21T00:00:00.000Z",
      dbSha256: digest("db"),
      key: KEY,
    };
    const { population, drawn } = await build(db.reader, opts);
    assert.deepEqual((await build(db.reader, opts)).population, population, "the same seed draws the same");
    assert.deepEqual(checkPopulation(population), []);
    const r = population.records;
    const pool = [...new Set([...r.dont, ...r.rejected.map(([u]) => u)])].sort((a, b) => a - b);
    assert.deepEqual(
      [...r.split.tune, ...r.split.held_out].sort((a, b) => a - b),
      pool,
    );
    for (const side of ["tune", "held_out"] as const) {
      const t = r.targets[side];
      assert.equal(r.split[side].filter((u) => r.dont.includes(u)).length, 2, "dont decisions split evenly");
      assert.ok([...t.dont, ...t.rejected.map(([u]) => u)].every((u) => r.split[side].includes(u)));
      assert.ok(
        t.rejected.every(([u]) => !t.dont.includes(u)),
        "a record is the target of one prompt kind",
      );
    }
    const o = population.ordinary;
    assert.deepEqual(
      o.split.tune.filter((s) => o.split.held_out.includes(s)),
      [],
      "no session on both sides",
    );
    for (const side of ["tune", "held_out"] as const)
      for (const [source] of o.drawn[side]) {
        const session = o.eligible.find(([x]) => x === source)?.[1] ?? -1;
        assert.ok(o.split[side].includes(session));
      }
    assert.ok(drawn.every((d) => d.mac === textMac(KEY, d.text)));
    assert.ok(
      drawn.every((d) => d.mac !== digest(d.text) && d.mac !== textMac("cd".repeat(32), d.text)),
      "without the key, hashing a guessed text does not give the published hash",
    );
    assert.deepEqual(population.eval_sessions, [
      { host: "codex", external: uuid("f"), id: uuid("e"), from: "2026-10-20T00:00:00.000Z" },
    ]);

    const changed = (f: (x: Population) => void) => {
      const x = structuredClone(population);
      f(x);
      return checkPopulation(x);
    };
    assert.deepEqual(
      changed((x) => x.records.split.tune.reverse()),
      ["records.split is not what the seed gives"],
    );
    // The draw from what is left may differ too
    assert.deepEqual(changed((x) => x.ordinary.eligible.pop()).slice(0, 2), [
      "ordinary.eligible does not hash to ordinary.sha256",
      "ordinary.found is not the eligible prompts plus the excluded ones",
    ]);
    assert.match(
      changed((x) => Object.assign(x.ordinary, { text: ["Prompt a1"] })).join("\n"),
      /ordinary\.text: a key outside the allowlist/,
    );
    assert.match(
      changed((x) => {
        (x.eval_sessions[0] as { external: string }).external = "Prompt a1";
      }).join("\n"),
      /eval_sessions\[0\]\.external: a string that is not an id/,
    );
    assert.throws(() => splitRecords(7, r.dont, r.rejected, { dont: 3, rejected: 1 }), /short of 3/);

    const file = path.join(dir, "population.json");
    fs.writeFileSync(file, `${JSON.stringify(population, null, 2)}\n`);
    const run = spawnSync(
      process.execPath,
      [path.join(import.meta.dirname, "..", "evals", "conflict", "sample.ts"), "--check", file],
      { encoding: "utf8", env: { ...tmpEnv(), PATH: process.env.PATH ?? "", HOME: dir, USERPROFILE: dir } },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /as its seed 7 and hashes say; 9 deliverable, 4 dont, 6 rejected options/);

    const keyFile = path.join(dir, "key");
    fs.writeFileSync(keyFile, `${KEY}\n`);
    const sample = (seed: string) =>
      spawnSync(
        process.execPath,
        [
          path.join(import.meta.dirname, "..", "evals", "conflict", "sample.ts"),
          ...["--db", path.join(dir, "absent.db"), "--project", "git:github.com/o/r", "--seed", seed],
          ...[
            "--from",
            "2026-10-01",
            "--to",
            "2026-10-20",
            "--out",
            file,
            "--private",
            path.join(dir, "texts.json"),
          ],
          ...["--key", keyFile],
        ],
        { encoding: "utf8", env: { ...tmpEnv(), PATH: process.env.PATH ?? "", HOME: dir, USERPROFILE: dir } },
      );
    for (const seed of ["nope", "1.5"]) {
      const bad = sample(seed);
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, new RegExp(`--seed ${seed.replace(".", "\\.")} is not a whole number`));
    }

    // Measuring needs the population the labels were made from, taken from the database copy at hand
    const copy = path.join(dir, "copy.db");
    fs.writeFileSync(copy, "a database copy");
    const pinnedFile = path.join(dir, "pinned.json");
    const own = { ...population, db_sha256: fileSha(copy) };
    fs.writeFileSync(pinnedFile, JSON.stringify(own));
    const labels = { population_sha256: digest(own) } as Labels;
    assert.deepEqual(pinned(pinnedFile, labels, copy), own);
    assert.throws(
      () => pinned(pinnedFile, { population_sha256: digest(population) } as Labels, copy),
      /is not the population the labels were made from/,
    );
    fs.writeFileSync(copy, "a changed database");
    assert.throws(
      () => pinned(pinnedFile, labels, copy),
      /is not the database the population was taken from/,
    );
    assert.throws(() => readKey(pinnedFile), /does not hold a key of 64 hex digits/);
    assert.equal(readKey(keyFile), KEY);
  } finally {
    await db.done();
  }
});

test("the overlap tier counts the prompt's content terms the record's words hold", () => {
  const words = "Keep one SQLite file, not Postgres.";
  assert.equal(overlapOf("Move the store over to Postgres", words), "partial");
  assert.equal(overlapOf("Swap SQLite for Postgres", words), "most");
  assert.equal(overlapOf("Use a hosted database server", words), "none");
  assert.equal(overlapOf("SQLite をやめて Postgres に移して", words), "most");
});

/** The fixture's population with three written prompts per target, every one kept but the first (fixed) and the second (dropped) */
async function labelled(
  db: TempDb,
  text = (target: string, kind: string, lang: string) => `${kind} ${lang} for ${target}`,
) {
  await fixture(db);
  const { population, drawn } = await build(db.reader, {
    project: "git:github.com/o/r",
    seed: 7,
    window: WINDOW,
    per: PER,
    evals: [],
    takenAt: "2026-10-21T00:00:00.000Z",
    dbSha256: digest("db"),
    key: KEY,
  });
  const written: Written[] = [];
  for (const side of ["tune", "held_out"] as const) {
    const t = population.records.targets[side];
    for (const target of [...t.dont.map((u) => `u${u}`), ...t.rejected.map(([u, o]) => `u${u}o${o}`)]) {
      const one = (kind: Written["kind"], lang: Written["lang"], override = false): Written => ({
        id: `s-${target}-${kind === "positive" ? "pos" : "hn"}-${lang}`,
        target,
        split: side,
        kind,
        lang,
        override,
        writer: "codex",
        text: text(target, kind, lang),
      });
      written.push(one("positive", "ja", true), one("positive", "en"), one("hard_negative", "en"));
    }
  }
  const first = written[0] as Written;
  const review: Review = {
    by: "cross_model",
    public: false,
    bars: BARS,
    calls: Object.fromEntries(written.map((w) => [w.id, { call: "keep" as const }])),
    conflict: { [first.target]: [999] },
    related: {},
  };
  review.calls[first.id] = { call: "fix", text: "Rule d1 を破って" };
  review.calls[(written[1] as Written).id] = { call: "drop" };
  return { population, drawn, written, review, first };
}

test("the labels cover every target and drawn prompt of the population, with the review call, and refuse text unless published", async () => {
  const db = tempDb();
  try {
    const { population, drawn, written, review, first } = await labelled(db);
    const { labels, texts } = await buildLabels(db.reader, population, written, review, drawn, KEY);
    assert.deepEqual(checkLabels(labels, population), []);
    const fixed = labels.prompts.find((p) => p.id === first.id);
    assert.equal(fixed?.mac, textMac(KEY, "Rule d1 を破って"), "a fixed prompt is labelled by its new text");
    assert.deepEqual(fixed?.conflict.slice(1), [999]);
    assert.equal(texts.find((t) => t.id === first.id)?.text, "Rule d1 を破って");
    assert.equal(labels.prompts.filter((p) => p.group === "ordinary").length, 4);
    assert.ok(labels.prompts.every((p) => p.text === undefined));

    const without = (f: (l: typeof labels) => void) => {
      const x = structuredClone(labels);
      f(x);
      return checkLabels(x, population).join("\n");
    };
    assert.match(
      without((x) => {
        x.prompts = x.prompts.filter((p) => !p.id.endsWith("-hn-en"));
        x.prompts_sha256 = digest(x.prompts.map((p) => [p.id, p.mac]));
      }),
      /has 0 hard negatives, not 1/,
    );
    assert.match(
      without((x) => {
        (x.prompts[0] as Prompt).call = null;
      }),
      /lacks the review call/,
    );
    assert.match(
      without((x) => {
        (x.prompts[0] as Prompt).text = "Rule d1 を破って";
      }),
      /published only when the owner allowed it/,
    );
    assert.match(
      without((x) => {
        const o = x.prompts.find((p) => p.group === "ordinary") as Prompt;
        o.mac = digest("another");
        x.prompts_sha256 = digest(x.prompts.map((p) => [p.id, p.mac]));
      }),
      /is not the drawn (tune|held_out) prompt/,
    );
    assert.match(
      without((x) => x.prompts.reverse()),
      /do not hash to prompts_sha256/,
    );
    assert.match(
      without((x) => {
        (x.prompts.find((p) => p.id.endsWith("-pos-en")) as Prompt).lang = "ja";
      }),
      /is not a (tune|held_out) en positive/,
    );
    assert.match(
      without((x) => {
        const hn = x.prompts.find((p) => p.group === "hard_negative") as Prompt;
        hn.lang = hn.lang === "ja" ? "en" : "ja";
      }),
      /is not a (tune|held_out) hard negative in its language/,
    );
    const published = await buildLabels(
      db.reader,
      population,
      written,
      { ...review, public: true },
      drawn,
      KEY,
    );
    assert.deepEqual(checkLabels(published.labels, population), []);
    assert.equal(published.labels.prompts.find((p) => p.id === first.id)?.text, "Rule d1 を破って");
    assert.ok(
      published.labels.prompts.filter((p) => p.group === "ordinary").every((p) => p.text === undefined),
    );
  } finally {
    await db.done();
  }
});

test("a side is measured from the private texts, assembled with the ordinary labels, and its tune file checked against the labels", async () => {
  const db = tempDb();
  try {
    // A positive against a rejected option names that option, so exact naming (B0) finds it
    const optionOf = (target: string) =>
      String(
        db.owner
          .prepare("select text from unit_option where id = ?")
          .get(Number(/o(\d+)$/.exec(target)?.[1] ?? 0))?.text ?? "",
      );
    const { population, drawn, written, review } = await labelled(db, (target, kind, lang) =>
      kind === "positive" && target.includes("o")
        ? `${lang === "ja" ? "これからは" : "Use"} ${optionOf(target)}`
        : `${kind} ${lang} for ${target}`,
    );
    const { labels, texts } = await buildLabels(db.reader, population, written, review, drawn, KEY);
    const methods = { B0: {}, B1a: { alias: "boundary" as const } };
    const byId = new Map(texts.map((t) => [t.id, t.text]));
    await assert.rejects(
      measure(db.reader, "/r", population.project, labels, new Map([...byId].slice(1)), KEY, "tune", methods),
      /private text is missing/,
    );
    const run = await measure(db.reader, "/r", population.project, labels, byId, KEY, "tune", methods);
    const tune = labels.prompts.filter((p) => p.split === "tune");
    assert.deepEqual(Object.keys(run.results).sort(), tune.map((p) => p.id).sort());
    const named = tune.filter(
      (p) => p.group === "positive" && /^s-u\d+o\d+-/.test(p.id) && p.call !== "drop",
    );
    assert.ok(named.length > 0);
    for (const p of named)
      assert.ok(
        run.results[p.id]?.B0?.shown.some((u) => p.conflict.includes(u)),
        p.id,
      );
    assert.equal(
      run.signals.positives,
      tune.filter((p) => p.group === "positive" && p.call !== "drop").length,
    );
    assert.equal(run.signals.ordinary, 2);

    // An ordinary prompt that shows a record needs that record labelled before the side can be assembled
    const ordinary = tune.find((p) => p.group === "ordinary") as Prompt;
    const unit = named[0]?.conflict[0] as number;
    run.results[ordinary.id] = {
      B0: { candidates: [unit], shown: [unit], cut: [] },
      B1a: { candidates: [], shown: [], cut: [] },
    };
    assert.deepEqual(pairsToLabel(labels, run.results, "tune"), [{ prompt: ordinary.id, unit }]);
    const o = { methods, judged: ["B1a"], measuredAt: "2026-10-21", dbSha256: population.db_sha256 };
    assert.throws(() => assemble(labels, run.results, [], "tune", o), /which has no labels/);
    const pairs: Pair[] = [
      {
        prompt: ordinary.id,
        unit,
        claude: "unrelated",
        codex: "related",
        claude2: "related",
        codex2: "related",
      },
    ];
    const baseline = assemble(labels, run.results, pairs, "tune", o);
    assert.deepEqual(baseline.labelling, { pairs: 1, first_agree: 0, second_agree: 1, undecidable: 0 });
    assert.equal(baseline.prompts.find((p) => p.id === ordinary.id)?.labels[String(unit)], "related");
    const split: Pair[] = [{ ...(pairs[0] as Pair), codex2: "unrelated" }];
    assert.equal(
      assemble(labels, run.results, split, "tune", o).prompts.find((p) => p.id === ordinary.id)?.labels[
        String(unit)
      ],
      "undecidable",
      "still split after each saw the other's reason",
    );

    const t: Tune = { chosen: "B1a", held_out_methods: methods, signals: run.signals, baseline };
    assert.deepEqual(checkTune(t, labels), []);
    assert.deepEqual(checkTune({ ...t, chosen: "B2" }, labels), [
      "the chosen method B2 is not among the held-out methods",
    ]);
    assert.deepEqual(checkTune({ ...t, held_out_methods: { B0: {}, B1a: { alias: "terms" } } }, labels), [
      "held-out method B1a is not one measured on tune",
    ]);
    assert.deepEqual(checkTune(t, { ...labels, bars: { ...labels.bars, minShown: 0.5 } }), [
      "the bars differ from the ones fixed with the labels",
    ]);
    const edited = structuredClone(t);
    (edited.baseline.prompts[0] as Prompt).conflict = [];
    assert.match(
      checkTune(edited, labels).join("\n"),
      /the tune prompts differ from the labels|counted again differs/,
    );

    // A held-out baseline must hold every held-out prompt of the labels, run and judged as fixed on tune
    const held = await measure(db.reader, "/r", population.project, labels, byId, KEY, "held_out", methods);
    const heldPairs: Pair[] = pairsToLabel(labels, held.results, "held_out").map((x) => ({
      ...x,
      claude: "related",
      codex: "related",
      claude2: null,
      codex2: null,
    }));
    const out = assemble(labels, held.results, heldPairs, "held_out", { ...o, judged: ["B1a"] });
    assert.deepEqual(checkHeldOut(out, labels, t), []);
    assert.ok(out.prompts.length > 1);
    for (const prompts of [out.prompts.slice(1), []])
      assert.deepEqual(checkHeldOut({ ...out, prompts }, labels, t), [
        "the held-out prompts differ from the labels",
      ]);
    assert.deepEqual(
      checkHeldOut(out, labels, { ...t, held_out_methods: { B0: {}, B1a: { alias: "terms" } } }),
      ["the methods differ from the ones fixed on tune"],
    );
    assert.deepEqual(checkHeldOut({ ...out, judged: ["B0", "B1a"] }, labels, t), [
      "the judged method is not B1a, the one fixed on tune",
    ]);
    assert.deepEqual(checkHeldOut(out, { ...labels, prompts: labels.prompts.slice(1) }, t), [
      "the labels do not hash to their prompts_sha256",
      ...(labels.prompts[0]?.split === "held_out" ? ["the held-out prompts differ from the labels"] : []),
    ]);
  } finally {
    await db.done();
  }
});
