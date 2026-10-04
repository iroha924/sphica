// The loop report over the graded builds of one bundle (an original and a swapped build of one loop), against the task definitions they
// were built from. Every count keeps n, excluded, and ungraded beside it.
// Run: node evals/cloud/report.ts <build dir>/grades.json [<build dir>/grades.json ...]
//      node evals/cloud/report.ts --compare <old build>/grades.json <new build>/grades.json
import fs from "node:fs";
import path from "node:path";
import { readTasks } from "./firing.ts";
import type { GradeRow } from "./grading.ts";
import type { GoldSignal } from "./judge.ts";
import type { Grade } from "./schema-check.ts";

type TaskInfo = { id: string; lang?: string; overlap?: boolean | null; gold?: string[] };
type Graded = GradeRow & {
  search_before_edit?: "yes" | "no" | "no_edit" | "unknown" | "not_applicable";
  tests?: string;
  gold?: string[];
  grade?: Grade;
  ungraded?: string;
  second?: { grade: Grade } | { ungraded: string };
  gold_signals?: Record<string, GoldSignal>;
};
export type Build = { build?: string | null; variant: string; bundle?: string; rows: Graded[] };

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

type Side = { label: string; build: Build; fixture: string | undefined; tasks: string };

/**
 * Old against new on the same records and tasks: each side's full report on its own (bundles never mixed), then one line per task, model,
 * and condition with each side's graded runs, mean score, and the rates the experiments' bars read. Refuses two builds whose fixtures or
 * task definitions differ, or that ran the same bundle.
 */
export function compare(old: Side, next: Side, tasks: TaskInfo[]): string[] {
  if (!old.fixture || old.fixture !== next.fixture)
    throw new Error(
      `the builds were made from different fixtures (${old.fixture} / ${next.fixture}); compare only the same records`,
    );
  if (old.tasks !== next.tasks) throw new Error("the builds were made from different task definitions");
  // A bundle is "<commit> {artifact hashes}"; two commits can ship the same artifacts, so only the hashes tell the bundles apart
  const artifacts = (b: Build) => {
    const at = b.bundle?.indexOf(" ") ?? -1;
    return b.bundle && at > 0 ? b.bundle.slice(at + 1) : "";
  };
  for (const side of [old, next])
    if (!artifacts(side.build) || artifacts(side.build) === "{}")
      throw new Error(`the ${side.label} build names no bundle; it cannot be told which code ran`);
  if (artifacts(old.build) === artifacts(next.build))
    throw new Error("both builds ran the same bundle; there is nothing to compare");
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

if (process.argv[1] === import.meta.filename && process.argv[2] === "--compare") {
  const files = process.argv.slice(3);
  if (files.length !== 2) throw new Error("--compare takes <old>/grades.json <new>/grades.json");
  const sides = files.map((f, i): Side => {
    const dir = path.dirname(f);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as {
      fixture?: string;
    };
    return {
      label: i === 0 ? "old" : "new",
      build: JSON.parse(fs.readFileSync(f, "utf8")) as Build,
      fixture: manifest.fixture,
      tasks: fs.readFileSync(path.join(dir, "tasks.json"), "utf8"),
    };
  });
  const plan = readTasks<{ tasks: TaskInfo[] }>(path.dirname(files[0] ?? ""));
  const [a, b] = sides as [Side, Side];
  console.log(compare(a, b, plan.tasks).join("\n"));
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
  const defs = files.map((f) => fs.readFileSync(path.join(path.dirname(f), "tasks.json"), "utf8"));
  if (new Set(defs).size > 1)
    throw new Error("the builds were made from different task definitions; report one loop at a time");
  const plan = readTasks<{ tasks: TaskInfo[]; swapped: { tasks: Record<string, string[]> } }>(
    path.dirname(files[0] ?? ""),
  );
  console.log(report(builds, plan.tasks, Object.keys(plan.swapped.tasks)).join("\n"));
}
