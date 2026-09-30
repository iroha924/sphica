// The two fixed shapes the evaluation reads from Codex: a grade (grade.schema.json) and an evaluation run's answer (answer.schema.json).
// The zod schemas here are the one source: the JSON files Codex gets through --output-schema are written from them
// (node evals/cloud/schema-check.ts --write), and a value that does not match is kept apart with the reason, never counted.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const gradeSchema = z.strictObject({
  score: z.literal([0, 1, 2]),
  reason: z.string(),
  cited_gold: z.enum(["yes", "no"]),
  implements_rejected: z.enum(["yes", "no", "not_applicable", "unknown"]),
  proposes_rejected: z.enum(["yes", "no", "not_applicable"]),
  followed: z.enum(["presented", "other", "neither", "not_applicable"]),
  flags: z.array(z.enum(["stopped_at_plan", "read_scaffolding", "off_task"])),
});

const answerSchema = z.strictObject({
  implemented: z.boolean(),
  summary: z.string(),
  past_decisions: z.array(
    z.strictObject({ ref: z.string(), how_used: z.enum(["followed", "overrode", "mentioned"]) }),
  ),
  unverified: z.array(z.string()),
});

export type Grade = z.infer<typeof gradeSchema>;
export type Answer = z.infer<typeof answerSchema>;
export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

/** The JSON Schema Codex's --output-schema takes: without $schema, as its strict mode wants every object closed and every key required. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

const check = <T>(schema: z.ZodType<T>, v: unknown): Checked<T> => {
  const r = schema.safeParse(v);
  if (r.success) return { ok: true, value: r.data };
  const first = r.error.issues[0];
  return { ok: false, reason: `${first?.path.join(".") || "value"}: ${first?.message ?? "does not match"}` };
};

export const checkGrade = (v: unknown): Checked<Grade> => check(gradeSchema, v);
export const checkAnswer = (v: unknown): Checked<Answer> => check(answerSchema, v);

/** Parses a model's final output: empty and non-JSON text are reasons, not values. */
export function parseOutput(text: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (!text.trim()) return { ok: false, reason: "empty output" };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "not JSON" };
  }
}

export const SCHEMA_FILES = { "grade.schema.json": gradeSchema, "answer.schema.json": answerSchema };

if (process.argv[1] === import.meta.filename && process.argv[2] === "--write")
  for (const [name, schema] of Object.entries(SCHEMA_FILES))
    fs.writeFileSync(
      path.join(import.meta.dirname, name),
      `${JSON.stringify(jsonSchemaOf(schema), null, 2)}\n`,
    );
