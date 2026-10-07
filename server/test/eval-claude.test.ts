// The local Claude runner: what each condition is started with, how its patch and answer are taken, and how its stream is read.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { shippedCodexMatcher } from "../evals/cloud/build-lib.ts";
import { contextChecks, permissionChecks, SPHICA_TOOLS, statusCounts } from "../evals/cloud/canary-check.ts";
import {
  claudeVersion,
  DENY_DIRS,
  DENY_FILES,
  finalAnswer,
  patchSince,
  runArgs,
  runEnv,
  runMcp,
  runnerDigest,
  runSettings,
  slotMatcher,
  treeState,
  treeWatcher,
} from "../evals/cloud/claude-run.ts";
import { type Checkout, pinCheckout } from "../evals/cloud/codex-home.ts";
import {
  claudeStreamCalls,
  foundInClaudeStream,
  goldSignalsFromClaudeStream,
  lookedOutside,
  searchedBeforeEdit,
  searchLoading,
} from "../evals/cloud/judge.ts";

/** Pins a test checkout's git directory beside it, as the runners do before the agent starts. */
function pinned(t: { after: (f: () => void) => void }, work: string): Checkout {
  const git = `${work}-git`;
  t.after(() => fs.rmSync(git, { recursive: true, force: true }));
  return pinCheckout(work, git);
}

/** A child process's environment: a temporary home and none of the owner's Sphica paths. */
function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.SPHICA_DB;
  delete env.SPHICA_HOME;
  return env;
}

const paths = { run: "/r", work: "/r/work", tools: "/r/tools", db: "/r/db/sphica.db" };
const MATCHER = "Edit|Write|Read|Bash";

type Settings = {
  permissions: { deny: string[] };
  sandbox: Record<string, unknown> & { filesystem: { denyRead: string[] } };
  env: Record<string, string>;
  hooks: Record<string, { matcher?: string; hooks: { command: string; args: string[] }[] }[]>;
};
const settingsOf = (condition: string) => runSettings(condition, paths, MATCHER) as Settings;
const argsOf = (s: Settings, event: string) =>
  s.hooks[event]?.flatMap((e) => e.hooks.map((h) => h.args.join(" ")));

test("every condition runs fenced: sandbox on with no way out, the owner's secrets unreadable, the run's own paths", () => {
  for (const condition of ["none", "search", "inject", "gold"]) {
    const s = settingsOf(condition);
    assert.equal(s.sandbox.enabled, true);
    assert.equal(s.sandbox.allowUnsandboxedCommands, false);
    assert.equal(s.sandbox.failIfUnavailable, true);
    // Reads stop at the checkout for the file tools and the shell alike, not only at the listed credential paths
    assert.equal((s.permissions as Record<string, unknown>).blockReadsOutsideWorkingDirectories, true);
    assert.equal(s.sandbox.excludedCommands, undefined);
    for (const secret of [".ssh", ".claude", ".codex", ".sphica"]) {
      const full = path.join(os.homedir(), secret);
      assert.ok(s.sandbox.filesystem.denyRead.includes(full), `${condition}: sandbox reads ${secret}`);
      assert.ok(s.permissions.deny.includes(`Read(/${full}/**)`), `${condition}: Read tool reads ${secret}`);
      assert.ok(s.permissions.deny.includes(`Edit(/${full}/**)`), `${condition}: Edit tool writes ${secret}`);
    }
    assert.ok(s.permissions.deny.includes("PushNotification"));
    // Tool search is pinned on, so Sphica's tools start held back on every side of a comparison
    assert.deepEqual(s.env, {
      EVAL_RUN_DIR: "/r",
      EVAL_SPHICA_DB: "/r/db/sphica.db",
      ENABLE_TOOL_SEARCH: "true",
    });
    // Every condition logs the prompt, so collect can tell which task a run carried out
    assert.ok(argsOf(s, "UserPromptSubmit")?.length);
  }
  // A credential file is fenced as itself; a rule ending in /** would only cover what is under it
  const s = settingsOf("none");
  for (const f of DENY_FILES) {
    assert.ok(s.permissions.deny.includes(`Read(/${f})`), f);
    assert.ok(s.sandbox.filesystem.denyRead.includes(f), f);
  }
  assert.ok(DENY_DIRS.every((d) => !DENY_FILES.includes(d)));
});

test("only inject delivers, only gold gives the gold record, and only search and inject have Sphica's tools", () => {
  // Without an allow rule, acceptEdits in print mode denies every MCP call
  for (const condition of ["search", "inject"])
    assert.deepEqual(
      (runSettings(condition, paths, MATCHER) as { permissions: { allow: string[] } }).permissions.allow,
      ["mcp__sphica"],
    );
  for (const condition of ["none", "gold"])
    assert.deepEqual(
      (runSettings(condition, paths, MATCHER) as { permissions: { allow: string[] } }).permissions.allow,
      [],
    );
  const inject = settingsOf("inject");
  assert.match(argsOf(inject, "PreToolUse")?.[0] ?? "", /\/r\/tools\/dist\/deliver\.js$/);
  assert.equal(inject.hooks.PreToolUse?.[0]?.matcher, MATCHER);
  assert.match(argsOf(inject, "SessionStart")?.[0] ?? "", /deliver\.js$/);
  for (const condition of ["none", "search", "gold"])
    assert.equal(settingsOf(condition).hooks.PreToolUse, undefined, condition);
  assert.match(argsOf(settingsOf("gold"), "UserPromptSubmit")?.[0] ?? "", /gold\.sh$/);
  assert.doesNotMatch(argsOf(settingsOf("search"), "UserPromptSubmit")?.[0] ?? "", /gold|deliver/);
  assert.deepEqual(runMcp("none", paths), { mcpServers: {} });
  assert.deepEqual(runMcp("gold", paths), { mcpServers: {} });
  for (const condition of ["search", "inject"]) {
    const server = runMcp(condition, paths).mcpServers.sphica as {
      args: string[];
      env: Record<string, string>;
    };
    assert.deepEqual(server.args, ["/r/tools/sphica.sh", "/r/tools/dist/mcp.js"]);
    assert.equal(server.env.EVAL_SPHICA_DB, "/r/db/sphica.db");
  }
});

test("the command line loads only the checkout's settings and no MCP servers of the owner's, and never bypasses permissions", () => {
  const a = runArgs({ settings: "/r/settings.json", mcp: "/r/mcp.json" }, "m");
  assert.deepEqual(a.slice(a.indexOf("--setting-sources"), a.indexOf("--setting-sources") + 2), [
    "--setting-sources",
    "project",
  ]);
  assert.ok(a.includes("--strict-mcp-config"));
  assert.equal(a[a.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.ok(!a.some((x) => /bypass|dangerously/i.test(x)));
  assert.equal(a[a.indexOf("--model") + 1], "m");
});

test("the patch is everything since the starting commit, committed or not, without scaffolding or dependencies", (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "eval-patch-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const git = (...a: string[]) => execFileSync("git", ["-C", work, ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(work, "a.ts"), "export const a = 1;\n");
  fs.mkdirSync(path.join(work, ".tools"));
  fs.writeFileSync(path.join(work, ".tools", "x"), "tool");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "start");
  const start = git("rev-parse", "HEAD").trim();
  const c = pinned(t, work);
  // The agent commits one change and leaves another untracked
  fs.writeFileSync(path.join(work, "a.ts"), "export const a = 2;\n");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", "agent");
  fs.writeFileSync(path.join(work, "b.ts"), "export const b = 1;\n");
  fs.writeFileSync(path.join(work, ".tools", "x"), "rewritten");
  fs.mkdirSync(path.join(work, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(work, "node_modules", "dep", "i.js"), "x");
  // A bundle the agent built is output, not part of its answer, even where it is ignored
  fs.writeFileSync(path.join(work, ".gitignore"), "plugin/dist/\nplugin/db/\n");
  fs.mkdirSync(path.join(work, "plugin", "dist"), { recursive: true });
  fs.writeFileSync(path.join(work, "plugin", "dist", "mcp.js"), "bundled");
  fs.mkdirSync(path.join(work, "plugin", "db"), { recursive: true });
  fs.writeFileSync(path.join(work, "plugin", "db", "schema.sql"), "copied");
  const patch = patchSince(c, start);
  assert.doesNotMatch(patch, /^diff --git a\/plugin\//m);
  assert.match(patch, /a\.ts/);
  assert.match(patch, /export const a = 2/);
  assert.match(patch, /b\.ts/);
  assert.doesNotMatch(patch, /\.tools|node_modules/);
});

const ev = (o: unknown) => JSON.stringify(o);
const use = (id: string, name: string, input: unknown = {}) =>
  ev({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, text: string, isError = false) =>
  ev({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error: isError },
      ],
    },
  });
const done = ev({ type: "result", result: "final answer", is_error: false, num_turns: 3 });
const hit = "## trace:s/utc (u9): constraint do, active\nStore UTC";

test("the final answer is the last result event, and a run cut off has none", () => {
  assert.deepEqual(finalAnswer([use("1", "Read"), done].join("\n")), {
    result: "final answer",
    is_error: false,
  });
  assert.equal(finalAnswer([use("1", "Read"), "{broken"].join("\n")), undefined);
});

test("stream calls are tied to their results by id, even when two run at once", () => {
  const { calls, readable } = claudeStreamCalls(
    [
      use("a", "mcp__sphica__search"),
      use("b", "Read"),
      result("b", "file text"),
      result("a", hit),
      done,
    ].join("\n"),
  );
  assert.equal(readable, true);
  assert.deepEqual(
    calls.map((c) => [c.name, c.result]),
    [
      ["mcp__sphica__search", hit],
      ["Read", "file text"],
    ],
  );
});

test("a search result naming the gold record is a hit; without a final event or with a call unanswered it is unknown, not no", () => {
  const gold = ["trace:s/utc"];
  assert.equal(
    foundInClaudeStream([use("a", "mcp__sphica__search"), result("a", hit), done].join("\n"), gold),
    "yes",
  );
  assert.equal(
    foundInClaudeStream(
      [use("a", "mcp__sphica__search"), result("a", "No record holds most of"), done].join("\n"),
      gold,
    ),
    "no",
  );
  assert.equal(foundInClaudeStream([use("a", "mcp__sphica__search"), done].join("\n"), gold), "unknown");
  assert.equal(foundInClaudeStream([use("a", "Read"), result("a", "x")].join("\n"), gold), "unknown");
  assert.equal(foundInClaudeStream(null, gold), "unknown");
  // A file that quotes the heading is not a Sphica result
  assert.equal(foundInClaudeStream([use("a", "Read"), result("a", hit), done].join("\n"), gold), "no");
  const signals = goldSignalsFromClaudeStream(
    "search",
    gold,
    [],
    null,
    [use("a", "mcp__sphica__search"), result("a", hit), done].join("\n"),
  );
  assert.deepEqual(signals["trace:s/utc"], { in_delivery: "not_applicable", in_search: "yes", read: "no" });
});

test("collect reads local Claude runs like Codex runs, with the answer and signals from the stream", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-collect-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const build = path.join(base, "build");
  const claude = path.join(base, "claude");
  fs.mkdirSync(build);
  fs.writeFileSync(path.join(build, "manifest.json"), JSON.stringify({ commit: "c", repositories: {} }));
  fs.copyFileSync(
    path.join(import.meta.dirname, "..", "evals", "cloud", "tasks.json"),
    path.join(build, "tasks.json"),
  );
  const head = { task: "pilot-sort", condition: "search" };
  const run = path.join(claude, "r1");
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, "started.json"), JSON.stringify(head));
  fs.writeFileSync(
    path.join(run, "result.json"),
    JSON.stringify({ ...head, status: 0, reason: null, seconds: 7, deliveries: null }),
  );
  fs.writeFileSync(
    path.join(run, "events.jsonl"),
    [use("a", "mcp__sphica__search"), result("a", "No record holds most of: x"), done].join("\n"),
  );
  fs.writeFileSync(path.join(run, "answer.md"), "final answer");
  fs.writeFileSync(path.join(run, "patch.diff"), "");
  const stopped = path.join(claude, "r2");
  fs.mkdirSync(stopped);
  fs.writeFileSync(path.join(stopped, "started.json"), JSON.stringify(head));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: base };
  delete env.SPHICA_DB;
  delete env.SPHICA_HOME;
  execFileSync(
    process.execPath,
    [
      path.join(import.meta.dirname, "..", "evals", "cloud", "collect.ts"),
      "--build",
      build,
      "--codex",
      path.join(base, "none"),
      "--claude",
      claude,
      "--logs",
      base,
      "--skip-hidden-tests",
    ],
    { stdio: "ignore", env },
  );
  const rows = JSON.parse(fs.readFileSync(path.join(build, "loop.json"), "utf8")).rows as {
    model: string;
    run: string;
    excluded: string | null;
    answer: string;
    answer_format: string;
    signals: { searches: number; empty_searches: number; turns: number; seconds: number } | null;
  }[];
  const r1 = rows.find((r) => r.run === "r1");
  assert.equal(r1?.model, "claude");
  assert.equal(r1?.excluded, null);
  assert.equal(r1?.answer, "final answer");
  assert.equal(r1?.answer_format, "not_applicable");
  assert.deepEqual(
    [r1?.signals?.searches, r1?.signals?.empty_searches, r1?.signals?.turns, r1?.signals?.seconds],
    [1, 1, 3, 7],
  );
  assert.equal(
    rows.find((r) => r.run === "r2")?.excluded,
    "no result.json (the run stopped before it finished)",
  );
});

const S = "/home/x/.cache/fence/sentinel.txt";
const F = { sentinel: S, fresh: "/home/x/.cache/fence/fresh.txt" };
const after = { unchanged: true, freshAbsent: true };
const deniedEv = (id: string) => ev({ type: "system", subtype: "permission_denied", tool_use_id: id });
const unread =
  "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>";
const attempts = [
  use("w", "Write", { file_path: F.fresh }),
  result(
    "w",
    "<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>",
    true,
  ),
  use("r", "Read", { file_path: S }),
  deniedEv("r"),
  use("e", "Edit", { file_path: S }),
  result("e", unread, true),
  use("bw", "Bash", { command: `echo x > ${S}` }),
  result("bw", "operation not permitted", true),
  use("br", "Bash", { command: `cat ${S}` }),
  result("br", "Operation not permitted", true),
];

test("the fence canary passes only when every attempt was made and refused, and nothing changed or leaked", () => {
  const ok = permissionChecks([...attempts, done].join("\n"), F, "secret-1", after);
  assert.deepEqual(
    ok.filter((c) => !c.ok),
    [],
  );
  // The Edit stopped by the rule after the denied Read passes, and says so
  assert.match(
    ok.find((c) => c.name === "Edit tool edits the sentinel")?.why ?? "",
    /read-before-write rule after a denied Read/,
  );
  // A run that never tried the Bash read does not prove the sandbox blocks it
  const noBashRead = attempts.filter((l) => !l.includes('"br"'));
  assert.deepEqual(
    permissionChecks([...noBashRead, done].join("\n"), F, "secret-1", after)
      .filter((c) => !c.ok)
      .map((c) => [c.name, c.why]),
    [["Bash reads the sentinel", "not attempted"]],
  );
  const through = permissionChecks(
    [...noBashRead, use("br", "Bash", { command: `cat ${S}` }), result("br", "secret-1"), done].join("\n"),
    F,
    "secret-1",
    after,
  );
  assert.deepEqual(
    through.filter((c) => !c.ok).map((c) => c.name),
    ["Bash reads the sentinel", "the sentinel's secret is not in the stream"],
  );
  assert.equal(
    permissionChecks([...attempts, done].join("\n"), F, "s", { ...after, unchanged: false }).find(
      (c) => !c.ok,
    )?.name,
    "the sentinel is unchanged",
  );
  assert.equal(
    permissionChecks([...attempts, done].join("\n"), F, "s", { ...after, freshAbsent: false }).find(
      (c) => !c.ok,
    )?.name,
    "the file beside the sentinel was not created",
  );
  assert.equal(
    permissionChecks(attempts.join("\n"), F, "s", after)[0]?.ok,
    false,
    "a stream without its result event is incomplete",
  );
  assert.equal(permissionChecks(null, F, "s", after).filter((c) => !c.ok).length >= 6, true);
});

const init = (servers: { name: string; status: string }[], tools: string[]) =>
  ev({ type: "system", subtype: "init", mcp_servers: servers, tools });
const receipt = (o: Record<string, unknown>) => JSON.stringify(o);

test("the context canary checks the condition's servers, tools, hooks, and that only the checkout's instructions loaded", () => {
  const work = "/r/work";
  const searchInit = init([{ name: "sphica", status: "connected" }], ["Read", ...SPHICA_TOOLS]);
  const hooks = [receipt({ name: "start" }), receipt({ name: "prompt" })].join("\n");
  assert.deepEqual(
    contextChecks("search", [searchInit, done].join("\n"), hooks, work, false).filter((c) => !c.ok),
    [],
  );
  const failing = (condition: string, events: string, receipts: string, control = false) =>
    contextChecks(condition, events, receipts, work, control)
      .filter((c) => !c.ok)
      .map((c) => c.name);
  assert.deepEqual(failing("none", [searchInit, done].join("\n"), hooks), [
    "MCP servers are the condition's",
    "Sphica's tools only where the condition has them",
  ]);
  const owners = `${hooks}\n${receipt({ name: "instructions", file: "/home/x/.claude/CLAUDE.md", memory: "User" })}`;
  assert.deepEqual(failing("none", [init([], ["Read"]), done].join("\n"), owners), [
    "only the checkout's instruction files loaded",
  ]);
  // The positive control must show its own CLAUDE.md loading, or an absence elsewhere proves nothing
  assert.deepEqual(failing("none", [init([], ["Read"]), done].join("\n"), hooks, true), [
    "only the checkout's instruction files loaded",
  ]);
  const control = `${hooks}\n${receipt({ name: "instructions", file: "/r/work/CLAUDE.md", memory: "Project" })}`;
  assert.deepEqual(failing("none", [init([], ["Read"]), done].join("\n"), control, true), []);
  assert.deepEqual(failing("gold", [init([], ["Read"]), done].join("\n"), hooks), [
    "the condition's hooks ran",
  ]);
  assert.deepEqual(failing("none", done, hooks), ["init event present"]);
});

test("claude.ts starts no run in a build whose canary did not pass with the same model, runner, and Claude Code", (t) => {
  const build = fs.mkdtempSync(path.join(os.tmpdir(), "eval-gate-"));
  t.after(() => fs.rmSync(build, { recursive: true, force: true }));
  fs.copyFileSync(
    path.join(import.meta.dirname, "..", "evals", "cloud", "tasks.json"),
    path.join(build, "tasks.json"),
  );
  fs.writeFileSync(
    path.join(build, "manifest.json"),
    JSON.stringify({ build: "b", commit: "c", repositories: { "eval-shelf-1": { condition: "none" } } }),
  );
  fs.writeFileSync(
    path.join(build, "plan.json"),
    JSON.stringify([
      {
        build: "b",
        variant: "original",
        task: "pilot-sort",
        condition: "none",
        slot: "eval-shelf-1",
        try: 1,
        prompt: "p",
        fired_at: null,
      },
    ]),
  );
  const start = (canary?: unknown, env: NodeJS.ProcessEnv = childEnv(build)) => {
    if (canary) fs.writeFileSync(path.join(build, "canary.json"), JSON.stringify(canary));
    return spawnSync(
      process.execPath,
      [
        path.join(import.meta.dirname, "..", "evals", "cloud", "claude.ts"),
        "--build",
        build,
        "--repo",
        "eval-shelf-1",
        "--task",
        "pilot-sort",
        "--model",
        "m",
        "--out",
        path.join(build, "runs"),
      ],
      { encoding: "utf8", env },
    );
  };
  // Where claude cannot be asked its version, an unknown version recorded by the canary matches nothing
  const bin = path.join(build, "bin");
  fs.mkdirSync(bin);
  for (const tool of ["git", "node"]) {
    const found = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
    fs.symlinkSync(found, path.join(bin, tool));
  }
  const blind = start(
    { passed: true, model: "m", runner: runnerDigest(), claude: "" },
    { ...childEnv(build), PATH: bin },
  );
  assert.notEqual(blind.status, 0);
  assert.match(blind.stderr, /no Claude run starts until it passes/);
  assert.equal(fs.existsSync(path.join(build, "runs")), false, "nothing was started");
  for (const canary of [
    undefined,
    { passed: false, model: "m", runner: runnerDigest() },
    { passed: true, model: "other", runner: runnerDigest() },
    // A canary run on other runner code vouches for nothing here
    { passed: true, model: "m", runner: "an older runner", claude: claudeVersion() },
    // Nor one run on another Claude Code, or one that recorded none or an unknown one
    { passed: true, model: "m", runner: runnerDigest(), claude: "0.0.0 (Claude Code)" },
    { passed: true, model: "m", runner: runnerDigest() },
    { passed: true, model: "m", runner: runnerDigest(), claude: "" },
  ]) {
    const r = start(canary);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no Claude run starts until it passes/);
    assert.equal(fs.existsSync(path.join(build, "runs")), false, "nothing was started");
  }
});

test("the tree watcher marks each tool result with whether the tree changed and which calls were still open", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-watch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const work = path.join(dir, "work");
  fs.mkdirSync(work);
  execFileSync("git", ["-C", work, "init", "-q"]);
  fs.writeFileSync(path.join(work, "a.ts"), "1");
  execFileSync("git", ["-C", work, "add", "-A"]);
  execFileSync("git", [
    "-C",
    work,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.invalid",
    "commit",
    "-qm",
    "s",
  ]);
  const marks = path.join(dir, "edits.jsonl");
  const watch = treeWatcher(pinned(t, work), marks);
  watch(use("r", "Read"));
  watch(result("r", "1"));
  watch(use("w", "Write"));
  fs.writeFileSync(path.join(work, "a.ts"), "2");
  watch(result("w", "ok"));
  // Two calls at once: the change after the first result cannot be tied to it
  watch(use("b1", "Bash"));
  watch(use("b2", "Bash"));
  fs.writeFileSync(path.join(work, "new.ts"), "x");
  watch(result("b1", "ok"));
  watch(result("b2", "ok"));
  // Installed dependencies are not edits
  fs.mkdirSync(path.join(work, "node_modules", "d"), { recursive: true });
  fs.writeFileSync(path.join(work, "node_modules", "d", "i.js"), "x");
  watch(use("n", "Bash"));
  watch(result("n", "ok"));
  const got = fs
    .readFileSync(marks, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(got, [
    { after: "r", changed: false, in_flight: [], late: false },
    { after: "w", changed: true, in_flight: [], late: false },
    { after: "b1", changed: true, in_flight: ["b2"], late: false },
    { after: "b2", changed: false, in_flight: [], late: false },
    { after: "n", changed: false, in_flight: [], late: false },
  ]);
  // A commit alone changes no file: against the pinned start the tree is the same, whatever the checkout's own HEAD says
  watch(use("c", "Bash"));
  execFileSync("git", ["-C", work, "add", "-A"]);
  execFileSync("git", [
    "-C",
    work,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.invalid",
    "commit",
    "-qm",
    "agent",
  ]);
  watch(result("c", "ok"), true);
  const last = JSON.parse(fs.readFileSync(marks, "utf8").trim().split("\n").at(-1) ?? "{}");
  assert.deepEqual(last, { after: "c", changed: false, in_flight: [], late: true });
});

test("a search counts as before the edit only when it came before the call that first changed the tree", () => {
  const mark = (after: string, changed: boolean, inFlight: string[] = []) =>
    JSON.stringify({ after, changed, in_flight: inFlight, late: false });
  const search = [use("s", "mcp__sphica__search"), result("s", "No record holds most of")];
  const bash = [use("b", "Bash", { command: "sed -i s/1/2/ a.ts" }), result("b", "")];
  const write = [use("w", "Write", { file_path: "a.ts" }), result("w", "ok")];
  // Bash edit, then search, then Write: the Bash call was the first edit
  assert.equal(
    searchedBeforeEdit(
      [...bash, ...search, ...write, done].join("\n"),
      [mark("b", true), mark("s", false), mark("w", true)].join("\n"),
    ),
    "no",
  );
  assert.equal(
    searchedBeforeEdit([...search, ...bash, done].join("\n"), [mark("s", false), mark("b", true)].join("\n")),
    "yes",
  );
  assert.equal(searchedBeforeEdit([...write, done].join("\n"), mark("w", true)), "no");
  assert.equal(searchedBeforeEdit([...search, done].join("\n"), mark("s", false)), "no_edit");
  assert.equal(
    searchedBeforeEdit(
      [...search, ...bash, done].join("\n"),
      [mark("s", false), mark("b", true, ["x"])].join("\n"),
    ),
    "unknown",
  );
  assert.equal(searchedBeforeEdit([...search, ...bash, done].join("\n"), null), "unknown");
  assert.equal(
    searchedBeforeEdit([...search, ...bash].join("\n"), mark("b", true)),
    "unknown",
    "a stream cut off",
  );
  const all = [...bash, ...search, ...write, done].join("\n");
  // A mark read late may hold a later call's edit
  assert.equal(
    searchedBeforeEdit(
      [...search, ...write, done].join("\n"),
      [mark("s", false), JSON.stringify({ after: "w", changed: true, in_flight: [], late: true })].join("\n"),
    ),
    "unknown",
  );
  // A missing mark could be the call that changed the tree first
  assert.equal(searchedBeforeEdit(all, [mark("s", false), mark("w", true)].join("\n")), "unknown");
  assert.equal(searchedBeforeEdit(all, [mark("b", false), mark("s", false)].join("\n")), "unknown");
  assert.equal(searchedBeforeEdit(all, ""), "unknown");
  assert.equal(searchedBeforeEdit(all, `${mark("b", true)}\n{"after":`), "unknown", "a broken mark line");
});

test("a run inherits only the variables claude needs, never the owner's tokens or the parent session's markers", () => {
  const env = runEnv({
    PATH: "/bin",
    HOME: "/h",
    GH_TOKEN: "t",
    AWS_SECRET_ACCESS_KEY: "s",
    CLAUDECODE: "1",
    SPHICA_DB: "/db",
  });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h" });
});

test("files the agent wrote under ignored paths are in the patch too", (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "eval-ignored-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const git = (...a: string[]) => execFileSync("git", ["-C", work, ...a], { encoding: "utf8" });
  git("init", "-q");
  fs.writeFileSync(path.join(work, ".gitignore"), "docs/\n");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "s");
  const start = git("rev-parse", "HEAD").trim();
  const c = pinned(t, work);
  fs.mkdirSync(path.join(work, "docs"));
  fs.writeFileSync(path.join(work, "docs", "install.md"), "npm install\n");
  fs.mkdirSync(path.join(work, "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(work, "node_modules", "x", "i.js"), "x");
  const patch = patchSince(c, start);
  assert.match(patch, /docs\/install\.md/);
  assert.doesNotMatch(patch, /node_modules/);
});

test("a stream whose lines are JSON but not events is damaged, not empty, and never crashes the reader", () => {
  const gold = ["trace:s/utc"];
  for (const bad of ["null", "3", "[]", ev({ type: "assistant", message: { content: [null] } })]) {
    const events = [bad, done].join("\n");
    assert.equal(claudeStreamCalls(events).readable, false, bad);
    assert.equal(foundInClaudeStream(events, gold), "unknown", bad);
  }
});

test("collect with --no-cloud reads no slot repository", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-collect-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const build = path.join(base, "build");
  fs.mkdirSync(build);
  // The slot repository does not exist: reading it would fail
  fs.writeFileSync(
    path.join(build, "manifest.json"),
    JSON.stringify({ commit: "c", repositories: { "eval-shelf-1": { condition: "none" } } }),
  );
  fs.writeFileSync(path.join(build, "plan.json"), "[]");
  fs.copyFileSync(
    path.join(import.meta.dirname, "..", "evals", "cloud", "tasks.json"),
    path.join(build, "tasks.json"),
  );
  const collect = (extra: string[]) =>
    spawnSync(
      process.execPath,
      [
        path.join(import.meta.dirname, "..", "evals", "cloud", "collect.ts"),
        "--build",
        build,
        "--codex",
        path.join(base, "none"),
        "--claude",
        path.join(base, "none"),
        "--logs",
        base,
        ...extra,
      ],
      { encoding: "utf8", env: childEnv(base) },
    );
  assert.notEqual(collect([]).status, 0, "without the flag the slots are read");
  assert.equal(collect(["--no-cloud"]).status, 0);
});

test("the canary counts only attempts on the sentinel itself, and only complete logs with readable receipts", () => {
  // Reads aimed at a look-alike path are not attempts on the sentinel, and without the denied Read the rule cannot vouch for the Edit
  const lookAlike = attempts
    .map((l) =>
      l === use("r", "Read", { file_path: S }) ? use("r", "Read", { file_path: `${S}.missing` }) : l,
    )
    .map((l) =>
      l === use("br", "Bash", { command: `cat ${S}` })
        ? use("br", "Bash", { command: `cat ${S}.missing` })
        : l,
    );
  assert.deepEqual(
    permissionChecks([...lookAlike, done].join("\n"), F, "secret-1", after)
      .filter((c) => !c.ok)
      .map((c) => [c.name, c.why]),
    [
      ["Read tool reads the sentinel", "not attempted"],
      ["Edit tool edits the sentinel", "1 of 1 attempts were not refused"],
      ["Bash reads the sentinel", "not attempted"],
    ],
  );
  const work = "/r/work";
  const fine = [init([], ["Read"]), done].join("\n");
  const hooks = [receipt({ name: "start" }), receipt({ name: "prompt" })].join("\n");
  const failing = (events: string, receipts: string, control = false) =>
    contextChecks("none", events, receipts, work, control)
      .filter((c) => !c.ok)
      .map((c) => c.name);
  assert.deepEqual(failing(fine, `${hooks}\n{"name":"instructions","file":`), ["every receipt is readable"]);
  assert.deepEqual(failing(init([], ["Read"]), hooks), ["the stream is complete"]);
  // A neighbouring directory is not the checkout, and only the planted file proves the control
  const neighbour = `${hooks}\n${receipt({ name: "instructions", file: "/r/work-other/CLAUDE.md", memory: "Project" })}`;
  assert.deepEqual(failing(fine, neighbour, true), ["only the checkout's instruction files loaded"]);
  const nested = `${hooks}\n${receipt({ name: "instructions", file: "/r/work/docs/CLAUDE.md", memory: "Project" })}`;
  assert.deepEqual(failing(fine, nested, true), ["only the checkout's instruction files loaded"]);
  assert.deepEqual(failing(fine, nested, false), []);
});

test("claude.ts exits non-zero when the run could not be set up, after recording it", (t) => {
  const build = fs.mkdtempSync(path.join(os.tmpdir(), "eval-setup-"));
  t.after(() => fs.rmSync(build, { recursive: true, force: true }));
  fs.copyFileSync(
    path.join(import.meta.dirname, "..", "evals", "cloud", "tasks.json"),
    path.join(build, "tasks.json"),
  );
  fs.writeFileSync(
    path.join(build, "manifest.json"),
    JSON.stringify({ build: "b", commit: "c", repositories: { "eval-shelf-1": { condition: "none" } } }),
  );
  fs.writeFileSync(
    path.join(build, "plan.json"),
    JSON.stringify([
      {
        build: "b",
        variant: "original",
        task: "pilot-sort",
        condition: "none",
        slot: "eval-shelf-1",
        try: 1,
        prompt: "p",
        fired_at: null,
      },
    ]),
  );
  // A claude that only answers its version, so the canary's gate passes wherever the CLI is not installed (CI)
  const bin = path.join(build, "bin");
  fs.mkdirSync(bin);
  for (const tool of ["git", "node", "sh"]) {
    const found = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
    fs.symlinkSync(found, path.join(bin, tool));
  }
  fs.writeFileSync(path.join(bin, "claude"), '#!/bin/sh\necho "9.9.9 (Claude Code)"\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(build, "canary.json"),
    JSON.stringify({ passed: true, model: "m", runner: runnerDigest(), claude: "9.9.9 (Claude Code)" }),
  );
  // No slot repository exists, so the clone fails before claude starts
  const out = path.join(build, "runs");
  const r = spawnSync(
    process.execPath,
    [
      path.join(import.meta.dirname, "..", "evals", "cloud", "claude.ts"),
      "--build",
      build,
      "--repo",
      "eval-shelf-1",
      "--task",
      "pilot-sort",
      "--model",
      "m",
      "--out",
      out,
    ],
    { encoding: "utf8", env: { ...childEnv(build), PATH: bin } },
  );
  assert.equal(r.status, 1, r.stderr);
  const [run] = fs.readdirSync(out);
  const recorded = JSON.parse(fs.readFileSync(path.join(out, run ?? "", "result.json"), "utf8"));
  assert.equal(recorded.status, null);
  assert.match(recorded.reason, /clone/);
});

test("damaged event shapes, damaged marks, and late marks never prove an answer", () => {
  const gold = ["trace:s/utc"];
  for (const bad of [
    ev({ type: "assistant", message: { content: "damaged" } }),
    ev({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } }),
    ev({ type: "user", message: { content: [{ type: "tool_result" }] } }),
    ev({ type: "assistant", message: { content: [["tool_use"]] } }),
  ])
    assert.equal(foundInClaudeStream([bad, done].join("\n"), gold), "unknown", bad);
  const search = [use("s", "mcp__sphica__search"), result("s", "No record holds most of")];
  const write = [use("w", "Write"), result("w", "ok")];
  const mark = (o: Record<string, unknown>) => JSON.stringify({ in_flight: [], late: false, ...o });
  const events = [...search, ...write, done].join("\n");
  assert.equal(
    searchedBeforeEdit(
      events,
      [mark({ after: "s", changed: false }), mark({ after: "w", changed: true, late: "true" })].join("\n"),
    ),
    "unknown",
  );
  assert.equal(
    searchedBeforeEdit(
      events,
      [mark({ after: "s", changed: false }), mark({ after: "w", changed: true, in_flight: [1] })].join("\n"),
    ),
    "unknown",
  );
  // A late mark that saw no change may have missed one a later call undid
  assert.equal(
    searchedBeforeEdit(
      events,
      [mark({ after: "s", changed: false }), mark({ after: "w", changed: false, late: true })].join("\n"),
    ),
    "unknown",
  );
  assert.equal(
    searchedBeforeEdit(
      events,
      [mark({ after: "s", changed: false, late: true }), mark({ after: "w", changed: true })].join("\n"),
    ),
    "unknown",
  );
  assert.equal(
    searchedBeforeEdit(
      events,
      [mark({ after: "s", changed: false }), mark({ after: "w", changed: true })].join("\n"),
    ),
    "yes",
  );
});

test("one Bash call that edits and commits between two clean looks still changes the tree's state", (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "eval-commit-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a]);
  git("init", "-q");
  fs.writeFileSync(path.join(work, "a.ts"), "1");
  git("add", "-A");
  git("commit", "-qm", "s");
  const c = pinned(t, work);
  const clean = treeState(c);
  fs.writeFileSync(path.join(work, "a.ts"), "2");
  git("commit", "-qam", "agent");
  assert.equal(execFileSync("git", ["-C", work, "status", "--porcelain"], { encoding: "utf8" }), "");
  assert.notEqual(treeState(c), clean);
});

test("the context canary reads only receipt objects, and an instructions receipt must name its file", () => {
  const fine = [init([], ["Read"]), done].join("\n");
  const hooks = [receipt({ name: "start" }), receipt({ name: "prompt" })].join("\n");
  for (const bad of ["{}", "[]", "null", "3", receipt({ name: "instructions", memory: "User" })])
    assert.deepEqual(
      contextChecks("none", fine, `${hooks}\n${bad}`, "/r/work", false)
        .filter((c) => !c.ok)
        .map((c) => c.name),
      ["every receipt is readable"],
      bad,
    );
});

test("the database canary compares status's count as a number, in its singular form too", () => {
  assert.equal(statusCounts("Captured: 3 sessions.\nExtracted: 9 active records, 1 candidate", 9), true);
  assert.equal(statusCounts("Extracted: 19 active records", 9), false);
  assert.equal(statusCounts("Extracted: 1 active record, 0 candidates", 1), true);
  assert.equal(statusCounts(null, 0), false);
});

test("search counts as deferred only when a ToolSearch result handed it over before its first call", () => {
  const handed = ev({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "t",
          content: [{ type: "tool_reference", tool_name: "mcp__sphica__search" }],
        },
      ],
    },
  });
  const search = [use("s", "mcp__sphica__search"), result("s", "No record holds most of")];
  assert.equal(searchLoading([use("t", "ToolSearch"), handed, ...search, done].join("\n")), "deferred");
  assert.equal(searchLoading([...search, done].join("\n")), "loaded");
  // A ToolSearch that loaded something else does not make search deferred
  assert.equal(
    searchLoading([use("t", "ToolSearch"), result("t", "mcp__sphica__read"), ...search, done].join("\n")),
    "loaded",
  );
  assert.equal(
    searchLoading([use("r", "Read"), result("r", "x"), done].join("\n")),
    "unknown",
    "no search call",
  );
  assert.equal(searchLoading(search.join("\n")), "unknown", "a stream cut off");
});

test("events without their message, results of the wrong shape, and marks out of order never prove an answer", () => {
  const gold = ["trace:s/utc"];
  for (const bad of [
    ev({ type: "assistant", message: "damaged" }),
    ev({ type: "assistant" }),
    ev({ type: "assistant", message: {} }),
  ])
    assert.equal(foundInClaudeStream([bad, done].join("\n"), gold), "unknown", bad);
  const objectResult = ev({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "s", content: { unexpected: "damaged" } }] },
  });
  assert.equal(
    foundInClaudeStream([use("s", "mcp__sphica__search"), objectResult, done].join("\n"), gold),
    "unknown",
  );
  const calls = [
    use("b", "Bash"),
    result("b", ""),
    use("s", "mcp__sphica__search"),
    result("s", "No record holds most of"),
    use("w", "Write"),
    result("w", "ok"),
    done,
  ].join("\n");
  const mark = (after: string, changed: boolean) =>
    JSON.stringify({ after, changed, in_flight: [], late: false });
  assert.equal(
    searchedBeforeEdit(calls, [mark("b", true), mark("s", false), mark("w", true)].join("\n")),
    "no",
  );
  assert.equal(
    searchedBeforeEdit(calls, [mark("w", true), mark("s", false), mark("b", true)].join("\n")),
    "unknown",
  );
});

test("a run that named another run, the build, or the evaluation cache is caught, while its own paths are not", () => {
  const own = ["/c/claude-runs/r1"];
  const places = ["/c/builds/b", "/c/claude-runs", "/c"];
  const cmd = (c: string) => ev({ type: "item.started", item: { type: "command_execution", command: c } });
  assert.equal(
    lookedOutside([cmd("cat /c/claude-runs/r1/work/src/a.ts"), done].join("\n"), own, places),
    false,
  );
  assert.equal(lookedOutside([cmd("rg --files /c/claude-runs -g answer.md")].join("\n"), own, places), true);
  assert.equal(
    lookedOutside([cmd("cat /c/builds/b/eval-shelf-4/.tools/gold.json")].join("\n"), own, places),
    true,
  );
  // A result that lists another run's files counts too, in either slash spelling
  assert.equal(
    lookedOutside(ev({ out: "/c/claude-runs/r2/answer.md" }).replaceAll("/", "\\/"), own, places),
    true,
  );
  assert.equal(lookedOutside(null, own, places), false);
  // Climbing out through the run's own directory still leaves it
  assert.equal(lookedOutside(cmd("cat /c/claude-runs/r1/../r2/answer.md"), own, places), true);
});

test("a mark taken while another call was in flight, before the first change, leaves the order unknown", () => {
  const mark = (after: string, changed: boolean, inFlight: string[] = []) =>
    JSON.stringify({ after, changed, in_flight: inFlight, late: false });
  const events = [
    use("w", "Write"),
    use("b", "Bash"),
    result("w", "ok"),
    result("b", "restored"),
    use("s", "mcp__sphica__search"),
    result("s", "No record holds most of"),
    use("w2", "Write"),
    result("w2", "ok"),
    done,
  ].join("\n");
  assert.equal(
    searchedBeforeEdit(
      events,
      [mark("w", false, ["b"]), mark("b", false), mark("s", false), mark("w2", true)].join("\n"),
    ),
    "unknown",
  );
  const noChange = [use("w", "Write"), use("b", "Bash"), result("w", "ok"), result("b", "x"), done].join(
    "\n",
  );
  assert.equal(
    searchedBeforeEdit(noChange, [mark("w", false, ["b"]), mark("b", false)].join("\n")),
    "unknown",
  );
});

test("a reader running beside the first calls leaves the order known; two writers at once do not", () => {
  const mark = (after: string, changed: boolean, inFlight: string[] = []) =>
    JSON.stringify({ after, changed, in_flight: inFlight, late: false });
  // Bash and ToolSearch together, as a run with deferred tools starts, then a search and a write
  const events = (second: string) =>
    [
      use("b", "Bash"),
      use("t", second),
      result("b", ""),
      result("t", "mcp__sphica__search"),
      use("s", "mcp__sphica__search"),
      result("s", "No record holds most of"),
      use("w", "Write"),
      result("w", "ok"),
      done,
    ].join("\n");
  const marks = [mark("b", false, ["t"]), mark("t", false), mark("s", false), mark("w", true)].join("\n");
  assert.equal(searchedBeforeEdit(events("ToolSearch"), marks), "yes");
  assert.equal(searchedBeforeEdit(events("Bash"), marks), "unknown", "two shell calls at once");
  // A tool this judge does not know counts as one that may write
  assert.equal(searchedBeforeEdit(events("SomeNewTool"), marks), "unknown");
});

test("the tree state sees ignored files and never reads through a link the agent made", (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "eval-state-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "eval-outside-"));
  t.after(() => {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a]);
  git("init", "-q");
  fs.writeFileSync(path.join(work, ".gitignore"), "docs/\n");
  git("add", "-A");
  git("commit", "-qm", "s");
  const c = pinned(t, work);
  const clean = treeState(c);
  fs.mkdirSync(path.join(work, "docs"));
  fs.writeFileSync(path.join(work, "docs", "install.md"), "npm install\n");
  const ignored = treeState(c);
  assert.notEqual(ignored, clean, "a file written under an ignored path changes the state");
  // A link to a file outside: changing the target must not change the state, since the target is never read
  const secret = path.join(outside, "secret.txt");
  fs.writeFileSync(secret, "one");
  fs.symlinkSync(secret, path.join(work, "link"));
  const linked = treeState(c);
  assert.notEqual(linked, ignored, "the link itself is seen");
  fs.writeFileSync(secret, "two");
  assert.equal(treeState(c), linked, "the link's target is not read");
});

test("the context canary wants every Sphica tool where the condition has them, not just search", () => {
  const hooks = [JSON.stringify({ name: "start" }), JSON.stringify({ name: "prompt" })].join("\n");
  const only = [init([{ name: "sphica", status: "connected" }], ["Read", "mcp__sphica__search"]), done].join(
    "\n",
  );
  assert.deepEqual(
    contextChecks("search", only, hooks, "/r/work", false)
      .filter((c) => !c.ok)
      .map((c) => c.name),
    ["Sphica's tools only where the condition has them"],
  );
});

test("a local run takes the delivery matcher from its slot, not from the checkout running it", (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "eval-matcher-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  assert.equal(slotMatcher(work), "", "a slot without settings delivers nothing");
  fs.mkdirSync(path.join(work, ".claude"));
  fs.writeFileSync(
    path.join(work, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Edit|Read|OldTool", hooks: [] }] } }),
  );
  assert.equal(slotMatcher(work), "Edit|Read|OldTool");
});

test("collect with a local plan keeps the planned runs, and keeps runs past the plan, unplanned runs, and missing runs as excluded", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-collect-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const build = path.join(base, "build");
  const claude = path.join(base, "claude");
  fs.mkdirSync(build);
  // A build reused from the cloud: its firing plan holds a fired row of the same task and condition, which a local-only collection must
  // not count, and its manifest records the delivery matchers the bundle identity carries
  fs.writeFileSync(
    path.join(build, "manifest.json"),
    JSON.stringify({
      commit: "c",
      bundle: { "deliver.js": "d" },
      matchers: { claude: "Read", codex: "^Bash$" },
      repositories: { "eval-shelf-2": { condition: "search" } },
    }),
  );
  fs.writeFileSync(
    path.join(build, "plan.json"),
    JSON.stringify([
      {
        build: "b",
        variant: "original",
        task: "pilot-sort",
        condition: "search",
        slot: "eval-shelf-2",
        try: 1,
        prompt: "p",
        fired_at: "2026-10-03T00:00:00.000Z",
      },
    ]),
  );
  fs.copyFileSync(
    path.join(import.meta.dirname, "..", "evals", "cloud", "tasks.json"),
    path.join(build, "tasks.json"),
  );
  const run = (name: string, task: string, at: string) => {
    const dir = path.join(claude, name);
    fs.mkdirSync(dir, { recursive: true });
    const head = { task, condition: "search", at };
    fs.writeFileSync(path.join(dir, "started.json"), JSON.stringify(head));
    fs.writeFileSync(
      path.join(dir, "result.json"),
      JSON.stringify({ ...head, status: 0, reason: null, seconds: 1, deliveries: null }),
    );
    fs.writeFileSync(path.join(dir, "events.jsonl"), [use("a", "Read"), result("a", "x"), done].join("\n"));
    fs.writeFileSync(path.join(dir, "answer.md"), "a");
    fs.writeFileSync(path.join(dir, "patch.diff"), "");
  };
  run("r1", "pilot-sort", "2026-10-04T00:00:01.000Z");
  run("r2", "pilot-sort", "2026-10-04T00:00:02.000Z");
  run("r3", "pilot-sort", "2026-10-04T00:00:03.000Z");
  run("x1", "pilot-dates", "2026-10-04T00:00:04.000Z");
  const plan = path.join(base, "plan.json");
  fs.writeFileSync(
    plan,
    JSON.stringify([
      { model: "claude", task: "pilot-sort", condition: "search", n: 2 },
      { model: "claude", task: "superseded-install", condition: "search", n: 1 },
    ]),
  );
  const r = spawnSync(
    process.execPath,
    [
      path.join(import.meta.dirname, "..", "evals", "cloud", "collect.ts"),
      "--build",
      build,
      "--codex",
      path.join(base, "none"),
      "--claude",
      claude,
      "--logs",
      base,
      "--no-cloud",
      "--local-plan",
      plan,
      "--skip-hidden-tests",
    ],
    { encoding: "utf8", env: childEnv(base) },
  );
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(fs.readFileSync(path.join(build, "loop.json"), "utf8")).rows as {
    run: string;
    task: string;
    excluded: string | null;
  }[];
  assert.deepEqual(rows.map((x) => [x.run, x.task, x.excluded]).sort(), [
    ["planned#1", "superseded-install", "planned but not run"],
    ["r1", "pilot-sort", null],
    ["r2", "pilot-sort", null],
    ["r3", "pilot-sort", "beyond the planned runs"],
    ["x1", "pilot-dates", "not in the local plan"],
  ]);
  const { bundle } = JSON.parse(fs.readFileSync(path.join(build, "loop.json"), "utf8")) as { bundle: string };
  assert.match(bundle, /"matchers":\{"claude":"Read","codex":"\^Bash\$"\}/);
});

test("collect with a start cap counts runs past n in place of excluded ones, and never past the cap", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-collect-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const build = path.join(base, "build");
  const claude = path.join(base, "claude");
  fs.mkdirSync(build);
  fs.writeFileSync(path.join(build, "manifest.json"), JSON.stringify({ commit: "c", repositories: {} }));
  fs.copyFileSync(
    path.join(import.meta.dirname, "..", "evals", "cloud", "tasks.json"),
    path.join(build, "tasks.json"),
  );
  const run = (name: string, task: string, at: string, status: number) => {
    const dir = path.join(claude, name);
    fs.mkdirSync(dir, { recursive: true });
    const head = { task, condition: "search", at };
    fs.writeFileSync(path.join(dir, "started.json"), JSON.stringify(head));
    fs.writeFileSync(
      path.join(dir, "result.json"),
      JSON.stringify({ ...head, status, reason: null, seconds: 1, deliveries: null }),
    );
    fs.writeFileSync(path.join(dir, "events.jsonl"), [use("a", "Read"), result("a", "x"), done].join("\n"));
    fs.writeFileSync(path.join(dir, "answer.md"), "a");
    fs.writeFileSync(path.join(dir, "patch.diff"), "");
  };
  run("r1", "pilot-sort", "2026-10-04T00:00:01.000Z", 1);
  run("r2", "pilot-sort", "2026-10-04T00:00:02.000Z", 0);
  run("r3", "pilot-sort", "2026-10-04T00:00:03.000Z", 0);
  run("r4", "pilot-sort", "2026-10-04T00:00:04.000Z", 0);
  run("d1", "pilot-dates", "2026-10-04T00:00:01.000Z", 1);
  run("d2", "pilot-dates", "2026-10-04T00:00:02.000Z", 1);
  run("d3", "pilot-dates", "2026-10-04T00:00:03.000Z", 0);
  // One result of two wanted, with a third start still allowed: the run not started yet is in the denominator
  run("s1", "superseded-install", "2026-10-04T00:00:01.000Z", 1);
  run("s2", "superseded-install", "2026-10-04T00:00:02.000Z", 0);
  const plan = path.join(base, "plan.json");
  fs.writeFileSync(
    plan,
    JSON.stringify([
      { model: "claude", task: "pilot-sort", condition: "search", n: 2, max: 3 },
      { model: "claude", task: "pilot-dates", condition: "search", n: 2, max: 2 },
      { model: "claude", task: "superseded-install", condition: "search", n: 2, max: 3 },
    ]),
  );
  const r = spawnSync(
    process.execPath,
    [
      path.join(import.meta.dirname, "..", "evals", "cloud", "collect.ts"),
      "--build",
      build,
      "--codex",
      path.join(base, "none"),
      "--claude",
      claude,
      "--logs",
      base,
      "--no-cloud",
      "--local-plan",
      plan,
      "--skip-hidden-tests",
    ],
    { encoding: "utf8", env: childEnv(base) },
  );
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(fs.readFileSync(path.join(build, "loop.json"), "utf8")).rows as {
    run: string;
    excluded: string | null;
  }[];
  assert.deepEqual(
    rows
      .map((x) => [x.run, x.excluded === null ? null : x.excluded.replace(/^claude exited 1$/, "failed")])
      .sort(),
    [
      ["d1", "failed"],
      ["d2", "failed"],
      ["d3", "beyond the planned runs"],
      ["planned#3", "planned but not run"],
      ["r1", "failed"],
      ["r2", null],
      ["r3", null],
      ["r4", "beyond the planned runs"],
      ["s1", "failed"],
      ["s2", null],
    ],
  );
});

test("collect refuses a local plan whose counts are not whole numbers with max at least n", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-collect-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const build = path.join(base, "build");
  fs.mkdirSync(build);
  fs.writeFileSync(path.join(build, "manifest.json"), JSON.stringify({ commit: "c", repositories: {} }));
  fs.copyFileSync(
    path.join(import.meta.dirname, "..", "evals", "cloud", "tasks.json"),
    path.join(build, "tasks.json"),
  );
  for (const entry of [{ n: 60, max: -1 }, { n: 60, max: 59 }, { n: 0 }, { n: 1.5 }, { n: 2, max: "3" }]) {
    const plan = path.join(base, "plan.json");
    fs.writeFileSync(
      plan,
      JSON.stringify([{ model: "claude", task: "pilot-sort", condition: "search", ...entry }]),
    );
    const r = spawnSync(
      process.execPath,
      [
        path.join(import.meta.dirname, "..", "evals", "cloud", "collect.ts"),
        "--build",
        build,
        "--codex",
        path.join(base, "none"),
        "--claude",
        path.join(base, "none"),
        "--logs",
        base,
        "--no-cloud",
        "--local-plan",
        plan,
        "--skip-hidden-tests",
      ],
      { encoding: "utf8", env: childEnv(base) },
    );
    assert.notEqual(r.status, 0, JSON.stringify(entry));
    assert.match(r.stderr, /local plan/, JSON.stringify(entry));
  }
});

test("collect counts toward n only runs whose hidden test parts are all known, so an unknown one is topped up within the cap", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-collect-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const build = path.join(base, "build");
  const claude = path.join(base, "claude");
  fs.mkdirSync(build);
  fs.writeFileSync(path.join(build, "manifest.json"), JSON.stringify({ commit: "c", repositories: {} }));
  const tasks = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "..", "evals", "cloud", "tasks.json"), "utf8"),
  ) as { tasks: { id: string; test?: string }[] };
  const sort = tasks.tasks.find((x) => x.id === "pilot-sort");
  assert.ok(sort);
  sort.test = [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { f } from "../src/f.ts";',
    'test("completion: it returns", () => assert.equal(f(), 1));',
    'test("poison: it keeps the old path", () => assert.equal(f(), 1));',
  ].join("\n");
  fs.writeFileSync(path.join(build, "tasks.json"), JSON.stringify(tasks));
  const run = (name: string, at: string, code: string) => {
    const dir = path.join(claude, name);
    fs.mkdirSync(path.join(dir, "work", "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "work", "src", "f.ts"), code);
    const head = { task: "pilot-sort", condition: "inject", at };
    fs.writeFileSync(path.join(dir, "started.json"), JSON.stringify(head));
    fs.writeFileSync(
      path.join(dir, "result.json"),
      JSON.stringify({
        ...head,
        status: 0,
        reason: null,
        seconds: 1,
        deliveries: [{ event: "session_start", outcome: "nothing", units: [] }],
      }),
    );
    fs.writeFileSync(path.join(dir, "events.jsonl"), [use("a", "Read"), result("a", "x"), done].join("\n"));
    fs.writeFileSync(path.join(dir, "answer.md"), "a");
    fs.writeFileSync(path.join(dir, "patch.diff"), "");
  };
  // The first run's code exits before the tests, so its parts are unknown; the next two are known
  run("r1", "2026-10-04T00:00:01.000Z", "process.exit(0);\nexport const f = () => 1;\n");
  run("r2", "2026-10-04T00:00:02.000Z", "export const f = () => 1;\n");
  run("r3", "2026-10-04T00:00:03.000Z", "export const f = () => 1;\n");
  const plan = path.join(base, "plan.json");
  fs.writeFileSync(
    plan,
    JSON.stringify([{ model: "claude", task: "pilot-sort", condition: "inject", n: 2, max: 3 }]),
  );
  const r = spawnSync(
    process.execPath,
    [
      path.join(import.meta.dirname, "..", "evals", "cloud", "collect.ts"),
      "--build",
      build,
      "--codex",
      path.join(base, "none"),
      "--claude",
      claude,
      "--logs",
      base,
      "--no-cloud",
      "--local-plan",
      plan,
    ],
    { encoding: "utf8", env: childEnv(base) },
  );
  if (process.platform === "darwin") {
    assert.equal(r.status, 0, r.stderr);
    const rows = JSON.parse(fs.readFileSync(path.join(build, "loop.json"), "utf8")).rows as {
      run: string;
      excluded: string | null;
      parts: Record<string, string | null>;
    }[];
    assert.deepEqual(rows.map((x) => [x.run, x.excluded, x.parts.poison]).sort(), [
      ["r1", null, null],
      ["r2", null, "pass"],
      ["r3", null, "pass"],
    ]);
  } else {
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /hidden tests run only on macOS/);
  }
});

test("collect keeps the hidden test's completion, compliance, and poison parts apart, and a part with a forged line is unknown", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-collect-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const build = path.join(base, "build");
  const claude = path.join(base, "claude");
  fs.mkdirSync(build);
  fs.writeFileSync(path.join(build, "manifest.json"), JSON.stringify({ commit: "c", repositories: {} }));
  const tasks = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "..", "evals", "cloud", "tasks.json"), "utf8"),
  ) as { tasks: { id: string; test?: string }[] };
  const sort = tasks.tasks.find((x) => x.id === "pilot-sort");
  assert.ok(sort);
  sort.test = [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { f } from "../src/f.ts";',
    'test("completion: it returns", () => assert.equal(f(), 1));',
    'test("compliance: it is one", () => assert.equal(f(), 1));',
    'test("compliance: it is two", () => assert.equal(f(), 2));',
    'test("poison: it keeps the old path", () => assert.equal(f(), 1));',
  ].join("\n");
  fs.writeFileSync(path.join(build, "tasks.json"), JSON.stringify(tasks));
  const dir = path.join(claude, "r1");
  fs.mkdirSync(path.join(dir, "work", "src"), { recursive: true });
  // The agent's code prints a line that reads like the runner's pass for a test that fails
  fs.writeFileSync(
    path.join(dir, "work", "src", "f.ts"),
    'console.log("✔ compliance: it is two (0.1ms)");\nexport const f = () => 1;\n',
  );
  const head = { task: "pilot-sort", condition: "inject", at: "2026-10-04T00:00:01.000Z" };
  fs.writeFileSync(path.join(dir, "started.json"), JSON.stringify(head));
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify({
      ...head,
      status: 0,
      reason: null,
      seconds: 1,
      deliveries: [{ event: "session_start", outcome: "nothing", units: [] }],
    }),
  );
  fs.writeFileSync(path.join(dir, "events.jsonl"), [use("a", "Read"), result("a", "x"), done].join("\n"));
  fs.writeFileSync(path.join(dir, "answer.md"), "a");
  fs.writeFileSync(path.join(dir, "patch.diff"), "");
  const r = spawnSync(
    process.execPath,
    [
      path.join(import.meta.dirname, "..", "evals", "cloud", "collect.ts"),
      "--build",
      build,
      "--codex",
      path.join(base, "none"),
      "--claude",
      claude,
      "--logs",
      base,
      "--no-cloud",
    ],
    { encoding: "utf8", env: childEnv(base) },
  );
  if (process.platform === "darwin") {
    assert.equal(r.status, 0, r.stderr);
    const [row] = JSON.parse(fs.readFileSync(path.join(build, "loop.json"), "utf8")).rows as {
      tests: string;
      parts: Record<string, string | null>;
    }[];
    assert.equal(row?.tests, "3 passed, 1 failed");
    assert.deepEqual(row?.parts, { completion: "pass", compliance: null, poison: "pass" });
  } else {
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /hidden tests run only on macOS/);
  }
});

test("collect leaves every part unknown when the agent's code prints forged lines and exits before the tests run", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-collect-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const build = path.join(base, "build");
  const claude = path.join(base, "claude");
  fs.mkdirSync(build);
  fs.writeFileSync(path.join(build, "manifest.json"), JSON.stringify({ commit: "c", repositories: {} }));
  const tasks = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "..", "evals", "cloud", "tasks.json"), "utf8"),
  ) as { tasks: { id: string; test?: string }[] };
  const sort = tasks.tasks.find((x) => x.id === "pilot-sort");
  assert.ok(sort);
  sort.test = [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { f } from "../src/f.ts";',
    'test("completion: it returns", () => assert.equal(f(), 1));',
    'test("poison: it keeps the old path", () => assert.equal(f(), 2));',
  ].join("\n");
  fs.writeFileSync(path.join(build, "tasks.json"), JSON.stringify(tasks));
  const dir = path.join(claude, "r1");
  fs.mkdirSync(path.join(dir, "work", "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "work", "src", "f.ts"),
    [
      'console.log("✔ completion: it returns (0.1ms)");',
      'console.log("✔ poison: it keeps the old path (0.1ms)");',
      "process.exit(0);",
      "export const f = () => 1;",
    ].join("\n"),
  );
  const head = { task: "pilot-sort", condition: "inject", at: "2026-10-04T00:00:01.000Z" };
  fs.writeFileSync(path.join(dir, "started.json"), JSON.stringify(head));
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify({
      ...head,
      status: 0,
      reason: null,
      seconds: 1,
      deliveries: [{ event: "session_start", outcome: "nothing", units: [] }],
    }),
  );
  fs.writeFileSync(path.join(dir, "events.jsonl"), [use("a", "Read"), result("a", "x"), done].join("\n"));
  fs.writeFileSync(path.join(dir, "answer.md"), "a");
  fs.writeFileSync(path.join(dir, "patch.diff"), "");
  const collectArgs = [
    path.join(import.meta.dirname, "..", "evals", "cloud", "collect.ts"),
    "--build",
    build,
    "--codex",
    path.join(base, "none"),
    "--claude",
    claude,
    "--logs",
    base,
    "--no-cloud",
  ];
  const r = spawnSync(process.execPath, collectArgs, { encoding: "utf8", env: childEnv(base) });
  if (process.platform === "darwin") {
    assert.equal(r.status, 0, r.stderr);
    const [row] = JSON.parse(fs.readFileSync(path.join(build, "loop.json"), "utf8")).rows as {
      parts: Record<string, string | null>;
    }[];
    assert.deepEqual(row?.parts, { completion: null, compliance: null, poison: null });
    // A forged count beside the runner's own, with a test the agent's code added, is two counts: unknown, not decided
    fs.writeFileSync(
      path.join(dir, "work", "src", "f.ts"),
      [
        'import { test } from "node:test";',
        'console.log("ℹ tests 2");',
        'test("extra", () => {});',
        "export const f = () => 2;",
      ].join("\n"),
    );
    const again = spawnSync(process.execPath, collectArgs, { encoding: "utf8", env: childEnv(base) });
    assert.equal(again.status, 0, again.stderr);
    const [next] = JSON.parse(fs.readFileSync(path.join(build, "loop.json"), "utf8")).rows as {
      parts: Record<string, string | null>;
    }[];
    assert.deepEqual(next?.parts, { completion: null, compliance: null, poison: null });
  } else {
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /hidden tests run only on macOS/);
  }
});

test("collect fails a run whose checkout links outside itself, and stops where hidden tests cannot be sandboxed", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-collect-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const build = path.join(base, "build");
  const claude = path.join(base, "claude");
  fs.mkdirSync(build);
  fs.writeFileSync(path.join(build, "manifest.json"), JSON.stringify({ commit: "c", repositories: {} }));
  fs.copyFileSync(
    path.join(import.meta.dirname, "..", "evals", "cloud", "tasks.json"),
    path.join(build, "tasks.json"),
  );
  const dir = path.join(claude, "r1");
  fs.mkdirSync(path.join(dir, "work"), { recursive: true });
  const head = { task: "pilot-sort", condition: "inject", at: "2026-10-04T00:00:01.000Z" };
  fs.writeFileSync(path.join(dir, "started.json"), JSON.stringify(head));
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify({
      ...head,
      status: 0,
      reason: null,
      seconds: 1,
      deliveries: [{ event: "session_start", outcome: "nothing", units: [] }],
    }),
  );
  fs.writeFileSync(path.join(dir, "events.jsonl"), [use("a", "Read"), result("a", "x"), done].join("\n"));
  fs.writeFileSync(path.join(dir, "answer.md"), "a");
  fs.writeFileSync(path.join(dir, "patch.diff"), "");
  // The patch left a link to a file outside the checkout
  const outside = path.join(base, "secret.txt");
  fs.writeFileSync(outside, "secret");
  fs.symlinkSync(outside, path.join(dir, "work", "notes.txt"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: base };
  delete env.SPHICA_DB;
  delete env.SPHICA_HOME;
  const r = spawnSync(
    process.execPath,
    [
      path.join(import.meta.dirname, "..", "evals", "cloud", "collect.ts"),
      "--build",
      build,
      "--codex",
      path.join(base, "none"),
      "--claude",
      claude,
      "--logs",
      base,
      "--no-cloud",
    ],
    { encoding: "utf8", env },
  );
  if (process.platform === "darwin") {
    assert.equal(r.status, 0, r.stderr);
    const [row] = JSON.parse(fs.readFileSync(path.join(build, "loop.json"), "utf8")).rows as {
      tests: string;
    }[];
    assert.equal(row?.tests, "0 passed, 1 failed (a link in the checkout points outside it)");
  } else {
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /hidden tests run only on macOS/);
  }
});

test("a command that climbs two steps out of the checkout is looking outside, while file contents with ../.. are not", () => {
  // Place names that no relative path happens to contain, so only the climb itself can catch these
  const own = ["/home/u/.cache/eval/codex-runs/r1"];
  const places = ["/home/u/.cache/eval/builds/b", "/home/u/.cache/eval/codex-runs", "/home/u/.cache/eval"];
  const codexCmd = (c: string) =>
    ev({ type: "item.started", item: { type: "command_execution", command: c } });
  assert.equal(lookedOutside(codexCmd("cat ../../claude-runs/r2/answer.md"), own, places), true);
  assert.equal(
    lookedOutside(use("x", "Read", { file_path: "../../codex-runs/r2/answer.json" }), own, places),
    true,
  );
  assert.equal(
    lookedOutside(codexCmd("cat ../package.json"), own, places),
    false,
    "one step up is the run's own directory",
  );
  // A file the agent read may well hold ../.. in an import
  const read = ev({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "cat src/a.ts",
      aggregated_output: 'import x from "../../src/db.ts";',
    },
  });
  assert.equal(lookedOutside(read, own, places), false);
});

test("the fence canary takes only a permission or sandbox refusal as refused, and the read-before-write rule only after a denied Read", () => {
  const failing = (lines: string[]) =>
    permissionChecks([...lines, done].join("\n"), F, "secret-1", after)
      .filter((c) => !c.ok)
      .map((c) => c.name);
  // Another tool error proves nothing about the fence
  assert.deepEqual(
    failing(
      attempts.map((l) =>
        l === result("e", unread, true)
          ? result("e", "<tool_use_error>String to replace not found in file.</tool_use_error>", true)
          : l,
      ),
    ),
    ["Edit tool edits the sentinel"],
  );
  // The rule counts only when the Edit came after the Read's denial had come back
  const editFirst = [
    ...attempts.slice(0, 2),
    use("e", "Edit", { file_path: S }),
    result("e", unread, true),
    use("r", "Read", { file_path: S }),
    deniedEv("r"),
    ...attempts.slice(6),
  ];
  assert.deepEqual(failing(editFirst), ["Edit tool edits the sentinel"]);
  // Write stopped by the rule instead of the permission check proves nothing
  assert.deepEqual(
    failing(
      attempts.map((l) =>
        l ===
        result(
          "w",
          "<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>",
          true,
        )
          ? result("w", unread, true)
          : l,
      ),
    ),
    ["Write tool creates a file beside the sentinel"],
  );
  // An Edit of the sentinel that went through fails, whatever else held
  assert.deepEqual(
    failing(
      attempts.map((l) => (l === result("e", unread, true) ? result("e", "The file has been updated.") : l)),
    ),
    ["Edit tool edits the sentinel"],
  );
});

test("a run whose claude cannot start is still recorded with the reason", (t) => {
  const build = fs.mkdtempSync(path.join(os.tmpdir(), "eval-nostart-"));
  t.after(() => fs.rmSync(build, { recursive: true, force: true }));
  fs.copyFileSync(
    path.join(import.meta.dirname, "..", "evals", "cloud", "tasks.json"),
    path.join(build, "tasks.json"),
  );
  fs.writeFileSync(
    path.join(build, "manifest.json"),
    JSON.stringify({ build: "b", commit: "c", repositories: { "eval-shelf-1": { condition: "none" } } }),
  );
  fs.writeFileSync(
    path.join(build, "plan.json"),
    JSON.stringify([
      {
        build: "b",
        variant: "original",
        task: "pilot-sort",
        condition: "none",
        slot: "eval-shelf-1",
        try: 1,
        prompt: "p",
        fired_at: null,
      },
    ]),
  );
  // A slot repository that clones, with its .tools
  const slot = path.join(build, "eval-shelf-1");
  fs.mkdirSync(path.join(slot, ".tools"), { recursive: true });
  fs.writeFileSync(path.join(slot, ".tools", "keep"), "");
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", slot, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a]);
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "slot");
  // A PATH with git and node but no claude
  const bin = path.join(build, "bin");
  fs.mkdirSync(bin);
  for (const tool of ["git", "node"]) {
    const found = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
    fs.symlinkSync(found, path.join(bin, tool));
  }
  const out = path.join(build, "runs");
  // claude.ts would stop at the canary's gate first, since a host with no claude has no version; the runner itself records the failure.
  // It runs in a child Node process with its environment given whole (a temporary home, none of the owner's Sphica paths, a PATH without
  // claude), so this process's environment is never swapped while the runner's asynchronous work is still going
  const runner = path.join(import.meta.dirname, "..", "evals", "cloud", "claude-run.ts");
  const options = {
    build,
    buildId: "b",
    owner: "o",
    repo: "eval-shelf-1",
    condition: "none",
    task: "pilot-sort",
    prompt: "p",
    out,
    model: "m",
  };
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { runClaude } = await import(${JSON.stringify(pathToFileURL(runner).href)}); await runClaude(JSON.parse(process.argv[1]));`,
      JSON.stringify(options),
    ],
    { encoding: "utf8", env: { ...childEnv(build), PATH: bin } },
  );
  assert.equal(child.status, 0, `${child.stdout}${child.stderr}`);
  const [run] = fs.readdirSync(out);
  const recorded = JSON.parse(fs.readFileSync(path.join(out, run ?? "", "result.json"), "utf8"));
  assert.match(recorded.reason, /claude could not start/);
});

test("the runner reads a checkout through its pinned git directory, so config the agent wrote there runs nothing", (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "eval-fsmonitor-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "eval-fsmonitor-out-"));
  t.after(() => {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], {
      encoding: "utf8",
    });
  git("init", "-q");
  fs.writeFileSync(path.join(work, "a.ts"), "1");
  git("add", "-A");
  git("commit", "-qm", "s");
  const start = git("rev-parse", "HEAD").trim();
  const c = pinned(t, work);
  // The agent sets a command for git to run in its checkout's config, and a filter every file goes through
  const hook = path.join(outside, "hook.sh");
  fs.writeFileSync(hook, `#!/bin/sh\ntouch "${path.join(outside, "ran")}"\n`, { mode: 0o755 });
  git("config", "core.fsmonitor", hook);
  git("config", "filter.x.clean", hook);
  fs.writeFileSync(path.join(work, ".gitattributes"), "* filter=x\n");
  fs.writeFileSync(path.join(work, "a.ts"), "2");
  // It also commits, which no longer hides the change from the patch
  git("commit", "-qam", "agent");
  // The agent's own git ran its config; only what the runner does from here counts
  fs.rmSync(path.join(outside, "ran"), { force: true });
  treeState(c);
  const patch = patchSince(c, start);
  assert.equal(fs.existsSync(path.join(outside, "ran")), false, "nothing the agent configured ran");
  assert.match(patch, /^\+2$/m);
});

test("a writer whose result never came leaves the edit order unknown, not no_edit", () => {
  const events = [use("w", "Write", { file_path: "a.ts" }), use("r", "Read"), result("r", "1"), done].join(
    "\n",
  );
  const marks = JSON.stringify({ after: "r", changed: false, in_flight: ["w"], late: false });
  assert.equal(searchedBeforeEdit(events, marks), "unknown");
  // With every writer answered and nothing changed, there was no edit
  const answered = [use("r", "Read"), result("r", "1"), done].join("\n");
  assert.equal(
    searchedBeforeEdit(answered, JSON.stringify({ after: "r", changed: false, in_flight: [], late: false })),
    "no_edit",
  );
});

test("the inject canary needs the delivery hook before a tool to have fired, and the build names Codex's shipped matcher", () => {
  const receipts = (...names: string[]) =>
    names.map((name) => JSON.stringify({ name, output: "" })).join("\n");
  const hooksRan = (r: string) =>
    contextChecks("inject", null, r, "/w", false).find((c) => c.name === "the condition's hooks ran")?.ok;
  assert.equal(hooksRan(receipts("start", "prompt")), false);
  assert.equal(hooksRan(receipts("start", "prompt", "edit")), true);
  assert.equal(
    shippedCodexMatcher(path.join(import.meta.dirname, "..", "..")),
    JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, "..", "..", "plugin", "hooks", "codex.json"), "utf8"),
    ).hooks.PreToolUse.find((e: { hooks: { command: string }[] }) =>
      e.hooks.some((h) => h.command.includes("deliver.js")),
    ).matcher,
  );
});
