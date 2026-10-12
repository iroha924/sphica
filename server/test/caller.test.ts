// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { callerOf } from "../src/caller.ts";

// The call shapes the hosts were measured to send
const claudeMeta = { progressToken: 2, "claudecode/toolUseId": "toolu_01A" };
const codexMeta = (turn_trigger: unknown, thread: Record<string, unknown> = {}) => ({
  progressToken: 1,
  callId: "exec-1",
  "x-codex-turn-metadata": {
    session_id: "cx-s",
    thread_id: "cx-s",
    turn_id: "cx-t",
    turn_trigger,
    thread_source: "user",
    ...thread,
  },
});
// A thread spawned inside a session: the parent's session id, its own thread id and turn
const child = {
  thread_id: "cx-child",
  turn_id: "cx-child-t",
  thread_source: "subagent",
  parent_thread_id: "cx-s",
};

test("an interactive Claude Code session is cli with its own session id and no parent marker saying otherwise", () => {
  const env = { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ID: "s1" };
  assert.deepEqual(callerOf(claudeMeta, env), {
    host: "claude-code",
    session: "s1",
    turn: null,
    toolUseId: "toolu_01A",
    mode: "interactive",
    raw: "cli",
  });
  assert.equal(callerOf(claudeMeta, { ...env, SPHICA_PARENT_SESSION: "s1" }).mode, "interactive");
});

test("a Claude Code child that inherited cli, or one without a session id, is unknown", () => {
  // The Agent SDK keeps an inherited cli; the parent's marker then names another session
  assert.equal(
    callerOf(claudeMeta, {
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SESSION_ID: "child",
      SPHICA_PARENT_SESSION: "parent",
    }).mode,
    "unknown",
  );
  assert.equal(callerOf(claudeMeta, { CLAUDE_CODE_ENTRYPOINT: "cli" }).mode, "unknown");
});

test("claude -p is headless, other sdk- entrypoints are the SDK, and unseen values are unknown", () => {
  const at = (CLAUDE_CODE_ENTRYPOINT: string) =>
    callerOf(claudeMeta, { CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_SESSION_ID: "s1" });
  assert.equal(at("sdk-cli").mode, "headless");
  assert.equal(at("sdk-ts").mode, "sdk");
  assert.equal(at("sdk-py").mode, "sdk");
  assert.equal(at("claude-desktop").mode, "unknown");
  assert.equal(at("claude-desktop").raw, "claude-desktop");
});

test("Codex is read from its turn metadata: the owner's own thread started by a person is interactive, exec is headless", () => {
  // A Codex started from a Claude Code shell inherits Claude Code's variables; its own metadata wins
  const env = { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ID: "claude-s" };
  assert.deepEqual(callerOf(codexMeta("user"), env), {
    host: "codex",
    session: "cx-s",
    turn: "cx-t",
    toolUseId: null,
    mode: "interactive",
    raw: "user",
  });
  assert.deepEqual(callerOf(codexMeta("exec"), env), {
    host: "codex",
    session: "cx-s",
    turn: "cx-t",
    toolUseId: null,
    mode: "headless",
    raw: "exec",
  });
  // A turn the background server went on with after a restart, and values not seen yet
  assert.equal(callerOf(codexMeta("daemon_recovery"), env).mode, "unknown");
  assert.equal(callerOf(codexMeta("daemon_recovery"), env).turn, "cx-t");
  assert.equal(callerOf(codexMeta(undefined), env).mode, "unknown");
  assert.equal(callerOf(codexMeta(1), env).raw, null);
});

test("a Codex call from a thread that is not the owner's own is never interactive and names no turn", () => {
  // A child thread carries the parent's session id and the same trigger as the parent's turn
  assert.deepEqual(callerOf(codexMeta("user", child), {}), {
    host: "codex",
    session: "cx-s",
    turn: null,
    toolUseId: null,
    mode: "unknown",
    raw: "user:subagent",
  });
  // A child inside an exec run stays headless, and its turn cannot be placed either
  const inExec = callerOf(codexMeta("exec", child), {});
  assert.deepEqual([inExec.mode, inExec.turn, inExec.raw], ["headless", null, "exec:subagent"]);
  for (const thread of [
    { thread_source: undefined },
    { thread_source: "subagent" },
    { thread_id: undefined },
    { thread_id: "another" },
    { session_id: undefined },
    { session_id: undefined, thread_id: undefined },
  ]) {
    const c = callerOf(codexMeta("user", thread), {});
    assert.deepEqual([c.mode, c.turn], ["unknown", null], JSON.stringify(thread));
  }
  assert.equal(callerOf(codexMeta("user", { thread_source: undefined }), {}).raw, "user:none");
  assert.equal(callerOf(codexMeta(undefined, { thread_id: "another" }), {}).raw, "none:user");
  // A joined value past the length kept is not stored
  assert.equal(callerOf(codexMeta("u".repeat(150), { thread_source: "s".repeat(150) }), {}).raw, null);
});

test("a call with neither host's signals is unknown", () => {
  assert.deepEqual(callerOf(undefined, {}), {
    host: null,
    session: null,
    turn: null,
    toolUseId: null,
    mode: "unknown",
    raw: null,
  });
  assert.equal(callerOf({ "x-codex-turn-metadata": "x" }, {}).mode, "unknown");
  assert.equal(callerOf({ "claudecode/toolUseId": 3 }, { CLAUDE_CODE_SESSION_ID: "s1" }).host, null);
});

test("caller metadata out of bounds is kept as unknown, never stored as sent", () => {
  const long = "x".repeat(10_000);
  const codex = callerOf(
    { "x-codex-turn-metadata": { session_id: long, turn_id: "t\u0000", turn_trigger: long } },
    {},
  );
  assert.deepEqual([codex.session, codex.turn, codex.raw], [null, null, null]);
  const claude = callerOf(
    { "claudecode/toolUseId": long },
    { CLAUDE_CODE_ENTRYPOINT: long, CLAUDE_CODE_SESSION_ID: "s1" },
  );
  assert.deepEqual([claude.toolUseId, claude.raw, claude.mode], [null, null, "unknown"]);
});
