// The post_write entry check replays past writes from transcripts against real records and a real delivery log: which writes count, which
// records a conversation was already shown, and how the labelling sample is drawn.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  type Pair,
  placeOf,
  readTranscripts,
  replay,
  sample,
  writtenText,
} from "../evals/post-write/replay.ts";
import { inTransaction } from "../src/db.ts";
import { sessionId } from "../src/knowledge.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { openRun } from "../src/trace.ts";
import { insert, message, project, type TempDb, tempDb } from "./temp-db.ts";

function checkout(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-replay-")));
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/o/r.git"], {
    stdio: "ignore",
  });
  return dir;
}

async function save(db: TempDb, p: number, record: unknown) {
  const t: Target = {
    projectId: p,
    origin: "trace",
    prefix: "trace:ext-s1/",
    sessionId: "s1",
    root: null,
    sources: null,
  };
  return inTransaction(db.ingest, async (trx) => {
    const run = await openRun(trx, {
      projectId: p,
      origin: "trace",
      target: "session:s1",
      sessionId: "s1",
      draftId: `d${Math.random()}`,
    });
    return saveRecord(trx, t, run, await checkRecord(trx, t, record), []);
  });
}

const decided = (key: string, source: number, quote: string, extra: Record<string, unknown> = {}) => ({
  key,
  kind: "constraint",
  stance: "do",
  text: quote,
  evidence: [{ source: `s${source}`, quote, role: "states" }],
  adoption: [{ source: `s${source}`, quote }],
  ...extra,
});

const call = (
  id: string,
  at: string,
  cwd: string,
  name: string,
  input: Record<string, unknown>,
  agent?: string,
) =>
  JSON.stringify({
    type: "assistant",
    sessionId: "ext-a",
    ...(agent ? { agentId: agent } : {}),
    timestamp: at,
    cwd,
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
const result = (id: string, error = false) =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: error }] },
  });

test("the replay counts what a write names, less what the conversation was shown since its last restart", async () => {
  const db = tempDb();
  const repo = checkout();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-replay-logs-"));
  try {
    const p = project(db);
    const m = message(db, p, {
      id: "m1",
      text: "Store every timestamp in UTC. No telemetry. Keep open() small.",
    });
    await save(db, p, {
      units: [
        decided("utc", m, "Store every timestamp in UTC.", {
          anchors: [{ path: "src/dates.ts", symbol: "toStored", role: "applies_to" }],
        }),
        decided("no-telemetry", m, "No telemetry.", {
          stance: "dont",
          options: [{ text: "telemetry", outcome: "rejected" }],
        }),
        decided("opener", m, "Keep open() small.", {
          anchors: [{ path: "src/open.ts", symbol: "open", role: "applies_to" }],
        }),
      ],
    });
    const unit = (key: string) =>
      Number(db.owner.prepare("select id from unit where key = ?").get(`trace:ext-s1/${key}`)?.id);
    const sid = sessionId(p, "claude-code", "ext-a");
    insert(db, "session", {
      id: sid,
      project_id: p,
      host: "claude-code",
      external_id: "ext-a",
      started_at: "2026-10-01T00:00:00.000Z",
    });
    const delivered = (at: string, event: string, reason: string | null, units: number[]) => {
      const d = insert(db, "delivery", { session_id: sid, event, outcome: "emitted", reason, at });
      for (const u of units) insert(db, "delivery_unit", { delivery_id: d, unit_id: u });
    };
    delivered("2026-10-01T00:00:10.000Z", "pre_edit", null, [unit("opener")]);
    delivered("2026-10-01T00:00:30.000Z", "session_start", "compact", []);

    const main = [
      call("w1", "2026-10-01T00:00:01.000Z", repo, "Write", {
        file_path: path.join(repo, "docs/plan.md"),
        content: "toStored を地域の時刻にする。telemetry も足す。",
      }),
      result("w1"),
      call("w2", "2026-10-01T00:00:02.000Z", repo, "Edit", {
        file_path: "src/x.ts",
        old_string: "telemetry",
        new_string: "toStored(d)",
      }),
      result("w2"),
      call("w3", "2026-10-01T00:00:03.000Z", repo, "Edit", {
        file_path: "src/y.ts",
        old_string: "a",
        new_string: "open()",
      }),
      result("w3", true),
      "{not json",
      call("w4", "2026-10-01T00:00:20.000Z", repo, "MultiEdit", {
        file_path: "src/z.ts",
        edits: [
          { old_string: "a", new_string: "open()" },
          { old_string: "b", new_string: "c" },
        ],
      }),
      result("w4"),
      call("w5", "2026-10-01T00:00:40.000Z", repo, "Edit", {
        file_path: "src/x.ts",
        old_string: "a",
        new_string: "toStored()",
      }),
      result("w5"),
      call("w6", "2026-10-01T00:00:41.000Z", repo, "Write", {
        file_path: "/etc/elsewhere.ts",
        content: "toStored()",
      }),
      result("w6"),
      call("w7", "2026-10-01T00:00:42.000Z", repo, "NotebookEdit", {
        notebook_path: "n.ipynb",
        new_source: "telemetry",
        edit_mode: "delete",
      }),
      result("w7"),
    ];
    const sub = [
      call(
        "s1",
        "2026-10-01T00:00:05.000Z",
        repo,
        "Edit",
        { file_path: "src/x.ts", old_string: "a", new_string: "toStored()" },
        "ag1",
      ),
      result("s1"),
    ];
    fs.writeFileSync(path.join(dir, "a.jsonl"), `${main.join("\n")}\n`);
    fs.mkdirSync(path.join(dir, "a", "subagents"), { recursive: true });
    fs.writeFileSync(path.join(dir, "a", "subagents", "agent-ag1.jsonl"), `${sub.join("\n")}\n`);

    const { writes, inputs } = readTranscripts([
      path.join(dir, "a.jsonl"),
      path.join(dir, "a", "subagents", "agent-ag1.jsonl"),
    ]);
    assert.deepEqual(
      writes.map((w) => w.toolUseId),
      ["w1", "w2", "s1", "w4", "w5", "w6"],
      "the failed edit and the deleted notebook cell are not writes",
    );
    assert.equal(inputs.failed, 1);
    assert.equal(inputs.unreadable, 1);
    const r = await replay(db.file, writes, inputs);
    assert.equal(r.inputs.outside, 1, "a file outside the project is counted, not matched");
    assert.deepEqual(
      r.pairs.map((x) => [x.toolUseId, x.key.replace("trace:ext-s1/", ""), x.hit, x.document]),
      [
        ["w1", "utc", "symbol", true],
        ["w1", "no-telemetry", "option", true],
        // w2: utc was just delivered by the replay itself, and old_string never counts
        ["s1", "utc", "symbol", false],
        // w4: opener was emitted by the hook before the compaction; w5: after it, utc counts again
        ["w5", "utc", "symbol", false],
      ],
    );
    assert.deepEqual(
      r.sessions.map((s) => [s.agent, s.writes, s.fires]),
      [
        [null, 4, 2],
        ["ag1", 1, 1],
      ],
    );
  } finally {
    await db.done();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a write from a removed worktree belongs to its checkout's project, with paths from the worktree's root", () => {
  const repo = checkout();
  try {
    const gone = path.join(repo, ".claude", "worktrees", "f1");
    assert.deepEqual(placeOf(path.join(gone, "server")), { key: "git:github.com/o/r", root: gone });
    assert.equal(
      placeOf(path.join(repo, "elsewhere", "missing")),
      null,
      "any other missing directory is outside",
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a write counts from its result, so what its own pre-edit delivery showed is left out, and a delivery shows only what fits", async () => {
  const db = tempDb();
  const repo = checkout();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-replay-logs-"));
  try {
    const p = project(db);
    const long = "Keep this part of the system exactly as it is, because the reason is long. ".repeat(4);
    const m = message(db, p, { id: "m1", text: `Shown before. ${long}` });
    const slug = (s: string) => `${s}-a-rather-long-record-slug-like-the-real-ones-have`;
    await save(db, p, {
      units: [
        decided("pre", m, "Shown before.", {
          anchors: [{ path: "src/pre.ts", symbol: "preSymbol", role: "applies_to" }],
        }),
        ...["first", "second", "third"].map((s) =>
          decided(slug(s), m, long.trim(), {
            anchors: [{ path: `src/${s}.ts`, symbol: `${s}LongSymbolName`, role: "applies_to" }],
          }),
        ),
      ],
    });
    const sid = sessionId(p, "claude-code", "ext-a");
    insert(db, "session", {
      id: sid,
      project_id: p,
      host: "claude-code",
      external_id: "ext-a",
      started_at: "2026-10-01T00:00:00.000Z",
    });
    const pre = Number(db.owner.prepare("select id from unit where key = ?").get("trace:ext-s1/pre")?.id);
    const d = insert(db, "delivery", {
      session_id: sid,
      event: "pre_edit",
      outcome: "emitted",
      at: "2026-10-01T00:00:00.500Z",
    });
    insert(db, "delivery_unit", { delivery_id: d, unit_id: pre });
    const lines = [
      "null",
      JSON.stringify({ type: "user", message: { content: [null] } }),
      // The call's own time has no fraction; its pre-edit delivery came before the tool returned
      call("w1", "2026-10-01T00:00:00Z", repo, "Write", {
        file_path: path.join(repo, "docs/plan.md"),
        content: "preSymbol firstLongSymbolName secondLongSymbolName thirdLongSymbolName",
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-10-01T00:00:01Z",
        message: { content: [{ type: "tool_result", tool_use_id: "w1", is_error: false }] },
      }),
    ];
    fs.writeFileSync(path.join(dir, "a.jsonl"), `${lines.join("\n")}\n`);
    const { writes, inputs } = readTranscripts([path.join(dir, "a.jsonl")]);
    assert.equal(
      inputs.unreadable,
      2,
      "a line that parses but holds no record is unreadable, and the rest still replays",
    );
    assert.equal(
      writes[0]?.at,
      "2026-10-01T00:00:01.000Z",
      "a write's time is its result's, in the database's form",
    );
    const r = await replay(db.file, writes, inputs);
    assert.deepEqual(
      r.pairs.map((x) => [x.key.replace(/^trace:ext-s1\/|-a-rather.*$/g, ""), x.shown]),
      [
        ["first", true],
        ["second", true],
        ["third", false],
      ],
      "the record its own pre-edit delivery showed is left out, and the third line does not fit in 900 characters",
    );
  } finally {
    await db.done();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the text of a write is what it put in the file", () => {
  assert.equal(writtenText("Edit", { old_string: "a", new_string: "b" }), "b");
  assert.equal(writtenText("Write", { content: "c" }), "c");
  assert.equal(writtenText("MultiEdit", { edits: [{ new_string: "x" }, { new_string: "y" }] }), "x\ny");
  assert.equal(writtenText("NotebookEdit", { new_source: "n", edit_mode: "insert" }), "n");
  assert.equal(writtenText("NotebookEdit", { new_source: "n", edit_mode: "delete" }), null);
  assert.equal(writtenText("Read", {}), null);
});

test("the labelling sample is fixed by its seed and split between documents and code", () => {
  const pair = (i: number, document: boolean, shown = true): Pair => ({
    session: "s",
    agent: null,
    toolUseId: `t${i}`,
    at: "",
    path: document ? "docs/a.md" : "src/a.ts",
    document,
    key: `k${i}`,
    hit: "symbol",
    why: "",
    shown,
  });
  const pairs = [
    ...Array.from({ length: 30 }, (_, i) => pair(i, true)),
    ...Array.from({ length: 5 }, (_, i) => pair(100 + i, false)),
    pair(200, false, false),
  ];
  const a = sample(pairs, 7, 20);
  assert.deepEqual(a, sample(pairs, 7, 20), "the same seed draws the same sample");
  assert.notDeepEqual(
    a.map((x) => x.key),
    sample(pairs, 8, 20).map((x) => x.key),
  );
  assert.equal(a.length, 20);
  assert.equal(
    a.filter((x) => !x.document).length,
    5,
    "a short stratum is taken whole and the rest come from the other",
  );
  assert.ok(!a.some((x) => x.key === "k200"), "only pairs a delivery would show are sampled");
});
