// Replays one evaluation task with Codex on this machine (plan step 9, the second model under test). Each run gets a fresh clone of the
// condition's bootstrap repository, a temporary HOME, and a CODEX_HOME holding only a link to the owner's auth.json plus the model settings,
// so the owner's rules, memories, and MCP servers never reach it. The cost comes from the owner's ChatGPT plan, not the cloud credits.
// Run: node evals/cloud/codex.ts --repo eval-shelf-2 --task pilot-dates [--build <dir>] [--out <dir>]
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const HERE = import.meta.dirname;
const { values: args } = parseArgs({
  options: {
    build: { type: "string", default: path.join(os.homedir(), ".cache", "sphica-eval", "build") },
    out: { type: "string", default: path.join(os.homedir(), ".cache", "sphica-eval", "codex-runs") },
    repo: { type: "string" },
    task: { type: "string" },
  },
});

type Task = { id: string; prompt: string; gold: string[] };
const plan = JSON.parse(fs.readFileSync(path.join(HERE, "tasks.json"), "utf8")) as { tasks: Task[] };
const manifest = JSON.parse(fs.readFileSync(path.join(args.build ?? "", "manifest.json"), "utf8")) as {
  repositories: Record<string, { condition: string }>;
};
const repo = args.repo ?? "";
const task = plan.tasks.find((t) => t.id === args.task);
const condition = manifest.repositories[repo]?.condition;
if (!task || !condition) throw new Error(`unknown task ${args.task} or repository ${repo}`);
if (condition === "inject")
  throw new Error("Codex has no delivery hooks yet (plan step 10); run none, search, or gold");

/** The owner's model and effort only; nothing else from ~/.codex/config.toml. */
function modelSettings(): string {
  const text = fs.readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8");
  return text
    .split("\n")
    .filter((l) => /^(model|model_reasoning_effort)\s*=/.test(l))
    .join("\n");
}

const run = `${task.id}-${condition}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const dir = path.join(path.resolve(args.out ?? ""), run);
const work = path.join(dir, "work");
const home = path.join(dir, "home");
const codexHome = path.join(dir, "codex-home");
const tmp = path.join(dir, "tmp");
for (const d of [home, codexHome, tmp]) fs.mkdirSync(d, { recursive: true });
execFileSync("git", ["clone", "-q", path.join(args.build ?? "", repo), work]);
// Sphica identifies the project by origin, so the clone points where the cloud checkout does
execFileSync("git", ["-C", work, "remote", "set-url", "origin", `https://github.com/iroha924/${repo}.git`]);
fs.symlinkSync(path.join(os.homedir(), ".codex", "auth.json"), path.join(codexHome, "auth.json"));
const mcp =
  condition === "search"
    ? `\n[mcp_servers.sphica]\ncommand = "sh"\nargs = [${JSON.stringify(path.join(work, ".tools", "sphica.sh"))}, ${JSON.stringify(path.join(work, ".tools", "dist", "mcp.js"))}]\nenv = { TMPDIR = ${JSON.stringify(tmp)} }\n`
    : "";
fs.writeFileSync(path.join(codexHome, "config.toml"), `${modelSettings()}\n${mcp}`);

// Gold is given at the first prompt, in the delivery hook's shape (the same first-prompt delivery the Claude runs get)
const goldText =
  condition === "gold"
    ? ((
        JSON.parse(fs.readFileSync(path.join(work, ".tools", "gold.json"), "utf8")) as {
          id: string;
          text: string;
        }[]
      ).find((g) => g.id === task.id)?.text ?? "")
    : "";
const prompt = goldText ? `${goldText}\n\n${task.prompt}` : task.prompt;

const started = Date.now();
const r = spawnSync(
  "codex",
  [
    "exec",
    "--json",
    "--ignore-rules",
    "-s",
    "workspace-write",
    "-C",
    work,
    "-o",
    path.join(dir, "last.md"),
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
fs.writeFileSync(path.join(dir, "events.jsonl"), r.stdout ?? "");
fs.writeFileSync(path.join(dir, "stderr.log"), r.stderr ?? "");
execFileSync("git", ["-C", work, "add", "-A"]);
const patch = execFileSync(
  "git",
  ["-C", work, "diff", "--cached", "HEAD", "--", ".", ":!.tools", ":!.eval"],
  { encoding: "utf8" },
);
fs.writeFileSync(path.join(dir, "patch.diff"), patch);
const tools = (r.stdout ?? "").split("\n").flatMap((l) => {
  try {
    const e = JSON.parse(l) as { item?: { type?: string; server?: string; tool?: string } };
    return e.item?.type === "mcp_tool_call" ? [`${e.item.server}.${e.item.tool}`] : [];
  } catch {
    return [];
  }
});
fs.writeFileSync(
  path.join(dir, "result.json"),
  `${JSON.stringify({ run, model: "codex", repo, condition, task: task.id, status: r.status, seconds: Math.round((Date.now() - started) / 1000), mcp_calls: tools }, null, 2)}\n`,
);
console.log(`${run}: exit ${r.status}, ${tools.length} MCP calls, patch ${patch.length} bytes → ${dir}`);
