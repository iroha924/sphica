// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ALLOWED, differences, reported } from "../../scripts/lib/pane-report.mjs";

const note = (label: string, items: readonly string[]) => `./register.tsx ${label}: ${items.join(", ")}`;
const validated = (notes: string[]) => ({ contents: [{ notes }] });
const allowedNotes = () => Object.entries(ALLOWED).map(([label, items]) => note(label, items));

test("the reviewed mod's notes match, a matcher's commas stay inside it", () => {
  const got = reported(validated(allowedNotes()));
  assert.deepEqual(got.register.hooks?.at(-1), "ui.render{component=Pane, requestId=sphica-delivered}");
  assert.deepEqual(differences(got), []);
});

test("an extra call, a missing hook, a hook without .catch, and notes in another shape all fail", () => {
  const notes = allowedNotes().map((n) =>
    n.startsWith("./register.tsx calls:") ? `${n}, $.fs.read` : n.replace("classic.PreToolUse, ", ""),
  );
  notes.push("./register.tsx gating hook without .catch: classic.Stop");
  assert.deepEqual(differences(reported(validated(notes))), [
    "hooks: missing classic.PreToolUse",
    "calls: not allowed $.fs.read",
    "gating hook without .catch: classic.Stop",
  ]);
  assert.deepEqual(differences(reported(validated(["register.tsx hooks= session.start"]))), [
    "hooks: validate reported none",
    "calls: validate reported none",
    "state writes: validate reported none",
    "state reads: validate reported none",
  ]);
});

test("notes from any module other than register.tsx fail, whatever they say", () => {
  const notes = [
    ...allowedNotes(),
    "./extra.tsx calls: $.fs.read",
    "./extra.tsx gating hook without .catch: classic.Stop",
  ];
  assert.deepEqual(differences(reported(validated(notes))), [
    "./extra.tsx: a module the pane does not ship (calls: $.fs.read)",
    "./extra.tsx: a module the pane does not ship (gating hook without .catch: classic.Stop)",
  ]);
});
