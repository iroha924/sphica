// Checking a reviewer's verdicts. Kept apart from review.ts so the delivery hook, which selects records for review, does not
// bundle zod.

import { z } from "zod";
import type { Reads } from "./db.ts";
import { type FileDiff, selectForReview } from "./review.ts";

const Finding = z
  .object({
    outcome: z.enum(["violation", "complies", "unrelated", "undetermined"]),
    unit: z.string().min(1),
    reason: z.string().optional(),
    /** Changed code the verdict rests on: a path in the diff and a line added there (the path alone for a file that is gone) */
    evidence: z
      .object({ path: z.string().min(1), line: z.number().int().positive().optional() })
      .strict()
      .optional(),
  })
  .strict();
const MAX_FINDINGS = 50;
const Findings = z.array(Finding).max(MAX_FINDINGS);

/**
 * Problems with a reviewer's verdicts: a violation or compliance must name an applicable record, give a reason, and point at changed code;
 * each applicable record gets one outcome (asked only while they fit in the findings limit), and never contradictory ones.
 */
export async function checkFindings(
  db: Reads,
  projectId: number,
  files: FileDiff[],
  raw: unknown,
): Promise<string[]> {
  const parsed = Findings.safeParse(raw);
  if (!parsed.success) return parsed.error.issues.map((i) => `findings.${i.path.join(".")}: ${i.message}`);
  const selected = (await selectForReview(db, projectId, files)).map((u) => u.key);
  const applicable = new Set(selected);
  const problems: string[] = [];
  for (const [i, f] of parsed.data.entries()) {
    const at = `findings.${i} (${f.outcome} ${f.unit})`;
    if (f.outcome !== "violation" && f.outcome !== "complies") continue;
    if (!applicable.has(f.unit))
      problems.push(`${at}: not a record this diff touches; cite one review_select returned`);
    if (!f.reason?.trim()) problems.push(`${at}: give the reason, tying the record to the change`);
    if (!f.evidence) problems.push(`${at}: needs evidence in the changed code (a path and an added line)`);
    else {
      const file = files.find((x) => x.path === f.evidence?.path);
      if (!file) problems.push(`${at}: evidence path ${f.evidence.path} is not in the diff`);
      else if (file.gone) {
        // A deleted or renamed-away file has no added lines: its path is the evidence
      } else if (f.evidence.line === undefined)
        problems.push(`${at}: evidence in ${file.path} needs an added line`);
      else if (!file.lines.includes(f.evidence.line))
        problems.push(`${at}: evidence line ${f.evidence.line} is not an added line of ${file.path}`);
    }
  }
  // Every selected record is judged, once: several violations are fine, but not a violation and a compliance
  for (const key of selected) {
    const outcomes = [...new Set(parsed.data.filter((f) => f.unit === key).map((f) => f.outcome))];
    if (!outcomes.length && selected.length <= MAX_FINDINGS)
      problems.push(`${key}: no verdict; give one (unrelated or undetermined when it does not apply)`);
    else if (outcomes.length > 1)
      problems.push(`${key}: contradictory verdicts (${outcomes.join(", ")}); give one outcome`);
  }
  return problems;
}
