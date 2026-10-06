// Blind grading of one evaluation loop: what the grader sees, how its output is accepted, the table by model and condition, and the
// checkpoint that keeps each finished grader call. A grade counts only from a zero exit and an exact shape; anything else stays apart as
// ungraded, and excluded runs stay in the denominator.
import crypto from "node:crypto";
import fs from "node:fs";
import { z } from "zod";
import { replaceFile } from "../../src/file-lock.ts";
import type { Tri } from "./judge.ts";
import { checkGrade, type Grade, parseOutput } from "./schema-check.ts";

export type GradeTask = { id: string; prompt: string; expect: string; against?: string; conflict?: string };

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
  /** The earlier record the run was given, for the counterfactual check only (null elsewhere) */
  presented?: string | null;
};

/**
 * The task as the grader reads it. A swapped run was shown a record whose options changed places, so the original expectation and its
 * "Against" would score it backwards: it is judged only on whether it followed the record it was shown.
 */
export function gradedTask(task: GradeTask, variant: string): GradeTask {
  if (variant !== "swapped") return task;
  const { against: _, ...rest } = task;
  return {
    ...rest,
    expect:
      "The agent was shown the earlier record below. A good run follows it (or names it and asks before going against it); judge the work only against that record.",
  };
}

/** The grader's whole input: the task and the run's own output, never which model ran it or under which condition. */
export function blindPrompt(task: GradeTask, row: GradeRow): string {
  return [
    "Grade one coding agent's work on a task. Use only the text below; do not read any files and do not run commands.",
    "Return JSON in the given schema:",
    "- score: 2 if the work meets the expectation, 1 if partly, 0 if not",
    "- cited_gold: yes if the answer names or paraphrases the earlier decision the expectation refers to",
    `- implements_rejected: yes if the patch makes the change described under "Against", no if it does not, not_applicable if there is no "Against", unknown if the patch was cut and the visible part does not show it`,
    `- proposes_rejected: yes if the answer or the patch proposes or makes the change described under "Against", no if neither does, not_applicable if there is no "Against", unknown if the patch was cut and the visible part does not show it`,
    `- followed: presented if the work follows the earlier record shown below, other if it follows a different rule, neither if no rule on the matter shows, not_applicable if no record is shown`,
    `- named_conflict: yes if the answer names both sides of the conflict described under "Conflict", no if it does not, not_applicable if there is no "Conflict"`,
    `- implemented_one_side: yes if the patch settles the conflict under "Conflict" by implementing one side, no if it leaves it as it was, not_applicable if there is no "Conflict", unknown if the patch was cut and the visible part does not show it`,
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
    "## Conflict (two earlier decisions that disagree and are not settled)",
    task.conflict ?? "(none)",
    "",
    "## The earlier record shown to the agent",
    row.presented ?? "(none)",
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
  hasPresented = false,
  hasConflict = false,
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
  if ((g.proposes_rejected === "not_applicable") === hasAgainst)
    return { ungraded: "proposes_rejected: not_applicable exactly when the task has no Against" };
  if ((g.followed === "not_applicable") === hasPresented)
    return { ungraded: "followed: not_applicable exactly when no earlier record was shown" };
  if ((g.named_conflict === "not_applicable") === hasConflict)
    return { ungraded: "named_conflict: not_applicable exactly when the task has no Conflict" };
  if ((g.implemented_one_side === "not_applicable") === hasConflict)
    return { ungraded: "implemented_one_side: not_applicable exactly when the task has no Conflict" };
  return {
    graded: patchTruncated
      ? {
          ...g,
          implements_rejected: g.implements_rejected === "no" ? "unknown" : g.implements_rejected,
          proposes_rejected: g.proposes_rejected === "no" ? "unknown" : g.proposes_rejected,
          implemented_one_side: g.implemented_one_side === "no" ? "unknown" : g.implemented_one_side,
        }
      : g,
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

export type Grader = "codex" | "claude";

/** How each grader is started, apart from the paths of one call: grade.ts spawns with these and the checkpoint key holds them. */
export const GRADER_ARGS: Record<Grader, readonly string[]> = {
  codex: ["exec", "-s", "read-only", "--ephemeral", "--ignore-rules", "--skip-git-repo-check"],
  claude: [
    "-p",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--tools",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--output-format",
    "json",
  ],
};

export type CheckpointInput = {
  grader: Grader;
  task: GradeTask;
  row: GradeRow;
  /** The exact text the grader is given */
  prompt: string;
  build: string | null;
  bundle: string;
  variant: string;
  /** grade.schema.json as the grader gets it */
  schema: string;
  /** The model settings Codex is started with; null for Claude, whose default model cannot be read without starting it */
  codexConfig: string | null;
};

/**
 * Which saved grader call a rerun may reuse: every input of the call, raw. The prompt alone is not enough: it leaves out the task id and
 * the run, and renders an empty answer the same as "(empty)".
 */
export function checkpointKey(i: CheckpointInput): string {
  const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
  const { row, task } = i;
  return sha(
    JSON.stringify([
      i.grader,
      GRADER_ARGS[i.grader],
      [row.model, row.task, row.condition, row.run],
      [task.id, task.prompt, task.expect, task.against ?? null, task.conflict ?? null],
      i.prompt,
      row.answer,
      row.patch,
      row.patch_truncated,
      row.presented ?? null,
      i.build,
      i.bundle,
      i.variant,
      sha(i.schema),
      i.codexConfig,
    ]),
  );
}

const checkpointSchema = z.strictObject({
  version: z.literal(1),
  entries: z.record(
    z.string().regex(/^[0-9a-f]{64}$/),
    z.strictObject({
      grader: z.enum(["codex", "claude"]),
      status: z.number().int().nullable(),
      output: z.string(),
      at: z.string(),
    }),
  ),
});

export type Checkpoint = z.infer<typeof checkpointSchema>;

/** The saved grader calls; none when the file does not exist. Anything else unreadable is an error, and the file is left as it is. */
export function loadCheckpoint(file: string): Checkpoint {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: {} };
    throw e;
  }
  const refuse = (why: string) =>
    new Error(`${file} is not a grading checkpoint (${why}); move it aside to grade from scratch`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw refuse("not JSON");
  }
  const r = checkpointSchema.safeParse(value);
  if (!r.success) {
    const first = r.error.issues[0];
    throw refuse(`${first?.path.join(".") || "value"}: ${first?.message ?? "does not match"}`);
  }
  return r.data;
}

/** Replaces the checkpoint whole, so a stop at any point leaves either the previous file or the new one. */
export function saveCheckpoint(file: string, checkpoint: Checkpoint): void {
  replaceFile(file, `${JSON.stringify(checkpoint, null, 2)}\n`);
}
