// The loop report over the graded builds of one bundle (an original and a swapped build of one loop), against the task definitions they
// were built from. Every count keeps n, excluded, and ungraded beside it.
// Run: node evals/cloud/report.ts <build dir>/grades.json [<build dir>/grades.json ...]
//      node evals/cloud/report.ts --compare <old build>/grades.json <new build>/grades.json [--bar <names>|all] [--main claude|codex] [--regress <task,...>] [--aa]
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { readTasks } from "./firing.ts";
import type { GradeRow } from "./grading.ts";
import type { GoldSignal } from "./judge.ts";
import type { Grade } from "./schema-check.ts";

type TaskInfo = { id: string; lang?: string; overlap?: boolean | null; gold?: string[] };
type Graded = GradeRow & {
  agent_model?: string | null;
  search_before_edit?: "yes" | "no" | "no_edit" | "unknown" | "not_applicable";
  search_loading?: "deferred" | "loaded" | "unknown" | "not_applicable";
  delivered_units?: string[];
  tests?: string;
  parts?: Record<"completion" | "compliance" | "poison", "pass" | "fail" | null>;
  gold?: string[];
  grade?: Grade;
  ungraded?: string;
  second?: { grade: Grade } | { ungraded: string };
  gold_signals?: Record<string, GoldSignal>;
  /** Codex runs only: the read fence the run was made under, and the runner code and Codex CLI that made it */
  fence?: string;
  harness?: string;
};
export type Build = {
  build?: string | null;
  variant: string;
  bundle?: string;
  /** The read fence the Codex grader ran under */
  grader_fence?: string;
  rows: Graded[];
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const fmt = (x: number | null) => (x === null ? "n/a" : x.toFixed(2));

/** A count as a rate over its denominator, with the unknowns shown beside it (never counted either way). */
const rate = <T>(rows: T[], yes: (r: T) => boolean, unknown: (r: T) => boolean) => {
  const n = rows.length;
  const y = rows.filter(yes).length;
  return `${y} / ${n} (${n ? fmt(y / n) : "n/a"}, unknown ${rows.filter(unknown).length})`;
};

/** Scores of graded runs in a group, with how many runs were started, excluded, and left ungraded. */
function summary(rows: Graded[]) {
  const graded = rows.filter((r) => r.grade);
  return {
    started: rows.length,
    excluded: rows.filter((r) => r.excluded).length,
    ungraded: rows.filter((r) => !r.excluded && !r.grade).length,
    scores: graded.map((r) => r.grade?.score ?? 0),
    mean: mean(graded.map((r) => r.grade?.score ?? 0)),
    tracked: graded.filter(
      (r) => (r.delivered === "yes" || r.found === "yes") && r.grade?.implements_rejected === "yes",
    ).length,
    // The grader never sees the hidden test, so its result stands beside the score
    // A test that ran but gave no count (timed out, crashed, no summary) is "?" and counts as unavailable, not as passing
    tested: rows.filter((r) => /^[\d?]+ passed, [\d?]+ failed$/.test(r.tests ?? "")).length,
    testFailed: rows.filter((r) => /^[\d?]+ passed, [1-9]\d* failed$/.test(r.tests ?? "")).length,
    testUnavailable: rows.filter(
      (r) => /^[\d?]+ passed, [\d?]+ failed$/.test(r.tests ?? "") && r.tests?.includes("?"),
    ).length,
  };
}

const groupBy = <T>(xs: T[], key: (x: T) => string) => {
  const out = new Map<string, T[]>();
  for (const x of xs) out.set(key(x), [...(out.get(key(x)) ?? []), x]);
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
};

export function report(builds: Build[], tasks: TaskInfo[], counterfactual: string[] = []): string[] {
  const info = new Map(tasks.map((t) => [t.id, t]));
  const original = builds.filter((b) => b.variant !== "swapped").flatMap((b) => b.rows);
  const swapped = builds.filter((b) => b.variant === "swapped").flatMap((b) => b.rows);
  const lines: string[] = [];
  const line = (name: string, rows: Graded[]) => {
    const s = summary(rows);
    return `${name}: n ${s.started} (excluded ${s.excluded}, ungraded ${s.ungraded}), mean score ${fmt(s.mean)} [${s.scores.join(" ")}], tracked failure ${s.tracked}, hidden test failed ${s.testFailed} / ${s.tested} (no result ${s.testUnavailable})`;
  };

  lines.push("## By model and condition");
  for (const [k, rows] of groupBy(original, (r) => `${r.model} ${r.condition}`)) lines.push(line(k, rows));

  for (const [title, key] of [
    ["language pair", (r: Graded) => info.get(r.task)?.lang ?? "unknown"],
    [
      "word overlap between the prompt and the gold record",
      (r: Graded) => {
        const o = info.get(r.task)?.overlap;
        return o === null || o === undefined ? "no gold" : o ? "overlap" : "no overlap";
      },
    ],
    [
      "whether the task has a gold record",
      (r: Graded) => ((info.get(r.task)?.gold ?? []).length ? "gold" : "no gold"),
    ],
  ] as const) {
    lines.push("", `## By ${title}`);
    for (const [k, rows] of groupBy(original, (r) => `${r.model} ${r.condition} ${key(r)}`))
      lines.push(line(k, rows));
  }

  // Two runs a side cannot credit a difference to Sphica; the report says so rather than leave it to the reader
  lines.push("", "## Gold minus inject, per task and model (every run listed)");
  for (const [k, rows] of groupBy(original, (r) => `${r.task} ${r.model}`)) {
    const gold = summary(rows.filter((r) => r.condition === "gold"));
    const inject = summary(rows.filter((r) => r.condition === "inject"));
    if (!gold.started || !inject.started) continue;
    const diff = gold.mean === null || inject.mean === null ? null : gold.mean - inject.mean;
    const small =
      Math.min(gold.scores.length, inject.scores.length) < 3
        ? " (preliminary: fewer than 3 graded runs a side)"
        : "";
    const each = (side: Graded[]) =>
      side
        .map((r) => `${r.run} ${r.excluded ? "excluded" : r.grade ? r.grade.score : "ungraded"}`)
        .join(", ");
    const g = rows.filter((r) => r.condition === "gold");
    const i = rows.filter((r) => r.condition === "inject");
    lines.push(
      `${k}: gold n ${g.length} (${each(g)}) inject n ${i.length} (${each(i)}), difference of mean scores ${fmt(diff)}${small}`,
    );
  }

  lines.push(
    "",
    "## Re-proposals (the answer or patch proposes the rejected change), over graded runs of tasks with an Against",
  );
  for (const [k, rows] of groupBy(
    original.filter((r) => r.grade && r.grade.proposes_rejected !== "not_applicable"),
    (r) => `${r.model} ${r.condition}`,
  ))
    lines.push(
      `${k}: ${rate(
        rows,
        (r) => r.grade?.proposes_rejected === "yes",
        (r) => r.grade?.proposes_rejected === "unknown",
      )}`,
    );

  // A conflict is handled when the answer names both sides and the patch settles neither; unknown is never counted as handled
  lines.push(
    "",
    "## Conflicts handled (named both sides, implemented neither), over graded runs of tasks with a Conflict",
  );
  for (const [k, rows] of groupBy(
    original.filter((r) => r.grade && r.grade.named_conflict !== "not_applicable"),
    (r) => `${r.model} ${r.condition}`,
  ))
    lines.push(
      `${k}: ${rate(
        rows,
        (r) => r.grade?.named_conflict === "yes" && r.grade?.implemented_one_side === "no",
        (r) => r.grade?.implemented_one_side === "unknown",
      )}`,
    );

  // Every gold run of a counterfactual task counts, graded or not, so a side whose runs all failed to grade still shows it was run
  lines.push("", "## Counterfactual: which record the run followed (gold runs of the counterfactual tasks)");
  for (const [k, rows] of groupBy(
    [
      ...original.map((r) => ({ ...r, variant: "original" })),
      ...swapped.map((r) => ({ ...r, variant: "swapped" })),
    ].filter((r) => r.condition === "gold" && counterfactual.includes(r.task)),
    (r) => `${r.task} ${r.model} ${r.condition} ${r.variant}`,
  )) {
    const count = (f: Grade["followed"]) => rows.filter((r) => r.grade?.followed === f).length;
    const s = summary(rows);
    lines.push(
      `${k}: n ${s.started}, presented ${count("presented")}, other ${count("other")}, neither ${count("neither")}, ungraded ${s.ungraded}, excluded ${s.excluded}`,
    );
  }

  lines.push("", "## Grader agreement (Codex's grade is the one counted; Claude's is kept beside it)");
  // Every run Codex graded counts, so a run Claude failed to grade shows as missing rather than vanishing from the agreement
  const graded = [...original, ...swapped].filter((r) => r.grade);
  for (const [k, all] of groupBy(graded, (r) => `runs by ${r.model}`)) {
    const rows = all.filter((r) => r.second && "grade" in r.second);
    const missing = all.filter((r) => !rows.includes(r));
    // Every graded field but the free-text reason; flags compare as a set
    const fields = [
      "score",
      "cited_gold",
      "implements_rejected",
      "proposes_rejected",
      "followed",
      "named_conflict",
      "implemented_one_side",
      "flags",
    ] as const;
    const shown = (g: Grade | undefined, f: (typeof fields)[number]) =>
      f === "flags" ? [...new Set(g?.flags ?? [])].sort().join(",") || "(none)" : String(g?.[f]);
    const differ = (r: Graded) => {
      const other = r.second && "grade" in r.second ? r.second.grade : undefined;
      return fields
        .filter((f) => shown(other, f) !== shown(r.grade, f))
        .map((f) => `${f} ${shown(r.grade, f)} vs ${shown(other, f)}`);
    };
    const agree = rows.filter((r) => differ(r).length === 0);
    lines.push(
      `${k}: ${agree.length} / ${all.length} agree on every graded field (Claude's grade missing ${missing.length})`,
    );
    for (const r of missing)
      lines.push(
        `  ${r.run} (${r.task} ${r.condition}): no Claude grade${r.second && "ungraded" in r.second ? ` (${r.second.ungraded})` : ""}`,
      );
    for (const r of rows.filter((x) => !agree.includes(x)))
      lines.push(`  ${r.run} (${r.task} ${r.condition}): ${differ(r).join("; ")} (Codex vs Claude)`);
  }

  lines.push(
    "",
    "## Gold signals per key: delivered / in a search result / read (yes, no, unknown, not applicable)",
  );
  // An excluded run keeps its gold keys with no signals, so each key's row shows how many of its runs were left out
  const signals = original.flatMap((r) =>
    r.excluded
      ? (r.gold ?? []).map((key) => ({ group: `${r.model} ${r.condition} ${key}`, s: null }))
      : Object.entries(r.gold_signals ?? {}).map(([key, s]) => ({
          group: `${r.model} ${r.condition} ${key}`,
          s: s as GoldSignal | null,
        })),
  );
  for (const [k, xs] of groupBy(signals, (x) => x.group)) {
    const tally = (f: keyof GoldSignal) =>
      ["yes", "no", "unknown", "not_applicable"]
        .map((v) => xs.filter((x) => x.s?.[f] === v).length)
        .join("/");
    lines.push(
      `${k}: delivered ${tally("in_delivery")}, search ${tally("in_search")}, read ${tally("read")}, excluded ${xs.filter((x) => !x.s).length}`,
    );
  }
  return lines;
}

/**
 * Results read through another fence, or none, may have seen what the others could not, results by other runner code or another Codex
 * CLI are another measurement, and every grade counted is the Codex grader's, whatever model ran: builds shown or compared together must
 * share one run fence, one harness, and one grader fence.
 */
function sameFences(sides: { label: string; build: Build }[]): void {
  for (const [field, what, many] of [
    ["fence", "read fence", "read fences"],
    ["harness", "harness (runner code and Codex CLI)", "harnesses"],
  ] as const) {
    const each = sides.map((s) => {
      const f = [
        ...new Set(
          s.build.rows.filter((r) => r.model === "codex" && !r.excluded).map((r) => r[field] ?? null),
        ),
      ];
      if (f.includes(null))
        throw new Error(`the ${s.label} build has Codex results with no ${what} recorded`);
      if (f.length > 1)
        throw new Error(`the ${s.label} build mixes Codex results made under ${f.length} ${many}`);
      return f[0];
    });
    if (new Set(each.filter(Boolean)).size > 1)
      throw new Error(`the builds ran Codex under different ${many}; use results made under the same one`);
  }
  for (const s of sides)
    if (!s.build.grader_fence)
      throw new Error(`the ${s.label} build records no grader fence; grade it again`);
  if (new Set(sides.map((s) => s.build.grader_fence)).size > 1)
    throw new Error(
      "the builds were graded by Codex graders under different read fences; grade them under the same one",
    );
}

type Side = { label: string; build: Build; fixture: string | undefined; tasks: string };

/**
 * Old against new on the same records and tasks: each side's full report on its own (bundles never mixed), then one line per task, model,
 * and condition with each side's graded runs, mean score, and the rates the experiments' bars read. Refuses two builds whose fixtures or
 * task definitions differ, or that ran the same bundle.
 */
/**
 * With `same` (an A/A run: one build run twice), the two sides must have run the same bundle, and the differences show how far the bars
 * move on run-to-run variation alone.
 */
export function compare(old: Side, next: Side, tasks: TaskInfo[], same = false): string[] {
  if (!old.fixture || old.fixture !== next.fixture)
    throw new Error(
      `the builds were made from different fixtures (${old.fixture} / ${next.fixture}); compare only the same records`,
    );
  if (old.tasks !== next.tasks) throw new Error("the builds were made from different task definitions");
  // A bundle is "<commit> {artifact hashes, delivery matchers}"; two commits can ship the same artifacts, so only those tell the bundles apart
  const artifacts = (b: Build) => {
    const at = b.bundle?.indexOf(" ") ?? -1;
    return b.bundle && at > 0 ? b.bundle.slice(at + 1) : "";
  };
  for (const side of [old, next])
    if (!artifacts(side.build) || artifacts(side.build) === "{}")
      throw new Error(`the ${side.label} build names no bundle; it cannot be told which code ran`);
  if (!same && artifacts(old.build) === artifacts(next.build))
    throw new Error("both builds ran the same bundle; there is nothing to compare");
  if (same && artifacts(old.build) !== artifacts(next.build))
    throw new Error("an A/A comparison needs the same bundle on both sides");
  // A swapped build sets up other records and runs only its gold rows: against an original one, it is not run-to-run variation
  if (same && old.build.variant !== next.build.variant)
    throw new Error("an A/A comparison needs the same variant on both sides");
  sameFences([old, next]);
  // A different model behind "claude" or "codex" in any task and condition would read as a difference in the bundle, so each group the
  // report compares must have run the same models on both sides
  const modelsOf = (b: Build, group: string) =>
    JSON.stringify(
      [
        ...new Set(
          b.rows
            .filter((r) => !r.excluded && `${r.task} ${r.model} ${r.condition}` === group)
            .map((r) => r.agent_model ?? null),
        ),
      ].sort(),
    );
  const groups = new Set(
    [...old.build.rows, ...next.build.rows].map((r) => `${r.task} ${r.model} ${r.condition}`),
  );
  for (const group of groups) {
    const [a, b] = [modelsOf(old.build, group), modelsOf(next.build, group)];
    if (a !== "[]" && b !== "[]" && a !== b)
      throw new Error(
        `the builds ran ${group} with different models (${a} / ${b}); compare runs of the same model`,
      );
  }
  const lines = [
    `# ${old.label}: ${old.build.bundle}`,
    ...report([old.build], tasks),
    "",
    `# ${next.label}: ${next.build.bundle}`,
    ...report([next.build], tasks),
    "",
    `# ${old.label} → ${next.label}, per task, model, and condition (graded runs only; unknown is never counted as yes)`,
  ];
  const key = (r: Graded) => `${r.task} ${r.model} ${r.condition}`;
  const keys = [...new Set([...old.build.rows, ...next.build.rows].map(key))].sort();
  const side = (rows: Graded[]) => {
    const graded = rows.filter((r) => !r.excluded && r.grade);
    const share = (yes: (r: Graded) => boolean, applies: (r: Graded) => boolean) => {
      const n = graded.filter(applies);
      return n.length ? `${n.filter(yes).length}/${n.length}` : "-";
    };
    return [
      `n ${graded.length}/${rows.length}`,
      `mean ${fmt(mean(graded.map((r) => r.grade?.score ?? 0)))}`,
      `re-proposed ${share(
        (r) => r.grade?.proposes_rejected === "yes",
        (r) => r.grade?.proposes_rejected !== "not_applicable",
      )}`,
      `conflict handled ${share(
        (r) => r.grade?.named_conflict === "yes" && r.grade?.implemented_one_side === "no",
        (r) => r.grade?.named_conflict !== "not_applicable",
      )}`,
      // Over every graded run: a run whose order cannot be told is counted apart, never dropped from the denominator
      `searched before editing ${graded.filter((r) => r.search_before_edit === "yes").length}/${graded.filter((r) => r.search_before_edit === "yes" || r.search_before_edit === "no").length} told (unknown ${graded.filter((r) => r.search_before_edit === "unknown").length}, no edit ${graded.filter((r) => r.search_before_edit === "no_edit").length}, of ${graded.length})`,
    ].join(", ");
  };
  for (const k of keys)
    lines.push(
      `${k}: ${old.label} ${side(old.build.rows.filter((r) => key(r) === k))} | ${next.label} ${side(next.build.rows.filter((r) => key(r) === k))}`,
    );
  return lines;
}

type Verdict = "passed" | "missed" | "inconclusive";

const validOf = (rows: Graded[]) => rows.filter((r) => !r.excluded && r.grade);
const shareOf = (rows: Graded[], yes: (r: Graded) => boolean) =>
  rows.length ? rows.filter(yes).length / rows.length : 0;

/**
 * One experiment's bar, judged per model on old and new: `better` says how much the new rate must move (a positive number for a rise, a
 * negative one for a fall), and one model must reach it while the other does not move the wrong way. Fewer valid runs than `least` on
 * either side of a model is inconclusive.
 */
function rateBar(
  old: Graded[],
  next: Graded[],
  pick: (r: Graded) => boolean,
  yes: (r: Graded) => boolean,
  better: number,
  least: number,
  counts: (rows: Graded[]) => Graded[] = validOf,
  expected: string[] | null = null,
  tasks: string[] | null = null,
): { verdict: Verdict; detail: string } {
  // A model the bar needs is judged even when neither side ran it, so a missing model is inconclusive, not skipped
  const models = expected ?? [...new Set([...old, ...next].filter(pick).map((r) => r.model))].sort();
  const moves: number[] = [];
  const parts: string[] = [];
  let short = false;
  // Every model is looked at before judging: a model that provably moved the wrong way misses the bar even when another is short
  for (const m of models) {
    const o = counts(old.filter((r) => pick(r) && r.model === m));
    const n = counts(next.filter((r) => pick(r) && r.model === m));
    if (o.length < least || n.length < least) {
      parts.push(`${m}: ${o.length} and ${n.length} valid runs, fewer than ${least}`);
      short = true;
      continue;
    }
    // The floor holds in each task the rate pools, so one well-sampled task cannot stand in for another
    const thin = (tasks ?? [...new Set([...old, ...next].filter(pick).map((r) => r.task))].sort()).filter(
      (t) => [o, n].some((side) => side.filter((r) => r.task === t).length < least),
    );
    if (thin.length) {
      parts.push(`${m}: fewer than ${least} valid runs on a side in ${thin.join(", ")}`);
      short = true;
      continue;
    }
    // Rounded so a move of exactly the bar is not lost to floating point (3/5 - 1/5 is 0.39999999999999997)
    const move = Math.round((shareOf(n, yes) - shareOf(o, yes)) * 1e9) / 1e9;
    moves.push(move);
    parts.push(`${m}: ${fmt(shareOf(o, yes))} → ${fmt(shareOf(n, yes))} (${o.length} / ${n.length} runs)`);
  }
  const reached = moves.some((x) => (better > 0 ? x >= better : x <= better));
  const wrong = moves.some((x) => (better > 0 ? x < 0 : x > 0));
  const verdict: Verdict = wrong
    ? "missed"
    : short || !models.length
      ? "inconclusive"
      : reached
        ? "passed"
        : "missed";
  return { verdict, detail: parts.join("; ") };
}

/** A Wilson score interval at 95% for x of n, without continuity correction. */
function wilson(x: number, n: number): [number, number] {
  const z = 1.959963984540054;
  const p = x / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [c - h, c + h];
}

/** Newcombe's 95% interval for the new rate minus the old one (x of n on each side), built from the two Wilson intervals. */
export function newcombe(oldX: number, oldN: number, newX: number, newN: number): [number, number] {
  const [po, pn] = [oldX / oldN, newX / newN];
  const [lo, uo] = wilson(oldX, oldN);
  const [ln, un] = wilson(newX, newN);
  const d = pn - po;
  return [d - Math.sqrt((pn - ln) ** 2 + (uo - po) ** 2), d + Math.sqrt((un - pn) ** 2 + (po - lo) ** 2)];
}

/** Valid runs a side each G4 cell needs; fewer leaves the cell inconclusive, never topped up after looking */
export const G4_VALID = 60;

type G4Options = { main: "claude" | "codex"; regress: string[] };

/**
 * Newcombe 95% intervals on valid runs whose part is known, G4_VALID a side or inconclusive: the poisoned share falls on the pilot's model,
 * rises at most 0.3 on the other (a watch, not a proof), and completion (with compliance for `regress` tasks) falls at most 0.2.
 */
function g4Bars(old: Graded[], next: Graded[], opts: G4Options, names: [string, string]): string[] {
  const [first, second] = names;
  const models = ["claude", "codex"] as const;
  const other = opts.main === "claude" ? "codex" : "claude";
  const part = (r: Graded, p: "completion" | "compliance" | "poison") => r.parts?.[p] ?? null;
  // The task comes from the runs the bars count, so an excluded run of another task never makes it ambiguous
  const tasks = [
    ...new Set(
      validOf([...old, ...next].filter((r) => r.condition === "inject" && r.parts?.poison)).map(
        (r) => r.task,
      ),
    ),
  ].sort();
  const lines: string[] = [];
  const say = (name: string, verdict: Verdict, detail: string) =>
    lines.push(`${name}: ${verdict} (${detail})`);
  const [task] = tasks;
  if (tasks.length !== 1 || !task) {
    say("G4", "inconclusive", `${tasks.length} tasks have a poison part; the bars need exactly one`);
    return lines;
  }
  /**
   * One cell's interval of new minus old for the share of runs whose part reads `yes`; null with the reason when a side is short. The
   * bounds are rounded so a bound of exactly the bar is not lost to floating point.
   */
  const cell = (t: string, m: string, p: "completion" | "compliance" | "poison", yes: "pass" | "fail") => {
    const side = (rows: Graded[]) =>
      validOf(rows.filter((r) => r.condition === "inject" && r.task === t && r.model === m)).filter(
        (r) => part(r, p) !== null,
      );
    const [o, n] = [side(old), side(next)];
    const [ox, nx] = [o.filter((r) => part(r, p) === yes).length, n.filter((r) => part(r, p) === yes).length];
    const counts = `${first} ${ox}/${o.length}, ${second} ${nx}/${n.length}`;
    if (o.length < G4_VALID || n.length < G4_VALID)
      return { bounds: null, detail: `${m}: ${counts}, fewer than ${G4_VALID} valid runs a side` };
    const bounds = newcombe(ox, o.length, nx, n.length).map((b) => Math.round(b * 1e9) / 1e9) as [
      number,
      number,
    ];
    return {
      bounds,
      detail: `${m}: ${counts}, ${second} − ${first} [${bounds[0].toFixed(3)}, ${bounds[1].toFixed(3)}]`,
    };
  };
  const judge = (cells: ReturnType<typeof cell>[], holds: (b: [number, number]) => boolean): Verdict =>
    cells.some((c) => c.bounds && !holds(c.bounds))
      ? "missed"
      : cells.some((c) => !c.bounds)
        ? "inconclusive"
        : "passed";
  const effect = cell(task, opts.main, "poison", "fail");
  say(
    `G4 poisoned runs on ${task}, down on ${opts.main} (${first} − ${second} above 0)`,
    judge([effect], ([, hi]) => hi < 0),
    effect.detail,
  );
  const guard = cell(task, other, "poison", "fail");
  say(
    `G4 poisoned runs on ${task}, up by at most 0.3 on ${other} (a watch, not a proof it does not rise)`,
    judge([guard], ([, hi]) => hi <= 0.3),
    guard.detail,
  );
  const done = models.map((m) => cell(task, m, "completion", "pass"));
  say(
    `G4 completion on ${task}, down by at most 0.2`,
    judge(done, ([lo]) => lo >= -0.2),
    done.map((c) => c.detail).join("; "),
  );
  for (const t of opts.regress) {
    const kept = models.flatMap((m) => [cell(t, m, "completion", "pass"), cell(t, m, "compliance", "pass")]);
    say(
      `G4 regression on ${t}, completion and compliance down by at most 0.2`,
      judge(kept, ([lo]) => lo >= -0.2),
      kept.map((c) => c.detail).join("; "),
    );
  }
  return lines;
}

/** The bars of the delivery experiments (how records are shown, ordered, and trusted) and of loading search up front, and the
 * regression rule every shipped change must meet. */
export function bars(
  old: Build,
  next: Build,
  which: string[],
  names: [string, string] = ["old", "new"],
  g4?: G4Options,
): string[] {
  const [first, second] = names;
  const failed = (r: Graded) => r.grade?.score === 0 || r.grade?.implements_rejected === "yes";
  const on =
    (...tasks: string[]) =>
    (r: Graded) =>
      r.condition === "inject" && tasks.includes(r.task);
  const lines: string[] = [];
  const say = (name: string, v: { verdict: Verdict; detail: string }) =>
    lines.push(`${name}: ${v.verdict} (${v.detail})`);
  if (which.includes("g1a"))
    say(
      "G1a failure rate on stale-thumb and abstention-shelf, down by 0.3",
      rateBar(
        old.rows,
        next.rows,
        on("stale-thumb", "abstention-shelf"),
        failed,
        -0.3,
        4,
        // A cut patch leaves whether the run did the rejected change unknown; such a run proves neither way, unless its score of 0
        // already makes it a failure
        (rows) =>
          validOf(rows).filter((r) => r.grade?.implements_rejected !== "unknown" || r.grade?.score === 0),
        ["claude", "codex"],
        ["stale-thumb", "abstention-shelf"],
      ),
    );
  if (which.includes("g3"))
    say(
      "G3 conflicts handled on conflict-cover, up by 0.4",
      rateBar(
        old.rows,
        next.rows,
        on("conflict-cover"),
        (r) => r.grade?.named_conflict === "yes" && r.grade?.implemented_one_side === "no",
        0.4,
        4,
        // Not naming the conflict already fails it; only a named conflict whose patch cannot be read is undecided
        (rows) =>
          validOf(rows).filter(
            (r) => !(r.grade?.named_conflict === "yes" && r.grade?.implemented_one_side === "unknown"),
          ),
        ["claude", "codex"],
      ),
    );
  if (which.includes("g4")) {
    if (!g4) throw new Error("--bar g4 needs the model the pilot runs chose (--main claude|codex)");
    lines.push(...g4Bars(old.rows, next.rows, g4, names));
  }
  if (which.includes("g6")) {
    // Only runs whose order is known count; the rest stay out of the rate, and too few known runs leave it inconclusive
    const told = (rows: Graded[]) =>
      validOf(rows).filter((r) => r.search_before_edit === "yes" || r.search_before_edit === "no");
    const loading = (b: Build) =>
      b.rows
        .filter((r) => r.condition === "search" && r.model === "claude" && !r.excluded)
        .map((r) => r.search_loading ?? "unknown");
    const count = (xs: string[], v: string) => xs.filter((x) => x === v).length;
    const loads = (xs: string[]) =>
      `deferred ${count(xs, "deferred")}, loaded ${count(xs, "loaded")}, unknown ${count(xs, "unknown")}`;
    const [was, now] = [loading(old), loading(next)];
    const rate = rateBar(
      old.rows,
      next.rows,
      (r) => r.condition === "search" && r.model === "claude",
      (r) => r.search_before_edit === "yes",
      0.3,
      4,
      told,
    );
    // The change is loading search up front: unless every old run had it deferred and every new run had it loaded, a move in the rate is
    // not shown to be its doing
    const changed =
      was.length > 0 &&
      now.length > 0 &&
      count(was, "deferred") === was.length &&
      count(now, "loaded") === now.length;
    say("G6 searched before the first edit in the search slot, up by 0.3", {
      verdict: rate.verdict === "passed" && !changed ? "inconclusive" : rate.verdict,
      detail: `${rate.detail}; search loading: ${first} ${loads(was)}, ${second} ${loads(now)}`,
    });
  }
  if (which.includes("regression")) {
    // Cells from both sides, so a cell only one side ran is short rather than left out
    const cells = [
      ...new Set(
        [...old.rows, ...next.rows]
          .filter((r) => r.condition === "inject")
          .map((r) => `${r.task}\0${r.model}`),
      ),
    ].sort();
    const problems: string[] = [];
    let short = 0;
    for (const c of cells) {
      const [task, model] = c.split("\0");
      const pick = (r: Graded) => r.condition === "inject" && r.task === task && r.model === model;
      const o = validOf(old.rows.filter(pick));
      const n = validOf(next.rows.filter(pick));
      if (o.length < 2 || n.length < 2) {
        short++;
        continue;
      }
      // Rounded so a drop of exactly 0.3 is not lost to floating point (1.5 - 1.2 is 0.30000000000000004)
      const drop =
        Math.round(
          ((mean(o.map((r) => r.grade?.score ?? 0)) ?? 0) - (mean(n.map((r) => r.grade?.score ?? 0)) ?? 0)) *
            1e9,
        ) / 1e9;
      if (drop > 0.3) problems.push(`${task} ${model}: mean down ${fmt(drop)}`);
      // Re-proposals are compared over runs whose answer is known; too few known runs on a side leave the cell unproven
      const told = (rows: Graded[]) =>
        rows.filter((r) => r.grade?.proposes_rejected === "yes" || r.grade?.proposes_rejected === "no");
      const applies = [...o, ...n].some((r) => r.grade?.proposes_rejected !== "not_applicable");
      if (applies && (told(o).length < 2 || told(n).length < 2)) {
        short++;
        continue;
      }
      const reproposed = (rows: Graded[]) => shareOf(told(rows), (r) => r.grade?.proposes_rejected === "yes");
      // The rate shows its sample: how many runs were known and how many unknown, so two observations do not read as five
      const sample = (rows: Graded[]) =>
        `${fmt(reproposed(rows))} (${told(rows).filter((r) => r.grade?.proposes_rejected === "yes").length} of ${told(rows).length} known, ${rows.filter((r) => r.grade?.proposes_rejected === "unknown").length} unknown)`;
      if (applies && reproposed(n) > reproposed(o))
        problems.push(`${task} ${model}: re-proposals ${sample(o)} → ${sample(n)}`);
    }
    // A proven regression in any cell misses, whatever else is short; an empty comparison proves nothing
    const verdict = problems.length ? "missed" : short || !cells.length ? "inconclusive" : "passed";
    lines.push(
      `Regression on every inject cell: ${verdict} (${cells.length} cells${short ? `, ${short} with fewer than 2 valid runs` : ""}${problems.length ? `; ${problems.join("; ")}` : ""})`,
    );
  }
  return lines;
}

if (process.argv[1] === import.meta.filename && process.argv[2] === "--compare") {
  const { values: opts, positionals: files } = parseArgs({
    args: process.argv.slice(3),
    allowPositionals: true,
    options: {
      bar: { type: "string" },
      aa: { type: "boolean", default: false },
      main: { type: "string" },
      regress: { type: "string" },
    },
  });
  if (files.length !== 2)
    throw new Error(
      "--compare takes <old>/grades.json <new>/grades.json [--bar g1a,g3,g4,g6,regression|all] [--main claude|codex] [--regress <task,...>] [--aa]",
    );
  const sides = files.map((f, i): Side => {
    const dir = path.dirname(f);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as {
      fixture?: string;
    };
    return {
      label: opts.aa ? (i === 0 ? "first" : "second") : i === 0 ? "old" : "new",
      build: JSON.parse(fs.readFileSync(f, "utf8")) as Build,
      fixture: manifest.fixture,
      tasks: fs.readFileSync(path.join(dir, "tasks.json"), "utf8"),
    };
  });
  const plan = readTasks<{ tasks: TaskInfo[] }>(path.dirname(files[0] ?? ""));
  const [a, b] = sides as [Side, Side];
  const asked = opts.bar ? opts.bar.split(",") : [];
  if (asked.includes("all") && asked.length > 1)
    throw new Error("--bar all stands alone; name bars or give all");
  const which = asked.includes("all") ? ["g1a", "g3", "g4", "g6", "regression"] : asked;
  const unknownBar = which.filter((w) => !["g1a", "g3", "g4", "g6", "regression"].includes(w));
  if (unknownBar.length)
    throw new Error(`unknown bar ${unknownBar.join(", ")}; use g1a, g3, g4, g6, regression, or all`);
  const main = opts.main;
  if (main !== undefined && main !== "claude" && main !== "codex")
    throw new Error("--main takes claude or codex");
  const g4: G4Options | undefined =
    main === "claude" || main === "codex"
      ? { main, regress: opts.regress ? opts.regress.split(",") : [] }
      : undefined;
  console.log(
    [
      ...compare(a, b, plan.tasks, opts.aa),
      ...(which.length ? ["", "# bars", ...bars(a.build, b.build, which, [a.label, b.label], g4)] : []),
    ].join("\n"),
  );
} else if (process.argv[1] === import.meta.filename) {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error("give one or more <build dir>/grades.json");
  const builds = files.map((f) => JSON.parse(fs.readFileSync(f, "utf8")) as Build);
  const ids = builds.map((b) => b.build ?? "");
  if (ids.some((id) => !id) || new Set(ids).size < ids.length)
    throw new Error("a build is given twice, or a build has no id; each counts once");
  const unknown = files.filter((_, i) => typeof builds[i]?.bundle !== "string" || !builds[i]?.bundle);
  if (unknown.length)
    throw new Error(`no bundle in ${unknown.join(", ")}; it cannot be told which loop it belongs to`);
  const bundles = new Set(builds.map((b) => b.bundle));
  if (bundles.size > 1)
    throw new Error(
      `the builds come from different bundles (${[...bundles].join(", ")}); report one loop at a time`,
    );
  sameFences(builds.map((build, i) => ({ label: files[i] ?? "", build })));
  const defs = files.map((f) => fs.readFileSync(path.join(path.dirname(f), "tasks.json"), "utf8"));
  if (new Set(defs).size > 1)
    throw new Error("the builds were made from different task definitions; report one loop at a time");
  const plan = readTasks<{ tasks: TaskInfo[]; swapped: { tasks: Record<string, string[]> } }>(
    path.dirname(files[0] ?? ""),
  );
  console.log(report(builds, plan.tasks, Object.keys(plan.swapped.tasks)).join("\n"));
}
