// The offline retrieval benchmark must run in verify: experiments on search are judged with it, so one that cannot run, or runs with
// fewer questions, fails here. Its numbers are compared by the experiment's own pull request, never gated here.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("--compare refuses a ref outside this checkout's history, since the ref's code would run", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-bench-home-"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.SPHICA_DB;
  delete env.SPHICA_HOME;
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
