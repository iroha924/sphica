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

export function report(builds: Build[], tasks: TaskInfo[]): string[] {
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
    lines.push(
      `${k}: gold [${gold.scores.join(" ")}] inject [${inject.scores.join(" ")}], difference ${fmt(diff)}${small}; excluded ${gold.excluded}/${inject.excluded}, ungraded ${gold.ungraded}/${inject.ungraded}`,
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

  lines.push("", "## Counterfactual: which record the run followed");
  for (const [k, rows] of groupBy(
    [
      ...original.map((r) => ({ ...r, variant: "original" })),
      ...swapped.map((r) => ({ ...r, variant: "swapped" })),
    ].filter((r) => r.grade && r.grade.followed !== "not_applicable"),
    (r) => `${r.task} ${r.model} ${r.condition} ${r.variant}`,
  )) {
    const count = (f: Grade["followed"]) => rows.filter((r) => r.grade?.followed === f).length;
    lines.push(`${k}: presented ${count("presented")}, other ${count("other")}, neither ${count("neither")}`);
  }

  lines.push("", "## Grader agreement (Codex's grade is the one counted; Claude's is kept beside it)");
  const both = [...original, ...swapped].filter((r) => r.grade && r.second && "grade" in r.second);
  for (const [k, rows] of groupBy(both, (r) => `runs by ${r.model}`)) {
    const agree = rows.filter((r) => {
      const other = r.second && "grade" in r.second ? r.second.grade : undefined;
      return other?.score === r.grade?.score && other?.implements_rejected === r.grade?.implements_rejected;
    });
    lines.push(`${k}: ${agree.length} / ${rows.length} agree on score and implements_rejected`);
    for (const r of rows.filter((x) => !agree.includes(x))) {
      const other = r.second && "grade" in r.second ? r.second.grade : undefined;
      lines.push(
        `  ${r.run} (${r.task} ${r.condition}): Codex ${r.grade?.score}/${r.grade?.implements_rejected}, Claude ${other?.score}/${other?.implements_rejected}`,
      );
    }
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
  const tasks = (
    JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "tasks.json"), "utf8")) as { tasks: TaskInfo[] }
  ).tasks;
  console.log(report(builds, tasks).join("\n"));
}
