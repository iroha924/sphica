// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The offline order benchmark: the crowded file holds more records than one delivery shows, so the ordering rule decides what lands
// inside the limits, and the bench reads that from what the hooks really returned.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { keysIn, LIGHT, orderBench, WEIGHTY } from "../evals/order/bench.ts";

test("keys are read only from their own delivery lines", () => {
  assert.deepEqual(
    keysIn("lead\n- trace:a/b (decision do): text naming - trace:c/d (x)\n- harvest:1/e (finding): y"),
    ["trace:a/b", "harvest:1/e"],
  );
});

test("the crowded file holds more records than a delivery shows, and the bench counts only those records", async () => {
  const r = await orderBench();
  const crowded = [...WEIGHTY, ...LIGHT];
  // Without more candidates than room, the order would decide nothing
  assert.ok(crowded.length > 5);
  for (const e of r.events) {
    assert.ok(e.shown.length > 0 && e.shown.length <= 5, `${e.event}: ${e.shown.length}`);
    assert.ok(e.chars <= 1500 + 400, `${e.event}: ${e.chars}`);
    for (const k of e.shown)
      assert.ok(crowded.includes(k), `${e.event} shows ${k}, which is not a crowded record`);
  }
  assert.deepEqual(
    r.events.map((e) => e.event),
    ["pre_read", "pre_edit"],
  );
  assert.equal(r.weighty.of, WEIGHTY.length * 2);
  assert.equal(
    r.weighty.shown + r.light.shown,
    r.events.reduce((n, e) => n + e.shown.length, 0),
  );
});

test("the order bench compares only with a ref this checkout's history holds", () => {
  const r = spawnSync(
    process.execPath,
    [
      path.join(import.meta.dirname, "..", "evals", "order", "run.ts"),
      "--compare",
      "0000000000000000000000000000000000000000",
    ],
    {
      encoding: "utf8",
      cwd: path.join(import.meta.dirname, ".."),
    },
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not in this checkout's history/);
});
