// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The record MCP server's replies, through the server as a host calls it: each one stays within the reply budget. Codex drops the middle
// of a longer reply without a word, and what the record server says decides what an agent saves, marks as read, or asks the owner to
// confirm.

import "./isolate-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { fakeIssueGh } from "./fake-gh.ts";
import { recordWorld } from "./record-world.ts";
import { insert, manyAdopted, message } from "./temp-db.ts";

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

/** Every page of a result, from its first reply through record_more, each within the budget and each further on than the last */
async function result(w: Awaited<ReturnType<typeof recordWorld>>, first: { text: string; isError: boolean }) {
  const pages = [first.text];
  let at = -1;
  for (;;) {
    const cursor = /call record_more with cursor: "([^"]+)"$/.exec(pages.at(-1) ?? "")?.[1];
    if (!cursor) return pages;
    const position = Number(cursor.split(".")[1]);
    assert.ok(position > at, `the cursor went from ${at} to ${position}`);
    at = position;
    const next = await w.reply("record_more", { cursor });
    assert.ok(!next.isError, next.text.slice(0, 300));
    pages.push(next.text);
  }
}

/** Twenty findings, each quoting the message and anchored to twenty paths that are not in the working tree */
const anchored = (source: number) => ({
  units: Array.from({ length: 20 }, (_, u) => ({
    key: `finding-${u}`,
    kind: "finding",
    text: `Finding ${u}`,
    evidence: [{ source: `s${source}`, quote: "Keep the retry in the client.", role: "states" }],
    anchors: Array.from({ length: 20 }, (_, a) => ({
      path: `src/${"d".repeat(300)}/missing-${u}-${a}.ts`,
      role: "applies_to",
    })),
  })),
});

test("record_check and record_save: the verdict and the counts come first, and warnings that do not fit are read on without saving again", async () => {
  const w = await recordWorld("results-saved");
  try {
    const said = message(w.db, w.p, { id: "m1", text: "Keep the retry in the client." });
    const run = await w.trace();
    await w.context(run);
    const checked = await result(w, await w.reply("record_check", { run, record: anchored(said) }));
    assert.match(checked[0] ?? "", /^✓ 20 records can be saved\nIn all: 20 active, \d+ warnings\n/);
    assert.ok(checked.length >= 3, `${checked.length} pages`);
    const count = Number(/, (\d+) warnings\n/.exec(checked[0] ?? "")?.[1]);
    assert.equal(checked.join("\n").match(/^△ /gm)?.length, count);
    assert.equal(checked.join("\n").match(/^✓ would be active: /gm)?.length, 20);
    // Nothing was written by the check or by reading its pages
    const units = () => Number(w.db.owner.prepare("select count(*) as n from unit").get()?.n);
    assert.equal(units(), 0);
    const first = await w.reply("record_save", { run, record: anchored(said) });
    assert.ok(!first.isError, first.text.slice(0, 300));
    const saved = await result(w, first);
    assert.match(saved[0] ?? "", /^✓ saved\nIn all: 20 active, \d+ warnings\n/);
    assert.equal(saved.join("\n").match(/^✓ trace:\S+ active$/gm)?.length, 20);
    assert.equal(saved.join("\n").match(/^△ /gm)?.length, count);
    // Reading the pages again saves nothing again, and the run stays saved
    assert.equal(units(), 20);
    assert.deepEqual(await result(w, first), saved);
    assert.equal(units(), 20);
    const again = await w.reply("record_save", { run, record: anchored(said) });
    assert.ok(again.isError);
    assert.match(again.text, /This run was already saved/);
  } finally {
    await w.done();
  }
});

test("record_check and record_save: a record with many errors is refused with the count first, nothing is written, and the run can save again", async () => {
  const w = await recordWorld("results-refused");
  try {
    const said = message(w.db, w.p, { id: "m1", text: "Keep the retry in the client." });
    const run = await w.trace();
    await w.context(run);
    // Every unit, and every option of it, cites sources the project does not have: thousands of errors
    let n = 0;
    const missing = (count: number) =>
      Array.from({ length: count }, () => ({
        source: `s9${String(n++).padStart(14, "0")}`,
        quote: "nothing",
        role: "states",
      }));
    const record = {
      units: Array.from({ length: 30 }, (_, u) => ({
        key: `${"k".repeat(50)}-${u}`,
        kind: "finding",
        text: `Finding ${u}`,
        evidence: missing(20),
        options: Array.from({ length: 12 }, (_, o) => ({
          text: `Option ${o}`,
          outcome: "proposed",
          evidence: missing(10),
        })),
      })),
    };
    const checked = await result(w, await w.reply("record_check", { run, record }));
    const errors = Number(/^✗ (\d+) errors; fix the record and check again\n/.exec(checked[0] ?? "")?.[1]);
    assert.ok(errors >= 4000, `${errors} errors`);
    assert.ok(checked.length >= 3, `${checked.length} pages`);
    assert.equal(checked.join("\n").match(/^✗ .*not a source of this project/gm)?.length, errors);
    const refused = await w.reply("record_save", { run, record });
    assert.ok(refused.isError);
    assert.match(
      refused.text,
      new RegExp(`^✗ ${errors} errors; nothing was saved\\. Fix the record, check it, and save again\\n✗ `),
    );
    const pages = await result(w, refused);
    assert.equal(pages.join("\n").match(/^✗ .*not a source of this project/gm)?.length, errors);
    assert.equal(Number(w.db.owner.prepare("select count(*) as n from unit").get()?.n), 0);
    assert.equal(Number(w.db.owner.prepare("select count(*) as n from source_processing").get()?.n), 0);
    // One unknown key of 40 KB is an error that fits a page
    const key = await w.reply("record_check", { run, record: { units: [], ["z".repeat(40_000)]: 1 } });
    assert.match(key.text, /^✗ 1 error; fix the record and check again\n✗ /);
    // The same run saves once the record is right
    const ok = await w.reply("record_save", {
      run,
      record: {
        units: [
          {
            key: "retry",
            kind: "finding",
            text: "Retry in the client",
            evidence: [{ source: `s${said}`, quote: "Keep the retry in the client.", role: "states" }],
          },
        ],
      },
    });
    assert.ok(!ok.isError, ok.text);
    assert.match(ok.text, /^✓ saved\nIn all: 1 active\n✓ trace:ext-s1\/retry active$/);
  } finally {
    await w.done();
  }
});

test("glean_fetch: everything is kept, the count comes first, and the list names refs only, read on without fetching again", async () => {
  const gh = fakeIssueGh(9, 1500, `SECRET ${"の".repeat(120)}`);
  const w = await recordWorld("fetch-pages", { PATH: gh.path }, () => ({
    action: "accept",
    content: { confirm: "1" },
  }));
  try {
    message(w.db, w.p, { id: "m1", text: "Look at issue 9." });
    const run = /^run: (\S+)/.exec((await w.reply("glean_begin", { session: "s1" })).text)?.[1] ?? "";
    const first = await w.reply("glean_fetch", { run, url: "https://github.com/o/fetch-pages/issues/9" });
    assert.ok(!first.isError, first.text.slice(0, 300));
    assert.match(
      first.text,
      /^1501 sources kept\. Read each with read s<id>, then cite the refs:\n<past-records id="[0-9a-f]+">\n/,
    );
    const pages = await result(w, first);
    assert.ok(pages.length >= 2, `${pages.length} pages`);
    // Every source kept is listed once, by the id read takes, and each page frames what comes from the commenters (their names)
    const listed = pages.flatMap((p) =>
      [...p.matchAll(/^- s(\d+) (issue_body|issue_comment) by someone$/gm)].map((m) => Number(m[1])),
    );
    assert.equal(new Set(listed).size, 1501);
    assert.equal(
      Number(w.db.owner.prepare("select count(*) as n from source where kind like 'issue%'").get()?.n),
      1501,
    );
    for (const p of pages)
      assert.match(p, /<past-records id="[0-9a-f]+">\n[\s\S]*\n<\/past-records id="[0-9a-f]+">/);
    // No word of a source is in the list: what a server keeps for record_more outlives a forget made from another session
    assert.doesNotMatch(pages.join("\n"), /SECRET|の/);
    // Reading the pages asked gh for nothing more
    const calls = fs.readFileSync(gh.calls, "utf8").trim().split("\n").length;
    assert.deepEqual(await result(w, first), pages);
    assert.equal(fs.readFileSync(gh.calls, "utf8").trim().split("\n").length, calls);
    // A forget in this session clears what it kept: the list's cursor is gone with it
    const cursor = /cursor: "([^"]+)"$/.exec(first.text)?.[1] ?? "";
    assert.ok(!(await w.reply("forget_apply", { sources: [`s${listed.at(-1)}`] })).isError);
    const stale = await w.reply("record_more", { cursor });
    assert.ok(stale.isError);
    assert.match(
      stale.text,
      /no longer kept .*sources were forgotten since.*The sources were kept; do not fetch again/,
    );
  } finally {
    await w.done();
  }
});

test("forget: every source and the count are always shown, and the records affected are counted by what becomes of them and read on", async () => {
  let asked = "";
  const w = await recordWorld("forget-pages", {}, (m) => {
    asked = m;
    return { action: "accept", content: { confirm: "50" } };
  });
  try {
    // One message 300 decisions rest on, and 49 more sources with long names
    manyAdopted(w.db, w.p, 300, (i) => ({
      key: `trace:${"k".repeat(150)}/decision-${i}`,
      kind: "decision",
      stance: "do",
    }));
    const cited = Number(
      w.db.owner.prepare("select id from source where external_id = 'many-300'").get()?.id,
    );
    const others = Array.from({ length: 49 }, (_, i) =>
      insert(w.db, "source", {
        project_id: w.p,
        kind: "issue_comment",
        artifact: `issue:${"9".repeat(300)}${i}`,
        external_id: `comment:${i}`,
        revision: 1,
        author_kind: "person",
        created_at: "2026-09-10T00:00:00.000Z",
        available_at: "2026-09-10T00:00:00.000Z",
        captured_at: "2026-09-10T00:00:00.000Z",
        text: `comment ${i}`,
        original_bytes: Buffer.byteLength(`comment ${i}`),
        content_hash: Buffer.alloc(32, i),
        indexed: 0,
      }),
    );
    const sources = [cited, ...others].map((id) => `s${id}`);
    const must = (text: string) => {
      for (const ref of sources)
        assert.match(text, new RegExp(`^- ${ref} (session_message|issue_comment) in `, "m"));
      assert.match(
        text,
        /^300 records affected: 300 leave active, 0 become active, 0 change state otherwise, 0 keep their state$/m,
      );
      assert.match(text, /^Records keep their own text: /m);
      assert.match(text, /^Copies outside the database /m);
    };
    const records = (pages: string[]) =>
      pages.flatMap((p) =>
        [
          ...p.matchAll(/^- record trace:k{150}\/decision-(\d+): active → candidate, loses 2 citations$/gm),
        ].map((m) => Number(m[1])),
      );
    const preview = await w.reply("forget_preview", { sources });
    assert.ok(!preview.isError, preview.text.slice(0, 300));
    must(preview.text);
    const previewed = await result(w, preview);
    assert.ok(previewed.length >= 2, `${previewed.length} pages`);
    assert.equal(new Set(records(previewed)).size, 300);
    // The owner confirms against every source and the count, within a size a dialog can show
    const applied = await w.reply("forget_apply", { sources });
    assert.ok(!applied.isError, applied.text.slice(0, 300));
    assert.ok(Buffer.byteLength(asked) <= 32 * 1024, `${Buffer.byteLength(asked)} bytes in the dialog`);
    assert.match(asked, /^Forget 50 sources for good\?\n/);
    must(asked);
    assert.match(asked, /^and \d+ more records: forget_preview lists every one$/m);
    assert.match(applied.text, /^Forgot 50 sources\.\n/);
    must(applied.text);
    assert.match(applied.text, /^The deleted text was cleared from the database file\.$/m);
    assert.equal(new Set(records(await result(w, applied))).size, 300);
    // What was kept before the forget is gone with it: a kept line may quote a source
    const stale = await w.reply("record_more", {
      cursor: /cursor: "([^"]+)"$/.exec(preview.text)?.[1] ?? "",
    });
    assert.ok(stale.isError);
    assert.match(stale.text, /no longer kept .*sources were forgotten since/);
    assert.equal(Number(w.db.owner.prepare("select count(*) as n from source").get()?.n), 0);
  } finally {
    await w.done();
  }
});
