// The decision lane of a review against real SQLite: which records a diff touches, and which verdicts are backed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { inTransaction } from "../src/db.ts";
import { READ_BUDGET } from "../src/read.ts";
import { reconcile } from "../src/reconcile.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { AI_DEPARTURE, parseDiff, reviewBatch, selectedText, selectForReview } from "../src/review.ts";
import { checkedText, checkFindings } from "../src/review-findings.ts";
import { openRun } from "../src/trace.ts";
import { aiDecided, manyAdopted, message, project, run, type TempDb, tempDb } from "./temp-db.ts";

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

/** The problems with verdicts on the first batch, checked with the selection review_select would give */
async function problemsOf(db: TempDb, p: number, diff: string, findings: unknown) {
  const files = parseDiff(diff);
  const { selection } = await reviewBatch(db.reader, p, files, null, diff);
  return (await checkFindings(db.reader, p, files, findings, { after: null, selection, diff })).problems;
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

// A review judges its records 50 at a time: a check above that never passes records it was not given as judged
test("review batch: 51 selected records and verdicts for the first 50 name the one left", async () => {
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
    const first = await reviewBatch(db.reader, p, files, null, DIFF);
    const some = Array.from({ length: 50 }, (_, n) => ({ outcome: "unrelated", unit: `trace:ext-s1/r${n}` }));
    const checked = await checkFindings(db.reader, p, files, some, {
      after: null,
      selection: first.selection,
      diff: DIFF,
    });
    const said = JSON.stringify(checked);
    assert.ok(said.includes("trace:ext-s1/r50"), `the record left is named: ${said}`);
    assert.ok(!said.includes("every verdict is backed"), said);
    assert.deepEqual(checked.problems, []);
    const last = first.records.at(-1)?.id ?? 0;
    assert.equal(first.next, last);
    assert.equal(
      checkedText(checked),
      `Batch 1 of 2 backed (selection ${first.selection}). Not judged in this call: 1 records (next batch: trace:ext-s1/r50); call review_select with after: ${last}, then review_check with the same after.`,
    );
    // The second batch holds only the record left, and its check says it was the last
    const second = await reviewBatch(db.reader, p, files, last, DIFF);
    assert.deepEqual(
      second.records.map((u) => u.key),
      ["trace:ext-s1/r50"],
    );
    assert.equal(second.selection, first.selection);
    const done = await checkFindings(
      db.reader,
      p,
      files,
      [{ outcome: "unrelated", unit: "trace:ext-s1/r50" }],
      {
        after: last,
        selection: first.selection,
        diff: DIFF,
      },
    );
    assert.equal(
      checkedText(done),
      `Batch 2 of 2 backed (selection ${first.selection}). This was the last batch (51 records in all).`,
    );
  } finally {
    await db.done();
  }
});

test("review batch: 120 records go in three batches by id, each check speaks for its batch, and a changed record breaks the selection", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const words = Array.from({ length: 120 }, (_, n) => `Rule ${n}.`);
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
    await save(db, p, { units: words.slice(0, 50).map(unit) });
    await save(db, p, { units: words.slice(50, 100).map((w, i) => unit(w, i + 50)) });
    await save(db, p, { units: words.slice(100).map((w, i) => unit(w, i + 100)) });
    const files = parseDiff(DIFF);
    const all = await selectForReview(db.reader, p, files);
    assert.deepEqual(
      all.map((u) => u.id),
      all.map((u) => u.id).toSorted((a, b) => a - b),
    );
    const judged = (b: { records: { key: string }[] }) =>
      b.records.map((u) => ({ outcome: "unrelated", unit: u.key }));
    const seen: string[] = [];
    let after: number | null = null;
    const texts: string[] = [];
    const first = await reviewBatch(db.reader, p, files, null, DIFF);
    for (;;) {
      const b = await reviewBatch(db.reader, p, files, after, DIFF);
      seen.push(...b.records.map((u) => u.key));
      const c = await checkFindings(db.reader, p, files, judged(b), {
        after,
        selection: first.selection,
        diff: DIFF,
      });
      assert.deepEqual(c.problems, []);
      texts.push(checkedText(c));
      if (b.next === null) break;
      after = b.next;
    }
    assert.equal(seen.length, 120);
    assert.equal(new Set(seen).size, 120);
    assert.equal(texts.length, 3);
    assert.match(texts[0] ?? "", /^Batch 1 of 3 backed .* Not judged in this call: 70 records/);
    assert.match(texts[1] ?? "", /^Batch 2 of 3 backed .* Not judged in this call: 20 records/);
    assert.match(texts[2] ?? "", /^Batch 3 of 3 backed .* This was the last batch \(120 records in all\)\.$/);
    for (const t of texts) assert.doesNotMatch(t, /every verdict/);

    // A verdict on a record of another batch, and a record of this batch left without one, are both problems
    const second = await reviewBatch(db.reader, p, files, first.next, DIFF);
    const wrong = await checkFindings(
      db.reader,
      p,
      files,
      [...judged(first).slice(1), { outcome: "unrelated", unit: second.records[0]?.key }],
      { after: null, selection: first.selection, diff: DIFF },
    );
    assert.deepEqual(wrong.problems, [
      `findings.49 (unrelated ${second.records[0]?.key}): not in this batch; judge it with the batch review_select returns it in`,
      `${first.records[0]?.key}: no verdict; give one (unrelated or undetermined when it does not apply)`,
    ]);

    // A record that changes between batches (its revision rises) changes the selection: the review starts again
    await save(db, p, {
      units: [
        {
          key: "other",
          kind: "decision",
          stance: "do",
          text: "Rule 0.",
          evidence: [{ source: `s${m}`, quote: "Rule 0.", role: "states" }],
          adoption: [{ source: `s${m}`, quote: "Rule 0." }],
          anchors: [{ path: "src/other.ts", role: "applies_to" }],
          conflicts: ["trace:ext-s1/r0"],
        },
      ],
    });
    assert.deepEqual(
      (await selectForReview(db.reader, p, files)).map((u) => u.id),
      all.map((u) => u.id),
    );
    const stale = await checkFindings(db.reader, p, files, judged(second), {
      after: first.next,
      selection: first.selection,
      diff: DIFF,
    });
    assert.deepEqual(stale.problems, [
      "the records this diff touches changed since review_select gave this selection; start again from the first batch",
    ]);
    assert.notEqual((await reviewBatch(db.reader, p, files, null, DIFF)).selection, first.selection);
  } finally {
    await db.done();
  }
});

test("review batch boundary: an after that is not where a batch ended is refused, so receipts cannot skip a record", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const words = Array.from({ length: 120 }, (_, n) => `Rule ${n}.`);
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
    await save(db, p, { units: words.slice(0, 50).map(unit) });
    await save(db, p, { units: words.slice(50, 100).map((w, i) => unit(w, i + 50)) });
    await save(db, p, { units: words.slice(100).map((w, i) => unit(w, i + 100)) });
    const files = parseDiff(DIFF);
    const first = await reviewBatch(db.reader, p, files, null, DIFF);
    const skipped = first.records[0]?.id ?? 0;
    const off = await reviewBatch(db.reader, p, files, skipped, DIFF);
    const c = await checkFindings(
      db.reader,
      p,
      files,
      off.records.map((u) => ({ outcome: "unrelated", unit: u.key })),
      { after: skipped, selection: first.selection, diff: DIFF },
    );
    assert.deepEqual(c.problems, [
      `after ${skipped} is not where a batch review_select gave ends; start again from the first batch`,
    ]);
  } finally {
    await db.done();
  }
});

test("review batch empty: when the records fill whole batches, the empty batch after the last one cannot be checked as backed", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const words = Array.from({ length: 50 }, (_, n) => `Rule ${n}.`);
    const m = message(db, p, { id: "m1", text: words.join(" ") });
    await save(db, p, {
      units: words.map((w, n) => ({
        key: `r${n}`,
        kind: "decision",
        stance: "do",
        text: w,
        evidence: [{ source: `s${m}`, quote: w, role: "states" }],
        adoption: [{ source: `s${m}`, quote: w }],
        anchors: [{ path: "src/db.ts", role: "applies_to" }],
      })),
    });
    const files = parseDiff(DIFF);
    const first = await reviewBatch(db.reader, p, files, null, DIFF);
    const last = first.all.at(-1)?.id ?? 0;
    const empty = await checkFindings(db.reader, p, files, [], {
      after: last,
      selection: first.selection,
      diff: DIFF,
    });
    assert.deepEqual(empty.problems, [
      `no record after ${last}: the last batch is the one that ended there; start again from the first batch`,
    ]);
  } finally {
    await db.done();
  }
});

test("review selection: diffs that differ only in removed or context lines are told apart", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "SQLite にする。" });
    await save(db, p, {
      units: [
        {
          key: "storage",
          kind: "decision",
          stance: "do",
          text: "SQLite にする。",
          evidence: [{ source: `s${m}`, quote: "SQLite にする。", role: "states" }],
          adoption: [{ source: `s${m}`, quote: "SQLite にする。" }],
          anchors: [{ path: "src/a.ts", role: "applies_to" }],
        },
      ],
    });
    const diff = (removed: string) =>
      ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", `-${removed}`, "+return false;"].join("\n");
    const one = diff("return true;");
    const other = diff("return 1;");
    assert.deepEqual(parseDiff(one), parseDiff(other));
    const a = await reviewBatch(db.reader, p, parseDiff(one), null, one);
    const b = await reviewBatch(db.reader, p, parseDiff(other), null, other);
    assert.notEqual(a.selection, b.selection);
    assert.equal((await reviewBatch(db.reader, p, parseDiff(one), null, one)).selection, a.selection);
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
    // The places of one record's violations go in one finding; each place is checked, and a deleted file's path alone is a place
    const problems = await problemsOf(db, p, DIFF, [
      {
        outcome: "violation",
        unit: "trace:ext-s1/storage",
        reason: "adds pg",
        evidence: [
          { path: "src/db.ts", line: 3 },
          { path: "other.ts", line: 1 },
          { path: "gone.ts" },
          { path: "src/db.ts" },
        ],
      },
      { outcome: "complies", unit: "trace:ext-s1/maybe" },
      { outcome: "unrelated", unit: "trace:ext-s1/no-telemetry" },
    ]);
    assert.deepEqual(problems, [
      "findings.0 (violation trace:ext-s1/storage): evidence line 3 is not an added line of src/db.ts",
      "findings.0 (violation trace:ext-s1/storage): evidence path other.ts is not in the diff",
      "findings.0 (violation trace:ext-s1/storage): evidence in src/db.ts needs an added line",
      "findings.1 (complies trace:ext-s1/maybe): not a record this diff touches; cite one review_select returned",
      "findings.1 (complies trace:ext-s1/maybe): give the reason, tying the record to the change",
      "findings.1 (complies trace:ext-s1/maybe): needs evidence in the changed code (a path and an added line)",
    ]);
    assert.match((await problemsOf(db, p, DIFF, [{ outcome: "maybe" }])).join(), /findings\.0/);
    // Every record review_select returned needs a verdict
    assert.deepEqual(await problemsOf(db, p, DIFF, []), [
      "trace:ext-s1/storage: no verdict; give one (unrelated or undetermined when it does not apply)",
      "trace:ext-s1/no-telemetry: no verdict; give one (unrelated or undetermined when it does not apply)",
    ]);
  } finally {
    await db.done();
  }
});

test("review evidence: one finding per record holds every place it is violated, each checked once", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "SQLite にする。" });
    await save(db, p, {
      units: [
        {
          key: "storage",
          kind: "decision",
          stance: "do",
          text: "SQLite にする。",
          evidence: [{ source: `s${m}`, quote: "SQLite にする。", role: "states" }],
          adoption: [{ source: `s${m}`, quote: "SQLite にする。" }],
          anchors: [{ path: "src/db.ts", role: "applies_to" }],
        },
      ],
    });
    // 22 added lines: a record violated on 21 of them is judged in one finding
    const added = Array.from({ length: 22 }, (_, n) => `+import pg${n} from "pg";`);
    const text = [
      "--- a/src/db.ts",
      "+++ b/src/db.ts",
      "@@ -0,0 +1,22 @@",
      ...added,
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-old",
    ].join("\n");
    const at = (lines: number[]) => lines.map((line) => ({ path: "src/db.ts", line }));
    const violation = (evidence: unknown) => ({
      outcome: "violation",
      unit: "trace:ext-s1/storage",
      reason: "adds pg",
      evidence,
    });
    const lines = Array.from({ length: 21 }, (_, n) => n + 1);
    assert.deepEqual(await problemsOf(db, p, text, [violation(at(lines))]), []);
    // Each of the 21 places is checked: one that is not an added line is named
    assert.deepEqual(await problemsOf(db, p, text, [violation(at([...lines.slice(1), 40]))]), [
      "findings.0 (violation trace:ext-s1/storage): evidence line 40 is not an added line of src/db.ts",
    ]);
    // A place given twice counts once; the single-place object still works
    assert.deepEqual(await problemsOf(db, p, text, [violation(at([2, 2, 3]))]), []);
    assert.deepEqual(await problemsOf(db, p, text, [violation({ path: "src/db.ts", line: 4 })]), []);
    // More distinct places than the diff has (22 added lines and one deleted file) is refused
    assert.deepEqual(
      await problemsOf(db, p, text, [
        violation([...at(Array.from({ length: 23 }, (_, n) => n + 1)), { path: "gone.ts" }]),
      ]),
      [
        "findings.0 (violation trace:ext-s1/storage): 24 places of evidence, more places than the diff has (23)",
      ],
    );
    // A second finding on the same record is a problem, whatever its outcome
    assert.deepEqual(
      await problemsOf(db, p, text, [
        violation(at([1])),
        { outcome: "complies", unit: "trace:ext-s1/storage", reason: "keeps it", evidence: at([2]) },
      ]),
      [
        "trace:ext-s1/storage: 2 findings; give one per record, with every place it is violated in its evidence",
      ],
    );
  } finally {
    await db.done();
  }
});

test("only the record in effect applies: a replaced one does not until its successor is withdrawn, and a waiting proposal never does", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "SQLite にする。DuckDB に移す。" });
    const ai = message(db, p, { id: "a1", text: "Postgres がよさそう。", speaker: "assistant" });
    const decided = (key: string, quote: string, extra = {}) => ({
      key,
      kind: "decision",
      stance: "do",
      text: quote,
      evidence: [{ source: `s${m}`, quote, role: "states" }],
      adoption: [{ source: `s${m}`, quote }],
      anchors: [{ path: "src/db.ts", role: "applies_to" }],
      ...extra,
    });
    await save(db, p, { units: [decided("sqlite", "SQLite にする。")] });
    await save(db, p, {
      units: [
        {
          key: "postgres",
          kind: "decision",
          stance: "do",
          text: "Postgres がよさそう。",
          evidence: [{ source: `s${ai}`, quote: "Postgres がよさそう。", role: "proposes" }],
          anchors: [{ path: "src/db.ts", role: "applies_to" }],
          supersedes: "trace:ext-s1/sqlite",
        },
      ],
    });
    await save(db, p, {
      units: [decided("duckdb", "DuckDB に移す。", { supersedes: "trace:ext-s1/sqlite" })],
    });
    const files = parseDiff(DIFF);
    const keys = async () => (await selectForReview(db.reader, p, files)).map((h) => h.key);
    assert.deepEqual(await keys(), ["trace:ext-s1/duckdb"]);
    const id = Number(db.owner.prepare("select id from unit where key = 'trace:ext-s1/duckdb'").get()?.id);
    const runId = run(db, p);
    await inTransaction(db.ingest, (trx) =>
      reconcile(
        trx,
        [id],
        { runId },
        { withdraw: new Map([[id, { reason: "the owner withdrew it", source: null }]]) },
      ),
    );
    assert.deepEqual(await keys(), ["trace:ext-s1/sqlite"]);
  } finally {
    await db.done();
  }
});

test("review_select marks an AI's decision and says a departure from it needs only a reason", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    aiDecided(db, p, "pool", "I keep the connection pool small.", "src/db.ts");
    const files = parseDiff(DIFF);
    const { text } = await selectedText(db.reader, await selectForReview(db.reader, p, files), READ_BUDGET);
    assert.match(
      text,
      /^- trace:ext-s1\/pool \(u\d+, decision do, decided by an AI\): I keep the connection pool small\. \[anchored to src\/db\.ts\]$/m,
    );
    assert.ok(text.endsWith(AI_DEPARTURE));
    const owner = tempDb();
    try {
      const q = project(owner);
      const m = message(owner, q, { id: "m1", text: "Keep one SQLite file." });
      await save(owner, q, {
        units: [
          {
            key: "sqlite",
            kind: "constraint",
            stance: "do",
            text: "Keep one SQLite file.",
            evidence: [{ source: `s${m}`, quote: "Keep one SQLite file.", role: "states" }],
            adoption: [{ source: `s${m}`, quote: "Keep one SQLite file." }],
            anchors: [{ path: "src/db.ts", role: "applies_to" }],
          },
        ],
      });
      const { text: plain } = await selectedText(
        owner.reader,
        await selectForReview(owner.reader, q, files),
        READ_BUDGET,
      );
      assert.match(plain, /^- trace:ext-s1\/sqlite \(u\d+, constraint do\): Keep one SQLite file\./);
      assert.ok(!plain.includes(AI_DEPARTURE));
    } finally {
      await owner.done();
    }
  } finally {
    await db.done();
  }
});

test("review selection keeps which location-free records apply, in id order, and which option and line it names", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, {
      id: "m1",
      text: "No mongoClient. No kafkaClient. No natsClient. No rabbitClient. Use rabbitClient. Keep one SQLite file.",
    });
    const dont = (key: string, quote: string, options: string[], extra = {}) => ({
      key,
      kind: "decision",
      stance: "dont",
      text: quote,
      evidence: [{ source: `s${m}`, quote, role: "states" }],
      adoption: [{ source: `s${m}`, quote }],
      options: options.map((text) => ({ text, outcome: "rejected" })),
      ...extra,
    });
    await save(db, p, {
      units: [
        // Two options on the added lines: the first one saved is named
        dont("two-options", "No mongoClient.", ["mongoClient", "redisClient"]),
        // Any live anchor, even one that only shows where it was done, takes a record out of the location-free set
        dont("evidence-anchor", "No kafkaClient.", ["kafkaClient"], {
          anchors: [{ path: "src/queue.ts", role: "evidence" }],
        }),
        // A record whose only anchor is retired is location-free again
        dont("retired-anchor", "No natsClient.", ["natsClient"], {
          anchors: [{ path: "src/bus.ts", role: "applies_to" }],
        }),
        dont("conflicted", "No rabbitClient.", ["rabbitClient"]),
        {
          key: "storage",
          kind: "decision",
          stance: "do",
          text: "Keep one SQLite file.",
          evidence: [{ source: `s${m}`, quote: "Keep one SQLite file.", role: "states" }],
          adoption: [{ source: `s${m}`, quote: "Keep one SQLite file." }],
          anchors: [{ path: "src/db.ts", role: "applies_to" }],
        },
      ],
    });
    // Selection does not hold back records in a conflict: that is delivery's rule, applied after it
    await save(db, p, {
      units: [
        {
          key: "use-rabbit",
          kind: "decision",
          stance: "do",
          text: "Use rabbitClient.",
          evidence: [{ source: `s${m}`, quote: "Use rabbitClient.", role: "states" }],
          adoption: [{ source: `s${m}`, quote: "Use rabbitClient." }],
          conflicts: ["trace:ext-s1/conflicted"],
        },
      ],
    });
    db.owner
      .prepare("update unit_anchor set retired_at = ? where path = 'src/bus.ts'")
      .run(new Date().toISOString());
    const files = [
      {
        path: "src/a.ts",
        added: ["const c = redisClient ?? mongoClient;", "natsClient.connect();"],
        lines: [1, 2],
      },
      { path: "src/b.ts", added: ["kafkaClient(); rabbitClient(); natsClient();"], lines: [1] },
      { path: "src/db.ts", added: ["open();"], lines: [1] },
    ];
    assert.deepEqual(
      (await selectForReview(db.reader, p, files)).map((u) => [u.key, u.because]),
      [
        ["trace:ext-s1/two-options", "an added line in src/a.ts names the option mongoClient"],
        ["trace:ext-s1/retired-anchor", "an added line in src/a.ts names the option natsClient"],
        ["trace:ext-s1/conflicted", "an added line in src/b.ts names the option rabbitClient"],
        ["trace:ext-s1/storage", "anchored to src/db.ts"],
      ],
    );
  } finally {
    await db.done();
  }
});

test("review selection still finds a location-free record when 32,767 of them exist, past SQLite's limit on bound values", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const n = 32_767;
    // Only the last one has an option: the list that overflowed held every location-free record, with or without options
    manyAdopted(db, p, n, (i) => ({
      key: `trace:ext-s1/r${i}`,
      kind: "decision",
      stance: i % 2 ? "dont" : "defer",
      ...(i === n - 1 ? { option: "lastVendorClient" } : {}),
    }));
    const free = db.owner
      .prepare(
        "select count(*) as n from unit u where project_id = ? and lifecycle = 'active' and stance in ('dont', 'defer') and not exists (select 1 from unit_anchor a where a.unit_id = u.id and a.retired_at is null)",
      )
      .get(p)?.n;
    assert.equal(free, n);
    const hits = await selectForReview(db.reader, p, [
      { path: "src/x.ts", added: ["const c = lastVendorClient();"], lines: [1] },
    ]);
    assert.deepEqual(
      hits.map((u) => [u.key, u.because]),
      [[`trace:ext-s1/r${n - 1}`, "an added line in src/x.ts names the option lastVendorClient"]],
    );
  } finally {
    await db.done();
  }
});
