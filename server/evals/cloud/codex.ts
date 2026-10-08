// Replays one evaluation task with Codex on this machine (see runCodex in codex-run.ts).
// Run: node evals/cloud/codex.ts --repo eval-shelf-2 --task pilot-dates [--build <dir>] [--out <dir>]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { runCodex } from "./codex-run.ts";
import { readPlan, readTasks } from "./firing.ts";

const { values: args } = parseArgs({
  options: {
    build: { type: "string" },
    out: { type: "string", default: path.join(os.homedir(), ".cache", "sphica-eval", "codex-runs") },
    repo: { type: "string" },
    task: { type: "string" },
  },
});

type Task = { id: string; prompt: string; gold: string[] };
if (!args.build)
  throw new Error(
    "--build <dir> names the build whose slot to replay (~/.cache/sphica-eval/builds/<build id>)",
  );
const plan = readTasks<{ tasks: Task[] }>(args.build);
const manifest = JSON.parse(fs.readFileSync(path.join(args.build, "manifest.json"), "utf8")) as {
  build?: string;
  owner?: string;
  matchers?: { codex?: string };
  repositories: Record<string, { condition: string }>;
};
const repo = args.repo ?? "";
const task = plan.tasks.find((t) => t.id === args.task);
const condition = manifest.repositories[repo]?.condition;
if (!task || !condition) throw new Error(`unknown task ${args.task} or repository ${repo}`);
// The build's task definitions hold every project's tasks; a run the build did not plan would be collected as one of its results
if (!readPlan(args.build).some((r) => r.task === task.id && r.condition === condition))
  throw new Error(`${task.id} under ${condition} is not in the build's firing plan`);

const { dir, result } = await runCodex({
  build: args.build,
  buildId: manifest.build,
  owner: manifest.owner ?? "iroha924",
  repo,
  condition,
  task,
  out: path.resolve(args.out ?? ""),
  codexMatcher: manifest.matchers?.codex,
});
const calls = (result.mcp_calls as string[] | undefined) ?? [];
const patch = fs.statSync(path.join(dir, "patch.diff")).size;
console.log(`${result.run}: exit ${result.status}, ${calls.length} MCP calls, patch ${patch} bytes → ${dir}`);
