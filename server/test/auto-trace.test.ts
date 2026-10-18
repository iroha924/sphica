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
  differences,
  extract,
  type Population,
  readClaude,
  readCodex,
  readLogs,
  shares,
  times,
} from "../evals/trace/auto-trace.ts";
import { at, hash, insert, project, session, type TempDb, tempDb } from "./temp-db.ts";

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

function unit(db: TempDb, p: number, run: number, key: string, created: string): number {
  return insert(db, "unit", {
    project_id: p,
    key,
    kind: "finding",
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
    const pop = await extract(db.reader, KEY, WINDOW, logs);
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
        ["codex", 4, "e1"],
      ],
    );
    const narrow = await extract(db.reader, KEY, { from: WINDOW.from, to: at("2026-10-10T00:00:00Z") }, logs);
    assert.deepEqual(
      narrow.runs.map((r) => r.draft),
      ["draftA"],
    );
    assert.equal(narrow.spans.length, 1);
    await assert.rejects(
      extract(db.reader, "git:github.com/o/none", WINDOW, logs),
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
    const pinned = await extract(db.reader, KEY, WINDOW, logs);
    assert.deepEqual(differences(pinned, pinned), []);
    const fewer = await extract(db.reader, KEY, WINDOW, logs.slice(1));
    assert.deepEqual(differences(pinned, fewer), [
      `1 pinned runs are no longer there, first ${f.a}`,
      "unmatched run ids differ: 1 pinned, 0 now",
      "automatic trace spans differ: 2 pinned, 1 now",
    ]);
    db.owner.prepare("delete from unit where id = ?").run(f.a2);
    assert.deepEqual(differences(pinned, await extract(db.reader, KEY, WINDOW, logs)), [
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
      ...["--db", db.file, "--claude", dirs.claude, "--codex", dirs.codex, "--project", KEY],
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
      /--freeze needs --claude, --codex, --project, --from, --to, --repo, --frozen, --out/,
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
