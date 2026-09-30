// Marks the next unfired row of a build's firing plan (only --condition's rows when given) and prints its slot and prompt; fire that
// slot's routine (~/.cache/sphica-eval/routines.json) right after, since a marked row never fired shows as a run with no result.
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
if (args.condition && !rows.some((r) => r.condition === args.condition))
  throw new Error(`the firing plan has no rows for condition ${args.condition}`);
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
