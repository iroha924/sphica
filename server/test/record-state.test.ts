// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// What the record MCP server keeps between calls, through the server as a host calls it: reading the rest of a result changes nothing,
// and a cursor is good only for the result, the run, and the process that gave it.

import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { recordWorld } from "./record-world.ts";

test("record_more refuses a cursor no reply gave, and says so when the result is not kept by this process", async () => {
  const w = await recordWorld("more-gone");
  try {
    const shape = await w.reply("record_more", { cursor: "nonsense" });
    assert.ok(shape.isError);
    // A cursor from a server that has since restarted: the letter still says what made it
    const gone = await w.reply("record_more", { cursor: "s0123456789ab.40" });
    assert.ok(gone.isError);
    assert.match(
      gone.text,
      /^Sphica: This result is no longer kept \(the record server restarted, or newer results took its place\)\. The record was saved; do not save it again\./,
    );
  } finally {
    await w.done();
  }
});
