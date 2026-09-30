// The offline retrieval benchmark must run in verify: experiments on search are judged with it, so one that cannot run, or runs with
// fewer questions, fails here. Its numbers are compared by the experiment's own pull request, never gated here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bench } from "../evals/retrieval/bench.ts";

test("the retrieval benchmark runs every question and gives a number for each measure", async () => {
  const r = await bench();
  assert.equal(r.all.answerable, 48);
  assert.equal(r.all.unanswerable, 12);
  for (const [k, v] of Object.entries({ ...r.all.recall, mrr: r.all.mrr, falseHit: r.all.falseHit }))
    assert.ok(!Number.isNaN(v), `${k} is a number`);
  assert.deepEqual([...r.byLang.keys()], ["en>en", "en>ja", "ja>en", "ja>ja"]);
});
