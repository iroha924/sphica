#!/usr/bin/env node
// Launches a package's capture and delivery hooks the way Claude Code would from its hooks/hooks.json: node with the entry's
// `args` (exec form, no shell), for the entries whose matcher matches.
// This is a launch check of the shipped definitions, not a run inside a real host.
//
// Usage: node scripts/check-hooks-live.mjs [<package root>]   (default: plugin/, which `bun run bundle` builds)

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { root, withTempDir } from "./lib/live-harness.mjs";

const windows = process.platform === "win32";
const source = path.resolve(process.argv[2] ?? path.join(root, "plugin"));
const failures = [];
const fail = (what, detail = "") => failures.push(detail ? `${what}\n${String(detail).slice(0, 800)}` : what);
const TIMEOUT_MS = 60_000;
// The placeholder as hooks.json writes it, joined so the source holds no template-looking literal
const ROOT = ["$", "{CLAUDE_PLUGIN_ROOT}"].join("");

/** The first executable named name on PATH. */
function onPath(name) {
  const exts = windows ? [".exe"] : [""];
  for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter(Boolean))
    for (const ext of exts) {
      const at = path.join(dir, `${name}${ext}`);
      if (fs.existsSync(at)) return at;
    }
  return null;
}

await withTempDir(async (dir) => {
  // A space in the plugin root catches a path that a shell splits
  const pkg = path.join(dir, "plugin root");
  fs.cpSync(source, pkg, { recursive: true });
  const home = path.join(dir, "home");
  const ghConfig = path.join(dir, "gh-config");
  for (const d of [home, ghConfig]) fs.mkdirSync(d, { recursive: true });
  // Built from nothing, so no SPHICA_*, token, host session, or workspace of the parent leaks in. gh is left off PATH: init
  // then reports it could not bind an account, and nothing reaches api.github.com.
  const git = onPath("git");
  if (!git) throw new Error("git is not on PATH");
  const dirs = [path.dirname(process.execPath), path.dirname(git)];
  // git reads no system or user config, so the owner's signing or hooks never run on the fixture
  const gitConfig = path.join(dir, "gitconfig");
  fs.writeFileSync(gitConfig, "[user]\n\temail = t@example.com\n\tname = t\n");
  const env = { PATH: "", HOME: home, USERPROFILE: home, GH_CONFIG_DIR: ghConfig };
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = gitConfig;
  env.CODEX_HOME = path.join(home, ".codex");
  env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
  for (const k of [
    "SystemRoot",
    "SYSTEMROOT",
    "windir",
    "TEMP",
    "TMP",
    "TMPDIR",
    "PATHEXT",
    "ComSpec",
    "LANG",
  ])
    if (process.env[k]) env[k] = process.env[k];
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (windows && systemRoot) dirs.push(path.join(systemRoot, "System32"));
  env.PATH = dirs.join(path.delimiter);

  const repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const store = new Map();\n");
  for (const args of [
    ["init", "-q"],
    ["remote", "add", "origin", "https://github.com/example/live.git"],
    ["add", "-A"],
    ["commit", "-qm", "store"],
  ]) {
    const r = spawnSync(git, ["-C", repo, ...args], { env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  }

  const node = (args, extra = {}) =>
    spawnSync(process.execPath, args, {
      cwd: repo,
      env: { ...env, ...extra },
      encoding: "utf8",
      timeout: TIMEOUT_MS,
    });

  const init = node([path.join(pkg, "dist", "cli.js"), "init", "--cwd", repo]);
  if (init.status !== 0) fail("init exited non-zero", `${init.stdout}${init.stderr}`);
  const dbFile = path.join(home, ".sphica", "sphica.db");
  // A read-only connection cannot recover a WAL another process left behind, so the checks open it as the hooks do
  const query = (fn) => {
    const db = new DatabaseSync(dbFile, { timeout: 5_000 });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  if (!fs.existsSync(dbFile)) throw new Error(`init made no database\n${init.stdout}${init.stderr}`);

  const manifest = JSON.parse(fs.readFileSync(path.join(pkg, "hooks", "hooks.json"), "utf8")).hooks;
  /** Runs every entry Claude Code would run for this event (and tool), as the entry defines it. */
  const fire = (event, input, session, extra = {}) => {
    const entries = (manifest[event] ?? [])
      .filter((g) => !g.matcher || new RegExp(`^(?:${g.matcher})$`).test(input.tool_name ?? ""))
      .flatMap((g) => g.hooks ?? []);
    if (!entries.length) fail(`hooks.json runs nothing for ${event} ${input.tool_name ?? ""}`);
    const hookEnv = {
      ...env,
      CLAUDE_PLUGIN_ROOT: pkg,
      CLAUDE_PROJECT_DIR: repo,
      CLAUDE_CODE_SESSION_ID: session,
      ...extra,
    };
    const stdin = JSON.stringify({ hook_event_name: event, session_id: session, cwd: repo, ...input });
    let out = "";
    for (const h of entries) {
      // Only exec form ships (verify:ai pins it): node with the script path as one argument, never a shell
      if (h.command !== "node" || !Array.isArray(h.args)) {
        fail(`${event} hook is not exec form with node`, JSON.stringify(h));
        continue;
      }
      const args = h.args.map((a) => a.replaceAll(ROOT, pkg));
      const r = spawnSync(process.execPath, args, {
        cwd: repo,
        env: hookEnv,
        input: stdin,
        encoding: "utf8",
        timeout: TIMEOUT_MS,
      });
      if (r.error || r.status !== 0)
        fail(
          `${event} hook ${h.command} ${(h.args ?? []).join(" ")} failed`,
          r.error?.message ?? `${r.stdout}${r.stderr}`,
        );
      out += r.stdout ?? "";
    }
    return out;
  };

  // ---- Seed: an owner decision anchored to src/a.ts, traced through the package's record MCP server ----
  const decision = "Keep the store in src/a.ts a Map.";
  fire("UserPromptSubmit", { prompt: decision, prompt_id: "f1" }, "fixture-1");
  const mcp = spawn(process.execPath, [path.join(pkg, "dist", "mcp-record.js")], {
    cwd: repo,
    env: { ...env, CLAUDE_PROJECT_DIR: repo },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  readline.createInterface({ input: mcp.stdout }).on("line", (line) => {
    try {
      const m = JSON.parse(line);
      pending.get(m.id)?.(m);
      pending.delete(m.id);
    } catch {}
  });
  let next = 1;
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), TIMEOUT_MS);
      pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const call = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: { cwd: repo, ...args } });
    const text = (r.result?.content ?? []).map((c) => c.text ?? "").join("\n");
    if (r.error || r.result?.isError) throw new Error(`${name}: ${r.error?.message ?? text}`);
    return text;
  };
  try {
    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "hooks-live", version: "0" },
    });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const run = /run: (\S+)/.exec(await call("trace_begin", { session: "fixture-1" }))?.[1];
    if (!run) throw new Error("trace_begin returned no run");
    const context = await call("record_context", { run });
    const ref = /## (s\d+) owner/.exec(context)?.[1];
    if (!ref) throw new Error(`record_context shows no owner message\n${context.slice(0, 600)}`);
    const quote = [{ source: ref, quote: decision }];
    const record = {
      units: [
        {
          key: "map",
          kind: "decision",
          stance: "do",
          text: decision,
          evidence: [{ ...quote[0], role: "states" }],
          adoption: quote,
          anchors: [{ path: "src/a.ts", role: "applies_to" }],
          // english-exempt: a record needs search words in both languages
          aliases: ["store", "map", "src/a.ts", "ストア", "マップ", "保存", "データ", "構造"],
        },
      ],
    };
    const checked = await call("record_check", { run, record });
    const saved = await call("record_save", { run, record });
    if (!/saved/.test(saved)) fail("record_save did not save", `${checked}\n${saved}`);
  } finally {
    // Closing stdin ends the server on its own. Killed mid-write on Windows, it left the database unreadable to the next reader
    const exited = new Promise((r) => mcp.once("exit", r));
    mcp.stdin.end();
    const timer = setTimeout(() => mcp.kill(), 10_000);
    await exited;
    clearTimeout(timer);
  }
  const unit = query((db) =>
    db.prepare("select lifecycle, extraction, unsourced from unit where key like '%/map'").get(),
  );
  if (unit?.lifecycle !== "active" || unit.extraction !== "supported" || unit.unsourced !== 0)
    fail("the seeded decision is not active, supported, and sourced", JSON.stringify(unit));

  // ---- The measured turn: no trace or flush runs until Stop's detached send ----
  const spool = path.join(home, ".sphica", "spool");
  const marker = `smoke prompt ${process.pid}-${Date.now()}`;
  fire("UserPromptSubmit", { prompt: marker, prompt_id: "t1" }, "smoke-1");
  const queued = fs
    .readdirSync(spool)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .some((f) => fs.readFileSync(path.join(spool, f), "utf8").includes(marker));
  if (!queued) fail("UserPromptSubmit queued nothing with the owner's prompt");

  const delivered = fire(
    "PreToolUse",
    { tool_name: "PowerShell", tool_input: { command: "Get-Content .\\src\\a.ts" } },
    "smoke-1",
  );
  if (!/\/map /.test(delivered) || !/which this command names/.test(delivered))
    fail("a PowerShell command naming src/a.ts got no decision", delivered);

  const inDb = () => query((db) => Boolean(db.prepare("select 1 from source where text = ?").get(marker)));
  // Sent only by Stop's detached process: already there would make the check below pass on its own
  if (inDb()) fail("the owner's prompt reached the database before Stop");
  fire("Stop", { last_assistant_message: "Done.", prompt_id: "t1" }, "smoke-1");
  const deadline = Date.now() + 30_000;
  let sent = false;
  let reads = 0;
  while (Date.now() < deadline) {
    sent = inDb();
    reads = query((db) =>
      Number(
        db
          .prepare(
            "select count(*) as n from delivery d join session s on s.id = d.session_id where s.external_id = 'smoke-1' and d.event = 'pre_read' and d.outcome = 'emitted'",
          )
          .get().n,
      ),
    );
    if (sent) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!sent) fail("Stop's detached send did not put the owner's prompt in the database within 30 seconds");
  // Windows cannot delete the temp directory while the detached sender still holds files in it: wait for it to empty the queue
  for (let i = 0; i < 20 && fs.readdirSync(spool).some((f) => f.endsWith(".json")); i++)
    await new Promise((r) => setTimeout(r, 250));
  if (reads !== 1) fail(`expected one emitted pre_read delivery for the smoke session, found ${reads}`);

  // ---- A new interactive session is asked once to trace the smoke session, which now waits ----
  const interactive = { CLAUDE_CODE_ENTRYPOINT: "cli" };
  const asked = fire("SessionStart", { source: "startup" }, "smoke-2", interactive);
  if (!/1 earlier session of this project waits to be traced/.test(asked))
    fail("a new interactive session was not asked to trace the waiting session", asked);
  if (/wait(s)? to be traced/.test(fire("SessionStart", { source: "compact" }, "smoke-2", interactive)))
    fail("the automatic trace notice came twice in one session");
});

if (failures.length) {
  console.error(`hooks: ${failures.length} failure(s)\n${failures.map((f) => `- ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(
  `hooks: launched ${source === path.join(root, "plugin") ? "plugin/" : source} as hooks.json defines (capture, PowerShell delivery, detached send)`,
);
