// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Past sessions read from host logs become the same records live capture queues: only lines the log marks as the owner's are the owner's
import "./isolate-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { messageOf } from "../src/capture.ts";
import { EDIT_TOOLS, fromClaude, fromCodex } from "../src/history.ts";

const place = { key: "github.com/example/repo", root: "/work/repo" };
const lines = (...rows: object[]) => rows.map((r) => JSON.stringify(r));
const claude = (row: object) => ({
  sessionId: "s1",
  cwd: "/work/repo",
  gitBranch: "main",
  entrypoint: "cli",
  ...row,
});
const human = (promptId: string, text: unknown, timestamp: string, extra: object = {}) =>
  claude({
    type: "user",
    promptId,
    origin: { kind: "human" },
    timestamp,
    message: { role: "user", content: text },
    ...extra,
  });
const assistant = (id: string, content: object[], timestamp: string) =>
  claude({ type: "assistant", timestamp, message: { id, role: "assistant", content } });

test("a Claude Code log yields the owner's prompts and each turn's last reply, with the ids live capture gives them", () => {
  const log = fromClaude(
    lines(
      human("p1", "Fix the parser", "2026-11-01T00:00:00.000Z"),
      assistant("m1", [{ type: "text", text: "Looking" }], "2026-11-01T00:00:01.000Z"),
      assistant("m2", [{ type: "text", text: "Done: the parser" }], "2026-11-01T00:00:02.000Z"),
      assistant("m2", [{ type: "text", text: "is fixed" }], "2026-11-01T00:00:03.000Z"),
      human("p2", [{ type: "text", text: "Thanks" }], "2026-11-01T00:01:00.000Z"),
    ),
    place,
  );
  assert.equal(log.excluded, null);
  assert.equal(log.session, "s1");
  const base = {
    v: 2 as const,
    host: "claude-code" as const,
    session: "s1",
    project: place.key,
    branch: "main",
  };
  const expected = [
    messageOf({ ...base, turn: "p1" }, "p1:owner", "owner", "Fix the parser", "2026-11-01T00:00:00.000Z"),
    messageOf({ ...base, turn: "p2" }, "p2:owner", "owner", "Thanks", "2026-11-01T00:01:00.000Z"),
    messageOf(
      { ...base, turn: "p1" },
      "p1:assistant",
      "assistant",
      "Done: the parser\n\nis fixed",
      "2026-11-01T00:00:02.000Z",
    ),
  ];
  assert.deepEqual(log.records, expected);
});

test("notices, other agents' reports, meta lines, subagent lines, and lines without an origin are never the owner's", () => {
  const log = fromClaude(
    lines(
      human("p1", "Mine", "2026-11-01T00:00:00.000Z"),
      claude({
        type: "user",
        promptId: "p2",
        origin: { kind: "task-notification" },
        timestamp: "2026-11-01T00:00:01.000Z",
        message: { content: "<task-notification>done</task-notification>" },
      }),
      claude({
        type: "user",
        promptId: "p1",
        isMeta: true,
        origin: { kind: "peer" },
        timestamp: "2026-11-01T00:00:02.000Z",
        message: { content: "report" },
      }),
      claude({
        type: "user",
        promptId: "p1",
        timestamp: "2026-11-01T00:00:03.000Z",
        message: { content: "no origin" },
      }),
      claude({
        type: "user",
        promptId: "p1",
        isSidechain: true,
        origin: { kind: "human" },
        timestamp: "2026-11-01T00:00:04.000Z",
        message: { content: "subagent" },
      }),
      claude({ type: "brand-new", timestamp: "2026-11-01T00:00:05.000Z" }),
    ).concat("not json"),
    place,
  );
  assert.deepEqual(
    log.records
      .filter((r) => r.kind === "message" && r.speaker === "owner")
      .map((r) => r.kind === "message" && r.body),
    ["Mine"],
  );
  assert.deepEqual(log.skipped, {
    "task-notification message": 1,
    "peer message": 1,
    "message without an origin": 1,
    "subagent line": 1,
    "brand-new line": 1,
    "unreadable line": 1,
  });
});

test("an AskUserQuestion answer is the owner's and its questions are the reply's, keyed by the tool use as live capture keys them", () => {
  const log = fromClaude(
    lines(
      human("p1", "Ask me", "2026-11-01T00:00:00.000Z"),
      assistant(
        "m1",
        [{ type: "tool_use", id: "tu1", name: "AskUserQuestion", input: {} }],
        "2026-11-01T00:00:01.000Z",
      ),
      claude({
        type: "user",
        promptId: "p1",
        timestamp: "2026-11-01T00:00:05.000Z",
        sourceToolUseID: "tu1",
        message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "answered" }] },
        toolUseResult: {
          questions: [],
          answers: { "Which?": "A" },
          annotations: { "Which?": { notes: "fine" } },
        },
      }),
    ),
    place,
  );
  const said = log.records.filter((r) => r.kind === "message" && r.id.startsWith("p1:ask:tu1"));
  assert.deepEqual(
    said.map((r) => r.kind === "message" && [r.speaker, r.body, r.at]),
    [
      ["assistant", "Q1: Which?", "2026-11-01T00:00:04.999Z"],
      ["owner", "A1: A\nNotes: fine", "2026-11-01T00:00:05.000Z"],
    ],
  );
});

test("an edit tool's file is an edit once its result came back without an error, relative to the repository", () => {
  const log = fromClaude(
    lines(
      human("p1", "Edit", "2026-11-01T00:00:00.000Z"),
      assistant(
        "m1",
        [
          { type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/work/repo/src/a.ts" } },
          { type: "tool_use", id: "e2", name: "Write", input: { file_path: "/work/repo/src/b.ts" } },
          { type: "tool_use", id: "e3", name: "Edit", input: { file_path: "/elsewhere/c.ts" } },
          { type: "tool_use", id: "r1", name: "Read", input: { file_path: "/work/repo/src/d.ts" } },
        ],
        "2026-11-01T00:00:01.000Z",
      ),
      claude({
        type: "user",
        promptId: "p1",
        timestamp: "2026-11-01T00:00:02.000Z",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "e1", content: "ok" },
            { type: "tool_result", tool_use_id: "e2", is_error: true, content: "failed" },
            { type: "tool_result", tool_use_id: "e3", content: "ok" },
            { type: "tool_result", tool_use_id: "r1", content: "ok" },
          ],
        },
      }),
    ),
    place,
  );
  assert.deepEqual(
    log.records.filter((r) => r.kind === "edit").map((r) => r.kind === "edit" && [r.path, r.event, r.via]),
    [["src/a.ts", "e1", "tool"]],
  );
});

test("a headless or SDK Claude Code run is left out whole", () => {
  const log = fromClaude(
    lines({ ...human("p1", "Run", "2026-11-01T00:00:00.000Z"), entrypoint: "sdk-cli" }),
    place,
  );
  assert.equal(log.excluded, "headless or SDK run");
  assert.deepEqual(log.records, []);
});

const codexMeta = (payload: object) => ({
  type: "session_meta",
  timestamp: "2026-11-01T00:00:00.000Z",
  payload: {
    id: "c1",
    cwd: "/work/repo",
    originator: "codex-tui",
    source: "vscode",
    thread_source: "user",
    ...payload,
  },
});
const item = (turn: string, thread: string, it: object, timestamp: string) => ({
  type: "event_msg",
  timestamp,
  payload: { type: "item_completed", turn_id: turn, thread_id: thread, item: it },
});

test("a Codex log yields the owner's UserMessage items, each turn's last agent message, and completed file changes", () => {
  const log = fromCodex(
    lines(
      codexMeta({}),
      {
        type: "response_item",
        timestamp: "2026-11-01T00:00:01.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<environment_context>...</environment_context>" }],
        },
      },
      item(
        "t1",
        "c1",
        { type: "UserMessage", id: "u1", content: [{ type: "text", text: "Rename it" }] },
        "2026-11-01T00:00:02.000Z",
      ),
      item(
        "t1",
        "child",
        { type: "UserMessage", id: "u2", content: [{ type: "text", text: "child prompt" }] },
        "2026-11-01T00:00:03.000Z",
      ),
      item(
        "t1",
        "c1",
        { type: "FileChange", id: "f1", status: "completed", changes: { "/work/repo/src/x.ts": {} } },
        "2026-11-01T00:00:04.000Z",
      ),
      item(
        "t1",
        "c1",
        { type: "FileChange", id: "f2", status: "failed", changes: { "/work/repo/src/y.ts": {} } },
        "2026-11-01T00:00:05.000Z",
      ),
      {
        type: "event_msg",
        timestamp: "2026-11-01T00:00:06.000Z",
        payload: { type: "task_complete", turn_id: "t1", last_agent_message: "Renamed" },
      },
    ),
    place,
  );
  assert.equal(log.excluded, null);
  const base = {
    v: 2 as const,
    host: "codex" as const,
    session: "c1",
    project: place.key,
    branch: null,
    turn: "t1",
  };
  assert.deepEqual(log.records, [
    messageOf(base, "t1:owner", "owner", "Rename it", "2026-11-01T00:00:02.000Z"),
    { ...base, kind: "edit", event: "f1", path: "src/x.ts", via: "tool", at: "2026-11-01T00:00:04.000Z" },
    messageOf(base, "t1:assistant", "assistant", "Renamed", "2026-11-01T00:00:06.000Z"),
  ]);
  assert.deepEqual(log.skipped, { "item of another thread": 1 });
});

test("codex exec runs, child threads, and logs without a session line are left out whole", () => {
  assert.equal(
    fromCodex(lines(codexMeta({ originator: "codex_exec", source: "exec" })), place).excluded,
    "codex exec run",
  );
  assert.equal(
    fromCodex(lines(codexMeta({ source: { subagent: "review" }, thread_source: "subagent" })), place)
      .excluded,
    "child thread",
  );
  assert.equal(fromCodex(lines({ type: "event_msg", payload: {} }), place).excluded, "no session line");
  assert.equal(fromCodex([], place).excluded, "no session line");
});

test("a prompt typed while a turn ran is the owner's under the running turn, and queued notices or reports are not", () => {
  const log = fromClaude(
    lines(
      human("p1", "Start", "2026-11-01T00:00:00.000Z"),
      claude({
        type: "attachment",
        timestamp: "2026-11-01T00:00:01.000Z",
        attachment: {
          type: "queued_command",
          commandMode: "prompt",
          origin: { kind: "human" },
          prompt: "Also this",
          timestamp: "2026-11-01T00:00:01.500Z",
        },
      }),
      claude({
        type: "attachment",
        timestamp: "2026-11-01T00:00:02.000Z",
        attachment: {
          type: "queued_command",
          commandMode: "prompt",
          origin: { kind: "peer" },
          prompt: "report",
        },
      }),
      claude({
        type: "attachment",
        timestamp: "2026-11-01T00:00:03.000Z",
        attachment: {
          type: "queued_command",
          commandMode: "task-notification",
          origin: { kind: "task-notification" },
          prompt: "done",
        },
      }),
    ),
    place,
  );
  const owners = log.records.filter((r) => r.kind === "message" && r.speaker === "owner");
  assert.deepEqual(
    owners.map((r) => r.kind === "message" && [r.turn, r.body, r.at]),
    [
      ["p1", "Start", "2026-11-01T00:00:00.000Z"],
      ["p1", "Also this", "2026-11-01T00:00:01.500Z"],
    ],
  );
  assert.deepEqual(log.skipped, { "queued peer message": 1, "queued task-notification message": 1 });
});

test("a block the host wrapped in system-reminder is not the owner's, even on a line of human origin", () => {
  const log = fromClaude(
    lines(
      human(
        "p1",
        [
          { type: "text", text: "<system-reminder>side session event</system-reminder>" },
          { type: "text", text: "My prompt" },
        ],
        "2026-11-01T00:00:00.000Z",
      ),
      human("p2", "<system-reminder>only the host</system-reminder>", "2026-11-01T00:01:00.000Z"),
    ),
    place,
  );
  assert.deepEqual(
    log.records
      .filter((r) => r.kind === "message" && r.speaker === "owner")
      .map((r) => r.kind === "message" && r.body),
    ["My prompt"],
  );
});

test("answers count only from an AskUserQuestion call, never from another tool's result that carries answers", () => {
  const log = fromClaude(
    lines(
      human("p1", "Fetch", "2026-11-01T00:00:00.000Z"),
      assistant(
        "m1",
        [{ type: "tool_use", id: "x1", name: "mcp__other__fetch", input: {} }],
        "2026-11-01T00:00:01.000Z",
      ),
      claude({
        type: "user",
        promptId: "p1",
        timestamp: "2026-11-01T00:00:02.000Z",
        message: { content: [{ type: "tool_result", tool_use_id: "x1", content: "ok" }] },
        toolUseResult: { answers: { "Ship it?": "Yes" } },
      }),
    ),
    place,
  );
  assert.deepEqual(
    log.records.filter((r) => r.kind === "message" && r.id.includes(":ask:")),
    [],
  );
});

test("a session with no message marked as the owner's is left out, so a later import can still add the owner's words", () => {
  const log = fromClaude(
    lines(
      claude({
        type: "user",
        promptId: "p1",
        timestamp: "2026-11-01T00:00:00.000Z",
        message: { content: "no origin" },
      }),
      assistant("m1", [{ type: "text", text: "Reply" }], "2026-11-01T00:00:01.000Z"),
    ),
    place,
  );
  assert.equal(log.excluded, "no message marked as the owner's");
  assert.deepEqual(log.records, []);
  const codex = fromCodex(
    lines(codexMeta({}), {
      type: "event_msg",
      timestamp: "2026-11-01T00:00:06.000Z",
      payload: { type: "task_complete", turn_id: "t1", last_agent_message: "Done" },
    }),
    place,
  );
  assert.equal(codex.excluded, "no message marked as the owner's");
});

test("a Codex thread from anything but a terminal or an editor is left out, as is one without a recognizable own thread", () => {
  assert.equal(
    fromCodex(lines(codexMeta({ source: "mcp" })), place).excluded,
    "session not started from a terminal or an editor",
  );
  assert.equal(fromCodex(lines(codexMeta({ thread_source: "subagent" })), place).excluded, "child thread");
});

test("the edit tools read are the ones the capture hook's matcher names", () => {
  const hooks = fs.readFileSync(
    path.join(import.meta.dirname, "..", "..", "plugin", "hooks", "hooks.json"),
    "utf8",
  );
  const matcher = /"matcher":\s*"([^"]*MultiEdit[^"]*)"/.exec(hooks)?.[1];
  assert.ok(matcher, "the capture hook names its edit tools in a matcher");
  // The same matcher also takes AskUserQuestion, whose answers the import reads apart from edits
  assert.deepEqual(new Set(matcher.split("|").filter((t) => t !== "AskUserQuestion")), EDIT_TOOLS);
});

test("each record keeps to the repository by its own line's directory, so a turn that moves in keeps its reply and one that moves out drops it", () => {
  const rootOf = (cwd: string) => (cwd.startsWith("/work/repo") ? "/work/repo" : null);
  const at = (dir: string, row: object) => ({ ...row, cwd: dir });
  const log = fromClaude(
    lines(
      at("/elsewhere", human("p1", "Start outside", "2026-11-01T00:00:00.000Z")),
      at("/work/repo", assistant("m1", [{ type: "text", text: "Moved in" }], "2026-11-01T00:00:01.000Z")),
      at("/work/repo", human("p2", "Inside", "2026-11-01T00:01:00.000Z")),
      at("/elsewhere", assistant("m2", [{ type: "text", text: "Moved out" }], "2026-11-01T00:01:01.000Z")),
    ),
    { ...place, rootOf },
  );
  assert.deepEqual(
    log.records.map((r) => r.kind === "message" && `${r.speaker}:${r.body}`),
    ["owner:Inside", "assistant:Moved in"],
  );
  assert.equal(log.skipped["record from another directory"], 2);
});

test("a host block in front of a prompt in one string is left out and the prompt after it is kept", () => {
  const log = fromClaude(
    lines(human("p1", "<system-reminder>host</system-reminder>\nMine after it", "2026-11-01T00:00:00.000Z")),
    place,
  );
  assert.deepEqual(
    log.records
      .filter((r) => r.kind === "message" && r.speaker === "owner")
      .map((r) => r.kind === "message" && r.body),
    ["Mine after it"],
  );
});
