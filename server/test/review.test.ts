// The decision lane of a review against real SQLite: which records a diff touches, and which verdicts are backed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { inTransaction } from "../src/db.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { checkFindings, parseDiff, selectForReview } from "../src/review.ts";
import { openRun } from "../src/trace.ts";
import { message, project, type TempDb, tempDb } from "./temp-db.ts";

async function save(db: TempDb, p: number, record: unknown) {
  const t: Target = { projectId: p, origin: "trace", prefix: "trace:ext-s1/", sessionId: "s1", root: null };
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

const DIFF = [
  "diff --git a/src/db.ts b/src/db.ts",
  "--- a/src/db.ts",
  "+++ b/src/db.ts",
  "@@ -3,2 +3,3 @@ export function open() {",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  '+import pg from "pg";',
  "\\ No newline at end of file",
  "--- a/src/telemetry.ts",
  "+++ b/src/telemetry.ts",
  "@@ -0,0 +1 @@",
  "+export function sendTelemetry() {}",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-old",
].join("\n");

test("a diff lists its changed files with added lines and their new line numbers", () => {
  assert.deepEqual(parseDiff(DIFF), [
    { path: "src/db.ts", added: ["const b = 3;", 'import pg from "pg";'], lines: [4, 5] },
    { path: "src/telemetry.ts", added: ["export function sendTelemetry() {}"], lines: [1] },
  ]);
});

test("records anchored to a changed path, and location-free don't records naming an added option, apply; verdicts need evidence", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "SQLite にする。テレメトリは入れない。候補。" });
    const decided = (key: string, quote: string, extra = {}) => ({
      key,
      kind: "decision",
      stance: "do",
      text: quote,
      evidence: [{ source: `s${m}`, quote, role: "states" }],
      adoption: [{ source: `s${m}`, quote }],
      ...extra,
    });
    await save(db, p, {
      units: [
        decided("storage", "SQLite にする。", {
          anchors: [{ path: "src/db.ts", symbol: "open", role: "applies_to" }],
        }),
        decided("no-telemetry", "テレメトリは入れない。", {
          stance: "dont",
          options: [{ text: "telemetry", outcome: "rejected" }],
        }),
        {
          key: "maybe",
          kind: "decision",
          stance: "do",
          text: "候補",
          evidence: [{ source: `s${m}`, quote: "候補。", role: "states" }],
          anchors: [{ path: "src/db.ts", role: "applies_to" }],
        },
      ],
    });
    const files = parseDiff(DIFF);
    const hits = await selectForReview(db.reader, p, files);
    assert.deepEqual(
      hits.map((u) => [u.key, u.because]),
      [
        ["trace:ext-s1/storage", "anchored to src/db.ts open"],
        ["trace:ext-s1/no-telemetry", "an added line in src/telemetry.ts names the option telemetry"],
      ],
    );
    assert.deepEqual(await selectForReview(db.reader, p, []), []);
    const problems = await checkFindings(db.reader, p, files, [
      {
        outcome: "violation",
        unit: "trace:ext-s1/storage",
        reason: "adds pg",
        evidence: { path: "src/db.ts", line: 5 },
      },
      { outcome: "complies", unit: "trace:ext-s1/maybe" },
      {
        outcome: "violation",
        unit: "trace:ext-s1/storage",
        reason: "x",
        evidence: { path: "src/db.ts", line: 3 },
      },
      {
        outcome: "violation",
        unit: "trace:ext-s1/storage",
        reason: "x",
        evidence: { path: "other.ts", line: 1 },
      },
      { outcome: "unrelated", unit: "trace:ext-s1/no-telemetry" },
    ]);
    assert.deepEqual(problems, [
      "findings.1 (complies trace:ext-s1/maybe): not a record this diff touches; cite one review_select returned",
      "findings.1 (complies trace:ext-s1/maybe): give the reason, tying the record to the change",
      "findings.1 (complies trace:ext-s1/maybe): needs evidence in the changed code (a path and an added line)",
      "findings.2 (violation trace:ext-s1/storage): evidence line 3 is not an added line of src/db.ts",
      "findings.3 (violation trace:ext-s1/storage): evidence path other.ts is not in the diff",
    ]);
    assert.match((await checkFindings(db.reader, p, files, [{ outcome: "maybe" }])).join(), /findings\.0/);
  } finally {
    await db.done();
  }
});
