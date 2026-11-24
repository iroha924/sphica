// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Past sessions read from the hosts' own logs into the records live capture queues, so an import goes through the same send, views, and
// checks. The owner's words are only what the log marks as typed by a person, and AskUserQuestion answers, as live capture takes them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { leaves } from "./anchors.ts";
import { askedOf, messageOf, spoolDir, type Spooled, type TurnBase, unregisteredDir } from "./capture.ts";
import { ownThread } from "./codex-log.ts";
import type { Reads } from "./db.ts";
import type { Host } from "./knowledge.ts";
import { identify, relativeTo } from "./project.ts";

/**
 * Where a session's records go: the project key capture writes, and the root of the checkout it ran in, for relative paths. `rootOf`, when
 * given, tells each turn's checkout root from the directory the turn ran in, or null when that is not the repository: a session can move
 * between directories, and live capture decides the project at each hook call
 */
export type Place = { key: string; root: string; rootOf?: (cwd: string) => string | null };

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
const iso = (v: unknown): string | null => {
  const s = str(v);
  return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null;
};

/** The edit tools whose input names the file they wrote: the matcher of the capture hook in plugin/hooks/hooks.json */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Text the host puts in front of a person's prompt in the same line; it is the host's, never the owner's */
const HOST_BLOCK = /^\s*<system-reminder>/;

/** The text blocks of a message's content in order, joined by `sep`, leaving out blocks the host added */
const textOf = (content: unknown, sep: string): string =>
  typeof content === "string"
    ? HOST_BLOCK.test(content)
      ? ""
      : content
    : Array.isArray(content)
      ? content
          .filter((b): b is Json => isObject(b) && b.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string)
          .filter((text) => !HOST_BLOCK.test(text))
          .join(sep)
      : "";
/** A prompt's text blocks join with one line break, as the prompt in hook input does; reply blocks with a blank line (measured against live capture) */
const PROMPT_SEP = "\n";
const REPLY_SEP = "\n\n";

const ownerless = "no message marked as the owner's";
/** Why a log none of whose turns ran in the repository is not the repository's */
const ELSEWHERE = "ran in other directories";

/**
 * A Claude Code session log (`<config>/projects/<dir>/<session>.jsonl`). The owner's words are user lines whose origin is `human`, and prompts
 * typed while a turn ran (queued_command attachments of `human` origin, which live capture records under the running turn); notices, other
 * agents' reports, and meta lines are not. A turn is the prompt id of the user lines; the reply is the last assistant message with text in it.
 * A session a headless or SDK process ran (entrypoint `sdk-*`) is left out, as live capture leaves it out.
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
  const replies = new Map<string, { message: string; texts: string[]; at: string }>();
  const pendingEdits = new Map<string, string>();
  const asks = new Set<string>();
  const base = (t: string): TurnBase => ({
    v: 2,
    host: "claude-code",
    session: session ?? "",
    project: place.key,
    branch,
    turn: t,
  });
  const turnRoots = new Map<string, string | null>();
  /** The checkout root a turn ran in, or null when the turn ran outside the repository */
  const rootFor = (t: string): string | null =>
    turnRoots.has(t) ? (turnRoots.get(t) ?? null) : place.rootOf ? null : place.root;
  const keep = (t: string, r: Spooled | null): boolean => {
    if (!r) return false;
    if (!rootFor(t)) {
      count(skipped, "record of a turn in another directory");
      return false;
    }
    records.push(r);
    return true;
  };
  const owner = (t: string, text: string, at: string) => {
    if (keep(t, messageOf(base(t), `${t}:owner`, "owner", text, at))) owned = true;
  };

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
    if (line.type === "attachment") {
      const a = isObject(line.attachment) ? line.attachment : null;
      if (a?.type !== "queued_command" || !turn || !at) continue;
      const origin = isObject(a.origin) ? str(a.origin.kind) : null;
      if (origin === "human" && a.commandMode === "prompt" && a.isMeta !== true)
        owner(turn, textOf(a.prompt, PROMPT_SEP), iso(a.timestamp) ?? at);
      else count(skipped, `queued ${origin ?? "unmarked"} message`);
      continue;
    }
    if (line.type === "user") {
      turn = str(line.promptId) ?? turn;
      if (turn && !turnRoots.has(turn)) {
        const here = str(line.cwd) ?? cwd;
        turnRoots.set(turn, place.rootOf ? (here ? place.rootOf(here) : null) : place.root);
      }
      if (!turn || !at || !message) continue;
      const content = message.content;
      const blocks = Array.isArray(content) ? content.filter(isObject) : [];
      const results = blocks.filter((b) => b.type === "tool_result" && typeof b.tool_use_id === "string");
      for (const b of results) {
        const id = b.tool_use_id as string;
        const file = pendingEdits.get(id);
        pendingEdits.delete(id);
        const root = rootFor(turn);
        const rel = file && root ? relativeTo(root, file, str(line.cwd) ?? cwd ?? root) : null;
        if (rel && b.is_error !== true)
          keep(turn, { ...base(turn), kind: "edit", event: id, path: rel, via: "tool", at });
        if (asks.has(id)) {
          asks.delete(id);
          for (const r of askedOf(base(turn), { tool_response: line.toolUseResult }, id, at))
            if (keep(turn, r) && r.speaker === "owner") owned = true;
        }
      }
      if (results.length) continue;
      const origin = isObject(line.origin) ? str(line.origin.kind) : null;
      if (line.isMeta === true || origin !== "human") {
        count(skipped, origin ? `${origin} message` : "message without an origin");
        continue;
      }
      owner(turn, textOf(content, PROMPT_SEP), at);
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
      if (prev && prev.message === id) prev.texts.push(text);
      else replies.set(turn, { message: id, texts: [text], at });
      continue;
    }
    if (typeof line.type === "string" && !KNOWN_CLAUDE.has(line.type)) count(skipped, `${line.type} line`);
  }
  for (const [t, reply] of replies)
    keep(t, messageOf(base(t), `${t}:assistant`, "assistant", reply.texts.join(REPLY_SEP), reply.at));
  if (!session) excluded ??= "no session id";
  if (![...turnRoots.values()].some(Boolean)) excluded ??= ELSEWHERE;
  // A session with no owner message is not recorded: once recorded it is never read again, so a later reader could not add the owner's words
  if (!owned) excluded ??= ownerless;
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

/**
 * Why a Codex log is not a person's own session, from its first line, or null when it is one: the session's own thread (as live capture
 * decides it), from a terminal or an editor. codex exec is left out whole: the log cannot tell a person's exec from an agent's
 */
function codexExcluded(meta: Json | null): string | null {
  if (!meta || !str(meta.id)) return "no session line";
  const thread = {
    id: str(meta.id),
    originator: str(meta.originator),
    threadSource: str(meta.thread_source),
    parent: str(meta.parent_thread_id),
    subagent: null,
  };
  if (!ownThread({ session_id: thread.id ?? "" }, thread) || isObject(meta.source)) return "child thread";
  if (meta.originator === "codex_exec" || meta.source === "exec") return "codex exec run";
  if (!PERSON_SOURCES.has(String(meta.source))) return `${String(meta.source)} session`;
  return null;
}

const metaOf = (first: string | undefined): Json | null => {
  const line = first === undefined ? null : parse(first);
  return line?.type === "session_meta" && isObject(line.payload) ? line.payload : null;
};

/**
 * A Codex session log (`<CODEX_HOME>/sessions/.../rollout-*.jsonl`, decompressed). The owner's words are the completed UserMessage items of
 * the session's own thread (host-injected context arrived as other items in every log measured); the reply is the turn's last agent message.
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
    cwd,
    records: excluded ? [] : records,
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
const hostHomes = (): Homes => ({
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

/** A decompressed log over this many bytes is not read: the largest measured was 15 MB */
const MAX_LOG_BYTES = 256 * 1024 * 1024;

/** A file's lines, decompressed when it ends in `.zst`, or null when it cannot be read or is over the limit */
function linesOf(file: string): string[] | null {
  try {
    const buf = fs.readFileSync(file);
    const text = file.endsWith(".zst")
      ? zlib.zstdDecompressSync(buf, { maxOutputLength: MAX_LOG_BYTES })
      : buf;
    return text.toString("utf8").split("\n");
  } catch {
    return null;
  }
}

/** The first line of a zstd file, read without decompressing the rest, or null */
async function firstLineOf(file: string): Promise<string | null> {
  const stream = fs.createReadStream(file).pipe(zlib.createZstdDecompress());
  let text = "";
  try {
    for await (const chunk of stream) {
      text += (chunk as Buffer).toString("utf8");
      const end = text.indexOf("\n");
      if (end >= 0) return text.slice(0, end);
      if (text.length > 1024 * 1024) return null;
    }
    return text || null;
  } catch {
    return null;
  } finally {
    stream.destroy();
  }
}

/**
 * The logs both hosts keep for the target repository. A Claude Code session is a file directly in a project directory (its subagents sit
 * in folders beside it and are not read); a Codex session is a rollout, often compressed with zstd, whose first line is read before the rest.
 * A session that ran in another checkout of the same repository (a worktree) has its paths made relative to that checkout's root.
 */
export async function readLogs(
  target: Target,
  homes: Homes = hostHomes(),
): Promise<{ logs: SessionLog[]; unreadable: number; elsewhere: number }> {
  const logs: SessionLog[] = [];
  let unreadable = 0;
  let elsewhere = 0;
  const roots = new Map<string, string | null>();
  /** The root of the checkout a log ran in when it is the target repository's, or null */
  const rootOf = (cwd: string | null): string | null => {
    if (!cwd) return null;
    if (!roots.has(cwd)) {
      const found = fs.existsSync(cwd) ? identify(cwd) : null;
      roots.set(
        cwd,
        found
          ? found.key === target.match
            ? found.root
            : null
          : leaves(path.relative(target.root, cwd))
            ? null
            : target.root,
      );
    }
    return roots.get(cwd) ?? null;
  };
  const take = (
    lines: string[] | null,
    read: (l: string[], p: Place) => SessionLog,
    cwdOf: (l: string[]) => string | null,
  ) => {
    if (!lines) {
      unreadable++;
      return;
    }
    const root = rootOf(cwdOf(lines));
    if (!root) {
      elsewhere++;
      return;
    }
    logs.push(read(lines, { key: target.key, root }));
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
      // Each turn is the repository's or not by the directory it ran in, so a session that moved into the repository keeps those turns
      const log = fromClaude(lines, { key: target.key, root: target.root, rootOf });
      if (log.excluded === ELSEWHERE) elsewhere++;
      else logs.push(log);
    }

  const sessions = path.join(homes.codex, "sessions");
  const rollouts = (() => {
    try {
      return fs
        .readdirSync(sessions, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() && /^rollout-.*\.jsonl(?:\.zst)?$/.test(e.name))
        .map((e) => path.join(e.parentPath, e.name))
        .sort();
    } catch {
      return [];
    }
  })();
  for (const file of rollouts) {
    const first = file.endsWith(".zst") ? await firstLineOf(file) : (linesOf(file)?.[0] ?? null);
    const meta = metaOf(first ?? undefined);
    if (!first) {
      unreadable++;
      continue;
    }
    // Decided from the first line alone, so the rest of a log that is not read is never decompressed
    const out = codexExcluded(meta);
    if (out) {
      logs.push({
        host: "codex",
        session: str(meta?.id) ?? "",
        cwd: str(meta?.cwd),
        records: [],
        skipped: {},
        excluded: out,
      });
      continue;
    }
    if (!rootOf(str(meta?.cwd))) {
      elsewhere++;
      continue;
    }
    take(linesOf(file), fromCodex, (l) => str(metaOf(l[0])?.cwd));
  }
  return { logs, unreadable, elsewhere };
}

/** Session ids of records still waiting to be sent: live capture of a running or unsent session, which an import must not race */
function queuedSessions(): Set<string> {
  const ids = new Set<string>();
  for (const dir of [spoolDir(), unregisteredDir()])
    for (const e of entries(dir)) {
      if (!e.isFile() || !e.name.endsWith(".json")) continue;
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, e.name), "utf8")) as { session?: unknown };
        if (typeof r.session === "string") ids.add(r.session);
      } catch {
        // A record being written or set aside is read on the next send
      }
    }
  return ids;
}

/**
 * The logs to import: not left out, and neither in the database (live or imported before, so never read again) nor waiting in the queue
 * (a session still running, or one live capture has not sent yet: its records would collide with the import's at another time)
 */
export async function unrecorded(
  db: Reads,
  logs: readonly SessionLog[],
): Promise<{ fresh: SessionLog[]; known: number; running: number }> {
  const ids = [...new Set(logs.map((l) => l.session).filter(Boolean))];
  const known = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db
      .selectFrom("session")
      .select(["host", "external_id"])
      .where("external_id", "in", ids.slice(i, i + 500))
      .execute();
    for (const r of rows) known.add(`${r.host}\0${r.external_id}`);
  }
  const queued = queuedSessions();
  let running = 0;
  let knownCount = 0;
  const fresh = logs.filter((l) => {
    if (l.excluded) return false;
    if (known.has(`${l.host}\0${l.session}`)) {
      knownCount++;
      return false;
    }
    if (queued.has(l.session)) {
      running++;
      return false;
    }
    return true;
  });
  return { fresh, known: knownCount, running };
}

/** How many of the given messages the database holds now, by session and id: what an import actually wrote */
export async function written(db: Reads, logs: readonly SessionLog[]): Promise<number> {
  let n = 0;
  for (const log of logs) {
    const ids = log.records.flatMap((r) => (r.kind === "message" ? [r.id] : []));
    for (let i = 0; i < ids.length; i += 500) {
      const row = await db
        .selectFrom("source")
        .innerJoin("session", "session.id", "source.session_id")
        .select((eb) => eb.fn.count<number>("source.id").as("n"))
        .where("session.host", "=", log.host)
        .where("session.external_id", "=", log.session)
        .where("source.kind", "=", "session_message")
        .where("source.external_id", "in", [...new Set(ids.slice(i, i + 500))])
        .executeTakeFirst();
      n += Number(row?.n ?? 0);
    }
  }
  return n;
}
