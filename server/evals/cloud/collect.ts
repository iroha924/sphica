// Collects one loop of the evaluation (plan step 9): every claude/eval-* branch of the bootstrap repositories, matched to its task by the
// prompt the hooks received, plus the local Codex runs. For each run it records the hidden tests, what was delivered, and the failure signals
// in the run log (searches that found nothing, reads that found nothing, tool errors, Sphica calls, turns, time), and writes one table.
// Run logs of cloud runs are saved by hand from the routine API into <logs>/<branch session id>.log (the harness never holds the token).
// Local Claude runs (claude.ts) are collected the same way as the Codex runs, from their run directories.
// Run: node evals/cloud/collect.ts [--build <dir>] [--logs <dir>] [--codex <dir>] [--claude <dir>] [--no-cloud]
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { type FiringRow, pair, readPlan, readTasks, taskFromReceipts } from "./firing.ts";
import {
  answerFormat,
  capPatch,
  claudeStreamCalls,
  deliveredSignal,
  foundInClaudeLog,
  foundInClaudeStream,
  foundInCodexEvents,
  type GoldSignal,
  goldNotGiven,
  goldSignalsFromClaude,
  goldSignalsFromClaudeStream,
  goldSignalsFromCodex,
  presentedText,
  searchedBeforeEdit,
  type Tri,
} from "./judge.ts";

const CACHE = path.join(os.homedir(), ".cache", "sphica-eval");
const { values: args } = parseArgs({
  options: {
    build: { type: "string" },
    logs: { type: "string", default: path.join(CACHE, "logs") },
    codex: { type: "string", default: path.join(CACHE, "codex-runs") },
    claude: { type: "string", default: path.join(CACHE, "claude-runs") },
    // A build run only locally: skip fetching result branches from the slot repositories
    "no-cloud": { type: "boolean", default: false },
  },
});

type Task = { id: string; prompt: string; test?: string; project?: string; gold?: string[] };
const build = args.build ?? "";
if (!build)
  throw new Error("--build <dir> names the build to collect (~/.cache/sphica-eval/builds/<build id>)");
const plan = readTasks<{ tasks: Task[]; swapped: { tasks: Record<string, string[]> } }>(build);
// grade reads tasks.json beside loop.json, so it is always written into the build
const out = path.join(build, "loop.json");
const manifest = JSON.parse(fs.readFileSync(path.join(build, "manifest.json"), "utf8")) as {
  build?: string;
  variant?: string;
  commit: string;
  bundle?: Record<string, string>;
  project?: string;
  repositories: Record<string, { condition: string }>;
};
const swapped = manifest.variant === "swapped";
/** A swapped build's gold is the swapped record, not the task's original one */
const goldOf = (task: Task) => (swapped ? (plan.swapped.tasks[task.id] ?? []) : (task.gold ?? []));
/** The gold slot's rendering of a counterfactual task's record: what the grader checks the run followed. Other tasks have none. */
const goldSlot = Object.entries(manifest.repositories).find(([, r]) => r.condition === "gold")?.[0];
const shown = goldSlot
  ? (JSON.parse(fs.readFileSync(path.join(build, goldSlot, ".tools", "gold.json"), "utf8")) as {
      id: string;
      text: string;
    }[])
  : [];
const presentedOf = (task: Task, condition: string) =>
  presentedText(task.id, condition, shown, plan.swapped.tasks);

type Row = {
  model: "claude" | "codex";
  task: string;
  condition: string;
  run: string;
  /** Why the run is not a result (it still counts in the denominator); null for a result */
  excluded: string | null;
  tests: string;
  /** The final answer as the grader reads it (Codex's schema answer rendered to text) */
  answer: string;
  answer_format: "valid" | "invalid" | "refused_or_empty" | "not_applicable";
  answer_format_reason: string | null;
  patch: string;
  patch_truncated: boolean;
  gold: string[];
  delivered: "yes" | "no" | "not_applicable";
  delivered_units: string[];
  found: Tri;
  /** The same, per gold key and kept apart: delivered, in a search result, shown by a read */
  gold_signals: Record<string, GoldSignal>;
  presented: string | null;
  /** Local Claude runs only: whether a Sphica search came before the first change to the work tree */
  search_before_edit: "yes" | "no" | "no_edit" | "unknown" | "not_applicable";
  signals: {
    searches: number;
    empty_searches: number;
    reads_not_found: number;
    tool_errors: number;
    turns: number | null;
    seconds: number | null;
  } | null;
};

/** A run that is not a result, kept so the report's denominator holds every run that was started */
const excludedRow = (
  model: Row["model"],
  task: string,
  condition: string,
  run: string,
  reason: string,
): Row => ({
  model,
  task,
  condition,
  run,
  excluded: reason,
  tests: "none",
  answer: "",
  answer_format: "not_applicable",
  answer_format_reason: null,
  patch: "",
  patch_truncated: false,
  gold: ((t) => (t ? goldOf(t) : []))(plan.tasks.find((t) => t.id === task)),
  delivered: "not_applicable",
  delivered_units: [],
  found: "unknown",
  gold_signals: {},
  presented: null,
  search_before_edit: "not_applicable",
  signals: null,
});

const NO_GOLD = "gold hook returned no record";

const withoutStart = ({ started: _started, ...r }: Row & { started: string }): Row => r;

/** Failure signals in a run's text: a routine run log, or Codex's JSONL events. */
function signals(log: string): NonNullable<Row["signals"]> {
  const count = (re: RegExp) => (log.match(re) ?? []).length;
  const result = /result: \w+ is_error=\w+ turns=(\d+) duration=(\d+)s/.exec(log);
  return {
    // A routine log names the tool mcp__sphica__search; Codex's events start each call as an item with server and tool
    searches: count(
      /mcp__sphica__search\b|"type":"item\.started","item":\{[^}]*"server":"sphica","tool":"search"/g,
    ),
    empty_searches: count(/No record holds most of|No source holds most of/g),
    reads_not_found: count(/not found in this project/g),
    tool_errors: count(/tool_result ERROR|"status":"failed"/g),
    turns: result ? Number(result[1]) : null,
    seconds: result ? Number(result[2]) : null,
  };
}

/** The same signals from a local Claude run's stream-json, where each call carries its own result. */
function streamSignals(events: string): NonNullable<Row["signals"]> {
  const { calls } = claudeStreamCalls(events);
  const searches = calls.filter((c) => c.name === "mcp__sphica__search");
  const turns = events
    .split("\n")
    .flatMap((l) => {
      try {
        const e = JSON.parse(l) as { type?: string; num_turns?: number };
        return e.type === "result" && typeof e.num_turns === "number" ? [e.num_turns] : [];
      } catch {
        return [];
      }
    })
    .at(-1);
  return {
    searches: searches.length,
    empty_searches: searches.filter((c) =>
      /No record holds most of|No source holds most of/.test(c.result ?? ""),
    ).length,
    reads_not_found: calls.filter(
      (c) => c.name === "mcp__sphica__read" && /not found in this project/.test(c.result ?? ""),
    ).length,
    tool_errors: calls.filter((c) => c.error).length,
    turns: turns ?? null,
    seconds: null,
  };
}

/**
 * Runs a task's hidden test against a checkout; "none" when the task has none. The checkout holds an agent's patch, so the test runs only
 * on macOS, in sandbox-exec without network, under Node's permission model (reads only the checkout, no writes or child processes), with no inherited environment.
 */
function hiddenTest(work: string, task: Task): string {
  if (!task.test) return "none";
  // The hidden test checks the original record's rule, which a swapped run is not given
  if (swapped) return "not run (swapped variant)";
  if (process.platform !== "darwin")
    return "not run (hidden tests run only on macOS, where sandbox-exec denies network)";
  // The write happens before the sandbox: a test/ or hidden.test.ts the branch made a symlink would send it outside the checkout
  const testDir = path.join(work, "test");
  const dirStat = fs.lstatSync(testDir, { throwIfNoEntry: false });
  if (dirStat && !dirStat.isDirectory()) return "not run (test/ in the branch is not a plain directory)";
  fs.mkdirSync(testDir, { recursive: true });
  const file = path.join(testDir, "hidden.test.ts");
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, task.test, { flag: "wx" });
  const inside = fs.realpathSync(work);
  const r = spawnSync(
    "/usr/bin/sandbox-exec",
    [
      "-p",
      "(version 1)(allow default)(deny network*)",
      process.execPath,
      "--permission",
      `--allow-fs-read=${inside}`,
      "--test",
      "--test-isolation=none",
      "test/hidden.test.ts",
    ],
    { cwd: work, encoding: "utf8", timeout: 300_000, env: { PATH: "/usr/bin:/bin", HOME: inside } },
  );
  const pass = /^ℹ pass (\d+)/m.exec(r.stdout)?.[1] ?? "0";
  const fail = /^ℹ fail (\d+)/m.exec(r.stdout)?.[1] ?? "?";
  return `${pass} passed, ${fail} failed`;
}

/** The task a run carried out: by the prompt its hooks received, else the build's only task (slots built before every slot logged prompts) */
const built = plan.tasks.filter((t) => t.project === manifest.project);
const taskOf = (text: string, firing: FiringRow[]) => {
  const id = taskFromReceipts(text, firing, plan.tasks);
  return plan.tasks.find((t) => t.id === id) ?? (built.length === 1 ? built[0] : undefined);
};

function main() {
  const rows: Row[] = [];
  // The firing plan is the denominator: every fired row is one run asked for, with its task, even when it pushed no branch
  const firing = Object.keys(manifest.repositories).length ? readPlan(build) : [];
  const claude: (Row & { started: string })[] = [];
  const cloud = args["no-cloud"] ? [] : Object.entries(manifest.repositories);
  for (const [repo, { condition }] of cloud) {
    const dir = path.join(build, repo);
    execFileSync("git", [
      "-C",
      dir,
      "fetch",
      "-q",
      "--prune",
      "origin",
      "+refs/heads/claude/eval-*:refs/remotes/origin/claude/eval-*",
    ]);
    const branches = execFileSync("git", ["-C", dir, "branch", "-r", "--list", "origin/claude/eval-*"], {
      encoding: "utf8",
    })
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean);
    for (const branch of branches) {
      // A branch left from an earlier build ran another bundle and fixture: it is not this loop's result
      if (spawnSync("git", ["-C", dir, "merge-base", "--is-ancestor", "main", branch]).status !== 0) {
        console.log(`${repo} ${branch}: not built on this loop's slot, left out`);
        continue;
      }
      const show = (file: string) =>
        spawnSync("git", ["-C", dir, "show", `${branch}:${file}`], { encoding: "utf8" }).stdout ?? "";
      const receipts = show(".eval/receipts.jsonl");
      const task = taskOf(receipts, firing);
      if (!task) continue;
      const work = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-collect-"));
      try {
        execFileSync("git", ["-C", dir, "worktree", "add", "-q", "--detach", work, branch]);
        // A reused container keeps an earlier run's database copy: count only deliveries after this session's first receipt
        const started =
          receipts
            .split("\n")
            .flatMap((l) => (l.trim() ? [(JSON.parse(l) as { at: string }).at] : []))
            .sort()[0] ?? "";
        const deliveries = (
          JSON.parse(show(".eval/deliveries.json") || "[]") as {
            outcome: string;
            units: string;
            at: string;
          }[]
        ).filter((d) => d.at >= started);
        const session = branch.replace("origin/claude/eval-", "");
        const logFile = path.join(args.logs ?? "", `${session}.log`);
        const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : null;
        const gold = goldOf(task);
        const emitted = deliveries
          .filter((d) => d.outcome === "emitted")
          .flatMap((d) => JSON.parse(d.units) as string[]);
        // The gold hook's receipt holds what it returned to the session
        const goldOut = receipts
          .split("\n")
          .flatMap((l) => (l.trim() ? [JSON.parse(l) as { name: string; output?: string }] : []))
          .filter((r) => r.name === "gold")
          .map((r) => r.output ?? "")
          .join("\n");
        if (goldNotGiven(condition, gold, goldOut || null)) {
          claude.push({ ...excludedRow("claude", task.id, condition, session, NO_GOLD), started });
          continue;
        }
        const diff = execFileSync(
          "git",
          ["-C", dir, "diff", "main", branch, "--", ".", ":!.tools", ":!.eval"],
          {
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
          },
        );
        const cut = capPatch(diff);
        claude.push({
          started,
          model: "claude",
          task: task.id,
          condition,
          run: session,
          excluded: null,
          tests: hiddenTest(work, task),
          answer: show(".eval/answer.md"),
          answer_format: "not_applicable",
          answer_format_reason: null,
          patch: cut.patch,
          patch_truncated: cut.truncated,
          gold,
          delivered: deliveredSignal(condition, gold, emitted, goldOut || null),
          delivered_units: emitted,
          found: foundInClaudeLog(log, gold),
          gold_signals: goldSignalsFromClaude(condition, gold, emitted, goldOut || null, log),
          presented: presentedOf(task, condition),
          // A routine log has no record of the work tree between calls
          search_before_edit: "unknown",
          signals: log === null ? null : signals(log),
        });
      } finally {
        execFileSync("git", ["-C", dir, "worktree", "remove", "--force", work]);
      }
    }
  }
  const { matched, missing, unplanned } = pair(firing, claude);
  for (const [, r] of matched) rows.push(withoutStart(r));
  for (const r of unplanned) {
    console.log(`${r.run}: ${r.task} ${r.condition} ran but the firing plan did not ask for it; kept`);
    rows.push(withoutStart(r));
  }
  for (const f of missing)
    rows.push(excludedRow("claude", f.task, f.condition, `${f.slot}#${f.try}`, "no result branch"));
  for (const [model, runs] of [
    ["codex", args.codex ?? ""],
    ["claude", args.claude ?? ""],
  ] as const) {
    if (!fs.existsSync(runs)) continue;
    for (const name of fs.readdirSync(runs)) {
      const dir = path.join(runs, name);
      const read = (file: string) =>
        fs.existsSync(path.join(dir, file)) ? fs.readFileSync(path.join(dir, file), "utf8") : null;
      // started.json is the denominator: a run that started counts even when it left no result
      const startedAt = read("started.json");
      const resultText = read("result.json");
      if (!startedAt && !resultText) continue;
      const parse = <T>(text: string | null): T | null => {
        try {
          return text === null ? null : (JSON.parse(text) as T);
        } catch {
          return null;
        }
      };
      const head = parse<{ task: string; condition: string; build?: string }>(startedAt) ??
        parse<{ task: string; condition: string; build?: string }>(resultText) ?? {
          task: "unknown",
          condition: "unknown",
        };
      // Codex runs of every build share one directory: a run of another build, or one without a build id, is not this build's
      if (manifest.build && head.build !== manifest.build) {
        console.log(`${name}: a run of build ${head.build ?? "without an id"}, left out`);
        continue;
      }
      if (!resultText) {
        rows.push(
          excludedRow(
            model,
            head.task,
            head.condition,
            name,
            "no result.json (the run stopped before it finished)",
          ),
        );
        continue;
      }
      const result = parse<{
        task: string;
        condition: string;
        seconds: number;
        status: number | null;
        reason?: string | null;
        deliveries?: { outcome: string; units: string[] }[] | null;
      }>(resultText);
      // Cut off while it was written: the run started, so it stays in the denominator
      if (!result) {
        rows.push(excludedRow(model, head.task, head.condition, name, "unreadable result.json"));
        continue;
      }
      // A run whose agent process failed (a timeout, a login error), or whose patch capture after it failed, says nothing about Sphica
      if (result.status !== 0 || result.reason) {
        rows.push(
          excludedRow(
            model,
            result.task,
            result.condition,
            name,
            result.reason ?? `${model} exited ${result.status}`,
          ),
        );
        continue;
      }
      // An inject run whose hooks logged nothing at all never had Sphica delivering
      if (result.condition === "inject" && !result.deliveries?.length) {
        rows.push(excludedRow(model, result.task, result.condition, name, "inject run with no delivery log"));
        continue;
      }
      const task = plan.tasks.find((t) => t.id === result.task);
      if (!task) {
        rows.push(excludedRow(model, result.task, result.condition, name, "unknown task"));
        continue;
      }
      const gold = goldOf(task);
      if (goldNotGiven(result.condition, gold, read("gold-receipt.txt"))) {
        rows.push(excludedRow(model, task.id, result.condition, name, NO_GOLD));
        continue;
      }
      const events = read("events.jsonl");
      const found = model === "codex" ? foundInCodexEvents(events, gold) : foundInClaudeStream(events, gold);
      const emitted = (result.deliveries ?? [])
        .filter((d) => d.outcome === "emitted")
        .flatMap((d) => d.units);
      // Codex answers in a fixed shape; Claude's answer is its final message, as on the cloud
      const answer =
        model === "codex"
          ? answerFormat(read("answer.json"))
          : { text: read("answer.md") ?? "", format: "not_applicable" as const, reason: null };
      const cut = capPatch(read("patch.diff") ?? "");
      const goldReceipt = read("gold-receipt.txt");
      rows.push({
        model,
        task: task.id,
        condition: result.condition,
        run: name,
        excluded: null,
        tests: hiddenTest(path.join(dir, "work"), task),
        answer: answer.text,
        answer_format: answer.format,
        answer_format_reason: answer.reason,
        patch: cut.patch,
        patch_truncated: cut.truncated,
        gold,
        delivered: deliveredSignal(result.condition, gold, emitted, goldReceipt),
        delivered_units: emitted,
        found,
        presented: presentedOf(task, result.condition),
        search_before_edit:
          model === "claude" ? searchedBeforeEdit(events, read("edits.jsonl")) : "not_applicable",
        gold_signals:
          model === "codex"
            ? goldSignalsFromCodex(result.condition, gold, emitted, goldReceipt, events)
            : goldSignalsFromClaudeStream(result.condition, gold, emitted, goldReceipt, events),
        // A missing or broken event log cannot say how many searches or errors there were
        signals:
          found === "unknown"
            ? null
            : model === "codex"
              ? { ...signals(events ?? ""), seconds: result.seconds }
              : { ...streamSignals(events ?? ""), seconds: result.seconds },
      });
    }
  }
  fs.writeFileSync(
    out,
    `${JSON.stringify({ build: manifest.build ?? null, variant: manifest.variant ?? "original", bundle: `${manifest.commit} ${JSON.stringify(manifest.bundle ?? {})}`, collected: new Date().toISOString(), rows }, null, 2)}\n`,
  );
  for (const r of rows)
    console.log(
      r.excluded
        ? [r.model, r.task, r.condition, `excluded: ${r.excluded}`].join("  ")
        : [
            r.model,
            r.task,
            r.condition,
            r.tests,
            `delivered=${r.delivered}`,
            `found=${r.found}`,
            `answer=${r.answer_format}`,
            `patch=${r.patch.length}${r.patch_truncated ? " (cut)" : ""}`,
            `search=${r.signals?.searches ?? "?"}/${r.signals?.empty_searches ?? "?"} empty`,
            `turns=${r.signals?.turns ?? "?"}`,
            `${r.signals?.seconds ?? "?"}s`,
          ].join("  "),
    );
}

main();
