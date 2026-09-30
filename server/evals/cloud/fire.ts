// Takes the next unfired row of a build's firing plan, marks it fired now, and prints what to fire: the slot (its routine is in
// ~/.cache/sphica-eval/routines.json) and the prompt. Fire the routine right after; a row marked but never fired shows as a run with no result.
// Run: node evals/cloud/fire.ts <build dir>
import { readPlan, writePlan } from "./firing.ts";

const build = process.argv[2];
if (!build) throw new Error("give the build directory");
const rows = readPlan(build);
const next = rows.find((r) => r.fired_at === null);
if (!next) {
  console.log(JSON.stringify({ done: true, fired: rows.length }));
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
      left: rows.filter((r) => r.fired_at === null).length,
    }),
  );
}
