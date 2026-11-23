// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Past sessions read from the hosts' own logs into the records live capture queues, so an import goes through the same send, views, and
// checks. Only what the log marks as the owner's own words is taken as the owner's; a line without that mark is never the owner's.
import { answersOf, messageOf, type Spooled, type TurnBase } from "./capture.ts";
import type { Host } from "./knowledge.ts";
import { relativeTo } from "./project.ts";

/** Where the session's repository is: its project key as capture writes it, and its root for relative paths */
export type Place = { key: string; root: string };

export type SessionLog = {
  host: Host;
  session: string;
  /** The directory the session ran in, as its log says */
  cwd: string | null;
  records: Spooled[];
  /** Lines or items left out, by reason */
  skipped: Record<string, number>;
  /** Why the whole session is left out, or null when it is read */
  excluded: string | null;
};

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const parse = (line: string): Json | null => {
  try {
    const v: unknown = JSON.parse(line);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
};
const count = (skipped: Record<string, number>, reason: string) => {
  skipped[reason] = (skipped[reason] ?? 0) + 1;
};
/** One millisecond before `at`, so a question reads before its answer whatever order the records are sent in */
const before = (at: string): string => new Date(Date.parse(at) - 1).toISOString();
const iso = (v: unknown): string | null => {
  const s = str(v);
  return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null;
};

/** The edit tools whose input names the file they wrote, as live capture reads them on PostToolUse */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** The text of a message's content: a string, or the text blocks of a block list in order, joined by `sep` */
const textOf = (content: unknown, sep: string): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((b): b is Json => isObject(b) && b.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string)
          .join(sep)
      : "";
/** A prompt's text blocks join with one line break, as the prompt in hook input does; reply blocks with a blank line (measured against live capture) */
const PROMPT_SEP = "\n";
const REPLY_SEP = "\n\n";

/**
 * A Claude Code session log (`~/.claude/projects/<dir>/<session>.jsonl`). The owner's words are user lines whose origin is `human`; notices,
 * other agents' reports, and lines marked meta are not. A turn is the prompt id of the user lines; the reply is the last assistant message
 * with text in that turn. A session a headless or SDK process ran (entrypoint `sdk-*`) is left out, as live capture leaves it out.
 */
export function fromClaude(lines: readonly string[], place: Place): SessionLog {
  const skipped: Record<string, number> = {};
  const records: Spooled[] = [];
  let session: string | null = null;
  let cwd: string | null = null;
  let branch: string | null = null;
  let excluded: string | null = null;
  let turn: string | null = null;
  const replies = new Map<string, { message: string; texts: string[]; at: string }>();
  const pendingEdits = new Map<string, string>();
  const base = (t: string): TurnBase => ({
    v: 2,
    host: "claude-code",
    session: session ?? "",
    project: place.key,
    branch,
    turn: t,
  });

  for (const raw of lines) {
    if (!raw.trim()) continue;
    const line = parse(raw);
    if (!line) {
      count(skipped, "unreadable line");
      continue;
    }
    session ??= str(line.sessionId);
    cwd ??= str(line.cwd);
    branch ??= str(line.gitBranch);
    if (str(line.entrypoint)?.startsWith("sdk-")) excluded ??= "headless or SDK run";
    if (line.isSidechain === true) {
      count(skipped, "subagent line");
      continue;
    }
    const at = iso(line.timestamp);
    const message = isObject(line.message) ? line.message : null;
    if (line.type === "user") {
      turn = str(line.promptId) ?? turn;
      if (!turn || !at || !message) continue;
      const content = message.content;
      const blocks = Array.isArray(content) ? content.filter(isObject) : [];
      for (const b of blocks) {
        if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
        const file = pendingEdits.get(b.tool_use_id);
        pendingEdits.delete(b.tool_use_id);
        if (file && b.is_error !== true)
          records.push({ ...base(turn), kind: "edit", event: b.tool_use_id, path: file, via: "tool", at });
      }
      const said = answersOf({ tool_response: line.toolUseResult });
      const toolUse =
        str(line.sourceToolUseID) ?? str(blocks.find((b) => b.type === "tool_result")?.tool_use_id);
      if (said && toolUse) {
        const key = `${turn}:ask:${toolUse}`;
        const q = messageOf(base(turn), `${key}:q`, "assistant", said.questions, before(at));
        const a = messageOf(base(turn), key, "owner", said.answers, at);
        for (const r of [q, a]) if (r) records.push(r);
        continue;
      }
      if (blocks.some((b) => b.type === "tool_result")) continue;
      const origin = isObject(line.origin) ? str(line.origin.kind) : null;
      if (line.isMeta === true || origin !== "human") {
        count(skipped, origin ? `${origin} message` : "message without an origin");
        continue;
      }
      const r = messageOf(base(turn), `${turn}:owner`, "owner", textOf(content, PROMPT_SEP), at);
      if (r) records.push(r);
      continue;
    }
    if (line.type === "assistant") {
      if (!turn || !at || !message) continue;
      const id = str(message.id) ?? str(line.uuid) ?? "";
      const content = Array.isArray(message.content) ? message.content.filter(isObject) : [];
      for (const b of content) {
        if (b.type !== "tool_use" || typeof b.id !== "string" || !EDIT_TOOLS.has(String(b.name))) continue;
        const input = isObject(b.input) ? b.input : {};
        const file = str(input.file_path) ?? str(input.notebook_path);
        const rel = file ? relativeTo(place.root, file, cwd ?? place.root) : null;
        if (rel) pendingEdits.set(b.id, rel);
      }
      const text = textOf(content, REPLY_SEP);
      if (!text.trim()) continue;
      const prev = replies.get(turn);
      if (prev && prev.message === id) prev.texts.push(text);
      else replies.set(turn, { message: id, texts: [text], at });
      continue;
    }
    if (typeof line.type === "string" && !KNOWN_CLAUDE.has(line.type)) count(skipped, `${line.type} line`);
  }
  for (const [t, reply] of replies) {
    const r = messageOf(base(t), `${t}:assistant`, "assistant", reply.texts.join(REPLY_SEP), reply.at);
    if (r) records.push(r);
  }
  if (!session) excluded ??= "no session id";
  return {
    host: "claude-code",
    session: session ?? "",
    cwd,
    records: excluded ? [] : records,
    skipped,
    excluded,
  };
}

/** Line types of a Claude Code log that carry nothing capture records, counted apart from ones not seen before */
const KNOWN_CLAUDE = new Set([
  "user",
  "assistant",
  "system",
  "attachment",
  "summary",
  "file-history-snapshot",
  "queue-operation",
  "last-prompt",
  "custom-title",
  "agent-name",
  "relocated",
  "atis-latch",
  "api-request",
  "api-request-shape",
  "api-request-blob",
]);

/**
 * A Codex session log (`~/.codex/sessions/.../rollout-*.jsonl`, decompressed). Read only when its first line names the session's own thread
 * started by a person, not codex exec (the log cannot tell a person's exec from an agent's) and not a child thread. The owner's words are
 * the completed UserMessage items of that thread; host-injected context never arrives as one. The reply is the turn's last agent message.
 */
export function fromCodex(lines: readonly string[], place: Place): SessionLog {
  const skipped: Record<string, number> = {};
  const records: Spooled[] = [];
  const first = lines.length ? parse(lines[0] ?? "") : null;
  const meta = first?.type === "session_meta" && isObject(first.payload) ? first.payload : null;
  const session = str(meta?.id) ?? "";
  const cwd = str(meta?.cwd);
  const result = (excluded: string | null): SessionLog => ({
    host: "codex",
    session,
    cwd,
    records: excluded ? [] : records,
    skipped,
    excluded,
  });
  if (!meta || !session) return result("no session line");
  if (meta.thread_source !== "user" || isObject(meta.source)) return result("child thread");
  if (meta.originator === "codex_exec" || meta.source === "exec") return result("codex exec run");
  const base = (t: string): TurnBase => ({
    v: 2,
    host: "codex",
    session,
    project: place.key,
    branch: null,
    turn: t,
  });

  for (const raw of lines.slice(1)) {
    if (!raw.trim()) continue;
    const line = parse(raw);
    if (!line) {
      count(skipped, "unreadable line");
      continue;
    }
    const payload = isObject(line.payload) ? line.payload : null;
    const at = iso(line.timestamp);
    if (line.type !== "event_msg" || !payload || !at) continue;
    const turn = str(payload.turn_id);
    if (!turn) continue;
    if (payload.type === "task_complete") {
      const reply = str(payload.last_agent_message);
      const r = reply ? messageOf(base(turn), `${turn}:assistant`, "assistant", reply, at) : null;
      if (r) records.push(r);
      continue;
    }
    if (payload.type !== "item_completed" || !isObject(payload.item)) continue;
    if (payload.thread_id !== session) {
      count(skipped, "item of another thread");
      continue;
    }
    const item = payload.item;
    if (item.type === "UserMessage") {
      const r = messageOf(base(turn), `${turn}:owner`, "owner", textOf(item.content, PROMPT_SEP), at);
      if (r) records.push(r);
    } else if (item.type === "FileChange" && item.status === "completed" && isObject(item.changes)) {
      for (const file of Object.keys(item.changes)) {
        const rel = relativeTo(place.root, file, cwd ?? place.root);
        if (rel)
          records.push({ ...base(turn), kind: "edit", event: str(item.id), path: rel, via: "tool", at });
      }
    }
  }
  return result(null);
}
