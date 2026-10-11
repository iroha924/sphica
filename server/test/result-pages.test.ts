// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The kept lines of a result: every page within the reply budget, every line reached, and a cursor that either gives its page again or
// says the result is gone and what to do.

import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { READ_BUDGET } from "../src/reply-budget.ts";
import { firstPage, morePage, pieces } from "../src/result-pages.ts";

const size = (s: string) => Buffer.byteLength(s);
const next = (text: string) => /call record_more with cursor: "([^"]+)"$/.exec(text)?.[1];

/** Every page of a result from its first reply, each within the budget */
function all(first: string, projectId: number): string[] {
  const pages = [first];
  let at = -1;
  for (let c = next(first); c; c = next(pages.at(-1) ?? "")) {
    // Every cursor is further on than the one before: a page that carried nothing would name the same place for ever
    const position = Number(c.split(".")[1]);
    assert.ok(position > at, `the cursor went from ${at} to ${position}`);
    at = position;
    pages.push(morePage(c, projectId));
  }
  for (const p of pages) assert.ok(size(p) <= READ_BUDGET, `${size(p)} bytes`);
  return pages;
}

test("a kept line is plain, on one line, and split between characters when it is too long for a page to carry", () => {
  assert.deepEqual(pieces("✓ short"), ["✓ short"]);
  assert.deepEqual(pieces("two\nlines \u001b[31mred"), ["two lines red"]);
  const long = `✗ ${"記".repeat(20_000)} end`;
  const split = pieces(long);
  assert.ok(split.length > 10);
  for (const p of split) assert.ok(size(p) <= 4096, `${size(p)} bytes`);
  // The last piece counts its own mark too
  assert.deepEqual(
    pieces("x".repeat(8184)).map((p) => size(p) <= 4096),
    [true, true, true],
  );
  // Nothing is lost: the pieces without their cut marks are the line
  assert.equal(split.map((p) => p.replace(/^… /, "").replace(/ …$/, "")).join(""), long);
  assert.ok(
    split.slice(1).every((p) => p.startsWith("… ")) && split.slice(0, -1).every((p) => p.endsWith(" …")),
  );
});

test("a result that fits is one reply and keeps nothing; one that does not is read to its end through its cursors", () => {
  const small = firstPage({
    kind: "check",
    projectId: 1,
    lead: ["✓ 2 records can be saved"],
    lines: ["✓ a", "✓ b"],
  });
  assert.equal(small, "✓ 2 records can be saved\n✓ a\n✓ b");
  const lines = Array.from({ length: 900 }, (_, i) => `△ line ${i} ${"w".repeat(100)}`);
  const first = firstPage({ kind: "check", projectId: 1, lead: ["✗ 900 errors"], lines });
  assert.match(first, /^✗ 900 errors\n△ line 0 /);
  assert.match(first, /\n\d+ more lines: call record_more with cursor: "c[0-9a-f]{12}\.\d+"$/);
  const pages = all(first, 1);
  assert.ok(pages.length >= 3);
  const seen = pages.flatMap((p) => p.split("\n").filter((l) => l.startsWith("△ line ")));
  assert.deepEqual(seen, lines);
  // The lead is on the first page only, and the last page names no cursor
  assert.ok(pages.slice(1).every((p) => !p.includes("900 errors")));
  assert.equal(next(pages.at(-1) ?? ""), undefined);
  // The same cursor gives the same page
  const c = next(first) ?? "";
  assert.equal(morePage(c, 1), morePage(c, 1));
});

test("a first line too large for a page still moves on, piece by piece", () => {
  const first = firstPage({
    kind: "check",
    projectId: 1,
    lead: ["✗ 1 error"],
    lines: [`✗ ${"k".repeat(40_000)}: unknown key`],
  });
  const pages = all(first, 1);
  assert.ok(pages.length >= 2);
  const text = pages
    .flatMap((p) => p.split("\n").filter((l) => l.startsWith("✗ k") || l.startsWith("… ")))
    .map((l) => l.replace(/^… /, "").replace(/ …$/, ""))
    .join("");
  assert.equal(text, `✗ ${"k".repeat(40_000)}: unknown key`);
});

test("lines that carry text from outside go inside a frame on every page, and Sphica's own words stay outside it", () => {
  const lines = Array.from({ length: 600 }, (_, i) => `- s${i} comment by someone: ${"t".repeat(100)}`);
  const pages = all(
    firstPage({ kind: "fetch", projectId: 1, lead: ["600 sources kept."], lines, framed: true }),
    1,
  );
  assert.ok(pages.length >= 2);
  assert.match(pages[0] ?? "", /^600 sources kept\.\n<past-records id="[0-9a-f]+">\n/);
  for (const p of pages.slice(0, -1))
    assert.match(
      p,
      /\n<\/past-records id="[0-9a-f]+">\n\d+ more lines?: call record_more with cursor: "f[0-9a-f]{12}\.\d+"$/,
    );
  assert.match(
    pages.at(-1) ?? "",
    /^<past-records id="[0-9a-f]+">\n[\s\S]*\n<\/past-records id="[0-9a-f]+">$/,
  );
  assert.equal(pages.flatMap((p) => p.split("\n").filter((l) => l.startsWith("- s"))).length, 600);
  // The same cursor gives the same page, frame and all
  const c = next(pages[0] ?? "") ?? "";
  assert.equal(morePage(c, 1), morePage(c, 1));
  assert.equal(morePage(c, 1), pages[1]);
});

test("a result of any length is read to its end: a position has as many digits as it needs", () => {
  const first = firstPage({
    kind: "check",
    projectId: 1,
    lead: ["lead"],
    lines: Array(1_001_000).fill("x".repeat(100)),
  });
  const pages = all(first, 1);
  assert.match(next(pages.at(-2) ?? "") ?? "", /\.\d{7}$/);
  assert.equal(pages.join("\n").match(/^x{100}$/gm)?.length, 1_001_000);
});

test("a cursor is refused for another project, when it is not one a reply gave, and past the end", () => {
  const lines = Array.from({ length: 900 }, (_, i) => `line ${i} ${"w".repeat(100)}`);
  const c = next(firstPage({ kind: "save", projectId: 1, lead: ["✓ saved"], lines })) ?? "";
  assert.throws(() => morePage(c, 2), /belongs to another project/);
  assert.throws(() => morePage("x", 1), /not a cursor a reply gave/);
  // A position is good only if a reply named it: an edited cursor would skip lines without a word
  const at = Number(c.split(".")[1]);
  for (const position of [1, at - 1, at + 1, 5000])
    assert.throws(() => morePage(c.replace(/\.\d+$/, `.${position}`), 1), /not a cursor a reply gave/);
  assert.match(morePage(c, 1), /^line \d+ /);
});

test("checks push out only other results that can be run again, and a cursor whose result is gone says what to do next", () => {
  const lines = Array.from({ length: 900 }, (_, i) => `line ${i} ${"w".repeat(100)}`);
  const cursor = (kind: Parameters<typeof firstPage>[0]["kind"]) =>
    next(firstPage({ kind, projectId: 1, lead: ["lead"], lines })) ?? "";
  const saved = cursor("save");
  const fetched = cursor("fetch");
  const applied = cursor("forget_apply");
  const checked = cursor("check");
  const refused = cursor("refused");
  const previewed = cursor("forget_preview");
  for (let i = 0; i < 20; i++) cursor("check");
  // What was committed is still read; what can be run again made room
  for (const c of [saved, fetched, applied]) assert.match(morePage(c, 1), /^line \d+ /);
  assert.throws(
    () => morePage(checked, 1),
    /no longer kept .*Run record_check again: it gives the same result\./,
  );
  assert.throws(
    () => morePage(refused, 1),
    /no longer kept .*Nothing was saved\. Run record_check or record_save again\./,
  );
  assert.throws(() => morePage(previewed, 1), /no longer kept .*Run forget_preview again\./);
  // The committed pool has its own limit, and says the write is done
  for (let i = 0; i < 20; i++) cursor("save");
  assert.throws(() => morePage(saved, 1), /no longer kept .*The record was saved; do not save it again\./);
  assert.throws(() => morePage(fetched, 1), /no longer kept .*The sources were kept; do not fetch again\./);
  assert.throws(
    () => morePage(applied, 1),
    /no longer kept .*The sources were forgotten; nothing is left to do for them\./,
  );
});
