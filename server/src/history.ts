// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Past sessions read from the hosts' own logs into the records live capture queues, so an import goes through the same send, views, and
// checks. The owner's words are only what the log marks as typed by a person, and AskUserQuestion answers, as live capture takes them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { leaves } from "./anchors.ts";
import {
  askedOf,
  chunks,
  messageOf,
  queued,
  spoolDir,
  type Spooled,
  type TurnBase,
  unregisteredDir,
} from "./capture.ts";
import { ownThread, SESSION_META_BYTES } from "./codex-log.ts";
import type { Reads } from "./db.ts";
import type { Host } from "./knowledge.ts";
import { identify, relativeTo } from "./project.ts";

/**
 * Where a session's records go: the project key capture writes, and the checkout root paths are relative to. `rootOf` tells that root from
 * the directory a line ran in, or null outside the repository, since a session can move between directories and live capture decides per call
 */
export type Place = { key: string; root: string; rootOf?: (cwd: string) => string | null };

export type SessionLog = {
  host: Host;
  session: string;
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
const iso = (v: unknown): string | null => {
  const s = str(v);
  return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null;
};

/** The edit tools whose input names the file they wrote: the matcher of the capture hook in plugin/hooks/hooks.json */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** System reminders the host puts in front of a person's prompt; an unclosed one hides the rest */
const HOST_BLOCKS = /^\s*(?:<system-reminder>[\s\S]*?<\/system-reminder>\s*)+/;
const withoutHost = (text: string): string =>
  /^\s*<system-reminder>/.test(text) ? (HOST_BLOCKS.test(text) ? text.replace(HOST_BLOCKS, "") : "") : text;

/** The text blocks of a message's content in order, joined by `sep`, without the host's reminders in front of them */
const textOf = (content: unknown, sep: string): string =>
  typeof content === "string"
    ? withoutHost(content)
    : Array.isArray(content)
      ? content
          .filter((b): b is Json => isObject(b) && b.type === "text" && typeof b.text === "string")
          .map((b) => withoutHost(b.text as string))
          .filter((text) => text !== "")
          .join(sep)
      : "";
/** A prompt's text blocks join with one line break, as the prompt in hook input does; reply blocks with a blank line (measured against live capture) */
const PROMPT_SEP = "\n";
const REPLY_SEP = "\n\n";

const ownerless = "no message marked as the owner's";
/** Each message id once, the first: the same text twice in a turn has one id, and the database refuses its repeat at another time */
const once = (records: Spooled[]): Spooled[] => {
  const seen = new Set<string>();
  return records.filter((r) => r.kind !== "message" || (!seen.has(r.id) && Boolean(seen.add(r.id))));
};
/** Why a log none of whose lines ran in the repository is not the repository's */
const ELSEWHERE = "ran in other directories";

/**
 * A Claude Code log (`<config>/projects/<dir>/<session>.jsonl`). The owner's words: user lines of `human` origin, and `human` prompts queued
 * while a turn ran (live capture records them under that turn). A turn is the user lines' prompt id, its reply the last assistant message
 * with text. Each record keeps to the repository by its own line's directory. A headless or SDK run (entrypoint `sdk-*`) is left out whole
 */
export function fromClaude(lines: readonly string[], place: Place): SessionLog {
  const skipped: Record<string, number> = {};
  const records: Spooled[] = [];
  let session: string | null = null;
  let cwd: string | null = null;
  let branch: string | null = null;
  let excluded: string | null = null;
  let turn: string | null = null;
  let owned = false;
  let here = false;
  const replies = new Map<string, { message: string; texts: string[]; at: string; cwd: string | null }>();
  let replying: string | null = null;
  const pendingEdits = new Map<string, string>();
  const asks = new Set<string>();
  const rootAt = (dir: string | null): string | null =>
    place.rootOf ? (dir ? place.rootOf(dir) : null) : place.root;
  const base = (t: string): TurnBase => ({
    v: 2,
    host: "claude-code",
    session: session ?? "",
    project: place.key,
    branch,
    turn: t,
  });
  const keep = (r: Spooled | null, dir: string | null): boolean => {
    if (!r) return false;
    if (!rootAt(dir)) {
      count(skipped, "record from another directory");
      return false;
    }
    records.push(r);
    return true;
  };
  const owner = (t: string, text: string, at: string, dir: string | null) => {
    if (keep(messageOf(base(t), `${t}:owner`, "owner", text, at), dir)) owned = true;
  };

  for (const raw of lines) {
    if (!raw.trim()) continue;
    const line = parse(raw);
    if (!line) {
      count(skipped, "unreadable line");
      continue;
    }
    session ??= str(line.sessionId);
    if (line.isSidechain === true) {
      count(skipped, "subagent line");
      continue;
    }
    cwd = str(line.cwd) ?? cwd;
    if (rootAt(cwd)) here = true;
    branch ??= str(line.gitBranch);
    if (str(line.entrypoint)?.startsWith("sdk-")) excluded ??= "headless or SDK run";
    const at = iso(line.timestamp);
    const message = isObject(line.message) ? line.message : null;
    if (line.type === "attachment") {
      const a = isObject(line.attachment) ? line.attachment : null;
      if (a?.type !== "queued_command" || !turn || !at) continue;
      const origin = isObject(a.origin) ? str(a.origin.kind) : null;
      if (origin === "human" && a.commandMode === "prompt" && a.isMeta !== true)
        owner(turn, textOf(a.prompt, PROMPT_SEP), iso(a.timestamp) ?? at, cwd);
      else count(skipped, `queued ${origin ?? "unmarked"} message`);
      continue;
    }
    if (line.type === "user") {
      turn = str(line.promptId) ?? turn;
      if (!turn || !at || !message) continue;
      const content = message.content;
      const blocks = Array.isArray(content) ? content.filter(isObject) : [];
      const results = blocks.filter((b) => b.type === "tool_result" && typeof b.tool_use_id === "string");
      for (const b of results) {
        const id = b.tool_use_id as string;
        const file = pendingEdits.get(id);
        pendingEdits.delete(id);
        const root = rootAt(cwd);
        const rel = file && root ? relativeTo(root, file, cwd ?? root) : null;
        if (rel && b.is_error !== true)
          keep({ ...base(turn), kind: "edit", event: id, path: rel, via: "tool", at }, cwd);
        if (asks.has(id)) {
          asks.delete(id);
          for (const r of askedOf(base(turn), { tool_response: line.toolUseResult }, id, at))
            if (keep(r, cwd) && r.speaker === "owner") owned = true;
        }
      }
      if (results.length) continue;
      // Claude Code runs no Stop hook for a turn the owner interrupted, so live capture keeps none of its reply
      if (textOf(content, PROMPT_SEP).startsWith("[Request interrupted by user")) {
        if (replying) replies.delete(replying);
        count(skipped, "interrupted reply");
        continue;
      }
      const origin = isObject(line.origin) ? str(line.origin.kind) : null;
      if (line.isMeta === true || origin !== "human") {
        count(skipped, origin ? `${origin} message` : "message without an origin");
        continue;
      }
      owner(turn, textOf(content, PROMPT_SEP), at, cwd);
      continue;
    }
    if (line.type === "assistant") {
      if (!turn || !at || !message) continue;
      const id = str(message.id) ?? str(line.uuid) ?? "";
      const content = Array.isArray(message.content) ? message.content.filter(isObject) : [];
      for (const b of content) {
        if (b.type !== "tool_use" || typeof b.id !== "string") continue;
        if (b.name === "AskUserQuestion") asks.add(b.id);
        if (!EDIT_TOOLS.has(String(b.name))) continue;
        const input = isObject(b.input) ? b.input : {};
        const file = str(input.file_path) ?? str(input.notebook_path);
        if (file) pendingEdits.set(b.id, file);
      }
      const text = textOf(content, REPLY_SEP);
      if (!text.trim()) continue;
      const prev = replies.get(turn);
      if (prev && prev.message === id) {
        prev.texts.push(text);
        prev.cwd = cwd;
      } else replies.set(turn, { message: id, texts: [text], at, cwd });
      replying = turn;
      continue;
    }
    if (typeof line.type === "string" && !KNOWN_CLAUDE.has(line.type)) count(skipped, `${line.type} line`);
  }
  // A reply belongs where the turn's last message ran, as live capture sends it from the Stop hook there
  for (const [t, reply] of replies)
    keep(messageOf(base(t), `${t}:assistant`, "assistant", reply.texts.join(REPLY_SEP), reply.at), reply.cwd);
  if (!here) excluded = ELSEWHERE;
  if (!session) excluded ??= "no session id";
  // A session with no owner message is not recorded: once recorded it is never read again, so a later reader could not add the owner's words
  if (!owned) excluded ??= ownerless;
  return {
    host: "claude-code",
    session: session ?? "",
    records: excluded ? [] : once(records),
    skipped,
    excluded,
  };
}

/** Line types of a Claude Code log that carry nothing capture records, counted apart from ones not seen before */
const KNOWN_CLAUDE = new Set([
  "user",
  "assistant",
  "system",
  "summary",
  "file-history-snapshot",
  "file-history-delta",
  "queue-operation",
  "last-prompt",
  "custom-title",
  "ai-title",
  "agent-name",
  "relocated",
  "atis-latch",
  "api-request",
  "api-request-shape",
  "api-request-blob",
  "mode",
  "permission-mode",
  "pr-link",
  "tools-used",
  "cost-state",
]);

/** The sources of a Codex thread a person started in a terminal or an editor; exec, MCP, and child threads are not one */
const PERSON_SOURCES = new Set(["cli", "vscode"]);

/** Why a Codex log is not a person's own session, from its first line, or null: the session's own thread as live capture decides it, from a terminal or an editor */
function codexExcluded(meta: Json | null): string | null {
  const id = str(meta?.id);
  if (!meta || !id) return "no session line";
  const thread = {
    id,
    originator: str(meta.originator),
    threadSource: str(meta.thread_source),
    parent: str(meta.parent_thread_id),
    subagent: null,
  };
  if (!ownThread({ session_id: id }, thread) || isObject(meta.source)) return "child thread";
  // The log cannot tell an exec a person started from one an agent started
  if (meta.originator === "codex_exec" || meta.source === "exec") return "codex exec run";
  if (!PERSON_SOURCES.has(String(meta.source))) return "session not started from a terminal or an editor";
  return null;
}

const metaOf = (first: string | undefined | null): Json | null => {
  const line = first ? parse(first) : null;
  return line?.type === "session_meta" && isObject(line.payload) ? line.payload : null;
};

/**
 * A Codex log (`<CODEX_HOME>/sessions/.../rollout-*.jsonl`, decompressed). The owner's words are the completed UserMessage items of the
 * session's own thread (host-injected context arrived as other items in every log measured); the reply is each turn's last agent message.
 */
export function fromCodex(lines: readonly string[], place: Place): SessionLog {
  const skipped: Record<string, number> = {};
  const records: Spooled[] = [];
  const meta = metaOf(lines[0]);
  const session = str(meta?.id) ?? "";
  const cwd = str(meta?.cwd);
  let owned = false;
  const result = (excluded: string | null): SessionLog => ({
    host: "codex",
    session,
    records: excluded ? [] : once(records),
    skipped,
    excluded,
  });
  const out = codexExcluded(meta);
  if (out) return result(out);
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
      if (r) {
        records.push(r);
        owned = true;
      }
    } else if (item.type === "FileChange" && item.status === "completed" && isObject(item.changes)) {
      for (const file of Object.keys(item.changes)) {
        const rel = relativeTo(place.root, file, cwd ?? place.root);
        if (rel)
          records.push({ ...base(turn), kind: "edit", event: str(item.id), path: rel, via: "tool", at });
      }
    }
  }
  return result(owned ? null : ownerless);
}

/** Where each host keeps its logs: Claude Code under `$CLAUDE_CONFIG_DIR/projects` (`~/.claude` by default), Codex under `$CODEX_HOME/sessions` */
export type Homes = { claude: string; codex: string };
export const hostHomes = (): Homes => ({
  claude: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
  codex: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
});

/** The repository the import is for: `key` is what its records carry, `match` the key a directory's repository is compared with */
export type Target = Place & { match: string };

/** Entries of a directory, or none when it cannot be read */
const entries = (dir: string): fs.Dirent[] => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/** A log over this many bytes, compressed or not, is not read: the largest measured was 15 MB */
const MAX_LOG_BYTES = 256 * 1024 * 1024;

/** A file's lines, decompressed when it ends in `.zst`, or null when it cannot be read or is over the limit */
function linesOf(file: string): string[] | null {
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) return null;
    const buf = fs.readFileSync(file);
    const text = file.endsWith(".zst")
      ? zlib.zstdDecompressSync(buf, { maxOutputLength: MAX_LOG_BYTES })
      : buf;
    return text.toString("utf8").split("\n");
  } catch {
    return null;
  }
}

/** The first line of a log without reading the rest, within the bytes live capture reads it from, or null */
async function firstLineOf(file: string): Promise<string | null> {
  const source = fs.createReadStream(file, { end: file.endsWith(".zst") ? undefined : SESSION_META_BYTES });
  const unzip = file.endsWith(".zst") ? zlib.createZstdDecompress() : null;
  // A pipe does not pass the source's errors on; without this an unreadable file ends the process
  if (unzip) {
    source.on("error", (e) => unzip.destroy(e));
    source.pipe(unzip);
  }
  // Counted in bytes, and a line that does not end within them is no first line, as live capture reads it (codexThread)
  let bytes = Buffer.alloc(0);
  try {
    for await (const chunk of unzip ?? source) {
      bytes = Buffer.concat([bytes, chunk as Buffer]);
      const end = bytes.indexOf(0x0a);
      if (end >= 0 && end < SESSION_META_BYTES) return bytes.subarray(0, end).toString("utf8");
      if (bytes.length >= SESSION_META_BYTES) return null;
    }
    return null;
  } catch {
    return null;
  } finally {
    source.destroy();
    unzip?.destroy();
  }
}

/**
 * The logs both hosts keep for the target repository, from logs that ran in it or in another checkout of it (each checkout's own root is
 * kept for paths). A Claude Code session is a file directly in a project directory; its subagents' folders beside it are not read
 */
export async function readLogs(
  target: Target,
  homes: Homes = hostHomes(),
): Promise<{ logs: SessionLog[]; unreadable: number; elsewhere: number }> {
  const logs: SessionLog[] = [];
  let unreadable = 0;
  let elsewhere = 0;
  const roots = new Map<string, string | null>();
  /** The root of the checkout a directory is in when that checkout is the target repository's, or null */
  const rootOf = (cwd: string): string | null => {
    if (!roots.has(cwd)) roots.set(cwd, checkoutRoot(cwd, target));
    return roots.get(cwd) ?? null;
  };

  const projects = path.join(homes.claude, "projects");
  for (const dir of entries(projects).filter((e) => e.isDirectory()))
    for (const f of entries(path.join(projects, dir.name))) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const lines = linesOf(path.join(projects, dir.name, f.name));
      if (!lines) {
        unreadable++;
        continue;
      }
      const log = fromClaude(lines, { key: target.key, root: target.root, rootOf });
      if (log.excluded === ELSEWHERE) elsewhere++;
      else logs.push(log);
    }

  const sessions = path.join(homes.codex, "sessions");
  let rollouts: string[] = [];
  try {
    rollouts = fs
      .readdirSync(sessions, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && /^rollout-.*\.jsonl(?:\.zst)?$/.test(e.name))
      .map((e) => path.join(e.parentPath, e.name))
      .sort();
  } catch {
    // No Codex logs here
  }
  for (const file of rollouts) {
    const meta = metaOf(await firstLineOf(file));
    const cwd = str(meta?.cwd);
    if (!meta) {
      unreadable++;
      continue;
    }
    // Decided from the first line alone, so the rest of a log that is not read is never decompressed
    const root = cwd ? rootOf(cwd) : null;
    if (!root) {
      elsewhere++;
      continue;
    }
    const out = codexExcluded(meta);
    if (out) {
      logs.push({ host: "codex", session: str(meta.id) ?? "", records: [], skipped: {}, excluded: out });
      continue;
    }
    const lines = linesOf(file);
    if (!lines) unreadable++;
    else logs.push(fromCodex(lines, { key: target.key, root }));
  }
  return { logs, unreadable, elsewhere };
}

/**
 * The root of the checkout `cwd` is in when it is the target repository's: by the directory's own repository while it exists, else by its
 * place under the target's root, where Claude Code keeps its worktrees in `.claude/worktrees/<name>`
 */
function checkoutRoot(cwd: string, target: Target): string | null {
  if (fs.existsSync(cwd)) {
    const found = identify(cwd);
    return found?.key === target.match ? found.root : null;
  }
  const rel = path.relative(target.root, cwd);
  if (leaves(rel)) return null;
  const parts = rel.split(path.sep);
  return parts[0] === ".claude" && parts[1] === "worktrees" && parts[2]
    ? path.join(target.root, ".claude", "worktrees", parts[2])
    : target.root;
}

/** Session ids of records still waiting to be sent: live capture of a running or unsent session, which an import must not race */
function queuedSessions(): Set<string> {
  const ids = new Set<string>();
  for (const { name, from } of [...queued(spoolDir()), ...queued(unregisteredDir())]) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(from, name), "utf8")) as { session?: unknown };
      if (typeof r.session === "string") ids.add(r.session);
    } catch {
      // Sent or set aside since it was listed
    }
  }
  return ids;
}

/**
 * The logs to import: not left out, not waiting in the queue (a session still running, or one live capture has not sent, would collide),
 * and not in the database (never read again). The queue is read first, so a send between the two reads cannot let a session through
 */
export async function unrecorded(
  db: Reads,
  logs: readonly SessionLog[],
  projectKeys: readonly string[],
): Promise<{ fresh: SessionLog[]; known: number; running: number }> {
  const queuedNow = queuedSessions();
  const ids = [...new Set(logs.map((l) => l.session).filter(Boolean))];
  const known = new Set<string>();
  for (const part of chunks(ids)) {
    // Per project: a session that ran in two repositories is recorded apart in each
    const rows = await db
      .selectFrom("session")
      .innerJoin("project", "project.id", "session.project_id")
      .select(["session.host", "session.external_id"])
      .where("project.key", "in", [...projectKeys])
      .where("session.external_id", "in", part)
      .execute();
    for (const r of rows) known.add(`${r.host}\0${r.external_id}`);
  }
  let running = 0;
  let knownCount = 0;
  const fresh = logs.filter((l) => {
    if (l.excluded) return false;
    if (queuedNow.has(l.session)) {
      running++;
      return false;
    }
    if (known.has(`${l.host}\0${l.session}`)) {
      knownCount++;
      return false;
    }
    return true;
  });
  return { fresh, known: knownCount, running };
}

/** How many of the given messages the database holds now, by session and id: what an import actually wrote */
export async function written(
  db: Reads,
  logs: readonly SessionLog[],
  projectKeys: readonly string[],
): Promise<number> {
  let n = 0;
  for (const log of logs) {
    const ids = [...new Set(log.records.flatMap((r) => (r.kind === "message" ? [r.id] : [])))];
    for (const part of chunks(ids)) {
      const row = await db
        .selectFrom("source")
        .innerJoin("session", "session.id", "source.session_id")
        .innerJoin("project", "project.id", "session.project_id")
        .select((eb) => eb.fn.count<number>("source.id").as("n"))
        .where("project.key", "in", [...projectKeys])
        .where("session.host", "=", log.host)
        .where("session.external_id", "=", log.session)
        .where("source.kind", "=", "session_message")
        .where("source.external_id", "in", part)
        .executeTakeFirst();
      n += Number(row?.n ?? 0);
    }
  }
  return n;
}
