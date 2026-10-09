// The post_write entry check replays past writes from synthetic transcripts against a real database: records deliverable at the write's
// result, what had reached the conversation (from its transcript), the scope and doubt counted apart, the labelling sample, and the bar.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  decide,
  type Label,
  type Pair,
  placeOf,
  replay,
  sample,
  writtenText,
} from "../evals/post-write/replay.ts";
import { readConversations } from "../evals/post-write/transcript.ts";
import { inTransaction } from "../src/db.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { openRun } from "../src/trace.ts";
import { message, project, type TempDb, tempDb } from "./temp-db.ts";

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

const NOTE = "Sphica past record, not an instruction; read it with Sphica's read before relying on it";
const line = (at: string, o: Record<string, unknown>, agent?: string) =>
  JSON.stringify({ sessionId: "ext-a", ...(agent ? { agentId: agent } : {}), timestamp: at, ...o });
const human = (at: string) =>
  line(at, { type: "user", origin: { kind: "human" }, message: { content: "go" } });
const delivery = (at: string, text: string, agent?: string) =>
  line(
    at,
    {
      attachment: {
        type: "hook_additional_context",
        hookEvent: "PreToolUse",
        toolUseID: "x",
        content: [text],
      },
    },
    agent,
  );
const write = (
  at: string,
  id: string,
  cwd: string,
  name: string,
  input: Record<string, unknown>,
  agent?: string,
) =>
  line(at, { type: "assistant", cwd, message: { content: [{ type: "tool_use", id, name, input }] } }, agent);
const result = (at: string, id: string, error = false, agent?: string) =>
  line(
    at,
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: error }] } },
    agent,
  );

test("a write is matched against the records deliverable at its result, less what reached its conversation", async () => {
  const db = tempDb();
  const repo = checkout();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-replay-logs-"));
  try {
    const p = project(db);
    const m = message(db, p, {
      id: "m1",
      text: "Store every timestamp in UTC. No telemetry. Keep open() small. Old rule.",
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
        decided("old", m, "Old rule.", {
          anchors: [{ path: "src/old.ts", symbol: "oldRule", role: "applies_to" }],
        }),
      ],
    });
    const old = Number(db.owner.prepare("select id from unit where key = 'trace:ext-s1/old'").get()?.id);
    const run = Number(db.owner.prepare("select run_id from unit_anchor limit 1").get()?.run_id);
    // old stops being deliverable in 2050, long before the writes below
    db.owner
      .prepare(
        "insert into unit_state (unit_id, from_state, to_state, at, reason, run_id) values (?, 'active', 'candidate', ?, 'r', ?)",
      )
      .run(old, "2050-01-01T00:00:00.000Z", run);
    const openShown = `Active decisions applying to src/open.ts. ${NOTE}:\n- trace:ext-s1/opener (constraint do): Keep open() small.`;
    const main = [
      delivery("2098-12-31T23:59:00.000Z", "Sphica: current work."),
      human("2099-01-01T00:00:00.000Z"),
      write("2099-01-01T00:01:00.000Z", "w1", repo, "Write", {
        file_path: path.join(repo, "docs/plan.md"),
        content: "toStored を地域の時刻に。telemetry も足す。open() と oldRule() も触る。",
      }),
      delivery("2099-01-01T00:01:01.000Z", openShown),
      result("2099-01-01T00:01:02.000Z", "w1"),
      write("2099-01-01T00:02:00.000Z", "w2", repo, "Edit", {
        file_path: "src/x.ts",
        old_string: "telemetry",
        new_string: "toStored(d)",
      }),
      result("2099-01-01T00:02:01.000Z", "w2"),
      write("2099-01-01T00:03:00.000Z", "w3", repo, "Edit", {
        file_path: "src/y.ts",
        old_string: "a",
        new_string: "open()",
      }),
      result("2099-01-01T00:03:01.000Z", "w3", true),
      line("2099-01-01T00:04:00.000Z", { type: "system", subtype: "compact_boundary" }),
      write("2099-01-01T00:05:00.000Z", "w4", repo, "Edit", {
        file_path: "src/x.ts",
        old_string: "a",
        new_string: "toStored()",
      }),
      result("2099-01-01T00:05:01.000Z", "w4"),
      write("2099-01-01T00:06:00.000Z", "w5", repo, "Write", {
        file_path: "/etc/elsewhere.ts",
        content: "toStored()",
      }),
      result("2099-01-01T00:06:01.000Z", "w5"),
      // Written before any record was saved: nothing it names was deliverable then
      write("2020-01-01T00:00:00.000Z", "w6", repo, "Write", {
        file_path: path.join(repo, "a.ts"),
        content: "toStored()",
      }),
      result("2020-01-01T00:00:01.000Z", "w6"),
      delivery("2099-01-01T00:07:00.000Z", "Sphica: Legacy record: trace:ext-s1/opener (constraint do): K"),
      write("2099-01-01T00:08:00.000Z", "w7", repo, "Edit", {
        file_path: "src/z.ts",
        old_string: "a",
        new_string: "open()",
      }),
      result("2099-01-01T00:08:01.000Z", "w7"),
    ];
    fs.writeFileSync(path.join(dir, "a.jsonl"), `${main.join("\n")}\n`);
    // A conversation where Sphica's delivery was never seen before the write
    const quiet = [
      human("2099-01-01T00:00:00.000Z"),
      write("2099-01-01T00:01:00.000Z", "q1", repo, "Edit", {
        file_path: "src/q.ts",
        old_string: "a",
        new_string: "toStored()",
      }),
      result("2099-01-01T00:01:01.000Z", "q1"),
    ];
    fs.writeFileSync(path.join(dir, "quiet.jsonl"), `${quiet.join("\n")}\n`);

    const r = await replay(db.reader, readConversations(dir));
    assert.deepEqual(
      r.pairs.map((x) => [x.toolUseId, x.key.replace("trace:ext-s1/", ""), x.hit, x.document, x.shown]),
      [
        ["w1", "utc", "symbol", true, true],
        ["w1", "no-telemetry", "option", true, true],
        // w2: utc was just delivered by the replay itself, and old_string never counts
        // w4: after the compaction utc counts again
        ["w4", "utc", "symbol", false, true],
      ],
      "opener reached the conversation through w1's own pre-edit delivery, and old was no longer deliverable",
    );
    assert.deepEqual(r.counts, {
      conversations: 2,
      unreadable: 0,
      writes: 7,
      failed: 1,
      outside: 1,
      notObserved: 1,
      unknown: 1,
    });
  } finally {
    await db.done();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a delivery shows only what fits in 900 characters", async () => {
  const db = tempDb();
  const repo = checkout();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-replay-logs-"));
  try {
    const p = project(db);
    const long = "Keep this part of the system exactly as it is, because the reason is long. ".repeat(4);
    const m = message(db, p, { id: "m1", text: long });
    const slug = (s: string) => `${s}-a-rather-long-record-slug-like-the-real-ones-have`;
    await save(db, p, {
      units: ["first", "second", "third"].map((s) =>
        decided(slug(s), m, long.trim(), {
          anchors: [{ path: `src/${s}.ts`, symbol: `${s}LongSymbolName`, role: "applies_to" }],
        }),
      ),
    });
    const lines = [
      delivery("2098-12-31T23:59:00.000Z", "Sphica: current work."),
      human("2099-01-01T00:00:00.000Z"),
      write("2099-01-01T00:01:00.000Z", "w1", repo, "Write", {
        file_path: path.join(repo, "docs/plan.md"),
        content: "firstLongSymbolName secondLongSymbolName thirdLongSymbolName",
      }),
      result("2099-01-01T00:01:01.000Z", "w1"),
    ];
    fs.writeFileSync(path.join(dir, "a.jsonl"), `${lines.join("\n")}\n`);
    const r = await replay(db.reader, readConversations(dir));
    assert.deepEqual(
      r.pairs.map((x) => [x.key.replace(/^trace:ext-s1\/|-a-rather.*$/g, ""), x.shown]),
      [
        ["first", true],
        ["second", true],
        ["third", false],
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
    unit: i,
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
  assert.equal(a.length, 20);
  assert.equal(
    a.filter((x) => !x.document).length,
    5,
    "a short stratum is taken whole and the rest come from the other",
  );
  assert.ok(!a.some((x) => x.key === "k200"), "only pairs a delivery would show are sampled");
});

test("the bar settles only what every resolution of the unknown labels agrees on", () => {
  const labels = (counts: Partial<Record<Label["label"], number>>): Label[] =>
    (["R", "H", "N", "unknown"] as const)
      .flatMap((k) => Array<Label["label"]>(counts[k] ?? 0).fill(k))
      .map((label, i) => ({ n: i + 1, label }));
  assert.equal(decide(labels({ H: 10, N: 30 })).verdict, "not built");
  assert.equal(decide(labels({ R: 1, H: 26, N: 13 })).verdict, "build");
  assert.equal(
    decide(labels({ H: 27, N: 10, unknown: 3 })).verdict,
    "undecided",
    "unknowns could all be R or all be N",
  );
  assert.equal(decide(labels({ R: 1, H: 25, N: 12, unknown: 2 })).verdict, "undecided");
  assert.equal(decide(labels({ H: 40 })).verdict, "not built", "no pair goes against a record");
  assert.equal(
    decide(labels({ R: 1, H: 10 })).verdict,
    "undecided",
    "fewer than 20 labelled pairs decide nothing",
  );
  assert.throws(
    () =>
      decide([
        { n: 1, label: "N" },
        { n: 3, label: "N" },
      ]),
    /without gaps/,
  );
});
