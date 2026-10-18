// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The automatic trace evaluation on a real database and logs written here: which runs the logs name as automatic, and a pinned population
// the live data no longer gives.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  attribute,
  checkLabels,
  decide,
  differences,
  draw,
  extract,
  type Labels,
  type Population,
  pin,
  readClaude,
  readCodex,
  readLogs,
  shares,
  sheet,
  times,
} from "../evals/trace/auto-trace.ts";
import { openReader } from "../src/db.ts";
import { at, hash, insert, message, project, run, session, type TempDb, tempDb } from "./temp-db.ts";

const SCRIPT = path.join(import.meta.dirname, "..", "evals", "trace", "auto-trace.ts");
const WINDOW = { from: at("2026-10-04T00:00:00Z"), to: at("2026-10-18T06:00:00Z") };
const KEY = "git:github.com/o/r";
const RECORD = "mcp__plugin_sphica_record__";

type Line = Record<string, unknown>;
const jsonl = (rows: Line[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

/** One line of a Claude Code response: message.id ties the lines of one response together */
const said = (id: string, when: string, calls: { id: string; name: string; input: Line }[] = []): Line => ({
  type: "assistant",
  sessionId: "main",
  cwd: "/r",
  timestamp: at(when),
  requestId: `req-${id}`,
  message: { id, content: calls.map((c) => ({ type: "tool_use", ...c })) },
});

const answered = (id: string, when: string, text: string, error = false): Line => ({
  type: "user",
  sessionId: "main",
  timestamp: at(when),
  message: {
    content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error: error }],
  },
});

const responded = (id: string, when: string, turn = "t1"): Line => ({
  type: "token_usage_record",
  timestamp: at(when),
  payload: { response_id: id, turn_id: turn, usage: { input_tokens: 1, output_tokens: 1 } },
});

const mcp = (id: string, when: string, server: string, tool: string, args: Line, text: string): Line => ({
  type: "event_msg",
  timestamp: at(when),
  payload: {
    type: "item_completed",
    item: {
      type: "McpToolCall",
      id,
      server,
      tool,
      arguments: args,
      status: "completed",
      result: { content: [{ type: "text", text }] },
    },
  },
});

function logsDir(): { root: string; claude: string; codex: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-auto-trace-"));
  const claude = path.join(root, "claude");
  const codex = path.join(root, "codex");
  fs.mkdirSync(claude);
  fs.mkdirSync(codex);
  return { root, claude, codex };
}

/**
 * Claude Code: an automatic trace of run A, a retry after a wrong run id, and a manual trace of run M (no auto). Codex: an automatic trace
 * of run C, with the same call also written as text inside a code-mode exec call, and a session with no automatic call at all.
 */
function writeLogs(dirs: { claude: string; codex: string }) {
  fs.writeFileSync(
    path.join(dirs.claude, "main.jsonl"),
    jsonl([
      said("m1", "2026-10-05T00:00:00Z", [
        { id: "p1", name: `${RECORD}trace_pending`, input: { auto: true, cwd: "/r" } },
      ]),
      answered("p1", "2026-10-05T00:00:01Z", "1 session to trace"),
      said("m2", "2026-10-05T00:00:02Z", [
        { id: "b1", name: `${RECORD}trace_begin`, input: { session: "s1" } },
      ]),
      said("m2", "2026-10-05T00:00:02Z"),
      answered("b1", "2026-10-05T00:00:03Z", "run: draftA"),
      said("m3", "2026-10-05T00:00:04Z", [
        { id: "c0", name: `${RECORD}record_context`, input: { run: "wrongId", auto: true } },
      ]),
      answered("c0", "2026-10-05T00:00:05Z", "Sphica: No run wrongId. Begin again", true),
      said("m4", "2026-10-05T00:00:06Z", [
        { id: "c1", name: `${RECORD}record_context`, input: { run: "draftA", auto: true } },
        { id: "r1", name: "mcp__plugin_sphica_sphica__search", input: { query: "x" } },
      ]),
      answered("c1", "2026-10-05T00:00:07Z", "context"),
      "not json" as unknown as Line,
      said("m5", "2026-10-06T00:00:00Z", [
        { id: "c2", name: `${RECORD}record_context`, input: { run: "draftM" } },
      ]),
    ]),
  );
  fs.writeFileSync(
    path.join(dirs.claude, "manual.jsonl"),
    jsonl([
      said("x1", "2026-10-06T00:00:00Z", [
        { id: "x", name: `${RECORD}record_context`, input: { run: "draftM" } },
      ]),
    ]),
  );
  fs.mkdirSync(path.join(dirs.codex, "2026", "10", "14"), { recursive: true });
  fs.writeFileSync(
    path.join(dirs.codex, "2026", "10", "14", "rollout-a.jsonl"),
    jsonl([
      { type: "session_meta", payload: { id: "thread-1" } },
      { type: "turn_context", payload: { cwd: "/r" } },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          input: 'tools.mcp__record__record_context({run:"draftZ",auto:true})',
        },
      },
      responded("resp1", "2026-10-14T00:00:00Z"),
      mcp("e1", "2026-10-14T00:00:01Z", "record", "trace_pending", { auto: true }, "1 session"),
      responded("resp2", "2026-10-14T00:00:02Z"),
      mcp("e2", "2026-10-14T00:00:03Z", "record", "record_context", { run: "draftC", auto: true }, "context"),
      mcp("e3", "2026-10-14T00:00:04Z", "sphica", "search", { query: "x" }, "hits"),
    ]),
  );
  fs.writeFileSync(
    path.join(dirs.codex, "2026", "10", "14", "rollout-b.jsonl"),
    jsonl([
      { type: "session_meta", payload: { id: "thread-2" } },
      responded("resp9", "2026-10-14T00:00:00Z"),
    ]),
  );
}

function traceRun(db: TempDb, p: number, draft: string, started: string, target = "s1"): number {
  session(db, p, target);
  return insert(db, "extraction_run", {
    project_id: p,
    origin: "trace",
    target: `session:${target}`,
    session_id: target,
    status: "saved",
    draft_id: draft,
    started_at: at(started),
    finished_at: at(started),
  });
}

function unit(db: TempDb, p: number, run: number, key: string, created: string, kind = "finding"): number {
  return insert(db, "unit", {
    project_id: p,
    key,
    kind,
    stance: kind === "decision" ? "do" : null,
    text: key,
    extraction: "supported",
    run_id: run,
    created_at: at(created),
    content_hash: hash(key.length),
  });
}

/** Runs A and C inside the window, A with two records, and M, which no automatic call names */
function fixture(db: TempDb) {
  const p = project(db);
  const a = traceRun(db, p, "draftA", "2026-10-05T00:00:02Z");
  const c = traceRun(db, p, "draftC", "2026-10-14T00:00:02Z", "s2");
  traceRun(db, p, "draftM", "2026-10-06T00:00:00Z");
  const a2 = unit(db, p, a, "a2", "2026-10-05T00:00:09Z");
  const a1 = unit(db, p, a, "a1", "2026-10-05T00:00:08Z");
  return { p, a, c, a1, a2 };
}

test("a Claude Code transcript gives one response per message.id, with each call's result and its error text", () => {
  const dirs = logsDir();
  try {
    writeLogs(dirs);
    const log = readClaude(dirs.claude, "main.jsonl");
    assert.equal(log.session, "main");
    assert.deepEqual(
      log.responses.map((r) => r.key),
      ["m1", "m2", "m3", "m4", "m5"],
    );
    assert.deepEqual(log.unreadable, [10]);
    const byId = Object.fromEntries(log.calls.map((c) => [c.id, c]));
    assert.deepEqual([byId.b1?.tool, byId.b1?.server, byId.b1?.response], ["trace_begin", "record", 1]);
    assert.deepEqual([byId.r1?.tool, byId.r1?.server], ["search", "read"]);
    assert.deepEqual(byId.c0?.result, { line: 7, ok: false, text: "Sphica: No run wrongId. Begin again" });
    assert.equal(byId.c2?.result, null);
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test("a Codex rollout ties each completed McpToolCall to the response before it, and never reads calls written as code", () => {
  const dirs = logsDir();
  try {
    writeLogs(dirs);
    const log = readCodex(dirs.codex, path.join("2026", "10", "14", "rollout-a.jsonl"));
    assert.equal(log.session, "thread-1");
    assert.deepEqual(
      log.responses.map((r) => [r.key, r.turn]),
      [
        ["resp1", "t1"],
        ["resp2", "t1"],
      ],
    );
    assert.deepEqual(
      log.calls.map((c) => [c.tool, c.server, c.response, c.input.run ?? null]),
      [
        ["trace_pending", "record", 0, null],
        ["record_context", "record", 1, "draftC"],
        ["search", "read", 1, null],
      ],
    );
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test("the population is the project's trace runs an automatic record_context names, inside the window, with their records", async () => {
  const db = tempDb();
  const dirs = logsDir();
  try {
    writeLogs(dirs);
    const f = fixture(db);
    const logs = readLogs(dirs);
    assert.deepEqual(
      logs.map((l) => l.file),
      ["main.jsonl", path.join("2026", "10", "14", "rollout-a.jsonl")],
    );
    const pop = await extract(db.reader, KEY, WINDOW, logs, "/r");
    assert.deepEqual(
      pop.runs.map((r) => [r.id, r.draft, r.target, r.callers, r.units]),
      [
        [
          f.a,
          "draftA",
          { host: "claude-code", session: "ext-s1" },
          [{ host: "claude-code", file: "main.jsonl" }],
          [f.a1, f.a2],
        ],
        [
          f.c,
          "draftC",
          { host: "claude-code", session: "ext-s2" },
          [{ host: "codex", file: path.join("2026", "10", "14", "rollout-a.jsonl") }],
          [],
        ],
      ],
    );
    assert.equal(pop.units, 2);
    assert.deepEqual(pop.unmatched, [
      {
        draft: "wrongId",
        host: "claude-code",
        file: "main.jsonl",
        line: 6,
        error: "Sphica: No run wrongId. Begin again",
      },
    ]);
    assert.deepEqual(
      pop.spans.map((s) => [s.host, s.line, s.call]),
      [
        ["claude-code", 1, "p1"],
        ["codex", 5, "e1"],
      ],
    );
    const narrow = await extract(
      db.reader,
      KEY,
      { from: WINDOW.from, to: at("2026-10-10T00:00:00Z") },
      logs,
      "/r",
    );
    assert.deepEqual(
      narrow.runs.map((r) => r.draft),
      ["draftA"],
    );
    assert.equal(narrow.spans.length, 1);
    await assert.rejects(
      extract(db.reader, "git:github.com/o/none", WINDOW, logs, "/r"),
      /no project with the key/,
    );
  } finally {
    await db.done();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test("a pinned population matches itself and names the runs, records, and spans that changed since", async () => {
  const db = tempDb();
  const dirs = logsDir();
  try {
    writeLogs(dirs);
    const f = fixture(db);
    const logs = readLogs(dirs);
    const pinned = await extract(db.reader, KEY, WINDOW, logs, "/r");
    assert.deepEqual(differences(pinned, pinned), []);
    const fewer = await extract(db.reader, KEY, WINDOW, logs.slice(1), "/r");
    assert.deepEqual(differences(pinned, fewer), [
      `1 pinned runs are no longer there, first ${f.a}`,
      "unmatched run ids differ: 1 pinned, 0 now",
      "automatic trace spans differ: 2 pinned, 1 now",
    ]);
    db.owner.prepare("delete from unit where id = ?").run(f.a2);
    assert.deepEqual(differences(pinned, await extract(db.reader, KEY, WINDOW, logs, "/r")), [
      `1 runs changed, first ${f.a}`,
    ]);
    assert.match(differences({ ...pinned, sha256: "0" }, pinned)[0] ?? "", /does not hash to its sha256/);
  } finally {
    await db.done();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

/** A git repository with one commit holding server/, as freeze checks server/ is clean */
function repoAt(dir: string): string {
  const repo = path.join(dir, "repo");
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  fs.mkdirSync(path.join(repo, "server"), { recursive: true });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "server", "a.ts"), "export {};\n");
  git("add", ".");
  git("commit", "-qm", "first");
  return repo;
}

test("the script freezes the database and the logs once, then stops with the difference when the live data no longer gives them", async () => {
  const db = tempDb();
  const dirs = logsDir();
  try {
    writeLogs(dirs);
    const f = fixture(db);
    const repo = repoAt(dirs.root);
    const frozen = path.join(dirs.root, "frozen");
    const out = path.join(dirs.root, "baseline.json");
    const args = [
      SCRIPT,
      "--freeze",
      ...["--db", db.file, "--claude", dirs.claude, "--codex", dirs.codex, "--project", KEY, "--root", "/r"],
      ...["--from", WINDOW.from, "--to", WINDOW.to, "--repo", repo, "--frozen", frozen, "--out", out],
    ];
    const first = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    const baseline = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(baseline.population.runs.length, 2);
    assert.equal(baseline.inputs.logs.count, 2);
    assert.equal(baseline.inputs.commit.length, 40);
    assert.ok(fs.existsSync(path.join(frozen, "sphica.db")));
    assert.ok(fs.existsSync(path.join(frozen, "logs", "codex", "2026", "10", "14", "rollout-a.jsonl")));
    assert.ok(!fs.existsSync(path.join(frozen, "logs", "claude-code", "manual.jsonl")));
    const usage = spawnSync(process.execPath, [SCRIPT, "--usage", "--baseline", out, "--frozen", frozen], {
      encoding: "utf8",
    });
    assert.equal(usage.status, 0, usage.stderr);
    const counted = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.deepEqual(Object.keys(counted.usage.hosts), ["claude-code", "codex"]);
    assert.equal(counted.usage.spans.length, 2);
    assert.equal(
      counted.usage.hosts["claude-code"].output.gaps,
      counted.usage.hosts["claude-code"].responses,
    );
    fs.writeFileSync(out, `${JSON.stringify(baseline, null, 2)}\n`);
    const again = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /2 runs and 2 records, the same as/);
    db.owner.prepare("delete from unit where id = ?").run(f.a1);
    const changed = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /no longer gives the pinned population:\n1 runs changed/);
    assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(out, "utf8"))), JSON.stringify(baseline));
    const missing = spawnSync(process.execPath, [SCRIPT, "--freeze", "--db", db.file], { encoding: "utf8" });
    assert.notEqual(missing.status, 0);
    assert.match(
      missing.stderr,
      /--freeze needs --claude, --codex, --project, --root, --from, --to, --repo, --frozen, --out/,
    );
  } finally {
    await db.done();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

/** A Claude Code response line with usage: output carries the tokens so a sum names the responses in it */
const spent = (
  id: string,
  when: string,
  output: number,
  calls: { id: string; name: string; input: Line }[] = [],
): Line => {
  const line = said(id, when, calls);
  (line.message as Line).usage = {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: output,
  };
  return line;
};

const asked = (when: string): Line => ({
  type: "user",
  sessionId: "main",
  timestamp: at(when),
  origin: { kind: "human" },
  message: { content: "go on" },
});

const t = (s: number) => `2026-10-05T00:00:${String(s).padStart(2, "0")}Z`;

/**
 * One automatic trace of runs A (saves nothing) and B (saves a record), begun together: m3 works on both, m5 runs while both are open,
 * m8 while only B is, m10 closes it, and m11 and the next turn's m12 are the owner's work after it.
 */
function spanLog(dir: string) {
  fs.writeFileSync(
    path.join(dir, "span.jsonl"),
    jsonl([
      asked(t(0)),
      spent("m1", t(1), 1, [{ id: "p", name: `${RECORD}trace_pending`, input: { auto: true } }]),
      answered("p", t(2), "2 sessions to trace"),
      spent("m2", t(3), 2, [
        { id: "ba", name: `${RECORD}trace_begin`, input: { session: "sa" } },
        { id: "bb", name: `${RECORD}trace_begin`, input: { session: "sb" } },
      ]),
      answered("ba", t(4), "run: dA\nNext: record_context with this run."),
      answered("bb", t(5), "run: dB\nNext: record_context with this run."),
      spent("m3", t(6), 0, [{ id: "ca", name: `${RECORD}record_context`, input: { run: "dA", auto: true } }]),
      spent("m3", t(6), 4, [{ id: "cb", name: `${RECORD}record_context`, input: { run: "dB", auto: true } }]),
      answered("ca", t(7), "context A"),
      answered("cb", t(8), "context B"),
      spent("m4", t(9), 8, [{ id: "x1", name: "Bash", input: { command: "git log" } }]),
      answered("x1", t(10), "log"),
      spent("m5", t(11), 16),
      spent("m6", t(12), 32, [{ id: "sa", name: `${RECORD}record_save`, input: { run: "dA" } }]),
      answered("sa", t(13), "✓ saved"),
      spent("m7", t(14), 64, [{ id: "x2", name: "Bash", input: { command: "rg mask" } }]),
      answered("x2", t(15), "mask"),
      spent("m8", t(16), 128),
      spent("m9", t(17), 256, [{ id: "sb", name: `${RECORD}record_save`, input: { run: "dB" } }]),
      answered("sb", t(18), "✓ saved"),
      spent("m10", t(19), 512),
      spent("m11", t(20), 1024, [{ id: "x3", name: "Edit", input: {} }]),
      answered("x3", t(21), "edited"),
      asked(t(22)),
      spent("m12", t(23), 2048),
    ]),
  );
}

function spanPopulation(
  lines: { file: string; line: number; call: string }[],
  runs: [number, string, number[]][],
): Population {
  return {
    project: KEY,
    root: "/r",
    window: WINDOW,
    condition: "",
    runs: runs.map(([id, draft, units]) => ({
      id,
      draft,
      started_at: at(t(3)),
      finished_at: at(t(18)),
      status: "saved",
      target: { host: "claude-code", session: null },
      callers: [],
      units,
    })),
    unmatched: [],
    spans: lines.map((l) => ({ host: "claude-code", ...l, at: null })),
    units: 0,
    sha256: "",
  };
}

test("a span runs from the automatic trace_pending to the response that reads the last record result, and its tokens split into bounds", () => {
  const dirs = logsDir();
  try {
    spanLog(dirs.claude);
    const log = readClaude(dirs.claude, "span.jsonl");
    assert.deepEqual(
      log.responses.map((r) => [r.key, r.turn]),
      [...Array.from({ length: 11 }, (_, i) => [`m${i + 1}`, "1"]), ["m12", "2"]],
    );
    assert.equal(
      log.responses[2]?.usage?.output,
      4,
      "the last line of a response holds its usage, taken once",
    );
    const pop = spanPopulation(
      [{ file: "span.jsonl", line: 2, call: "p" }],
      [
        [1, "dA", []],
        [2, "dB", [7]],
      ],
    );
    const { responses, spans } = attribute(pop, [log]);
    assert.deepEqual(
      responses.map((r) => [r.key, r.runs, r.selection, r.unattributed, r.lower, r.upper]),
      [
        ["m1", [], true, false, false, true],
        ["m2", [1, 2], true, false, false, true],
        ["m3", [1, 2], false, false, false, true],
        ["m4", [1, 2], false, false, false, true],
        ["m5", [], false, true, false, true],
        ["m6", [1], false, false, true, true],
        ["m7", [1], false, false, true, true],
        ["m8", [2], false, false, false, false],
        ["m9", [2], false, false, false, false],
        ["m10", [2], false, false, false, false],
      ],
    );
    assert.deepEqual(
      spans.map((s) => [s.start, s.end, s.truncated, s.runs, s.selection_seconds]),
      [[2, 21, false, [1, 2], 2]],
    );
    const share = shares(responses)["claude-code"];
    assert.deepEqual(
      [share?.output.total, share?.output.empty_low, share?.output.empty_high, share?.output.gaps],
      [1023, 96, 127, 0],
    );
    const owned = attribute(
      pop,
      [log],
      [{ host: "claude-code", file: "span.jsonl", line: 16, reason: "checks the owner's mask" }],
    );
    assert.equal(
      shares(owned.responses)["claude-code"]?.output.empty_low,
      32,
      "owner work leaves the low bound",
    );
    assert.equal(
      shares(owned.responses)["claude-code"]?.output.empty_high,
      127,
      "and stays in the high bound",
    );
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test("a run whose last call has no result is unknown, so its tokens count only in the high bound, and a missing usage is a gap", () => {
  const dirs = logsDir();
  try {
    fs.writeFileSync(
      path.join(dirs.claude, "cut.jsonl"),
      jsonl([
        spent("m1", t(1), 1, [{ id: "p", name: `${RECORD}trace_pending`, input: { auto: true } }]),
        answered("p", t(2), "1 session"),
        spent("m2", t(3), 2, [{ id: "b", name: `${RECORD}trace_begin`, input: { session: "s" } }]),
        answered("b", t(4), "run: dC"),
        {
          ...said("", t(5), [{ id: "c", name: `${RECORD}record_context`, input: { run: "dC", auto: true } }]),
          requestId: undefined,
          message: {
            content: [
              {
                type: "tool_use",
                id: "c",
                name: `${RECORD}record_context`,
                input: { run: "dC", auto: true },
              },
            ],
          },
        },
      ]),
    );
    const log = readClaude(dirs.claude, "cut.jsonl");
    assert.equal(log.responses[2]?.gap, "no message.id or requestId");
    const pop = spanPopulation([{ file: "cut.jsonl", line: 1, call: "p" }], [[3, "dC", []]]);
    const { responses, spans } = attribute(pop, [log]);
    assert.equal(spans[0]?.truncated, true);
    assert.deepEqual(
      responses.map((r) => [r.runs, r.lower, r.upper]),
      [
        [[], false, true],
        [[3], false, true],
        [[3], false, true],
      ],
    );
    const share = shares(responses)["claude-code"]?.output;
    assert.deepEqual([share?.total, share?.empty_low, share?.gaps, share?.gaps_high], [3, 0, 1, 1]);
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test("Codex usage comes once per response_id and must add up to the turn's running total, else it is a gap", () => {
  const dirs = logsDir();
  try {
    const record = (id: string, usage: Line, total: Line, turn = "t1"): Line => ({
      type: "token_usage_record",
      timestamp: at(t(1)),
      payload: { response_id: id, turn_id: turn, usage, turn_token_usage: total },
    });
    fs.writeFileSync(
      path.join(dirs.codex, "u.jsonl"),
      jsonl([
        { type: "turn_context", payload: { model: "gpt-x" } },
        record(
          "r1",
          { input_tokens: 10, cached_input_tokens: 4, output_tokens: 1 },
          { input_tokens: 10, cached_input_tokens: 4, output_tokens: 1 },
        ),
        record(
          "r1",
          { input_tokens: 10, cached_input_tokens: 4, output_tokens: 1 },
          { input_tokens: 10, cached_input_tokens: 4, output_tokens: 1 },
        ),
        record(
          "r2",
          { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2 },
          { input_tokens: 15, cached_input_tokens: 4, output_tokens: 3 },
        ),
        record(
          "r3",
          { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1 },
          { input_tokens: 30, cached_input_tokens: 4, output_tokens: 4 },
        ),
        record(
          "r4",
          { input_tokens: 7, cached_input_tokens: 0, output_tokens: 1 },
          { input_tokens: 7, cached_input_tokens: 0, output_tokens: 1 },
          "t2",
        ),
      ]),
    );
    const log = readCodex(dirs.codex, "u.jsonl");
    assert.deepEqual(
      log.responses.map((r) => [r.key, r.usage, r.gap]),
      [
        ["r1", { model: "gpt-x", input: 6, cacheCreation: 0, cacheRead: 4, output: 1 }, null],
        ["r2", { model: "gpt-x", input: 5, cacheCreation: 0, cacheRead: 0, output: 2 }, null],
        ["r3", null, "input_tokens: 15 + 5 is not the turn total 30"],
        ["r4", { model: "gpt-x", input: 7, cacheCreation: 0, cacheRead: 0, output: 1 }, null],
      ],
    );
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test("span time merges overlapping spans, and run time comes from begin to save", () => {
  const pop = spanPopulation([], [[1, "dA", []]]);
  const span = (from: string, to: string) => ({
    host: "claude-code" as const,
    file: "f",
    start: 1,
    end: 2,
    from: at(from),
    to: at(to),
    truncated: false,
    runs: [],
    selection_seconds: 5,
  });
  const out = times(pop, [span(t(0), t(10)), span(t(5), t(20)), span(t(30), t(40))]);
  assert.equal(out.span_seconds_merged, 30);
  assert.deepEqual(out.span_seconds, { n: 3, total: 35, median: 10, max: 15 });
  assert.deepEqual(out.run_seconds, { n: 1, total: 15, median: 15, max: 15 });
});

test("only the project's own automatic calls count: a call made from another repository is neither a span nor an unmatched run id", async () => {
  const db = tempDb();
  const dirs = logsDir();
  try {
    writeLogs(dirs);
    fixture(db);
    fs.writeFileSync(
      path.join(dirs.codex, "other.jsonl"),
      jsonl([
        { type: "session_meta", payload: { id: "thread-3" } },
        { type: "turn_context", payload: { cwd: "/elsewhere" } },
        responded("o1", "2026-10-15T00:00:00Z"),
        mcp("o2", "2026-10-15T00:00:01Z", "record", "trace_pending", { auto: true }, "1 session"),
        responded("o3", "2026-10-15T00:00:02Z"),
        mcp(
          "o4",
          "2026-10-15T00:00:03Z",
          "record",
          "record_context",
          { run: "theirs", auto: true },
          "context",
        ),
        { type: "turn_context", payload: { cwd: "/r/sub" } },
        responded("o5", "2026-10-15T00:00:04Z", "t2"),
        mcp("o6", "2026-10-15T00:00:05Z", "record", "trace_pending", { auto: true }, "nothing waits"),
      ]),
    );
    const pop = await extract(db.reader, KEY, WINDOW, readLogs(dirs), "/r");
    assert.deepEqual(
      pop.spans.map((s) => [s.file, s.call]),
      [
        ["main.jsonl", "p1"],
        [path.join("2026", "10", "14", "rollout-a.jsonl"), "e1"],
        ["other.jsonl", "o6"],
      ],
    );
    assert.deepEqual(
      pop.unmatched.map((u) => u.draft),
      ["wrongId"],
    );
  } finally {
    await db.done();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test("a new baseline is extracted from the frozen copy, so a write to the live database meanwhile cannot make the two disagree", async () => {
  const db = tempDb();
  const dirs = logsDir();
  try {
    writeLogs(dirs);
    const f = fixture(db);
    const frozen = path.join(dirs.root, "frozen");
    const out = path.join(dirs.root, "baseline.json");
    const values = {
      db: db.file,
      claude: dirs.claude,
      codex: dirs.codex,
      project: KEY,
      root: "/r",
      from: WINDOW.from,
      to: WINDOW.to,
      repo: repoAt(dirs.root),
      frozen,
      out,
    };
    await pin(values, () => db.owner.prepare("delete from unit where id = ?").run(f.a1));
    const pinned = JSON.parse(fs.readFileSync(out, "utf8")).population;
    const snapshot = openReader(path.join(frozen, "sphica.db"));
    try {
      const again = await extract(snapshot, KEY, WINDOW, readLogs(dirs), "/r");
      assert.deepEqual(pinned.runs, again.runs);
    } finally {
      await snapshot.destroy();
    }
  } finally {
    await db.done();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

/** Run A with six records; the owner adopted u1 and u2, an AI u5, and a later run of another trace adopted u1 again */
function adopted(db: TempDb) {
  const p = project(db);
  session(db, p, "s1");
  // An AI's adoption needs a run an interactive session began, still running when it writes
  const call = insert(db, "record_call", {
    project_id: p,
    tool: "trace_begin",
    host: "codex",
    caller_session: "main",
    caller_turn: "turn-begin",
    mode: "interactive",
    called_at: at("2026-10-05T00:00:00Z"),
  });
  const a = insert(db, "extraction_run", {
    project_id: p,
    origin: "trace",
    target: "session:s1",
    session_id: "s1",
    status: "running",
    draft_id: "draftA",
    begin_call_id: call,
    started_at: at("2026-10-05T00:00:00Z"),
  });
  const later = run(db, p);
  const units = [1, 2, 3, 4, 5, 6].map((i) => unit(db, p, a, `u${i}`, `2026-10-05T00:00:0${i}Z`, "decision"));
  const prompt = message(db, p, {
    id: "m1",
    text: "前置き。SQLite にしよう、Postgres は要らない",
    sent: "2026-10-05T00:00:00Z",
  });
  // The proposal the owner answers, for the sheet's message before it
  message(db, p, {
    id: "m0",
    text: "SQLite か Postgres のどちらにしますか",
    speaker: "assistant",
    sent: "2026-10-04T23:59:00Z",
  });
  const reply = insert(db, "source", {
    project_id: p,
    kind: "session_message",
    artifact: "session:s1",
    external_id: "m2",
    revision: 1,
    session_id: "s1",
    turn_id: "turn-2",
    author_kind: "assistant",
    created_at: at("2026-10-05T00:01:00Z"),
    captured_at: at("2026-10-05T00:01:00Z"),
    text: "I'll keep the retry in the client.",
    original_bytes: Buffer.byteLength("I'll keep the retry in the client."),
    content_hash: hash(9),
    indexed: 0,
  });
  const span = (text: string, part: string) => {
    const start = Buffer.from(text).indexOf(Buffer.from(part));
    return { span_start: start, span_end: start + Buffer.byteLength(part) };
  };
  const adopt = (
    u: number,
    route: string,
    source: number,
    sp: { span_start: number; span_end: number },
    by = a,
  ) =>
    insert(db, "unit_adoption", {
      unit_id: u,
      route,
      source_id: source,
      ...sp,
      run_id: by,
      added_at: at("2026-10-05T00:02:00Z"),
    });
  const evidence = (u: number, source: number, sp: { span_start: number; span_end: number }, role: string) =>
    insert(db, "unit_evidence", {
      unit_id: u,
      source_id: source,
      ...sp,
      role,
      run_id: a,
      added_at: at("2026-10-05T00:02:00Z"),
    });
  const sqlite = span("前置き。SQLite にしよう、Postgres は要らない", "SQLite にしよう");
  const retry = span("I'll keep the retry in the client.", "keep the retry in the client");
  evidence(units[0] as number, prompt, sqlite, "states");
  evidence(units[4] as number, reply, retry, "decides");
  const ownerRows = [
    adopt(units[0] as number, "owner_statement", prompt, sqlite),
    adopt(units[1] as number, "owner_statement", prompt, sqlite),
  ];
  const agentRow = adopt(units[4] as number, "agent", reply, retry);
  adopt(
    units[0] as number,
    "explicit",
    prompt,
    span("前置き。SQLite にしよう、Postgres は要らない", "Postgres は要らない"),
    later,
  );
  const population = spanPopulation([], [[a, "draftA", units]]);
  return { p, a, units, ownerRows, agentRow, population };
}

test("the sample is fixed by the seed, AI decisions it missed are an extra set, and only the automatic runs' adoptions are audited", async () => {
  const db = tempDb();
  try {
    const f = adopted(db);
    const first = await draw(db.reader, f.population, 20261018, 3);
    const again = await draw(db.reader, f.population, 20261018, 3);
    assert.deepEqual(first, again);
    assert.equal(first.sample.length, 3);
    assert.deepEqual(
      first.sample.map((d) => d.n),
      [1, 2, 3],
    );
    const sampled = new Set(first.sample.map((d) => d.unit));
    assert.deepEqual(
      first.extra.map((d) => [d.unit, d.agent, d.n]),
      sampled.has(f.units[4] as number) ? [] : [[f.units[4], true, 4]],
    );
    assert.deepEqual(
      first.audit.map((r) => [r.adoption, r.route]),
      [
        [f.ownerRows[0], "owner_statement"],
        [f.ownerRows[1], "owner_statement"],
        [f.agentRow, "agent"],
      ],
    );
    const all = await draw(db.reader, f.population, 20261018, 6);
    assert.deepEqual(
      all.sample.map((d) => d.unit).sort((x, y) => x - y),
      [...f.units].sort((x, y) => x - y),
    );
    assert.deepEqual(all.extra, []);
    assert.notDeepEqual(
      (await draw(db.reader, f.population, 1, 6)).sample.map((d) => d.unit),
      all.sample.map((d) => d.unit),
    );
  } finally {
    await db.done();
  }
});

test("the sheet quotes evidence and adoptions by their byte spans, with the words around an adoption and the message before it", async () => {
  const db = tempDb();
  try {
    const f = adopted(db);
    const drawn = await draw(db.reader, f.population, 20261018, 6);
    const text = await sheet(db.reader, f.population, drawn);
    assert.match(text, /- evidence states s\d+ \(owner\):\n {4}> SQLite にしよう\n/);
    assert.match(text, /- adoption agent s\d+ \(assistant\):\n {4}> keep the retry in the client\n/);
    assert.match(text, /> 前置き。\[\[SQLite にしよう\]\]、Postgres は要らない/);
    assert.match(
      text,
      /- message before it, s\d+ \(assistant\):\n {4}> SQLite か Postgres のどちらにしますか/,
    );
    assert.equal(text.match(/^## A\d+ /gm)?.length, 3);
    assert.equal(text.match(/^## S\d+ /gm)?.length, 6);
  } finally {
    await db.done();
  }
});

test("the script draws once into the baseline, refuses another seed after that, and writes the sheet", async () => {
  const db = tempDb();
  const dirs = logsDir();
  try {
    writeLogs(dirs);
    fixture(db);
    const repo = repoAt(dirs.root);
    const frozen = path.join(dirs.root, "frozen");
    const out = path.join(dirs.root, "baseline.json");
    const sheetFile = path.join(dirs.root, "sheet.md");
    const freeze = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "--freeze",
        ...[
          "--db",
          db.file,
          "--claude",
          dirs.claude,
          "--codex",
          dirs.codex,
          "--project",
          KEY,
          "--root",
          "/r",
        ],
        ...["--from", WINDOW.from, "--to", WINDOW.to, "--repo", repo, "--frozen", frozen, "--out", out],
      ],
      { encoding: "utf8" },
    );
    assert.equal(freeze.status, 0, freeze.stderr);
    const sample = (seed: string) =>
      spawnSync(
        process.execPath,
        [
          SCRIPT,
          "--sample",
          "--baseline",
          out,
          "--frozen",
          frozen,
          "--seed",
          seed,
          "--size",
          "1",
          "--sheet",
          sheetFile,
        ],
        { encoding: "utf8" },
      );
    const first = sample("20261018");
    assert.equal(first.status, 0, first.stderr);
    const baseline = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(baseline.sample.length, 1);
    assert.equal(baseline.sampling.seed, 20261018);
    assert.match(fs.readFileSync(sheetFile, "utf8"), /^## S1 u\d+ a[12]$/m);
    assert.equal(sample("20261018").status, 0);
    const other = sample("7");
    assert.notEqual(other.status, 0);
    assert.match(other.stderr, /already holds another sample/);
    const bad = sample("x");
    assert.match(bad.stderr, /--seed x is not a whole number/);
    const missing = spawnSync(process.execPath, [SCRIPT, "--sample", "--baseline", out], {
      encoding: "utf8",
    });
    assert.match(missing.stderr, /--sample needs --frozen, --seed, --size, --sheet/);
  } finally {
    await db.done();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test("a span ends at the last line of its closing response, and responses from the window's end on are cut off", () => {
  const dirs = logsDir();
  try {
    spanLog(dirs.claude);
    const lines = fs.readFileSync(path.join(dirs.claude, "span.jsonl"), "utf8").trimEnd().split("\n");
    // The closing response m10 (line 21) goes on in a second line written 30 seconds later
    lines.splice(21, 0, JSON.stringify(spent("m10", "2026-10-05T00:00:49Z", 512)));
    fs.writeFileSync(path.join(dirs.claude, "span.jsonl"), `${lines.join("\n")}\n`);
    const log = readClaude(dirs.claude, "span.jsonl");
    const runs: [number, string, number[]][] = [
      [1, "dA", []],
      [2, "dB", [7]],
    ];
    const whole = attribute(spanPopulation([{ file: "span.jsonl", line: 2, call: "p" }], runs), [log]);
    assert.equal(whole.spans[0]?.to, at("2026-10-05T00:00:49Z"));
    const early = {
      ...spanPopulation([{ file: "span.jsonl", line: 2, call: "p" }], runs),
      window: { from: WINDOW.from, to: at(t(13)) },
    };
    const cut = attribute(early, [log]);
    assert.deepEqual(
      cut.responses.map((r) => r.key),
      ["m1", "m2", "m3", "m4", "m5", "m6"],
    );
    assert.equal(cut.spans[0]?.truncated, true);
    assert.equal(cut.spans[0]?.to, at(t(12)));
    assert.deepEqual(
      cut.responses.filter((r) => r.lower).map((r) => r.key),
      [],
      "a run cut off by the window is not known empty",
    );
    // The closing response m10 starts inside the window and its last line comes after the window's end
    const straddle = attribute({ ...early, window: { from: WINDOW.from, to: at("2026-10-05T00:00:30Z") } }, [
      log,
    ]);
    assert.equal(straddle.responses.at(-1)?.key, "m10");
    assert.equal(straddle.spans[0]?.truncated, true);
    assert.equal(straddle.spans[0]?.to, at("2026-10-05T00:00:30Z"));
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

type Rec = Labels["sample"][number];
const label = (correctness: string, value: string) => ({ correctness, value, reason: "r" }) as Rec["settled"];

/** size drawn records, labelled by the [correctness, value] pairs given and then correct and not-needed */
function labelled(size: number, pairs: [string, string][], audit: [string, string][] = []) {
  const sample = Array.from({ length: size }, (_, i) => ({
    n: i + 1,
    unit: 100 + i,
    key: `k${i}`,
    kind: "decision",
    agent: false,
  }));
  const rows = audit.map(([route], i) => ({ n: i + 1, adoption: 500 + i, unit: 100, route, source: 1 }));
  const settled = (i: number) => label(...(pairs[i] ?? ["correct", "not-needed"]));
  const labels: Labels = {
    sample: sample.map((d, i) => ({
      n: d.n,
      unit: d.unit,
      claude: settled(i),
      codex: settled(i),
      owner: null,
      settled: settled(i),
    })),
    extra: [],
    audit: rows.map((r, i) => {
      const v = { verdict: audit[i]?.[1], reason: "r" } as Labels["audit"][number]["settled"];
      return { n: r.n, adoption: r.adoption, claude: v, codex: v, owner: null, settled: v };
    }),
    owner_work: [],
  };
  const population = spanPopulation([], [[1, "dA", sample.map((d) => d.unit)]]);
  return { drawn: { sample, extra: [], audit: rows }, labels, population };
}

const hostsAt = (low: number | null, high: number | null, gaps = 0) => {
  const share = {
    total: 10,
    empty_low: 0,
    empty_high: 0,
    share_low: low,
    share_high: high,
    gaps,
    gaps_low: 0,
    gaps_high: 0,
  };
  return { "claude-code": { responses: 10, output: share, all: share, models: {} } };
};

test("the useful bar counts confirmed and possible records apart, so unknowns fall on both sides of 28 in 40", () => {
  const many = (n: number, pair: [string, string]) => Array.from({ length: n }, () => pair);
  const bar = (pairs: [string, string][]) => {
    const f = labelled(40, pairs);
    return decide(f.labels, f.drawn, f.population, hostsAt(0.1, 0.2)).useful;
  };
  assert.deepEqual(bar(many(28, ["correct", "useful"])), {
    size: 40,
    need: 28,
    confirmed: 28,
    possible: 28,
    bar: "pass",
  });
  assert.equal(bar(many(27, ["correct", "useful"])).bar, "fail");
  assert.deepEqual(bar([...many(27, ["correct", "useful"]), ["unknown", "useful"]]), {
    size: 40,
    need: 28,
    confirmed: 27,
    possible: 28,
    bar: "undecided",
  });
  assert.equal(bar([...many(27, ["correct", "useful"]), ["correct", "unknown"]]).bar, "undecided");
  assert.equal(
    bar([...many(27, ["correct", "useful"]), ["wrong", "useful"]]).bar,
    "fail",
    "a wrong record is never useful",
  );
  assert.equal(bar([...many(27, ["correct", "useful"]), ["unknown", "not-needed"]]).bar, "fail");
});

test("one misattributed owner adoption fails its bar, an unknown one leaves it to the owner, and AI adoptions are only counted", () => {
  const bar = (audit: [string, string][]) => {
    const f = labelled(40, [], audit);
    return decide(f.labels, f.drawn, f.population, hostsAt(0.1, 0.2)).adoption;
  };
  assert.equal(bar([["owner_statement", "correct"]]).bar, "pass");
  assert.equal(bar([["owner_statement", "unknown"]]).bar, "undecided");
  assert.equal(
    bar([
      ["owner_statement", "unknown"],
      ["explicit", "misattributed"],
    ]).bar,
    "fail",
  );
  assert.deepEqual(
    bar([
      ["owner_statement", "correct"],
      ["agent", "misattributed"],
      ["agent", "unknown"],
    ]),
    {
      owner_rows: 1,
      misattributed: 0,
      unknown: 0,
      bar: "pass",
      agent: { audited: 2, misattributed: 1, unknown: 1 },
    },
  );
});

test("the empty-run bar needs both proxies at both bounds on one side of 0.3, exactly 0.3 does not exceed it, and a gap leaves it open", () => {
  const f = labelled(
    40,
    Array.from({ length: 28 }, () => ["correct", "useful"] as [string, string]),
  );
  const bar = (h: ReturnType<typeof hostsAt>) => decide(f.labels, f.drawn, f.population, h);
  assert.equal(bar(hostsAt(0.31, 0.5)).empty.bar, "experiment");
  assert.equal(bar(hostsAt(0.1, 0.3)).empty.bar, "no experiment");
  assert.equal(bar(hostsAt(0.2, 0.4)).empty.bar, "undecided");
  assert.equal(bar(hostsAt(0.1, 0.2, 1)).empty.bar, "undecided");
  assert.equal(bar(hostsAt(null, null)).empty.bar, "undecided");
  assert.deepEqual(bar(hostsAt(0.1, 0.2)).actions, ["keep the automatic trace as it is"]);
  const g = labelled(40, [], [["owner_statement", "misattributed"]]);
  assert.deepEqual(decide(g.labels, g.drawn, g.population, hostsAt(0.4, 0.5)).actions, [
    "plan a fix of what the automatic trace extracts",
    "file an issue for the misattributed owner adoptions",
    "plan #259's stage-1 mechanical filter experiment",
  ]);
  assert.deepEqual(decide(f.labels, f.drawn, f.population, hostsAt(0.2, 0.4)).actions, [
    "the owner decides the empty-run token share",
  ]);
});

test("labels are refused when they sit on other rows than drawn or use words outside the vocabulary", () => {
  const f = labelled(3, []);
  checkLabels(f.labels, f.drawn);
  const swapped = structuredClone(f.labels);
  (swapped.sample[0] as Rec).unit = 999;
  assert.throws(() => checkLabels(swapped, f.drawn), /sample 1: not the row drawn there/);
  const word = structuredClone(f.labels);
  (word.sample[1] as Rec).codex = label("maybe", "useful");
  assert.throws(() => checkLabels(word, f.drawn), /sample 2 codex: a record label needs correctness/);
  const reasonless = structuredClone(f.labels);
  (reasonless.sample[2] as Rec).owner = { correctness: "correct", value: "useful", reason: " " };
  assert.throws(() => checkLabels(reasonless, f.drawn), /sample 3 owner/);
  assert.throws(
    () => checkLabels({ ...f.labels, sample: f.labels.sample.slice(1) }, f.drawn),
    /sample: 2 labelled, 3 drawn/,
  );
});

test("the script takes the labels once, then gives the same result again from the frozen inputs, and refuses a result they do not give", async () => {
  const db = tempDb();
  const dirs = logsDir();
  try {
    writeLogs(dirs);
    fixture(db);
    const repo = repoAt(dirs.root);
    const frozen = path.join(dirs.root, "frozen");
    const out = path.join(dirs.root, "baseline.json");
    const run = (...a: string[]) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: "utf8" });
    const freeze = run(
      "--freeze",
      ...["--db", db.file, "--claude", dirs.claude, "--codex", dirs.codex, "--project", KEY, "--root", "/r"],
      ...["--from", WINDOW.from, "--to", WINDOW.to, "--repo", repo, "--frozen", frozen, "--out", out],
    );
    assert.equal(freeze.status, 0, freeze.stderr);
    const sheetFile = path.join(dirs.root, "sheet.md");
    const sampled = run(
      "--sample",
      "--baseline",
      out,
      "--frozen",
      frozen,
      "--seed",
      "1",
      "--size",
      "2",
      "--sheet",
      sheetFile,
    );
    assert.equal(sampled.status, 0, sampled.stderr);
    const drawn = JSON.parse(fs.readFileSync(out, "utf8"));
    const l = label("correct", "useful");
    const labels: Labels = {
      sample: drawn.sample.map((d: { n: number; unit: number }) => ({
        n: d.n,
        unit: d.unit,
        claude: l,
        codex: l,
        owner: l,
        settled: l,
      })),
      extra: [],
      audit: [],
      owner_work: [],
    };
    const labelsFile = path.join(dirs.root, "labels.json");
    fs.writeFileSync(labelsFile, JSON.stringify(labels));
    const first = run("--decide", "--baseline", out, "--frozen", frozen, "--labels", labelsFile);
    assert.equal(first.status, 0, first.stderr);
    const decided = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(decided.result.useful.bar, "undecided", "a sample of 2 is not the 40 the bar was fixed for");
    assert.equal(
      decided.result.empty.bar,
      "undecided",
      "the fixture logs carry no usage, so every response is a gap",
    );
    const again = run("--decide", "--baseline", out, "--frozen", frozen);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /give the baseline's result again/);
    assert.match(
      run("--decide", "--baseline", out, "--frozen", frozen, "--labels", labelsFile).stderr,
      /already holds labels/,
    );
    fs.writeFileSync(out, JSON.stringify({ ...decided, result: { ...decided.result, actions: [] } }));
    const tampered = run("--decide", "--baseline", out, "--frozen", frozen);
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /no longer give the baseline's result/);
    assert.match(run("--decide", "--baseline", out).stderr, /--decide needs --frozen/);
  } finally {
    await db.done();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test("the useful bar is judged only on the 40 records fixed in the plan, and the runs it leaves undetermined are counted", () => {
  const ten = labelled(
    10,
    Array.from({ length: 7 }, () => ["correct", "useful"] as [string, string]),
  );
  assert.equal(decide(ten.labels, ten.drawn, ten.population, hostsAt(0.1, 0.2)).useful.bar, "undecided");
  const f = labelled(
    40,
    Array.from({ length: 28 }, () => ["correct", "useful"] as [string, string]),
  );
  const population = spanPopulation(
    [],
    [
      [1, "dA", f.drawn.sample.slice(0, 20).map((d) => d.unit)],
      [2, "dB", f.drawn.sample.slice(20).map((d) => d.unit)],
      [3, "dC", [999]],
      [4, "dD", []],
    ],
  );
  assert.deepEqual(decide(f.labels, f.drawn, population, hostsAt(0.1, 0.2)).runs, {
    total: 4,
    saved: 3,
    confirmed_useful: 2,
    sampled: 2,
    undetermined: 1,
  });
});
