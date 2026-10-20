// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The offline conflict evaluation's measures and verdict, computed from labels and candidate ids alone; the public baseline's allowlist;
// and --recount, which counts a public baseline again and fails when it does not come out as written.
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
  type Prompt,
  publicJson,
  reached,
  summarize,
  wilson,
} from "../evals/conflict/measure.ts";
import { recount } from "../evals/conflict/run.ts";
import { tempDir, tmpEnv } from "./temp-dir.ts";

const METHODS = ["B0", "B1b", "B2"];
const none = { candidates: [], shown: [], cut: [] };
let n = 0;

/** A held-out prompt every method gave nothing, with what the test changes */
function prompt(over: Partial<Prompt> = {}): Prompt {
  n += 1;
  return {
    id: `p${n}`,
    sha256: digest(`p${n}`),
    group: "positive",
    split: "held_out",
    lang: "ja",
    override: false,
    writer: "codex",
    overlap: "none",
    owner: "keep",
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
  prompt({ group: "ordinary", writer: "owner", owner: null, conflict: [], overlap: null, ...over });

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
    prompt({ owner: "drop", results: { B0: none, B1b: shows([7]), B2: shows([7]) } }),
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
    [b2?.ordinary_unrelated.k, b2?.ordinary_conflicts],
    [0, 1],
    "a real conflict is not counted unrelated",
  );
  assert.deepEqual(b1?.hard_negative_shown, wilson(1, 1));

  assert.throws(
    () => summarize([ordinary({ results: { B0: shows([9]), B1b: none, B2: none } })], METHODS, "held_out"),
    /shows record 9, which has no label/,
  );
  assert.throws(() => summarize([prompt({ owner: null })], METHODS, "held_out"), /no owner's call yet/);
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
  const verdict = (ps: Prompt[], bars = BARS) => decide(summarize(ps, METHODS, "held_out"), bars);
  assert.deepEqual(verdict(passing()), { verdict: "advance", reasons: [], passing: ["B1b"] });
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
    verdict: decide(summary, BARS),
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
  assert.throws(() => publicJson(one({ sha256: "Postgres" })), /prompts\[0\]\.sha256/);
  assert.throws(
    () => publicJson({ ...b, verdict: { ...b.verdict, reasons: ["the owner wants Postgres"] } }),
    /verdict\.reasons\[0\]/,
  );
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
