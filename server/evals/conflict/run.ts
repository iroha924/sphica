// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The offline conflict evaluation's command line. --build-labels turns the written prompts, the review's calls on them, and the drawn
// ordinary prompts into the public labels and a private file of the final texts; --check-labels holds the labels to the pinned population.
// --recount counts the public baseline again from its labels and candidate ids alone and fails unless the summary and verdict come out as
// written.
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { openReader, type Reads } from "../../src/db.ts";
import { queryTerms, terms } from "../../src/text.ts";
import {
  type Bars,
  checkLabelsPublic,
  checkPublic,
  decide,
  digest,
  type Labels,
  type Overlap,
  type Prompt,
  summarize,
  type Verdict,
} from "./measure.ts";
import { type Population, textSha } from "./sample.ts";

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

type Ordinary = { id: number; split: Side; sha256: string; text: string };

/** A side's summary and verdict counted again from a public baseline, and which of the two differ from what it says */
export function recount(value: unknown, split: Side = "held_out"): { verdict: Verdict; differs: string[] } {
  checkPublic(value);
  const summary = summarize(value.prompts, Object.keys(value.methods), split);
  const verdict = decide(summary, value.bars);
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
): Promise<{ labels: Labels; texts: { id: string; sha256: string; text: string }[] }> {
  const prompts: Prompt[] = [];
  const texts: { id: string; sha256: string; text: string }[] = [];
  for (const w of written) {
    const call = review.calls[w.id];
    if (!call) throw new Error(`${w.id} has no review call`);
    if (call.call === "fix" && !call.text) throw new Error(`${w.id} is fixed without its new text`);
    const text = call.call === "fix" ? (call.text as string) : w.text;
    const unit = unitOf(w.target);
    const sha256 = textSha(text);
    texts.push({ id: w.id, sha256, text });
    prompts.push({
      id: w.id,
      sha256,
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
    texts.push({ id: `o-${o.id}`, sha256: o.sha256, text: o.text });
    prompts.push({
      id: `o-${o.id}`,
      sha256: o.sha256,
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
    prompts_sha256: digest(prompts.map((p) => [p.id, p.sha256])),
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
  if (l.prompts_sha256 !== digest(l.prompts.map((p) => [p.id, p.sha256])))
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
        else if (p.group !== "positive" || p.split !== side || !p.conflict.includes(unit))
          out.push(`${id} is not a ${side} positive against u${unit}`);
      }
      const hn = ["ja", "en"].map((lang) => `s-${target}-hn-${lang}`).filter((id) => byId.has(id));
      for (const id of hn) wanted.add(id);
      if (hn.length !== 1) out.push(`${target} has ${hn.length} hard negatives, not 1`);
      for (const id of hn) {
        const p = byId.get(id) as Prompt;
        if (p.group !== "hard_negative" || p.split !== side || p.conflict.length)
          out.push(`${id} is not a ${side} hard negative with an empty conflict set`);
      }
      if ([`s-${target}-pos-ja`, `s-${target}-pos-en`].filter((id) => byId.get(id)?.override).length > 1)
        out.push(`${target} has more than one override prompt`);
    }
    for (const [source, sha256] of population.ordinary.drawn[side]) {
      const id = `o-${source}`;
      wanted.add(id);
      const p = byId.get(id);
      if (!p) out.push(`${id} is missing`);
      else if (p.group !== "ordinary" || p.split !== side || p.sha256 !== sha256)
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

const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

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
    },
  });
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
    const need = ["db", "population", "synthetic", "review", "ordinary", "out", "texts"] as const;
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
    "usage: run.ts --recount <baseline.json> | --check-labels <labels.json> | --build-labels ...",
  );
}

if (process.argv[1] && /run\.(ts|js)$/.test(process.argv[1])) await main();
