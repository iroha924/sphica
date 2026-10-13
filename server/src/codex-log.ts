// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Which thread of a Codex session a hook call came from, read from the first line of the session log the call names. Hook input is the
// same for a person's own thread, codex exec, and a child thread that carries no agent id (the built-in review); only the log tells them apart.
import fs from "node:fs";
import path from "node:path";

/** How far into a Codex session log its first line is looked for; the line holds the session's instructions and ran to 23 KB when measured */
const SESSION_META_BYTES = 256 * 1024;

export type CodexThread = {
  /** The thread's own id: the session's for its own thread, another for a child */
  id: string | null;
  originator: string | null;
  /** `user` for a thread a person or codex exec started, `subagent` for one the session spawned */
  threadSource: string | null;
  /** The session a child thread belongs to */
  parent: string | null;
  /** The kind of child, when the log names it by one word (`review`) */
  subagent: string | null;
};

type Call = { session_id?: string; transcript_path?: string };

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * The first line of the session log a hook call names, or null when it is not there to read as one: no path, a relative one, anything but
 * a regular file, a line that does not end within the bytes read, or a line that is not a session's first.
 */
export function codexThread(input: Pick<Call, "transcript_path">): CodexThread | null {
  const file = input.transcript_path;
  if (typeof file !== "string" || !path.isAbsolute(file)) return null;
  let fd: number | undefined;
  try {
    // A regular file only: a FIFO would block the hook
    if (!fs.lstatSync(file).isFile()) return null;
    fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(SESSION_META_BYTES);
    const read = fs.readSync(fd, buffer, 0, SESSION_META_BYTES, 0);
    const end = buffer.subarray(0, read).indexOf(0x0a);
    if (end < 0) return null;
    // Anything but an object with an object payload has none of these fields
    const line = JSON.parse(buffer.subarray(0, end).toString("utf8")) as {
      type?: unknown;
      payload?: Record<string, unknown> | null;
    } | null;
    const payload = line?.payload;
    if (line?.type !== "session_meta" || !payload || typeof payload !== "object" || Array.isArray(payload))
      return null;
    const source = payload.source;
    return {
      id: text(payload.id),
      originator: text(payload.originator),
      threadSource: text(payload.thread_source),
      parent: text(payload.parent_thread_id),
      subagent:
        source && typeof source === "object" ? text((source as Record<string, unknown>).subagent) : null,
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Whether the log says the call came from the session's own thread, the one a person or codex exec started */
export const ownThread = (input: Pick<Call, "session_id">, thread: CodexThread | null): boolean =>
  Boolean(input.session_id) && thread?.id === input.session_id && thread?.threadSource === "user";

/** The id of the child thread the call came from, when the log says this session spawned it; null for anything else */
export const childThread = (input: Pick<Call, "session_id">, thread: CodexThread | null): string | null =>
  input.session_id &&
  thread?.threadSource === "subagent" &&
  thread.parent === input.session_id &&
  thread.id !== null &&
  thread.id !== input.session_id &&
  /^[\x21-\x7e]{1,200}$/.test(thread.id)
    ? thread.id
    : null;
