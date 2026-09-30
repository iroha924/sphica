// Replays one evaluation task with Codex on this machine (plan step 9, the second model under test). Each run gets a fresh clone of the
// condition's bootstrap repository, a temporary HOME, and a CODEX_HOME holding only a link to the owner's auth.json plus the model settings,
// so the owner's rules, memories, and MCP servers never reach it. The cost comes from the owner's ChatGPT plan, not the cloud credits.
// Run: node evals/cloud/codex.ts --repo eval-shelf-2 --task pilot-dates [--build <dir>] [--out <dir>]
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { openReader } from "../../src/db.ts";
import { claimRunDir, isolatedCodexHome } from "./codex-home.ts";
import { readTasks } from "./firing.ts";

const HERE = import.meta.dirname;
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
  repositories: Record<string, { condition: string }>;
};
const repo = args.repo ?? "";
const task = plan.tasks.find((t) => t.id === args.task);
const condition = manifest.repositories[repo]?.condition;
if (!task || !condition) throw new Error(`unknown task ${args.task} or repository ${repo}`);

const { run, dir } = claimRunDir(path.resolve(args.out ?? ""), `${task.id}-${condition}`);
const work = path.join(dir, "work");
const home = path.join(dir, "home");
const codexHome = path.join(dir, "codex-home");
const tmp = path.join(dir, "tmp");
for (const d of [home, codexHome, tmp]) fs.mkdirSync(d, { recursive: true });
// The run counts from here: collect takes started.json as the denominator, and result.json is written whatever happens below
fs.writeFileSync(
  path.join(dir, "started.json"),
  `${JSON.stringify({ run, build: manifest.build, model: "codex", repo, condition, task: task.id, at: new Date().toISOString() }, null, 2)}\n`,
);
const started = Date.now();
const result: Record<string, unknown> = {
  run,
  build: manifest.build,
  model: "codex",
  repo,
  condition,
  task: task.id,
  status: null,
  reason: null,
};
try {
  execFileSync("git", ["clone", "-q", path.join(args.build ?? "", repo), work]);
  // Sphica identifies the project by origin, so the clone points where the cloud checkout does
  execFileSync("git", [
    "-C",
    work,
    "remote",
    "set-url",
    "origin",
    `https://github.com/${manifest.owner ?? "iroha924"}/${repo}.git`,
  ]);
  // Hooks run without a trust prompt, so they run from a copy outside the checkout the agent can write (it could rewrite .tools)
  const tools = path.join(dir, "tools");
  fs.cpSync(path.join(work, ".tools"), tools, { recursive: true });
  const mcp =
    condition === "search" || condition === "inject"
      ? `\n[mcp_servers.sphica]\ncommand = "sh"\nargs = [${JSON.stringify(path.join(tools, "sphica.sh"))}, ${JSON.stringify(path.join(tools, "dist", "mcp.js"))}]\nenv = { TMPDIR = ${JSON.stringify(tmp)} }\n`
      : "";
  isolatedCodexHome(codexHome, mcp);

  // Inject runs the shipped delivery hooks against the slot's database copy; gold goes through a prompt hook too, so both arrive as the
  // developer context a plugin hook gives (plugin/hooks/codex.json), not as part of the prompt
  const hook = (args: string[], timeout: number) => ({
    hooks: [{ type: "command", command: args.map((a) => JSON.stringify(a)).join(" "), timeout }],
  });
  const deliver = ["sh", path.join(tools, "sphica.sh"), path.join(tools, "dist", "deliver.js"), "codex"];
  const hooks =
    condition === "inject"
      ? {
          SessionStart: [hook(deliver, 10)],
          UserPromptSubmit: [hook(deliver, 10)],
          PreToolUse: [{ matcher: "^apply_patch$|^Bash$", ...hook(deliver, 10) }],
        }
      : condition === "gold"
        ? { UserPromptSubmit: [hook(["sh", path.join(dir, "gold-hook.sh")], 10)] }
        : null;
  // The gold record arrives as hook context, not as a delivery row: keep what the hook returned as the run's receipt
  if (condition === "gold")
    fs.writeFileSync(
      path.join(dir, "gold-hook.sh"),
      `out=$(sh ${JSON.stringify(path.join(tools, "gold.sh"))})\ncode=$?\nprintf '%s' "$out" >> ${JSON.stringify(path.join(dir, "gold-receipt.txt"))}\nprintf '%s' "$out"\nexit $code\n`,
    );
  if (hooks) fs.writeFileSync(path.join(codexHome, "hooks.json"), `${JSON.stringify({ hooks }, null, 2)}\n`);
  const prompt = task.prompt;

  const r = spawnSync(
    "codex",
    [
      "exec",
      "--json",
      // Only the hooks written above, which this script vets, are in this CODEX_HOME
      ...(hooks ? ["--dangerously-bypass-hook-trust"] : []),
      "--ignore-rules",
      "-s",
      "workspace-write",
      "-C",
      work,
      // The final answer comes back in a fixed shape (implemented, past decisions, unverified); collect checks it
      "--output-schema",
      path.join(HERE, "answer.schema.json"),
      "-o",
      path.join(dir, "answer.json"),
      "-",
    ],
    {
      input: prompt,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        CODEX_HOME: codexHome,
        TMPDIR: tmp,
        LANG: process.env.LANG ?? "",
      },
      encoding: "utf8",
      timeout: 30 * 60_000,
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  // Recorded now, so a failure in what follows still leaves Codex's own exit in result.json
  result.status = r.status;
  fs.writeFileSync(path.join(dir, "events.jsonl"), r.stdout ?? "");
  fs.writeFileSync(path.join(dir, "stderr.log"), r.stderr ?? "");
  execFileSync("git", ["-C", work, "add", "-A"]);
  const patch = execFileSync(
    "git",
    ["-C", work, "diff", "--cached", "HEAD", "--", ".", ":!.tools", ":!.eval"],
    { encoding: "utf8" },
  );
  fs.writeFileSync(path.join(dir, "patch.diff"), patch);
  const calls = (r.stdout ?? "").split("\n").flatMap((l) => {
    try {
      // Each call appears as item.started and item.completed; count the start only
      const e = JSON.parse(l) as { type?: string; item?: { type?: string; server?: string; tool?: string } };
      return e.type === "item.started" && e.item?.type === "mcp_tool_call"
        ? [`${e.item.server}.${e.item.tool}`]
        : [];
    } catch {
      return [];
    }
  });
  // What the delivery hooks logged, from the slot's database copy (keyed by its fixture, as sphica.sh keys it)
  let deliveries: { event: string; outcome: string; units: string[] }[] | null = null;
  if (condition === "inject") {
    const id = fs.readFileSync(path.join(tools, "fixture.id"), "utf8").trim();
    const db = openReader(path.join(tmp, "eval-sphica", id, "sphica.db"));
    try {
      const rows = await db
        .selectFrom("delivery as d")
        .select(["d.id", "d.event", "d.outcome"])
        .orderBy("d.id")
        .execute();
      const units = await db
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
      await db.destroy();
    }
  }
  Object.assign(result, {
    status: r.status,
    reason: r.status === 0 ? null : (r.error?.message ?? `codex exited ${r.status}`),
    mcp_calls: calls,
    deliveries,
  });
  console.log(`${run}: exit ${r.status}, ${calls.length} MCP calls, patch ${patch.length} bytes → ${dir}`);
} catch (e) {
  result.reason = (e as Error).message;
  throw e;
} finally {
  result.seconds = Math.round((Date.now() - started) / 1000);
  fs.writeFileSync(path.join(dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
}
