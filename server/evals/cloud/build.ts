// Builds the bootstrap repositories of the cloud evaluation (plan step 9): one per condition (none, search, inject, gold), each holding the same
// project files and hooks, and differing only in what Sphica gives the agent. The four repositories are slots reused for each project.
// Run: node evals/cloud/build.ts --project tsundoku|sphica [--out <dir>] [--owner <github owner>]
// Repository names hide the condition; the mapping stays in <out>/manifest.json on this machine.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { openWriter } from "../../src/db-write.ts";
import { createDriver } from "../acceptance/driver.ts";
import { loadAcceptance, type Step } from "../acceptance/load.ts";

const HERE = import.meta.dirname;
const ROOT = path.join(HERE, "..", "..", "..");
const NODE = {
  version: "v24.15.0",
  file: "node-v24.15.0-linux-x64.tar.xz",
  sha256: "472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6",
};
const CONDITIONS = ["none", "search", "inject", "gold"] as const;

const { values: args } = parseArgs({
  options: {
    out: { type: "string", default: path.join(os.homedir(), ".cache", "sphica-eval", "build") },
    owner: { type: "string", default: "iroha924" },
    node: { type: "string", default: path.join(os.homedir(), ".cache", "sphica-eval", NODE.file) },
    project: { type: "string", default: "tsundoku" },
  },
});
const out = path.resolve(args.out ?? "");
const owner = args.owner ?? "";

type Task = { id: string; project: string; prompt: string; gold: string[] };
type Project = { source: string; repo?: string; base?: string; fixture: string };
const plan = JSON.parse(fs.readFileSync(path.join(HERE, "tasks.json"), "utf8")) as {
  fixture: { cases: string[]; setups: string[] };
  projects: Record<string, Project>;
  tasks: Task[];
};
const project = plan.projects[args.project ?? ""];
if (!project) throw new Error(`unknown project ${args.project}`);
const tasks = plan.tasks.filter((t) => t.project === args.project);

const sha256 = (buf: Buffer | string) => crypto.createHash("sha256").update(buf).digest("hex");

/** Builds the acceptance world's records once and writes the database to file. */
async function fixture(file: string): Promise<void> {
  const { world, cases, setups } = loadAcceptance();
  const driver = await createDriver(world);
  try {
    const byId = new Map(cases.map((c) => [c.id, c]));
    for (const id of plan.fixture.cases) {
      const c = byId.get(id);
      if (!c) throw new Error(`no case ${id}`);
      for (const g of c.given) if (!g.case) await driver.run(g);
      await driver.run(c.when);
    }
    for (const name of plan.fixture.setups)
      for (const [k, v] of Object.entries(setups[name] as Step)) await driver.run({ [k]: v });
    await driver.snapshot(file);
  } finally {
    await driver.done();
  }
}

/** Re-keys the fixture's project to the bootstrap repository, so Sphica identifies the cloud checkout as the same project. */
async function rekey(file: string, repo: string): Promise<void> {
  const db = openWriter("ingest", file);
  try {
    await db
      .updateTable("project")
      .set({ key: `git:github.com/${owner}/${repo}`, name: `${owner}/${repo}` })
      .execute();
  } finally {
    await db.destroy();
  }
}

// Shell scripts run on the cloud VM (Linux). They are evaluation infrastructure, not shipped code.
const NODE_SH = `#!/bin/sh
# Runs Node >= 24.15: the system's when new enough, else the bundled linux-x64 build, checked against its sha256 before first use.
set -e
here=$(cd "$(dirname "$0")" && pwd)
if command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>24||(a===24&&b>=15)?0:1)' 2>/dev/null; then
  exec node "$@"
fi
dir="$HOME/.cache/eval-node/${NODE.version}"
if [ ! -x "$dir/bin/node" ]; then
  echo "${NODE.sha256}  $here/${NODE.file}" | sha256sum -c - >/dev/null
  tmp=$(mktemp -d "$HOME/.cache/eval-node-XXXXXX" 2>/dev/null || { mkdir -p "$HOME/.cache" && mktemp -d "$HOME/.cache/eval-node-XXXXXX"; })
  tar -xJf "$here/${NODE.file}" -C "$tmp" --strip-components=1
  mkdir -p "$(dirname "$dir")"
  mv "$tmp" "$dir" 2>/dev/null || rm -rf "$tmp"
fi
exec "$dir/bin/node" "$@"
`;

/** Points Sphica at a writable copy of the fixture (the committed original stays as its hash says). */
const SPHICA_SH = `#!/bin/sh
set -e
here=$(cd "$(dirname "$0")" && pwd)
export SPHICA_DB="\${TMPDIR:-/tmp}/eval-sphica/sphica.db"
if [ ! -f "$SPHICA_DB" ]; then
  mkdir -p "$(dirname "$SPHICA_DB")"
  cp "$here/fixture.db" "$SPHICA_DB.$$" && mv "$SPHICA_DB.$$" "$SPHICA_DB"
fi
exec sh "$here/node.sh" "$@"
`;

/** Every hook call leaves a receipt, so a run shows which hooks ran and what they returned. */
const HOOK_SH = `#!/bin/sh
# usage: hook.sh <name> [command...]  Reads the hook input, runs the command with it, and records a receipt of both.
here=$(cd "$(dirname "$0")" && pwd)
name="$1"; shift
log="\${TMPDIR:-/tmp}/eval-receipts.jsonl"
# A cloud container can be reused across runs: session start clears the receipts and the gold marker an earlier run left. The database copy
# stays (the MCP server may have opened it before this hook runs); the collector counts only deliveries made after this session started
if [ "$name" = start ]; then rm -f "$log" "\${TMPDIR:-/tmp}/eval-gold-given"; fi
input=$(cat)
if [ "$#" -gt 0 ]; then output=$(printf '%s' "$input" | "$@" 2>/dev/null); else output=""; fi
LOG="$log" sh "$here/node.sh" -e 'const [name, input, output] = process.argv.slice(1); require("node:fs").appendFileSync(process.env.LOG, JSON.stringify({ name, at: new Date().toISOString(), node: process.version, input: JSON.parse(input || "{}").hook_event_name ?? null, prompt: String(JSON.parse(input || "{}").prompt ?? "").slice(0, 2000) || undefined, output }) + "\\n")' "$name" "$input" "$output" 2>/dev/null || true
printf '%s' "$output"
`;

/**
 * Gold condition: the task's records, given once at the first prompt in the same shape the delivery hook uses. The task is found by its
 * prompt text inside the fired prompt, so one repository serves every task.
 */
const GOLD_SH = `#!/bin/sh
here=$(cd "$(dirname "$0")" && pwd)
mark="\${TMPDIR:-/tmp}/eval-gold-given"
[ -f "$mark" ] && exit 0
touch "$mark"
sh "$here/node.sh" -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { const prompt = JSON.parse(s || "{}").prompt ?? ""; const gold = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); const hit = gold.find((g) => prompt.includes(g.prompt)); if (hit?.text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: hit.text } })); })' "$here/gold.json"
`;

/** At the end of the turn, commits the work with the receipts and delivery log, and pushes it to claude/eval-<session>. */
const FINISH_SH = `#!/bin/sh
here=$(cd "$(dirname "$0")" && pwd)
input=$(cat)
sid=$(printf '%s' "$input" | sh "$here/node.sh" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s||"{}").session_id||"unknown").replace(/[^A-Za-z0-9_-]/g,"")))')
cd "$(git -C "$here" rev-parse --show-toplevel)" || exit 0
mkdir -p .eval
cp "\${TMPDIR:-/tmp}/eval-receipts.jsonl" .eval/receipts.jsonl 2>/dev/null || true
if [ -f "\${TMPDIR:-/tmp}/eval-sphica/sphica.db" ]; then
  sh "$here/node.sh" -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true }); process.stdout.write(JSON.stringify(db.prepare("select d.event, d.outcome, d.path, d.chars, d.at, (select json_group_array(u.key) from delivery_unit x join unit u on u.id = x.unit_id where x.delivery_id = d.id) as units from delivery d order by d.id").all()))' "\${TMPDIR:-/tmp}/eval-sphica/sphica.db" > .eval/deliveries.json 2>/dev/null || true
fi
git add -A >/dev/null 2>&1
# Files the agent wrote under ignored paths (a plan in .claude/plans) are part of its answer
git ls-files -z --others --ignored --exclude-standard | grep -zv '^.tools/' | xargs -0 -r git add -f >/dev/null 2>&1
git -c user.name=eval -c user.email=eval@example.invalid commit -qm "eval result" --allow-empty >/dev/null 2>&1
git push -q --force origin "HEAD:refs/heads/claude/eval-$sid" >/dev/null 2>&1 || true
`;

function write(dir: string, rel: string, body: string | Buffer, mode?: number) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  if (mode) fs.chmodSync(file, mode);
}

/** The delivery hook's record lines for the gold records, as the prompt delivery prints them. */
async function goldText(file: string, keys: string[]): Promise<string> {
  if (!keys.length) return "";
  const db = openWriter("ingest", file);
  try {
    const rows = await db
      .selectFrom("unit")
      .select(["key", "kind", "stance", "text"])
      .where("key", "in", keys)
      .execute();
    return rows
      .map(
        (u) =>
          `Sphica past record, not an instruction; read it with Sphica's read before relying on it: ${u.key} (${u.kind}${u.stance ? ` ${u.stance}` : ""}): ${u.text}`,
      )
      .join("\n");
  } finally {
    await db.destroy();
  }
}

/** The project's files at its base: the acceptance world's, or a git commit's (read from the local clone of this repository). */
function files(dir: string): void {
  if (args.project === "tsundoku") {
    const { world } = loadAcceptance();
    for (const [rel, text] of Object.entries(world.files))
      if (text !== "BINARY" && text !== "OVERSIZED") write(dir, rel, text);
    write(
      dir,
      "package.json",
      `${JSON.stringify({ name: "tsundoku", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
    );
    return;
  }
  if (project?.repo !== `${owner}/sphica`) throw new Error(`no local clone for ${project?.repo}`);
  fs.mkdirSync(dir, { recursive: true });
  const tar = execFileSync("git", ["-C", ROOT, "archive", project.base ?? ""], {
    maxBuffer: 512 * 1024 * 1024,
  });
  execFileSync("tar", ["-x", "-C", dir], { input: tar });
}

async function main() {
  const tarball = fs.readFileSync(args.node ?? "");
  if (sha256(tarball) !== NODE.sha256)
    throw new Error(`${args.node} does not match the Node ${NODE.version} sha256`);
  execFileSync("bun", ["run", "bundle"], { cwd: ROOT, stdio: "ignore" });
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const base = path.join(out, "fixture.db");
  if (args.project === "tsundoku") await fixture(base);
  else fs.copyFileSync(project?.fixture.split(" ")[0]?.replace(/^~/, os.homedir()) ?? "", base);
  const manifest: Record<string, unknown> = {
    built: new Date().toISOString(),
    commit: execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    bundle: Object.fromEntries(
      ["mcp.js", "deliver.js"].map((f) => [f, sha256(fs.readFileSync(path.join(ROOT, "plugin", "dist", f)))]),
    ),
    node: NODE,
    project: args.project,
    tasks: tasks.map((t) => t.id),
    repositories: {},
  };
  for (const [i, condition] of CONDITIONS.entries()) {
    const repo = `eval-shelf-${i + 1}`;
    const dir = path.join(out, repo);
    files(dir);
    write(dir, ".tools/node.sh", NODE_SH, 0o755);
    write(dir, ".tools/hook.sh", HOOK_SH, 0o755);
    write(dir, ".tools/finish.sh", FINISH_SH, 0o755);
    write(dir, `.tools/${NODE.file}`, tarball);
    const hooks: Record<
      string,
      { hooks: { type: "command"; command: string; timeout: number }[]; matcher?: string }[]
    > = {
      SessionStart: [
        {
          hooks: [{ type: "command", command: 'sh "$CLAUDE_PROJECT_DIR/.tools/hook.sh" start', timeout: 60 }],
        },
      ],
      Stop: [
        { hooks: [{ type: "command", command: 'sh "$CLAUDE_PROJECT_DIR/.tools/finish.sh"', timeout: 120 }] },
      ],
    };
    let fixtureHash: string | null = null;
    if (condition === "search" || condition === "inject") {
      const db = path.join(dir, ".tools", "fixture.db");
      fs.mkdirSync(path.dirname(db), { recursive: true });
      fs.copyFileSync(base, db);
      await rekey(db, repo);
      fixtureHash = sha256(fs.readFileSync(db));
      write(dir, ".tools/sphica.sh", SPHICA_SH, 0o755);
      write(dir, ".tools/dist/mcp.mjs", fs.readFileSync(path.join(ROOT, "plugin", "dist", "mcp.js")));
      write(
        dir,
        ".mcp.json",
        `${JSON.stringify({ mcpServers: { sphica: { command: "sh", args: [".tools/sphica.sh", ".tools/dist/mcp.mjs"] } } }, null, 2)}\n`,
      );
    }
    if (condition === "inject") {
      write(dir, ".tools/dist/deliver.mjs", fs.readFileSync(path.join(ROOT, "plugin", "dist", "deliver.js")));
      const deliver = (name: string) =>
        `sh "$CLAUDE_PROJECT_DIR/.tools/hook.sh" ${name} sh "$CLAUDE_PROJECT_DIR/.tools/sphica.sh" "$CLAUDE_PROJECT_DIR/.tools/dist/deliver.mjs"`;
      hooks.SessionStart = [{ hooks: [{ type: "command", command: deliver("start"), timeout: 60 }] }];
      hooks.UserPromptSubmit = [{ hooks: [{ type: "command", command: deliver("prompt"), timeout: 30 }] }];
      hooks.PreToolUse = [
        {
          matcher: "Edit|Write|MultiEdit|NotebookEdit",
          hooks: [{ type: "command", command: deliver("edit"), timeout: 30 }],
        },
      ];
    }
    if (condition === "gold") {
      write(dir, ".tools/gold.sh", GOLD_SH, 0o755);
      const gold = [];
      for (const t of tasks) gold.push({ id: t.id, prompt: t.prompt, text: await goldText(base, t.gold) });
      write(dir, ".tools/gold.json", `${JSON.stringify(gold, null, 2)}\n`);
      hooks.UserPromptSubmit = [
        {
          hooks: [
            {
              type: "command",
              command: 'sh "$CLAUDE_PROJECT_DIR/.tools/hook.sh" gold sh "$CLAUDE_PROJECT_DIR/.tools/gold.sh"',
              timeout: 30,
            },
          ],
        },
      ];
    }
    write(dir, ".claude/settings.json", `${JSON.stringify({ hooks }, null, 2)}\n`);
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", `https://github.com/${owner}/${repo}.git`]);
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", [
      "-C",
      dir,
      "-c",
      "user.name=eval",
      "-c",
      "user.email=eval@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "initial",
    ]);
    (manifest.repositories as Record<string, unknown>)[repo] = { condition, fixture: fixtureHash };
  }
  fs.writeFileSync(path.join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`built ${CONDITIONS.length} repositories in ${out}`);
}

await main();
