// M2 of the E3 plan: a change task run with the rule lines only, or with the rule lines and the drafted Biome check installed, on Claude or
// Codex, then judged by machine: whether the final patch still holds a forbidden import (the violation that reached the commit), whether
// the installed check failed on the allowed exception, and whether the task's hidden test passes.
// Run from server/:
//   node evals/review/m2.ts --host claude|codex --condition rules|check --task <id>|all --runs <n> [--jobs <n>] [--out <dir>]
//   node evals/review/m2.ts --report <runs dir>
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { claudeVersion, DENY_DIRS, DENY_FILES, finalAnswer, runEnv } from "../cloud/claude-run.ts";
import {
  type Checkout,
  checkoutGit,
  claimRunDir,
  codexModelOf,
  isolatedCodexHome,
  pinCheckout,
} from "../cloud/codex-home.ts";
import { linksOutside, runHiddenTest } from "../cloud/hidden-test.ts";
import { restrictedImports } from "./biome.ts";
import { buildReviewFixture, loadReviewCases, type ReviewFixture } from "./fixture.ts";
import { loadRulesCases } from "./rules-grade.ts";

type Task = { id: string; tempts: "lodash" | "db" | "none"; prompt: string; test: string };
type M2Cases = { rules: string; check: string; conditions: string[]; tasks: Task[] };
const cases = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "m2-cases.json"), "utf8")) as M2Cases;
/** The change tasks, for the tests that judge hand-made patches */
export const m2Tasks = (): Task[] => cases.tasks;
const BIOME = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");
const ORIGIN = "https://github.com/example/tsundoku.git";

/** The rules fixture (M1's records and files), built once per out directory. */
async function fixtureIn(out: string): Promise<ReviewFixture> {
  const dir = path.join(out, "fixture-rules");
  const manifest = path.join(dir, "fixture.json");
  if (fs.existsSync(manifest)) return JSON.parse(fs.readFileSync(manifest, "utf8")) as ReviewFixture;
  fs.mkdirSync(dir, { recursive: true });
  const review = loadReviewCases();
  const m1 = loadRulesCases();
  const built = await buildReviewFixture(dir, {
    files: { ...review.files, ...m1.files },
    steps: [...review.steps, ...m1.steps],
    diffs: [],
  });
  fs.writeFileSync(manifest, `${JSON.stringify(built, null, 2)}\n`);
  return built;
}

const git = (work: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-C",
      work,
      "-c",
      "user.name=eval",
      "-c",
      "user.email=eval@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );

/**
 * The checkout a run starts from: the fixture, the rule lines in CLAUDE.md and AGENTS.md, a check script that runs the pinned Biome, and,
 * under check, the drafted check as biome.jsonc in place of the project's biome.json. Committed, so the patch is what the agent changed,
 * and its git directory copied to `gitDir` before the run starts: the run can write the checkout's own, and its config would run on the host.
 */
export function prepare(
  repo: string,
  work: string,
  condition: string,
  gitDir: string,
): { start: string; checkout: Checkout } {
  execFileSync("git", ["clone", "-q", repo, work]);
  git(work, "remote", "set-url", "origin", ORIGIN);
  fs.writeFileSync(path.join(work, "CLAUDE.md"), cases.rules);
  fs.writeFileSync(path.join(work, "AGENTS.md"), cases.rules);
  fs.mkdirSync(path.join(work, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(work, "scripts", "check.mjs"),
    `// Lints the project with Biome and fails on what it reports\nimport { spawnSync } from "node:child_process";\nconst r = spawnSync(process.execPath, [${JSON.stringify(BIOME)}, "lint", "."], { stdio: "inherit" });\nprocess.exit(r.status ?? 1);\n`,
  );
  if (condition === "check") {
    fs.rmSync(path.join(work, "biome.json"));
    fs.writeFileSync(path.join(work, "biome.jsonc"), cases.check);
  }
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", `the ${condition} condition`);
  return { start: git(work, "rev-parse", "HEAD").trim(), checkout: pinCheckout(work, gitDir) };
}

/** The files a run changed since start, tracked or not, read through the pinned git directory. */
const changed = (c: Checkout, start: string) => {
  checkoutGit(c, ["add", "-A"]);
  return checkoutGit(c, ["diff", "--cached", "--name-only", start]).split("\n").filter(Boolean);
};

export type M2Judgement = {
  /** Changed files that still import what the records forbid */
  violations: string[];
  /** The allowed exception flagged by the installed check (check condition only) */
  falseFailure: boolean;
  completed: boolean;
  tests: string;
};

/**
 * A finished run judged on a copy of its checkout: the forbidden imports by the drafted check (whatever was installed), whether the check
 * installed in the run itself flags the exception, and the hidden test.
 */
export function judge(
  c: Checkout,
  start: string,
  task: Task,
  scratch: string,
  // The OS sandbox runs the hidden test on macOS only; a test on another host passes the same Node fence without it
  hidden: (
    work: string,
    test: string,
  ) => { tests: string; parts: { completion: string | null } } = runHiddenTest,
): M2Judgement {
  const work = c.work;
  // The run wrote this checkout: a link out of it would let the judge read or write the owner's files
  if (linksOutside(work)) throw new Error("a link in the checkout leads outside it; the run is not judged");
  const files = changed(c, start);
  fs.cpSync(work, scratch, { recursive: true, filter: (src) => path.basename(src) !== ".git" });
  const installed = fs.existsSync(path.join(scratch, "biome.jsonc"))
    ? restrictedImports(scratch).map((r) => r.path)
    : null;
  fs.rmSync(path.join(scratch, "biome.json"), { force: true });
  fs.rmSync(path.join(scratch, "biome.jsonc"), { force: true });
  fs.writeFileSync(path.join(scratch, "biome.jsonc"), cases.check, { flag: "wx" });
  const flagged = new Set(restrictedImports(scratch).map((r) => r.path));
  const result = hidden(scratch, task.test);
  // A test that never ran says nothing about completion: the run is a failure, not an unfinished task
  if (result.parts.completion === null) throw new Error(`the hidden test did not run: ${result.tests}`);
  return {
    violations: files.filter((f) => flagged.has(f)),
    falseFailure: task.tempts === "none" && (installed ?? []).some((f) => f === "src/ui/admin.ts"),
    completed: result.parts.completion === "pass",
    tests: result.tests,
  };
}

function runChild(command: string, args: string[], cwd: string, env: Record<string, string>, input: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string; error: string | null }>(
    (resolve) => {
      const child = spawn(command, args, { cwd, env, detached: true });
      let stdout = "";
      let stderr = "";
      let error: string | null = null;
      const timer = setTimeout(() => {
        error = "timed out after 20 minutes";
        process.kill(-(child.pid ?? 0), "SIGKILL");
      }, 20 * 60_000);
      child.stdout.on("data", (d) => {
        stdout += d;
      });
      child.stderr.on("data", (d) => {
        stderr += d;
      });
      child.on("error", (e) => {
        error = e.message;
      });
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr, error });
      });
      child.stdin.end(input);
    },
  );
}

/** Claude may edit its checkout and run commands inside the sandbox; nothing outside the checkout is readable to its file tools. */
const claudeSettings = () => ({
  permissions: {
    blockReadsOutsideWorkingDirectories: true,
    deny: [
      "WebFetch",
      "WebSearch",
      ...DENY_DIRS.map((d) => `Read(/${d}/**)`),
      ...DENY_FILES.map((f) => `Read(/${f})`),
    ],
  },
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    failIfUnavailable: true,
    filesystem: { denyRead: [...DENY_DIRS, ...DENY_FILES] },
  },
  hooks: {},
});

async function runOne(o: {
  fixture: ReviewFixture;
  host: string;
  condition: string;
  task: Task;
  out: string;
  model: string;
}) {
  const { run, dir } = claimRunDir(o.out, `${o.task.id}-${o.condition}-${o.host}`);
  const started = Date.now();
  const work = path.join(dir, "work");
  const result: Record<string, unknown> = { run, host: o.host, condition: o.condition, task: o.task.id };
  try {
    const { start, checkout } = prepare(o.fixture.repo, work, o.condition, path.join(dir, "git"));
    let r: Awaited<ReturnType<typeof runChild>>;
    if (o.host === "claude") {
      const settings = path.join(dir, "settings.json");
      const mcp = path.join(dir, "mcp.json");
      fs.writeFileSync(settings, JSON.stringify(claudeSettings(), null, 2));
      fs.writeFileSync(mcp, JSON.stringify({ mcpServers: {} }));
      result.model = o.model;
      result.cli = claudeVersion();
      r = await runChild(
        "claude",
        [
          "-p",
          "--setting-sources",
          "project",
          "--settings",
          settings,
          "--strict-mcp-config",
          "--mcp-config",
          mcp,
          "--permission-mode",
          "acceptEdits",
          "--output-format",
          "stream-json",
          "--verbose",
          "--no-session-persistence",
          "--model",
          o.model,
        ],
        work,
        runEnv(process.env),
        o.task.prompt,
      );
      fs.writeFileSync(path.join(dir, "final.md"), finalAnswer(r.stdout)?.result ?? "");
    } else {
      const codexHome = path.join(dir, "codex-home");
      isolatedCodexHome(codexHome);
      result.model = codexModelOf(codexHome);
      result.cli = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
      const home = path.join(dir, "home");
      const tmp = path.join(dir, "tmp");
      fs.mkdirSync(home);
      fs.mkdirSync(tmp);
      r = await runChild(
        "codex",
        [
          "exec",
          "--json",
          "--ignore-rules",
          "--ephemeral",
          "-s",
          "workspace-write",
          "-C",
          work,
          "-o",
          path.join(dir, "final.md"),
          "-",
        ],
        work,
        {
          PATH: process.env.PATH ?? "",
          HOME: home,
          CODEX_HOME: codexHome,
          TMPDIR: tmp,
          LANG: process.env.LANG ?? "",
        },
        o.task.prompt,
      );
    }
    fs.writeFileSync(path.join(dir, "events.jsonl"), r.stdout);
    fs.writeFileSync(path.join(dir, "stderr.log"), r.stderr);
    result.status = r.status;
    result.reason = r.error ?? (r.status === 0 ? null : `${o.host} exited ${r.status}`);
    result.judgement = judge(checkout, start, o.task, path.join(dir, "judged"));
  } catch (e) {
    result.reason = (e as Error).message;
  } finally {
    result.seconds = Math.round((Date.now() - started) / 1000);
    fs.writeFileSync(path.join(dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  }
  return { dir, result };
}

function report(runs: string) {
  const rows = new Map<
    string,
    { runs: number; failed: number; violations: number; falseFailures: number; completed: number }
  >();
  for (const name of fs.readdirSync(runs).sort()) {
    const file = path.join(runs, name, "result.json");
    if (name.startsWith("fixture") || !fs.statSync(path.join(runs, name)).isDirectory()) continue;
    // A run directory without its result counts as a failed run
    const [, task = "", condition = "", host = ""] = /^(\w+)-(rules|check)-(claude|codex)-/.exec(name) ?? [];
    const r = (
      fs.existsSync(file)
        ? JSON.parse(fs.readFileSync(file, "utf8"))
        : { host, condition, task, status: null }
    ) as {
      host: string;
      condition: string;
      task: string;
      status: number | null;
      judgement?: M2Judgement;
    };
    for (const key of [`${r.host} ${r.condition}`, `${r.host} ${r.condition} ${r.task}`]) {
      const t = rows.get(key) ?? { runs: 0, failed: 0, violations: 0, falseFailures: 0, completed: 0 };
      rows.set(key, t);
      t.runs++;
      if (r.status !== 0 || !r.judgement) {
        t.failed++;
        continue;
      }
      if (r.judgement.violations.length) t.violations++;
      if (r.judgement.falseFailure) t.falseFailures++;
      if (r.judgement.completed) t.completed++;
    }
  }
  console.log(
    "| | runs | failed | runs with a violation | false failures | completed |\n|---|---|---|---|---|---|",
  );
  for (const [k, t] of [...rows].sort(([a], [b]) => a.localeCompare(b)))
    console.log(`| ${k} | ${t.runs} | ${t.failed} | ${t.violations} | ${t.falseFailures} | ${t.completed} |`);
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      report: { type: "string" },
      host: { type: "string" },
      condition: { type: "string" },
      task: { type: "string", default: "all" },
      runs: { type: "string", default: "1" },
      jobs: { type: "string", default: "3" },
      model: { type: "string", default: "claude-opus-5-5" },
      out: { type: "string", default: path.join(os.homedir(), ".cache", "sphica-eval", "review", "m2") },
    },
  });
  if (args.report) return report(path.resolve(args.report));
  const host = args.host ?? "";
  const condition = args.condition ?? "";
  if (host !== "claude" && host !== "codex") throw new Error("--host is claude or codex");
  if (!cases.conditions.includes(condition))
    throw new Error(`--condition is one of ${cases.conditions.join(", ")}`);
  const tasks = cases.tasks.filter((t) => args.task === "all" || t.id === args.task);
  if (!tasks.length) throw new Error(`--task is all or one of ${cases.tasks.map((t) => t.id).join(", ")}`);
  const runs = Number(args.runs);
  const jobs = Number(args.jobs);
  // A mistyped count would start no run and still exit 0, reading as an experiment with nothing in it
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs is a whole number of 1 or more");
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error("--jobs is a whole number of 1 or more");
  const out = path.resolve(args.out ?? "");
  fs.mkdirSync(out, { recursive: true });
  const fixture = await fixtureIn(out);
  const queue = tasks.flatMap((task) => Array.from({ length: runs }, () => task));
  const worker = async () => {
    for (let task = queue.shift(); task; task = queue.shift()) {
      const { dir, result } = await runOne({ fixture, host, condition, task, out, model: args.model ?? "" });
      console.log(`${result.run}: ${result.reason ?? "ok"} → ${dir}`);
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
}

if (process.argv[1] === import.meta.filename) await main();
