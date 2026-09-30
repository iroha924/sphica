// Prints the offline retrieval benchmark (bench.ts). Run from server/: node evals/retrieval/run.ts
import { bench, type Scores } from "./bench.ts";

const pct = (n: number) => (Number.isNaN(n) ? "n/a" : `${(n * 100).toFixed(1)}%`);
const line = (name: string, s: Scores) =>
  `${name.padEnd(12)} answerable ${String(s.answerable).padStart(2)}  R@1 ${pct(s.recall[1]).padStart(6)}  R@5 ${pct(s.recall[5]).padStart(6)}  R@10 ${pct(s.recall[10]).padStart(6)}  MRR ${Number.isNaN(s.mrr) ? "n/a" : s.mrr.toFixed(3)}  no gold ${String(s.unanswerable).padStart(2)}  returned anyway ${pct(s.falseHit).padStart(6)}`;

const r = await bench();
for (const row of r.rows)
  console.log(
    `${row.id} (${row.lang}${row.overlap === null ? "" : row.overlap ? ", overlap" : ""}): ${row.rank ? `gold at ${row.rank}` : row.hits && row.overlap === null ? `${row.hits} hits` : row.overlap === null ? "empty" : "missed"}`,
  );
console.log(`\n${line("all", r.all)}`);
for (const [k, s] of r.byLang) console.log(line(k, s));
for (const [k, s] of r.byOverlap) console.log(line(k, s));
