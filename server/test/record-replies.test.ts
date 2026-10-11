// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The record MCP server's replies, through the server as a host calls it: each one stays within the reply budget. Codex drops the middle
// of a longer reply without a word, and what the record server says decides what an agent saves, marks as read, or asks the owner to
// confirm.

import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { recordWorld } from "./record-world.ts";
import { insert, message } from "./temp-db.ts";

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

test("record_context: pages of Japanese text stay within the reply budget, and every message is on one of them", async () => {
  const w = await recordWorld("context-pages");
  try {
    for (let i = 0; i < 40; i++)
      message(w.db, w.p, {
        id: `m${i}`,
        text: `発言 ${i}: ${"あ".repeat(1500)}`,
        sent: `2026-09-10T00:${String(i).padStart(2, "0")}:00Z`,
      });
    const { pages } = await w.context(await w.trace());
    assert.ok(pages.length > 4, `${pages.length} pages`);
    assert.equal(pages.join("\n").match(/^## s\d+ /gm)?.length, 40);
    for (let i = 0; i < 40; i++) assert.ok(pages.some((p) => p.includes(`発言 ${i}: `)));
    assert.match(pages.at(-1) ?? "", /Live records of this project/);
    // A page is not cut short for no reason: all but the last carry more than half the budget
    for (const p of pages.slice(0, -1))
      assert.ok(Buffer.byteLength(p) > 16 * 1024, `${Buffer.byteLength(p)} bytes`);
  } finally {
    await w.done();
  }
});

test("record_context: one message longer than a page is cut between characters, and names the byte of the stored text to read on from", async () => {
  const w = await recordWorld("context-long");
  try {
    const text = `始まり ${"い😀".repeat(12_000)} 終わり`;
    const long = message(w.db, w.p, { id: "m1", text });
    const { pages } = await w.context(await w.trace());
    const at = Number(
      new RegExp(`\\(cut here; read s${long}@(\\d+) for the rest\\)`).exec(pages[0] ?? "")?.[1],
    );
    assert.ok(at > 20_000, `${at}`);
    // The byte is a place in the stored text, between two characters: what the page shows ends there, and the rest starts there
    const stored = Buffer.from(text);
    const shown = stored.subarray(0, at).toString("utf8");
    assert.ok(!shown.includes("\ufffd") && !stored.subarray(at).toString("utf8").startsWith("\ufffd"));
    assert.ok((pages[0] ?? "").includes(`${shown.slice(-40)}\n(cut here;`));
    assert.doesNotMatch(pages.join("\n"), /終わり/);
    const rest = await w.reply("record_more", { cursor: "c0123456789ab.0" });
    assert.ok(rest.isError);
  } finally {
    await w.done();
  }
});

test("record_context: what comes from outside in a heading is cut, so a page always has room for the message", async () => {
  const w = await recordWorld("context-heading");
  try {
    w.db.owner
      .prepare(
        "insert into session (id, project_id, host, external_id, started_at) values (?, ?, 'claude-code', ?, ?)",
      )
      .run("s1", w.p, `long-${"x".repeat(40_000)}`, "2026-09-01T00:00:00.000Z");
    const said = message(w.db, w.p, { id: "m1", text: "Keep the retry in the client." });
    const run = await w.trace();
    assert.ok(run, "the run began");
    const { pages } = await w.context(run);
    assert.equal(pages.length, 1);
    assert.match(pages[0] ?? "", new RegExp(`^## s${said} owner `, "m"));
    assert.match(pages[0] ?? "", /Keep the retry in the client\./);
  } finally {
    await w.done();
  }
});

test("record_context: a closing part longer than a page goes on through the run's cursor, with every edit and every field definition whole", async () => {
  const w = await recordWorld("context-tail");
  try {
    const said = message(w.db, w.p, { id: "m1", text: "Track these fields." });
    const r = Number(
      w.db.owner
        .prepare(
          "insert into extraction_run (project_id, origin, target, status, started_at) values (?, 'trace', 'session:s1', 'saved', '2026-09-10T00:00:00.000Z') returning id",
        )
        .get(w.p)?.id,
    );
    for (let i = 0; i < 100; i++)
      insert(w.db, "field_def", {
        project_id: w.p,
        name: `field_${i}`,
        type: "text",
        label: `Field ${i}`,
        description: `${i} ${"説".repeat(300)} end${i}`,
        source_id: said,
        span_start: 0,
        span_end: 5,
        run_id: r,
        added_at: "2026-09-10T00:00:00.000Z",
      });
    for (let i = 0; i < 150; i++)
      insert(w.db, "edit_observation", {
        session_id: "s1",
        turn_id: "t1",
        tool_event_id: `e${i}`,
        path: `src/file-${i}.ts`,
        via: "tool",
        observed_at: "2026-09-10T00:00:00.000Z",
      });
    const run = await w.trace();
    const { pages, cursors } = await w.context(run);
    assert.ok(pages.length >= 3, `${pages.length} pages`);
    assert.ok(
      cursors.every((c) => /^t[0-9a-f]{8}\.\d+$/.test(c)),
      cursors.join(" "),
    );
    const all = pages.join("\n");
    for (let i = 0; i < 150; i++) assert.ok(all.includes(`- src/file-${i}.ts (tool, t1)`), `edit ${i}`);
    for (let i = 0; i < 100; i++) assert.ok(all.includes(` end${i}`), `the end of field ${i}'s description`);
    assert.doesNotMatch(all, /left out/);
    assert.match(pages.at(-1) ?? "", /Live records of this project[^\n]*\nNone\./);
    // The same cursor gives the same page, apart from the frame's id
    const again = async (c: string) =>
      (await w.reply("record_context", { run, after: c })).text.replace(/id="[0-9a-f]+"/g, "");
    assert.equal(await again(cursors[0] ?? ""), await again(cursors[0] ?? ""));
    assert.equal(await again(cursors[0] ?? ""), (pages[1] ?? "").replace(/id="[0-9a-f]+"/g, ""));
  } finally {
    await w.done();
  }
});

test("record_context: a terminal sequence in a message, cut or left open, hides nothing after that message", async () => {
  const w = await recordWorld("context-sequences");
  try {
    // A title sequence longer than the page: the cut lands inside it, and the note and the cursor come after it
    const long = message(w.db, w.p, {
      id: "m1",
      text: `Visible beginning\u001b]${"あ".repeat(12_000)}\u0007Visible end`,
    });
    // One left open: it swallows the rest of its own message at most
    const open = message(w.db, w.p, {
      id: "m2",
      text: "First part\u001b]never closed",
      sent: "2026-09-10T00:01:00Z",
    });
    const last = message(w.db, w.p, { id: "m3", text: "The message after.", sent: "2026-09-10T00:02:00Z" });
    const { pages } = await w.context(await w.trace());
    const all = pages.join("\n");
    assert.match(all, /Visible beginning/);
    assert.match(all, new RegExp(`^## s${open} owner [^\\n]*\\nFirst part$`, "m"));
    assert.match(all, new RegExp(`^## s${last} owner [^\\n]*\\nThe message after\\.$`, "m"));
    assert.match(pages.at(-1) ?? "", /Live records of this project/);
    // Where the long one stopped is said, and read goes on from there to its end
    const at = new RegExp(`\\(cut here; read s${long}@(\\d+) for the rest\\)`).exec(all)?.[1];
    if (at !== undefined) assert.ok(Number(at) > 0);
    else assert.match(all, /Visible beginningVisible end/);
    assert.ok(!all.includes("\u001b"));
  } finally {
    await w.done();
  }
});
