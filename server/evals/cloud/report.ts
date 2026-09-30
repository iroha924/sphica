// The loop report over one or more graded builds (an original and a swapped build of one loop): the table by model and condition, the
// same split by language pair, word overlap, and whether the task has a gold record; gold minus inject per task and model with every run;
// re-proposals; the counterfactual; grader agreement; and each gold key's signals. Counts keep n, excluded, and ungraded beside them.
// Run: node evals/cloud/report.ts <build dir>/grades.json [<build dir>/grades.json ...]
import fs from "node:fs";
import path from "node:path";
import type { GradeRow } from "./grading.ts";
import type { GoldSignal } from "./judge.ts";
import type { Grade } from "./schema-check.ts";

type TaskInfo = { id: string; lang?: string; overlap?: boolean | null; gold?: string[] };
type Graded = GradeRow & {
  grade?: Grade;
  ungraded?: string;
  second?: { grade: Grade } | { ungraded: string };
  gold_signals?: Record<string, GoldSignal>;
};
export type Build = { variant: string; rows: Graded[] };

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const fmt = (x: number | null) => (x === null ? "n/a" : x.toFixed(2));

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
    return `${name}: n ${s.started} (excluded ${s.excluded}, ungraded ${s.ungraded}), mean score ${fmt(s.mean)} [${s.scores.join(" ")}], tracked failure ${s.tracked}`;
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
    lines.push(`${k}: ${rows.filter((r) => r.grade?.proposes_rejected === "yes").length} / ${rows.length}`);

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
  const both = [...original, ...swapped].filter((r) => r.grade && r.second && "grade" in r.second);
  for (const [k, rows] of groupBy(both, (r) => `runs by ${r.model}`)) {
    const fields = ["score", "implements_rejected", "proposes_rejected", "followed"] as const;
    const differ = (r: Graded) => {
      const other = r.second && "grade" in r.second ? r.second.grade : undefined;
      return fields
        .filter((f) => other?.[f] !== r.grade?.[f])
        .map((f) => `${f} ${r.grade?.[f]} vs ${other?.[f]}`);
    };
    const agree = rows.filter((r) => differ(r).length === 0);
    lines.push(`${k}: ${agree.length} / ${rows.length} agree on every graded field`);
    for (const r of rows.filter((x) => !agree.includes(x)))
      lines.push(`  ${r.run} (${r.task} ${r.condition}): ${differ(r).join("; ")} (Codex vs Claude)`);
  }

  lines.push("", "## Gold signals per key: delivered / in a search result / read (yes, no, unknown)");
  const signals = original
    .filter((r) => !r.excluded)
    .flatMap((r) =>
      Object.entries(r.gold_signals ?? {}).map(([key, s]) => ({
        group: `${r.model} ${r.condition} ${key}`,
        s,
      })),
    );
  for (const [k, xs] of groupBy(signals, (x) => x.group)) {
    const tally = (f: keyof GoldSignal) =>
      ["yes", "no", "unknown"].map((v) => xs.filter((x) => x.s[f] === v).length).join("/");
    lines.push(
      `${k}: delivered ${tally("in_delivery")}, search ${tally("in_search")}, read ${tally("read")}`,
    );
  }
  return lines;
}

if (process.argv[1] === import.meta.filename) {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error("give one or more <build dir>/grades.json");
  const builds = files.map((f) => JSON.parse(fs.readFileSync(f, "utf8")) as Build);
  const plan = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "tasks.json"), "utf8")) as {
    tasks: TaskInfo[];
    swapped: { tasks: Record<string, string[]> };
  };
  console.log(report(builds, plan.tasks, Object.keys(plan.swapped.tasks)).join("\n"));
}
