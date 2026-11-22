// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// A closing keyword before an issue reference closes that issue wherever it stands in the body, even in a sentence that says the
// opposite, so the check allows one only on a line of its own
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { strayClosingRefs } from "../../scripts/lib/pr-body.mjs";

const CLI = path.join(import.meta.dirname, "..", "..", "scripts", "check-pr-body-refs.mjs");

test("a closing keyword before an issue number inside a sentence is found, even negated", () => {
  const body = "## Decisions\n\n- zod stays as it is. So this PR does not close #394.\n";
  assert.deepEqual(strayClosingRefs(body), [{ line: 3, text: "close #394" }]);
});

test("every keyword GitHub reads, in any case, with a colon, another repository, or an issue URL, is found", () => {
  const lines = [
    "it fixes #1 too",
    "this Resolved #2 earlier",
    "and CLOSES: #3",
    "fix iroha924/sphica#4 later",
    "resolves https://github.com/iroha924/sphica/issues/5 as well",
    "see `closed #6` here",
  ];
  assert.deepEqual(
    strayClosingRefs(lines.join("\n")).map((f) => f.line),
    [1, 2, 3, 4, 5, 6],
  );
});

test("a keyword and a reference alone on their line, as the template asks, pass", () => {
  const body =
    "Closes #12\nfixes: #13\nResolves iroha924/sphica#14\n\n## What changed\n\nRefs #15 is related.\n";
  assert.deepEqual(strayClosingRefs(body), []);
});

test("words that only contain a keyword, a keyword without a number, and HTML comments pass", () => {
  const body = [
    "<!--",
    "If this PR resolves an issue, put `Closes #12` on one line at the top of the body",
    "-->",
    "We disclose #7 publicly.",
    "A closed-loop #8 test.",
    "This fixes the parser.",
    "Issue #9 stays open.",
  ].join("\r\n");
  assert.deepEqual(strayClosingRefs(body), []);
});

test("the command fails with the line it found, and passes a clean body", () => {
  const bad = spawnSync(process.execPath, [CLI], {
    env: { ...process.env, BODY: "Refs #1\n\nThis does not close #2." },
    encoding: "utf8",
  });
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout + bad.stderr, /line 3: close #2/);
  const good = spawnSync(process.execPath, [CLI], {
    env: { ...process.env, BODY: "Closes #1\n\nDone." },
    encoding: "utf8",
  });
  assert.equal(good.status, 0, good.stdout + good.stderr);
});
