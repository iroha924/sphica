// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

import "./isolate-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { markOnce, marksDir } from "../src/once.ts";
import { ownTmpdir, tempDir } from "./temp-dir.ts";

test("a key is new the first time and seen after, apart for each kind", () => {
  ownTmpdir("sphica-once-");
  assert.equal(markOnce("pending", "a"), true);
  assert.equal(markOnce("pending", "a"), false);
  assert.equal(markOnce("pending", "b"), true);
  assert.equal(markOnce("review", "a"), true);
  assert.equal((fs.statSync(marksDir()).mode & 0o777).toString(8), "700");
});

// A shared /tmp lets another user make the directory first and place the marks there, which would silence what they guard
test("a directory others can write, or a link in its place, never counts a key as seen", () => {
  ownTmpdir("sphica-once-open-");
  fs.mkdirSync(path.join(marksDir(), "pending"), { recursive: true });
  fs.chmodSync(marksDir(), 0o777);
  fs.writeFileSync(path.join(marksDir(), "pending", "placed"), "");
  assert.equal(markOnce("pending", "a"), true);
  assert.equal(markOnce("pending", "a"), true, "said again rather than silenced");

  // A file where the kind's directory goes makes the directory fail to be made, which is no mark either
  ownTmpdir("sphica-once-file-");
  fs.mkdirSync(marksDir());
  fs.chmodSync(marksDir(), 0o777);
  fs.writeFileSync(path.join(marksDir(), "pending"), "");
  assert.equal(markOnce("pending", "a"), true);
  assert.equal(markOnce("pending", "a"), true, "said again rather than silenced");

  ownTmpdir("sphica-once-top-file-");
  fs.writeFileSync(marksDir(), "");
  assert.equal(markOnce("pending", "a"), true);
  assert.equal(markOnce("pending", "a"), true, "said again rather than silenced");

  ownTmpdir("sphica-once-link-");
  const elsewhere = tempDir("sphica-once-elsewhere-");
  fs.chmodSync(elsewhere, 0o700);
  fs.symlinkSync(elsewhere, marksDir());
  assert.equal(markOnce("pending", "a"), true);
  assert.equal(markOnce("pending", "a"), true, "said again rather than silenced");
});
