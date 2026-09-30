// The firing plan of one build: every Claude run the loop asks for, one row per task, condition, and try. build.ts writes it, fire.ts marks a
// row when its routine is fired, and collect.ts counts the fired rows as the denominator, so a run that pushed no branch still has its task.
import fs from "node:fs";
import path from "node:path";

export type FiringRow = {
  build: string;
  variant: string;
  task: string;
  condition: string;
  slot: string;
  try: number;
  prompt: string;
  fired_at: string | null;
};

const planFile = (build: string) => path.join(build, "plan.json");

export function readPlan(build: string): FiringRow[] {
  const file = planFile(build);
  if (!fs.existsSync(file)) throw new Error(`no firing plan at ${file} (build.ts writes it)`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as FiringRow[];
}

export const writePlan = (build: string, rows: FiringRow[]) =>
  fs.writeFileSync(planFile(build), `${JSON.stringify(rows, null, 2)}\n`);

/**
 * Pairs each fired row with a result, by task and condition, in the order the rows were fired and the runs started. A row left over had no
 * result; a result left over was not asked for by this plan.
 */
export function pair<R extends { task: string; condition: string; started: string }>(
  rows: FiringRow[],
  results: R[],
): { matched: [FiringRow, R][]; missing: FiringRow[]; unplanned: R[] } {
  const matched: [FiringRow, R][] = [];
  const missing: FiringRow[] = [];
  const left = [...results].sort((a, b) => a.started.localeCompare(b.started));
  for (const row of rows
    .filter((r) => r.fired_at !== null)
    .sort((a, b) => (a.fired_at ?? "").localeCompare(b.fired_at ?? ""))) {
    const at = left.findIndex((r) => r.task === row.task && r.condition === row.condition);
    if (at < 0) missing.push(row);
    else matched.push([row, ...left.splice(at, 1)] as [FiringRow, R]);
  }
  return { matched, missing, unplanned: left };
}
