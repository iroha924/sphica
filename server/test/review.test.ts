// The decision lane of a review against real SQLite: which records a diff touches, and which verdicts are backed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { inTransaction } from "../src/db.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { parseDiff, selectForReview } from "../src/review.ts";
import { checkFindings } from "../src/review-findings.ts";
import { openRun } from "../src/trace.ts";
import { message, project, type TempDb, tempDb } from "./temp-db.ts";

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

test("a diff lists its changed files with added lines and their new line numbers, and a deleted file under its old path", () => {
  assert.deepEqual(parseDiff(DIFF), [
    { path: "src/db.ts", added: ["const b = 3;", 'import pg from "pg";'], lines: [4, 5] },
    { path: "src/telemetry.ts", added: ["export function sendTelemetry() {}"], lines: [1] },
    { path: "gone.ts", added: [], lines: [], gone: true },
  ]);
});

test("a mode-only or binary change, which prints no ---/+++ header, still lists its path", () => {
  const diff = [
    "diff --git a/bin/run.sh b/bin/run.sh",
    "old mode 100644",
    "new mode 100755",
    "diff --git a/logo.png b/logo.png",
    "index 1111111..2222222 100644",
    "Binary files a/logo.png and b/logo.png differ",
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "-x",
    "+y",
  ].join("\n");
  assert.deepEqual(parseDiff(diff), [
    { path: "bin/run.sh", added: [], lines: [] },
    { path: "logo.png", added: [], lines: [] },
    { path: "src/a.ts", added: ["y"], lines: [1] },
  ]);
});

test("a rename without content changes lists both paths, the old one as gone", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/b.ts",
    "similarity index 100%",
    "rename from src/a.ts",
    "rename to src/b.ts",
    "diff --git a/src/c.ts b/src/d.ts",
    "similarity index 90%",
    "rename from src/c.ts",
    "rename to src/d.ts",
    "--- a/src/c.ts",
    "+++ b/src/d.ts",
    "@@ -1 +1 @@",
    "-x",
    "+y",
  ].join("\n");
  assert.deepEqual(parseDiff(diff), [
    { path: "src/a.ts", added: [], lines: [], gone: true },
    { path: "src/b.ts", added: [], lines: [] },
    { path: "src/c.ts", added: [], lines: [], gone: true },
    { path: "src/d.ts", added: ["y"], lines: [1] },
  ]);
});

// Git quotes a path holding a tab, quote, backslash, or (without core.quotePath=false) a non-ASCII byte, and escapes it C-style
test("quoted Git paths are read unquoted in headers, renames, and deletions", () => {
  const diff = [
    'diff --git "a/q\\"x.sh" "b/q\\"x.sh"',
    "old mode 100644",
    "new mode 100755",
    'diff --git "a/old\\\\name.ts" "b/new\\tname.ts"',
    "similarity index 100%",
    'rename from "old\\\\name.ts"',
    'rename to "new\\tname.ts"',
    'diff --git "a/\\346\\227\\245.ts" "b/\\346\\227\\245.ts"',
    '--- "a/\\346\\227\\245.ts"',
    '+++ "b/\\346\\227\\245.ts"',
    "@@ -1 +1 @@",
    "-x",
    "+y",
    'diff --git "a/del\\tx.ts" "b/del\\tx.ts"',
    "deleted file mode 100644",
    '--- "a/del\\tx.ts"',
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-x",
  ].join("\n");
  assert.deepEqual(parseDiff(diff), [
    { path: 'q"x.sh', added: [], lines: [] },
    { path: "old\\name.ts", added: [], lines: [], gone: true },
    { path: "new\tname.ts", added: [], lines: [] },
    { path: "日.ts", added: ["y"], lines: [1] },
    { path: "del\tx.ts", added: [], lines: [], gone: true },
  ]);
});

test("inside a hunk, an added or removed line that looks like a file header stays a line of the same file", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,3 @@",
    "--- removed text",
    "+++ b/decoy.ts",
    "+real",
    " kept",
  ].join("\n");
  assert.deepEqual(parseDiff(diff), [{ path: "src/a.ts", added: ["++ b/decoy.ts", "real"], lines: [1, 2] }]);
});

// Findings hold at most 50 verdicts, so a verdict for every record is asked only while that many fit
test("more records than findings can hold do not make every verdict set fail", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const words = Array.from({ length: 51 }, (_, n) => `Rule ${n}.`);
    const m = message(db, p, { id: "m1", text: words.join(" ") });
    const unit = (w: string, n: number) => ({
      key: `r${n}`,
      kind: "decision",
      stance: "do",
      text: w,
      evidence: [{ source: `s${m}`, quote: w, role: "states" }],
      adoption: [{ source: `s${m}`, quote: w }],
      anchors: [{ path: "src/db.ts", role: "applies_to" }],
    });
    // One save holds at most 50 records
    await save(db, p, { units: words.slice(0, 50).map(unit) });
    await save(db, p, { units: [unit(words[50] ?? "", 50)] });
    const files = parseDiff(DIFF);
    assert.equal((await selectForReview(db.reader, p, files)).length, 51);
    const some = Array.from({ length: 50 }, (_, n) => ({ outcome: "unrelated", unit: `trace:ext-s1/r${n}` }));
    assert.deepEqual(await checkFindings(db.reader, p, files, some), []);
  } finally {
    await db.done();
  }
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
    // A full-width spelling of the option on an added line matches too (both sides are normalized the same way)
    const wide = await selectForReview(db.reader, p, [
      { path: "src/x.ts", added: ["send(ＴＥＬＥＭＥＴＲＹ)"], lines: [1] },
    ]);
    assert.deepEqual(
      wide.map((u) => u.key),
      ["trace:ext-s1/no-telemetry"],
    );
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
      // A deleted file has no added lines: its path is the evidence
      {
        outcome: "violation",
        unit: "trace:ext-s1/storage",
        reason: "drops the file",
        evidence: { path: "gone.ts" },
      },
      { outcome: "violation", unit: "trace:ext-s1/storage", reason: "x", evidence: { path: "src/db.ts" } },
    ]);
    assert.deepEqual(problems, [
      "findings.1 (complies trace:ext-s1/maybe): not a record this diff touches; cite one review_select returned",
      "findings.1 (complies trace:ext-s1/maybe): give the reason, tying the record to the change",
      "findings.1 (complies trace:ext-s1/maybe): needs evidence in the changed code (a path and an added line)",
      "findings.2 (violation trace:ext-s1/storage): evidence line 3 is not an added line of src/db.ts",
      "findings.3 (violation trace:ext-s1/storage): evidence path other.ts is not in the diff",
      "findings.6 (violation trace:ext-s1/storage): evidence in src/db.ts needs an added line",
    ]);
    assert.match((await checkFindings(db.reader, p, files, [{ outcome: "maybe" }])).join(), /findings\.0/);
    // Every record review_select returned needs a verdict, and one record cannot both comply and be violated
    assert.deepEqual(await checkFindings(db.reader, p, files, []), [
      "trace:ext-s1/storage: no verdict; give one (unrelated or undetermined when it does not apply)",
      "trace:ext-s1/no-telemetry: no verdict; give one (unrelated or undetermined when it does not apply)",
    ]);
    const mixed = await checkFindings(db.reader, p, files, [
      {
        outcome: "violation",
        unit: "trace:ext-s1/storage",
        reason: "adds pg",
        evidence: { path: "src/db.ts", line: 5 },
      },
      {
        outcome: "complies",
        unit: "trace:ext-s1/storage",
        reason: "keeps it",
        evidence: { path: "src/db.ts", line: 5 },
      },
      { outcome: "unrelated", unit: "trace:ext-s1/no-telemetry" },
    ]);
    assert.deepEqual(mixed, [
      "trace:ext-s1/storage: contradictory verdicts (violation, complies); give one outcome",
    ]);
  } finally {
    await db.done();
  }
});
