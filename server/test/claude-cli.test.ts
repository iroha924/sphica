// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { childEnv } from "../../scripts/claude-cli.mjs";

test("the pinned CLI runs in a throwaway home and never sees the owner's Sphica or Codex locations", () => {
  const env = childEnv("/tmp/c", {
    PATH: "/bin",
    HOME: "/Users/o",
    SPHICA_DB: "/Users/o/.sphica/sphica.db",
    SPHICA_HOME: "/Users/o/.sphica",
    CODEX_HOME: "/Users/o/.codex",
  });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/tmp/c", USERPROFILE: "/tmp/c", CLAUDE_CONFIG_DIR: "/tmp/c" });
});
