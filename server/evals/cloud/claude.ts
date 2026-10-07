// Runs one evaluation task with Claude on this machine, the local counterpart of the cloud routines (see runClaude in claude-run.ts).
// Run: node evals/cloud/claude.ts --build <dir> --repo eval-shelf-3 --task pilot-dates [--model <model>] [--out <dir>]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { claudeVersion, runClaude, runnerDigest } from "./claude-run.ts";
import { readPlan, readTasks } from "./firing.ts";

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

const canary = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(args.build, "canary.json"), "utf8")) as {
      passed?: boolean;
      model?: string;
      runner?: string;
      claude?: string;
    };
  } catch {
    return null;
  }
})();
if (
  !canary?.passed ||
  canary.model !== args.model ||
  canary.runner !== runnerDigest() ||
  canary.claude !== claudeVersion()
)
  throw new Error(
    `run node evals/cloud/canary.ts --build ${args.build} --model ${args.model} first (again after any change to the runner or update of Claude Code); no Claude run starts until it passes`,
  );

const { dir, result } = await runClaude({
  build: args.build,
  buildId: manifest.build,
  owner: manifest.owner ?? "iroha924",
  repo,
  condition,
  task: task.id,
  prompt: task.prompt,
  out: path.resolve(args.out ?? ""),
  model: args.model ?? "",
});
console.log(`${result.run}: exit ${result.status}${result.reason ? ` (${result.reason})` : ""} → ${dir}`);
// The run is recorded either way; a caller still learns it did not finish cleanly
if (result.reason) process.exitCode = 1;
