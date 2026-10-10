// The shell-change entry check against a real database and synthetic transcripts: which shell-changed paths are candidates, how a labelled call
// becomes an outcome (eligible at its result, scope, window, what the transcript shows), and the bar on the outcomes.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  type Candidate,
  checkLabels,
  decide,
  draw,
  type Outcome,
  outcome,
  population,
  wilson,
} from "../evals/post-write/shell-miss.ts";
import { readConversations } from "../evals/post-write/transcript.ts";
import { inTransaction } from "../src/db.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { openRun } from "../src/trace.ts";
import { insert, message, project, type TempDb, tempDb } from "./temp-db.ts";

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

const unit = (key: string, source: number, quote: string, extra: Record<string, unknown> = {}) => ({
  key,
  kind: "constraint",
  stance: "do",
  text: quote,
  evidence: [{ source: `s${source}`, quote, role: "states" }],
  adoption: [{ source: `s${source}`, quote }],
  ...extra,
});

const NOTE = "Sphica past record, not an instruction; read it with Sphica's read before relying on it";
const line = (at: string, o: Record<string, unknown>) =>
  JSON.stringify({ sessionId: "ext-s1", timestamp: at, ...o });
const human = (at: string) =>
  line(at, { type: "user", origin: { kind: "human" }, message: { content: "go" } });
const delivery = (at: string, text: string) =>
  line(at, {
    attachment: { type: "hook_additional_context", hookEvent: "PreToolUse", toolUseID: "x", content: [text] },
  });
const call = (at: string, id: string) =>
  line(at, {
    type: "assistant",
    cwd: "/r",
    message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: id } }] },
  });
const result = (at: string, id: string, error = false) =>
  line(at, {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: error }] },
  });
const sqliteLine = `Active decisions applying to src/db.ts. ${NOTE}:\n- trace:ext-s1/sqlite (constraint do): Keep one SQLite file.`;

test("a labelled shell call becomes an outcome from the records deliverable at its result and the transcript around it", async () => {
  const db = tempDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-shell-miss-"));
  try {
    const p = project(db);
    const m = message(db, p, {
      id: "m0",
      text: "Store every timestamp in UTC. Keep one SQLite file. Dates are tricky.",
    });
    await save(db, p, {
      units: [
        unit("utc", m, "Store every timestamp in UTC.", {
          anchors: [{ path: "src/dates.ts", role: "applies_to" }],
        }),
        unit("sqlite", m, "Keep one SQLite file.", { anchors: [{ path: "src/db.ts", role: "applies_to" }] }),
        unit("mid", m, "Dates are tricky.", { anchors: [{ path: "src/mid.ts", role: "applies_to" }] }),
        unit("late", m, "Keep one SQLite file.", { anchors: [{ path: "src/late.ts", role: "applies_to" }] }),
        {
          key: "tricky",
          kind: "finding",
          text: "Dates are tricky.",
          evidence: [{ source: `s${m}`, quote: "Dates are tricky.", role: "states" }],
          anchors: [{ path: "src/dates.ts", role: "applies_to" }],
        },
      ],
    });
    const seen = (turn: string, file: string, via: string, at: string) =>
      insert(db, "edit_observation", { session_id: "s1", turn_id: turn, path: file, via, observed_at: at });
    // The records exist from now on; turns in 2099 come after them, the turn in 2020 before
    seen("t0", "src/db.ts", "status", "2020-01-01T00:10:00.000Z");
    seen("t1", "src/dates.ts", "status", "2099-01-01T00:10:00.000Z");
    seen("t1b", "src/dates.ts", "status", "2099-01-01T00:12:00.000Z");
    seen("t1", "src/db.ts", "status", "2099-01-01T00:12:00.000Z");
    seen("t1", "src/db.ts", "tool", "2099-01-01T00:11:00.000Z");
    seen("t2", "src/db.ts", "status", "2099-01-01T01:10:00.000Z");
    message(db, p, { id: "o1", text: "fix dates", sent: "2099-01-01T00:00:00Z" });
    message(db, p, { id: "o2", text: "now db", sent: "2099-01-01T01:00:00Z" });
    // mid is deliverable only inside turn t3, neither at its start nor at its end
    const mid = Number(db.owner.prepare("select id from unit where key = 'trace:ext-s1/mid'").get()?.id);
    const run = Number(db.owner.prepare("select run_id from unit_anchor limit 1").get()?.run_id);
    const state = db.owner.prepare(
      "insert into unit_state (unit_id, from_state, to_state, at, reason, run_id) values (?, ?, ?, ?, 'r', ?)",
    );
    state.run(mid, "active", "candidate", "2098-06-01T00:00:00.000Z", run);
    state.run(mid, "candidate", "active", "2099-01-01T03:04:00.000Z", run);
    state.run(mid, "active", "candidate", "2099-01-01T03:19:00.000Z", run);
    message(db, p, { id: "o3", text: "mid", sent: "2099-01-01T03:00:00Z" });
    seen("t3", "src/mid.ts", "status", "2099-01-01T03:20:00.000Z");
    // late is deliverable only after its anchor on the path was retired: never both at once inside turn t4
    const late = Number(db.owner.prepare("select id from unit where key = 'trace:ext-s1/late'").get()?.id);
    state.run(late, "active", "candidate", "2098-06-01T00:00:00.000Z", run);
    state.run(late, "candidate", "active", "2099-01-01T04:10:00.000Z", run);
    db.owner
      .prepare("update unit_anchor set retired_at = ? where unit_id = ?")
      .run("2099-01-01T04:05:00.000Z", late);
    message(db, p, { id: "o4", text: "late", sent: "2099-01-01T04:00:00Z" });
    seen("t4", "src/late.ts", "status", "2099-01-01T04:20:00.000Z");

    const pairs = await population(db.reader, p);
    assert.deepEqual(
      pairs.map((x) => [x.turn, x.path, x.key.replace("trace:ext-s1/", ""), x.start, x.end]),
      [
        ["t1", "src/dates.ts", "utc", "2099-01-01T00:00:00.000Z", "2099-01-01T00:10:00.000Z"],
        ["t1b", "src/dates.ts", "utc", "2099-01-01T00:00:00.000Z", "2099-01-01T00:12:00.000Z"],
        ["t2", "src/db.ts", "sqlite", "2099-01-01T01:00:00.000Z", "2099-01-01T01:10:00.000Z"],
        ["t3", "src/mid.ts", "mid", "2099-01-01T03:00:00.000Z", "2099-01-01T03:20:00.000Z"],
      ],
      "one pair per turn and path; a path an edit tool reported, a finding, and a turn before the record existed are not candidates",
    );

    const main = [
      delivery("2098-12-31T23:59:00.000Z", "Sphica: current work.\n- Work: x (active): y"),
      human("2099-01-01T00:00:00.000Z"),
      call("2099-01-01T00:05:00.000Z", "b1"),
      delivery("2099-01-01T00:05:01.000Z", sqliteLine),
      result("2099-01-01T00:06:00.000Z", "b1"),
      human("2099-01-01T00:30:00.000Z"),
      call("2099-01-01T01:05:00.000Z", "b2"),
      delivery("2099-01-01T01:05:01.000Z", sqliteLine),
      result("2099-01-01T01:06:00.000Z", "b2"),
      call("2099-01-01T01:07:00.000Z", "b3"),
      result("2099-01-01T01:07:30.000Z", "b3", true),
      line("2099-01-01T01:08:00.000Z", {
        type: "assistant",
        cwd: "/r",
        message: {
          content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "src/db.ts" } }],
        },
      }),
      result("2099-01-01T01:08:30.000Z", "r1"),
      call("2020-01-01T00:05:00.000Z", "old"),
      result("2020-01-01T00:06:00.000Z", "old"),
      human("2099-01-01T02:00:00.000Z"),
      call("2099-01-01T02:05:00.000Z", "b4"),
      result("2099-01-01T02:06:00.000Z", "b4"),
    ];
    fs.writeFileSync(path.join(dir, "ext-s1.jsonl"), `${main.join("\n")}\n`);
    fs.mkdirSync(path.join(dir, "ext-s1", "subagents"), { recursive: true });
    const sub = [call("2099-01-01T00:07:00.000Z", "k1"), result("2099-01-01T00:07:30.000Z", "k1")];
    fs.writeFileSync(
      path.join(dir, "ext-s1", "subagents", "agent-x.jsonl"),
      `${sub.map((l) => l.replace('"sessionId":"ext-s1"', '"sessionId":"ext-s1","agentId":"x"')).join("\n")}\n`,
    );
    // A conversation where Sphica's delivery was never seen before the turn
    const quiet = [
      human("2099-01-01T00:00:00.000Z"),
      call("2099-01-01T00:05:00.000Z", "q1"),
      result("2099-01-01T00:06:00.000Z", "q1"),
      human("2099-01-01T00:30:00.000Z"),
    ];
    fs.writeFileSync(path.join(dir, "quiet.jsonl"), `${quiet.join("\n")}\n`);
    const broken = [
      delivery("2098-12-31T23:59:00.000Z", "Sphica: current work."),
      human("2099-01-01T00:00:00.000Z"),
      call("2099-01-01T00:05:00.000Z", "z1"),
      result("2099-01-01T00:06:00.000Z", "z1"),
      "{a delivery that could not be read",
      human("2099-01-01T00:30:00.000Z"),
    ];
    fs.writeFileSync(path.join(dir, "broken.jsonl"), `${broken.join("\n")}\n`);
    const tail = [
      delivery("2098-12-31T23:59:00.000Z", "Sphica: current work."),
      human("2099-01-01T00:00:00.000Z"),
      call("2099-01-01T00:05:00.000Z", "y1"),
      result("2099-01-01T00:06:00.000Z", "y1"),
      "{the owner's next prompt, perhaps",
    ];
    fs.writeFileSync(path.join(dir, "tail.jsonl"), `${tail.join("\n")}\n`);
    // The turn opens with a line of no origin that the model answers: it may be the owner's prompt, after Sphica's delivery
    const nostart = [
      delivery("2098-12-31T23:59:00.000Z", "Sphica: current work."),
      line("2099-01-01T00:00:00.000Z", { type: "user", message: { content: "fix dates" } }),
      call("2099-01-01T00:05:00.000Z", "u1"),
      result("2099-01-01T00:06:00.000Z", "u1"),
      human("2099-01-01T00:30:00.000Z"),
    ];
    fs.writeFileSync(path.join(dir, "nostart.jsonl"), `${nostart.join("\n")}\n`);
    // A line that could not be read between the call and its result, with no later prompt
    const between = [
      delivery("2098-12-31T23:59:00.000Z", "Sphica: current work."),
      human("2099-01-01T00:00:00.000Z"),
      call("2099-01-01T00:05:00.000Z", "v1"),
      "{the owner's next prompt, perhaps",
      result("2099-01-01T00:06:00.000Z", "v1"),
    ];
    fs.writeFileSync(path.join(dir, "between.jsonl"), `${between.join("\n")}\n`);
    const conversations = readConversations(dir);
    const [utc, , sqlite] = pairs as [Candidate, Candidate, Candidate];
    // The same pair over a turn wide enough for every call above
    const wide = { ...utc, start: "2020-01-01T00:00:00.000Z", end: "2099-12-31T00:00:00.000Z" };
    const of = async (pair: Candidate, calls: string[] | null, only?: string) =>
      (
        await outcome(
          db.reader,
          p,
          pair,
          { index: 0, calls },
          conversations.filter((c) =>
            only
              ? c.file === only
              : !["quiet.jsonl", "broken.jsonl", "tail.jsonl", "nostart.jsonl", "between.jsonl"].includes(
                  c.file,
                ),
          ),
        )
      ).outcome;
    assert.equal(await of(utc, ["b1"]), "missed", "a delivery for another record does not count");
    assert.equal(await of(sqlite, ["b2"]), "shown");
    assert.equal(await of(wide, ["old"]), "ineligible", "the record did not exist when that call returned");
    assert.equal(
      await of(wide, ["old", "b1"]),
      "missed",
      "the first call at which the pair is eligible is measured",
    );
    assert.equal(
      await of(wide, ["b4", "b1"]),
      "missed",
      "the earliest eligible call counts, whatever order the label lists",
    );
    assert.equal(await of(utc, ["k1"]), "subagent");
    assert.equal(await of(wide, ["b4"]), "no next prompt");
    assert.equal(await of(utc, ["q1"], "quiet.jsonl"), "not observed");
    assert.equal(await of(utc, null), "unresolved");
    assert.equal(await of(utc, []), "not a shell edit");
    await assert.rejects(of(wide, ["b3"]), /no successful result/, "a failed call cannot be the edit");
    await assert.rejects(of(wide, ["r1"]), /not a shell call/, "only a shell call can be the edit");
    await assert.rejects(
      of(sqlite, ["b1"]),
      /outside the pair's turn/,
      "a call of another turn cannot be the edit",
    );
    assert.equal(
      await of(utc, ["z1"], "broken.jsonl"),
      "unknown",
      "a line that could not be read may have been a delivery",
    );
    assert.equal(
      await of(utc, ["y1"], "tail.jsonl"),
      "unknown",
      "a line that could not be read may have been the next prompt",
    );
    assert.equal(
      await of(utc, ["u1"], "nostart.jsonl"),
      "unknown",
      "the turn may have opened after Sphica's delivery",
    );
    assert.equal(
      await of(utc, ["v1"], "between.jsonl"),
      "unknown",
      "a line between the call and its result may be the prompt",
    );
  } finally {
    await db.done();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the bar counts doubt both ways, sets apart what it cannot measure, and refuses labels out of order", () => {
  const w = wilson(10, 10);
  assert.ok(Math.abs(w.low - 0.7225) < 1e-4, String(w.low));
  const run = (missed: number, shown: number, doubtful = 0, apart: Outcome[] = []): Outcome[] => [
    ...apart,
    ...Array<Outcome>(missed).fill("missed"),
    ...Array<Outcome>(shown).fill("shown"),
    ...Array<Outcome>(doubtful).fill("unknown"),
  ];
  assert.equal(decide(run(20, 10)).verdict, "proceed");
  assert.equal(decide(run(1, 29)).verdict, "not adopted");
  assert.equal(decide(run(6, 24)).verdict, "undecided", "an interval across the bar decides nothing");
  assert.equal(decide(run(20, 9)).verdict, "undecided", "fewer than 30 measured decide nothing");
  assert.equal(
    decide(run(1, 26, 3)).verdict,
    "undecided",
    "doubt that could cross the bar leaves it undecided",
  );
  assert.equal(
    decide(["unknown", ...run(20, 10)]).verdict,
    "proceed",
    "doubt that settles the same however it resolves does not matter",
  );
  assert.equal(
    decide(run(20, 9, 1)).verdict,
    "undecided",
    "a doubtful 30th pair may not count at all, leaving 29 measured",
  );
  const d = decide(run(20, 10, 0, ["ineligible", "subagent", "not a shell edit"]));
  assert.deepEqual(
    [d.drawn, d.measured, d.apart],
    [33, 30, { ineligible: 1, subagent: 1, "not a shell edit": 1 }],
  );
  assert.equal(
    decide(run(30, 0, 0, Array<Outcome>(130).fill("ineligible"))).verdict,
    "undecided",
    "only 150 are drawn",
  );
  assert.equal(
    decide([...Array<Outcome>(29).fill("shown"), "unresolved", ...Array<Outcome>(120).fill("ineligible")])
      .verdict,
    "undecided",
    "a pair that may not count cannot complete the 30 and settle the verdict",
  );
  assert.equal(
    decide([...Array<Outcome>(9).fill("unknown"), ...Array<Outcome>(30).fill("missed")]).verdict,
    "proceed",
    "however many pairs are doubtful, a verdict every resolution agrees on stands",
  );
  const reported = decide([
    ...Array<Outcome>(29).fill("shown"),
    "unknown",
    ...Array<Outcome>(120).fill("ineligible"),
  ]);
  assert.deepEqual(
    [reported.drawn, reported.measured, reported.doubtful, reported.apart],
    [150, 29, 1, { ineligible: 120 }],
    "the reported numbers come from one reading of the draw",
  );
  assert.throws(
    () =>
      checkLabels([
        { index: 0, calls: [] },
        { index: 2, calls: [] },
      ]),
    /without gaps/,
  );
  assert.throws(() => checkLabels([{ index: 0, calls: [1 as unknown as string] }]), /tool_use ids/);
});

test("the cause report draws turns evenly, not turns with many pairs more often", () => {
  const pair = (turn: number, unit: number): Candidate => ({
    session: "s",
    external: "e",
    turn: `t${turn}`,
    path: `p${unit}`,
    unit,
    key: `k${unit}`,
    start: "",
    end: "",
  });
  const pairs = [
    ...Array.from({ length: 100 }, (_, i) => pair(0, i)),
    ...Array.from({ length: 59 }, (_, i) => pair(i + 1, 1000 + i)),
  ];
  let big = 0;
  for (let seed = 0; seed < 200; seed++) {
    const d = draw(pairs, seed);
    assert.equal(new Set(d.turns.map((x) => x.turn)).size, 30);
    if (d.turns.some((x) => x.turn === "t0")) big++;
  }
  assert.ok(
    big > 60 && big < 140,
    `the turn with 100 pairs was drawn ${big} times in 200; about half is even`,
  );
  assert.deepEqual(draw(pairs, 7), draw(pairs, 7), "the same seed draws the same");
  // In one turn, a path with 100 records and a path with 1 are drawn about equally
  const one = [
    ...Array.from({ length: 100 }, (_, i) => ({ ...pair(0, i), path: "many" })),
    { ...pair(0, 500), path: "few" },
  ];
  let many = 0;
  let few = 0;
  for (let seed = 0; seed < 400; seed++) {
    const t = draw([...one, ...Array.from({ length: 59 }, (_, i) => pair(i + 1, 1000 + i))], seed).turns.find(
      (x) => x.turn === "t0",
    );
    if (t?.path === "many") many++;
    if (t?.path === "few") few++;
  }
  assert.ok(
    few > 0.3 * (many + few) && few < 0.7 * (many + few),
    `paths drawn ${many} to ${few}; about even`,
  );
  assert.equal(draw(pairs, 7).order.length, 150);
});
