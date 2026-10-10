// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// What a local Claude run is started with: the settings file (sandbox, permissions, hooks) and the MCP config for one condition. The run
// uses the owner's login, so everything else of the owner's (settings, CLAUDE.md, plugins, MCP servers) is kept out by the command line
// (project sources only, strict MCP config) and what is left is fenced by the sandbox and acceptEdits.
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openReader } from "../../src/db.ts";
import {
  type Checkout,
  checkoutGit,
  claimRunDir,
  evalCache,
  pinCheckout,
  requireInside,
} from "./codex-home.ts";

type Hook = { type: "command"; command: string; args: string[]; timeout: number };
type HookEntry = { matcher?: string; hooks: Hook[] };

/** Directories a run must never read, whatever the agent tries: the owner's credentials and Sphica's own database. */
export const DENY_DIRS = [".ssh", ".aws", ".config", ".codex", ".claude", ".sphica", ".gnupg"].map((p) =>
  path.join(os.homedir(), p),
);
/** Single credential files: a rule ending in /** would only cover what is under them, not the file itself */
export const DENY_FILES = [".npmrc", ".netrc"].map((p) => path.join(os.homedir(), p));

export type RunPaths = {
  /** The run directory: receipts, the gold marker, the database copy live here */
  run: string;
  /** The checkout the agent works in */
  work: string;
  /** The slot's .tools, copied outside the checkout so the agent cannot rewrite what the hooks run */
  tools: string;
  /** The run's copy of the fixture database */
  db: string;
};

/** Exec-form hook: no shell parses the paths, so a space in them never splits an argument. */
const hook = (args: string[], timeout: number): Hook => ({
  type: "command",
  command: "sh",
  args,
  timeout,
});

/** The settings file of one run. The shipped delivery matcher is passed in so inject fires on the tools the plugin does. */
export function runSettings(condition: string, p: RunPaths, deliverMatcher: string): Record<string, unknown> {
  const dirs = DENY_DIRS;
  const receipt = (name: string, ...command: string[]) =>
    hook([path.join(p.tools, "hook.sh"), name, ...command], 60);
  const deliver = (name: string) =>
    receipt(name, "sh", path.join(p.tools, "sphica.sh"), path.join(p.tools, "dist", "deliver.js"));
  const hooks: Record<string, HookEntry[]> = {
    SessionStart: [{ hooks: [receipt("start")] }],
    // Every condition logs the prompt, so collect can tell which task a run carried out
    UserPromptSubmit: [{ hooks: [receipt("prompt")] }],
    // Which instruction files loaded: the check that none of the owner's reached the run
    InstructionsLoaded: [{ hooks: [receipt("instructions")] }],
  };
  if (condition === "inject") {
    hooks.SessionStart = [{ hooks: [deliver("start")] }];
    hooks.UserPromptSubmit = [{ hooks: [deliver("prompt")] }];
    hooks.PreToolUse = [{ matcher: deliverMatcher, hooks: [deliver("edit")] }];
  }
  if (condition === "gold")
    hooks.UserPromptSubmit = [{ hooks: [receipt("gold", "sh", path.join(p.tools, "gold.sh"))] }];
  return {
    permissions: {
      // Nothing outside the checkout is readable by the file tools or the sandboxed shell: not other runs, not the build's gold, not files
      // of the owner's that no list below names
      blockReadsOutsideWorkingDirectories: true,
      // acceptEdits asks before any MCP call, and a run has no one to answer: Sphica's tools are allowed where the condition has them
      allow: condition === "search" || condition === "inject" ? ["mcp__sphica"] : [],
      deny: [
        "PushNotification",
        "WebFetch",
        "WebSearch",
        ...dirs.flatMap((d) => [`Read(/${d}/**)`, `Edit(/${d}/**)`]),
        ...DENY_FILES.flatMap((f) => [`Read(/${f})`, `Edit(/${f})`]),
      ],
    },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      filesystem: { denyRead: [...dirs, ...DENY_FILES] },
    },
    // MCP tools load through tool search on every run, so old and new start from the same loading and only alwaysLoad can change it
    env: { EVAL_RUN_DIR: p.run, EVAL_SPHICA_DB: p.db, ENABLE_TOOL_SEARCH: "true" },
    hooks,
  };
}

/** The MCP config of one run: Sphica's read server where the condition has it, and nothing otherwise. */
export function runMcp(condition: string, p: RunPaths): { mcpServers: Record<string, unknown> } {
  if (condition !== "search" && condition !== "inject") return { mcpServers: {} };
  return {
    mcpServers: {
      sphica: {
        command: "sh",
        args: [path.join(p.tools, "sphica.sh"), path.join(p.tools, "dist", "mcp.js")],
        env: { EVAL_SPHICA_DB: p.db, EVAL_RUN_DIR: p.run },
      },
    },
  };
}

/** The command line of one run, after `claude`. The model is pinned so old and new are run by the same one. */
export function runArgs(p: { settings: string; mcp: string }, model: string): string[] {
  return [
    "-p",
    // Project sources load the checkout's CLAUDE.md as in the cloud; the runner removed the checkout's settings file
    "--setting-sources",
    "project",
    "--settings",
    p.settings,
    "--strict-mcp-config",
    "--mcp-config",
    p.mcp,
    "--permission-mode",
    "acceptEdits",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--model",
    model,
  ];
}

/**
 * The only variables a run inherits: what claude needs to start and find the owner's login. Anything else of the owner's shell (tokens,
 * the parent session's markers, Sphica's own paths) would reach the agent's commands, which the sandbox does not fence.
 */
const RUN_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "__CF_USER_TEXT_ENCODING",
];

export const runEnv = (parent: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(RUN_ENV.flatMap((k) => (parent[k] === undefined ? [] : [[k, parent[k] as string]])));

/**
 * The Claude Code that runs: a canary vouches for the host it ran on, since a host update can change what stops a tool call. Empty when
 * claude cannot be started or does not answer in time, which matches no canary.
 */
export function claudeVersion(): string {
  try {
    return execFileSync("claude", ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
    }).trim();
  } catch {
    return "";
  }
}

/**
 * The runner's own code, as one hash: a canary vouches for the code that ran it, so a change to how runs are fenced or set up needs a new
 * canary before more runs start.
 */
export function runnerDigest(): string {
  const hash = crypto.createHash("sha256");
  for (const file of [
    "claude-run.ts",
    "claude.ts",
    "canary.ts",
    "canary-check.ts",
    "codex-home.ts",
    "slot-scripts.ts",
  ])
    hash.update(`${file}\0`).update(fs.readFileSync(path.join(import.meta.dirname, file)));
  return hash.digest("hex");
}

/** Tracked and untracked changes since the starting commit, without the slot's scaffolding, built package output, or installed dependencies,
 * the same set the cloud finish hook leaves out. */
export function patchSince(c: Checkout, start: string): string {
  const leave = [":!.tools", ":!.eval", ":!plugin/dist", ":!plugin/db", ":(exclude,glob)**/node_modules/**"];
  // add -A never adds ignored files, and naming an ignored path in its pathspec (built output) fails it: what is left out is left out below
  checkoutGit(c, ["add", "-A"]);
  // Files the agent wrote under ignored paths (a plan, docs) are part of its answer too
  const ignored = checkoutGit(c, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--",
    ".",
    ...leave,
  ])
    .split("\0")
    .filter(Boolean);
  if (ignored.length) checkoutGit(c, ["add", "-f", "--", ...ignored]);
  return checkoutGit(c, ["diff", "--cached", start, "--", ".", ...leave]);
}

/** The last result event of a stream-json run: the final answer, or nothing when the run was cut off. */
export function finalAnswer(events: string): { result: string; is_error: boolean } | undefined {
  return events
    .split("\n")
    .flatMap((l) => {
      try {
        const e = JSON.parse(l) as { type?: string; result?: unknown; is_error?: unknown };
        return e.type === "result" ? [{ result: String(e.result ?? ""), is_error: e.is_error === true }] : [];
      } catch {
        return [];
      }
    })
    .at(-1);
}

/** The delivery hook's matcher in the slot's own settings, as the build wrote it; empty when the slot delivers nothing. */
export function slotMatcher(work: string): string {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(work, ".claude", "settings.json"), "utf8")) as {
      hooks?: { PreToolUse?: { matcher?: string }[] };
    };
    return settings.hooks?.PreToolUse?.[0]?.matcher ?? "";
  } catch {
    return "";
  }
}

type RunResult = {
  run: string;
  build: string | undefined;
  model: "claude";
  claude_model: string;
  repo: string;
  condition: string;
  task: string;
  status: number | null;
  reason: string | null;
  deliveries?: { event: string; outcome: string; units: string[] }[] | null;
  seconds?: number;
};

/**
 * One local Claude run: a fresh clone of the slot, its own database copy and receipts, and claude -p fenced by the sandbox and acceptEdits.
 * Nothing is committed to the slot or pushed: the patch is the diff from the clone's starting commit.
 */
export async function runClaude(o: {
  build: string;
  buildId: string | undefined;
  owner: string;
  repo: string;
  condition: string;
  task: string;
  prompt: string;
  out: string;
  model: string;
  /** Files committed into the clone before the run starts (the canary's positive control) */
  plant?: Record<string, string>;
}): Promise<{ dir: string; result: RunResult }> {
  // The clone, its .tools, and its database copy stay where every fenced Codex run is denied
  const out = requireInside(evalCache(), o.out, "--out");
  const { run, dir } = claimRunDir(out, `${o.task}-${o.condition}`);
  const work = path.join(dir, "work");
  const tools = path.join(dir, "tools");
  const db = path.join(dir, "db", "sphica.db");
  fs.writeFileSync(
    path.join(dir, "started.json"),
    `${JSON.stringify({ run, build: o.buildId, model: "claude", repo: o.repo, condition: o.condition, task: o.task, at: new Date().toISOString() }, null, 2)}\n`,
  );
  const started = Date.now();
  const result: RunResult = {
    run,
    build: o.buildId,
    model: "claude",
    claude_model: o.model,
    repo: o.repo,
    condition: o.condition,
    task: o.task,
    status: null,
    reason: null,
  };
  try {
    execFileSync("git", ["clone", "-q", path.join(o.build, o.repo), work]);
    // Sphica identifies the project by origin, so the clone points where the cloud checkout does; nothing is pushed
    execFileSync("git", [
      "-C",
      work,
      "remote",
      "set-url",
      "origin",
      `https://github.com/${o.owner}/${o.repo}.git`,
    ]);
    // The slot's own settings carry the cloud's hooks (one commits and pushes); the run's settings come from --settings instead, while
    // project sources stay on so the checkout's CLAUDE.md loads as it does in the cloud
    // The delivery matcher is the one the build wrote into its slot, so old and new builds fire on the tools each was built with
    const matcher = slotMatcher(work);
    for (const [rel, body] of Object.entries(o.plant ?? {})) fs.writeFileSync(path.join(work, rel), body);
    if (fs.existsSync(path.join(work, ".claude", "settings.json")))
      execFileSync("git", ["-C", work, "rm", "-q", ".claude/settings.json"]);
    execFileSync("git", ["-C", work, "add", "-A"]);
    if (execFileSync("git", ["-C", work, "status", "--porcelain"], { encoding: "utf8" }).trim()) {
      execFileSync("git", [
        "-C",
        work,
        "-c",
        "user.name=eval",
        "-c",
        "user.email=eval@example.invalid",
        "commit",
        "-qm",
        "local run: the runner's settings and files",
      ]);
    }
    const start = execFileSync("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    fs.cpSync(path.join(work, ".tools"), tools, { recursive: true });
    fs.mkdirSync(path.dirname(db), { recursive: true });
    const paths = { run: dir, work, tools, db };
    const settings = path.join(dir, "settings.json");
    const mcp = path.join(dir, "mcp.json");
    fs.writeFileSync(settings, `${JSON.stringify(runSettings(o.condition, paths, matcher), null, 2)}\n`);
    fs.writeFileSync(mcp, `${JSON.stringify(runMcp(o.condition, paths), null, 2)}\n`);
    const env = runEnv(process.env);
    // After each tool result the work tree is looked at, so the first change can be tied to the call that made it; the start state is
    // taken before the agent starts
    const checkout = pinCheckout(work, path.join(dir, "git"));
    const watch = treeWatcher(checkout, path.join(dir, "edits.jsonl"));
    const child = spawn("claude", runArgs({ settings, mcp }, o.model), {
      cwd: work,
      env: { ...env, EVAL_RUN_DIR: dir, EVAL_SPHICA_DB: db },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const events = fs.createWriteStream(path.join(dir, "events.jsonl"));
    const stderr = fs.createWriteStream(path.join(dir, "stderr.log"));
    child.stdout.pipe(events);
    child.stderr.pipe(stderr);
    let pending = "";
    child.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      // A line with more lines already behind it was read late: the tree may already hold what the later calls did
      for (const [i, line] of lines.entries()) watch(line, i < lines.length - 1 || pending.length > 0);
    });
    child.stdin.end(o.prompt);
    const timer = setTimeout(() => child.kill("SIGTERM"), 30 * 60_000);
    // A claude that cannot start (not on the allowlisted PATH) emits error, not close: the run is still recorded below
    let failedToStart: string | null = null;
    const status = await new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
      child.on("error", (e) => {
        failedToStart = e.message;
        resolve(null);
      });
    });
    clearTimeout(timer);
    await Promise.all([new Promise((r) => events.end(r)), new Promise((r) => stderr.end(r))]);
    result.status = status;
    const final = finalAnswer(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8"));
    fs.writeFileSync(path.join(dir, "answer.md"), final?.result ?? "");
    fs.writeFileSync(path.join(dir, "patch.diff"), patchSince(checkout, start));
    // The gold hook's receipts hold what it returned to the session
    const receipts = fs.existsSync(path.join(dir, "eval-receipts.jsonl"))
      ? fs.readFileSync(path.join(dir, "eval-receipts.jsonl"), "utf8")
      : "";
    if (o.condition === "gold")
      fs.writeFileSync(
        path.join(dir, "gold-receipt.txt"),
        receipts
          .split("\n")
          .flatMap((l) => (l.trim() ? [JSON.parse(l) as { name: string; output?: string }] : []))
          .filter((r) => r.name === "gold")
          .map((r) => r.output ?? "")
          .join("\n"),
      );
    let deliveries: { event: string; outcome: string; units: string[] }[] | null = null;
    if (o.condition === "inject" && fs.existsSync(db)) {
      const reader = openReader(db);
      try {
        const rows = await reader
          .selectFrom("delivery as d")
          .select(["d.id", "d.event", "d.outcome"])
          .orderBy("d.id")
          .execute();
        const units = await reader
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
        await reader.destroy();
      }
    }
    Object.assign(result, {
      reason: failedToStart
        ? `claude could not start: ${failedToStart}`
        : status !== 0
          ? `claude exited ${status}`
          : !final
            ? "no result event"
            : final.is_error
              ? "the run ended in an error"
              : null,
      deliveries,
    });
  } catch (e) {
    result.reason = (e as Error).message;
  } finally {
    result.seconds = Math.round((Date.now() - started) / 1000);
    fs.writeFileSync(path.join(dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  }
  return { dir, result };
}

/**
 * The work tree's state: each changed or untracked path (installed dependencies aside) with a hash of its content, so two states differ
 * exactly when a file changed between them.
 */
export function treeState(c: Checkout): string {
  // Ignored files count too (an answer written under an ignored docs/ is part of the patch), but not the slot's scaffolding or installed
  // dependencies or built package output, the same set patchSince leaves out. The pinned index stays at the start, so a change the agent committed still shows
  const status = checkoutGit(c, [
    "status",
    "--porcelain=v1",
    "-z",
    "-uall",
    "--ignored=traditional",
    "--",
    ".",
    ":!.tools",
    ":!.eval",
    ":!plugin/dist",
    ":!plugin/db",
    ":(exclude,glob)**/node_modules/**",
  ]);
  const entries = status.split("\0").filter(Boolean).sort();
  const hash = crypto.createHash("sha256");
  for (const e of entries) {
    hash.update(e);
    const file = path.join(c.work, e.slice(3));
    try {
      // Never follow a link: the agent may point one at a file outside the checkout, which this unsandboxed process could read
      const st = fs.lstatSync(file);
      if (st.isSymbolicLink()) hash.update(`link:${fs.readlinkSync(file)}`);
      else if (st.isFile()) hash.update(fs.readFileSync(file));
    } catch {}
  }
  return hash.digest("hex");
}

type TreeMark = {
  /** The tool call whose result had just arrived */
  after: string;
  /** Whether the tree differs from the previous mark (or from the start, for the first) */
  changed: boolean;
  /** Calls started whose results had not arrived: a change then cannot be tied to one call */
  in_flight: string[];
  /** More of the stream had already arrived when this result was read, so the tree may hold later calls' work */
  late: boolean;
};

/**
 * Reads the stream line by line and writes one mark per tool result to `file`. The start state is taken when the watcher is made, before
 * the agent can act.
 */
export function treeWatcher(
  checkout: Checkout,
  file: string,
  state: (c: Checkout) => string = treeState,
): (line: string, late?: boolean) => void {
  let last = state(checkout);
  const open = new Set<string>();
  return (line: string, late = false) => {
    let e: { type?: string; message?: { content?: unknown } };
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof e !== "object" || e === null) return;
    const content = Array.isArray(e.message?.content) ? (e.message?.content as unknown[]) : [];
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const c = block as Record<string, unknown>;
      if (e.type === "assistant" && c.type === "tool_use" && typeof c.id === "string") open.add(c.id);
      if (e.type === "user" && c.type === "tool_result" && typeof c.tool_use_id === "string") {
        open.delete(c.tool_use_id);
        const now = state(checkout);
        const mark: TreeMark = { after: c.tool_use_id, changed: now !== last, in_flight: [...open], late };
        last = now;
        fs.appendFileSync(file, `${JSON.stringify(mark)}\n`);
      }
    }
  };
}
