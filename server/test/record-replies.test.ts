// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The record MCP server's replies, through the server as a host calls it: each one stays within the reply budget. Codex drops the middle
// of a longer reply without a word, and what the record server says decides what an agent saves, marks as read, or asks the owner to
// confirm.

import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { recordWorld } from "./record-world.ts";

test("an error the SDK builds itself, repeating what the caller sent, stays within the reply budget and stays an error", async () => {
  const w = await recordWorld("record-error");
  try {
    // A tool name the server does not have, and a property a tool's schema refuses, each 40 KB: no tool runs for either
    const unknownTool = await w.reply("x".repeat(40_000));
    assert.ok(unknownTool.isError);
    assert.match(unknownTool.text, /x{1000}/);
    assert.match(unknownTool.text, /\n\(This error was cut to keep the reply within 32 KiB\.\)$/);
    const unknownKey = await w.reply("record_context", { run: "r", ["k".repeat(40_000)]: 1 });
    assert.ok(unknownKey.isError);
    assert.match(unknownKey.text, /\n\(This error was cut to keep the reply within 32 KiB\.\)$/);
    // A terminal sequence in what the caller sent is not left open by the cut
    const title = await w.reply(`\u001b]0;${"t".repeat(40_000)}\u0007 tail`);
    assert.ok(title.isError);
    assert.ok(!title.text.includes("\u001b"));
    // Within the budget, an error is what the SDK built, byte for byte
    const small = "\u001b]0;t\u0007 tail";
    assert.equal((await w.reply(small)).text, `MCP error -32602: Tool ${small} not found`);
  } finally {
    await w.done();
  }
});
