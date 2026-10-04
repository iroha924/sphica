// The local Claude runner: what each condition is started with, how its patch and answer are taken, and how its stream is read.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { contextChecks, permissionChecks, statusCounts } from "../evals/cloud/canary-check.ts";
import {
  DENY_DIRS,
  DENY_FILES,
  finalAnswer,
  patchSince,
  runArgs,
  runEnv,
  runMcp,
  runSettings,
  treeState,
  treeWatcher,
} from "../evals/cloud/claude-run.ts";
import {
  claudeStreamCalls,
  foundInClaudeStream,
  goldSignalsFromClaudeStream,
  searchedBeforeEdit,
} from "../evals/cloud/judge.ts";

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
    assert.equal(s.sandbox.excludedCommands, undefined);
    for (const secret of [".ssh", ".claude", ".codex", ".sphica"]) {
      const full = path.join(os.homedir(), secret);
      assert.ok(s.sandbox.filesystem.denyRead.includes(full), `${condition}: sandbox reads ${secret}`);
      assert.ok(s.permissions.deny.includes(`Read(/${full}/**)`), `${condition}: Read tool reads ${secret}`);
      assert.ok(s.permissions.deny.includes(`Edit(/${full}/**)`), `${condition}: Edit tool writes ${secret}`);
    }
    assert.ok(s.permissions.deny.includes("PushNotification"));
    assert.deepEqual(s.env, { EVAL_RUN_DIR: "/r", EVAL_SPHICA_DB: "/r/db/sphica.db" });
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
  // The agent commits one change and leaves another untracked
  fs.writeFileSync(path.join(work, "a.ts"), "export const a = 2;\n");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", "agent");
  fs.writeFileSync(path.join(work, "b.ts"), "export const b = 1;\n");
  fs.writeFileSync(path.join(work, ".tools", "x"), "rewritten");
  fs.mkdirSync(path.join(work, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(work, "node_modules", "dep", "i.js"), "x");
  const patch = patchSince(work, start);
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
const deniedEv = (id: string) => ev({ type: "system", subtype: "permission_denied", tool_use_id: id });
const attempts = [
  use("w", "Write", { file_path: S }),
  result("w", "denied", true),
  use("e", "Edit", { file_path: S }),
  result("e", "denied", true),
  use("bw", "Bash", { command: `echo x > ${S}` }),
  result("bw", "operation not permitted", true),
  use("r", "Read", { file_path: S }),
  deniedEv("r"),
  use("br", "Bash", { command: `cat ${S}` }),
  result("br", "Operation not permitted", true),
];

test("the fence canary passes only when all five attempts were made and refused, and nothing changed or leaked", () => {
  const ok = permissionChecks([...attempts, done].join("\n"), S, "secret-1", true);
  assert.deepEqual(
    ok.filter((c) => !c.ok),
    [],
  );
  // A run that never tried the Bash read does not prove the sandbox blocks it
  const skipped = permissionChecks([...attempts.slice(0, 8), done].join("\n"), S, "secret-1", true);
  assert.deepEqual(
    skipped.filter((c) => !c.ok).map((c) => [c.name, c.why]),
    [["Bash reads the sentinel", "not attempted"]],
  );
  const through = permissionChecks(
    [
      ...attempts.slice(0, 8),
      use("br", "Bash", { command: `cat ${S}` }),
      result("br", "secret-1"),
      done,
    ].join("\n"),
    S,
    "secret-1",
    true,
  );
  assert.deepEqual(
    through.filter((c) => !c.ok).map((c) => c.name),
    ["Bash reads the sentinel", "the sentinel's secret is not in the stream"],
  );
  assert.equal(
    permissionChecks([...attempts, done].join("\n"), S, "s", false).find((c) => !c.ok)?.name,
    "the sentinel is unchanged",
  );
  assert.equal(
    permissionChecks(attempts.join("\n"), S, "s", true)[0]?.ok,
    false,
    "a stream without its result event is incomplete",
  );
  assert.equal(permissionChecks(null, S, "s", true).filter((c) => !c.ok).length >= 6, true);
});

const init = (servers: { name: string; status: string }[], tools: string[]) =>
  ev({ type: "system", subtype: "init", mcp_servers: servers, tools });
const receipt = (o: Record<string, unknown>) => JSON.stringify(o);

test("the context canary checks the condition's servers, tools, hooks, and that only the checkout's instructions loaded", () => {
  const work = "/r/work";
  const searchInit = init([{ name: "sphica", status: "connected" }], ["Read", "mcp__sphica__search"]);
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

test("claude.ts starts no run in a build whose canary did not pass with the same model", (t) => {
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
  const start = (canary?: unknown) => {
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
      { encoding: "utf8" },
    );
  };
  for (const canary of [undefined, { passed: false, model: "m" }, { passed: true, model: "other" }]) {
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
  const watch = treeWatcher(work, marks);
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
  // A commit made from Bash leaves the status clean but still changes the tree's state
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
  assert.deepEqual(last, { after: "c", changed: true, in_flight: [], late: true });
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
  fs.mkdirSync(path.join(work, "docs"));
  fs.writeFileSync(path.join(work, "docs", "install.md"), "npm install\n");
  fs.mkdirSync(path.join(work, "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(work, "node_modules", "x", "i.js"), "x");
  const patch = patchSince(work, start);
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
      { encoding: "utf8", env: { ...process.env, HOME: base } },
    );
  assert.notEqual(collect([]).status, 0, "without the flag the slots are read");
  assert.equal(collect(["--no-cloud"]).status, 0);
});

test("the canary counts only attempts on the sentinel itself, and only complete logs with readable receipts", () => {
  // Reads aimed at a look-alike path are not attempts on the sentinel
  const lookAlike = [
    ...attempts.slice(0, 6),
    use("r", "Read", { file_path: `${S}.missing` }),
    result("r", "No such file", true),
    use("br", "Bash", { command: `cat ${S}.missing` }),
    result("br", "No such file", true),
    done,
  ].join("\n");
  assert.deepEqual(
    permissionChecks(lookAlike, S, "secret-1", true)
      .filter((c) => !c.ok)
      .map((c) => c.why),
    ["not attempted", "not attempted"],
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
  fs.writeFileSync(path.join(build, "canary.json"), JSON.stringify({ passed: true, model: "m" }));
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
    { encoding: "utf8" },
  );
  assert.equal(r.status, 1);
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
  const clean = treeState(work);
  fs.writeFileSync(path.join(work, "a.ts"), "2");
  git("commit", "-qam", "agent");
  assert.equal(execFileSync("git", ["-C", work, "status", "--porcelain"], { encoding: "utf8" }), "");
  assert.notEqual(treeState(work), clean);
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
