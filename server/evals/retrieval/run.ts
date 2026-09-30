// Prints the offline retrieval benchmark (bench.ts). Run from server/: node evals/retrieval/run.ts [--compare <git ref>] [--json]
// --compare copies this runner and corpus into a worktree of the ref and runs them there, so the ref's own terms(), index triggers,
// and search build and read its database; running both versions against one database would compare the wrong tokenizer.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bench, type Scores } from "./bench.ts";

type Summary = { name: string; scores: Scores }[];

// JSON turns NaN into null, so a number read back from another ref can be null
const none = (n: number | null) => n === null || Number.isNaN(n);
const pct = (n: number | null) => (none(n) ? "n/a" : `${((n as number) * 100).toFixed(1)}%`);
const cells = (s: Scores) =>
  `R@1 ${pct(s.recall[1]).padStart(6)}  R@5 ${pct(s.recall[5]).padStart(6)}  R@10 ${pct(s.recall[10]).padStart(6)}  MRR ${none(s.mrr) ? "  n/a" : s.mrr.toFixed(3)}  returned anyway ${pct(s.falseHit).padStart(6)}`;

async function summary(): Promise<{ lines: string[]; groups: Summary }> {
  const r = await bench();
  const lines = r.rows.map(
    (row) =>
      `${row.id} (${row.lang}${row.overlap ? ", overlap" : ""}): ${row.overlap === null ? (row.hits ? `${row.hits} hits` : "empty") : row.rank ? `gold at ${row.rank}` : "missed"}`,
  );
  const groups: Summary = [
    { name: "all", scores: r.all },
    ...[...r.byLang, ...r.byOverlap].map(([name, scores]) => ({ name, scores })),
  ];
  return { lines, groups };
}

/** Runs this runner and corpus against another ref's source, in a throwaway worktree with that ref's dependencies. */
function other(ref: string): Summary {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  // The ref's code runs here with the owner's permissions, so only a ref this checkout's history already holds is compared
  const inHistory = spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", ref, "HEAD"]).status === 0;
  if (!inHistory)
    throw new Error(`${ref} is not in this checkout's history; compare only with a ref HEAD contains`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-bench-"));
  const tree = path.join(dir, "tree");
  execFileSync("git", ["-C", root, "worktree", "add", "--detach", tree, ref], { stdio: "ignore" });
  try {
    const here = path.join(tree, "server", "evals", "retrieval");
    fs.mkdirSync(here, { recursive: true });
    for (const f of ["bench.ts", "run.ts", "corpus.json"])
      fs.copyFileSync(path.join(import.meta.dirname, f), path.join(here, f));
    execFileSync("bun", ["install", "--cwd", "server", "--frozen-lockfile", "--ignore-scripts"], {
      cwd: tree,
      stdio: "ignore",
    });
    let out: string;
    try {
      out = execFileSync(process.execPath, [path.join("evals", "retrieval", "run.ts"), "--json"], {
        cwd: path.join(tree, "server"),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      const why = `${(e as { stderr?: string }).stderr ?? ""}`.trim().split("\n").slice(-3).join("\n");
      throw new Error(
        `the benchmark does not run against ${ref} (its source lacks what the runner uses):\n${why}`,
      );
    }
    return JSON.parse(out) as Summary;
  } finally {
    execFileSync("git", ["-C", root, "worktree", "remove", "--force", tree], { stdio: "ignore" });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
const at = args.indexOf("--compare");
const ref = at >= 0 ? args[at + 1] : undefined;
if (at >= 0 && !ref) throw new Error("--compare needs a git ref");
const mine = await summary();
if (args.includes("--json")) process.stdout.write(`${JSON.stringify(mine.groups)}\n`);
else if (ref) {
  const theirs = new Map(other(ref).map((g) => [g.name, g.scores]));
  for (const g of mine.groups) {
    const t = theirs.get(g.name);
    console.log(
      `${g.name}\n  ${ref.padEnd(12)} ${t ? cells(t) : "(no such group)"}\n  ${"this tree".padEnd(12)} ${cells(g.scores)}`,
    );
  }
} else {
  console.log(mine.lines.join("\n"));
  console.log("");
  for (const g of mine.groups)
    console.log(
      `${g.name.padEnd(12)} ${cells(g.scores)}  (${g.scores.answerable} with gold, ${g.scores.unanswerable} without)`,
    );
}
