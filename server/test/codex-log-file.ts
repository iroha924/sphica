// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Codex session logs for tests, with the first line as Codex 0.162.1 writes it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A session's own log in a new directory, which the caller removes: `payload` replaces fields of the first line, `rest` follows it */
export function codexLog(sessionId: string, payload: Record<string, unknown> = {}, rest = ""): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-codex-log-")));
  const file = path.join(dir, `rollout-${sessionId}.jsonl`);
  const first = {
    timestamp: "2026-10-12T10:57:58.000Z",
    type: "session_meta",
    payload: {
      id: sessionId,
      session_id: sessionId,
      originator: "codex-tui",
      source: "vscode",
      thread_source: "user",
      cli_version: "0.162.1",
      base_instructions: { text: "You are Codex." },
      ...payload,
    },
  };
  fs.writeFileSync(file, `${JSON.stringify(first)}\n${rest}`);
  return file;
}

/** The log of a child thread the session spawned without an agent id, as the built-in review's is: its own id, the session as its parent */
export const childLog = (sessionId: string, childId: string, kind: unknown = "review"): string =>
  codexLog(childId, {
    session_id: sessionId,
    parent_thread_id: sessionId,
    source: { subagent: kind },
    thread_source: "subagent",
  });
