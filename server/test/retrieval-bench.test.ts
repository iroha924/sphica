// The offline retrieval benchmark must run in verify: experiments on search are judged with it, so one that cannot run, or runs with
// fewer questions, fails here. Its numbers are compared by the experiment's own pull request, never gated here.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { bench, misses } from "../evals/retrieval/bench.ts";

test("the retrieval benchmark runs every question and gives a number for each measure", async () => {
  const r = await bench();
  assert.equal(r.all.answerable, 93);
  assert.equal(r.all.unanswerable, 20);
  for (const [k, v] of Object.entries({ ...r.all.recall, mrr: r.all.mrr, falseHit: r.all.falseHit }))
    assert.ok(!Number.isNaN(v), `${k} is a number`);
  assert.deepEqual([...r.byLang.keys()], ["en>en", "en>ja", "ja>en", "ja>ja"]);
});

/** A child's environment: a temporary home, and none of the owner's Sphica paths. */
function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.SPHICA_DB;
  delete env.SPHICA_HOME;
  return env;
}

test("--compare refuses a ref outside this checkout's history, since the ref's code would run", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-bench-home-"));
  const env = childEnv(home);
  // A commit object no ref points to: made without touching any branch
  const loose = execFileSync("git", ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "not in history"], {
    encoding: "utf8",
    env: {
      ...env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  }).trim();
  const r = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, "..", "evals", "retrieval", "run.ts"), "--compare", loose],
    { encoding: "utf8", env },
  );
  fs.rmSync(home, { recursive: true, force: true });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not in this checkout's history/);
});

test("--compare with --json is refused, since --json prints one side only", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-bench-home-"));
  const r = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, "..", "evals", "retrieval", "run.ts"), "--compare", "HEAD", "--json"],
    { encoding: "utf8", env: childEnv(home) },
  );
  fs.rmSync(home, { recursive: true, force: true });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--json prints this tree only/);
});

/** A one-record corpus with what an experiment's question sets need: anchors, a save time, and an implementation's code evidence. */
const record = (over: Record<string, unknown> = {}) => ({
  key: "reader",
  kind: "implementation",
  stance: null,
  message: "connectReader opens the reader connection read only.",
  quote: "connectReader opens the reader connection read only.",
  text: "connectReader opens the reader connection read only",
  why: null,
  options: [],
  aliases: [],
  supersedes: null,
  anchors: [{ path: "server/src/db.ts", symbol: "connectReader" }],
  created_at: "2026-03-04T05:06:07.000Z",
  ...over,
});

test("a record's anchors, save time, and code evidence are stored as written, and its question is scored by set", async () => {
  const before = Date.now;
  const r = await bench({
    records: [record()],
    questions: [
      { id: "i1", lang: "en>en", overlap: true, text: "reader connection", gold: ["reader"], set: "ident" },
    ],
  });
  assert.equal(Date.now, before, "the bench puts the clock back");
  assert.equal(r.rows[0]?.rank, 1);
  assert.deepEqual([...r.bySet.keys()], ["set ident"]);
});

test("the bench stops when a record cannot be stored as written", async () => {
  await assert.rejects(
    bench({ records: [record({ anchors: [{ path: "/abs/db.ts" }] })], questions: [] }),
    /record reader: .*not inside the repository/,
  );
});

test("a missed Japanese question is told apart by whether its words were cut differently or are other words", async () => {
  const corpus = {
    records: [
      record({
        key: "read-shelf",
        kind: "decision",
        stance: "do",
        message: "既読本は下段に出す。",
        quote: "既読本は下段に出す。",
        text: "既読本は下段に出す",
        anchors: [],
      }),
    ],
    questions: [
      // The question cuts the record's compound into three words; the record holds the first and a two-character compound
      { id: "s", lang: "ja>ja", overlap: true, text: "既読の本の場所", gold: ["read-shelf"] },
    ],
  };
  const [m] = misses(await bench(corpus), corpus);
  assert.equal(m?.id, "s");
  assert.deepEqual(m?.matched, ["既"]);
  assert.deepEqual(m?.missing, [
    { term: "読", cause: "split" },
    { term: "本", cause: "split" },
    { term: "場所", cause: "vocabulary" },
  ]);
  assert.equal(m?.cause, "mixed");
  assert.equal(m?.splitAlone, true);
});
