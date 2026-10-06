// How long each delivery hook (the bundled deliver.js, a fresh process per call as the hosts run it) and capture's drain take as records grow.
// Every reply is checked for the records it must name, so a hook that fails quietly with an empty reply never passes as fast.
// node server/evals/scale/run.ts [--sizes 359,1000] [--no-stress] [--no-drain]; timings belong to the machine printed first.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { inTransaction } from "../../src/db.ts";
import { checkRecord, saveRecord, type Target } from "../../src/record.ts";
import { openRun } from "../../src/trace.ts";
import { insert, message, project, session, type TempDb, tempDb } from "../../test/temp-db.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const HOOK = path.join(ROOT, "plugin", "dist", "deliver.js");
const RUNS = 5;
const BAR_MS = 1000;
const PER_SAVE = 50;
const KEY = "git:github.com/o/r";

// Never the owner's ~/.sphica: the drain below and everything this process opens use a home of its own
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-scale-"));
process.env.SPHICA_HOME = path.join(home, ".sphica");
const { flush, spoolDir } = await import("../../src/capture.ts");

/** Each Claude Code delivery hook's time limit in ms, read from the shipped hooks.json */
function limits(): Record<string, number> {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, "plugin", "hooks", "hooks.json"), "utf8"))
    .hooks as Record<string, { hooks: { args?: string[]; timeout?: number }[] }[]>;
  const out: Record<string, number> = {};
  for (const [event, groups] of Object.entries(hooks))
    for (const h of groups.flatMap((g) => g.hooks))
      if (h.args?.some((a) => a.endsWith("dist/deliver.js")) && h.timeout) out[event] = h.timeout * 1000;
  return out;
}

type Unit = Record<string, unknown>;
type Fixture = {
  name: string;
  units: number;
  /** Keys the cases expect, filled while seeding */
  keys: Record<string, string>;
  db: TempDb;
  repo: string;
};

const constraint = (i: number, quote: string, extra: Unit = {}): Unit => ({
  key: `k${i}`,
  kind: "constraint",
  stance: "do",
  text: quote,
  aliases: ["scale", "benchmark"],
  ...extra,
});

/** The shape the pilot measured: a constraint with two anchored paths (one with a symbol) and two rejected options */
const uniform = (i: number): Unit =>
  constraint(i, `Rule ${i}: keep module${i} pure.`, {
    options: [
      { text: `option alpha${i}`, outcome: "rejected" },
      { text: `option beta${i}`, outcome: "rejected" },
    ],
    anchors: [
      { path: `src/mod${i}/a.ts`, symbol: `fnAlpha${i}`, role: "applies_to" },
      { path: `src/mod${i}/b.ts`, role: "applies_to" },
    ],
  });

const LONG = (i: number, j: number) => `long option ${i}-${j} `.padEnd(500, "x");

/**
 * The stress shape, per record index: 5 % share one path, 1 % carry 20 anchors and 12 options of 500 characters, 10 % are broad
 * constraints, 10 % location-free don't/defer decisions (what review matches by option), 1 in 500 conflicts with a record of the
 * previous save (never the last record, which the cases name); the rest are uniform.
 */
function stress(i: number, prefix: (b: number) => string): Unit {
  const r = i % 100;
  if (r < 5)
    return constraint(i, `Rule ${i}: guard the shared module.`, {
      anchors: [
        { path: "src/shared/hot.ts", role: "applies_to" },
        { path: `src/mod${i}/a.ts`, role: "applies_to" },
      ],
    });
  if (r === 5)
    return constraint(i, `Rule ${i}: keep the wide module stable.`, {
      anchors: Array.from({ length: 20 }, (_, j) => ({ path: `src/wide${i}/f${j}.ts`, role: "applies_to" })),
      options: Array.from({ length: 12 }, (_, j) => ({ text: LONG(i, j), outcome: "rejected" })),
    });
  if (r < 16) return constraint(i, `Rule ${i}: write every log line in English.`);
  if (r < 26)
    return {
      key: `k${i}`,
      kind: "decision",
      stance: r % 2 ? "dont" : "defer",
      text: `Rule ${i}: no vendor${i} client.`,
      options: [{ text: `vendor${i}client`, outcome: "rejected" }],
      aliases: ["scale", "benchmark"],
    };
  const u = uniform(i);
  if (i % 500 === 250 && i >= PER_SAVE)
    u.conflicts = [`${prefix(Math.floor((i - PER_SAVE) / PER_SAVE))}k${i - PER_SAVE}`];
  return u;
}

/** Saves n records through the real check and save path, PER_SAVE at a time, each quoting its own owner message */
async function seed(db: TempDb, projectId: number, n: number, shape: (i: number) => Unit): Promise<void> {
  const prefix = (b: number) => `trace:ext-b${b}/`;
  for (let b = 0; b * PER_SAVE < n; b++) {
    const units: Unit[] = [];
    for (let i = b * PER_SAVE; i < Math.min(n, (b + 1) * PER_SAVE); i++) {
      const u = shape(i);
      const quote = String(u.text);
      const m = message(db, projectId, { id: `m${i}`, text: `${quote} That is settled.` });
      units.push({
        ...u,
        evidence: [{ source: `s${m}`, quote, role: "states" }],
        adoption: [{ source: `s${m}`, quote }],
      });
    }
    const target: Target = {
      projectId,
      origin: "trace",
      prefix: prefix(b),
      sessionId: "s1",
      root: null,
      sources: null,
    };
    await inTransaction(db.ingest, async (trx) => {
      const run = await openRun(trx, {
        projectId,
        origin: "trace",
        target: "session:s1",
        sessionId: "s1",
        draftId: `d${b}`,
      });
      return saveRecord(trx, target, run, await checkRecord(trx, target, { units }), []);
    });
  }
}

/** A checkout whose origin is the project, with a default branch to compare against and a change touching anchored files */
function checkout(changed: string[], added: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-scale-repo-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("remote", "add", "origin", "https://github.com/o/r.git");
  git("config", "user.email", "scale@example.invalid");
  git("config", "user.name", "scale");
  for (const rel of changed) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), "export {};\n");
  }
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  for (const rel of changed) fs.appendFileSync(path.join(dir, rel), `${added}\n`);
  return dir;
}

async function build(name: string, n: number, kind: "uniform" | "stress"): Promise<Fixture> {
  const db = tempDb();
  const p = project(db, KEY, "o/r");
  const last = n - 1;
  // The last record is uniform in both shapes (99 % 100 is uniform), so the prompt, read, edit, and shell cases name it
  const shape = kind === "uniform" ? uniform : (i: number) => stress(i, (b) => `trace:ext-b${b}/`);
  await seed(db, p, n, shape);
  const keys: Record<string, string> = { last: `trace:ext-b${Math.floor(last / PER_SAVE)}/k${last}` };
  let added = "// nothing to match";
  const changed = [`src/mod${last}/a.ts`];
  if (kind === "stress") {
    // A location-free don't record review must find through an added line, and a broad constraint session start shows
    const free = [...Array(n).keys()].reverse().find((i) => i % 100 >= 16 && i % 100 < 26) ?? 0;
    const broad = [...Array(n).keys()].reverse().find((i) => i % 100 >= 6 && i % 100 < 16) ?? 0;
    keys.free = `trace:ext-b${Math.floor(free / PER_SAVE)}/k${free}`;
    keys.broad = `trace:ext-b${Math.floor(broad / PER_SAVE)}/k${broad}`;
    // Only the last record's file changes: review shows five records in id order, and the 500 sharing hot.ts would fill them
    added = `const c = vendor${free}client;`;
    // A history of other sessions and their deliveries, as a project used for months has
    db.owner.exec("begin");
    const now = Date.now();
    for (let s = 0; s < 2000; s++) session(db, p, `h${s}`);
    for (let d = 0; d < 50_000; d++)
      insert(db, "delivery", {
        session_id: `h${d % 2000}`,
        event: d % 3 ? "pre_read" : "prompt",
        outcome: "emitted",
        eligible: 1,
        omitted: 0,
        chars: 200,
        at: new Date(now - (d % 1440) * 60_000).toISOString(),
      });
    db.owner.exec("commit");
  }
  return { name, units: n, keys, db, repo: checkout(changed, added) };
}

type Case = {
  name: string;
  event: string;
  input: Record<string, unknown>;
  /** Keys every reply must name; empty means the reply must be empty */
  expect: (f: Fixture) => string[];
  /** Only for one shape */
  only?: "stress";
  /** Several calls in one session (a read budget being spent), timed per call */
  calls?: number;
};

const reviewed = (f: Fixture) => [f.keys.last ?? "", ...(f.keys.free ? [f.keys.free] : [])];

const CASES: Case[] = [
  {
    name: "prompt, naming a symbol and a path",
    event: "UserPromptSubmit",
    input: {},
    expect: (f) => [f.keys.last ?? ""],
  },
  {
    name: "prompt, naming nothing",
    event: "UserPromptSubmit",
    input: { prompt: "今日の天気は？ What should we work on next?" },
    expect: () => [],
  },
  {
    name: "prompt, 4 KB naming nothing",
    event: "UserPromptSubmit",
    input: { prompt: "Please look at the overall design and tell me what you think. ".repeat(66) },
    expect: () => [],
  },
  {
    name: "read an anchored file",
    event: "PreToolUse",
    input: { tool_name: "Read" },
    expect: (f) => [f.keys.last ?? ""],
  },
  {
    name: "edit an anchored file",
    event: "PreToolUse",
    input: { tool_name: "Edit" },
    expect: (f) => [f.keys.last ?? ""],
  },
  {
    name: "shell command naming an anchored file",
    event: "PreToolUse",
    input: { tool_name: "Bash" },
    expect: (f) => [f.keys.last ?? ""],
  },
  {
    name: "read a file 500 records share",
    event: "PreToolUse",
    input: { tool_name: "Read", tool_input: { file_path: "src/shared/hot.ts" } },
    expect: () => ["trace:ext-b"],
    only: "stress",
  },
  {
    name: "read 10 files in one session",
    event: "PreToolUse",
    input: { tool_name: "Read" },
    expect: (f) => [f.keys.last ?? ""],
    calls: 10,
    only: "stress",
  },
  {
    name: "review, typed slash command",
    event: "UserPromptExpansion",
    input: { expansion_type: "slash_command", command_name: "review", command_args: "" },
    expect: reviewed,
  },
  {
    name: "review, Skill tool",
    event: "PreToolUse",
    input: { tool_name: "Skill", tool_input: { skill: "review" } },
    expect: reviewed,
  },
  {
    name: "session start",
    event: "SessionStart",
    input: { source: "startup" },
    expect: (f) => (f.keys.broad ? [f.keys.broad] : []),
  },
  {
    name: "subagent start",
    event: "SubagentStart",
    input: { agent_id: "a1", agent_type: "Explore" },
    expect: (f) => (f.keys.broad ? [f.keys.broad] : []),
  },
];

/** The input for one call: the case's own fields, filled with the fixture's last record where a path or prompt is needed */
function inputOf(c: Case, f: Fixture, sessionId: string, call: number): Record<string, unknown> {
  const last = f.units - 1;
  const file = c.calls ? `src/mod${last - call}/a.ts` : `src/mod${last}/a.ts`;
  const tool = c.input.tool_name;
  const toolInput =
    (c.input.tool_input as Record<string, unknown> | undefined) ??
    (tool === "Bash"
      ? { command: `cat ${file} | head -20` }
      : tool === "Read" || tool === "Edit"
        ? { file_path: path.join(f.repo, file), old_string: "a", new_string: "b" }
        : undefined);
  const resolved =
    toolInput && typeof toolInput.file_path === "string" && !path.isAbsolute(toolInput.file_path)
      ? { ...toolInput, file_path: path.join(f.repo, toolInput.file_path) }
      : toolInput;
  return {
    hook_event_name: c.event,
    session_id: sessionId,
    cwd: f.repo,
    transcript_path: path.join(home, `${sessionId}.jsonl`),
    prompt: `fnAlpha${last} と src/mod${last}/b.ts を直したい`,
    ...c.input,
    ...(resolved ? { tool_input: resolved } : {}),
  };
}

/** The child's environment: nothing of the owner's Sphica, Codex, or Claude Code session, and a home and database of its own */
function env(f: Fixture): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env))
    if (!/^(SPHICA_|CODEX_|CLAUDE_)/.test(k) && k !== "HOME" && k !== "USERPROFILE") out[k] = v;
  return {
    ...out,
    HOME: home,
    USERPROFILE: home,
    SPHICA_HOME: path.join(home, ".sphica"),
    SPHICA_DB: f.db.file,
  };
}

type Call = { ms: number; problem: string | null };

/** One hook call in a fresh process, killed at its time limit */
function call(input: Record<string, unknown>, f: Fixture, limitMs: number): Promise<Call & { text: string }> {
  return new Promise((resolve) => {
    const start = performance.now();
    const child = spawn(process.execPath, [HOOK], {
      cwd: f.repo,
      env: env(f),
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, limitMs);
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.on("close", () => {
      clearTimeout(timer);
      const ms = performance.now() - start;
      if (killed) return resolve({ ms, problem: "timeout", text: "" });
      if (!out) return resolve({ ms, problem: null, text: "" });
      try {
        const text = String(JSON.parse(out)?.hookSpecificOutput?.additionalContext ?? "");
        resolve({ ms, problem: null, text });
      } catch {
        resolve({ ms, problem: "invalid output", text: "" });
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

/** What is wrong with a reply, or null */
function judge(text: string, expected: string[]): string | null {
  if (text.includes("Sphica unavailable")) return "unavailable";
  if (!expected.length) return null;
  const missing = expected.filter((k) => !text.includes(k));
  return missing.length ? `missing ${missing.join(", ")}` : null;
}

type Row = { fixture: string; case: string; median: number; max: number; problems: string[] };

async function measure(f: Fixture, timeouts: Record<string, number>): Promise<Row[]> {
  const rows: Row[] = [];
  for (const c of CASES) {
    if (c.only && !f.name.startsWith(c.only)) continue;
    const limit = timeouts[c.event] ?? 5000;
    const times: number[] = [];
    const problems: string[] = [];
    for (let r = 0; r < RUNS; r++) {
      const sessionId = `${f.name}-${c.name}-${r}`.replace(/[^\w-]/g, "_");
      for (let k = 0; k < (c.calls ?? 1); k++) {
        const got = await call(inputOf(c, f, sessionId, k), f, limit);
        times.push(got.ms);
        // Only the first read of a session has to name its record: later ones may be spent by the budget
        const problem = got.problem ?? judge(got.text, k === 0 ? c.expect(f) : []);
        if (problem) problems.push(problem);
        if (!c.expect(f).length && !c.calls && got.text && c.event === "UserPromptSubmit")
          problems.push("a prompt naming nothing delivered");
      }
    }
    times.sort((a, b) => a - b);
    rows.push({
      fixture: f.name,
      case: c.name,
      median: Math.round(times[Math.floor(times.length / 2)] ?? 0),
      max: Math.round(times.at(-1) ?? 0),
      problems: [...new Set(problems)],
    });
  }
  return rows;
}

type Drain = { queued: number; ms: number; sent: number; left: number; rows: number; listings: number };

/** Capture's send of a queue of k messages left by an outage, in this process with its own SPHICA_HOME */
async function drain(k: number): Promise<Drain> {
  const db = tempDb();
  project(db, KEY, "o/r");
  const dir = spoolDir();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const t = Date.now();
  for (let i = 0; i < k; i++) {
    const body = `message ${i} `.repeat(40);
    fs.writeFileSync(
      path.join(dir, `${t}-1-${String(i).padStart(8, "0")}.json`),
      JSON.stringify({
        v: 2,
        kind: "message",
        host: "claude-code",
        session: `s${i % 50}`,
        project: KEY,
        branch: null,
        at: "2026-09-13T00:00:00.000Z",
        turn: `t${i}`,
        id: `t${i}:owner:${i.toString(16).padStart(16, "0")}`,
        speaker: i % 2 ? "assistant" : "owner",
        body,
        truncated: false,
        redacted: false,
        originalBytes: Buffer.byteLength(body),
      }),
    );
  }
  const readdir = fs.readdirSync;
  let listings = 0;
  fs.readdirSync = ((...a: Parameters<typeof readdir>) => {
    if (String(a[0]) === dir) listings++;
    return readdir(...a);
  }) as typeof readdir;
  try {
    const start = performance.now();
    const r = await flush(db.file);
    const ms = Math.round(performance.now() - start);
    const left = readdir(dir).filter((n) => String(n).endsWith(".json")).length;
    const rows = Number(
      db.owner.prepare("select count(*) as n from source where kind = 'session_message'").get()?.n ?? 0,
    );
    return { queued: k, ms, sent: r.sent, left, rows, listings };
  } finally {
    fs.readdirSync = readdir;
    await db.done();
  }
}

const { values } = parseArgs({
  options: {
    sizes: { type: "string", default: "359,1000,3000,10000,30000" },
    "no-stress": { type: "boolean", default: false },
    "no-drain": { type: "boolean", default: false },
  },
});
const sizes = values.sizes.split(",").map(Number);

execFileSync(process.execPath, [path.join(ROOT, "scripts", "bundle.mjs")], { cwd: ROOT, stdio: "ignore" });
const commit = execFileSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["-C", ROOT, "status", "--porcelain", "--", "server/src"], {
  encoding: "utf8",
}).trim();
console.log(
  `Commit ${commit}${dirty ? " with uncommitted server/src changes" : ""}, node ${process.version}, ${os.type()} ${os.release()} ${os.arch()}, ${os.cpus()[0]?.model ?? "unknown CPU"} x${os.cpus().length}`,
);
console.log(
  `Bundled ${path.relative(ROOT, HOOK)} in a fresh process per call, ${RUNS} runs per case, bar ${BAR_MS} ms at 10,000 records`,
);

const timeouts = limits();
const rows: Row[] = [];
const fixtures: [string, number, "uniform" | "stress"][] = [
  ...sizes.map((n): [string, number, "uniform"] => [`uniform ${n}`, n, "uniform"]),
  ...(values["no-stress"] ? [] : [["stress 10000", 10_000, "stress"] as [string, number, "stress"]]),
];
for (const [name, n, kind] of fixtures) {
  const f = await build(name, n, kind);
  try {
    rows.push(...(await measure(f, timeouts)));
  } finally {
    await f.db.done();
    fs.rmSync(f.repo, { recursive: true, force: true });
  }
}

console.log("\n| fixture | case | median ms | max ms | problems |\n|---|---|---|---|---|");
for (const r of rows)
  console.log(`| ${r.fixture} | ${r.case} | ${r.median} | ${r.max} | ${r.problems.join("; ") || "none"} |`);

let failed = rows.some((r) => r.problems.length);
if (!values["no-drain"]) {
  console.log("\n| queued | ms | sent | left | rows | queue listings |\n|---|---|---|---|---|---|");
  for (const k of [1000, 10_000, 50_000]) {
    const d = await drain(k);
    console.log(`| ${d.queued} | ${d.ms} | ${d.sent} | ${d.left} | ${d.rows} | ${d.listings} |`);
    if (d.sent !== k || d.left !== 0 || d.rows !== k) failed = true;
  }
}
fs.rmSync(home, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
