// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The offline conflict evaluation's command line. --recount counts the public baseline again from its labels and candidate ids alone and
// fails unless the summary and verdict come out as written.
import fs from "node:fs";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { checkPublic, decide, summarize, type Verdict } from "./measure.ts";

/** The held-out summary and verdict counted again from a public baseline, and which of the two differ from what it says */
export function recount(value: unknown): { verdict: Verdict; differs: string[] } {
  checkPublic(value);
  const summary = summarize(value.prompts, Object.keys(value.methods), "held_out");
  const verdict = decide(summary, value.bars);
  return {
    verdict,
    differs: [
      ...(isDeepStrictEqual(summary, value.summary) ? [] : ["summary"]),
      ...(isDeepStrictEqual(verdict, value.verdict) ? [] : ["verdict"]),
    ],
  };
}

function main(): void {
  const { values } = parseArgs({ options: { recount: { type: "string" } } });
  if (!values.recount) throw new Error("usage: run.ts --recount <baseline.json>");
  const { verdict, differs } = recount(JSON.parse(fs.readFileSync(values.recount, "utf8")));
  if (differs.length) {
    console.error(`${values.recount}: the ${differs.join(" and ")} counted again differ from what it says`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `${values.recount}: ${verdict.verdict}${verdict.passing.length ? ` (${verdict.passing.join(", ")})` : ""}${verdict.reasons.length ? ` [${verdict.reasons.join(", ")}]` : ""}, as written`,
  );
}

if (process.argv[1] && /run\.(ts|js)$/.test(process.argv[1])) main();
