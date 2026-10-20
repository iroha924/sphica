// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The offline conflict evaluation's command line: labels built from the written and drawn prompts, each side measured on the pinned database
// copy, the tune and held-out files assembled, and --recount and --rerun, which count a public baseline again from its ids and measure it
// again from the private texts.
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { openReader, type Reads } from "../../src/db.ts";
import { projectId } from "../../src/project.ts";
import { queryTerms, terms } from "../../src/text.ts";
import {
  type Bars,
  type Baseline,
  checkLabelsPublic,
  checkPublic,
  decide,
  digest,
  type Labels,
  type Overlap,
  type Prompt,
  promptLines,
  publicJson,
  type Result,
  summarize,
  type Verdict,
} from "./measure.ts";
import { candidates, corpus, cutByLimit, display, look, type Method } from "./methods.ts";
import { fileSha, type Population, readKey, textMac } from "./sample.ts";

type Side = "tune" | "held_out";

/** A synthetic prompt as its writer handed it over, kept in the private file */
export type Written = {
  id: string;
  target: string;
  split: Side;
  kind: "positive" | "hard_negative";
  lang: "ja" | "en";
  override: boolean;
  writer: "claude" | "codex";
  text: string;
};

/** The review's call on every synthetic prompt (with the new text for a fix), the bars, and the record sets beyond each target */
export type Review = {
  /** Who made the calls: the owner, or the model that did not write each prompt */
  by: "owner" | "cross_model";
  public: boolean;
  bars: Bars;
  calls: Record<string, { call: "keep" | "fix" | "drop"; text?: string }>;
  conflict: Record<string, number[]>;
  related: Record<string, number[]>;
};

type Ordinary = { id: number; split: Side; mac: string; text: string };

/** A side's summary and verdict counted again from a public baseline, and which of the two differ from what it says */
export function recount(value: unknown, split: Side = "held_out"): { verdict: Verdict; differs: string[] } {
  checkPublic(value);
  const summary = summarize(value.prompts, Object.keys(value.methods), split);
  const verdict = decide(summary, value.bars, value.judged);
  return {
    verdict,
    differs: [
      ...(isDeepStrictEqual(summary, value.summary) ? [] : ["summary"]),
      ...(isDeepStrictEqual(verdict, value.verdict) ? [] : ["verdict"]),
    ],
  };
}

/** How many of the prompt's content terms the record's words hold: none, under half, or half and more */
export function overlapOf(prompt: string, words: string): Overlap {
  const asked = queryTerms(prompt);
  const have = new Set(terms(words));
  const shared = asked.filter((t) => have.has(t)).length;
  return shared === 0 ? "none" : shared * 2 < asked.length ? "partial" : "most";
}

const unitOf = (target: string) => Number(/^u(\d+)/.exec(target)?.[1]);
const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

/** The words a writer was given for a record: its text, reason, scope, and options with their reasons */
async function wordsOf(db: Reads, unit: number): Promise<string> {
  const [u, options] = await Promise.all([
    db.selectFrom("unit").select(["text", "why", "scope_note"]).where("id", "=", unit).executeTakeFirst(),
    db
      .selectFrom("unit_option")
      .select(["text", "why", "reconsider_when"])
      .where("unit_id", "=", unit)
      .execute(),
  ]);
  if (!u) throw new Error(`no record u${unit}`);
  return [u.text, u.why, u.scope_note, ...options.flatMap((o) => [o.text, o.why, o.reconsider_when])]
    .filter(Boolean)
    .join("\n");
}

/** The labels of every prompt, and the final texts for the private file */
export async function buildLabels(
  db: Reads,
  population: Population,
  written: Written[],
  review: Review,
  ordinary: Ordinary[],
  key: string,
): Promise<{ labels: Labels; texts: { id: string; mac: string; text: string }[] }> {
  const prompts: Prompt[] = [];
  const texts: { id: string; mac: string; text: string }[] = [];
  for (const w of written) {
    const call = review.calls[w.id];
    if (!call) throw new Error(`${w.id} has no review call`);
    if (call.call === "fix" && !call.text) throw new Error(`${w.id} is fixed without its new text`);
    const text = call.call === "fix" ? (call.text as string) : w.text;
    const unit = unitOf(w.target);
    const mac = textMac(key, text);
    texts.push({ id: w.id, mac, text });
    prompts.push({
      id: w.id,
      mac,
      group: w.kind,
      split: w.split,
      lang: w.lang,
      override: w.override,
      writer: w.writer,
      overlap: overlapOf(text, await wordsOf(db, unit)),
      call: call.call,
      undecidable: false,
      conflict: w.kind === "positive" ? [unit, ...(review.conflict[w.target] ?? [])] : [],
      related:
        w.kind === "positive"
          ? (review.related[w.target] ?? [])
          : [unit, ...(review.related[w.target] ?? [])],
      labels: {},
      results: {},
      ...(review.public ? { text } : {}),
    });
  }
  for (const o of ordinary) {
    texts.push({ id: `o-${o.id}`, mac: o.mac, text: o.text });
    prompts.push({
      id: `o-${o.id}`,
      mac: o.mac,
      group: "ordinary",
      split: o.split,
      lang: JAPANESE.test(o.text) ? "ja" : "en",
      override: false,
      writer: "owner",
      overlap: null,
      call: null,
      undecidable: false,
      conflict: [],
      related: [],
      labels: {},
      results: {},
    });
  }
  const labels: Labels = {
    issue: 260,
    review: review.by,
    population_sha256: digest(population),
    prompts_sha256: digest(prompts.map((p) => [p.id, p.mac])),
    synthetic_text_public: review.public,
    bars: review.bars,
    prompts,
  };
  const problems = checkLabels(labels, population);
  if (problems.length) throw new Error(problems.join("\n"));
  return { labels, texts };
}

/** Every way the labels miss a prompt the population calls for, or a label every prompt needs */
export function checkLabels(v: unknown, population: Population): string[] {
  try {
    checkLabelsPublic(v);
  } catch (e) {
    return [(e as Error).message];
  }
  const out: string[] = [];
  const l = v;
  if (l.population_sha256 !== digest(population)) out.push("the labels were made from another population");
  if (l.prompts_sha256 !== digest(l.prompts.map((p) => [p.id, p.mac])))
    out.push("the prompts do not hash to prompts_sha256");
  const byId = new Map(l.prompts.map((p) => [p.id, p]));
  if (byId.size !== l.prompts.length) out.push("a prompt id appears twice");
  const wanted = new Set<string>();
  for (const side of ["tune", "held_out"] as const) {
    const t = population.records.targets[side];
    const targets = [...t.dont.map((u) => `u${u}`), ...t.rejected.map(([u, o]) => `u${u}o${o}`)];
    for (const target of targets) {
      const unit = unitOf(target);
      for (const lang of ["ja", "en"]) {
        const id = `s-${target}-pos-${lang}`;
        wanted.add(id);
        const p = byId.get(id);
        if (!p) out.push(`${id} is missing`);
        else if (p.group !== "positive" || p.split !== side || p.lang !== lang || !p.conflict.includes(unit))
          out.push(`${id} is not a ${side} ${lang} positive against u${unit}`);
      }
      const hn = ["ja", "en"].map((lang) => `s-${target}-hn-${lang}`).filter((id) => byId.has(id));
      for (const id of hn) wanted.add(id);
      if (hn.length !== 1) out.push(`${target} has ${hn.length} hard negatives, not 1`);
      for (const id of hn) {
        const p = byId.get(id) as Prompt;
        if (
          p.group !== "hard_negative" ||
          p.split !== side ||
          !id.endsWith(`-${p.lang}`) ||
          p.conflict.length
        )
          out.push(`${id} is not a ${side} hard negative in its language with an empty conflict set`);
      }
      if ([`s-${target}-pos-ja`, `s-${target}-pos-en`].filter((id) => byId.get(id)?.override).length > 1)
        out.push(`${target} has more than one override prompt`);
    }
    for (const [source, mac] of population.ordinary.drawn[side]) {
      const id = `o-${source}`;
      wanted.add(id);
      const p = byId.get(id);
      if (!p) out.push(`${id} is missing`);
      else if (p.group !== "ordinary" || p.split !== side || p.mac !== mac)
        out.push(`${id} is not the drawn ${side} prompt`);
    }
  }
  for (const p of l.prompts) {
    if (!wanted.has(p.id)) out.push(`${p.id} is not a prompt the population calls for`);
    const synthetic = p.group !== "ordinary";
    if (synthetic && (p.call === null || p.overlap === null || p.writer === "owner"))
      out.push(`${p.id} lacks the review call, its overlap, or its writer`);
    if (synthetic && p.override && p.group !== "positive")
      out.push(`${p.id} is an override but not a positive`);
    if (!synthetic && (p.call !== null || p.overlap !== null || p.override))
      out.push(`${p.id} is the owner's own prompt and takes no call, overlap, or override`);
  }
  return out;
}

/** How often each signal brought up a record: positives whose conflict set it reached, and ordinary prompts where it fired at all */
type Signals = {
  positives: number;
  ordinary: number;
  reached: Record<string, number>;
  fired: Record<string, number>;
};

/**
 * Every method's candidates, shown records, and records cut by the search limit, for each prompt of one side, read from the private texts
 * (each held to its pinned hash); and how often each signal fired, to compare them one by one.
 */
export async function measure(
  db: Reads,
  root: string,
  project: string,
  labels: Labels,
  texts: Map<string, string>,
  key: string,
  split: Side,
  methods: Record<string, Method>,
): Promise<{ results: Record<string, Record<string, Result>>; signals: Signals }> {
  const pid = await projectId(db, project);
  if (pid === null) throw new Error(`no project ${project}`);
  const c = await corpus(db, pid, root);
  const deliverable = new Set(c.units.map((u) => u.id));
  const results: Record<string, Record<string, Result>> = {};
  const signals: Signals = { positives: 0, ordinary: 0, reached: {}, fired: {} };
  const add = (to: Record<string, number>, ss: Set<string>) => {
    for (const s of ss) to[s] = (to[s] ?? 0) + 1;
  };
  for (const p of labels.prompts.filter((x) => x.split === split)) {
    const text = texts.get(p.id);
    if (text === undefined || textMac(key, text) !== p.mac)
      throw new Error(`${p.id}: its private text is missing or does not hash to its label`);
    const l = await look(db, c, text);
    results[p.id] = Object.fromEntries(
      Object.entries(methods).map(([name, m]): [string, Result] => {
        const cands = candidates(c, l, m);
        return [
          name,
          {
            candidates: cands.map((x) => x.u.id),
            shown: display(cands, c.ai).shown,
            cut: [...cutByLimit(c, l, m)],
          },
        ];
      }),
    );
    if (p.group === "positive" && p.call !== "drop") {
      signals.positives += 1;
      add(signals.reached, new Set(p.conflict.flatMap((u): string[] => [...(l.signals.get(u) ?? [])])));
    }
    if (p.group === "ordinary") {
      signals.ordinary += 1;
      add(
        signals.fired,
        new Set([...l.signals].filter(([u]) => deliverable.has(u)).flatMap(([, ss]): string[] => [...ss])),
      );
    }
  }
  return { results, signals };
}

type PairLabel = "conflict" | "related" | "unrelated";
/** One record an ordinary prompt showed, labelled by Claude and Codex apart, then again after each saw the other's label and reason */
export type Pair = {
  prompt: string;
  unit: number;
  claude: PairLabel;
  codex: PairLabel;
  claude2: PairLabel | null;
  codex2: PairLabel | null;
};

/** A pair's label: the first one both gave, or the one both gave after seeing each other's, or nobody could settle it */
const settle = (x: Pair) =>
  x.claude === x.codex ? x.claude : x.claude2 !== null && x.claude2 === x.codex2 ? x.claude2 : "undecidable";

/** The records the ordinary prompts of a side showed under any method, each once: what Claude and Codex label */
export function pairsToLabel(labels: Labels, results: Record<string, Record<string, Result>>, split: Side) {
  const out: { prompt: string; unit: number }[] = [];
  for (const p of labels.prompts.filter((x) => x.split === split && x.group === "ordinary"))
    for (const unit of new Set(Object.values(results[p.id] ?? {}).flatMap((r) => r.shown)))
      out.push({ prompt: p.id, unit });
  return out;
}

/** Only a positive's candidates and cut records are counted (how far its conflict set got); other prompts count what was shown */
const kept = (p: Prompt, r: Result): Result =>
  p.group === "positive" ? r : { candidates: [], shown: r.shown, cut: [] };

/** The public file of one side: the side's prompts with their results and ordinary labels, its summary, and the verdict by the bars */
export function assemble(
  labels: Labels,
  results: Record<string, Record<string, Result>>,
  pairs: Pair[],
  split: Side,
  o: { methods: Record<string, Method>; judged: string[]; measuredAt: string; dbSha256: string },
): Baseline {
  const wanted = pairsToLabel(labels, results, split);
  const got = new Map(pairs.map((x) => [`${x.prompt} ${x.unit}`, x]));
  for (const w of wanted)
    if (!got.has(`${w.prompt} ${w.unit}`))
      throw new Error(`${w.prompt} showed u${w.unit}, which has no labels`);
  if (pairs.length !== wanted.length)
    throw new Error("the pairs name a record no ordinary prompt of this side showed");
  const prompts = labels.prompts
    .filter((p) => p.split === split)
    .map((p): Prompt => {
      const r = results[p.id];
      if (!r) throw new Error(`${p.id} has no results`);
      const mine = pairs.filter((x) => x.prompt === p.id);
      return {
        ...p,
        labels: Object.fromEntries(mine.map((x) => [String(x.unit), settle(x)])),
        results: Object.fromEntries(Object.keys(o.methods).map((m) => [m, kept(p, r[m] as Result)])),
      };
    });
  const summary = summarize(prompts, Object.keys(o.methods), split);
  return {
    issue: 260,
    measured_at: o.measuredAt,
    review: labels.review,
    labelling: {
      pairs: pairs.length,
      first_agree: pairs.filter((x) => x.claude === x.codex).length,
      second_agree: pairs.filter((x) => x.claude !== x.codex && settle(x) !== "undecidable").length,
      undecidable: pairs.filter((x) => settle(x) === "undecidable").length,
    },
    inputs: {
      db_sha256: o.dbSha256,
      prompts_sha256: labels.prompts_sha256,
      population_sha256: labels.population_sha256,
    },
    methods: o.methods,
    bars: labels.bars,
    synthetic_text_public: labels.synthetic_text_public,
    prompts,
    summary,
    judged: o.judged,
    verdict: decide(summary, labels.bars, o.judged),
  };
}

/** The tune side's file: its measured side, the method chosen there, the methods held-out will run, and the signals compared */
export type Tune = {
  chosen: string;
  held_out_methods: Record<string, Method>;
  signals: Signals;
  baseline: Baseline;
};

/** Every way the tune file is not counted from the labels, or names a choice held-out cannot run */
export function checkTune(v: Tune, labels: Labels): string[] {
  const out: string[] = [];
  try {
    const { differs } = recount(v.baseline, "tune");
    for (const d of differs) out.push(`the tune ${d} counted again differs from what it says`);
  } catch (e) {
    return [(e as Error).message];
  }
  const b = v.baseline;
  if (b.summary.split !== "tune") out.push("the measured side is not tune");
  if (!isDeepStrictEqual(b.bars, labels.bars))
    out.push("the bars differ from the ones fixed with the labels");
  if (b.inputs.prompts_sha256 !== labels.prompts_sha256)
    out.push("the tune side was measured on other labels");
  const strip = (p: Prompt) => ({ ...p, labels: {}, results: {} });
  const fixed = labels.prompts.filter((p) => p.split === "tune");
  if (!isDeepStrictEqual(b.prompts.map(strip), fixed.map(strip)))
    out.push("the tune prompts differ from the labels");
  if (!(v.chosen in v.held_out_methods))
    out.push(`the chosen method ${v.chosen} is not among the held-out methods`);
  if (!("B0" in v.held_out_methods)) out.push("held-out does not run B0");
  for (const [name, m] of Object.entries(v.held_out_methods))
    if (!isDeepStrictEqual(m, b.methods[name]))
      out.push(`held-out method ${name} is not one measured on tune`);
  return out;
}

/** Every way a held-out baseline is not the whole held-out side of the labels, run and judged as fixed on tune */
export function checkHeldOut(b: Baseline, labels: Labels, tune: Tune): string[] {
  const out: string[] = [];
  if (labels.prompts_sha256 !== digest(labels.prompts.map((p) => [p.id, p.mac])))
    out.push("the labels do not hash to their prompts_sha256");
  if (b.inputs.prompts_sha256 !== labels.prompts_sha256)
    out.push("the baseline was measured on other labels");
  if (b.summary.split !== "held_out") out.push("the measured side is not held-out");
  const strip = (p: Prompt) => ({ ...p, labels: {}, results: {} });
  const fixed = labels.prompts.filter((p) => p.split === "held_out");
  if (!isDeepStrictEqual(b.prompts.map(strip), fixed.map(strip)))
    out.push("the held-out prompts differ from the labels");
  if (!isDeepStrictEqual(b.bars, labels.bars))
    out.push("the bars differ from the ones fixed with the labels");
  if (!isDeepStrictEqual(b.methods, tune.held_out_methods))
    out.push("the methods differ from the ones fixed on tune");
  if (!isDeepStrictEqual(b.judged, [tune.chosen]))
    out.push(`the judged method is not ${tune.chosen}, the one fixed on tune`);
  return out;
}

const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

/** The population the labels were made from, read from its file, and only when the database copy is the one it was taken from */
export function pinned(population: string, labels: Labels, db: string): Population {
  const p = read(population) as Population;
  if (digest(p) !== labels.population_sha256)
    throw new Error(`${population} is not the population the labels were made from`);
  if (fileSha(db) !== p.db_sha256) throw new Error(`${db} is not the database the population was taken from`);
  return p;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      recount: { type: "string" },
      "build-labels": { type: "boolean" },
      "check-labels": { type: "string" },
      db: { type: "string" },
      population: { type: "string" },
      synthetic: { type: "string" },
      review: { type: "string" },
      ordinary: { type: "string" },
      out: { type: "string" },
      texts: { type: "string" },
      measure: { type: "boolean" },
      root: { type: "string" },
      labels: { type: "string" },
      split: { type: "string" },
      methods: { type: "string" },
      tune: { type: "boolean" },
      "held-out": { type: "boolean" },
      "tune-file": { type: "string" },
      "check-tune": { type: "string" },
      run: { type: "string" },
      pairs: { type: "string" },
      chosen: { type: "string" },
      "held-out-methods": { type: "string" },
      "measured-at": { type: "string" },
      baseline: { type: "string" },
      rerun: { type: "boolean" },
      prompts: { type: "string" },
      key: { type: "string" },
    },
  });
  const need = (mode: string, keys: (keyof typeof values)[]) => {
    const missing = keys.filter((k) => !values[k]);
    if (missing.length) throw new Error(`${mode} needs ${missing.map((k) => `--${String(k)}`).join(", ")}`);
  };
  const root = values.root ?? path.resolve(import.meta.dirname, "..", "..", "..");
  const textsOf = (file: string) =>
    new Map((read(file).prompts as { id: string; text: string }[]).map((t) => [t.id, t.text]));
  if (values.measure) {
    need("--measure", ["db", "population", "labels", "texts", "key", "split", "methods", "out"]);
    const split = values.split as Side;
    if (split !== "tune" && split !== "held_out") throw new Error("--split is tune or held_out");
    const methods = read(values.methods as string) as Record<string, Method>;
    const labels = read(values.labels as string) as Labels;
    const population = pinned(values.population as string, labels, values.db as string);
    const db = openReader(values.db as string);
    try {
      const run = await measure(
        db,
        root,
        population.project,
        labels,
        textsOf(values.texts as string),
        readKey(values.key as string),
        split,
        methods,
      );
      fs.writeFileSync(values.out as string, `${JSON.stringify({ split, methods, ...run }, null, 2)}\n`);
      console.log(
        `${values.out}: ${Object.keys(run.results).length} ${split} prompts measured; ${pairsToLabel(labels, run.results, split).length} records shown on ordinary prompts to label`,
      );
    } finally {
      await db.destroy();
    }
    return;
  }
  if (values["check-tune"]) {
    const file = values["check-tune"];
    const problems = checkTune(
      read(file),
      read(values.labels ?? path.join(path.dirname(file), "labels.json")),
    );
    if (problems.length) {
      for (const p of problems) console.error(p);
      process.exitCode = 1;
      return;
    }
    const t = read(file) as Tune;
    console.log(
      `${file}: counted again as written; chosen ${t.chosen}; held-out runs ${Object.keys(t.held_out_methods).join(", ")}; bars as fixed with the labels; ${t.baseline.labelling.pairs} ordinary records labelled (${t.baseline.labelling.first_agree} agreed at first, ${t.baseline.labelling.second_agree} after review, ${t.baseline.labelling.undecidable} undecidable)`,
    );
    return;
  }
  if (values.tune || values["held-out"]) {
    const mode = values.tune ? "--tune" : "--held-out";
    need(mode, ["labels", "run", "pairs", "measured-at", "population", "out"]);
    const labels = read(values.labels as string) as Labels;
    const run = read(values.run as string) as {
      split: Side;
      methods: Record<string, Method>;
      results: Record<string, Record<string, Result>>;
      signals: Signals;
    };
    if (!values.tune) need(mode, ["tune-file"]);
    const tune = values.tune ? null : (read(values["tune-file"] as string) as Tune);
    const methods = tune ? tune.held_out_methods : run.methods;
    if (run.split !== (tune ? "held_out" : "tune"))
      throw new Error(`${mode} takes a ${tune ? "held_out" : "tune"} run`);
    if (tune && !isDeepStrictEqual(run.methods, methods))
      throw new Error("the held-out run was measured with other methods than the ones fixed on tune");
    const baseline = assemble(labels, run.results, read(values.pairs as string).pairs, run.split, {
      methods,
      // Tune compares every method; held-out judges only the one fixed there
      judged: tune ? [tune.chosen] : Object.keys(methods).filter((m) => m !== "B0"),
      measuredAt: values["measured-at"] as string,
      dbSha256: (read(values.population as string) as Population).db_sha256,
    });
    if (tune) {
      const problems = checkHeldOut(baseline, labels, tune);
      if (problems.length) throw new Error(problems.join("\n"));
      fs.writeFileSync(values.out as string, publicJson(baseline));
      console.log(`${values.out}: ${baseline.verdict.verdict} ${baseline.verdict.passing.join(", ")}`);
    } else {
      need(mode, ["chosen", "held-out-methods"]);
      const t: Tune = {
        chosen: values.chosen as string,
        held_out_methods: read(values["held-out-methods"] as string),
        signals: run.signals,
        baseline,
      };
      const problems = checkTune(t, labels);
      if (problems.length) throw new Error(problems.join("\n"));
      fs.writeFileSync(values.out as string, promptLines(t));
      console.log(`${values.out}: written`);
    }
    return;
  }
  if (values.rerun) {
    need("--rerun", ["db", "prompts", "key", "baseline"]);
    const b = read(values.baseline as string);
    checkPublic(b);
    const dir = path.dirname(values.baseline as string);
    const labels = read(values.labels ?? path.join(dir, "labels.json")) as Labels;
    const problems = checkHeldOut(b, labels, read(values["tune-file"] ?? path.join(dir, "tune.json")));
    if (problems.length) throw new Error(problems.join("\n"));
    const population = pinned(
      values.population ?? path.join(dir, "population.json"),
      labels,
      values.db as string,
    );
    if (population.db_sha256 !== b.inputs.db_sha256)
      throw new Error(`${values.db} is not the database the baseline was measured on`);
    const db = openReader(values.db as string);
    try {
      const run = await measure(
        db,
        root,
        population.project,
        labels,
        textsOf(values.prompts as string),
        readKey(values.key as string),
        "held_out",
        b.methods,
      );
      const differ = b.prompts.filter((p) => {
        const again = run.results[p.id] ?? {};
        return Object.keys(b.methods).some(
          (m) => !isDeepStrictEqual(kept(p, again[m] as Result), p.results[m]),
        );
      });
      if (differ.length) {
        console.error(
          `${differ.length} held-out prompts give other candidates now: ${differ.map((p) => p.id).join(", ")}`,
        );
        process.exitCode = 1;
        return;
      }
      console.log(
        `${values.baseline}: the database and ${b.prompts.length} held-out texts hash as pinned, and every method gives the same candidates and shown records`,
      );
    } finally {
      await db.destroy();
    }
    return;
  }
  if (values.recount) {
    const { verdict, differs } = recount(read(values.recount));
    if (differs.length) {
      console.error(`${values.recount}: the ${differs.join(" and ")} counted again differ from what it says`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `${values.recount}: ${verdict.verdict}${verdict.passing.length ? ` (${verdict.passing.join(", ")})` : ""}${verdict.reasons.length ? ` [${verdict.reasons.join(", ")}]` : ""}, as written`,
    );
    return;
  }
  if (values["check-labels"]) {
    const file = values["check-labels"];
    const population = read(
      values.population ?? path.join(path.dirname(file), "population.json"),
    ) as Population;
    const labels = read(file);
    const problems = checkLabels(labels, population);
    if (problems.length) {
      for (const p of problems) console.error(p);
      process.exitCode = 1;
      return;
    }
    const ps = (labels as Labels).prompts;
    const n = (f: (p: Prompt) => boolean) => ps.filter(f).length;
    const kept = (p: Prompt) => p.call !== "drop";
    console.log(
      `${file}: every prompt the population calls for, labelled; positives ${n((p) => p.group === "positive" && kept(p))} kept and ${n((p) => p.group === "positive" && !kept(p))} dropped, hard negatives ${n((p) => p.group === "hard_negative" && kept(p))} kept and ${n((p) => p.group === "hard_negative" && !kept(p))} dropped, ordinary ${n((p) => p.group === "ordinary")}; text ${(labels as Labels).synthetic_text_public ? "published" : "private"}`,
    );
    return;
  }
  if (values["build-labels"]) {
    const need = ["db", "population", "synthetic", "review", "ordinary", "out", "texts", "key"] as const;
    const missing = need.filter((k) => !values[k]);
    if (missing.length) throw new Error(`--build-labels needs ${missing.map((k) => `--${k}`).join(", ")}`);
    const db = openReader(values.db as string);
    try {
      const { labels, texts } = await buildLabels(
        db,
        read(values.population as string),
        read(values.synthetic as string).prompts,
        read(values.review as string),
        read(values.ordinary as string).ordinary,
        readKey(values.key as string),
      );
      fs.writeFileSync(values.out as string, `${JSON.stringify(labels, null, 2)}\n`);
      fs.writeFileSync(values.texts as string, `${JSON.stringify({ prompts: texts }, null, 2)}\n`);
      console.log(`${values.out}: ${labels.prompts.length} prompts labelled; their texts in ${values.texts}`);
    } finally {
      await db.destroy();
    }
    return;
  }
  throw new Error(
    "usage: run.ts --recount <baseline.json> | --check-labels <labels.json> | --check-tune <tune.json> | --build-labels | --measure | --tune | --held-out | --rerun ...",
  );
}

if (process.argv[1] && /run\.(ts|js)$/.test(process.argv[1])) await main();
