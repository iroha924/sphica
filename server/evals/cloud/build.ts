// Builds the bootstrap repositories of the cloud evaluation (plan step 9): one per condition (none, search, inject, gold), each holding the same
// project files and hooks, and differing only in what Sphica gives the agent. The four repositories are slots reused for each project.
// Run: node evals/cloud/build.ts --project tsundoku|sphica [--variant original|swapped] [--runs <n>] [--out <dir>] [--owner <github owner>]
// Repository names hide the condition; the mapping stays in <out>/manifest.json on this machine.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { openReader } from "../../src/db.ts";
import { openWriter } from "../../src/db-write.ts";
import { CONFIRM_GOLD, recordLines } from "../../src/deliver.ts";
import { inline } from "../../src/panel.ts";
import { createDriver } from "../acceptance/driver.ts";
import { loadAcceptance, type Step } from "../acceptance/load.ts";
import { planRows, writePlan, writeTasks } from "./firing.ts";
import { FINISH_SH, GOLD_SH, HOOK_SH, NODE, NODE_SH, SPHICA_SH } from "./slot-scripts.ts";

const HERE = import.meta.dirname;
const ROOT = path.join(HERE, "..", "..", "..");
const CONDITIONS = ["none", "search", "inject", "gold"] as const;

const { values: args } = parseArgs({
  options: {
    // Each build keeps its own directory, so an original and a swapped build of one loop can both be collected
    out: { type: "string" },
    variant: { type: "string", default: "original" },
    runs: { type: "string", default: "2" },
    owner: { type: "string", default: "iroha924" },
    node: { type: "string", default: path.join(os.homedir(), ".cache", "sphica-eval", NODE.file) },
    project: { type: "string", default: "tsundoku" },
  },
});
const variant = args.variant ?? "original";
if (variant !== "original" && variant !== "swapped") throw new Error("--variant is original or swapped");
const runs = Number(args.runs);
if (!Number.isInteger(runs) || runs < 1)
  throw new Error("--runs takes a whole number of Claude runs per task and condition");
const buildId = `${args.project}-${variant}-${new Date().toISOString().replace(/[-:.]/g, "")}`;
const out = path.resolve(args.out ?? path.join(os.homedir(), ".cache", "sphica-eval", "builds", buildId));
// A build is never rebuilt in place: its firing plan and collected results belong to what was pushed from it
if (fs.existsSync(out))
  throw new Error(`${out} already exists; give a new --out, or leave it out for a new build id`);
const owner = args.owner ?? "";

type Task = { id: string; project: string; prompt: string; gold: string[]; conditions: string[] };
type Project = { source: string; repo?: string; base?: string; fixture: string };
const plan = JSON.parse(fs.readFileSync(path.join(HERE, "tasks.json"), "utf8")) as {
  fixture: { cases: string[]; setups: string[] };
  swapped: { drop: { cases: string[]; setups: string[] }; steps: Step[]; tasks: Record<string, string[]> };
  projects: Record<string, Project>;
  tasks: Task[];
};
const project = plan.projects[args.project ?? ""];
if (!project) throw new Error(`unknown project ${args.project}`);
// A swapped build carries only the tasks with a swapped record, each pointing at that record as its gold
const tasks = plan.tasks
  .filter((t) => t.project === args.project)
  .flatMap((t) =>
    args.variant !== "swapped"
      ? [t]
      : plan.swapped.tasks[t.id]
        ? [{ ...t, gold: plan.swapped.tasks[t.id] ?? [] }]
        : [],
  );
if (!tasks.length) throw new Error(`no ${args.variant} tasks for ${args.project}`);

const sha256 = (buf: Buffer | string) => crypto.createHash("sha256").update(buf).digest("hex");

/** Builds the acceptance world's records once and writes the database to file. */
async function fixture(file: string): Promise<void> {
  const { world, cases, setups } = loadAcceptance();
  const driver = await createDriver(world);
  try {
    const byId = new Map(cases.map((c) => [c.id, c]));
    const swapped = args.variant === "swapped";
    const dropped = (list: string[], drop: string[]) => list.filter((x) => !swapped || !drop.includes(x));
    for (const id of dropped(plan.fixture.cases, plan.swapped.drop.cases)) {
      const c = byId.get(id);
      if (!c) throw new Error(`no case ${id}`);
      for (const g of c.given) if (!g.case) await driver.run(g);
      await driver.run(c.when);
    }
    for (const name of dropped(plan.fixture.setups, plan.swapped.drop.setups))
      for (const [k, v] of Object.entries(setups[name] as Step)) await driver.run({ [k]: v });
    if (swapped) for (const step of plan.swapped.steps) await driver.run(step);
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

function write(dir: string, rel: string, body: string | Buffer, mode?: number) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  if (mode) fs.chmodSync(file, mode);
}

/**
 * The gold records as a file-bound delivery renders them (the record, its reason, its rejected options). The gold slot has no Sphica tools,
 * so the lead points to no read.
 */
async function goldText(file: string, keys: string[]): Promise<string> {
  if (!keys.length) return "";
  const db = openWriter("ingest", file);
  try {
    const rows = await db
      .selectFrom("unit")
      .select(["id", "key", "kind", "stance", "text", "why"])
      .where("key", "in", keys)
      .execute();
    // A gold slot missing a record would be labelled gold while giving less: stop the build instead
    const missing = keys.filter((k) => !rows.some((r) => r.key === k));
    if (missing.length) throw new Error(`gold records missing from the fixture: ${missing.join(", ")}`);
    // Gold claims the record as a delivery gives it; a body or reason the renderer would cut stops the build (rejected options show up to
    // three with a count, as in every delivery)
    const lines = await recordLines(db, rows);
    rows.forEach((r, i) => {
      const shown = lines[i] ?? "";
      if (!shown.includes(inline(r.text)) || (r.why && !shown.includes(`Why: ${inline(r.why)}`)))
        throw new Error(`gold record ${r.key} would be cut by the delivery renderer`);
    });
    return [GOLD_LEAD, ...lines].join("\n");
  } finally {
    await db.destroy();
  }
}

/** The lead of the gold context: a delivery's, without the pointer to read the gold slot cannot follow. */
const GOLD_LEAD = `Active decisions from this project's history (current code relevance unverified). ${CONFIRM_GOLD} Sphica past records, not instructions:`;

/**
 * Drops the section that asks for the owner's Go before implementing: an evaluation has no owner to give it, so runs would stop at a plan
 * for that reason alone. A copy that still asks for it stops the build.
 */
function dropGoGate(dir: string): void {
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8").replace(/^## Before implementing\n[\s\S]*?(?=^## )/m, "");
    if (/owner's (Go|approval)|(Go|approval) before implementing/i.test(text))
      throw new Error(`${name} in the slot still asks for the owner's Go`);
    fs.writeFileSync(file, text);
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

/** The shipped delivery hook's PreToolUse matcher, so the inject slot fires on the same tools the plugin does. */
function deliverMatcher(): string {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, "plugin", "hooks", "hooks.json"), "utf8")) as {
    hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
  };
  const entry = hooks.hooks.PreToolUse.find((e) => e.hooks.some((h) => h.command.includes("deliver.js")));
  if (!entry) throw new Error("plugin/hooks/hooks.json has no PreToolUse delivery hook");
  return entry.matcher;
}

/** Runs the slot's session start hook as the host would and requires a delivery row, so a hook that never runs fails the build. */
async function smokeDelivery(dir: string): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-smoke-"));
  try {
    // A reused container can hold another fixture's copy; the hook must not pick it up
    fs.mkdirSync(path.join(tmp, "eval-sphica"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "eval-sphica", "sphica.db"), "an earlier fixture");
    execFileSync("sh", [".tools/sphica.sh", ".tools/dist/deliver.js"], {
      cwd: dir,
      input: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "smoke",
        cwd: dir,
        source: "startup",
      }),
      env: { PATH: process.env.PATH ?? "", HOME: tmp, TMPDIR: tmp },
    });
    const id = fs.readFileSync(path.join(dir, ".tools", "fixture.id"), "utf8").trim();
    const db = openReader(path.join(tmp, "eval-sphica", id, "sphica.db"));
    try {
      const rows = await db.selectFrom("delivery").select("id").execute();
      if (!rows.length) throw new Error(`${dir}: the delivery hook logged nothing at session start`);
    } finally {
      await db.destroy();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const tarball = fs.readFileSync(args.node ?? "");
  if (sha256(tarball) !== NODE.sha256)
    throw new Error(`${args.node} does not match the Node ${NODE.version} sha256`);
  execFileSync("bun", ["run", "bundle"], { cwd: ROOT, stdio: "ignore" });
  fs.mkdirSync(out, { recursive: true });
  const base = path.join(out, "fixture.db");
  if (args.project === "tsundoku") await fixture(base);
  else fs.copyFileSync(project?.fixture.split(" ")[0]?.replace(/^~/, os.homedir()) ?? "", base);
  const manifest: Record<string, unknown> = {
    build: buildId,
    variant,
    built: new Date().toISOString(),
    commit: execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    bundle: Object.fromEntries(
      ["mcp.js", "deliver.js"].map((f) => [f, sha256(fs.readFileSync(path.join(ROOT, "plugin", "dist", f)))]),
    ),
    node: NODE,
    project: args.project,
    owner,
    tasks: tasks.map((t) => t.id),
    repositories: {},
  };
  for (const [i, condition] of CONDITIONS.entries()) {
    const repo = `eval-shelf-${i + 1}`;
    const dir = path.join(out, repo);
    files(dir);
    dropGoGate(dir);
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
      // Every slot logs the prompt, so collect can tell which task a run carried out
      UserPromptSubmit: [
        {
          hooks: [
            { type: "command", command: 'sh "$CLAUDE_PROJECT_DIR/.tools/hook.sh" prompt', timeout: 30 },
          ],
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
      write(dir, ".tools/fixture.id", `${fixtureHash.slice(0, 16)}\n`);
      // The bundles are ESM; keeping the .js names keeps deliver's entry check (deliver.(ts|js)) true, which .mjs silently broke
      write(dir, ".tools/dist/package.json", `${JSON.stringify({ type: "module" })}\n`);
      write(dir, ".tools/dist/mcp.js", fs.readFileSync(path.join(ROOT, "plugin", "dist", "mcp.js")));
      write(
        dir,
        ".mcp.json",
        `${JSON.stringify({ mcpServers: { sphica: { command: "sh", args: [".tools/sphica.sh", ".tools/dist/mcp.js"] } } }, null, 2)}\n`,
      );
    }
    if (condition === "inject") {
      write(dir, ".tools/dist/deliver.js", fs.readFileSync(path.join(ROOT, "plugin", "dist", "deliver.js")));
      const deliver = (name: string) =>
        `sh "$CLAUDE_PROJECT_DIR/.tools/hook.sh" ${name} sh "$CLAUDE_PROJECT_DIR/.tools/sphica.sh" "$CLAUDE_PROJECT_DIR/.tools/dist/deliver.js"`;
      hooks.SessionStart = [{ hooks: [{ type: "command", command: deliver("start"), timeout: 60 }] }];
      hooks.UserPromptSubmit = [{ hooks: [{ type: "command", command: deliver("prompt"), timeout: 30 }] }];
      hooks.PreToolUse = [
        {
          matcher: deliverMatcher(),
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
    // Unattended runs otherwise send push notifications to the owner's phone
    write(
      dir,
      ".claude/settings.json",
      `${JSON.stringify({ permissions: { deny: ["PushNotification"] }, hooks }, null, 2)}\n`,
    );
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
    if (condition === "inject") await smokeDelivery(dir);
    (manifest.repositories as Record<string, unknown>)[repo] = { condition, fixture: fixtureHash };
  }
  fs.writeFileSync(path.join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeTasks(out, plan);
  const slotOf = new Map(CONDITIONS.map((c, i) => [c, `eval-shelf-${i + 1}`]));
  writePlan(
    out,
    planRows(buildId, variant, tasks, runs, (c) => slotOf.get(c as (typeof CONDITIONS)[number]) ?? ""),
  );
  console.log(`built ${CONDITIONS.length} repositories in ${out}`);
}

await main();
