// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Checking a reviewer's verdicts. Kept apart from review.ts so the delivery hook, which selects records for review, does not
// bundle zod.

import { z } from "zod";
import type { Reads } from "./db.ts";
import { inline } from "./panel.ts";
import { fitCount, keyShown, preview, READ_BUDGET } from "./read.ts";
import { type Batch, type FileDiff, REVIEW_BATCH, reviewBatch } from "./review.ts";
import { head } from "./text.ts";

/** A place in the changed code: a path in the diff and a line added there (the path alone for a file that is gone) */
const Place = z.object({ path: z.string().min(1), line: z.number().int().positive().optional() }).strict();
const Finding = z
  .object({
    outcome: z.enum(["violation", "complies", "unrelated", "undetermined"]),
    unit: z.string().min(1),
    reason: z.string().optional(),
    /** The places the verdict rests on: one, or every place a record is violated */
    evidence: z.union([Place, z.array(Place).min(1)]).optional(),
  })
  .strict();
const Findings = z.array(Finding).max(REVIEW_BATCH);

/**
 * The problems with one batch's verdicts, and the batch they were checked against (null when the verdicts could not be read against one).
 * given counts the findings each record of the batch got: the reply always carries it, however many problems it has room for.
 */
export type Checked = { problems: string[]; batch: Batch | null; given?: { id: number; findings: number }[] };

/** A key, path, or message from the caller's input as a problem line shows it: one line, clipped. Matching uses the whole value */
const shown = (s: string) => preview(s, 200);

/**
 * Problems with a reviewer's verdicts on one batch: a violation or compliance must name an applicable record, give a reason, and point at
 * changed code, every place of it; each record of the batch gets exactly one finding. The selection must be the one review_select gave, so
 * the batches of one review cover the same records.
 */
export async function checkFindings(
  db: Reads,
  projectId: number,
  files: FileDiff[],
  raw: unknown,
  at: { after: number | null; selection: string; diff: string },
): Promise<Checked> {
  const parsed = Findings.safeParse(raw);
  if (!parsed.success)
    return {
      problems: parsed.error.issues.map((i) => `findings.${shown(i.path.join("."))}: ${shown(i.message)}`),
      batch: null,
    };
  const batch = await reviewBatch(db, projectId, files, at.after, at.diff);
  if (batch.selection !== at.selection)
    return {
      problems: [
        "the records this diff touches changed since review_select gave this selection; start again from the first batch",
      ],
      batch: null,
    };
  if (!batch.aligned)
    return {
      problems: [
        `after ${at.after} is not where a batch review_select gave ends; start again from the first batch`,
      ],
      batch: null,
    };
  // A batch past the last record holds nothing to judge, so a check of it would vouch for nothing
  if (!batch.records.length && batch.all.length)
    return {
      problems: [
        `no record after ${at.after}: the last batch is the one that ended there; start again from the first batch`,
      ],
      batch: null,
    };
  const applicable = new Set(batch.all.map((u) => u.key));
  const here = new Set(batch.records.map((u) => u.key));
  // A record can be violated at no more places than the diff has: its added lines and the files that are gone
  const places = files.reduce((n, f) => n + (f.gone ? 1 : f.lines.length), 0);
  const problems: string[] = [];
  for (const [i, f] of parsed.data.entries()) {
    const at = `findings.${i} (${f.outcome} ${shown(f.unit)})`;
    if (applicable.has(f.unit) && !here.has(f.unit)) {
      problems.push(`${at}: not in this batch; judge it with the batch review_select returns it in`);
      continue;
    }
    if (f.outcome !== "violation" && f.outcome !== "complies") continue;
    if (!applicable.has(f.unit))
      problems.push(`${at}: not a record this diff touches; cite one review_select returned`);
    if (!f.reason?.trim()) problems.push(`${at}: give the reason, tying the record to the change`);
    if (!f.evidence) {
      problems.push(`${at}: needs evidence in the changed code (a path and an added line)`);
      continue;
    }
    const given = Array.isArray(f.evidence) ? f.evidence : [f.evidence];
    const distinct = [...new Map(given.map((e) => [`${e.line ?? ""}:${e.path}`, e])).values()];
    if (distinct.length > places) {
      problems.push(
        `${at}: ${distinct.length} places of evidence, more places than the diff has (${places})`,
      );
      continue;
    }
    for (const e of distinct) {
      const file = files.find((x) => x.path === e.path);
      if (!file) problems.push(`${at}: evidence path ${shown(e.path)} is not in the diff`);
      else if (file.gone) {
        // A deleted or renamed-away file has no added lines: its path is the evidence
      } else if (e.line === undefined)
        problems.push(`${at}: evidence in ${shown(file.path)} needs an added line`);
      else if (!file.lines.includes(e.line))
        problems.push(`${at}: evidence line ${e.line} is not an added line of ${shown(file.path)}`);
    }
  }
  // Every record of the batch is judged once: the places of several violations go in one finding's evidence
  const given = batch.records.map((u) => ({
    id: u.id,
    findings: parsed.data.filter((f) => f.unit === u.key).length,
  }));
  for (const [i, u] of batch.records.entries()) {
    const n = given[i]?.findings ?? 0;
    if (!n)
      problems.push(
        `${keyShown(u.key, u.id)}: no verdict; give one (unrelated or undetermined when it does not apply)`,
      );
    else if (n > 1)
      problems.push(
        `${keyShown(u.key, u.id)}: ${n} findings; give one per record, with every place it is violated in its evidence`,
      );
  }
  return { problems, batch, given };
}

/** review_check's reply: success speaks for this batch only, and names the records later batches still have to judge. */
export function checkedText(c: Checked): string {
  if (c.problems.length || !c.batch) {
    // Which records still lack their one finding is said first and whole, by id: the problem lines after it are cut to fit
    const status = c.given?.length
      ? `Findings per record of this batch: ${c.given.map((g) => `u${g.id} ${g.findings === 1 ? "1 finding" : g.findings ? `${g.findings} findings` : "no finding"}`).join(", ")}.\n`
      : "";
    const lines = c.problems.map((x) => `- ${preview(x, 700)}`);
    const reply = (kept: number) =>
      `${lines.length} problems:\n${status}${lines.slice(0, kept).join("\n")}${kept < lines.length ? `\nand ${lines.length - kept} more problems; fix these and check again` : ""}`;
    return reply(fitCount(lines, READ_BUDGET, reply));
  }
  const b = c.batch;
  const done = `Batch ${b.k} of ${b.n} backed (selection ${b.selection}).`;
  if (b.next === null) return `${done} This was the last batch (${b.all.length} records in all).`;
  const next = b.next;
  const left = b.all.filter((u) => u.id > next);
  const names = left.slice(0, REVIEW_BATCH).map((u) => inline(head(u.key, 200)));
  return `${done} Not judged in this call: ${left.length} records (next batch: ${names.join(", ")}${left.length > names.length ? ", ..." : ""}); call review_select with after: ${next}, then review_check with the same after.`;
}
