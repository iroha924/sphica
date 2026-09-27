// Collects one loop of the evaluation (plan step 9): every claude/eval-* branch of the bootstrap repositories, matched to its task by the
// prompt the hooks received, plus the local Codex runs. For each run it records the hidden tests, what was delivered, and the failure signals
// in the run log (searches that found nothing, reads that found nothing, tool errors, Sphica calls, turns, time), and writes one table.
// Run logs of cloud runs are saved by hand from the routine API into <logs>/<branch session id>.log (the harness never holds the token).
// Run: node evals/cloud/collect.ts [--build <dir>] [--logs <dir>] [--codex <dir>] [--out <file>]
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const HERE = import.meta.dirname;
const CACHE = path.join(os.homedir(), ".cache", "sphica-eval");
const { values: args } = parseArgs({
  options: {
    build: { type: "string", default: path.join(CACHE, "build") },
    logs: { type: "string", default: path.join(CACHE, "logs") },
    codex: { type: "string", default: path.join(CACHE, "codex-runs") },
    out: { type: "string", default: path.join(CACHE, "loop.json") },
  },
});

type Task = { id: string; prompt: string; test?: string; project?: string };
const plan = JSON.parse(fs.readFileSync(path.join(HERE, "tasks.json"), "utf8")) as { tasks: Task[] };
const manifest = JSON.parse(fs.readFileSync(path.join(args.build ?? "", "manifest.json"), "utf8")) as {
  commit: string;
  project?: string;
  repositories: Record<string, { condition: string }>;
};

type Row = {
  model: "claude" | "codex";
  task: string;
  condition: string;
  run: string;
  tests: string;
  answer: string;
  delivered: string[];
  signals: {
    searches: number;
    empty_searches: number;
    reads_not_found: number;
    tool_errors: number;
    turns: number | null;
    seconds: number | null;
  };
};

/** Failure signals in a run's text: a routine run log, or Codex's JSONL events. */
function signals(log: string): Row["signals"] {
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

/** Runs a task's hidden test against a checkout; "none" when the task has none. */
function hiddenTest(work: string, task: Task): string {
  if (!task.test) return "none";
  fs.mkdirSync(path.join(work, "test"), { recursive: true });
  fs.writeFileSync(path.join(work, "test", "hidden.test.ts"), task.test);
  const r = spawnSync(process.execPath, ["--test", "test/hidden.test.ts"], { cwd: work, encoding: "utf8" });
  const pass = /^ℹ pass (\d+)/m.exec(r.stdout)?.[1] ?? "0";
  const fail = /^ℹ fail (\d+)/m.exec(r.stdout)?.[1] ?? "?";
  return `${pass} passed, ${fail} failed`;
}

/** The task a run carried out: by the prompt its hooks received, else the build's only task (slots built before every slot logged prompts) */
const built = plan.tasks.filter((t) => t.project === manifest.project);
const taskOf = (text: string) =>
  plan.tasks.find((t) => text.includes(t.prompt)) ?? (built.length === 1 ? built[0] : undefined);

function main() {
  const rows: Row[] = [];
  for (const [repo, { condition }] of Object.entries(manifest.repositories)) {
    const dir = path.join(args.build ?? "", repo);
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
      const show = (file: string) =>
        spawnSync("git", ["-C", dir, "show", `${branch}:${file}`], { encoding: "utf8" }).stdout ?? "";
      const receipts = show(".eval/receipts.jsonl");
      const task = taskOf(receipts);
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
        rows.push({
          model: "claude",
          task: task.id,
          condition,
          run: session,
          tests: hiddenTest(work, task),
          answer: show(".eval/answer.md"),
          delivered: deliveries
            .filter((d) => d.outcome === "emitted")
            .flatMap((d) => JSON.parse(d.units) as string[]),
          signals: signals(fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : ""),
        });
      } finally {
        execFileSync("git", ["-C", dir, "worktree", "remove", "--force", work]);
      }
    }
  }
  if (fs.existsSync(args.codex ?? ""))
    for (const name of fs.readdirSync(args.codex ?? "")) {
      const dir = path.join(args.codex ?? "", name);
      // A run still in progress has no result yet
      if (!fs.existsSync(path.join(dir, "result.json"))) continue;
      const result = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8")) as {
        task: string;
        condition: string;
        seconds: number;
        status: number | null;
        deliveries?: { outcome: string; units: string[] }[] | null;
      };
      // A run whose Codex process failed (a timeout, a login error) says nothing about Sphica: it is not a result
      if (result.status !== 0) {
        console.log(`${name}: codex exited ${result.status}, left out`);
        continue;
      }
      // An inject run whose hooks logged nothing at all never had Sphica delivering: it is not a result
      if (result.condition === "inject" && !result.deliveries?.length) {
        console.log(`${name}: inject run with no delivery log, left out`);
        continue;
      }
      const task = plan.tasks.find((t) => t.id === result.task);
      if (!task) continue;
      const events = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8");
      rows.push({
        model: "codex",
        task: task.id,
        condition: result.condition,
        run: name,
        tests: hiddenTest(path.join(dir, "work"), task),
        answer: fs.existsSync(path.join(dir, "last.md"))
          ? fs.readFileSync(path.join(dir, "last.md"), "utf8")
          : "",
        delivered: (result.deliveries ?? []).filter((d) => d.outcome === "emitted").flatMap((d) => d.units),
        signals: { ...signals(events), seconds: result.seconds },
      });
    }
  fs.writeFileSync(
    args.out ?? "",
    `${JSON.stringify({ bundle: manifest.commit, collected: new Date().toISOString(), rows }, null, 2)}\n`,
  );
  for (const r of rows)
    console.log(
      [
        r.model,
        r.task,
        r.condition,
        r.tests,
        `delivered=${r.delivered.length}`,
        `search=${r.signals.searches}/${r.signals.empty_searches} empty`,
        `read404=${r.signals.reads_not_found}`,
        `errors=${r.signals.tool_errors}`,
        `turns=${r.signals.turns ?? "?"}`,
        `${r.signals.seconds ?? "?"}s`,
      ].join("  "),
    );
}

main();
