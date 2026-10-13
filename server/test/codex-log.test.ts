// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// What a Codex session log's first line says about the thread a hook call came from, on real files: the session's own thread, a child
// thread, and everything that cannot be read as either.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { childThread, codexThread, ownThread } from "../src/codex-log.ts";
import { childLog, codexLog } from "./codex-log-file.ts";

const made: string[] = [];
const keep = (file: string) => {
  made.push(path.dirname(file));
  return file;
};
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

test("a session's own thread is one whose log holds the session's id and says a person or codex exec started it", () => {
  const own = (payload: Record<string, unknown> = {}, session = "cx-1") => {
    const input = { session_id: session, transcript_path: keep(codexLog("cx-1", payload)) };
    return ownThread(input, codexThread(input));
  };
  assert.equal(own(), true);
  // Who started the client is not asked: codex exec, the background server, and a client not measured are the session's own thread too
  assert.equal(own({ originator: "codex_exec", source: "exec" }), true);
  assert.equal(own({ originator: "Codex Desktop", source: "vscode" }), true);
  // A fork is a new session with its own log
  assert.equal(own({ forked_from_id: "cx-0" }), true);
  assert.equal(own({ thread_source: "subagent" }), false);
  assert.equal(own({ thread_source: undefined }), false);
  assert.equal(own({}, "cx-other"), false, "another session's log");
  assert.equal(
    ownThread({}, codexThread({ transcript_path: keep(codexLog("cx-1")) })),
    false,
    "no session id",
  );
  assert.equal(ownThread({ session_id: "cx-1" }, null), false);
});

test("a child thread is one whose log names this session as its parent, under an id of its own", () => {
  const child = (file: string, session = "cx-1") => {
    const input = { session_id: session, transcript_path: keep(file) };
    return { id: childThread(input, codexThread(input)), thread: codexThread(input) };
  };
  const review = child(childLog("cx-1", "cx-child"));
  assert.equal(review.id, "cx-child");
  assert.equal(review.thread?.subagent, "review");
  assert.equal(ownThread({ session_id: "cx-1" }, review.thread), false);
  // A spawned thread names its kind with an object, which is no word to read
  const spawned = child(childLog("cx-1", "cx-child", { thread_spawn: { depth: 1 } }));
  assert.equal(spawned.id, "cx-child");
  assert.equal(spawned.thread?.subagent, null);
  assert.equal(child(childLog("cx-other", "cx-child")).id, null, "another session's child");
  assert.equal(child(codexLog("cx-1")).id, null, "the session's own thread");
  assert.equal(child(childLog("cx-1", "cx-1")).id, null, "a child under the session's own id");
  assert.equal(child(childLog("cx-1", "has space")).id, null, "an id that is not one a host sends");
  assert.equal(child(childLog("cx-1", "x".repeat(201))).id, null);
  assert.equal(childThread({}, review.thread), null, "no session id");
});

test("a log that is not there to read as a session's first line says nothing", () => {
  const good = keep(codexLog("cx-1"));
  assert.notEqual(codexThread({ transcript_path: good }), null);
  assert.equal(codexThread({}), null);
  // Hosts name the log by its full path; one relative to wherever the hook runs is not read, even when it leads to a good log
  assert.equal(codexThread({ transcript_path: path.relative(process.cwd(), good) }), null);
  assert.equal(codexThread({ transcript_path: path.join(path.dirname(good), "missing.jsonl") }), null);
  assert.equal(codexThread({ transcript_path: path.dirname(good) }), null, "a directory");
  // A link to a good log is not the session's log file. Windows needs a privilege to make one, so it is tried elsewhere only
  if (process.platform !== "win32") {
    const link = path.join(path.dirname(good), "link.jsonl");
    fs.symlinkSync(good, link);
    assert.equal(codexThread({ transcript_path: link }), null);
  }
  // The first line alone is read, however long the log has grown, and up to 256 KiB of it
  assert.notEqual(
    codexThread({ transcript_path: keep(codexLog("cx-1", {}, `${"x".repeat(1024 * 1024)}\n`)) }),
    null,
  );
  const long = (kib: number) =>
    codexThread({
      transcript_path: keep(codexLog("cx-1", { base_instructions: { text: "i".repeat(kib * 1024) } })),
    });
  assert.notEqual(long(200), null);
  assert.equal(long(300), null);
  for (const text of [
    "",
    '{"type":"session_meta","payload":{"id":"cx-1"',
    `${JSON.stringify({ type: "session_meta", payload: null })}\n`,
    `${JSON.stringify({ type: "session_meta", payload: ["cx-1"] })}\n`,
    `${JSON.stringify({ type: "response_item", payload: { id: "cx-1", thread_source: "user" } })}\n`,
    "[]\n",
    "null\n",
    "not json\n",
  ]) {
    const file = keep(codexLog("cx-1"));
    fs.writeFileSync(file, text);
    assert.equal(codexThread({ transcript_path: file }), null, text.slice(0, 40));
  }
  // Fields of another type are not read as text
  const odd = keep(
    codexLog("cx-1", { id: 7, originator: ["codex-tui"], thread_source: { is: "user" }, source: null }),
  );
  assert.deepEqual(codexThread({ transcript_path: odd }), {
    id: null,
    originator: null,
    threadSource: null,
    parent: null,
    subagent: null,
  });
});
