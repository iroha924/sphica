// What a local Claude run is started with: the settings file (sandbox, permissions, hooks) and the MCP config for one condition. The run
// uses the owner's login, so everything else of the owner's (settings, CLAUDE.md, plugins, MCP servers) is kept out by the command line
// (project sources only, strict MCP config) and what is left is fenced by the sandbox and acceptEdits.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openReader } from "../../src/db.ts";
import { shippedMatcher } from "./build-lib.ts";
import { claimRunDir } from "./codex-home.ts";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");

type Hook = { type: "command"; command: string; args: string[]; timeout: number };
type HookEntry = { matcher?: string; hooks: Hook[] };

/** Paths a run must never read, whatever the agent tries: the owner's credentials and Sphica's own database. */
export const DENY_READ = [
  ".ssh",
  ".aws",
  ".config",
  ".codex",
  ".claude",
  ".sphica",
  ".gnupg",
  ".npmrc",
  ".netrc",
].map((p) => path.join(os.homedir(), p));

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
export function runSettings(
  condition: string,
  p: RunPaths,
  deliverMatcher: string,
  deny: string[] = [],
): Record<string, unknown> {
  const fenced = [...DENY_READ, ...deny];
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
      // acceptEdits asks before any MCP call, and a run has no one to answer: Sphica's tools are allowed where the condition has them
      allow: condition === "search" || condition === "inject" ? ["mcp__sphica"] : [],
      deny: [
        "PushNotification",
        "WebFetch",
        "WebSearch",
        ...fenced.flatMap((d) => [`Read(/${d}/**)`, `Edit(/${d}/**)`]),
      ],
    },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      filesystem: { denyRead: fenced },
    },
    env: { EVAL_RUN_DIR: p.run, EVAL_SPHICA_DB: p.db },
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

/** Variables of the parent Claude Code session that would make the run's hooks treat it as a nested call. */
export const PARENT_ENV = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "SPHICA_PARENT_SESSION",
  "SPHICA_DB",
  "SPHICA_HOME",
];

/** Tracked and untracked changes since the starting commit, without the slot's scaffolding or installed dependencies. */
export function patchSince(work: string, start: string): string {
  const leave = [":!.tools", ":!.eval", ":(exclude,glob)**/node_modules/**"];
  execFileSync("git", ["-C", work, "add", "-A", "--", ".", ...leave]);
  return execFileSync("git", ["-C", work, "diff", "--cached", start, "--", ".", ...leave], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
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

export type RunResult = {
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
 * Nothing is committed to the slot or pushed: the patch is the diff from the clone's starting commit. `deny` adds paths the run may not
 * read or write (the canary's sentinel).
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
  deny?: string[];
  /** Files committed into the clone before the run starts (the canary's positive control) */
  plant?: Record<string, string>;
}): Promise<{ dir: string; result: RunResult }> {
  const { run, dir } = claimRunDir(o.out, `${o.task}-${o.condition}`);
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
    fs.writeFileSync(
      settings,
      `${JSON.stringify(runSettings(o.condition, paths, shippedMatcher(ROOT), o.deny ?? []), null, 2)}\n`,
    );
    fs.writeFileSync(mcp, `${JSON.stringify(runMcp(o.condition, paths), null, 2)}\n`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !PARENT_ENV.includes(k)));
    const child = spawn("claude", runArgs({ settings, mcp }, o.model), {
      cwd: work,
      env: { ...env, EVAL_RUN_DIR: dir, EVAL_SPHICA_DB: db },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const events = fs.createWriteStream(path.join(dir, "events.jsonl"));
    const stderr = fs.createWriteStream(path.join(dir, "stderr.log"));
    child.stdout.pipe(events);
    child.stderr.pipe(stderr);
    child.stdin.end(o.prompt);
    const timer = setTimeout(() => child.kill("SIGTERM"), 30 * 60_000);
    const status = await new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
    clearTimeout(timer);
    await Promise.all([new Promise((r) => events.end(r)), new Promise((r) => stderr.end(r))]);
    result.status = status;
    const final = finalAnswer(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8"));
    fs.writeFileSync(path.join(dir, "answer.md"), final?.result ?? "");
    fs.writeFileSync(path.join(dir, "patch.diff"), patchSince(work, start));
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
      reason:
        status !== 0
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
