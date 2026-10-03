// Runs one evaluation task with Claude on this machine, the local counterpart of the cloud routines. Each run gets a fresh clone of the
// condition's slot, its own database copy and receipts, and a claude -p fenced by the sandbox and acceptEdits (see claude-run.ts).
// Nothing is committed or pushed: the patch is the diff from the clone's starting commit.
// Run: node evals/cloud/claude.ts --build <dir> --repo eval-shelf-3 --task pilot-dates [--model <model>] [--out <dir>]
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { openReader } from "../../src/db.ts";
import { shippedMatcher } from "./build-lib.ts";
import { finalAnswer, PARENT_ENV, patchSince, runArgs, runMcp, runSettings } from "./claude-run.ts";
import { claimRunDir } from "./codex-home.ts";
import { readPlan, readTasks } from "./firing.ts";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const { values: args } = parseArgs({
  options: {
    build: { type: "string" },
    out: { type: "string", default: path.join(os.homedir(), ".cache", "sphica-eval", "claude-runs") },
    repo: { type: "string" },
    task: { type: "string" },
    model: { type: "string", default: "claude-opus-5-5" },
  },
});

type Task = { id: string; prompt: string; gold: string[] };
if (!args.build)
  throw new Error("--build <dir> names the build whose slot to run (~/.cache/sphica-eval/builds/<build id>)");
const plan = readTasks<{ tasks: Task[] }>(args.build);
const manifest = JSON.parse(fs.readFileSync(path.join(args.build, "manifest.json"), "utf8")) as {
  build?: string;
  owner?: string;
  repositories: Record<string, { condition: string }>;
};
const repo = args.repo ?? "";
const task = plan.tasks.find((t) => t.id === args.task);
const condition = manifest.repositories[repo]?.condition;
if (!task || !condition) throw new Error(`unknown task ${args.task} or repository ${repo}`);
if (!readPlan(args.build).some((r) => r.task === task.id && r.condition === condition))
  throw new Error(`${task.id} under ${condition} is not in the build's firing plan`);

const { run, dir } = claimRunDir(path.resolve(args.out ?? ""), `${task.id}-${condition}`);
const work = path.join(dir, "work");
const tools = path.join(dir, "tools");
const db = path.join(dir, "db", "sphica.db");
fs.writeFileSync(
  path.join(dir, "started.json"),
  `${JSON.stringify({ run, build: manifest.build, model: "claude", repo, condition, task: task.id, at: new Date().toISOString() }, null, 2)}\n`,
);
const started = Date.now();
const result: Record<string, unknown> = {
  run,
  build: manifest.build,
  model: "claude",
  claude_model: args.model,
  repo,
  condition,
  task: task.id,
  status: null,
  reason: null,
};
try {
  execFileSync("git", ["clone", "-q", path.join(args.build, repo), work]);
  // Sphica identifies the project by origin, so the clone points where the cloud checkout does; nothing is pushed
  execFileSync("git", [
    "-C",
    work,
    "remote",
    "set-url",
    "origin",
    `https://github.com/${manifest.owner ?? "iroha924"}/${repo}.git`,
  ]);
  const start = execFileSync("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  fs.cpSync(path.join(work, ".tools"), tools, { recursive: true });
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const paths = { run: dir, work, tools, db };
  const settings = path.join(dir, "settings.json");
  const mcp = path.join(dir, "mcp.json");
  fs.writeFileSync(
    settings,
    `${JSON.stringify(runSettings(condition, paths, shippedMatcher(ROOT)), null, 2)}\n`,
  );
  fs.writeFileSync(mcp, `${JSON.stringify(runMcp(condition, paths), null, 2)}\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !PARENT_ENV.includes(k)));
  const child = spawn("claude", runArgs({ settings, mcp }, args.model ?? ""), {
    cwd: work,
    env: { ...env, EVAL_RUN_DIR: dir, EVAL_SPHICA_DB: db },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = fs.createWriteStream(path.join(dir, "events.jsonl"));
  const stderr = fs.createWriteStream(path.join(dir, "stderr.log"));
  child.stdout.pipe(events);
  child.stderr.pipe(stderr);
  child.stdin.end(task.prompt);
  const timer = setTimeout(() => child.kill("SIGTERM"), 30 * 60_000);
  const status = await new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  clearTimeout(timer);
  await Promise.all([new Promise((r) => events.end(r)), new Promise((r) => stderr.end(r))]);
  result.status = status;
  const final = finalAnswer(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8"));
  fs.writeFileSync(path.join(dir, "answer.md"), final?.result ?? "");
  fs.writeFileSync(path.join(dir, "patch.diff"), patchSince(work, start));
  // The gold hook's receipts hold what it returned to the session
  const receipts = fs.existsSync(path.join(dir, "eval-receipts.jsonl"))
    ? fs.readFileSync(path.join(dir, "eval-receipts.jsonl"), "utf8")
    : "";
  if (condition === "gold")
    fs.writeFileSync(
      path.join(dir, "gold-receipt.txt"),
      receipts
        .split("\n")
        .flatMap((l) => (l.trim() ? [JSON.parse(l) as { name: string; output?: string }] : []))
        .filter((r) => r.name === "gold")
        .map((r) => r.output ?? "")
        .join("\n"),
    );
  let deliveries: { event: string; outcome: string; units: string[] }[] | null = null;
  if (condition === "inject" && fs.existsSync(db)) {
    const reader = openReader(db);
    try {
      const rows = await reader
        .selectFrom("delivery as d")
        .select(["d.id", "d.event", "d.outcome"])
        .orderBy("d.id")
        .execute();
      const units = await reader
        .selectFrom("delivery_unit as x")
        .innerJoin("unit as u", "u.id", "x.unit_id")
        .select(["x.delivery_id", "u.key"])
        .execute();
      deliveries = rows.map((d) => ({
        event: d.event,
        outcome: d.outcome,
        units: units.filter((u) => u.delivery_id === d.id).map((u) => u.key),
      }));
    } finally {
      await reader.destroy();
    }
  }
  Object.assign(result, {
    reason:
      status !== 0
        ? `claude exited ${status}`
        : !final
          ? "no result event"
          : final.is_error
            ? "the run ended in an error"
            : null,
    deliveries,
  });
  console.log(`${run}: exit ${status} → ${dir}`);
} catch (e) {
  result.reason = (e as Error).message;
  throw e;
} finally {
  result.seconds = Math.round((Date.now() - started) / 1000);
  fs.writeFileSync(path.join(dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
}
