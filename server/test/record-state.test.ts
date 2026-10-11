// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// What the record MCP server keeps between calls, through the server as a host calls it: reading the rest of a result changes nothing,
// and a cursor is good only for the result, the run, and the process that gave it.

import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { recordWorld } from "./record-world.ts";
import { insert, message, session } from "./temp-db.ts";

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

/** Enough observed edits that a session's closing part needs more than one page */
const manyEdits = (w: Awaited<ReturnType<typeof recordWorld>>, sessionId: string) => {
  for (let i = 0; i < 1500; i++)
    insert(w.db, "edit_observation", {
      session_id: sessionId,
      turn_id: "t1",
      tool_event_id: `${sessionId}-e${i}`,
      path: `src/${"d".repeat(40)}/file-${i}.ts`,
      via: "tool",
      observed_at: "2026-09-10T00:00:00.000Z",
    });
};

const looked = (w: Awaited<ReturnType<typeof recordWorld>>) =>
  w.db.owner
    .prepare("select distinct source_id from source_processing order by source_id")
    .all()
    .map((r) => Number(r.source_id));

test("record_context: a cursor of the closing part is refused for another run that has come just as far", async () => {
  const w = await recordWorld("tail-runs");
  try {
    // Two sessions with the same closing part, read by two runs to the same line
    for (const id of ["s1", "s2"]) {
      session(w.db, w.p, id);
      message(w.db, w.p, { id: `m-${id}`, text: "Edit these files.", session: id });
      manyEdits(w, id);
    }
    const a = await w.trace("s1");
    const b = await w.trace("s2");
    const first = async (run: string) =>
      /call record_context with after: "(t[0-9a-f]{8}\.(\d+))"/.exec(
        (await w.reply("record_context", { run })).text,
      );
    const [ca, cb] = [await first(a), await first(b)];
    assert.ok(ca && cb);
    assert.equal(ca[2], cb[2], "both runs stopped at the same line");
    assert.notEqual(ca[1], cb[1]);
    const crossed = await w.reply("record_context", { run: b, after: ca[1] });
    assert.ok(crossed.isError);
    assert.match(crossed.text, /is not a page this run was given/);
    // Its own cursor still reads on
    assert.ok(!(await w.reply("record_context", { run: b, after: cb[1] })).isError);
  } finally {
    await w.done();
  }
});

test("record_context: saving in the middle of the pages marks only the messages shown, one cut on purpose included, and the closing part's pages mark nothing", async () => {
  const w = await recordWorld("pages-state");
  try {
    const long = message(w.db, w.p, { id: "m0", text: `長い ${"文".repeat(20_000)}` });
    const ids = Array.from({ length: 30 }, (_, i) =>
      message(w.db, w.p, {
        id: `m${i + 1}`,
        text: `発言 ${i}: ${"あ".repeat(1500)}`,
        sent: `2026-09-10T00:${String(i + 1).padStart(2, "0")}:00Z`,
      }),
    );
    manyEdits(w, "s1");
    // Two pages read, then saved: the cut message and the ones beside it count, the rest still wait
    const run = await w.trace();
    const one = await w.reply("record_context", { run });
    assert.match(one.text, new RegExp(`read s${long}@\\d+ for the rest`));
    const two = await w.reply("record_context", {
      run,
      after: /call record_context with after: "(s\d+)"/.exec(one.text)?.[1],
    });
    const shown = [...`${one.text}\n${two.text}`.matchAll(/^## s(\d+) /gm)].map((m) => Number(m[1]));
    assert.ok(shown.includes(long) && shown.length > 1 && shown.length < 31, `${shown.length} shown`);
    assert.ok(!(await w.reply("record_save", { run, record: { units: [] } })).isError);
    assert.deepEqual(looked(w), shown);
    // A second run reads to the end: the pages of the closing part add nothing to what counts as looked at
    const next = await w.trace();
    const { pages, cursors } = await w.context(next);
    assert.ok(cursors.filter((c) => c.startsWith("t")).length >= 2, cursors.join(" "));
    // The closing part is the one made when the run first reached it: an edit observed since then moves none of its pages
    insert(w.db, "edit_observation", {
      session_id: "s1",
      turn_id: "t0",
      tool_event_id: "late",
      path: "aaa/first-in-order.ts",
      via: "tool",
      observed_at: "2026-09-09T00:00:00.000Z",
    });
    const closing = cursors.filter((c) => c.startsWith("t"));
    for (const [i, c] of closing.entries()) {
      const page = (await w.reply("record_context", { run: next, after: c })).text;
      assert.equal(
        page.replace(/id="[0-9a-f]+"/g, ""),
        (pages[pages.length - closing.length + i] ?? "").replace(/id="[0-9a-f]+"/g, ""),
      );
      assert.doesNotMatch(page, /first-in-order/);
    }
    assert.equal(pages.join("\n").match(/^## s\d+ /gm)?.length, 31);
    assert.ok(!(await w.reply("record_save", { run: next, record: { units: [] } })).isError);
    assert.deepEqual(looked(w), [long, ...ids]);
  } finally {
    await w.done();
  }
});

test("record_context: an automatic run reads two pages of targets, and the pages of the closing part do not count against them", async () => {
  const w = await recordWorld("auto-state");
  try {
    for (let i = 0; i < 40; i++)
      message(w.db, w.p, {
        id: `m${i}`,
        text: `発言 ${i}: ${"あ".repeat(1500)}`,
        sent: `2026-09-10T00:${String(i).padStart(2, "0")}:00Z`,
      });
    manyEdits(w, "s1");
    const run = await w.trace();
    const { pages, cursors } = await w.context(run, true);
    const shown = [...pages.join("\n").matchAll(/^## s(\d+) /gm)].map((m) => Number(m[1]));
    // Two pages of messages, then the closing part over several pages, with the stop said where the messages end
    assert.equal(cursors.filter((c) => c.startsWith("s")).length, 1);
    assert.ok(cursors.filter((c) => c.startsWith("t")).length >= 2, cursors.join(" "));
    assert.ok(shown.length > 6 && shown.length < 40, `${shown.length} shown`);
    assert.match(
      pages[1] ?? "",
      new RegExp(`This automatic run stops here: ${40 - shown.length} later messages are not shown`),
    );
    assert.match(pages.at(-1) ?? "", /Live records of this project/);
    // Having read the closing part, the page of targets is still the page it was: those pages used up none of the run's two
    const targets = cursors.find((c) => c.startsWith("s")) ?? "";
    const again = await w.reply("record_context", { run, after: targets, auto: true });
    assert.equal(again.text.replace(/id="[0-9a-f]+"/g, ""), (pages[1] ?? "").replace(/id="[0-9a-f]+"/g, ""));
    assert.ok(!(await w.reply("record_save", { run, record: { units: [] } })).isError);
    assert.deepEqual(looked(w), shown);
  } finally {
    await w.done();
  }
});

test("record_context: two calls for the same run at once both get cursors that work", async () => {
  const w = await recordWorld("context-twice");
  try {
    message(w.db, w.p, { id: "m1", text: "あ".repeat(20_000) });
    const run = await w.trace();
    const [a, b] = await Promise.all([
      w.reply("record_context", { run }),
      w.reply("record_context", { run }),
    ]);
    const cursor = (text: string) => /call record_context with after: "(t[^"]+)"/.exec(text)?.[1] ?? "";
    assert.ok(cursor(a.text) && cursor(b.text));
    for (const c of [cursor(a.text), cursor(b.text)]) {
      const next = await w.reply("record_context", { run, after: c });
      assert.ok(!next.isError, next.text);
      assert.match(next.text, /Live records of this project/);
    }
  } finally {
    await w.done();
  }
});

test("record_more: a result is read again as it was, and after the server restarts its cursor says the result is gone and what to do", async () => {
  const w = await recordWorld("more-restart");
  try {
    const said = message(w.db, w.p, { id: "m1", text: "Keep the retry in the client." });
    const run = await w.trace();
    await w.context(run);
    // Twenty findings, each warned about twenty times: more lines than one reply carries
    const record = {
      units: Array.from({ length: 20 }, (_, u) => ({
        key: `finding-${u}`,
        kind: "finding",
        text: `Finding ${u}`,
        evidence: [{ source: `s${said}`, quote: "Keep the retry in the client.", role: "states" }],
        anchors: Array.from({ length: 20 }, (_, a) => ({
          path: `src/${"d".repeat(300)}/missing-${u}-${a}.ts`,
          role: "applies_to",
        })),
      })),
    };
    const cursor = (text: string) => /call record_more with cursor: "([^"]+)"$/.exec(text)?.[1] ?? "";
    const checked = cursor((await w.reply("record_check", { run, record })).text);
    const saved = cursor((await w.reply("record_save", { run, record })).text);
    assert.match(checked, /^c[0-9a-f]{12}\.\d+$/);
    assert.match(saved, /^s[0-9a-f]{12}\.\d+$/);
    const rows = () =>
      ["unit", "unit_anchor", "source_processing", "extraction_run"].map((t) =>
        Number(w.db.owner.prepare(`select count(*) as n from ${t}`).get()?.n),
      );
    const before = rows();
    const page = await w.reply("record_more", { cursor: saved });
    assert.ok(!page.isError);
    assert.equal((await w.reply("record_more", { cursor: saved })).text, page.text);
    assert.deepEqual(rows(), before);
    await w.restart();
    const gone = await w.reply("record_more", { cursor: saved });
    assert.ok(gone.isError);
    assert.match(
      gone.text,
      /no longer kept .*The record was saved; do not save it again\. Find what it saved with search and read\.$/,
    );
    assert.match(
      (await w.reply("record_more", { cursor: checked })).text,
      /no longer kept .*Run record_check again: it gives the same result\.$/,
    );
    assert.deepEqual(rows(), before);
  } finally {
    await w.done();
  }
});
