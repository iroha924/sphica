#!/usr/bin/env node
// Launches a package's capture and delivery hooks the way Claude Code would from its hooks/hooks.json: node with the entry's
// `args` (exec form, no shell), for the entries whose matcher matches; then every hooks/codex.json entry the way Codex would,
// through each shell Codex can use here and from plugin roots holding characters a shell might mangle.
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

  // ---- A record tool hook that cannot write, within its own timeout, leaves its observation for the next send ----
  {
    const tool = "mcp__plugin_sphica_record__record_save";
    const entry = (manifest.PreToolUse ?? []).find(
      (g) => g.matcher && new RegExp(`^(?:${g.matcher})$`).test(tool),
    );
    const limitMs = (entry?.hooks?.[0]?.timeout ?? 0) * 1000;
    if (!limitMs) fail("hooks.json gives the record tool hook no timeout");
    const calls = path.join(spool, "calls");
    const holder = new DatabaseSync(dbFile, { timeout: 5_000 });
    holder.exec("begin immediate");
    const started = Date.now();
    try {
      fire("PreToolUse", { tool_name: tool, tool_use_id: "toolu_locked", prompt_id: "t2" }, "smoke-1");
    } finally {
      holder.exec("rollback");
      holder.close();
    }
    const took = Date.now() - started;
    if (limitMs && took >= limitMs)
      fail(`the record tool hook took ${took} ms, past its ${limitMs} ms timeout`);
    const kept = () =>
      fs.existsSync(calls)
        ? fs.readdirSync(calls).filter((f) => f.endsWith(".json") && !f.startsWith("."))
        : [];
    if (kept().length !== 1)
      fail(`a record tool hook that could not write left ${kept().length} observations in ${calls}`);
    const flushed = node([path.join(pkg, "dist", "capture.js"), "--flush"]);
    if (flushed.status !== 0) fail("capture.js --flush failed", `${flushed.stdout}${flushed.stderr}`);
    const seen = query((db) =>
      db.prepare("select turn_id from tool_call_observation where tool_use_id = 'toolu_locked'").get(),
    );
    if (seen?.turn_id !== "t2" || kept().length)
      fail(
        `the next send did not write the kept observation (got ${JSON.stringify(seen)}, left ${kept().length})`,
      );
  }

  // ---- A new interactive session is asked once to trace the smoke session, which now waits ----
  const interactive = { CLAUDE_CODE_ENTRYPOINT: "cli" };
  const asked = fire("SessionStart", { source: "startup" }, "smoke-2", interactive);
  if (!/1 earlier session of this project waits to be traced/.test(asked))
    fail("a new interactive session was not asked to trace the waiting session", asked);
  if (/wait(s)? to be traced/.test(fire("SessionStart", { source: "compact" }, "smoke-2", interactive)))
    fail("the automatic trace notice came twice in one session");

  // ---- Codex: every codex.json entry, through each shell Codex can run hooks with, from plugin roots a shell might mangle ----
  // Codex 0.160.0 picks commandWindows on Windows (else command), replaces ${PLUGIN_ROOT} and its siblings as text, sets them in the
  // environment too, and runs the line through the session's shell
  const codexHooks = JSON.parse(fs.readFileSync(path.join(pkg, "hooks", "codex.json"), "utf8")).hooks;
  const powershellDir = path.join(systemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0");
  const shells = windows
    ? [
        {
          name: "powershell.exe",
          file: path.join(powershellDir, "powershell.exe"),
          args: (l) => ["-NoProfile", "-Command", l],
        },
        { name: "pwsh", file: onPath("pwsh"), args: (l) => ["-NoProfile", "-Command", l] },
        {
          name: "cmd.exe",
          file: path.join(systemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
          args: (l) => ["/c", `"${l}"`],
          verbatim: true,
        },
        // No shell in the session: COMSPEC with an upper-case /C
        { name: "COMSPEC", file: process.env.ComSpec, args: (l) => ["/C", `"${l}"`], verbatim: true },
        // Git Bash, not System32's bash.exe (WSL)
        {
          name: "Git Bash",
          file: path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
          args: (l) => ["-c", l],
        },
      ]
    : [{ name: "sh", file: "/bin/sh", args: (l) => ["-c", l] }];
  for (const s of shells)
    if (!s.file || !fs.existsSync(s.file)) throw new Error(`${s.name} is not installed here`);
  // A sh expands $ and backquotes inside the double quotes command puts the path in, so that root runs only where commandWindows is used
  const roots = [
    { name: "control", dir: "plugin-control" },
    { name: "spaced", dir: "plugin root & (x) it's" },
    ...(windows ? [{ name: "expanding", dir: "plugin $HOME `x %PATH%" }] : []),
  ];
  const codexData = path.join(dir, "plugin-data");
  fs.mkdirSync(codexData, { recursive: true });
  // A detached send from an earlier case may delete a queued file between listing and reading it; the database then has it
  const readQueued = (f) => {
    try {
      return fs.readFileSync(path.join(spool, f), "utf8");
    } catch {
      return "";
    }
  };
  const queuedOrSent = (marker) =>
    fs
      .readdirSync(spool)
      .filter((f) => f.endsWith(".json") && !f.startsWith("."))
      .some((f) => readQueued(f).includes(marker)) ||
    query((db) => Boolean(db.prepare("select 1 from source where text like ?").get(`%${marker}%`)));
  const inputs = {
    SessionStart: { source: "startup" },
    SubagentStart: { agent_id: "a1", agent_type: "explorer" },
    PreToolUse: { tool_name: "Bash", tool_input: { command: "cat src/a.ts" } },
    PostToolUse: { tool_name: "apply_patch", tool_input: { command: "" }, tool_response: "" },
    // As a subagent's, so neither starts a detached send that outlives this script and its temp directory (the Claude Code part
    // above already checks the send)
    Stop: { last_assistant_message: "Done.", agent_id: "a1" },
    Interrupt: { agent_id: "a1" },
  };
  let launched = 0;
  for (const r of roots) {
    const at = path.join(dir, r.dir);
    fs.cpSync(pkg, at, { recursive: true });
    const values = {
      PLUGIN_ROOT: at,
      CLAUDE_PLUGIN_ROOT: at,
      PLUGIN_DATA: codexData,
      CLAUDE_PLUGIN_DATA: codexData,
    };
    for (const s of shells) {
      const tag = `${r.name}/${s.name}`;
      const session = `codex-${r.name}-${s.name}`.replace(/[^A-Za-z0-9-]/g, "-");
      const childPath = [...dirs, ...(windows ? [powershellDir] : []), path.dirname(s.file)].join(
        path.delimiter,
      );
      const run = (event, h, input) => {
        let line = windows ? (h.commandWindows ?? h.command) : h.command;
        for (const [k, v] of Object.entries(values)) line = line.replaceAll(`\${${k}}`, v);
        launched++;
        return spawnSync(s.file, s.args(line), {
          cwd: repo,
          env: { ...env, PATH: childPath, ...values },
          input: JSON.stringify({
            hook_event_name: event,
            session_id: session,
            turn_id: `t-${session}`,
            cwd: repo,
            ...input,
          }),
          encoding: "utf8",
          // Codex stops a hook at its own timeout (600 seconds when unset)
          timeout: (h.timeout ?? 600) * 1000,
          windowsVerbatimArguments: Boolean(s.verbatim),
          windowsHide: true,
        });
      };
      const check = (event, i, result) => {
        if (result.error || result.status !== 0)
          fail(
            `Codex ${event} hook ${i} through ${tag} failed (exit ${result.status})`,
            result.error?.message ?? `${result.stdout}${result.stderr}`,
          );
      };
      // UserPromptSubmit first: its capture reads this case's own marker from stdin, so a queued marker proves stdin reached node
      // english-exempt: non-ASCII on purpose, so a shell that re-encodes stdin loses the marker
      const marker = `codex prompt ${tag} 記録 ${process.pid}`;
      codexHooks.UserPromptSubmit.flatMap((g) => g.hooks).forEach((h, i) => {
        check("UserPromptSubmit", i, run("UserPromptSubmit", h, { prompt: marker }));
      });
      if (!queuedOrSent(marker))
        fail(`Codex UserPromptSubmit through ${tag} queued nothing with this case's prompt`);
      for (const [event, input] of Object.entries(inputs))
        (codexHooks[event] ?? [])
          .flatMap((g) => g.hooks)
          .forEach((h, i) => {
            check(event, i, run(event, h, input));
          });
    }
  }
  const expected =
    roots.length *
    shells.length *
    Object.values(codexHooks)
      .flat()
      .flatMap((g) => g.hooks).length;
  if (launched !== expected) fail(`launched ${launched} Codex hooks, expected ${expected}`);

  // ---- The launch line itself, on a stub whose capture.js exits with a given code: what each shell makes of node's exit ----
  const stub = path.join(dir, "stub root");
  fs.mkdirSync(path.join(stub, "dist"), { recursive: true });
  fs.writeFileSync(path.join(stub, "dist", "capture.js"), "process.exit(Number(process.env.STUB_EXIT));\n");
  const captureHook = codexHooks.UserPromptSubmit.flatMap((g) => g.hooks).find((h) =>
    h.command.includes("capture.js"),
  );
  const nodeExe = path.basename(process.execPath);
  const withoutNode = dirs.filter((d) => d !== path.dirname(process.execPath));
  for (const s of shells) {
    // PowerShell turns any failing native command into 1; the others pass node's code through
    const powershell = /powershell|pwsh/.test(s.name);
    const shellDirs = [...(windows ? [powershellDir] : []), path.dirname(s.file)];
    if ([...withoutNode, ...shellDirs].some((d) => fs.existsSync(path.join(d, nodeExe))))
      throw new Error(`node is not the only one on PATH for ${s.name}, so a missing node cannot be shown`);
    const took = [];
    for (const { what, code, expect, pathDirs } of [
      { what: "node exiting 0", code: "0", expect: (st) => st === 0, pathDirs: [...dirs, ...shellDirs] },
      {
        what: "node exiting 7",
        code: "7",
        expect: (st) => (powershell ? st !== 0 : st === 7),
        pathDirs: [...dirs, ...shellDirs],
      },
      { what: "without node", code: "0", expect: (st) => st !== 0, pathDirs: [...withoutNode, ...shellDirs] },
    ]) {
      const line = (
        windows ? (captureHook.commandWindows ?? captureHook.command) : captureHook.command
      ).replaceAll(["$", "{PLUGIN_ROOT}"].join(""), stub);
      const started = Date.now();
      const r = spawnSync(s.file, s.args(line), {
        cwd: repo,
        env: { ...env, PATH: pathDirs.join(path.delimiter), PLUGIN_ROOT: stub, STUB_EXIT: code },
        input: "{}",
        encoding: "utf8",
        // A PowerShell that cannot find node takes 24 to 39 seconds to say so on the Windows runner
        timeout: 2 * TIMEOUT_MS,
        windowsVerbatimArguments: Boolean(s.verbatim),
        windowsHide: true,
      });
      took.push(`${what} → ${r.status} in ${Date.now() - started} ms`);
      if (r.error || !expect(r.status))
        fail(
          `the Codex launch line through ${s.name}, ${what}, exited ${r.status}`,
          r.error?.message ?? r.stderr,
        );
    }
    console.log(`codex launch line through ${s.name}: ${took.join(", ")}`);
  }
});

if (failures.length) {
  console.error(`hooks: ${failures.length} failure(s)\n${failures.map((f) => `- ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(
  `hooks: launched ${source === path.join(root, "plugin") ? "plugin/" : source} as hooks.json defines (capture, PowerShell delivery, detached send), and codex.json through ${windows ? "PowerShell, pwsh, cmd, COMSPEC, and Git Bash" : "sh"}`,
);
