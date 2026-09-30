// Takes the next unfired row of a build's firing plan, marks it fired now, and prints what to fire: the slot (its routine is in
// ~/.cache/sphica-eval/routines.json) and the prompt. Fire the routine right after; a row marked but never fired shows as a run with no result.
// --condition fires only that condition's rows (a swapped build is judged on its gold runs); rows never fired are not asked for.
// Run: node evals/cloud/fire.ts <build dir> [--condition <condition>]
import { parseArgs } from "node:util";
import { readPlan, writePlan } from "./firing.ts";

const { values: args, positionals } = parseArgs({
  options: { condition: { type: "string" } },
  allowPositionals: true,
});
const build = positionals[0];
if (!build) throw new Error("give the build directory");
const rows = readPlan(build);
const wanted = (r: (typeof rows)[number]) => !args.condition || r.condition === args.condition;
const next = rows.find((r) => r.fired_at === null && wanted(r));
if (!next) {
  console.log(JSON.stringify({ done: true, fired: rows.filter((r) => r.fired_at !== null).length }));
} else {
  next.fired_at = new Date().toISOString();
  writePlan(build, rows);
  const { slot, task, condition, try: n, prompt } = next;
  console.log(
    JSON.stringify({
      slot,
      task,
      condition,
      try: n,
      prompt,
      left: rows.filter((r) => r.fired_at === null && wanted(r)).length,
    }),
  );
}
