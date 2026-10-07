// Collects one loop of the evaluation (plan step 9): every claude/eval-* branch of the bootstrap repositories, matched to its task by the
// prompt the hooks received, plus the local Codex runs. For each run it records the hidden tests, what was delivered, and the failure signals
// in the run log (searches that found nothing, reads that found nothing, tool errors, Sphica calls, turns, time), and writes one table.
// Run logs of cloud runs are saved by hand from the routine API into <logs>/<branch session id>.log (the harness never holds the token).
// Local Claude runs (claude.ts) are collected the same way as the Codex runs, from their run directories.
// Run: node evals/cloud/collect.ts [--build <dir>] [--logs <dir>] [--codex <dir>] [--claude <dir>] [--no-cloud [--local-plan <json>]]
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
  lookedOutside,
  presentedText,
  searchedBeforeEdit,
  searchLoading,
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
    // Record hidden tests as not run instead of stopping where they cannot be sandboxed (not macOS)
    "skip-hidden-tests": { type: "boolean", default: false },
    // The local runs asked for, as [{ model, task, condition, n }]: what was not run, ran past n, or was not asked for stays as excluded
    "local-plan": { type: "string" },
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
  matchers?: Record<string, string>;
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

const PARTS = ["completion", "compliance", "poison"] as const;
type Parts = Record<(typeof PARTS)[number], "pass" | "fail" | null>;
const NO_PARTS: Parts = { completion: null, compliance: null, poison: null };

type Row = {
  model: "claude" | "codex";
  task: string;
  condition: string;
  run: string;
  /** Why the run is not a result (it still counts in the denominator); null for a result */
  excluded: string | null;
  tests: string;
  /** The hidden test's outcome per part, by test name prefix (`completion:`, `compliance:`, `poison:`); null when the task has no such test or it did not run */
  parts: Parts;
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
  /** The concrete model a local run used (Claude's --model, Codex's configured model and effort); null when it was not recorded */
  agent_model: string | null;
  /** Local Claude runs only: whether a Sphica search came before the first change to the work tree */
  search_before_edit: "yes" | "no" | "no_edit" | "unknown" | "not_applicable";
  /** Local Claude runs only: whether Sphica's search was held back for ToolSearch or there from the start */
  search_loading: "deferred" | "loaded" | "unknown" | "not_applicable";
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
  parts: NO_PARTS,
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
  search_loading: "not_applicable",
  agent_model: null,
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

/** n is the runs wanted; max (default n) caps the runs started, so runs past n stand in for excluded ones until max */
type LocalPlan = { model: "claude" | "codex"; task: string; condition: string; n: number; max?: number }[];

/**
 * Each planned cell keeps its runs by start until n are results (not excluded, every hidden test part known) or max have started; the
 * rest are excluded, and runs still owed join the denominator. The cap is fixed in advance, so no sample is topped up after its outcome.
 */
function reconcileLocal<
  R extends { model: string; task: string; condition: string; run: string; excluded: string | null },
>(
  rows: R[],
  plan: LocalPlan,
  startedOf: (r: R) => string,
  known: (r: R) => boolean,
  missing: (model: "claude" | "codex", task: string, condition: string, n: number) => R = (
    model,
    task,
    condition,
    n,
  ) => excludedRow(model, task, condition, `planned#${n}`, "planned but not run") as unknown as R,
): R[] {
  const out: R[] = [];
  const key = (x: { model: string; task: string; condition: string }) =>
    `${x.model}\0${x.task}\0${x.condition}`;
  const wanted = new Map(plan.map((p) => [key(p), p]));
  const groups = new Map<string, R[]>();
  const taken = new Map<string, { kept: number; results: number }>();
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  for (const [k, group] of groups) {
    const p = wanted.get(k);
    const ordered = [...group].sort((a, b) => startedOf(a).localeCompare(startedOf(b)));
    let kept = 0;
    let results = 0;
    for (const r of ordered) {
      if (!p) {
        out.push({ ...r, excluded: "not in the local plan" });
      } else if (kept < (p.max ?? p.n) && results < p.n) {
        kept++;
        if (!r.excluded && known(r)) results++;
        out.push(r);
      } else out.push({ ...r, excluded: "beyond the planned runs" });
    }
    if (p) taken.set(k, { kept, results });
  }
  // Runs still allowed to start stand in for the results missing, so a short sample shows in the denominator
  for (const p of plan) {
    const { kept, results } = taken.get(key(p)) ?? { kept: 0, results: 0 };
    const owed = Math.min((p.max ?? p.n) - kept, p.n - results);
    for (let i = 0; i < owed; i++) out.push(missing(p.model, p.task, p.condition, kept + i + 1));
  }
  return out;
}

/** A path as an SBPL string literal. */
const sbpl = (p: string) => JSON.stringify(p);

/** Whether any link in the checkout (outside .git) resolves outside it, or cannot be resolved. */
function linksOutside(work: string): boolean {
  const inside = fs.realpathSync(work);
  const walk = (dir: string): boolean =>
    fs.readdirSync(dir, { withFileTypes: true }).some((e) => {
      const full = path.join(dir, e.name);
      if (e.name === ".git" && dir === work) return false;
      if (e.isSymbolicLink()) {
        try {
          const target = fs.realpathSync(full);
          return target !== inside && !target.startsWith(inside + path.sep);
        } catch {
          return true;
        }
      }
      return e.isDirectory() ? walk(full) : false;
    });
  return walk(work);
}

/**
 * Runs a task's hidden test against a checkout; "none" when the task has none. The checkout holds an agent's patch, so the test runs only
 * on macOS, in sandbox-exec without network, under Node's permission model (reads only the checkout, no writes or child processes), with no inherited environment.
 */
function hiddenTest(work: string, task: Task): { tests: string; parts: Parts } {
  const unparted = (tests: string) => ({ tests, parts: NO_PARTS });
  if (!task.test) return unparted("none");
  // The hidden test checks the original record's rule, which a swapped run is not given
  if (swapped) return unparted("not run (swapped variant)");
  if (args["skip-hidden-tests"]) return unparted("not run (--skip-hidden-tests)");
  // Scores without the hidden tests would read as a complete comparison, so a collector that cannot sandbox them stops
  if (process.platform !== "darwin")
    throw new Error(
      "hidden tests run only on macOS, where sandbox-exec denies network; collect there, or pass --skip-hidden-tests to record them as not run",
    );
  if (!fs.existsSync(work)) return unparted("not run (no checkout)");
  // A link the patch made can point the task module at a file outside the checkout: such a run fails its hidden test without running it
  if (linksOutside(work))
    return {
      tests: "0 passed, 1 failed (a link in the checkout points outside it)",
      parts: NO_PARTS,
    };
  // The write happens before the sandbox: a test/ or hidden.test.ts the branch made a symlink would send it outside the checkout
  const testDir = path.join(work, "test");
  const dirStat = fs.lstatSync(testDir, { throwIfNoEntry: false });
  if (dirStat && !dirStat.isDirectory())
    return unparted("not run (test/ in the branch is not a plain directory)");
  fs.mkdirSync(testDir, { recursive: true });
  const file = path.join(testDir, "hidden.test.ts");
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, task.test, { flag: "wx" });
  const inside = fs.realpathSync(work);
  const r = spawnSync(
    "/usr/bin/sandbox-exec",
    [
      "-p",
      // No network, and no file contents under the home directory but the checkout's and the Node's that runs the test (metadata stays
      // readable: Node stats the checkout's parents)
      `(version 1)(allow default)(deny network*)(deny file-read-data (subpath ${sbpl(os.homedir())}))(allow file-read-data (subpath ${sbpl(inside)}) (subpath ${sbpl(path.dirname(path.dirname(fs.realpathSync(process.execPath))))}))`,
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
  return { tests: `${pass} passed, ${fail} failed`, parts: partsOf(task.test, r.stdout) };
}

/**
 * Each part the test source names, from the runner's lines before its failure list: a part passes only when each of its tests has exactly
 * one line, a pass, and the runner's one count of tests matches the source. The agent's code runs in the same process and can print lines
 * that read like the runner's; a name with two lines, a second count, or no count (it exited before the tests) leaves the part unknown.
 * Code that forges every line, the count included, is not caught here.
 */
function partsOf(source: string, stdout: string): Parts {
  const parts = { ...NO_PARTS };
  const all = [...source.matchAll(/\btest\(\s*"[^"]*"/g)].length;
  const lines = stdout.split("\n");
  const end = lines.indexOf("✖ failing tests:");
  const run = end < 0 ? lines : lines.slice(0, end);
  const counts = run.filter((l) => l.startsWith("ℹ tests "));
  if (counts.length !== 1 || counts[0] !== `ℹ tests ${all}`) return parts;
  for (const part of PARTS) {
    const names = [...source.matchAll(new RegExp(`\\btest\\(\\s*"(${part}:[^"]*)"`, "g"))].map(
      (m) => m[1] ?? "",
    );
    if (!names.length) continue;
    const marks = names.map((n) => run.filter((l) => l.startsWith(`✔ ${n} (`) || l.startsWith(`✖ ${n} (`)));
    if (marks.some((m) => m.length !== 1)) continue;
    parts[part] = marks.every((m) => m[0]?.startsWith("✔")) ? "pass" : "fail";
  }
  return parts;
}

/** The task a run carried out: by the prompt its hooks received, else the build's only task (slots built before every slot logged prompts) */
const built = plan.tasks.filter((t) => t.project === manifest.project);
const taskOf = (text: string, firing: FiringRow[]) => {
  const id = taskFromReceipts(text, firing, plan.tasks);
  return plan.tasks.find((t) => t.id === id) ?? (built.length === 1 ? built[0] : undefined);
};

function main() {
  const rows: Row[] = [];
  // The firing plan is the denominator of cloud runs: every fired row is one run asked for, with its task, even when it pushed no branch.
  // Without cloud runs the local plan is the denominator, and the build's cloud rows would only stand in for runs never looked for
  const firing = !args["no-cloud"] && Object.keys(manifest.repositories).length ? readPlan(build) : [];
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
          ...hiddenTest(work, task),
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
          search_loading: "unknown",
          agent_model: null,
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
        claude_model?: string;
        codex_model?: string | null;
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
      // A run that reached another run, the build, or the evaluation cache may have read answers or gold records it was not given
      const own = [dir, fs.realpathSync(dir)];
      // Both models' run places: a Codex run must not read a Claude run's answer, nor the other way round
      const places = [build, path.resolve(args.codex ?? ""), path.resolve(args.claude ?? ""), CACHE].flatMap(
        (p) => [p, fs.existsSync(p) ? fs.realpathSync(p) : p],
      );
      if (lookedOutside(read("events.jsonl"), own, places)) {
        rows.push(
          excludedRow(
            model,
            result.task,
            result.condition,
            name,
            "looked outside its checkout (other runs, the build, or the evaluation cache)",
          ),
        );
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
        ...hiddenTest(path.join(dir, "work"), task),
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
        search_loading: model === "claude" ? searchLoading(events) : "not_applicable",
        agent_model: result.claude_model ?? result.codex_model ?? null,
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
  if (args["local-plan"]) {
    if (!args["no-cloud"])
      throw new Error("--local-plan reconciles local runs only; pass --no-cloud with it");
    const asked = JSON.parse(fs.readFileSync(args["local-plan"], "utf8")) as LocalPlan;
    const whole = (x: unknown, least: number) => Number.isInteger(x) && (x as number) >= least;
    for (const p of asked)
      if (!whole(p.n, 1) || (p.max !== undefined && !whole(p.max, p.n)))
        throw new Error(
          `the local plan's ${p.task} ${p.condition}: n must be a whole number from 1, and max one from n`,
        );
    const startedOf = (r: Row) => {
      const file = path.join(
        r.model === "codex" ? (args.codex ?? "") : (args.claude ?? ""),
        r.run,
        "started.json",
      );
      try {
        return String((JSON.parse(fs.readFileSync(file, "utf8")) as { at?: string }).at ?? "");
      } catch {
        return "";
      }
    };
    // A part the task's hidden test names but the run left unknown makes the run no result, so another run may stand in for it
    const named = (r: Row) =>
      PARTS.filter((p) => plan.tasks.find((t) => t.id === r.task)?.test?.includes(`"${p}:`));
    const reconciled = reconcileLocal(rows, asked, startedOf, (r) =>
      named(r).every((p) => r.parts[p] !== null),
    );
    rows.length = 0;
    rows.push(...reconciled);
  }
  fs.writeFileSync(
    out,
    `${JSON.stringify({ build: manifest.build ?? null, variant: manifest.variant ?? "original", bundle: `${manifest.commit} ${JSON.stringify({ ...manifest.bundle, ...(manifest.matchers ? { matchers: manifest.matchers } : {}) })}`, collected: new Date().toISOString(), rows }, null, 2)}\n`,
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
