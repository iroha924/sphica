// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { duplicateKeys } from "../../scripts/lib/json-keys.mjs";

const dups = (text: string) => duplicateKeys(text).map((d) => [d.line, d.key]);

test("finds a key repeated in the same object, at the line of the repeat, and at any depth", () => {
  assert.deepEqual(dups('{\n  "lint": "a",\n  "fix": "b",\n  "lint": "c"\n}'), [[4, "lint"]]);
  assert.deepEqual(dups('{"a": {"b": 1, "b": 2}, "c": [{"d": 1, "d": 2}]}'), [
    [1, "b"],
    [1, "d"],
  ]);
  // Escapes name the same key
  assert.deepEqual(dups('{"a": 1, "\\u0061": 2}'), [[1, "a"]]);
});

test("the same key in different objects, string values, colons and quotes inside strings, and comments are fine", () => {
  assert.deepEqual(dups('{"a": {"a": 1}, "b": [{"a": 1}, {"a": 2}]}'), []);
  assert.deepEqual(dups('{"a": "a", "b": "x: \\"a\\": y", "c": "a"}'), []);
  assert.deepEqual(dups('{\n  // "a": 1\n  /* "a": 2 */\n  "a": 3, "url": "https://x//y"\n}'), []);
});
