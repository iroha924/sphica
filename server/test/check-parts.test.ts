// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

import "./isolate-home.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { partProblems } from "../../scripts/lib/check-parts.mjs";

const SCRIPT = path.join(import.meta.dirname, "..", "..", "scripts", "check-parts.mjs");

test("the check passes only when every expected part job succeeded", () => {
  assert.deepEqual(partProblems({ part: { result: "success" } }, ["part"]), []);
  for (const result of ["failure", "cancelled", "skipped"])
    assert.deepEqual(partProblems({ part: { result } }, ["part"]), [`part ended ${result}`], result);
});

test("a missing, unexpected, or malformed need fails the check", () => {
  assert.deepEqual(partProblems({}, ["part"]), ["part is not in needs"]);
  assert.deepEqual(partProblems({ part: { result: "success" }, other: { result: "success" } }, ["part"]), [
    "other is in needs but not expected",
  ]);
  assert.deepEqual(partProblems({ part: { result: "success" } }, []), ["no part job is expected"]);
  for (const needs of [null, [], "success"])
    assert.deepEqual(partProblems(needs, ["part"]), ["the needs context is not an object"]);
});

test("the script exits 1 on a failed part or unreadable NEEDS, and 0 when all succeeded", () => {
  const run = (needs: string) =>
    spawnSync(process.execPath, [SCRIPT, "part"], {
      env: { ...process.env, NEEDS: needs },
      encoding: "utf8",
    });
  const ok = run(JSON.stringify({ part: { result: "success", outputs: {} } }));
  assert.equal(ok.status, 0, ok.stderr);
  const failed = run(JSON.stringify({ part: { result: "failure", outputs: {} } }));
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /part ended failure/);
  const broken = run("not json");
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /not an object/);
});
