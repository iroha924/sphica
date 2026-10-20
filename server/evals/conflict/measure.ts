// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The measures of the offline conflict evaluation and the verdict rules fixed before labelling, computed from labels and candidate ids
// alone, so the public baseline can be counted again without any prompt text. The public file holds only allowlisted keys and values.
import crypto from "node:crypto";
import type { Method } from "./methods.ts";

type Group = "positive" | "hard_negative" | "ordinary";
type Split = "tune" | "held_out";
type Lang = "ja" | "en";
export type Overlap = "none" | "partial" | "most";
/** A candidate's label on an ordinary prompt: a real conflict, the same topic, neither, or one nobody could settle */
type CandidateLabel = "conflict" | "related" | "unrelated" | "undecidable";

/** What one method gave one prompt: its candidates in order, the ones the delivery would show, and pool records its search limit cut */
export type Result = { candidates: number[]; shown: number[]; cut: number[] };

export type Prompt = {
  id: string;
  /** Of the prompt's text, which stays private unless the owner lets synthetic prompts be published */
  sha256: string;
  group: Group;
  split: Split;
  lang: Lang;
  override: boolean;
  writer: "claude" | "codex" | "owner";
  overlap: Overlap | null;
  /** The review's call on a synthetic prompt, made by the model that did not write it; ordinary prompts are the owner's own and have none */
  call: "keep" | "fix" | "drop" | null;
  undecidable: boolean;
  /** Records the prompt goes against: showing any one of them counts */
  conflict: number[];
  related: number[];
  /** Ordinary prompts: the label of every record a method showed, by unit id */
  labels: Record<string, CandidateLabel>;
  results: Record<string, Result>;
  text?: string;
};

export type Bars = {
  minPositivePerLanguage: number;
  minOrdinary: number;
  maxUndecidable: number;
  minShown: number;
  minGainOverB0: number;
  maxUnrelatedUpper: number;
};

type Rate = { k: number; n: number; rate: number | null; low: number | null; high: number | null };
type Stages = { candidate: Rate; top3: Rate; shown: Rate };
type MethodSummary = {
  positive: {
    all: Stages;
    ja: Stages;
    en: Stages;
    override: Stages;
    plain: Stages;
    overlap: Record<Overlap, Stages>;
  };
  drops: { none: number; limit: number; rank: number; chars: number };
  vs_b0: { gained: number; lost: number };
  ordinary_unrelated: Rate;
  /** The same with records nobody could settle counted as unrelated, over every ordinary prompt: how much the left-out ones could move it */
  ordinary_unrelated_if_undecided: Rate;
  ordinary_conflicts: number;
  hard_negative_shown: Rate;
};
export type Summary = {
  split: Split;
  counts: {
    positive: Record<Lang, { kept: number; dropped: number; undecidable: number }>;
    hard_negative: { kept: number; dropped: number; undecidable: number };
    ordinary: { kept: number; undecidable: number };
  };
  methods: Record<string, MethodSummary>;
};
export type Verdict = { verdict: "advance" | "not_now" | "hold"; reasons: string[]; passing: string[] };

/** Who made the calls on synthetic prompts: the owner, or the model that did not write each prompt */
type Review = "owner" | "cross_model";
/** Ordinary candidates labelled by Claude and Codex apart: how many agreed at first, after each saw the other's reasons, and the rest */
type Labelling = { pairs: number; first_agree: number; second_agree: number; undecidable: number };

export type Baseline = {
  issue: number;
  measured_at: string;
  review: Review;
  labelling: Labelling;
  inputs: { db_sha256: string; prompts_sha256: string; population_sha256: string };
  methods: Record<string, Method>;
  /** The methods the verdict judges; the rest are reported beside them */
  judged: string[];
  bars: Bars;
  synthetic_text_public: boolean;
  prompts: Prompt[];
  summary: Summary;
  verdict: Verdict;
};

const B0 = "B0";
const Z = 1.959964;
const round = (x: number) => Math.round(x * 1e4) / 1e4;

/** The Wilson score interval at 95%: unlike the normal one it stays inside [0, 1] and says something at 0 of n */
export function wilson(k: number, n: number): Rate {
  if (n === 0) return { k, n, rate: null, low: null, high: null };
  const p = k / n;
  const d = 1 + (Z * Z) / n;
  const mid = (p + (Z * Z) / (2 * n)) / d;
  const half = (Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n))) / d;
  return { k, n, rate: round(p), low: round(Math.max(0, mid - half)), high: round(Math.min(1, mid + half)) };
}

/** The stage a positive prompt reached: shown, or why not. The first stage its conflict set reaches decides */
export function reached(p: Prompt, r: Result): "shown" | "chars" | "rank" | "limit" | "none" {
  const hit = (ids: number[]) => ids.some((id) => p.conflict.includes(id));
  if (hit(r.shown)) return "shown";
  if (hit(r.candidates.slice(0, 3))) return "chars";
  if (hit(r.candidates)) return "rank";
  return hit(r.cut) ? "limit" : "none";
}

const counted = (p: Prompt) => p.call !== "drop" && !p.undecidable;

function stages(ps: Prompt[], method: string): Stages {
  const at = ps.map((p) => reached(p, result(p, method)));
  const n = at.length;
  const shown = at.filter((s) => s === "shown").length;
  const top3 = shown + at.filter((s) => s === "chars").length;
  return {
    candidate: wilson(top3 + at.filter((s) => s === "rank").length, n),
    top3: wilson(top3, n),
    shown: wilson(shown, n),
  };
}

function result(p: Prompt, method: string): Result {
  const r = p.results[method];
  if (!r) throw new Error(`prompt ${p.id} has no result for ${method}`);
  return r;
}

/** Whether an ordinary prompt showed a record with one of these labels. Every record it showed must have a label */
function showsAny(p: Prompt, r: Result, labels: CandidateLabel[]): boolean {
  return r.shown.some((id) => {
    const label = p.labels[String(id)];
    if (!label) throw new Error(`ordinary prompt ${p.id} shows record ${id}, which has no label`);
    return labels.includes(label);
  });
}

export function summarize(prompts: Prompt[], methods: string[], split: Split): Summary {
  if (!methods.includes(B0))
    throw new Error(`the methods must include ${B0}, which every other one is held against`);
  const here = prompts.filter((p) => p.split === split);
  for (const p of here)
    if (p.group !== "ordinary" && p.call === null)
      throw new Error(`synthetic prompt ${p.id} has no review call yet; it cannot be measured`);
  // An ordinary prompt with any record nobody could settle is left out of every method's count, so all share one denominator
  const settled = (p: Prompt) => !p.undecidable && !Object.values(p.labels).includes("undecidable");
  const positives = here.filter((p) => p.group === "positive" && counted(p));
  const hard = here.filter((p) => p.group === "hard_negative" && counted(p));
  const ordinary = here.filter((p) => p.group === "ordinary" && settled(p));
  const open = here.filter((p) => p.group === "ordinary" && !p.undecidable);
  const tally = (g: Group, lang?: Lang) => {
    const of = here.filter((p) => p.group === g && (lang === undefined || p.lang === lang));
    return {
      kept: of.filter(counted).length,
      dropped: of.filter((p) => p.call === "drop").length,
      undecidable: of.filter((p) => p.call !== "drop" && p.undecidable).length,
    };
  };
  const out: Summary = {
    split,
    counts: {
      positive: { ja: tally("positive", "ja"), en: tally("positive", "en") },
      hard_negative: tally("hard_negative"),
      ordinary: {
        kept: ordinary.length,
        undecidable: here.filter((p) => p.group === "ordinary" && !settled(p)).length,
      },
    },
    methods: {},
  };
  for (const m of methods) {
    const at = positives.map((p) => reached(p, result(p, m)));
    const base = positives.map((p) => reached(p, result(p, B0)) === "shown");
    out.methods[m] = {
      positive: {
        all: stages(positives, m),
        ja: stages(
          positives.filter((p) => p.lang === "ja"),
          m,
        ),
        en: stages(
          positives.filter((p) => p.lang === "en"),
          m,
        ),
        override: stages(
          positives.filter((p) => p.override),
          m,
        ),
        plain: stages(
          positives.filter((p) => !p.override),
          m,
        ),
        overlap: {
          none: stages(
            positives.filter((p) => p.overlap === "none"),
            m,
          ),
          partial: stages(
            positives.filter((p) => p.overlap === "partial"),
            m,
          ),
          most: stages(
            positives.filter((p) => p.overlap === "most"),
            m,
          ),
        },
      },
      drops: {
        none: at.filter((s) => s === "none").length,
        limit: at.filter((s) => s === "limit").length,
        rank: at.filter((s) => s === "rank").length,
        chars: at.filter((s) => s === "chars").length,
      },
      vs_b0: {
        gained: at.filter((s, i) => s === "shown" && !base[i]).length,
        lost: at.filter((s, i) => s !== "shown" && base[i]).length,
      },
      ordinary_unrelated: wilson(
        ordinary.filter((p) => showsAny(p, result(p, m), ["unrelated"])).length,
        ordinary.length,
      ),
      ordinary_unrelated_if_undecided: wilson(
        open.filter((p) => showsAny(p, result(p, m), ["unrelated", "undecidable"])).length,
        open.length,
      ),
      ordinary_conflicts: ordinary.filter((p) =>
        result(p, m).shown.some((id) => p.labels[String(id)] === "conflict"),
      ).length,
      hard_negative_shown: wilson(hard.filter((p) => result(p, m).shown.length > 0).length, hard.length),
    };
  }
  return out;
}

/**
 * The verdict, holding first: too few prompts or too many nobody could settle say nothing either way. A method advances only when it
 * shows enough conflicts, gains enough over B0, loses none B0 showed, falls behind B0 in neither language, and rarely shows unrelated records.
 * Only the judged methods can advance: the one fixed on tune, so methods reported beside it on held-out cannot pass by chance.
 */
export function decide(s: Summary, bars: Bars, judged: string[]): Verdict {
  const reasons: string[] = [];
  for (const lang of ["ja", "en"] as const) {
    const c = s.counts.positive[lang];
    if (c.kept < bars.minPositivePerLanguage) reasons.push(`too_few_positive_${lang}`);
    if (c.undecidable > bars.maxUndecidable * (c.kept + c.undecidable))
      reasons.push(`undecidable_positive_${lang}`);
  }
  const h = s.counts.hard_negative;
  if (h.undecidable > bars.maxUndecidable * (h.kept + h.undecidable))
    reasons.push("undecidable_hard_negative");
  const o = s.counts.ordinary;
  if (o.kept < bars.minOrdinary) reasons.push("too_few_ordinary");
  if (o.undecidable > bars.maxUndecidable * (o.kept + o.undecidable)) reasons.push("undecidable_ordinary");
  if (reasons.length) return { verdict: "hold", reasons, passing: [] };
  const base = s.methods[B0];
  if (!base) throw new Error(`the summary has no ${B0}`);
  // Compared as counts over the same prompts, so no rounding decides a bar
  const passing = Object.entries(s.methods)
    .filter(([name]) => name !== B0 && judged.includes(name))
    .filter(([, m]) => {
      const { k, n } = m.positive.all.shown;
      const high = m.ordinary_unrelated.high;
      return (
        n > 0 &&
        k >= bars.minShown * n - 1e-9 &&
        k - base.positive.all.shown.k >= bars.minGainOverB0 * n - 1e-9 &&
        m.vs_b0.lost === 0 &&
        m.positive.ja.shown.k >= base.positive.ja.shown.k &&
        m.positive.en.shown.k >= base.positive.en.shown.k &&
        high !== null &&
        high <= bars.maxUnrelatedUpper
      );
    })
    .map(([name]) => name);
  return { verdict: passing.length ? "advance" : "not_now", reasons: [], passing };
}

/** The sha256 of a value's JSON, for pinning lists of ids */
export const digest = (value: unknown): string =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

// The public file's allowlist. Every key not named here, and every string not of its pattern or enum, refuses the write
const HEX = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[a-z0-9_]{1,40}$/;
type Rule = (v: unknown, at: string) => void;
const fail = (at: string, why: string): never => {
  throw new Error(`the public baseline refuses ${at}: ${why}`);
};
const str =
  (re: RegExp): Rule =>
  (v, at) => {
    if (typeof v !== "string" || !re.test(v)) fail(at, "not an allowed value");
  };
const oneOf =
  (...vs: unknown[]): Rule =>
  (v, at) => {
    if (!vs.includes(v)) fail(at, "not an allowed value");
  };
const num: Rule = (v, at) => {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(at, "not a number");
};
const numOrNull: Rule = (v, at) => (v === null ? undefined : num(v, at));
const bool: Rule = (v, at) => {
  if (typeof v !== "boolean") fail(at, "not a boolean");
};
const ids: Rule = (v, at) => {
  if (!Array.isArray(v) || !v.every((x) => Number.isInteger(x) && x > 0))
    fail(at, "not a list of record ids");
};
const list =
  (rule: Rule): Rule =>
  (v, at) => {
    if (!Array.isArray(v)) fail(at, "not a list");
    for (const [i, x] of (v as unknown[]).entries()) rule(x, `${at}[${i}]`);
  };
const obj =
  (shape: Record<string, Rule>, optional: string[] = []): Rule =>
  (v, at) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return fail(at, "not an object");
    for (const k of Object.keys(v)) if (!(k in shape)) fail(`${at}.${k}`, "a key outside the allowlist");
    for (const [k, rule] of Object.entries(shape)) {
      const x = (v as Record<string, unknown>)[k];
      if (x === undefined) {
        if (!optional.includes(k)) fail(`${at}.${k}`, "missing");
      } else rule(x, `${at}.${k}`);
    }
  };
const map =
  (key: RegExp, rule: Rule): Rule =>
  (v, at) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return fail(at, "not an object");
    for (const [k, x] of Object.entries(v)) {
      if (!key.test(k)) fail(`${at}.${k}`, "a key outside the allowlist");
      rule(x, `${at}.${k}`);
    }
  };

const rate = obj({ k: num, n: num, rate: numOrNull, low: numOrNull, high: numOrNull });
const stage = obj({ candidate: rate, top3: rate, shown: rate });
const tally = obj({ kept: num, dropped: num, undecidable: num });
const summaryRule = obj({
  split: oneOf("tune", "held_out"),
  counts: obj({
    positive: obj({ ja: tally, en: tally }),
    hard_negative: tally,
    ordinary: obj({ kept: num, undecidable: num }),
  }),
  methods: map(
    NAME,
    obj({
      positive: obj({
        all: stage,
        ja: stage,
        en: stage,
        override: stage,
        plain: stage,
        overlap: obj({ none: stage, partial: stage, most: stage }),
      }),
      drops: obj({ none: num, limit: num, rank: num, chars: num }),
      vs_b0: obj({ gained: num, lost: num }),
      ordinary_unrelated: rate,
      ordinary_unrelated_if_undecided: rate,
      ordinary_conflicts: num,
      hard_negative_shown: rate,
    }),
  ),
});

function promptRule(textPublic: boolean): Rule {
  const shape = {
    id: str(NAME),
    sha256: str(HEX),
    group: oneOf("positive", "hard_negative", "ordinary"),
    split: oneOf("tune", "held_out"),
    lang: oneOf("ja", "en"),
    override: bool,
    writer: oneOf("claude", "codex", "owner"),
    overlap: oneOf("none", "partial", "most", null),
    call: oneOf("keep", "fix", "drop", null),
    undecidable: bool,
    conflict: ids,
    related: ids,
    labels: map(/^[1-9]\d*$/, oneOf("conflict", "related", "unrelated", "undecidable")),
    results: map(NAME, obj({ candidates: ids, shown: ids, cut: ids })),
    text: (v: unknown, at: string) => {
      if (!textPublic) fail(at, "prompt text is published only when the owner allowed it");
      if (typeof v !== "string" || v.length === 0 || v.length > 2000) fail(at, "not a prompt text");
    },
  };
  const rule = obj(shape, ["text"]);
  return (v, at) => {
    rule(v, at);
    // The owner's own prompts never go out, whatever the flag says
    const p = v as Prompt;
    if (p.group === "ordinary" && p.text !== undefined)
      fail(`${at}.text`, "the owner's own prompts are never published");
    if (p.group === "ordinary" && p.writer !== "owner")
      fail(`${at}.writer`, "an ordinary prompt is the owner's");
  };
}

const barsRule = obj({
  minPositivePerLanguage: num,
  minOrdinary: num,
  maxUndecidable: num,
  minShown: num,
  minGainOverB0: num,
  maxUnrelatedUpper: num,
});

/** The labels fixed before any method runs: every prompt's labels and the bars, published like the baseline */
export type Labels = {
  issue: number;
  review: Review;
  population_sha256: string;
  prompts_sha256: string;
  synthetic_text_public: boolean;
  bars: Bars;
  prompts: Prompt[];
};

/** Throws unless the labels file holds only allowlisted keys and values */
export function checkLabelsPublic(v: unknown): asserts v is Labels {
  const top = v as { synthetic_text_public?: unknown };
  obj({
    issue: num,
    review: oneOf("owner", "cross_model"),
    population_sha256: str(HEX),
    prompts_sha256: str(HEX),
    synthetic_text_public: bool,
    bars: barsRule,
    prompts: list(promptRule(top?.synthetic_text_public === true)),
  })(v, "labels");
}

/** Throws unless the value holds only the public file's keys and values */
export function checkPublic(v: unknown): asserts v is Baseline {
  const top = v as { synthetic_text_public?: unknown };
  obj({
    issue: num,
    measured_at: str(DAY),
    review: oneOf("owner", "cross_model"),
    labelling: obj({ pairs: num, first_agree: num, second_agree: num, undecidable: num }),
    inputs: obj({ db_sha256: str(HEX), prompts_sha256: str(HEX), population_sha256: str(HEX) }),
    methods: map(
      NAME,
      obj(
        { alias: oneOf("boundary", "terms"), search: num, order: oneOf("id", "matches"), minAliases: num },
        ["alias", "search", "order", "minAliases"],
      ),
    ),
    judged: list(str(NAME)),
    bars: barsRule,
    synthetic_text_public: bool,
    prompts: list(promptRule(top?.synthetic_text_public === true)),
    summary: summaryRule,
    verdict: obj({
      verdict: oneOf("advance", "not_now", "hold"),
      reasons: list(str(CODE)),
      passing: list(str(NAME)),
    }),
  })(v, "baseline");
}

/** JSON indented by two spaces, but each prompt on one line: a side holds hundreds of them, each with every method's results */
export function promptLines(v: unknown): string {
  const kept: string[] = [];
  // Each prompt is swapped for a placeholder string, then for its one-line JSON
  const text = JSON.stringify(
    v,
    (key, value) =>
      key === "prompts" && Array.isArray(value)
        ? value.map((p) => `\u0000${kept.push(JSON.stringify(p)) - 1}`)
        : value,
    2,
  );
  return `${text.replace(/"\\u0000(\d+)"/g, (_, n: string) => kept[Number(n)] ?? "")}\n`;
}

/** The public baseline's text, refused when anything in it is outside the allowlist */
export function publicJson(b: Baseline): string {
  checkPublic(b);
  return promptLines(b);
}
