// Runs precedent lanes of the review evaluation on this machine, and the preflight that vouches for how they are fenced.
// Run from server/ after `bun run bundle`:
//   node evals/review/run.ts --preflight [--out <dir>]
//   node evals/review/run.ts --host claude|codex --diff <id>|all --runs <n> [--body <file>] [--jobs <n>] [--out <dir>]
//   node evals/review/run.ts --rules --host claude|codex --runs <n> [--body <file>] [--jobs <n>] [--out <dir>]
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { claudeVersion, finalAnswer, runEnv } from "../cloud/claude-run.ts";
import { claimRunDir, codexModelOf, fencedCodexHome } from "../cloud/codex-home.ts";
import { cachedFixture, loadReviewCases, type ReviewFixture } from "./fixture.ts";
import { loadRulesCases } from "./rules-grade.ts";
import {
  claudeArgs,
  claudeMcp,
  claudeSettings,
  codexArgs,
  codexMcp,
  evalDenies,
  keepCheckout,
  type LanePaths,
  outsideCheckout,
  READ_TOOLS,
  RULES_BODY,
  RULES_TOOLS,
  reviewPrompt,
  rulesPrompt,
  runnerDigest,
} from "./runner.ts";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const SERVER = path.join(ROOT, "plugin", "dist", "mcp.js");
const BODY = path.join(ROOT, "plugin", "skills", "review", "reviewers", "precedent.md");
const ORIGIN = "https://github.com/example/tsundoku.git";

type Host = "claude" | "codex";
type LaneResult = {
  run: string;
  host: Host;
  diff: string;
  model: string | null;
  cli: string;
  body_sha256: string;
  server_sha256: string;
  runner_sha256: string;
  status: number | null;
  reason: string | null;
  seconds: number;
};

const sha256 = (data: string | Buffer) => crypto.createHash("sha256").update(data).digest("hex");

/** The fixture under out, built once and reused by every run of the same out directory; rules adds M1's records and files. */
function fixtureIn(out: string, rules = false): Promise<ReviewFixture> {
  const cases = loadReviewCases();
  const m1 = loadRulesCases();
  return cachedFixture(
    path.join(out, rules ? "fixture-rules" : "fixture"),
    rules
      ? { files: { ...cases.files, ...m1.files }, steps: [...cases.steps, ...m1.steps], diffs: [] }
      : cases,
  );
}

/** Spawns a command with the input on stdin and resolves with its exit status and output; never rejects on a non-zero exit. */
function runChild(
  command: string,
  args: string[],
  o: { cwd: string; env: Record<string, string>; input: string; timeoutMs: number },
): Promise<{ status: number | null; stdout: string; stderr: string; error: string | null }> {
  return new Promise((resolve) => {
    // Its own process group, so a timeout also ends the MCP server it started: that child keeps the pipes open and close never fires
    const child = spawn(command, args, { cwd: o.cwd, env: o.env, detached: true });
    let stdout = "";
    let stderr = "";
    let error: string | null = null;
    const timer = setTimeout(() => {
      error = `timed out after ${o.timeoutMs / 60_000} minutes`;
      process.kill(-(child.pid ?? 0), "SIGKILL");
    }, o.timeoutMs);
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
    child.stdin.end(o.input);
  });
}

/**
 * One lane: a fresh clone of the fixture, a copy of the database, and the host started on a body. A review lane has its diff applied and
 * committed (the tree the reviewer reads is the changed one) and gets the diff as a file inside the checkout's git directory.
 */
async function runLane(o: {
  fixture: ReviewFixture;
  host: Host;
  /** The case's diff id, or null for a rules lane */
  diff: string | null;
  body: string;
  out: string;
  model: string;
  prompt: (body: string, p: LanePaths) => string;
  tools: string[];
  /** Writes files into the checkout before the host starts, untracked (the preflight's probe) */
  plant?: (work: string) => void;
}): Promise<{ dir: string; result: LaneResult }> {
  const name = o.diff ?? "rules";
  const { run, dir } = claimRunDir(o.out, `${name}-${o.host}`);
  const started = Date.now();
  const p: LanePaths = {
    work: outsideCheckout("review-work-"),
    diff: "",
    db: path.join(dir, "db", "sphica.db"),
    home: path.join(dir, "home"),
    server: SERVER,
  };
  const result: LaneResult = {
    run,
    host: o.host,
    diff: name,
    model: null,
    cli: "",
    body_sha256: "",
    server_sha256: "",
    runner_sha256: runnerDigest(),
    status: null,
    reason: null,
    seconds: 0,
  };
  // Everything that can fail is inside, so a run that stops early still leaves its result
  try {
    const body = fs.readFileSync(o.body, "utf8");
    result.body_sha256 = sha256(body);
    result.server_sha256 = sha256(fs.readFileSync(SERVER));
    execFileSync("git", ["clone", "-q", o.fixture.repo, p.work]);
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-C",
          p.work,
          "-c",
          "user.name=hana",
          "-c",
          "user.email=hana@example.invalid",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { encoding: "utf8" },
      );
    // Sphica finds the records' project by origin
    git("remote", "set-url", "origin", ORIGIN);
    if (o.diff !== null) {
      const diffFile = o.fixture.diffs[o.diff];
      if (!diffFile) throw new Error(`no diff ${o.diff}`);
      git("apply", "--index", diffFile);
      git("commit", "-q", "-m", "the change under review");
      p.diff = path.join(git("rev-parse", "--absolute-git-dir").trim(), "review.diff");
      fs.copyFileSync(diffFile, p.diff);
    }
    fs.mkdirSync(path.dirname(p.db), { recursive: true });
    fs.copyFileSync(o.fixture.db, p.db);
    fs.mkdirSync(p.home, { recursive: true });
    o.plant?.(p.work);
    const prompt = o.prompt(body, p);
    fs.writeFileSync(path.join(dir, "prompt.md"), prompt);
    fs.writeFileSync(path.join(dir, "checkout.txt"), `${p.work}\n`);

    let r: Awaited<ReturnType<typeof runChild>>;
    if (o.host === "claude") {
      const settings = path.join(dir, "settings.json");
      const mcp = path.join(dir, "mcp.json");
      fs.writeFileSync(settings, `${JSON.stringify(claudeSettings(o.tools, evalDenies(o.out)), null, 2)}\n`);
      fs.writeFileSync(mcp, `${JSON.stringify(claudeMcp(p), null, 2)}\n`);
      result.model = o.model;
      result.cli = claudeVersion();
      r = await runChild("claude", claudeArgs({ settings, mcp }, o.model), {
        cwd: p.work,
        env: runEnv(process.env),
        input: prompt,
        timeoutMs: 10 * 60_000,
      });
      fs.writeFileSync(path.join(dir, "final.md"), finalAnswer(r.stdout)?.result ?? "");
    } else {
      const codexHome = path.join(dir, "codex-home");
      fencedCodexHome(codexHome, { base: ":read-only", deny: evalDenies(o.out), extraConfig: codexMcp(p) });
      result.model = codexModelOf(codexHome);
      result.cli = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
      const tmp = path.join(dir, "tmp");
      fs.mkdirSync(tmp);
      r = await runChild("codex", codexArgs(p.work, path.join(dir, "final.md")), {
        cwd: p.work,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: p.home,
          CODEX_HOME: codexHome,
          TMPDIR: tmp,
          LANG: process.env.LANG ?? "",
        },
        input: prompt,
        timeoutMs: 10 * 60_000,
      });
    }
    fs.writeFileSync(path.join(dir, "events.jsonl"), r.stdout);
    fs.writeFileSync(path.join(dir, "stderr.log"), r.stderr);
    result.status = r.status;
    result.reason = r.error ?? (r.status === 0 ? null : `${o.host} exited ${r.status}`);
  } catch (e) {
    result.reason = (e as Error).message;
  } finally {
    keepCheckout(p.work, dir);
    result.seconds = Math.round((Date.now() - started) / 1000);
    fs.writeFileSync(path.join(dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  }
  return { dir, result };
}

type Event = Record<string, unknown> & { type?: string };
const events = (dir: string): Event[] =>
  fs
    .readFileSync(path.join(dir, "events.jsonl"), "utf8")
    .split("\n")
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Event];
      } catch {
        return [];
      }
    });

/** Every text a run's events hold, as one string: what the reviewer read and said */
const everything = (dir: string) => fs.readFileSync(path.join(dir, "events.jsonl"), "utf8");

/**
 * What the preflight requires of the lanes before any measured run: Claude cannot read a file outside its checkout, both hosts reach the
 * read server on the run's database (review_select selects the fixture's record), and Claude starts with no tool, MCP server, or plugin
 * beyond the lane's.
 */
async function preflight(out: string, model: string): Promise<string[]> {
  const fixture = await fixtureIn(out);
  const review = (host: Host, diff: string) => ({
    fixture,
    host,
    diff,
    body: BODY,
    out,
    model,
    prompt: (body: string, p: LanePaths) => reviewPrompt(body, { ...p, model: host }),
    tools: READ_TOOLS,
  });
  const problems: string[] = [];
  const token = crypto.randomUUID();
  const outside = path.join(out, "outside.txt");
  fs.writeFileSync(outside, `${token}\n`);
  const probe = await runLane({
    ...review("claude", "postgres"),
    prompt: (body, p) =>
      `${reviewPrompt(body, { ...p, model: "claude" })}\nBefore reviewing, use the Read tool on ${outside} and quote its first line in your reply.\n`,
  });
  if (everything(probe.dir).includes(token)) problems.push(`claude read ${outside}, outside its checkout`);
  // A probe that never tried the read would pass without showing the fence
  type Block = { type?: string; name?: string; input?: { file_path?: string } };
  const tried = events(probe.dir).some((e) => {
    const content = (e.message as { content?: unknown } | undefined)?.content;
    return (
      Array.isArray(content) &&
      (content as Block[]).some(
        (c) => c.type === "tool_use" && c.name === "Read" && c.input?.file_path === outside,
      )
    );
  });
  if (!tried)
    problems.push("claude never tried to read the file outside its checkout, so the fence was not shown");
  const init = events(probe.dir).find((e) => e.type === "system" && e.subtype === "init") as
    | { tools?: string[]; mcp_servers?: { name: string; status: string }[]; plugins?: unknown[] }
    | undefined;
  if (!init) problems.push("claude: no init event");
  else {
    const extra = (init.tools ?? []).filter(
      (t) => !["Read", "Grep", "Glob"].includes(t) && !t.startsWith("mcp__sphica__"),
    );
    if (extra.length) problems.push(`claude started with other tools: ${extra.join(", ")}`);
    const servers = (init.mcp_servers ?? []).map((s) => `${s.name}:${s.status}`);
    if (servers.join(",") !== "sphica:connected")
      problems.push(`claude MCP servers: ${servers.join(", ") || "none"}`);
    // Claude Code's own built-in plugins load in every session, the owner's review included; any other is the owner's
    const owners = (init.plugins ?? []).filter((x) => (x as { path?: string }).path !== "builtin");
    if (owners.length) problems.push(`claude loaded plugins: ${JSON.stringify(owners)}`);
  }
  // Codex reads with its permission profile: a script in the checkout tries what every run must not read, and each must be denied
  const cases = path.join(import.meta.dirname, "cases.json");
  const probeScript = `#!/bin/sh\nfor pair in "cases|${cases}" "outside|${outside}" "auth|$CODEX_HOME/auth.json"; do\n  label=\${pair%%|*}; file=\${pair#*|}\n  if head -c 1 "$file" >/dev/null 2>&1; then echo "READ $label"; else echo "DENIED $label"; fi\ndone\n`;
  const codex = await runLane({
    ...review("codex", "postgres"),
    plant: (work) => fs.writeFileSync(path.join(work, "probe.sh"), probeScript, { mode: 0o755 }),
    prompt: (body, p) =>
      `${reviewPrompt(body, { ...p, model: "codex" })}\nBefore reviewing, run ./probe.sh once and quote its output in your reply.\n`,
  });
  const fence = everything(codex.dir);
  for (const label of ["cases", "outside", "auth"])
    if (!fence.includes(`DENIED ${label}`))
      problems.push(`codex: the probe did not show ${label} denied (${codex.dir})`);
  if (fence.includes(token)) problems.push(`codex read ${outside}`);
  const lanes = [probe, codex];
  for (const lane of lanes) {
    const text = everything(lane.dir);
    if (lane.result.status !== 0) problems.push(`${lane.result.host}: ${lane.result.reason}`);
    if (!text.includes("Decision lane: checked") || !text.includes("trace:s-ja-storage/storage"))
      problems.push(`${lane.result.host}: review_select did not select the fixture's record (${lane.dir})`);
  }
  return problems;
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      preflight: { type: "boolean", default: false },
      rules: { type: "boolean", default: false },
      host: { type: "string" },
      diff: { type: "string" },
      runs: { type: "string", default: "1" },
      body: { type: "string" },
      jobs: { type: "string", default: "1" },
      model: { type: "string", default: "claude-opus-5-5" },
      out: { type: "string", default: path.join(os.homedir(), ".cache", "sphica-eval", "review") },
    },
  });
  const out = path.resolve(args.out ?? "");
  if (args.preflight) {
    if (!fs.existsSync(SERVER)) throw new Error(`${SERVER} is missing: run bun run bundle first`);
    // Its probe runs go apart from the measured ones, which the grader counts by directory name
    const problems = await preflight(path.join(out, "preflight"), args.model ?? "");
    for (const p of problems) console.log(`✗ ${p}`);
    if (problems.length) process.exitCode = 1;
    else console.log("✓ preflight passed");
    return;
  }
  const host = args.host;
  if (host !== "claude" && host !== "codex") throw new Error("--host is claude or codex");
  const known = loadReviewCases().diffs.map((d) => d.id);
  if (!args.rules && args.diff !== "all" && !known.includes(args.diff ?? ""))
    throw new Error(`--diff is all or one of ${known.join(", ")}`);
  const runs = Number(args.runs);
  const jobs = Number(args.jobs);
  // A mistyped count would start no run and still exit 0, reading as an experiment with nothing in it
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs is a whole number of 1 or more");
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error("--jobs is a whole number of 1 or more");
  // A Codex command can read the temp directory, where another run's checkout sits while it runs; Claude's lanes here have no shell
  if (host === "codex" && jobs > 1)
    throw new Error("--jobs is 1 for Codex: concurrent runs could read each other's checkout");
  if (!fs.existsSync(SERVER)) throw new Error(`${SERVER} is missing: run bun run bundle first`);
  fs.mkdirSync(out, { recursive: true });
  const fixture = await fixtureIn(out, args.rules);
  const body = path.resolve(args.body ?? (args.rules ? RULES_BODY : BODY));
  const ids = args.rules ? ["rules"] : args.diff === "all" ? known : [args.diff ?? ""];
  const queue = ids.flatMap((diff) => Array.from({ length: runs }, () => diff));
  const worker = async () => {
    for (let diff = queue.shift(); diff; diff = queue.shift()) {
      const { dir, result } = await runLane({
        fixture,
        host,
        diff: args.rules ? null : diff,
        body,
        out,
        model: args.model ?? "",
        prompt: args.rules
          ? (b) => rulesPrompt(b, loadRulesCases().picks)
          : (b, p) => reviewPrompt(b, { ...p, model: host }),
        tools: args.rules ? RULES_TOOLS : READ_TOOLS,
      });
      console.log(`${result.run}: ${result.reason ?? "ok"} (${result.seconds}s) → ${dir}`);
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
}

await main();
