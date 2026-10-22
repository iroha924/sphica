// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { EXPECTED_NOTES, entryProblems, noteProblems, PANE_SOURCE } from "../../scripts/lib/pane-report.mjs";

const validated = (notes: readonly string[]) => ({ contents: [{ type: "hooks", notes }] });

test("the reviewed mod's notes pass, in any order", () => {
  assert.deepEqual(noteProblems(validated(EXPECTED_NOTES)), []);
  assert.deepEqual(noteProblems(validated([...EXPECTED_NOTES].reverse())), []);
});

test("a note in any other shape, a missing note, or a changed list fails", () => {
  for (const extra of [
    "./extra.tsx calls: $.fs.read",
    "./extra 2.tsx calls: $.fs.read",
    "extra.tsx calls: $.fs.read",
    "./register.tsx extra.tsx calls: $.fs.read",
    "./register.tsx gating hook without .catch: classic.Stop",
  ])
    assert.deepEqual(
      noteProblems(validated([...EXPECTED_NOTES, extra])),
      [`unexpected note: ${extra}`],
      extra,
    );
  const calls = EXPECTED_NOTES.find((n) => n.startsWith("./register.tsx calls: ")) ?? "";
  assert.deepEqual(
    noteProblems(validated(EXPECTED_NOTES.map((n) => (n === calls ? `${calls}, $.fs.read` : n)))),
    [`unexpected note: ${calls}, $.fs.read`, `missing note: ${calls}`],
  );
  assert.deepEqual(noteProblems(validated(EXPECTED_NOTES.filter((n) => n !== calls))), [
    `missing note: ${calls}`,
  ]);
});

test("validate must have checked exactly one hooks file", () => {
  assert.deepEqual(noteProblems({ contents: [] }), ["validate checked [], not one hooks file"]);
  assert.deepEqual(
    noteProblems({
      contents: [
        { type: "hooks", notes: EXPECTED_NOTES },
        { type: "hooks", notes: [] },
      ],
    }),
    ['validate checked ["hooks","hooks"], not one hooks file'],
  );
  assert.deepEqual(noteProblems(undefined), ["validate checked [], not one hooks file"]);
});

test("the marketplace entry must install pane/ from this repository at the release tag", () => {
  const market = (source: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    plugins: [
      { name: "sphica" },
      { name: "sphica-pane", source: { ...PANE_SOURCE, ref: "v1.2.3", ...source }, ...extra },
    ],
  });
  assert.deepEqual(entryProblems(market({}), "1.2.3"), []);
  assert.deepEqual(entryProblems(market({ path: "panes" }), "1.2.3"), ['source.path is "panes", not "pane"']);
  assert.deepEqual(entryProblems(market({ ref: "v1.2.2" }), "1.2.3"), [
    'source.ref is "v1.2.2", not "v1.2.3"',
  ]);
  assert.deepEqual(entryProblems(market({ sha: "abc" }, { version: "1.2.3" }), "1.2.3"), [
    "source.sha is set",
    "the entry sets a version, which Claude Code would prefer over the pane's plugin.json",
  ]);
  assert.deepEqual(entryProblems({ plugins: [{ name: "sphica" }] }, "1.2.3"), ["no sphica-pane entry"]);
});
