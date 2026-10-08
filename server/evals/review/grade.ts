// Grades precedent lanes against the expected verdicts, by machine: each record's verdict is the one the last review_check that backed its
// batch accepted, and the run counts only when every batch was backed and the report ends with a completion line that matches. A run that
// cannot be graded is a failure, never zero findings.
// Run from server/: node evals/review/grade.ts --report <runs dir> [--against <baseline runs dir>]
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadReviewCases } from "./fixture.ts";

type Outcome = "violation" | "complies" | "unrelated" | "undetermined";
type Expected = { outcomes: Outcome[]; question: boolean };
type Call = { tool: string; args: Record<string, unknown>; text: string | null };
type Finding = { outcome: Outcome; unit: string };

type RecordGrade = {
  key: string;
  got: Outcome | null;
  falseViolation: boolean;
  missed: boolean;
  /** A verdict none of the expected outcomes allow, violation or not */
  mismatch: boolean;
  /** Whether the report lists the record as a question */
  asked: boolean;
  question: boolean;
};
export type RunGrade = {
  run: string;
  host: string;
  diff: string;
  state: "graded" | "failed" | "excluded";
  reason: string | null;
  records: RecordGrade[];
};

const lines = (text: string): Record<string, unknown>[] =>
  text.split("\n").flatMap((l) => {
    try {
      return [JSON.parse(l) as Record<string, unknown>];
    } catch {
      return [];
    }
  });

const textOf = (content: unknown): string | null =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c) => (c as { text?: string }).text ?? "").join("")
      : null;

/** The read server's calls in a run's events, in order, with the text each returned (null when it returned none). */
function mcpCalls(host: string, events: string): Call[] {
  const out: Call[] = [];
  if (host === "codex") {
    for (const e of lines(events)) {
      const item = e.item as
        | {
            type?: string;
            server?: string;
            tool?: string;
            arguments?: unknown;
            result?: { content?: unknown } | null;
          }
        | undefined;
      if (e.type !== "item.completed" || item?.type !== "mcp_tool_call" || item.server !== "sphica") continue;
      out.push({
        tool: item.tool ?? "",
        args: (item.arguments ?? {}) as Record<string, unknown>,
        text: textOf(item.result?.content),
      });
    }
    return out;
  }
  const pending = new Map<string, Call>();
  for (const e of lines(events)) {
    const content = (e.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content as {
      type?: string;
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: unknown;
    }[]) {
      if (c.type === "tool_use" && c.name?.startsWith("mcp__sphica__")) {
        const call = {
          tool: c.name.slice("mcp__sphica__".length),
          args: (c.input ?? {}) as Record<string, unknown>,
          text: null,
        };
        pending.set(c.id ?? "", call);
        out.push(call);
      } else if (c.type === "tool_result") {
        const call = pending.get(c.tool_use_id ?? "");
        if (call) call.text = textOf(c.content);
      }
    }
  }
  return out;
}

/**
 * Why a run looked outside its checkout, or null: its events name the repository the expected verdicts live in, or another run of the
 * same directory. Each host's sandbox denies those reads (runner.ts evalDenies), so this marks a run that tried, not one that succeeded;
 * a parent step in a command (`rg 'from "../db.ts"'`) is not one.
 */
export function lookedOutside(
  events: string,
  o: { forbidden: string[]; runs: string; run: string },
): string | null {
  for (const f of o.forbidden) if (events.includes(f)) return `named ${f}`;
  const other = new RegExp(`${o.runs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(?!${o.run}\\b)[\\w.-]+`);
  const m = other.exec(events);
  return m ? `named ${m[0]}` : null;
}

const BACKED = /^Batch (\d+) of (\d+) backed \(selection (\w+)\)\./;

/** The record keys a report lists under its questions line (`questions: <count>`), and that count; null when it has no such line. */
function questionsOf(report: string): { count: number; keys: string[] } | null {
  const m = /^questions:\s*(\d+)\s*$/m.exec(report);
  if (!m) return null;
  const rest = report.slice((m.index ?? 0) + m[0].length);
  const block = rest.split(/\n\s*\n/)[0] ?? "";
  // A key ends before the punctuation a list puts after it ("trace:s/k: why", "(trace:s/k).")
  const keys = [...block.matchAll(/(?:trace|harvest|glean):[^\s`'"),]+/g)].map((k) =>
    k[0].replace(/[.:;]+$/, ""),
  );
  return { count: Number(m[1]), keys: [...new Set(keys)] };
}

/** One run graded against the diff's expected verdicts. */
export function gradeRun(
  dir: string,
  expect: Record<string, Expected>,
  o: { forbidden: string[]; runs: string },
): RunGrade {
  const result = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8")) as {
    run: string;
    host: string;
    diff: string;
    status: number | null;
    reason: string | null;
  };
  const grade: RunGrade = {
    run: result.run,
    host: result.host,
    diff: result.diff,
    state: "failed",
    reason: null,
    records: [],
  };
  const read = (f: string) =>
    fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), "utf8") : "";
  const events = read("events.jsonl");
  const report = read("final.md").trim();
  const outside = lookedOutside(events, { ...o, run: result.run });
  if (outside) return { ...grade, state: "excluded", reason: outside };
  if (result.status !== 0) return { ...grade, reason: result.reason ?? `exit ${result.status}` };

  // Every batch backed by a check that review_check accepted, under one selection
  const backed = new Map<number, Finding[]>();
  let total: number | null = null;
  const selections = new Set<string>();
  for (const c of mcpCalls(result.host, events)) {
    const m = c.tool === "review_check" ? BACKED.exec(c.text ?? "") : null;
    if (!m) continue;
    total = Number(m[2]);
    selections.add(m[3] ?? "");
    backed.set(Number(m[1]), (c.args.findings ?? []) as Finding[]);
  }
  const expected = Object.keys(expect);
  if (expected.length && total === null) return { ...grade, reason: "no batch was backed by review_check" };
  if (selections.size > 1) return { ...grade, reason: `batches backed under ${selections.size} selections` };
  for (let k = 1; k <= (total ?? 0); k++)
    if (!backed.has(k)) return { ...grade, reason: `batch ${k} of ${total} not backed` };

  // The line may come inside a fence of its own: the fence lines are not text after it
  const lines = report.split("\n").filter((l) => l.trim() && !/^```\w*$/.test(l.trim()));
  const completion = lines.at(-1)?.trim() ?? "";
  const count = lines.filter((l) => l.trim().startsWith("completion:")).length;
  if (count > 1) return { ...grade, reason: `the report has ${count} completion lines` };
  const done = /^completion: lane=precedent model=(\w+) coverage=(\w+) unfinished=(.+) findings=(\d+)$/.exec(
    completion,
  );
  if (!done) return { ...grade, reason: "the report does not end with a completion line" };
  if (done[1] !== result.host) return { ...grade, reason: `the completion line names model ${done[1]}` };
  if (done[2] !== "COMPLETE") return { ...grade, reason: `coverage ${done[2]}: ${done[3]}` };
  if (done[3]?.trim() !== "none") return { ...grade, reason: `COMPLETE with unfinished scope: ${done[3]}` };
  // The count may carry a note after it ("findings: 1 (informational)")
  const listed = /^findings:\s*(\d+)\b/m.exec(report)?.[1];
  if (listed !== done[4])
    return {
      ...grade,
      reason: `the completion line says findings=${done[4]}, the list says ${listed ?? "nothing"}`,
    };

  const verdicts = new Map([...backed.values()].flat().map((f) => [f.unit, f.outcome]));
  // A violation backed but left out of the report never reached the reader
  const violations = [...verdicts.values()].filter((o) => o === "violation").length;
  if (violations > Number(listed))
    return {
      ...grade,
      reason: `${violations} violations backed, ${listed} findings reported: some were not reported`,
    };
  const asked = new Set(questionsOf(report)?.keys ?? []);
  for (const [key, e] of Object.entries(expect)) {
    const got = verdicts.get(key) ?? null;
    if (got === null) return { ...grade, reason: `${key} has no backed verdict` };
    grade.records.push({
      key,
      got,
      falseViolation: got === "violation" && !e.outcomes.includes("violation"),
      // Missed only where violation is the one right verdict: a record that allows any verdict cannot be missed
      missed: e.outcomes.every((x) => x === "violation") && got !== "violation",
      mismatch: !e.outcomes.includes(got),
      asked: asked.has(key),
      question: e.question,
    });
  }
  return { ...grade, state: "graded" };
}

type Tally = {
  runs: number;
  graded: number;
  failed: number;
  excluded: number;
  falseViolations: number;
  missed: number;
  mismatches: number;
  questionsAsked: number;
  questionsExpected: number;
  extraQuestions: number;
};
const empty = (): Tally => ({
  runs: 0,
  graded: 0,
  failed: 0,
  excluded: 0,
  falseViolations: 0,
  missed: 0,
  mismatches: 0,
  questionsAsked: 0,
  questionsExpected: 0,
  extraQuestions: 0,
});

/** Counts per host and per host and diff. A failed or excluded run adds to its own column, never to the verdict counts. */
export function tally(grades: RunGrade[]): Map<string, Tally> {
  const out = new Map<string, Tally>();
  const add = (key: string, g: RunGrade) => {
    const t = out.get(key) ?? empty();
    out.set(key, t);
    t.runs++;
    if (g.state !== "graded") {
      t[g.state]++;
      return;
    }
    t.graded++;
    for (const r of g.records) {
      if (r.falseViolation) t.falseViolations++;
      if (r.missed) t.missed++;
      if (r.mismatch) t.mismatches++;
      if (r.question) t.questionsExpected++;
      if (r.question && r.asked) t.questionsAsked++;
      if (!r.question && r.asked) t.extraQuestions++;
    }
  };
  for (const g of grades) {
    add(g.host, g);
    add(`${g.host} ${g.diff}`, g);
  }
  return out;
}

/** Every run directory under runs, graded. */
/**
 * Throws when the runs of one host in a directory were made under different settings (body, read server, model, CLI, cases): a tally of
 * them would mix two treatments. A directory is one measurement.
 */
export function oneConfiguration(runs: string, names: string[]): void {
  const seen = new Map<string, Set<string>>();
  for (const n of names) {
    const file = path.join(runs, n, "result.json");
    if (!fs.existsSync(file)) continue;
    const r = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const config = ["model", "cli", "body_sha256", "server_sha256", "cases_sha256", "runner_sha256"]
      .map((k) => String(r[k] ?? ""))
      .join(" ");
    const host = String(r.host);
    seen.set(host, (seen.get(host) ?? new Set()).add(config));
  }
  for (const [host, configs] of seen)
    if (configs.size > 1)
      throw new Error(
        `${runs} holds ${host} runs made under ${configs.size} settings: grade each from its own directory`,
      );
}

/** A run directory that never got its result: runLane always writes one, so its absence is a failure, never a run that did not happen */
const unfinished = (name: string): RunGrade => ({
  run: name,
  host: /-(claude|codex)-/.exec(name)?.[1] ?? "unknown",
  diff: name.replace(/-(claude|codex)-.*$/, ""),
  state: "failed",
  reason: "no result.json",
  records: [],
});

export function gradeAll(runs: string): RunGrade[] {
  const diffs = new Map(loadReviewCases().diffs.map((d) => [d.id, d.expect]));
  const forbidden = [path.resolve(import.meta.dirname, "..", "..", "..")];
  // A precedent run's directory, as runLane names it: rules runs, M2, the preflight, and the fixture share the output root
  const lane = new RegExp(`^(?:${[...diffs.keys()].join("|")})-(?:claude|codex)-\\d{4}-`);
  const names = fs
    .readdirSync(runs, { withFileTypes: true })
    .filter((e) => e.isDirectory() && lane.test(e.name))
    .map((e) => e.name)
    .sort();
  oneConfiguration(runs, names);
  return names.map((n) => {
    const dir = path.join(runs, n);
    if (!fs.existsSync(path.join(dir, "result.json"))) return unfinished(n);
    const diff = (JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8")) as { diff: string })
      .diff;
    return gradeRun(dir, diffs.get(diff) ?? {}, { forbidden, runs });
  });
}

function main() {
  const { values: args } = parseArgs({
    options: { report: { type: "string" }, against: { type: "string" } },
  });
  if (!args.report) throw new Error("--report <runs dir> names the runs to grade");
  const now = tally(gradeAll(path.resolve(args.report)));
  const before = args.against ? tally(gradeAll(path.resolve(args.against))) : null;
  const cols: (keyof Tally)[] = [
    "runs",
    "graded",
    "failed",
    "excluded",
    "falseViolations",
    "missed",
    "mismatches",
    "questionsAsked",
    "questionsExpected",
    "extraQuestions",
  ];
  console.log(`| | ${cols.join(" | ")} |\n|${"---|".repeat(cols.length + 1)}`);
  for (const [key, t] of [...now].sort(([a], [b]) => a.localeCompare(b))) {
    const b = before?.get(key);
    console.log(
      `| ${key} | ${cols.map((c) => (b ? `${t[c]} (${t[c] - b[c] >= 0 ? "+" : ""}${t[c] - b[c]})` : String(t[c]))).join(" | ")} |`,
    );
  }
}

if (process.argv[1] === import.meta.filename) main();
