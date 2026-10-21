// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Which version check a push to main runs: a reused pull request run's verdict only when the run and its artifact are what same-tree named
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mainCheckArgs } from "../../scripts/lib/main-version.mjs";

const reused = {
  tested: "true",
  run: "7",
  attempt: "2",
  repo: "o/r",
  apiRun: { id: 7, run_attempt: 2, head_repository: { full_name: "o/r" } },
  verdict: { run: { id: "7", attempt: "2" } },
  verdictAttempt: "2",
  file: "/tmp/v.json",
};

test("a push the full jobs check defers the dependency files to them", () => {
  assert.deepEqual(mainCheckArgs({ ...reused, tested: "false" }).args, ["--defer-deps"]);
  assert.deepEqual(mainCheckArgs({ ...reused, tested: undefined }).args, ["--defer-deps"]);
});

test("a reused run passes its verdict on only when the run, its attempt, its repository, and the artifact agree", () => {
  assert.deepEqual(mainCheckArgs(reused).args, ["--verdict", "/tmp/v.json"]);
  for (const [change, why] of [
    [{ apiRun: "the API request failed" }, /could not be read/],
    [{ apiRun: null }, /could not be read/],
    [
      { apiRun: { id: 7, run_attempt: 3, head_repository: { full_name: "o/r" } } },
      /attempt 3, not 7 attempt 2/,
    ],
    [
      { apiRun: { id: 7, run_attempt: 2, head_repository: { full_name: "fork/r" } } },
      /not from o\/r's own branches/,
    ],
    [{ verdict: null }, /left no release verdict/],
    [{ verdict: { run: { id: "7", attempt: "1" } } }, /not from run 7 attempt 2, up to attempt 2/],
  ] as const) {
    const out = mainCheckArgs({ ...reused, ...change });
    assert.deepEqual(out.args, [], JSON.stringify(change));
    assert.match(out.reason, why);
  }
});

test("a verdict written by an earlier attempt of the reused run stands, one from a later attempt does not", () => {
  const earlier = mainCheckArgs({
    ...reused,
    verdict: { run: { id: "7", attempt: "1" } },
    verdictAttempt: "1",
  });
  assert.deepEqual(earlier.args, ["--verdict", "/tmp/v.json"], earlier.reason);
  const later = mainCheckArgs({
    ...reused,
    verdict: { run: { id: "7", attempt: "3" } },
    verdictAttempt: "3",
  });
  assert.deepEqual(later.args, []);
  const mislabeled = mainCheckArgs({
    ...reused,
    verdict: { run: { id: "7", attempt: "2" } },
    verdictAttempt: "1",
  });
  assert.deepEqual(mislabeled.args, []);
});
