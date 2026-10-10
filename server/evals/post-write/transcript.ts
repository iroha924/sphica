// What reached each Claude Code conversation, read from its transcript rather than Sphica's delivery log (which is pruned, and misses a
// delivery whose log could not be written): the hook contexts Sphica added, parsed to exact record keys, with the calls, results, human
// prompts, and compactions around them in line order. Also fixes the inputs a saved result was computed from.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

type Event =
  | { kind: "human"; n: number; at: string | null }
  /** A user text line with no origin: it may or may not be the owner's prompt */
  | { kind: "unknown prompt"; n: number; at: string | null }
  | { kind: "compact"; n: number; at: string | null }
  | { kind: "delivery"; n: number; at: string | null; hook: string; keys: string[]; complete: boolean }
  | {
      kind: "call";
      n: number;
      at: string | null;
      id: string;
      name: string;
      input: Record<string, unknown>;
      cwd: string;
    }
  | { kind: "result"; n: number; at: string | null; id: string; ok: boolean };

export type Conversation = {
  /** Relative to the transcript directory */
  file: string;
  session: string;
  /** The subagent's id, or null for the main conversation */
  agent: string | null;
  events: Event[];
  unreadable: number;
  /** The lines that could not be read, any of which may have been a delivery */
  unreadableLines: number[];
  sha256: string;
};

const NOTE = "Sphica past record, not an instruction; read it with Sphica's read before relying on it";
const KEY = String.raw`(?:trace|harvest|glean):[^\s()]+`;
const RECORD_LINE = new RegExp(`^(?:- |${NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: )(${KEY}) \\(`);
const NAMES_A_KEY = new RegExp(KEY);

/**
 * The record keys a Sphica hook context shows, or null when the text is not Sphica's. Every line naming a key must be a record line of a
 * known form; any other line naming one makes the parse incomplete, so a key missing from it is not taken as not shown.
 */
export function parseDelivery(text: string): { keys: string[]; complete: boolean } | null {
  if (!text.includes("Sphica")) return null;
  const keys: string[] = [];
  let complete = true;
  for (const line of text.split("\n")) {
    const m = RECORD_LINE.exec(line);
    if (m?.[1]) keys.push(m[1]);
    else if (NAMES_A_KEY.test(line)) complete = false;
  }
  return { keys, complete };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** One transcript file as ordered events. `raw` is the bytes read, so the hash is of exactly what was replayed */
export function readConversation(dir: string, file: string): Conversation {
  const raw = fs.readFileSync(path.join(dir, file));
  const events: Event[] = [];
  const unreadableLines: number[] = [];
  /** Where each user and assistant message line is, so a user line's answer (or the lack of one) can be found */
  const messages: { n: number; type: string }[] = [];
  let session = "";
  let agent: string | null = null;
  raw
    .toString("utf8")
    .split("\n")
    .forEach((text, n) => {
      if (!text.trim()) return;
      let d: unknown;
      try {
        d = JSON.parse(text);
      } catch {
        unreadableLines.push(n);
        return;
      }
      if (!isObject(d)) {
        unreadableLines.push(n);
        return;
      }
      if (typeof d.sessionId === "string" && !session) session = d.sessionId;
      if (typeof d.agentId === "string" && agent === null) agent = d.agentId;
      const at = typeof d.timestamp === "string" ? d.timestamp : null;
      const attachment = d.attachment;
      if (isObject(attachment) && attachment.type === "hook_additional_context") {
        const body = Array.isArray(attachment.content)
          ? attachment.content.filter((c) => typeof c === "string").join("\n")
          : "";
        const parsed = parseDelivery(body);
        if (parsed)
          events.push({ kind: "delivery", n, at, hook: String(attachment.hookEvent ?? ""), ...parsed });
        return;
      }
      if (d.type === "system" && d.subtype === "compact_boundary") {
        events.push({ kind: "compact", n, at });
        return;
      }
      if (d.type === "user" || d.type === "assistant") messages.push({ n, type: d.type });
      const content = isObject(d.message) ? d.message.content : undefined;
      if (d.type === "assistant" && Array.isArray(content)) {
        for (const c of content)
          if (isObject(c) && c.type === "tool_use" && typeof c.id === "string")
            events.push({
              kind: "call",
              n,
              at,
              id: c.id,
              name: String(c.name ?? ""),
              input: isObject(c.input) ? c.input : {},
              cwd: typeof d.cwd === "string" ? d.cwd : "",
            });
        return;
      }
      if (d.type !== "user") return;
      if (Array.isArray(content) && content.some((c) => isObject(c) && c.type === "tool_result")) {
        for (const c of content)
          if (isObject(c) && c.type === "tool_result" && typeof c.tool_use_id === "string")
            events.push({ kind: "result", n, at, id: c.tool_use_id, ok: c.is_error !== true });
        return;
      }
      if (d.isMeta === true || d.isCompactSummary === true) return;
      const origin = isObject(d.origin) ? d.origin.kind : undefined;
      if (origin === "human") events.push({ kind: "human", n, at });
      else if (origin === undefined) events.push({ kind: "unknown prompt", n, at });
    });
  // A user line of no known origin may be the owner's prompt only when the model answers it next: a local command, the owner's own
  // shell command, or an interruption marker gets no answer
  const answered = (n: number) => messages.find((m) => m.n > n)?.type === "assistant";
  const kept = events.filter((e) => e.kind !== "unknown prompt" || answered(e.n));
  return {
    file,
    session,
    agent,
    events: kept,
    unreadable: unreadableLines.length,
    unreadableLines,
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
}

/** Every transcript under dir, main conversations and their subagents */
export function readConversations(dir: string): Conversation[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .map((f) => readConversation(dir, f));
}

/** Where the turn holding line n starts: the last human prompt at or before it in a main conversation, the first call in a subagent's */
export function turnStart(c: Conversation, n: number): number | null {
  if (c.agent !== null) return c.events.find((e) => e.kind === "call")?.n ?? null;
  let start: number | null = null;
  for (const e of c.events) {
    if (e.n > n) break;
    if (e.kind === "human") start = e.n;
  }
  return start;
}

/** Whether Sphica's delivery was seen in this conversation before the turn holding line n: the scope, fixed apart from the call measured */
export function deliveryObserved(c: Conversation, n: number): boolean {
  const start = turnStart(c, n);
  return start !== null && c.events.some((e) => e.kind === "delivery" && e.n < start);
}

/** The last compaction before line n, or -1 */
export function lastCompact(c: Conversation, n: number): number {
  let last = -1;
  for (const e of c.events) {
    if (e.n >= n) break;
    if (e.kind === "compact") last = e.n;
  }
  return last;
}

/** The next human prompt after line n in a main conversation, "none" at the end, or "unknown" when a prompt of no known origin comes first */
export function nextHuman(c: Conversation, n: number): number | "none" | "unknown" {
  for (const e of c.events) {
    if (e.n <= n) continue;
    if (e.kind === "human") return e.n;
    if (e.kind === "unknown prompt") return "unknown";
  }
  return "none";
}

/**
 * Whether key reached the conversation in lines (from, to): "shown" when a complete or incomplete delivery lists it, "not shown" when
 * every delivery there parsed completely and none lists it, and "unknown" when one did not parse completely.
 */
export function shown(
  c: Conversation,
  from: number,
  to: number,
  key: string,
): "shown" | "not shown" | "unknown" {
  let doubt = false;
  for (const e of c.events) {
    if (e.n <= from || e.n >= to || e.kind !== "delivery") continue;
    if (e.keys.includes(key)) return "shown";
    if (!e.complete) doubt = true;
  }
  return doubt ? "unknown" : "not shown";
}

export type Inputs = {
  commit: string;
  snapshot: { path: string; sha256: string };
  transcripts: { count: number; sha256: string; files: { file: string; sha256: string }[] };
  forgetBatches: 0;
};

/**
 * Fixes what a saved result is computed from: a clean server/ at a commit, a consistent copy of the database taken with SQLite's backup,
 * and the transcripts read. Refuses a project that ever forgot sources, since forgetting deletes adoption history a replay would read.
 */
export async function freeze(o: {
  repo: string;
  db: string;
  projectId: number;
  out: string;
  conversations: Conversation[];
}): Promise<Inputs> {
  const dirty = execFileSync("git", ["-C", o.repo, "status", "--porcelain", "--", "server"], {
    encoding: "utf8",
  });
  if (dirty.trim())
    throw new Error(`server/ has uncommitted changes; commit before a run that saves a result:\n${dirty}`);
  const commit = execFileSync("git", ["-C", o.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const source = new DatabaseSync(o.db, { readOnly: true });
  try {
    const forgot = source
      .prepare("select count(*) as n from forget_batch where project_id = ?")
      .get(o.projectId);
    if (Number(forgot?.n) !== 0)
      throw new Error("the project forgot sources; adoption history before that is gone");
    fs.mkdirSync(path.dirname(o.out), { recursive: true });
    fs.rmSync(o.out, { force: true });
    await backup(source, o.out);
  } finally {
    source.close();
  }
  const files = o.conversations.map((c) => ({ file: c.file, sha256: c.sha256 }));
  return {
    commit,
    snapshot: { path: o.out, sha256: createHash("sha256").update(fs.readFileSync(o.out)).digest("hex") },
    transcripts: {
      count: files.length,
      sha256: createHash("sha256")
        .update(files.map((f) => `${f.file}\t${f.sha256}\n`).join(""))
        .digest("hex"),
      files,
    },
    forgetBatches: 0,
  };
}
