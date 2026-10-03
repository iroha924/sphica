#!/usr/bin/env node
// Conversation recording. Called from hooks, it keeps your messages, the AI's last response, and touched files.
//
// **Recording hooks only write to a local queue.** A process detached by Stop sends it to the database in batches.
// While the database is unreachable the records stay queued and are resent idempotently next time (ids are derived from the input).
//
// **Prompts you did not type are never recorded as your messages.** In a prior case, prompts meant for another agent
// made up 97.2% of the database as "user messages". There are five checks, none of them guesses.
//   - turns inside a subagent carry agent_id in the hook input
//   - children started by Claude Code (claude -p or codex exec run from Bash) inherit SPHICA_PARENT_SESSION, which the parent's
//     SessionStart wrote to CLAUDE_ENV_FILE. If it differs from its own session id, it is a child
//     (to keep a launch from being recorded, set a value that matches no session. The value is that session's id so that, if this
//     variable ever reaches the hook's own environment, it matches your own session id and recording does not stop)
//   - another Codex started from a Codex shell inherits the parent's CODEX_THREAD_ID. If it differs from the hook input's session id, it is a child
//   - headless runs (claude -p) and Agent SDK runs have a CLAUDE_CODE_ENTRYPOINT starting with sdk- (sdk-cli, sdk-ts, sdk-py), checked
//     before the marker. Attended hosts set other values (cli, claude-desktop), so only sdk- values are excluded. An SDK agent started
//     outside the Bash tool that inherits cli and no marker cannot be told apart
//   - even within your session, background task completion and stop notices, and messages from channels, subagents, teammates,
//     or other sessions arrive at UserPromptSubmit (notices measured in 2.1.269). They are dropped by fixed shapes (INJECTED)

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Kysely } from "kysely";
import { dbFile, inTransaction, iso, sqliteCode } from "./db.ts";
import type { DB } from "./db-types.ts";
import { openWriter } from "./db-write.ts";
import { type Host, sessionId } from "./knowledge.ts";
import { panel, plain } from "./panel.ts";
import { identify, normalizeKey, patchPaths, relativeTo } from "./project.ts";
import { sphicaHome } from "./sqlite.ts";
import { bytes, clean, head, mask, plural, reason, sha256, tail } from "./text.ts";
import { changed, snapshot } from "./worktree.ts";

// Resolve the location on every call (so tests that replace HOME never touch the real queue).
export const spoolDir = (): string => path.join(sphicaHome(), "spool");
const stateFile = (): string => path.join(sphicaHome(), "capture.json");
/** Records the database rejected. Moved here instead of deleted, and counted by doctor (fix and move them back to resend). */
export const rejectedDir = (): string => path.join(spoolDir(), "rejected");
/**
 * Records of projects not registered yet. Kept here instead of deleted. Hooks do not touch the database, so whether a project is
 * registered is known only when sending. Deleting them would lose the messages in between even after a later `sphica init`.
 * The next send reads here too, so registering is enough for them to go in.
 */
export const unregisteredDir = (): string => path.join(spoolDir(), "unregistered");
/** Limit for set-aside records: room to move machines and register without filling the disk. */
export const HOLD_DAYS = 30;
export const HOLD_MAX = 1000;
/** Where each session's working tree stood when its running turn began. Turn start and end run in separate hook processes. */
const baselineDir = (): string => path.join(sphicaHome(), "worktree");

/** A queued record. Capture writes v:2; a v:1 record still in a queue from an older install is translated when sent (never silently dropped). */
export type Spooled =
  | {
      v: 2;
      kind: "message";
      host: Host;
      session: string;
      project: string;
      branch: string | null;
      turn: string;
      /** Unique within the session */
      id: string;
      speaker: "owner" | "assistant";
      body: string;
      truncated: boolean;
      redacted: boolean;
      originalBytes: number;
      at: string;
    }
  | {
      v: 2;
      kind: "edit";
      host: Host;
      session: string;
      project: string;
      branch: string | null;
      turn: string;
      /** The tool call that reported the edit */
      event: string | null;
      path: string;
      /** Reported by an edit tool, or seen changing in git status over the turn */
      via: "tool" | "status";
      at: string;
    };

type SpooledV1 =
  | {
      v: 1;
      kind: "message";
      speaker: "self" | "assistant";
      truncated: boolean;
      originalBytes: number;
      body: string;
    }
  | { v: 1; kind: "file"; action: string; path: string };

/** A record read from the queue in the current shape, or null when it is a v:1 record with nothing to keep (a read file). */
export function current(raw: unknown): Spooled | null {
  const r = raw as { v?: number } & Record<string, unknown>;
  // The send looks the project up by this key: a record without one is set aside instead of failing its whole batch
  if (typeof r.project !== "string") throw new Error("queue record without a project key");
  if (r.v === 2) return raw as Spooled;
  if (r.v !== 1) throw new Error(`unknown queue record version ${String(r.v)}`);
  const old = raw as SpooledV1 &
    Omit<Extract<Spooled, { kind: "edit" }>, "v" | "kind" | "event" | "path" | "via">;
  if (old.kind === "message")
    return {
      ...old,
      v: 2,
      kind: "message",
      speaker: old.speaker === "self" ? "owner" : "assistant",
      redacted: false,
    } as Spooled;
  if (old.action !== "edit") return null;
  return { ...old, v: 2, kind: "edit", event: null, path: old.path, via: "tool" } as Spooled;
}

/** Limit for one message. Beyond it only the start and end are kept (a huge log pasted by mistake never fills the database and index). */
export const MAX_MESSAGE = 128 * 1024;
const KEEP = 8 * 1024;

/**
 * Fits the size and masks keys. **Masking runs only on the kept part** — never run regexes over the whole of a huge input.
 * To avoid leaving half a key across the cut, it masks a window twice the kept length, then cuts.
 * Without cutting, the kept size equals the masked body (the table CHECK).
 */
export function fit(body: string): {
  body: string;
  truncated: boolean;
  redacted: boolean;
  originalBytes: number;
} {
  const all = bytes(body);
  if (all <= MAX_MESSAGE) {
    const kept = mask(body);
    return { body: kept, truncated: false, redacted: kept !== body, originalBytes: all };
  }
  const start = head(body, KEEP * 2);
  const end = tail(body, KEEP * 2);
  const a = head(mask(start), KEEP);
  const z = tail(mask(end), KEEP);
  const cut = all - bytes(a) - bytes(z);
  return {
    body: `${a}\n\n[${cut.toLocaleString("en-US")} bytes in the middle not saved]\n\n${z}`,
    truncated: true,
    // Masking leaves the text before its first mask as it was, so a kept part equal to the unmasked cut was not changed by masking
    redacted: a !== head(start, KEEP) || z !== tail(end, KEEP),
    originalBytes: all,
  };
}

/**
 * Prunes set-aside records. Without a limit they fill the disk — used without registering, unsendable
 * records pile up forever. Names start with the time they were stored (ms), so name order is oldest first.
 */
function prune(held: string): void {
  let files: string[];
  try {
    files = fs
      .readdirSync(held)
      .filter((f) => f.endsWith(".json") && !f.startsWith("."))
      .sort();
  } catch {
    return; // not there yet
  }
  const cutoff = Date.now() - HOLD_DAYS * 24 * 60 * 60 * 1000;
  const stale = files.filter((f) => Number(f.split("-")[0]) < cutoff);
  const over = files.slice(0, Math.max(0, files.length - HOLD_MAX));
  for (const f of new Set([...stale, ...over])) fs.rmSync(path.join(held, f), { force: true });
}

function spool(record: Spooled): void {
  const dir = spoolDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}.json`;
  const tmp = path.join(dir, `.${name}`);
  // Write under another name, then replace, so a half-written file is never sent.
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, name));
}

/** The current branch. Reads HEAD without starting git (in a worktree .git is a file pointing to the real location). */
export const branchOf = (root: string): string | null => {
  try {
    const dotgit = path.join(root, ".git");
    const gitdir = fs.statSync(dotgit).isFile()
      ? path.resolve(
          root,
          fs
            .readFileSync(dotgit, "utf8")
            .match(/^gitdir: (.+)$/m)?.[1]
            ?.trim() ?? "",
        )
      : dotgit;
    const h = fs.readFileSync(path.join(gitdir, "HEAD"), "utf8").trim();
    return h.startsWith("ref: refs/heads/") ? h.slice("ref: refs/heads/".length) : null;
  } catch {
    return null;
  }
};

export type HookInput = {
  hook_event_name?: string;
  session_id?: string;
  prompt_id?: string;
  turn_id?: string;
  agent_id?: string;
  cwd?: string;
  prompt?: string;
  last_assistant_message?: string | null;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
};

/** Whether this is your turn. Drops subagents, children started by agents, and headless and Agent SDK runs. */
export function isOwnerTurn(
  input: HookInput,
  parent = process.env.SPHICA_PARENT_SESSION,
  entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT,
  codexParent?: string,
): boolean {
  if (!input.session_id || input.agent_id) return false;
  // A child started from a Codex shell inherits the parent's CODEX_THREAD_ID, while the hook input carries the child's own session id.
  if (codexParent && codexParent !== input.session_id) return false;
  // The SDK sets sdk-* only when the entrypoint is unset, so a matching marker with it is an SDK process that inherited the env file.
  if (entrypoint?.startsWith("sdk-")) return false;
  if (parent) return parent === input.session_id;
  return true;
}

/**
 * Shapes of prompts that arrive without you typing them. Hook input has no origin marker (the transcript does; measured in 2.1.269), so they are dropped by shape:
 * background task completion notices, notices of stopping a background agent, and messages from channels, Slack, web fetch results, other sessions,
 * subagents, and teammates. Observed as arriving in Claude Code 2.1.270 (completion notices, stop notices, and messages exist in local transcripts).
 * **Shapes not listed are recorded as your messages** (a prompt fired by `/loop` arrives as bare text and cannot be dropped).
 * When the version goes up, check hook input and transcripts again.
 * **Dropped by how they start.** Dropping a message you started with wrapper or notice wording beats mistaking machine text for yours
 * (some notices carry text after the closing tag. Across all local transcripts, none of your 830 inputs were dropped and all 227 marked notices and
 * messages were). Wording is dropped only when it matches up to the delimiter (`:` or `.`).
 */
const INJECTED = [
  /^<(?:task-notification|channel|cross-session-message|teammate-message|agent-message|slack-ping|slack-tag-message|fetched-web-content|remote-review|remote-review-progress)[\s>]/,
  /^(?:\d+ background agents were stopped by the user:|Background agent ".*" was stopped by the user\.)/,
  /^(?:Another Claude|A peer) session sent a message(?: while you were working)?:/,
];

/**
 * The second half of message and response ids. **One turn id can carry several messages and responses** — messages typed while working arrive
 * with the running turn's id (143 of 148 in transcripts), and turns started by messages from other sessions reuse the previous turn's id
 * (all 127). Ids from the turn id alone collide on the unique constraint, and the later one is silently dropped.
 * **Built from the masked body** (building from the unmasked body would let weak keys be brute-forced by matching the masked body). The same
 * input arriving twice is one row. The same text arriving twice with the same turn id (a repeated addition or response) is one row too.
 */
const digest = (s: string): string => sha256(s).toString("hex").slice(0, 16);

/**
 * The answers you chose in AskUserQuestion, and notes added to them. The questions are the model's words and are recorded as its message; only the answers are yours.
 * tool_response is `{ questions, answers: {question: answer}, annotations: {question: { notes }} }` (confirmed in real transcripts).
 * **Answers come only from tool_response.** tool_input is written by the model, so its values are never taken as your answers.
 */
export function answersOf(input: HookInput): { questions: string; answers: string } | null {
  const response = input.tool_response as
    | { answers?: Record<string, unknown>; annotations?: Record<string, { notes?: unknown }> }
    | undefined;
  const answers = response?.answers;
  if (!answers || typeof answers !== "object") return null;
  const pairs = Object.entries(answers);
  if (!pairs.length) return null;
  return {
    questions: pairs.map(([q], i) => `Q${i + 1}: ${q}`).join("\n\n"),
    answers: pairs
      .map(([q, a], i) => {
        const notes = response?.annotations?.[q]?.notes;
        const memo = typeof notes === "string" && notes.trim() ? `\nNotes: ${notes.trim()}` : "";
        return `A${i + 1}: ${Array.isArray(a) ? a.join(" / ") : String(a)}${memo}`;
      })
      .join("\n\n"),
  };
}

/**
 * The notice shown to you at session start when recording has stopped. **The queue never keeps growing silently.**
 * One of: no database, sends keep failing, or records the database rejected.
 */
export function captureNotice(file: string = dbFile()): string | null {
  if (!fs.existsSync(file))
    return panel(
      "sphica: no database, so conversations are not recorded",
      [file],
      "Create it with sphica init",
    );
  const s = readState();
  if (s.stuck)
    return panel(
      "sphica: cannot send recordings",
      [`${s.pending} pending / failed: ${plain(s.stuck.slice(0, 120))}`],
      "Check with sphica doctor",
    );
  if (s.rejected > 0)
    return panel(
      `sphica: the database rejected ${plural(s.rejected, "record")}`,
      // Paths go in the box lines: a newline in HOME must not forge a line outside the box.
      [rejectedDir(), `Move them back to ${spoolDir()} to resend`],
      "Fix them first, then check with sphica doctor",
    );
  return null;
}

/**
 * Where the working tree stood when a turn began: one file per turn, never rewritten by another turn and never deleted to start one,
 * because hooks of different turns can run out of order. `seq` orders the turns; null when the turns before could not be read.
 * Status edits are given to a turn only when it is still the newest one after its end snapshot, and dropped when that cannot be told.
 * Gaps left open: a turn started by a notice can reuse an interrupted turn's id (nothing the hooks receive tells an interrupt apart),
 * edits made before the end snapshot runs, a starting point that could not be written, a hook that keeps running past its timeout,
 * and a session resumed after HOLD_DAYS while its old starting points are being pruned.
 */
type Start = {
  head: string | null;
  entries: Record<string, string> | null;
  running: boolean;
  turn: string;
  seq: number | null;
};

export const turnDir = (host: Host, session: string): string =>
  path.join(baselineDir(), digest(`${host}\0${session}`));
const startFile = (dir: string, turn: string): string => path.join(dir, `${digest(turn)}.json`);

const isStart = (v: unknown): v is Start => {
  const s = v as Start;
  return (
    !!s &&
    typeof s === "object" &&
    typeof s.turn === "string" &&
    typeof s.running === "boolean" &&
    (s.seq === null || Number.isSafeInteger(s.seq)) &&
    (s.entries === null || (typeof s.entries === "object" && !Array.isArray(s.entries))) &&
    (s.head === null || typeof s.head === "string")
  );
};

function readStart(file: string): Start | null {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    return isStart(s) ? s : null;
  } catch {
    return null;
  }
}

/** Every starting point of a session, or null when one of them cannot be read. Temporary files start with a dot. */
function readStarts(dir: string): Start[] | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
  const starts: Start[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const s = readStart(path.join(dir, name));
    if (!s) return null;
    starts.push(s);
  }
  return starts;
}

/** The turn with the highest number, or null when that cannot be told (an unreadable or unnumbered start, or a tie). */
function newestTurn(starts: Start[] | null): string | null {
  if (!starts?.length || starts.some((s) => s.seq === null)) return null;
  const top = Math.max(...starts.map((s) => s.seq as number));
  const at = starts.filter((s) => s.seq === top);
  return at.length === 1 ? (at[0]?.turn ?? null) : null;
}

function writeStart(dir: string, s: Start, file = startFile(dir, s.turn)): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Takes a turn's starting point and returns the step that saves it, or null when the turn is already running (a message typed while
 * it works). Split in two so tests can run another turn's hooks in between. A failed snapshot still saves the turn as the newest.
 */
export function openTurn(dir: string, turn: string, root: string): (() => void) | null {
  if (readStart(startFile(dir, turn))?.running) return null;
  const starts = readStarts(dir);
  const seq =
    starts && !starts.some((s) => s.seq === null)
      ? Math.max(0, ...starts.map((s) => s.seq as number)) + 1
      : null;
  const now = snapshot(root);
  return () =>
    writeStart(dir, { head: now?.head ?? null, entries: now?.entries ?? null, running: true, turn, seq });
}

/**
 * Takes a turn's end snapshot and returns the step that gives the paths changed since its start, or null when the turn has nothing to
 * compare against. The step reads the starts again after the snapshot: if a newer turn began before it, its edits may be in the snapshot.
 * A Stop leaves its end snapshot as the start of what follows: another Stop with no prompt in between is the same turn kept going by a
 * Stop hook, and a prompt that reuses the id takes a new snapshot first.
 */
export function closeTurn(dir: string, turn: string, root: string): (() => string[]) | null {
  const own = readStart(startFile(dir, turn));
  if (!own?.entries) return null;
  const before = { head: own.head, entries: own.entries };
  const now = snapshot(root);
  return () => {
    // A prompt that reused the id while this Stop ran saved a new start: leave it, and its turn, alone
    if (
      newestTurn(readStarts(dir)) !== turn ||
      JSON.stringify(readStart(startFile(dir, turn))) !== JSON.stringify(own)
    )
      return [];
    // A failed snapshot keeps the start, so a Stop that follows in the same turn still compares from it
    writeStart(dir, { ...own, ...(now ?? {}), running: false });
    return now ? changed(root, before, now) : [];
  };
}

/** Ends a turn without looking at the tree (Codex's interrupt is cut off after at most 3 seconds). Nothing follows it to compare. */
function stopTurn(dir: string, turn: string): void {
  const own = readStart(startFile(dir, turn));
  if (own?.entries || own?.running) writeStart(dir, { ...own, head: null, entries: null, running: false });
}

/**
 * Drops a session's starting points once every one of them is older than HOLD_DAYS, never some of them: removing one while a hook
 * of that session is between reading and writing could leave an older turn as the newest.
 */
function pruneBaselines(): void {
  const cutoff = Date.now() - HOLD_DAYS * 24 * 60 * 60 * 1000;
  const fresh = (file: string) =>
    (fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) >= cutoff;
  let names: string[];
  try {
    names = fs.readdirSync(baselineDir());
  } catch {
    return; // not there yet
  }
  for (const name of names) {
    const at = path.join(baselineDir(), name);
    // A single file per session is an older layout no turn reads; a session still on the older hooks may be using it
    if (!fs.statSync(at, { throwIfNoEntry: false })?.isDirectory()) {
      if (!fresh(at)) fs.rmSync(at, { force: true });
    } else {
      // An empty directory may be a session writing its first start
      const files = fs.readdirSync(at);
      if (files.length && !files.some((f) => fresh(path.join(at, f))))
        fs.rmSync(at, { recursive: true, force: true });
    }
  }
}

/** A starting point that cannot be read, written, or pruned costs only status edits, never the turn's messages, the send, or the notice. */
function attempt<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** One hook call. Whatever happens, work is never stopped (callers catch exceptions). */
export function onHook(host: Host, input: HookInput): { flush: boolean; notice?: string | null } {
  const event = input.hook_event_name;
  const owner = () =>
    isOwnerTurn(input, undefined, undefined, host === "codex" ? process.env.CODEX_THREAD_ID : undefined);
  if (event === "SessionStart") {
    if (!owner()) return { flush: false };
    // Pass this session's id on to children the agent starts from Bash.
    const file = process.env.CLAUDE_ENV_FILE;
    if (file && input.session_id && /^[A-Za-z0-9_-]+$/.test(input.session_id)) {
      fs.appendFileSync(file, `export SPHICA_PARENT_SESSION=${input.session_id}\n`);
    }
    // No starting point here: at startup this runs in the background and may finish after the first prompt's, and after a compaction
    // the running turn keeps its own.
    attempt(pruneBaselines);
    return { flush: false, notice: captureNotice() };
  }
  if (!owner()) return { flush: false };
  // Interrupt is cut off after at most 3 seconds. No new records are made, so only the queue is sent without checking git or the project.
  if (event === "Interrupt") {
    const turn = input.prompt_id ?? input.turn_id;
    if (turn) attempt(() => stopTurn(turnDir(host, String(input.session_id)), turn));
    return { flush: true };
  }
  const place = identify(input.cwd ?? process.cwd());
  if (!place) return { flush: false };
  const turn = input.prompt_id ?? input.turn_id;
  if (!turn) return { flush: false };
  const at = new Date().toISOString();
  const base = {
    v: 2 as const,
    host,
    session: String(input.session_id),
    // The key as the remote is written: a database whose keys are not normalized yet finds its project by it, a normalized one through normalizeKey
    project: place.legacyKey,
    branch: branchOf(place.root),
    turn,
    at,
  };
  const say = (key: string, speaker: "owner" | "assistant", raw: string, when = at) => {
    const kept = fit(clean(raw).trim());
    if (!kept.body.trim()) return;
    const id = `${key}:${digest(kept.body)}`;
    spool({ ...base, at: when, kind: "message", id, speaker, ...kept });
  };

  const dir = turnDir(host, base.session);
  if (event === "UserPromptSubmit" && input.prompt) {
    const prompt = input.prompt.trimStart();
    if (!INJECTED.some((r) => r.test(prompt))) say(`${turn}:owner`, "owner", prompt);
  }
  // Any prompt, a notice too, starts a turn unless its turn is already running. Between turns, the owner's own edits are not the turn's.
  // After the message is queued: this hook is synchronous, and a slow git status past its timeout must not cost the owner's words.
  if (event === "UserPromptSubmit") attempt(() => openTurn(dir, turn, place.root)?.());
  if (event === "Stop") {
    if (input.last_assistant_message) say(`${turn}:assistant`, "assistant", input.last_assistant_message);
    for (const p of attempt(() => closeTurn(dir, turn, place.root)?.()) ?? [])
      spool({ ...base, kind: "edit", event: null, path: p, via: "status" });
    return { flush: true };
  }
  if (event === "PostToolUse") {
    const tool = input.tool_name ?? "";
    const ti = input.tool_input ?? {};
    if (tool === "AskUserQuestion") {
      const said = answersOf(input);
      if (said) {
        const id = `${turn}:ask:${input.tool_use_id ?? at}`;
        // A millisecond before the answers, so the questions read first whatever order the spool files are sent in
        say(`${id}:q`, "assistant", said.questions, new Date(Date.parse(at) - 1).toISOString());
        say(id, "owner", said.answers);
      }
      return { flush: false };
    }
    // Read files are not recorded. They still arrive from hook settings written by older installs.
    if (tool === "Read") return { flush: false };
    const cwd = input.cwd ?? place.root;
    const files = (
      tool === "apply_patch"
        ? patchPaths(String(ti.command ?? ""))
        : [ti.file_path, ti.notebook_path].filter((p): p is string => typeof p === "string")
    ).flatMap((p) => relativeTo(place.root, p, cwd) ?? []);
    for (const p of files)
      spool({ ...base, kind: "edit", event: input.tool_use_id ?? null, path: p, via: "tool" });
  }
  return { flush: false };
}

type State = { flushedAt?: string; error?: string | null; deferred?: number };

function writeState(s: State): void {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(s));
  } catch {
    // Recording continues even if the state cannot be written
  }
}

/**
 * The queue and send state. `stuck` is the last failure when sending is failing, set only while a failure remains and records wait
 * (once the queue empties, the failure is in the past). The session start warning and doctor share this check.
 */
export function readState(): State & {
  pending: number;
  rejected: number;
  unregistered: number;
  stuck: string | null;
} {
  const count = (dir: string) => {
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith(".")).length;
    } catch {
      return 0; // not there yet
    }
  };
  const counts = {
    pending: count(spoolDir()),
    rejected: count(rejectedDir()),
    unregistered: count(unregisteredDir()),
  };
  // Read each field with a type check (so doctor and the SessionStart warning survive the file being edited from outside).
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    if (parsed && typeof parsed === "object") raw = parsed as Record<string, unknown>;
  } catch {
    // Not sent yet, or half-written and unreadable
  }
  // error is a string on send failure and null on success. An empty reason still counts as a failure.
  const error = typeof raw.error === "string" ? raw.error || "unknown failure" : null;
  return {
    flushedAt: typeof raw.flushedAt === "string" ? raw.flushedAt : undefined,
    error,
    deferred: typeof raw.deferred === "number" ? raw.deferred : undefined,
    ...counts,
    stuck: error && counts.pending > 0 ? error : null,
  };
}

/**
 * Never run two at once. The lock is created exclusively (`wx`) with the holder's pid inside. If it cannot be taken, it reads it and
 * breaks and retakes it once when the holder is gone or it is older than 5 minutes (a send killed when `-p` ends would leave the lock
 * and the next send would silently do nothing; this happened). A lock just created without a pid yet is treated as alive.
 */
function lock(): (() => void) | null {
  const file = path.join(spoolDir(), ".lock");
  fs.mkdirSync(spoolDir(), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
      // Remove only its own lock (if it was deemed stale and retaken by another send, that lock is not removed).
      return () => {
        try {
          if (fs.readFileSync(file, "utf8") === String(process.pid)) fs.rmSync(file, { force: true });
        } catch {
          // already gone
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (!st) continue;
    const holder = Number(fs.readFileSync(file, "utf8") || 0);
    const fresh = Date.now() - st.mtimeMs < 5 * 60_000;
    const alive = (() => {
      if (holder <= 0) return fresh; // half-written
      try {
        return process.kill(holder, 0);
      } catch {
        return false;
      }
    })();
    if (alive && fresh) return null;
    fs.rmSync(file, { force: true });
  }
  return null;
}

const BATCH = 500;
/** How long one send keeps going. Checked only between batches, so a batch can run past it (SQLite's busy wait, the one-by-one resend). */
const FLUSH_BUDGET_MS = 30_000; // the detached send; far under the 5-minute stale lock
export const TOOL_FLUSH_BUDGET_MS = 2_000; // sends an MCP tool waits for
// Keep the number of variables per statement well below SQLite's limit (32,766). Messages have 11 columns.
const ROWS = 1000;
const chunks = <T>(xs: T[], n = ROWS): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

/**
 * The project each spooled key names: the key itself, else the only project whose key normalizes as it does. Two such projects (a split
 * not migrated yet) leave the record held, since writing into either could keep the migration from merging them. Looked up inside the
 * write's transaction, so a migration that removes or renames a project cannot come between the lookup and the write.
 */
async function projectsOf(trx: Kysely<DB>, keys: string[]): Promise<Map<string, number>> {
  if (!keys.length) return new Map();
  const all = await trx.selectFrom("project").select(["id", "key"]).execute();
  const exact = new Map(all.map((p) => [p.key, p.id]));
  const normal = Map.groupBy(all, (p) => normalizeKey(p.key));
  const found = new Map<string, number>();
  for (const k of keys) {
    const same = normal.get(normalizeKey(k));
    const id = exact.get(k) ?? (same?.length === 1 ? same[0]?.id : undefined);
    if (id !== undefined) found.set(k, id);
  }
  return found;
}

export async function write(
  db: Kysely<DB>,
  batch: Spooled[],
): Promise<{ sent: number; strayed: Set<Spooled> }> {
  return inTransaction(db, async (trx) => {
    const projects = await projectsOf(
      trx,
      batch.map((r) => r.project),
    );
    const sessions = new Map<
      string,
      { project: number; host: Host; session: string; branch: string | null; at: string }
    >();
    for (const r of batch) {
      const p = projects.get(r.project);
      if (p === undefined) continue;
      const id = sessionId(p, r.host, r.session);
      const prev = sessions.get(id);
      if (!prev || Date.parse(r.at) < Date.parse(prev.at))
        sessions.set(id, { project: p, host: r.host, session: r.session, branch: r.branch, at: r.at });
    }
    for (const part of chunks([...sessions]))
      await trx
        .insertInto("capture_session")
        .values(
          part.map(([id, v]) => ({
            id,
            project_id: v.project,
            host: v.host,
            external_id: v.session,
            branch: v.branch,
            started_at: iso(v.at),
          })),
        )
        .execute();
    const messages = batch.flatMap((m) => {
      const p = m.kind === "message" ? projects.get(m.project) : undefined;
      if (m.kind !== "message" || p === undefined) return [];
      return [{ m, session: sessionId(p, m.host, m.session) }];
    });
    const present = async () => {
      let n = 0;
      for (const part of chunks(messages))
        for (const [session, ids] of Map.groupBy(part, (x) => x.session))
          n += (
            await trx
              .selectFrom("source")
              .select("id")
              .where("kind", "=", "session_message")
              .where("session_id", "=", session)
              .where(
                "external_id",
                "in",
                ids.map((x) => x.m.id),
              )
              .execute()
          ).length;
      return n;
    };
    const before = await present();
    const now = iso(Date.now());
    for (const part of chunks(messages))
      await trx
        .insertInto("capture_message")
        .values(
          part.map((x) => ({
            external_id: x.m.id,
            session_id: x.session,
            turn_id: x.m.turn,
            speaker: x.m.speaker,
            created_at: iso(x.m.at),
            captured_at: now,
            text: x.m.body,
            truncated: x.m.truncated ? 1 : 0,
            redacted: x.m.redacted ? 1 : 0,
            original_bytes: x.m.originalBytes,
            content_hash: sha256(x.m.body),
          })),
        )
        .execute();
    const after = await present();
    const edits = batch.flatMap((r) => {
      const p = r.kind === "edit" ? projects.get(r.project) : undefined;
      if (r.kind !== "edit" || p === undefined) return [];
      return [
        {
          session_id: sessionId(p, r.host, r.session),
          turn_id: r.turn,
          tool_event_id: r.event,
          path: r.path,
          via: r.via,
          observed_at: iso(r.at),
        },
      ];
    });
    for (const part of chunks(edits)) await trx.insertInto("capture_edit").values(part).execute();
    return { sent: after - before, strayed: new Set(batch.filter((r) => !projects.has(r.project))) };
  });
}

/**
 * Whether the record itself caused the failure. What SQLite rejected by constraint, type, or size (CONSTRAINT / MISMATCH / TOOBIG / RANGE)
 * fails the same way when resent. Lock, I/O, and file failures resend the whole batch.
 */
const REJECTED = new Set([18, 19, 20, 25]);
const rejected = (e: unknown): boolean => REJECTED.has(sqliteCode(e) ?? -1);

/** Queued records in `from`, oldest first (names start with the time they were stored). */
const queued = (from: string): { name: string; from: string }[] => {
  try {
    return fs
      .readdirSync(from)
      .filter((f) => f.endsWith(".json") && !f.startsWith("."))
      .sort()
      .map((name) => ({ name, from }));
  } catch {
    return []; // not there yet
  }
};

/**
 * Sends one batch. Records of unregistered projects are moved to unregistered/, records the database rejects to rejected/, the rest deleted.
 * **One invalid record never stops later records.** When the batch fails on a bad value it resends one by one.
 */
async function sendBatch(
  db: Kysely<DB>,
  names: { name: string; from: string }[],
): Promise<{ sent: number; rejected: number }> {
  const held = unregisteredDir();
  const records: { name: string; from: string; r: Spooled }[] = [];
  for (const { name, from } of names) {
    let r: Spooled | null;
    try {
      r = current(JSON.parse(fs.readFileSync(path.join(from, name), "utf8")));
    } catch {
      // Unreadable or of an unknown version: set it aside for the owner to see, never delete it
      fs.mkdirSync(rejectedDir(), { recursive: true, mode: 0o700 });
      fs.renameSync(path.join(from, name), path.join(rejectedDir(), name));
      continue;
    }
    if (r) records.push({ name, from, r });
    else fs.rmSync(path.join(from, name), { force: true }); // a v:1 read record: reads are not kept
  }
  let sent = 0;
  let strayed: typeof records = [];
  const bad: typeof records = [];
  try {
    const out = await write(
      db,
      records.map((x) => x.r),
    );
    sent = out.sent;
    strayed = records.filter((x) => out.strayed.has(x.r));
  } catch (e) {
    if (!rejected(e)) throw e;
    // One at a time, each looking its project up again: the failed batch's lookup was rolled back with it
    for (const x of records) {
      try {
        const out = await write(db, [x.r]);
        sent += out.sent;
        if (out.strayed.size) strayed.push(x);
      } catch (e2) {
        if (!rejected(e2)) throw e2;
        bad.push(x);
      }
    }
  }
  if (bad.length) {
    fs.mkdirSync(rejectedDir(), { recursive: true, mode: 0o700 });
    for (const x of bad) {
      try {
        fs.renameSync(path.join(x.from, x.name), path.join(rejectedDir(), x.name));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; // a concurrent send moved it first
      }
    }
  }
  if (strayed.length) {
    fs.mkdirSync(held, { recursive: true, mode: 0o700 });
    for (const x of strayed) {
      if (x.from === held) continue; // already set aside
      try {
        fs.renameSync(path.join(x.from, x.name), path.join(held, x.name));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; // a concurrent send moved it first
      }
    }
  }
  const moved = new Set([...bad, ...strayed].map((x) => x.name));
  for (const x of records) if (!moved.has(x.name)) fs.rmSync(path.join(x.from, x.name), { force: true });
  return { sent, rejected: bad.length };
}

/**
 * Sends the queue to the database. **The connection is capture, and this only adds rows.** Sending the same thing twice adds no rows.
 * Records of unregistered projects are held (only projects registered with `sphica init` are recorded); the first lock hold looks at
 * the held records present when it starts once, so they never take the place of queued records. The queue is then sent in batches
 * until it is empty or `budgetMs` is spent, at least one batch of it per call. A send that finds the lock taken waits for it within its budget,
 * and after unlocking a send looks at the queue again, so a holder that runs out of time does not leave records behind.
 * Failures such as a lost connection keep the batch queued for the next send.
 *
 * sent is the number of new messages (resent ones are not counted), deferred the held records left. busy means the lock never came free.
 */
export async function flush(
  file: string = dbFile(),
  budgetMs: number = FLUSH_BUDGET_MS,
): Promise<{ sent: number; deferred: number; rejected: number; busy?: boolean }> {
  const deadline = Date.now() + budgetMs;
  const dir = spoolDir();
  const held = unregisteredDir();
  const total = { sent: 0, deferred: 0, rejected: 0 };
  let batches = 0;
  let queueBatches = 0;
  for (let first = true; ; first = false) {
    let unlock = lock();
    while (!unlock && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
      if (Date.now() < deadline) unlock = lock();
    }
    if (!unlock) return first ? { ...total, busy: true } : total;
    let client: Kysely<DB> | null = null;
    const send = async (names: { name: string; from: string }[]) => {
      // Checks the generation only (db-write.ts): a revision change within a generation never stops recording.
      client ??= openWriter("capture", file);
      const r = await sendBatch(client, names);
      total.sent += r.sent;
      total.rejected += r.rejected;
      batches++;
    };
    const late = () => batches > 0 && Date.now() >= deadline;
    const sentBefore = batches;
    try {
      if (first) {
        // Expired held records are dropped before they could be sent. Records held during this send are not in the list.
        prune(held);
        for (const part of chunks(queued(held), BATCH)) {
          if (late()) break;
          await send(part);
        }
      }
      while (queueBatches === 0 || !late()) {
        const part = queued(dir).slice(0, BATCH);
        if (part.length === 0) break;
        await send(part);
        queueBatches++;
      }
      prune(held);
      total.deferred = queued(held).length;
      // Written before unlocking, so it never overwrites the state of a send that ran after this one. With nothing sent, the last send time stays.
      if (batches > sentBefore)
        writeState({ flushedAt: new Date().toISOString(), error: null, deferred: total.deferred });
    } catch (e) {
      writeState({ flushedAt: new Date().toISOString(), error: reason(e).slice(0, 300) });
      throw e;
    } finally {
      await (client as Kysely<DB> | null)?.destroy().catch(() => {});
      unlock();
    }
    if (Date.now() >= deadline || queued(dir).length === 0) return total;
  }
}

/** Reads hook input. Converting chunk by chunk garbles multibyte characters split at the boundary, so it is read as text. */
export async function readInput(stream: NodeJS.ReadableStream): Promise<HookInput> {
  stream.setEncoding("utf8");
  let raw = "";
  for await (const chunk of stream) raw += chunk;
  return JSON.parse(raw || "{}") as HookInput;
}

async function main(): Promise<void> {
  if (process.argv[2] === "--flush") {
    await flush();
    return;
  }
  const input = await readInput(process.stdin);
  const host: Host = process.argv[2] === "codex" ? "codex" : "claude-code";
  // Stop needs JSON on success. Return it first so a failed recording never breaks the hook contract.
  if (host === "codex" && input.hook_event_name === "Stop") process.stdout.write("{}");
  const { flush: send, notice } = onHook(host, input);
  // systemMessage is a warning you see; it does not enter the model's context.
  if (notice) process.stdout.write(JSON.stringify({ systemMessage: notice }));
  // Sending happens in a process detached from the session. As the hook's own process, the host would kill it at session end
  // (officially so with `-p`), and the last turn would not arrive until the next send. On Windows a detached child opens its own
  // console window unless hidden.
  if (send)
    spawn(process.execPath, [process.argv[1] ?? "", "--flush"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
}

// Runs only when started as a hook (tests and the CLI use only the functions).
if (process.argv[1] && /capture\.(ts|js)$/.test(process.argv[1])) {
  main().catch(() => {
    // Even if recording fails, work does not stop. Unsent records stay in the queue.
  });
}
