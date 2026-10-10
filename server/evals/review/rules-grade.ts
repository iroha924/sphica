// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Grades /sphica:rules runs for M1: the Biome config a run drafts goes into a copy of the fixture with held-out files it never saw, and the
// pinned Biome decides which of them fail. Biome itself reads the draft, comments and all, so no JSONC parsing happens here.
// Run from server/: node evals/review/rules-grade.ts --report <runs dir>
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { Step } from "../acceptance/load.ts";
import { repoPlaces } from "../cloud/codex-run.ts";
import { restrictedImports } from "./biome.ts";
import { lookedOutside, oneConfiguration } from "./grade.ts";

export type RulesCases = {
  files: Record<string, string>;
  steps: Step[];
  picks: string[];
  draft: string[];
  may_mark: string[];
  held_out: { path: string; text: string; fails: boolean }[];
};

export function loadRulesCases(): RulesCases {
  return JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "rules-cases.json"), "utf8"),
  ) as RulesCases;
}

/** The last fenced block of a reply that configures noRestrictedImports, or null when the reply drafts no check. */
export function draftOf(reply: string): string | null {
  const blocks = [...reply.matchAll(/^```[^\n]*\n([\s\S]*?)^```\s*$/gm)].map((m) => m[1] ?? "");
  return blocks.filter((b) => b.includes("noRestrictedImports")).at(-1) ?? null;
}

/** The record keys a draft marks with `sphica: <key>`. */
function markersOf(draft: string): string[] {
  // Only the marker lines the Skill asks for: a `//` comment of its own; the same words in a message string are not a marker
  const keys = [...draft.matchAll(/^\s*\/\/\s*sphica:\s*((?:trace|harvest|glean):[^\s"]+)/gm)].map((m) =>
    (m[1] ?? "").replace(/[.,;:]+$/, ""),
  );
  return [...new Set(keys)];
}

export type DraftGrade = {
  state: "graded" | "failed" | "excluded";
  reason: string | null;
  /** Marked records that should have no check */
  unwanted: string[];
  /** Records that should have a check and are not marked */
  unmarked: string[];
  falseFailures: string[];
  missedViolations: string[];
};

/** A draft judged on a copy of repo: the draft replaces biome.json as biome.jsonc, and the held-out files are added. */
export function gradeDraft(
  draft: string | null,
  repo: string,
  cases: RulesCases,
  scratch: string,
): DraftGrade {
  const grade: DraftGrade = {
    state: "failed",
    reason: null,
    unwanted: [],
    unmarked: [],
    falseFailures: [],
    missedViolations: [],
  };
  if (draft === null) return { ...grade, reason: "the reply drafts no Biome check" };
  const marked = markersOf(draft);
  grade.unwanted = marked.filter((k) => !cases.draft.includes(k) && !cases.may_mark.includes(k));
  grade.unmarked = cases.draft.filter((k) => !marked.includes(k));
  fs.cpSync(repo, scratch, { recursive: true, filter: (src) => path.basename(src) !== ".git" });
  fs.rmSync(path.join(scratch, "biome.json"), { force: true });
  fs.writeFileSync(path.join(scratch, "biome.jsonc"), draft);
  for (const f of cases.held_out) {
    fs.mkdirSync(path.dirname(path.join(scratch, f.path)), { recursive: true });
    fs.writeFileSync(path.join(scratch, f.path), f.text);
  }
  let flagged: Set<string>;
  try {
    flagged = new Set(restrictedImports(scratch).map((r) => r.path));
  } catch (e) {
    return { ...grade, reason: (e as Error).message };
  }
  for (const f of cases.held_out) {
    if (f.fails && !flagged.has(f.path)) grade.missedViolations.push(f.path);
    if (!f.fails && flagged.has(f.path)) grade.falseFailures.push(f.path);
  }
  return { ...grade, state: "graded" };
}

/**
 * One rules run graded: a run that named the repository holding the held-out cases (any worktree or its git directory), or another run, is excluded,
 * and a run without its result, or that did not exit 0, is failed.
 */
export function gradeRulesRun(
  dir: string,
  repo: string,
  cases: RulesCases,
  runs: string,
): DraftGrade & { host: string } {
  const name = path.basename(dir);
  const result = (
    fs.existsSync(path.join(dir, "result.json"))
      ? JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"))
      : { host: /-(claude|codex)-/.exec(name)?.[1] ?? "unknown", status: null, reason: "no result.json" }
  ) as { host: string; status: number | null; reason: string | null };
  const none = { unwanted: [], unmarked: [], falseFailures: [], missedViolations: [] };
  const read = (f: string) =>
    fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), "utf8") : "";
  const outside = lookedOutside(read("events.jsonl"), {
    forbidden: repoPlaces(),
    runs,
    run: name,
  });
  if (outside) return { host: result.host, state: "excluded", reason: outside, ...none };
  if (result.status !== 0) return { host: result.host, state: "failed", reason: result.reason, ...none };
  const scratch = path.join(dir, "graded");
  fs.rmSync(scratch, { recursive: true, force: true });
  return { host: result.host, ...gradeDraft(draftOf(read("final.md")), repo, cases, scratch) };
}

function main() {
  const { values: args } = parseArgs({ options: { report: { type: "string" } } });
  if (!args.report) throw new Error("--report <runs dir> names the rules runs to grade");
  const runs = path.resolve(args.report);
  const fixture = JSON.parse(fs.readFileSync(path.join(runs, "fixture-rules", "fixture.json"), "utf8")) as {
    repo: string;
  };
  const cases = loadRulesCases();
  const rows: string[] = [];
  const names = fs
    .readdirSync(runs)
    .filter((n) => n.startsWith("rules-"))
    .sort();
  oneConfiguration(runs, names);
  for (const name of names) {
    const g = gradeRulesRun(path.join(runs, name), fixture.repo, cases, runs);
    rows.push(
      `| ${name} | ${g.host} | ${g.state} | ${g.unwanted.join(" ")} | ${g.unmarked.join(" ")} | ${g.falseFailures.join(" ")} | ${g.missedViolations.join(" ")} | ${g.reason ?? ""} |`,
    );
  }
  console.log(
    "| run | host | state | unwanted | unmarked | false failures | missed violations | reason |\n|---|---|---|---|---|---|---|---|",
  );
  console.log(rows.join("\n"));
}

if (process.argv[1] === import.meta.filename) main();
