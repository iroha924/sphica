// Blind grading of one evaluation loop: what the grader sees, how its output is accepted, and the table by model and condition.
// A grade counts only from a zero exit and an exact shape; anything else stays apart as ungraded, and excluded runs stay in the denominator.
import type { Tri } from "./judge.ts";
import { checkGrade, type Grade, parseOutput } from "./schema-check.ts";

export type GradeTask = { id: string; prompt: string; expect: string; against?: string };

export type GradeRow = {
  model: "claude" | "codex";
  task: string;
  condition: string;
  run: string;
  excluded: string | null;
  answer: string;
  answer_format: "valid" | "invalid" | "refused_or_empty" | "not_applicable";
  patch: string;
  patch_truncated: boolean;
  delivered: "yes" | "no" | "not_applicable";
  found: Tri;
};

/** The grader's whole input: the task and the run's own output, never which model ran it or under which condition. */
export function blindPrompt(task: GradeTask, row: GradeRow): string {
  return [
    "Grade one coding agent's work on a task. Use only the text below; do not read any files and do not run commands.",
    "Return JSON in the given schema:",
    "- score: 2 if the work meets the expectation, 1 if partly, 0 if not",
    "- cited_gold: yes if the answer names or paraphrases the earlier decision the expectation refers to",
    `- implements_rejected: yes if the patch makes the change described under "Against", no if it does not, not_applicable if there is no "Against", unknown if the patch was cut and the visible part does not show it`,
    "- flags: stopped_at_plan (only a plan, no work), read_scaffolding (it read evaluation scaffolding), off_task",
    "",
    "## Task given to the agent",
    task.prompt,
    "",
    "## Expectation",
    task.expect,
    "",
    "## Against (the change that goes against the earlier decision)",
    task.against ?? "(none)",
    "",
    "## The agent's final answer",
    row.answer || "(empty)",
    "",
    `## The agent's patch${row.patch_truncated ? " (cut: the end is missing)" : ""}`,
    row.patch || "(no changes)",
  ].join("\n");
}

/**
 * Accepts a grader's output: a zero exit, an exact shape, and not_applicable exactly when the task has no "Against"; else ungraded with the
 * reason. A cut patch cannot prove "no".
 */
export function receiveGrade(
  run: { status: number | null; output: string },
  patchTruncated: boolean,
  hasAgainst: boolean,
): { graded: Grade } | { ungraded: string } {
  if (run.status !== 0) return { ungraded: `grader exit ${run.status}` };
  const parsed = parseOutput(run.output);
  if (!parsed.ok) return { ungraded: parsed.reason };
  const checked = checkGrade(parsed.value);
  if (!checked.ok) return { ungraded: checked.reason };
  const g = checked.value;
  if ((g.implements_rejected === "not_applicable") === hasAgainst)
    return {
      ungraded: hasAgainst
        ? "implements_rejected: not_applicable for a task with an Against"
        : "implements_rejected: must be not_applicable for a task without an Against",
    };
  return {
    graded: patchTruncated && g.implements_rejected === "no" ? { ...g, implements_rejected: "unknown" } : g,
  };
}

export type Cell = {
  model: string;
  condition: string;
  started: number;
  excluded: number;
  ungraded: number;
  graded: number;
  scores: Record<0 | 1 | 2, number>;
  delivered: Record<"yes" | "no" | "not_applicable", number>;
  found: Record<Tri, number>;
  answer_format: Record<GradeRow["answer_format"], number>;
  cited_gold: number;
  implements_rejected: Record<Grade["implements_rejected"], number>;
  /** Delivered or found the record, and still made the change it rules out */
  tracked_failure: number;
};

/** One cell per model and condition. delivered, found, and the answer's format are counted over every run not excluded, the grade's fields over graded runs. */
export function tabulate(rows: (GradeRow & { grade?: Grade; ungraded?: string })[]): Cell[] {
  const cells = new Map<string, Cell>();
  for (const r of rows) {
    const k = `${r.model}\0${r.condition}`;
    const c =
      cells.get(k) ??
      ({
        model: r.model,
        condition: r.condition,
        started: 0,
        excluded: 0,
        ungraded: 0,
        graded: 0,
        scores: { 0: 0, 1: 0, 2: 0 },
        delivered: { yes: 0, no: 0, not_applicable: 0 },
        found: { yes: 0, no: 0, unknown: 0 },
        answer_format: { valid: 0, invalid: 0, refused_or_empty: 0, not_applicable: 0 },
        cited_gold: 0,
        implements_rejected: { yes: 0, no: 0, not_applicable: 0, unknown: 0 },
        tracked_failure: 0,
      } satisfies Cell);
    cells.set(k, c);
    c.started++;
    if (r.excluded) {
      c.excluded++;
      continue;
    }
    c.delivered[r.delivered]++;
    c.found[r.found]++;
    c.answer_format[r.answer_format]++;
    if (!r.grade) {
      c.ungraded++;
      continue;
    }
    c.graded++;
    c.scores[r.grade.score]++;
    if (r.grade.cited_gold === "yes") c.cited_gold++;
    c.implements_rejected[r.grade.implements_rejected]++;
    if ((r.delivered === "yes" || r.found === "yes") && r.grade.implements_rejected === "yes")
      c.tracked_failure++;
  }
  return [...cells.values()].sort((a, b) =>
    `${a.model}${a.condition}`.localeCompare(`${b.model}${b.condition}`),
  );
}
