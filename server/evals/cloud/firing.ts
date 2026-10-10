// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

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
 * The firing plan: each task's conditions times the tries. A task's `runs` sets the tries per condition, and `runs` is the default for the
 * rest. A swapped build plans only its gold rows, the only runs shown the swapped record and the only ones the counterfactual reads.
 */
export function planRows(
  build: string,
  variant: string,
  tasks: { id: string; prompt: string; conditions: string[]; runs?: Record<string, number> }[],
  runs: number,
  slotOf: (condition: string) => string,
): FiringRow[] {
  for (const t of tasks)
    for (const [condition, n] of Object.entries(t.runs ?? {}))
      if (!Number.isInteger(n) || n < 1)
        throw new Error(
          `${t.id}: runs for ${condition} must be a whole number of at least 1, not ${JSON.stringify(n)}`,
        );
  return tasks.flatMap((t) =>
    t.conditions
      .filter((condition) => variant !== "swapped" || condition === "gold")
      .flatMap((condition) =>
        Array.from({ length: t.runs?.[condition] ?? runs }, (_, i) => ({
          build,
          variant,
          task: t.id,
          condition,
          slot: slotOf(condition),
          try: i + 1,
          prompt: t.prompt,
          fired_at: null,
        })),
      ),
  );
}

const tasksFile = (build: string) => path.join(build, "tasks.json");

/** The task definitions the build was made from: its runs are collected, graded, and reported against these, not the checkout's. */
export function readTasks<T>(build: string): T {
  const file = tasksFile(build);
  if (!fs.existsSync(file)) throw new Error(`no task definitions at ${file} (build.ts copies them)`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export const writeTasks = (build: string, tasks: unknown) =>
  fs.writeFileSync(tasksFile(build), `${JSON.stringify(tasks, null, 2)}\n`);

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

/**
 * The task a run carried out, from the prompt its hooks received: the build's planned prompts first (tasks.json may have been reworded since
 * the build), then the current tasks.
 */
export function taskFromReceipts(
  receipts: string,
  rows: Pick<FiringRow, "task" | "prompt">[],
  tasks: { id: string; prompt: string }[],
): string | undefined {
  return (
    rows.find((r) => receipts.includes(r.prompt))?.task ?? tasks.find((t) => receipts.includes(t.prompt))?.id
  );
}
