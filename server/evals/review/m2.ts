// M2 of the E3 plan: a change task run with the rule lines only, or with the rule lines and the drafted Biome check installed, on Claude or
// Codex, then judged by machine: whether the final patch still holds a forbidden import (the violation that reached the commit), whether
// the installed check failed on the allowed exception, and whether the task's hidden test passes.
// Run from server/:
//   node evals/review/m2.ts --host claude|codex --condition rules|check --task <id>|all --runs <n> [--jobs <n>] [--out <dir>]
//   node evals/review/m2.ts --report <runs dir>
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
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
  fencedCodexHome,
  pinCheckout,
} from "../cloud/codex-home.ts";
import { linksOutside, runHiddenTest } from "../cloud/hidden-test.ts";
import { restrictedImports } from "./biome.ts";
import { cachedFixture, loadReviewCases, type ReviewFixture } from "./fixture.ts";
import { lookedOutside, oneConfiguration } from "./grade.ts";
import { loadRulesCases } from "./rules-grade.ts";
import { evalDenies, keepCheckout, outsideCheckout, runnerDigest } from "./runner.ts";

type Task = { id: string; tempts: "lodash" | "db" | "none"; prompt: string; test: string };
type M2Cases = { rules: string; check: string; conditions: string[]; tasks: Task[] };
const CASES = path.join(import.meta.dirname, "m2-cases.json");
const cases = JSON.parse(fs.readFileSync(CASES, "utf8")) as M2Cases;
/** The change tasks, for the tests that judge hand-made patches */
export const m2Tasks = (): Task[] => cases.tasks;
const BIOME = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");
const BIOME_CONFIGS = new Set(["biome.json", "biome.jsonc", ".biome.json", ".biome.jsonc"]);
const ORIGIN = "https://github.com/example/tsundoku.git";

/** The rules fixture (M1's records and files), built once per out directory. */
function fixtureIn(out: string): Promise<ReviewFixture> {
  const review = loadReviewCases();
  const m1 = loadRulesCases();
  return cachedFixture(path.join(out, "fixture-rules"), {
    files: { ...review.files, ...m1.files },
    steps: [...review.steps, ...m1.steps],
    diffs: [],
  });
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
  // Biome reads every config in the tree, and a config can extend a file anywhere: the run wrote these, so none is kept
  for (const rel of fs.readdirSync(scratch, { recursive: true, encoding: "utf8" }))
    if (BIOME_CONFIGS.has(path.basename(rel))) fs.rmSync(path.join(scratch, rel), { force: true });
  fs.writeFileSync(path.join(scratch, "biome.jsonc"), cases.check, { flag: "wx" });
  const flagged = new Set(restrictedImports(scratch).map((r) => r.path));
  const result = hidden(scratch, task.test);
  // A test that never ran says nothing about completion: the run is a failure, not an unfinished task
  if (result.parts.completion === null) throw new Error(`the hidden test did not run: ${result.tests}`);
  return {
    violations: files.filter((f) => flagged.has(f)),
    // The check the condition installs is this same config, so whether it flags the exception is read from the same report
    falseFailure: task.tempts === "none" && flagged.has("src/ui/admin.ts"),
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
const claudeSettings = (denies: string[]) => ({
  permissions: {
    blockReadsOutsideWorkingDirectories: true,
    deny: [
      "WebFetch",
      "WebSearch",
      ...[...DENY_DIRS, ...denies].map((d) => `Read(/${d}/**)`),
      ...DENY_FILES.map((f) => `Read(/${f})`),
    ],
  },
  // The shell reads past the file tools' fence: the evaluations and the other runs are denied to it too
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    failIfUnavailable: true,
    filesystem: { denyRead: [...DENY_DIRS, ...DENY_FILES, ...denies] },
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
  const work = outsideCheckout("m2-work-");
  const result: Record<string, unknown> = {
    run,
    host: o.host,
    condition: o.condition,
    task: o.task.id,
    runner_sha256: runnerDigest(),
    // The tasks, rule lines, and check the run was given: a later edit of them makes a different measurement
    cases_sha256: crypto.createHash("sha256").update(fs.readFileSync(CASES)).digest("hex"),
  };
  try {
    const { start, checkout } = prepare(o.fixture.repo, work, o.condition, path.join(dir, "git"));
    let r: Awaited<ReturnType<typeof runChild>>;
    if (o.host === "claude") {
      const settings = path.join(dir, "settings.json");
      const mcp = path.join(dir, "mcp.json");
      fs.writeFileSync(settings, JSON.stringify(claudeSettings(evalDenies(o.out)), null, 2));
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
      fencedCodexHome(codexHome, { base: ":workspace", deny: evalDenies(o.out) });
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
    keepCheckout(work, dir);
    result.seconds = Math.round((Date.now() - started) / 1000);
    fs.writeFileSync(path.join(dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  }
  return { dir, result };
}

type Row = {
  runs: number;
  failed: number;
  excluded: number;
  violations: number;
  falseFailures: number;
  completed: number;
};

/**
 * Counts per host and condition, and per task too. A run without its result, or that did not exit 0, is failed; a run whose events name
 * the repository holding the hidden tests and the reference check, or another run, is excluded, as a check behind the read fence.
 */
export function m2Rows(runs: string): Map<string, Row> {
  const rows = new Map<string, Row>();
  // The evaluations, not the whole repository: a run's check script names the Biome installed under server/node_modules
  const forbidden = [path.resolve(import.meta.dirname, "..")];
  oneConfiguration(
    runs,
    fs.readdirSync(runs).filter((n) => /^\w+-(rules|check)-(claude|codex)-\d{4}-/.test(n)),
  );
  for (const name of fs.readdirSync(runs).sort()) {
    const file = path.join(runs, name, "result.json");
    const [, task = "", condition = "", host = ""] =
      /^(\w+)-(rules|check)-(claude|codex)-\d{4}-/.exec(name) ?? [];
    if (!host || !fs.statSync(path.join(runs, name)).isDirectory()) continue;
    const r = (
      fs.existsSync(file)
        ? JSON.parse(fs.readFileSync(file, "utf8"))
        : { host, condition, task, status: null }
    ) as { host: string; condition: string; task: string; status: number | null; judgement?: M2Judgement };
    const events = path.join(runs, name, "events.jsonl");
    const outside = fs.existsSync(events)
      ? lookedOutside(fs.readFileSync(events, "utf8"), { forbidden, runs, run: name })
      : null;
    for (const key of [`${r.host} ${r.condition}`, `${r.host} ${r.condition} ${r.task}`]) {
      const t = rows.get(key) ?? {
        runs: 0,
        failed: 0,
        excluded: 0,
        violations: 0,
        falseFailures: 0,
        completed: 0,
      };
      rows.set(key, t);
      t.runs++;
      if (outside) t.excluded++;
      else if (r.status !== 0 || !r.judgement) t.failed++;
      else {
        if (r.judgement.violations.length) t.violations++;
        if (r.judgement.falseFailure) t.falseFailures++;
        if (r.judgement.completed) t.completed++;
      }
    }
  }
  return rows;
}

function report(runs: string) {
  console.log(
    "| | runs | failed | excluded | runs with a violation | false failures | completed |\n|---|---|---|---|---|---|---|",
  );
  for (const [k, t] of [...m2Rows(runs)].sort(([a], [b]) => a.localeCompare(b)))
    console.log(
      `| ${k} | ${t.runs} | ${t.failed} | ${t.excluded} | ${t.violations} | ${t.falseFailures} | ${t.completed} |`,
    );
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      report: { type: "string" },
      host: { type: "string" },
      condition: { type: "string" },
      task: { type: "string", default: "all" },
      runs: { type: "string", default: "1" },
      jobs: { type: "string", default: "1" },
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
  // Every M2 lane has a shell, which can read the temp directory where another run's checkout sits while it runs
  if (jobs > 1) throw new Error("--jobs is 1 for M2: concurrent runs could read each other's checkout");
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
