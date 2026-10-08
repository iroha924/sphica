// Replays one evaluation task with Codex on this machine (see runCodex in codex-run.ts). With --probe, it instead shows that the run's
// commands cannot read what the fence hides, on the same slot, before any measured run.
// Run: node evals/cloud/codex.ts --build <dir> --repo eval-shelf-2 --task pilot-dates [--out <dir>] [--probe]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { evalCache } from "./codex-home.ts";
import { runCodex } from "./codex-run.ts";
import { readPlan, readTasks } from "./firing.ts";
import {
  anchoredTarget,
  anyKey,
  cacheToken,
  deliveredOnRead,
  type ProbeTarget,
  probeProblems,
  probeScript,
  probeTargets,
  ranCleanly,
  readCommand,
  readReturned,
} from "./probe.ts";

const { values: args } = parseArgs({
  options: {
    build: { type: "string" },
    out: { type: "string", default: path.join(os.homedir(), ".cache", "sphica-eval", "codex-runs") },
    repo: { type: "string" },
    task: { type: "string" },
    probe: { type: "boolean", default: false },
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

const run = {
  build: args.build,
  buildId: manifest.build,
  owner: manifest.owner ?? "iroha924",
  repo,
  condition,
  task,
  out: path.resolve(args.out ?? ""),
  codexMatcher: manifest.matchers?.codex,
};

if (args.probe) {
  const build = args.build;
  const token = cacheToken(evalCache());
  const problems: string[] = [];
  try {
    let targets: ProbeTarget[] = [];
    let key: string | null = null;
    let next: string | null = null;
    let planted = "";
    const { dir, result } = await runCodex({
      ...run,
      // Apart from the measured runs: collect reads only run directories directly under --out
      out: path.join(run.out, "probe"),
      probe: async (p) => {
        const control = path.join(p.work, "probe-control.txt");
        fs.writeFileSync(control, "control\n");
        targets = probeTargets([
          token,
          { label: "build-tasks", path: path.join(build, "tasks.json"), expect: "DENIED" },
          ...(condition === "search" || condition === "inject"
            ? [{ label: "run-db", path: p.db, expect: "DENIED" as const }]
            : []),
          { label: "control", path: control, expect: "READ" },
        ]);
        // The gold hook picks its record by the task's prompt, so the gold probe carries it, with the task itself called off
        let prompt =
          condition === "gold"
            ? `${task.prompt}\n\nDo not carry out the request above. Instead, run ./probe.sh once and quote its whole output.`
            : "Run ./probe.sh once and quote its whole output.";
        if (condition === "search") {
          key = await anyKey(p.tools);
          if (!key) throw new Error("no eligible probe target: the slot's database has no live record");
          prompt += ` Then call the sphica MCP server's read tool with refs ["${key}"] and cwd "${p.work}", and quote what it returns.`;
        }
        if (condition === "inject") {
          // The anchored path stays out of the prompt: the prompt's own delivery would show the record before the read could
          prompt += " Then run the command probe.sh printed after NEXT, exactly as printed.";
          const target = await anchoredTarget({
            tools: p.tools,
            work: p.work,
            scratch: path.join(p.dir, "probe-scratch"),
            prompt: `${prompt} Do nothing else.`,
          });
          if (!target)
            throw new Error("no eligible probe target: no anchored read delivers a record in this slot");
          key = target.key;
          next = readCommand(target.path);
        }
        planted = probeScript(targets, next);
        fs.writeFileSync(path.join(p.work, "probe.sh"), planted, { mode: 0o755 });
        return `${prompt} Do nothing else.`;
      },
    });
    const events = fs.existsSync(path.join(dir, "events.jsonl"))
      ? fs.readFileSync(path.join(dir, "events.jsonl"), "utf8")
      : "";
    problems.push(...probeProblems(events, targets));
    // The model can write its checkout: a probe.sh it changed reports whatever it was changed to report
    const ranScript = path.join(dir, "work", "probe.sh");
    if (!fs.existsSync(ranScript) || fs.readFileSync(ranScript, "utf8") !== planted)
      problems.push("probe.sh was changed or removed during the run");
    if (next && !ranCleanly(events, next)) problems.push(`the run did not complete ${next}`);
    if (result.reason) problems.push(`the run did not finish cleanly: ${result.reason}`);
    if (condition === "inject" && key && !deliveredOnRead(result.deliveries as never, key))
      problems.push(`the anchored read did not deliver ${key} under the fence`);
    if (condition === "search" && key && !readReturned(events, key))
      problems.push(`no error-free read through the MCP server returned ${key}`);
    const receipt = path.join(dir, "gold-receipt.txt");
    if (condition === "gold" && !(fs.existsSync(receipt) && fs.readFileSync(receipt, "utf8").trim()))
      problems.push("the gold hook returned nothing under the fence");
    console.log(`probe run → ${dir}`);
  } finally {
    fs.rmSync(token.path, { force: true });
  }
  for (const p of problems) console.log(`✗ ${p}`);
  if (problems.length) process.exitCode = 1;
  else console.log("✓ probe passed: every fenced target was denied, and the run still reached Sphica");
} else {
  const { dir, result } = await runCodex(run);
  const calls = (result.mcp_calls as string[] | undefined) ?? [];
  const patch = fs.statSync(path.join(dir, "patch.diff")).size;
  console.log(
    `${result.run}: exit ${result.status}, ${calls.length} MCP calls, patch ${patch} bytes → ${dir}`,
  );
}
