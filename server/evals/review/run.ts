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
import { claimRunDir, codexModelOf, isolatedCodexHome } from "../cloud/codex-home.ts";
import { buildReviewFixture, loadReviewCases, type ReviewFixture } from "./fixture.ts";
import { loadRulesCases } from "./rules-grade.ts";
import {
  claudeArgs,
  claudeMcp,
  claudeSettings,
  codexArgs,
  codexMcp,
  type LanePaths,
  READ_TOOLS,
  RULES_TOOLS,
  reviewPrompt,
  rulesPrompt,
} from "./runner.ts";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const SERVER = path.join(ROOT, "plugin", "dist", "mcp.js");
const BODY = path.join(ROOT, "plugin", "skills", "review", "reviewers", "precedent.md");
const RULES_BODY = path.join(ROOT, "plugin", "skills", "rules", "SKILL.md");
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
  status: number | null;
  reason: string | null;
  seconds: number;
};

const sha256 = (data: string | Buffer) => crypto.createHash("sha256").update(data).digest("hex");

/** The fixture under out, built once and reused by every run of the same out directory; rules adds M1's records and files. */
async function fixtureIn(out: string, rules = false): Promise<ReviewFixture> {
  const dir = path.join(out, rules ? "fixture-rules" : "fixture");
  const manifest = path.join(dir, "fixture.json");
  if (fs.existsSync(manifest)) return JSON.parse(fs.readFileSync(manifest, "utf8")) as ReviewFixture;
  fs.mkdirSync(dir, { recursive: true });
  const cases = loadReviewCases();
  const m1 = loadRulesCases();
  const built = await buildReviewFixture(
    dir,
    rules
      ? { files: { ...cases.files, ...m1.files }, steps: [...cases.steps, ...m1.steps], diffs: [] }
      : cases,
  );
  fs.writeFileSync(manifest, `${JSON.stringify(built, null, 2)}\n`);
  return built;
}

/** Spawns a command with the input on stdin and resolves with its exit status and output; never rejects on a non-zero exit. */
function runChild(
  command: string,
  args: string[],
  o: { cwd: string; env: Record<string, string>; input: string; timeoutMs: number },
): Promise<{ status: number | null; stdout: string; stderr: string; error: string | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: o.cwd, env: o.env });
    let stdout = "";
    let stderr = "";
    let error: string | null = null;
    const timer = setTimeout(() => {
      error = `timed out after ${o.timeoutMs / 60_000} minutes`;
      child.kill("SIGKILL");
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
}): Promise<{ dir: string; result: LaneResult }> {
  const name = o.diff ?? "rules";
  const { run, dir } = claimRunDir(o.out, `${name}-${o.host}`);
  const started = Date.now();
  const p: LanePaths = {
    work: path.join(dir, "work"),
    diff: "",
    db: path.join(dir, "db", "sphica.db"),
    home: path.join(dir, "home"),
    server: SERVER,
  };
  const body = fs.readFileSync(o.body, "utf8");
  const result: LaneResult = {
    run,
    host: o.host,
    diff: name,
    model: null,
    cli: "",
    body_sha256: sha256(body),
    server_sha256: sha256(fs.readFileSync(SERVER)),
    status: null,
    reason: null,
    seconds: 0,
  };
  try {
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
    const prompt = o.prompt(body, p);
    fs.writeFileSync(path.join(dir, "prompt.md"), prompt);

    let r: Awaited<ReturnType<typeof runChild>>;
    if (o.host === "claude") {
      const settings = path.join(dir, "settings.json");
      const mcp = path.join(dir, "mcp.json");
      fs.writeFileSync(settings, `${JSON.stringify(claudeSettings(o.tools), null, 2)}\n`);
      fs.writeFileSync(mcp, `${JSON.stringify(claudeMcp(p), null, 2)}\n`);
      result.model = o.model;
      result.cli = claudeVersion();
      r = await runChild("claude", claudeArgs({ settings, mcp }, o.model), {
        cwd: p.work,
        env: runEnv(process.env),
        input: prompt,
        timeoutMs: 30 * 60_000,
      });
      fs.writeFileSync(path.join(dir, "final.md"), finalAnswer(r.stdout)?.result ?? "");
    } else {
      const codexHome = path.join(dir, "codex-home");
      isolatedCodexHome(codexHome, codexMcp(p));
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
        timeoutMs: 30 * 60_000,
      });
    }
    fs.writeFileSync(path.join(dir, "events.jsonl"), r.stdout);
    fs.writeFileSync(path.join(dir, "stderr.log"), r.stderr);
    result.status = r.status;
    result.reason = r.error ?? (r.status === 0 ? null : `${o.host} exited ${r.status}`);
  } catch (e) {
    result.reason = (e as Error).message;
  } finally {
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
  const lanes = [probe, await runLane(review("codex", "postgres"))];
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
      jobs: { type: "string", default: "4" },
      model: { type: "string", default: "claude-opus-5-5" },
      out: { type: "string", default: path.join(os.homedir(), ".cache", "sphica-eval", "review") },
    },
  });
  const out = path.resolve(args.out ?? "");
  fs.mkdirSync(out, { recursive: true });
  if (!fs.existsSync(SERVER)) throw new Error(`${SERVER} is missing: run bun run bundle first`);
  if (args.preflight) {
    const problems = await preflight(out, args.model ?? "");
    for (const p of problems) console.log(`✗ ${p}`);
    if (problems.length) process.exitCode = 1;
    else console.log("✓ preflight passed");
    return;
  }
  const host = args.host;
  if (host !== "claude" && host !== "codex") throw new Error("--host is claude or codex");
  const fixture = await fixtureIn(out, args.rules);
  const body = path.resolve(args.body ?? (args.rules ? RULES_BODY : BODY));
  const ids = args.rules
    ? ["rules"]
    : args.diff === "all"
      ? loadReviewCases().diffs.map((d) => d.id)
      : [args.diff ?? ""];
  const queue = ids.flatMap((diff) => Array.from({ length: Number(args.runs) }, () => diff));
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
  await Promise.all(Array.from({ length: Math.max(1, Number(args.jobs)) }, worker));
}

await main();
