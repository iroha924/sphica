// Exact checks for the two fixed shapes the evaluation reads from Codex: a grade (grade.schema.json) and an evaluation run's answer
// (answer.schema.json). Hand-written for these two shapes only; a value that does not match is kept apart with the reason, never counted.

export type Grade = {
  score: 0 | 1 | 2;
  reason: string;
  cited_gold: "yes" | "no";
  implements_rejected: "yes" | "no" | "not_applicable" | "unknown";
  flags: ("stopped_at_plan" | "read_scaffolding" | "off_task")[];
};

export type Answer = {
  implemented: boolean;
  summary: string;
  past_decisions: { ref: string; how_used: "followed" | "overrode" | "mentioned" }[];
  unverified: string[];
};

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

type Rule = (v: unknown) => string | null;

const oneOf =
  (...allowed: unknown[]): Rule =>
  (v) =>
    allowed.includes(v) ? null : `must be one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}`;
const isString: Rule = (v) => (typeof v === "string" ? null : "must be a string");
const isBoolean: Rule = (v) => (typeof v === "boolean" ? null : "must be a boolean");
const listOf =
  (item: Rule): Rule =>
  (v) => {
    if (!Array.isArray(v)) return "must be an array";
    for (const [i, x] of v.entries()) {
      const why = item(x);
      if (why) return `[${i}] ${why}`;
    }
    return null;
  };
const shape =
  (fields: Record<string, Rule>): Rule =>
  (v) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return "must be an object";
    for (const key of Object.keys(v)) if (!(key in fields)) return `${key}: not allowed`;
    for (const [key, rule] of Object.entries(fields)) {
      if (!(key in v)) return `${key}: missing`;
      const why = rule((v as Record<string, unknown>)[key]);
      if (why) return `${key}: ${why}`;
    }
    return null;
  };

const gradeRule = shape({
  score: oneOf(0, 1, 2),
  reason: isString,
  cited_gold: oneOf("yes", "no"),
  implements_rejected: oneOf("yes", "no", "not_applicable", "unknown"),
  flags: listOf(oneOf("stopped_at_plan", "read_scaffolding", "off_task")),
});

const answerRule = shape({
  implemented: isBoolean,
  summary: isString,
  past_decisions: listOf(shape({ ref: isString, how_used: oneOf("followed", "overrode", "mentioned") })),
  unverified: listOf(isString),
});

const check = <T>(rule: Rule, v: unknown): Checked<T> => {
  const why = rule(v);
  return why
    ? { ok: false, reason: why.startsWith("must") ? `value ${why}` : why }
    : { ok: true, value: v as T };
};

export const checkGrade = (v: unknown): Checked<Grade> => check<Grade>(gradeRule, v);
export const checkAnswer = (v: unknown): Checked<Answer> => check<Answer>(answerRule, v);

/** Parses a model's final output: empty and non-JSON text are reasons, not values. */
export function parseOutput(text: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (!text.trim()) return { ok: false, reason: "empty output" };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "not JSON" };
  }
}
