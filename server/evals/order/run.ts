// Prints the offline order benchmark (bench.ts). Run from server/: node evals/order/run.ts [--compare <git ref>] [--json]
// --compare copies this runner into a worktree of the ref and runs it there, so the ref's own delivery hooks choose what is shown.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type OrderResult, orderBench } from "./bench.ts";

const lines = (r: OrderResult) => [
  ...r.events.map((e) => `${e.event}: ${e.shown.length} shown, ${e.chars} characters: ${e.shown.join(", ")}`),
  `weighty records shown: ${r.weighty.shown} / ${r.weighty.of}`,
  `light records shown: ${r.light.shown} / ${r.light.of}`,
  ...Object.entries(r.shown).map(([k, n]) => `  ${k}: ${n} / ${r.events.length}`),
];

/** Runs this runner, its bench, and the acceptance world it reads against another ref's source, in a throwaway worktree. */
function other(ref: string): OrderResult {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  // The ref's code runs here with the owner's permissions, so only a ref this checkout's history already holds is compared
  if (spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", ref, "HEAD"]).status !== 0)
    throw new Error(`${ref} is not in this checkout's history; compare only with a ref HEAD contains`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-order-"));
  const tree = path.join(dir, "tree");
  execFileSync("git", ["-C", root, "worktree", "add", "--detach", tree, ref], { stdio: "ignore" });
  try {
    const server = path.join(import.meta.dirname, "..", "..");
    for (const rel of [
      "evals/order/bench.ts",
      "evals/order/run.ts",
      "evals/acceptance/cases.json",
      "evals/acceptance/world.json",
    ]) {
      fs.mkdirSync(path.dirname(path.join(tree, "server", rel)), { recursive: true });
      fs.copyFileSync(path.join(server, rel), path.join(tree, "server", rel));
    }
    execFileSync("bun", ["install", "--cwd", "server", "--frozen-lockfile", "--ignore-scripts"], {
      cwd: tree,
      stdio: "ignore",
    });
    const out = execFileSync(process.execPath, [path.join("evals", "order", "run.ts"), "--json"], {
      cwd: path.join(tree, "server"),
      encoding: "utf8",
    });
    return JSON.parse(out) as OrderResult;
  } finally {
    execFileSync("git", ["-C", root, "worktree", "remove", "--force", tree], { stdio: "ignore" });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
const at = args.indexOf("--compare");
const ref = at >= 0 ? args[at + 1] : undefined;
if (at >= 0 && !ref) throw new Error("--compare needs a git ref");
const here = await orderBench();
if (args.includes("--json")) {
  if (ref) throw new Error("--json prints this tree only; leave it out with --compare");
  process.stdout.write(JSON.stringify(here));
} else if (ref) {
  console.log([`# ${ref}`, ...lines(other(ref)), "", "# this tree", ...lines(here)].join("\n"));
} else console.log(lines(here).join("\n"));
