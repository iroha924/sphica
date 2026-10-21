// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

import "./isolate-home.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { partProblems as problemsOf } from "../../scripts/lib/check-parts.mjs";

const partProblems = (...args: Parameters<typeof problemsOf>) => problemsOf(...args).map((p) => p.what);

const SCRIPT = path.join(import.meta.dirname, "..", "..", "scripts", "check-parts.mjs");
const PR_DETECTOR = { result: "skipped", outputs: {} };
const pushDetector = (result: string, tested: string | undefined) => ({
  result,
  outputs: tested === undefined ? {} : { tested },
});

test("on a pull request the check passes only when every expected part job succeeded and same-tree was skipped", () => {
  assert.deepEqual(
    partProblems({ "same-tree": PR_DETECTOR, part: { result: "success" } }, ["part"], "pull_request"),
    [],
  );
  for (const result of ["failure", "cancelled", "skipped"])
    assert.deepEqual(
      partProblems({ "same-tree": PR_DETECTOR, part: { result } }, ["part"], "pull_request"),
      [`part ended ${result}`],
      result,
    );
  // A detector that ran on a pull request, even with tested=true, lets nothing skip
  assert.deepEqual(
    partProblems(
      { "same-tree": pushDetector("success", "true"), part: { result: "skipped" } },
      ["part"],
      "pull_request",
    ),
    ["same-tree ended success on a pull request", "part ended skipped"],
  );
});

test("on a push the parts may be skipped only when same-tree succeeded with tested=true", () => {
  const table: [ReturnType<typeof pushDetector>, string, string[]][] = [
    [pushDetector("success", "true"), "skipped", []],
    [pushDetector("success", "true"), "success", []],
    [pushDetector("success", "false"), "success", []],
    [pushDetector("success", "false"), "skipped", ["part ended skipped"]],
    [pushDetector("success", undefined), "skipped", ["part ended skipped"]],
    [pushDetector("success", "yes"), "skipped", ["part ended skipped"]],
    // The push's own checks failed: the run fails whatever the parts did, and tested=true written before the failure counts for nothing
    [pushDetector("failure", "true"), "skipped", ["same-tree ended failure", "part ended skipped"]],
    [pushDetector("failure", undefined), "success", ["same-tree ended failure"]],
    [pushDetector("cancelled", undefined), "success", ["same-tree ended cancelled"]],
    [pushDetector("skipped", undefined), "success", ["same-tree ended skipped"]],
    [pushDetector("success", "true"), "failure", ["part ended failure"]],
    [pushDetector("success", "true"), "cancelled", ["part ended cancelled"]],
  ];
  for (const [detector, result, want] of table)
    assert.deepEqual(
      partProblems({ "same-tree": detector, part: { result } }, ["part"], "push"),
      want,
      `${JSON.stringify(detector)} ${result}`,
    );
});

test("a missing, unexpected, or malformed need, or an unknown event, fails the check", () => {
  assert.deepEqual(partProblems({ "same-tree": PR_DETECTOR }, ["part"], "pull_request"), [
    "part is not in needs",
  ]);
  assert.deepEqual(partProblems({ part: { result: "success" } }, ["part"], "pull_request"), [
    "same-tree is not in needs",
  ]);
  assert.deepEqual(
    partProblems(
      { "same-tree": PR_DETECTOR, part: { result: "success" }, other: { result: "success" } },
      ["part"],
      "pull_request",
    ),
    ["other is in needs but not expected"],
  );
  assert.deepEqual(partProblems({ part: { result: "success" } }, [], "pull_request"), [
    "no part job is expected",
  ]);
  for (const needs of [null, [], "success"])
    assert.deepEqual(partProblems(needs, ["part"], "pull_request"), ["the needs context is not an object"]);
  for (const event of [undefined, "", "workflow_dispatch", "PUSH"])
    assert.deepEqual(
      partProblems({ "same-tree": PR_DETECTOR, part: { result: "success" } }, ["part"], event),
      [`the event ${JSON.stringify(event)} is neither push nor pull_request`],
    );
});

test("the script exits 1 on a failed part, unreadable NEEDS, or no EVENT, and 0 when all succeeded", () => {
  const run = (needs: string, event: string | null = "pull_request") => {
    const env: NodeJS.ProcessEnv = { ...process.env, NEEDS: needs };
    if (event === null) delete env.EVENT;
    else env.EVENT = event;
    return spawnSync(process.execPath, [SCRIPT, "part"], { env, encoding: "utf8" });
  };
  const ok = run(JSON.stringify({ "same-tree": PR_DETECTOR, part: { result: "success", outputs: {} } }));
  assert.equal(ok.status, 0, ok.stderr);
  const tested = run(
    JSON.stringify({
      "same-tree": pushDetector("success", "true"),
      part: { result: "skipped", outputs: {} },
    }),
    "push",
  );
  assert.equal(tested.status, 0, tested.stderr);
  const failed = run(JSON.stringify({ "same-tree": PR_DETECTOR, part: { result: "failure", outputs: {} } }));
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /part ended failure/);
  const broken = run("not json");
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /not an object/);
  const noEvent = run(
    JSON.stringify({ "same-tree": PR_DETECTOR, part: { result: "success", outputs: {} } }),
    null,
  );
  assert.equal(noEvent.status, 1);
  assert.match(noEvent.stderr, /neither push nor pull_request/);
});

test("macos is judged like a part: it must succeed on a pull request and may be skipped only on a tested push", () => {
  const jobs = ["part", "macos"];
  assert.deepEqual(
    partProblems(
      { "same-tree": PR_DETECTOR, part: { result: "success" }, macos: { result: "failure" } },
      jobs,
      "pull_request",
    ),
    ["macos ended failure"],
  );
  assert.deepEqual(
    partProblems({ "same-tree": PR_DETECTOR, part: { result: "success" } }, jobs, "pull_request"),
    ["macos is not in needs"],
  );
  assert.deepEqual(
    partProblems(
      {
        "same-tree": pushDetector("success", "true"),
        part: { result: "skipped" },
        macos: { result: "skipped" },
      },
      jobs,
      "push",
    ),
    [],
  );
});
