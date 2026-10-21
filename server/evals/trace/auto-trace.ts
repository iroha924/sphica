// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The automatic trace evaluation. Whether the agent traced on its own is only in the host's logs (the auto argument is not stored), so the
// population is read from Claude Code transcripts and Codex rollouts, joined to the database by the run id, and pinned with a consistent
// copy of the database and of every log read, so the result can be computed again after the live data has changed.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import type { ReadonlyKysely } from "kysely/readonly";
import type { DB } from "../../src/db-types.ts";
import { openReader } from "../../src/db.ts";
import { head } from "../../src/text.ts";
import { shuffled } from "../post-write/replay.ts";

type Host = "claude-code" | "codex";
export type Window = { from: string; to: string };

/** A tool call as the log holds it. server is set for Sphica's record and read servers, whose tool is then the bare name */
type Call = {
  id: string;
  tool: string;
  server: "record" | "read" | null;
  input: Record<string, unknown>;
  line: number;
  at: string | null;
  /** The working directory the call names, else the one its line or turn ran in */
  cwd: string | null;
  /** The response that issued it, an index into Log.responses; null when the log holds no response before it */
  response: number | null;
  result: { line: number; ok: boolean; text: string } | null;
};

type Usage = { model: string; input: number; cacheCreation: number; cacheRead: number; output: number };

/**
 * One model response: Claude Code writes one over several lines that share message.id, Codex ends one with a token_usage_record. usage is
 * null with gap saying why when the log does not give this response's tokens exactly once; a gap is never counted as 0.
 */
type Response = {
  key: string | null;
  line: number;
  at: string | null;
  /** When its last line was written: a Claude Code response's lines can be minutes apart */
  until: string | null;
  turn: string | null;
  usage: Usage | null;
  gap: string | null;
};

export type Log = {
  host: Host;
  /** Relative to the host's log directory */
  file: string;
  session: string;
  sha256: string;
  responses: Response[];
  calls: Call[];
  unreadable: number[];
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const RECORD_TOOLS = new Set([
  "trace_pending",
  "trace_begin",
  "record_context",
  "record_check",
  "record_save",
  "record_more",
]);

function claudeTool(name: string): Pick<Call, "tool" | "server"> {
  const m = /^mcp__plugin_sphica_(record|sphica)__(\w+)$/.exec(name);
  if (!m?.[1] || !m[2]) return { tool: name, server: null };
  return { tool: m[2], server: m[1] === "record" ? "record" : "read" };
}

function codexTool(server: unknown, tool: unknown): Pick<Call, "tool" | "server"> {
  const name = String(tool ?? "");
  if (server === "record" && RECORD_TOOLS.has(name)) return { tool: name, server: "record" };
  if (server === "sphica") return { tool: name, server: "read" };
  return { tool: `${String(server ?? "")}/${name}`, server: null };
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => isObject(c) && c.type === "text" && typeof c.text === "string")
    .map((c) => (c as { text: string }).text)
    .join("\n");
}

function lines(raw: Buffer, unreadable: number[]): [number, Record<string, unknown>][] {
  const out: [number, Record<string, unknown>][] = [];
  raw
    .toString("utf8")
    .split("\n")
    .forEach((text, i) => {
      if (!text.trim()) return;
      try {
        const d: unknown = JSON.parse(text);
        if (isObject(d)) out.push([i + 1, d]);
        else unreadable.push(i + 1);
      } catch {
        unreadable.push(i + 1);
      }
    });
  return out;
}

const sha256 = (b: Buffer | string): string => crypto.createHash("sha256").update(b).digest("hex");

const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

/** A Claude Code transcript: responses by message.id (else requestId), tool_use calls in them, and tool_result lines as their results */
export function readClaude(dir: string, file: string): Log {
  const raw = fs.readFileSync(path.join(dir, file));
  const log: Log = {
    host: "claude-code",
    file,
    session: "",
    sha256: sha256(raw),
    responses: [],
    calls: [],
    unreadable: [],
  };
  const byKey = new Map<string, number>();
  const byCall = new Map<string, Call>();
  const messages: number[] = [];
  const prompts: number[] = [];
  const unmarked: number[] = [];
  for (const [n, d] of lines(raw, log.unreadable)) {
    if (typeof d.sessionId === "string" && !log.session) log.session = d.sessionId;
    const at = typeof d.timestamp === "string" ? d.timestamp : null;
    const cwd = typeof d.cwd === "string" ? d.cwd : null;
    const message = isObject(d.message) ? d.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    if (d.type === "assistant") {
      const key =
        typeof message.id === "string" ? message.id : typeof d.requestId === "string" ? d.requestId : null;
      let r = key === null ? undefined : byKey.get(key);
      if (r === undefined) {
        r = log.responses.push({ key, line: n, at, until: at, turn: null, usage: null, gap: null }) - 1;
        if (key !== null) byKey.set(key, r);
      }
      if (at) (log.responses[r] as Response).until = at;
      // Every line of a response repeats its usage, and the last line holds the final counts
      const response = log.responses[r] as Response;
      const u = isObject(message.usage) ? message.usage : null;
      const counts =
        u &&
        [
          u.input_tokens,
          u.cache_creation_input_tokens ?? 0,
          u.cache_read_input_tokens ?? 0,
          u.output_tokens,
        ].map(count);
      // A last line without counts leaves the earlier ones stale, so the response becomes a gap
      if (key === null || !counts || counts.some((c) => c === null)) {
        response.usage = null;
        response.gap = key === null ? "no message.id or requestId" : "no usage";
      } else {
        const [input, cacheCreation, cacheRead, output] = counts as number[];
        response.usage = {
          model: String(message.model ?? ""),
          input: input as number,
          cacheCreation: cacheCreation as number,
          cacheRead: cacheRead as number,
          output: output as number,
        };
        response.gap = null;
      }
      for (const c of content)
        if (isObject(c) && c.type === "tool_use" && typeof c.id === "string") {
          const input = isObject(c.input) ? c.input : {};
          const call: Call = {
            id: c.id,
            ...claudeTool(String(c.name ?? "")),
            input,
            line: n,
            at,
            cwd: typeof input.cwd === "string" ? input.cwd : cwd,
            response: r,
            result: null,
          };
          log.calls.push(call);
          byCall.set(c.id, call);
        }
      continue;
    }
    if (d.type !== "user") continue;
    messages.push(n);
    const results = content.filter((c) => isObject(c) && c.type === "tool_result");
    for (const c of results)
      if (isObject(c) && typeof c.tool_use_id === "string") {
        const call = byCall.get(c.tool_use_id);
        if (call) call.result = { line: n, ok: c.is_error !== true, text: resultText(c.content) };
      }
    if (results.length || d.isMeta === true || d.isCompactSummary === true) continue;
    const origin = isObject(d.origin) ? d.origin.kind : undefined;
    if (origin === "human") prompts.push(n);
    else if (origin === undefined) unmarked.push(n);
  }
  // A user line of no known origin starts a turn only when the model answers it next, as the delivery evaluation reads transcripts
  const answered = (n: number) => {
    const next = Math.min(...[...messages, ...log.responses.map((r) => r.line)].filter((m) => m > n));
    return log.responses.some((r) => r.line === next);
  };
  const starts = [...prompts, ...unmarked.filter(answered)].sort((a, b) => a - b);
  for (const r of log.responses) r.turn = String(starts.filter((s) => s < r.line).length);
  return log;
}

const CODEX_COUNTERS = ["input_tokens", "cached_input_tokens", "output_tokens"] as const;

/**
 * A Codex response's usage, checked against the turn's running total: the total before it plus this response must give the total after
 * it, counter by counter, so a record missing in between shows as a gap. before is null at a turn's first response.
 */
function codexUsage(
  p: Record<string, unknown>,
  model: string,
  before: Record<string, unknown> | null,
): Pick<Response, "usage" | "gap"> {
  const u = isObject(p.usage) ? p.usage : null;
  const after = isObject(p.turn_token_usage) ? p.turn_token_usage : null;
  if (!u || !after) return { usage: null, gap: "no usage or turn total" };
  for (const k of CODEX_COUNTERS) {
    const [mine, prev, total] = [count(u[k]), before ? count(before[k]) : 0, count(after[k])];
    if (mine === null || prev === null || total === null) return { usage: null, gap: `no ${k}` };
    if (prev + mine !== total)
      return { usage: null, gap: `${k}: ${prev} + ${mine} is not the turn total ${total}` };
  }
  // Codex's input_tokens holds the cached part, which Claude Code counts apart
  const [input, cached] = [count(u.input_tokens) as number, count(u.cached_input_tokens) as number];
  if (cached > input)
    return { usage: null, gap: `cached_input_tokens ${cached} is above input_tokens ${input}` };
  return {
    usage: {
      model,
      input: input - cached,
      cacheCreation: 0,
      cacheRead: cached,
      output: count(u.output_tokens) as number,
    },
    gap: null,
  };
}

/**
 * A Codex rollout: a token_usage_record ends each response, and the McpToolCall items completed after it are the calls that response made.
 * Codex logs record tools only as McpToolCall items (a call made from code mode is also text inside an exec call, which is not read).
 */
export function readCodex(dir: string, file: string): Log {
  const raw = fs.readFileSync(path.join(dir, file));
  const log: Log = {
    host: "codex",
    file,
    session: "",
    sha256: sha256(raw),
    responses: [],
    calls: [],
    unreadable: [],
  };
  let model = "";
  let cwd: string | null = null;
  let lastTurn: string | null = null;
  let turnTotal: Record<string, unknown> | null = null;
  for (const [n, d] of lines(raw, log.unreadable)) {
    const p = isObject(d.payload) ? d.payload : {};
    const at = typeof d.timestamp === "string" ? d.timestamp : null;
    if (d.type === "session_meta" && typeof p.id === "string" && !log.session) log.session = p.id;
    if (d.type === "turn_context" && typeof p.model === "string") model = p.model;
    if (d.type === "turn_context" && typeof p.cwd === "string") cwd = p.cwd;
    if (d.type === "token_usage_record") {
      const key = typeof p.response_id === "string" ? p.response_id : null;
      const turn = typeof p.turn_id === "string" ? p.turn_id : null;
      if (key !== null && log.responses.at(-1)?.key === key) continue;
      log.responses.push({
        key,
        line: n,
        at,
        until: at,
        turn,
        ...codexUsage(p, model, turn === lastTurn ? turnTotal : null),
      });
      turnTotal = isObject(p.turn_token_usage) ? p.turn_token_usage : null;
      lastTurn = turn;
      continue;
    }
    const item = isObject(p.item) ? p.item : null;
    if (d.type !== "event_msg" || p.type !== "item_completed" || item?.type !== "McpToolCall") continue;
    const result = isObject(item.result) ? item.result : {};
    const input = isObject(item.arguments) ? item.arguments : {};
    log.calls.push({
      id: String(item.id ?? `line-${n}`),
      ...codexTool(item.server, item.tool),
      input,
      line: n,
      at,
      cwd: typeof input.cwd === "string" ? input.cwd : cwd,
      response: log.responses.length ? log.responses.length - 1 : null,
      result: {
        line: n,
        ok: item.status === "completed" && result.isError !== true,
        text: resultText(result.content),
      },
    });
  }
  return log;
}

function jsonl(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
}

/** Every log under the two directories that made a record tool call with auto: true; the others hold nothing this evaluation reads */
export function readLogs(dirs: { claude: string; codex: string }): Log[] {
  const auto = (l: Log) => l.calls.some((c) => c.server === "record" && c.input.auto === true);
  return [
    ...jsonl(dirs.claude).map((f) => readClaude(dirs.claude, f)),
    ...jsonl(dirs.codex).map((f) => readCodex(dirs.codex, f)),
  ].filter(auto);
}

type Run = {
  id: number;
  draft: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  target: { host: string | null; session: string | null };
  callers: { host: Host; file: string }[];
  units: number[];
};

type Unmatched = { draft: string; host: Host; file: string; line: number; error: string | null };

/** Where an automatic trace began: a trace_pending call with auto: true */
type SpanStart = { host: Host; file: string; line: number; call: string; at: string | null };

export type Population = {
  project: string;
  root: string;
  window: Window;
  condition: string;
  runs: Run[];
  unmatched: Unmatched[];
  spans: SpanStart[];
  units: number;
  sha256: string;
};

const CONDITION =
  "trace runs of the project whose run id a record_context call with auto: true made from the root or below names in a log, started from <= started_at < to, ordered by started_at and id; spans start at each such trace_pending call with auto: true made in the window";

const inWindow = (at: string | null, w: Window) => at !== null && at >= w.from && at < w.to;

const populationDigest = (p: Pick<Population, "runs" | "unmatched" | "spans">): string =>
  sha256(JSON.stringify({ runs: p.runs, unmatched: p.unmatched, spans: p.spans }));

/** root is the repository's directory: Codex keeps every project's sessions together, so a call counts only when made from there */
export async function extract(
  db: ReadonlyKysely<DB>,
  project: string,
  w: Window,
  logs: Log[],
  root: string,
): Promise<Population> {
  const here = (c: Call) => c.cwd !== null && (c.cwd === root || c.cwd.startsWith(`${root}${path.sep}`));
  const p = await db.selectFrom("project").select("id").where("key", "=", project).executeTakeFirst();
  if (!p) throw new Error(`no project with the key ${project}`);
  const named = new Map<
    string,
    { host: Host; file: string; line: number; at: string | null; error: string | null }[]
  >();
  const spans: SpanStart[] = [];
  for (const log of logs)
    for (const c of log.calls) {
      if (c.server !== "record" || c.input.auto !== true || !here(c)) continue;
      if (c.tool === "trace_pending" && inWindow(c.at, w))
        spans.push({ host: log.host, file: log.file, line: c.line, call: c.id, at: c.at });
      if (c.tool !== "record_context" || typeof c.input.run !== "string") continue;
      const seen = named.get(c.input.run) ?? [];
      seen.push({
        host: log.host,
        file: log.file,
        line: c.line,
        at: c.at,
        error: c.result?.ok === false ? c.result.text : null,
      });
      named.set(c.input.run, seen);
    }
  const drafts = [...named.keys()];
  const rows = drafts.length
    ? await db
        .selectFrom("extraction_run as r")
        .leftJoin("session as s", "s.id", "r.session_id")
        .where("r.project_id", "=", p.id)
        .where("r.origin", "=", "trace")
        .where("r.draft_id", "in", drafts)
        .select([
          "r.id",
          "r.draft_id",
          "r.started_at",
          "r.finished_at",
          "r.status",
          "s.host",
          "s.external_id",
        ])
        .orderBy("r.started_at")
        .orderBy("r.id")
        .execute()
    : [];
  const kept = rows.filter((r) => r.started_at >= w.from && r.started_at < w.to);
  const units = kept.length
    ? await db
        .selectFrom("unit")
        .where(
          "run_id",
          "in",
          kept.map((r) => r.id),
        )
        .select(["id", "run_id"])
        .orderBy("created_at")
        .orderBy("id")
        .execute()
    : [];
  const runs: Run[] = kept.map((r) => ({
    id: r.id,
    draft: r.draft_id as string,
    started_at: r.started_at,
    finished_at: r.finished_at,
    status: r.status,
    target: { host: r.host, session: r.external_id },
    callers: [
      ...new Map(
        (named.get(r.draft_id as string) ?? []).map((c) => [
          `${c.host}\t${c.file}`,
          { host: c.host, file: c.file },
        ]),
      ).values(),
    ],
    units: units.filter((u) => u.run_id === r.id).map((u) => u.id),
  }));
  const found = new Set(rows.map((r) => r.draft_id));
  const unmatched = drafts
    .filter((d) => !found.has(d))
    .flatMap((draft) =>
      (named.get(draft) ?? [])
        .filter((c) => inWindow(c.at, w))
        .map((c) => ({ draft, host: c.host, file: c.file, line: c.line, error: c.error })),
    );
  unmatched.sort((a, b) => a.host.localeCompare(b.host) || a.file.localeCompare(b.file) || a.line - b.line);
  spans.sort((a, b) => a.host.localeCompare(b.host) || a.file.localeCompare(b.file) || a.line - b.line);
  const out = { runs, unmatched, spans };
  return {
    project,
    root,
    window: w,
    condition: CONDITION,
    ...out,
    units: runs.reduce((n, r) => n + r.units.length, 0),
    sha256: populationDigest(out),
  };
}

/** What differs between the pinned population and one extracted again: empty when they match */
export function differences(pinned: Population, fresh: Population): string[] {
  const out: string[] = [];
  if (populationDigest(pinned) !== pinned.sha256)
    out.push(`the pinned population does not hash to its sha256 ${pinned.sha256}`);
  const byId = new Map(fresh.runs.map((r) => [r.id, r]));
  const gone = pinned.runs.filter((r) => !byId.has(r.id));
  const added = fresh.runs.filter((r) => !pinned.runs.some((p) => p.id === r.id));
  const changed = pinned.runs.filter((r) => {
    const f = byId.get(r.id);
    return f && JSON.stringify(f) !== JSON.stringify(r);
  });
  if (gone.length) out.push(`${gone.length} pinned runs are no longer there, first ${gone[0]?.id}`);
  if (added.length) out.push(`${added.length} runs are there but not pinned, first ${added[0]?.id}`);
  if (changed.length) out.push(`${changed.length} runs changed, first ${changed[0]?.id}`);
  if (JSON.stringify(pinned.unmatched) !== JSON.stringify(fresh.unmatched))
    out.push(`unmatched run ids differ: ${pinned.unmatched.length} pinned, ${fresh.unmatched.length} now`);
  if (JSON.stringify(pinned.spans) !== JSON.stringify(fresh.spans))
    out.push(`automatic trace spans differ: ${pinned.spans.length} pinned, ${fresh.spans.length} now`);
  return out;
}

type Inputs = {
  commit: string;
  snapshot: { file: string; sha256: string };
  /** unreadable: the lines of each log that could not be read, so a result missing them is not taken as complete */
  logs: {
    count: number;
    sha256: string;
    files: { host: Host; file: string; sha256: string; unreadable: number[] }[];
  };
};

/** The real path of p, or of its nearest existing parent with the rest appended, so a link cannot hide where p is */
function realPath(p: string): string {
  const abs = path.resolve(p);
  if (fs.existsSync(abs)) return fs.realpathSync(abs);
  const parent = path.dirname(abs);
  return parent === abs ? abs : path.join(realPath(parent), path.basename(abs));
}

const logDir = (frozen: string, host: Host) => path.join(frozen, "logs", host);

/**
 * Copies what a result is computed from into frozen, outside the repository: a clean server/ at a commit, a consistent copy of the
 * database taken with SQLite's backup, and every log read. Refuses a project that ever forgot sources, since that deleted what the
 * records quoted.
 */
async function freeze(o: {
  repo: string;
  db: string;
  project: string;
  frozen: string;
  logs: Log[];
  dirs: { claude: string; codex: string };
}): Promise<Inputs> {
  const dirty = execFileSync("git", ["-C", o.repo, "status", "--porcelain", "--", "server"], {
    encoding: "utf8",
  });
  if (dirty.trim())
    throw new Error(`server/ has uncommitted changes; commit before a run that saves a result:\n${dirty}`);
  const commit = execFileSync("git", ["-C", o.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  // The copies hold the owner's whole database and conversations, which must never be committed
  const top = execFileSync("git", ["-C", o.repo, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const [repo, frozen] = [realPath(top), realPath(o.frozen)];
  if (frozen === repo || frozen.startsWith(`${repo}${path.sep}`))
    throw new Error(`--frozen ${o.frozen} is inside the repository; freeze outside it`);
  if (fs.existsSync(o.frozen) && fs.readdirSync(o.frozen).length)
    throw new Error(`${o.frozen} is not empty; freeze into a new directory`);
  fs.mkdirSync(o.frozen, { recursive: true });
  const snapshot = path.join(o.frozen, "sphica.db");
  const source = new DatabaseSync(o.db, { readOnly: true });
  try {
    const forgot = source
      .prepare(
        "select count(*) as n from forget_batch where project_id = (select id from project where key = ?)",
      )
      .get(o.project);
    if (Number(forgot?.n) !== 0)
      throw new Error("the project forgot sources; what its records quoted is gone");
    await backup(source, snapshot);
  } finally {
    source.close();
  }
  for (const l of o.logs) {
    const to = path.join(logDir(o.frozen, l.host), l.file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(l.host === "claude-code" ? o.dirs.claude : o.dirs.codex, l.file), to);
    if (sha256(fs.readFileSync(to)) !== l.sha256) throw new Error(`${l.file} changed while it was read`);
  }
  const files = o.logs.map((l) => ({
    host: l.host,
    file: l.file,
    sha256: l.sha256,
    unreadable: l.unreadable,
  }));
  return {
    commit,
    snapshot: { file: "sphica.db", sha256: sha256(fs.readFileSync(snapshot)) },
    logs: {
      count: files.length,
      sha256: sha256(files.map((f) => `${f.host}\t${f.file}\t${f.sha256}\n`).join("")),
      files,
    },
  };
}

/** The frozen database and logs, after checking they still hash to what the baseline pinned */
function thaw(frozen: string, inputs: Inputs): { db: string; logs: Log[] } {
  const db = path.join(frozen, inputs.snapshot.file);
  if (sha256(fs.readFileSync(db)) !== inputs.snapshot.sha256)
    throw new Error(`${db} does not hash to the pinned sha256`);
  const logs = inputs.logs.files.map((f) => {
    const dir = logDir(frozen, f.host);
    const l = f.host === "claude-code" ? readClaude(dir, f.file) : readCodex(dir, f.file);
    if (l.sha256 !== f.sha256) throw new Error(`${f.file} does not hash to the pinned sha256`);
    if (JSON.stringify(l.unreadable) !== JSON.stringify(f.unreadable))
      throw new Error(`${f.file} does not have the unreadable lines the baseline pins`);
    return l;
  });
  return { db, logs };
}

const RUN_ID = /^run: (\S+)/m;

/** The run a record-server call works on: its run argument, or for trace_begin the run its result returned */
function callRun(c: Call): string | null {
  if (c.tool === "trace_begin") return c.result?.ok ? (RUN_ID.exec(c.result.text)?.[1] ?? null) : null;
  return typeof c.input.run === "string" ? c.input.run : null;
}

/** A response the owner's labelling confirmed served the owner's request, with the reason written down */
export type OwnerWork = { host: Host; file: string; line: number; reason: string };

export type Attributed = {
  host: Host;
  file: string;
  key: string | null;
  line: number;
  span: number;
  runs: number[];
  selection: boolean;
  unattributed: boolean;
  owner_work: string | null;
  usage: Usage | null;
  gap: string | null;
  lower: boolean;
  upper: boolean;
};

export type SpanResult = {
  host: Host;
  file: string;
  start: number;
  end: number;
  from: string | null;
  to: string | null;
  truncated: boolean;
  runs: number[];
  /** From the span's start to the first response that began a run, or to its end when none did */
  selection_seconds: number | null;
};

const seconds = (from: string | null, to: string | null): number | null =>
  from && to ? (Date.parse(to) - Date.parse(from)) / 1000 : null;

/**
 * Every response of every automatic trace span, with what it worked on. A span runs from the response that called trace_pending with
 * auto: true to the response that reads the last record-server result of that sequence in the same turn (or the turn's last response).
 * A response with no record-server call or result belongs to the one run open then (begun, not yet saved), and is unattributed when zero
 * or several are open. owner_work comes only from labelling, never from the kind of tool a response used.
 */
export function attribute(
  population: Population,
  logs: Log[],
  ownerWork: OwnerWork[] = [],
): { responses: Attributed[]; spans: SpanResult[] } {
  const byDraft = new Map(population.runs.map((r) => [r.draft, r]));
  const responses: Attributed[] = [];
  const spans: SpanResult[] = [];
  const isAutoPending = (c: Call) =>
    c.server === "record" && c.tool === "trace_pending" && c.input.auto === true;
  for (const start of population.spans) {
    const log = logs.find((l) => l.host === start.host && l.file === start.file);
    const call = log?.calls.find((c) => c.id === start.call && c.line === start.line);
    if (!log || !call || call.response === null)
      throw new Error(
        `the span at ${start.host} ${start.file}:${start.line} has no response in the frozen logs`,
      );
    const rs = call.response;
    const turn = log.responses[rs]?.turn ?? null;
    const record = (r: number) => log.calls.filter((c) => c.response === r && c.server === "record");
    let stop = rs + 1;
    while (
      stop < log.responses.length &&
      log.responses[stop]?.turn === turn &&
      !record(stop).some(isAutoPending)
    )
      stop++;
    let last = rs;
    for (let r = rs; r < stop; r++) if (record(r).length) last = r;
    const closed = last + 1 < stop;
    const whole = closed ? last + 1 : stop - 1;
    // Responses from the window's end on are not counted: the span is cut there
    let end = whole;
    while (end > rs && (log.responses[end]?.at ?? "") >= population.window.to) end--;
    const until = log.responses[end]?.until ?? null;
    // A last response that runs past the window's end is cut there too
    const past = until !== null && until >= population.window.to;
    const endAt = past ? population.window.to : until;
    const unanswered = record(last).some((c) => c.result === null);
    const truncated =
      end < whole || past || unanswered || !endAt || (!closed && stop === log.responses.length);
    const span = spans.length;
    const open = new Set<string>();
    const touchedRuns = new Set<number>();
    let begun: string | null = null;
    for (let r = rs; r <= end; r++) {
      const resp = log.responses[r] as Response;
      const issued = record(r);
      const touched = [...issued, ...(r > rs ? record(r - 1) : [])];
      const drafts = touched.map(callRun).filter((d): d is string => d !== null);
      const runs = new Set<number>();
      let unattributed = drafts.some((d) => !byDraft.has(d));
      for (const d of drafts) {
        const run = byDraft.get(d);
        if (run) runs.add(run.id);
      }
      if (!touched.length) {
        const only = open.size === 1 ? byDraft.get([...open][0] as string) : undefined;
        if (only) runs.add(only.id);
        else unattributed = true;
      }
      const selection = touched.some(
        (c) => c.tool === "trace_pending" || (c.tool === "trace_begin" && callRun(c) === null),
      );
      for (const c of issued) {
        const d = callRun(c);
        if (c.tool === "trace_begin" && d) {
          open.add(d);
          begun ??= resp.at;
        }
        if (c.tool === "record_save" && d && c.result?.ok && !c.result.text.startsWith("✗")) open.delete(d);
      }
      for (const id of runs) touchedRuns.add(id);
      const owner = ownerWork.find((o) => o.host === log.host && o.file === log.file && o.line === resp.line);
      responses.push({
        host: log.host,
        file: log.file,
        key: resp.key,
        line: resp.line,
        span,
        runs: [...runs].sort((a, b) => a - b),
        selection,
        unattributed,
        owner_work: owner?.reason ?? null,
        usage: resp.usage,
        gap: resp.gap,
        lower: false,
        upper: false,
      });
    }
    spans.push({
      host: log.host,
      file: log.file,
      start: log.responses[rs]?.line as number,
      end: log.responses[end]?.line as number,
      from: log.responses[rs]?.at ?? null,
      to: endAt,
      truncated,
      runs: [...touchedRuns].sort((a, b) => a - b),
      selection_seconds: seconds(log.responses[rs]?.at ?? null, begun ?? endAt),
    });
  }
  // A run is known empty only when it saved, saved no record, and no span that touched it was cut short
  const cut = new Set(spans.filter((s) => s.truncated).flatMap((s) => s.runs));
  const outcome = new Map(
    population.runs.map((r) => [
      r.id,
      r.status !== "saved" || cut.has(r.id) ? "unknown" : r.units.length ? "saved" : "empty",
    ]),
  );
  for (const a of responses) {
    const of = a.runs.map((id) => outcome.get(id) ?? "unknown");
    a.lower =
      of.length > 0 && of.every((o) => o === "empty") && !a.owner_work && !a.selection && !a.unattributed;
    a.upper = of.some((o) => o !== "saved") || a.selection || a.unattributed;
  }
  return { responses, spans };
}

const METRICS = {
  output: (u: Usage) => u.output,
  all: (u: Usage) => u.input + u.cacheCreation + u.cacheRead + u.output,
};

export type Share = {
  total: number;
  empty_low: number;
  empty_high: number;
  share_low: number | null;
  share_high: number | null;
  /** Responses whose tokens the log does not give, and how many of them fall in each bound */
  gaps: number;
  gaps_low: number;
  gaps_high: number;
};

/** The empty-run share of each token proxy, per host and never summed across hosts, with the models' totals */
export function shares(responses: Attributed[]) {
  const hosts = [...new Set(responses.map((r) => r.host))].sort();
  return Object.fromEntries(
    hosts.map((host) => {
      const mine = responses.filter((r) => r.host === host);
      const metric = (f: (u: Usage) => number): Share => {
        const sum = (rs: Attributed[]) => rs.reduce((n, r) => n + (r.usage ? f(r.usage) : 0), 0);
        const [total, low, high] = [
          sum(mine),
          sum(mine.filter((r) => r.lower)),
          sum(mine.filter((r) => r.upper)),
        ];
        const gaps = mine.filter((r) => !r.usage);
        return {
          total,
          empty_low: low,
          empty_high: high,
          share_low: total ? low / total : null,
          share_high: total ? high / total : null,
          gaps: gaps.length,
          gaps_low: gaps.filter((r) => r.lower).length,
          gaps_high: gaps.filter((r) => r.upper).length,
        };
      };
      const models: Record<string, { responses: number; output: number; all: number }> = {};
      for (const r of mine)
        if (r.usage) {
          const name = r.usage.model || "unknown";
          models[name] ??= { responses: 0, output: 0, all: 0 };
          const m = models[name];
          m.responses++;
          m.output += METRICS.output(r.usage);
          m.all += METRICS.all(r.usage);
        }
      return [
        host,
        { responses: mine.length, output: metric(METRICS.output), all: metric(METRICS.all), models },
      ];
    }),
  );
}

function spread(xs: number[]) {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  const median = !sorted.length
    ? null
    : sorted.length % 2
      ? (sorted[Math.floor(mid)] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return { n: sorted.length, total: sorted.reduce((a, b) => a + b, 0), median, max: sorted.at(-1) ?? null };
}

/** Run time from begin to save, span wall time with overlapping spans merged, and the time spent choosing a session */
export function times(population: Population, spans: SpanResult[]) {
  const runs = population.runs
    .map((r) => seconds(r.started_at, r.finished_at))
    .filter((s): s is number => s !== null);
  const intervals = spans
    .filter((s) => s.from && s.to)
    .map((s) => [Date.parse(s.from as string), Date.parse(s.to as string)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  let merged = 0;
  let edge = Number.NEGATIVE_INFINITY;
  for (const [from, to] of intervals) {
    merged += Math.max(0, to - Math.max(from, edge));
    edge = Math.max(edge, to);
  }
  return {
    run_seconds: spread(runs),
    span_seconds: spread(intervals.map(([a, b]) => (b - a) / 1000)),
    span_seconds_merged: merged / 1000,
    selection_seconds: spread(spans.map((s) => s.selection_seconds).filter((s): s is number => s !== null)),
  };
}

const USAGE_RULE =
  "a verdict on fixed token proxies, not on subscription usage: per host, output tokens and all processed tokens (input + cache creation + cache read + output; Codex's cached input counted once), each response once; low counts responses touching only runs known empty with no selection, owner work, or unattributed part; high counts responses touching an empty or unknown run, and every selection or unattributed response";

export type Drawn = { n: number; unit: number; key: string; kind: string; agent: boolean };
export type AuditRow = { n: number; adoption: number; unit: number; route: string; source: number };

/**
 * The records to label and the adoptions to audit. The sample is the first size records of the population, ordered by (created_at, id),
 * shuffled with the seed; records an AI adopted that it missed are an extra set outside the useful rate. Every adoption row the
 * automatic runs wrote is audited.
 */
export async function draw(
  db: ReadonlyKysely<DB>,
  population: Population,
  seed: number,
  size: number,
): Promise<{ sample: Drawn[]; extra: Drawn[]; audit: AuditRow[] }> {
  const ids = population.runs.flatMap((r) => r.units);
  const runIds = population.runs.map((r) => r.id);
  if (!ids.length) return { sample: [], extra: [], audit: [] };
  const units = await db
    .selectFrom("unit")
    .where("id", "in", ids)
    .select(["id", "key", "kind"])
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  const adoptions = await db
    .selectFrom("unit_adoption")
    .where("run_id", "in", runIds)
    .select(["id", "unit_id", "route", "source_id"])
    .orderBy("id")
    .execute();
  const agent = new Set(adoptions.filter((a) => a.route === "agent").map((a) => a.unit_id));
  const row = (u: (typeof units)[number], n: number): Drawn => ({
    n,
    unit: u.id,
    key: u.key,
    kind: u.kind,
    agent: agent.has(u.id),
  });
  const sample = shuffled(units, seed)
    .slice(0, size)
    .map((u, i) => row(u, i + 1));
  const drawn = new Set(sample.map((d) => d.unit));
  const extra = units.filter((u) => agent.has(u.id) && !drawn.has(u.id)).map((u, i) => row(u, size + i + 1));
  const audit = adoptions.map((a, i) => ({
    n: i + 1,
    adoption: a.id,
    unit: a.unit_id,
    route: a.route,
    source: a.source_id,
  }));
  return { sample, extra, audit };
}

const cut = (text: string, from: number, to: number) =>
  Buffer.from(text, "utf8").subarray(from, to).toString("utf8");

const quoteLine = (s: string) => s.replaceAll("\n", "\n    > ");

/** The first or last chars characters of a text, taken on whole characters so none is split */
const firstChars = (s: string, chars: number) => Array.from(s).slice(0, chars).join("");
const lastChars = (s: string, chars: number) => Array.from(s).slice(-chars).join("");

/** A long message cut to its head and its end, where a proposal's options usually are, saying how much is left out */
function headAndEnd(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  const start = head(text, bytes / 4);
  const rest = Array.from(text.slice(start.length));
  let n = rest.length;
  let used = 0;
  while (n > 0 && used + Buffer.byteLength(rest[n - 1] as string) <= (bytes * 3) / 4)
    used += Buffer.byteLength(rest[--n] as string);
  const left = Buffer.byteLength(text) - Buffer.byteLength(start) - used;
  return `${start}\n[${left} bytes left out]\n${rest.slice(n).join("")}`;
}

/** The labelling sheet: each drawn record with its evidence and adoptions in their words, then each adoption with what it answered */
export async function sheet(
  db: ReadonlyKysely<DB>,
  population: Population,
  drawn: { sample: Drawn[]; extra: Drawn[]; audit: AuditRow[] },
): Promise<string> {
  const runOf = new Map(population.runs.flatMap((r) => r.units.map((u) => [u, r])));
  const source = async (id: number) =>
    db
      .selectFrom("source")
      .where("id", "=", id)
      .select(["id", "author_kind", "text", "session_id", "created_at"])
      .executeTakeFirstOrThrow();
  const before = async (s: { id: number; session_id: string | null; created_at: string }) =>
    s.session_id === null
      ? undefined
      : db
          .selectFrom("source")
          .where("session_id", "=", s.session_id)
          .where((eb) =>
            eb.or([
              eb("created_at", "<", s.created_at),
              eb.and([eb("created_at", "=", s.created_at), eb("id", "<", s.id)]),
            ]),
          )
          .select(["id", "author_kind", "text"])
          .orderBy("created_at", "desc")
          .orderBy("id", "desc")
          .executeTakeFirst();
  const out: string[] = [
    "# Automatic trace labelling sheet",
    "",
    "Records: correctness correct / wrong / unknown, and value useful / not-needed / unknown (would a later session in this project need it, as of when it was saved). Adoptions: correct / misattributed / unknown, by speaker, quoted span, and the proposal it answers.",
    "",
  ];
  const record = async (d: Drawn, heading: string) => {
    const u = await db
      .selectFrom("unit")
      .where("id", "=", d.unit)
      .select(["key", "kind", "stance", "text", "why", "lifecycle"])
      .executeTakeFirstOrThrow();
    const run = runOf.get(d.unit);
    out.push(
      `## ${heading}${d.n} u${d.unit} ${u.key}`,
      "",
      `- ${u.kind}${u.stance ? ` ${u.stance}` : ""}, now ${u.lifecycle}${d.agent ? ", adopted by an AI" : ""}; run ${run?.id} on ${run?.target.host} ${run?.target.session}`,
      `- text: ${u.text}`,
    );
    if (u.why) out.push(`- why: ${u.why}`);
    const options = await db
      .selectFrom("unit_option")
      .where("unit_id", "=", d.unit)
      .select(["position", "outcome", "text", "why"])
      .orderBy("position")
      .execute();
    for (const o of options)
      out.push(`- option ${o.position} ${o.outcome}: ${o.text}${o.why ? ` (${o.why})` : ""}`);
    const evidence = await db
      .selectFrom("unit_evidence")
      .where("unit_id", "=", d.unit)
      .select(["source_id", "span_start", "span_end", "role"])
      .orderBy("id")
      .execute();
    for (const e of evidence) {
      const s = await source(e.source_id);
      out.push(
        `- evidence ${e.role} s${s.id} (${s.author_kind}):`,
        `    > ${quoteLine(cut(s.text, e.span_start, e.span_end))}`,
      );
    }
    const adoptions = await db
      .selectFrom("unit_adoption")
      .where("unit_id", "=", d.unit)
      .select(["route", "source_id", "span_start", "span_end", "retracted_at"])
      .orderBy("id")
      .execute();
    for (const a of adoptions) {
      const s = await source(a.source_id);
      out.push(
        `- adoption ${a.route}${a.retracted_at ? " (retracted)" : ""} s${s.id} (${s.author_kind}):`,
        `    > ${quoteLine(cut(s.text, a.span_start, a.span_end))}`,
      );
    }
    out.push("");
  };
  for (const d of drawn.sample) await record(d, "S");
  if (drawn.extra.length) out.push("# AI decisions outside the sample", "");
  for (const d of drawn.extra) await record(d, "X");
  out.push("# Adoptions to audit", "");
  for (const a of drawn.audit) {
    const row = await db
      .selectFrom("unit_adoption as a")
      .innerJoin("unit as u", "u.id", "a.unit_id")
      .where("a.id", "=", a.adoption)
      .select(["u.key", "u.text", "a.span_start", "a.span_end"])
      .executeTakeFirstOrThrow();
    const s = await source(a.source);
    const prev = await before(s);
    out.push(
      `## A${a.n} adoption ${a.adoption} (${a.route}) of u${a.unit} ${row.key}`,
      "",
      `- record: ${row.text}`,
      `- quoted span in s${s.id} (${s.author_kind}):`,
      `    > ${quoteLine(cut(s.text, row.span_start, row.span_end))}`,
      `- around it:`,
      `    > ${quoteLine(`${lastChars(cut(s.text, 0, row.span_start), 200)}[[${cut(s.text, row.span_start, row.span_end)}]]${firstChars(cut(s.text, row.span_end, Buffer.byteLength(s.text)), 200)}`)}`,
    );
    if (prev)
      out.push(
        `- message before it, s${prev.id} (${prev.author_kind}):`,
        `    > ${quoteLine(headAndEnd(prev.text, 6000))}`,
      );
    out.push("");
  }
  return out.join("\n");
}

/** Fixed with the owner before labelling: 40 records drawn, 70% of them is 28 */
const SAMPLE_SIZE = 40;
const USEFUL_NEED = 28;
const CORRECTNESS = ["correct", "wrong", "unknown"] as const;
const VALUE = ["useful", "not-needed", "unknown"] as const;
const VERDICT = ["correct", "misattributed", "unknown"] as const;

type RecordLabel = {
  correctness: (typeof CORRECTNESS)[number];
  value: (typeof VALUE)[number];
  reason: string;
};
type AuditLabel = { verdict: (typeof VERDICT)[number]; reason: string };
type Labelled<T, L> = T & { claude: L; codex: L; owner: L | null; settled: L };
export type Labels = {
  sample: Labelled<{ n: number; unit: number }, RecordLabel>[];
  extra: Labelled<{ n: number; unit: number }, RecordLabel>[];
  audit: Labelled<{ n: number; adoption: number }, AuditLabel>[];
  owner_work: OwnerWork[];
};

type Bar = "pass" | "fail" | "undecided";

export type Decision = {
  useful: { size: number; need: number; confirmed: number; possible: number; bar: Bar };
  adoption: {
    owner_rows: number;
    misattributed: number;
    unknown: number;
    bar: Bar;
    agent: { audited: number; misattributed: number; unknown: number };
  };
  empty: {
    host: Host;
    output: [number | null, number | null];
    all: [number | null, number | null];
    gaps: number;
    bar: "experiment" | "no experiment" | "undecided";
  };
  /** undetermined: runs that saved records but no sampled record of theirs is confirmed useful */
  runs: { total: number; saved: number; confirmed_useful: number; sampled: number; undetermined: number };
  actions: string[];
};

/** Every label the bar reads, checked against the drawn rows by position, so a label cannot sit on another record than the one drawn */
export function checkLabels(
  labels: Labels,
  drawn: { sample: Drawn[]; extra: Drawn[]; audit: AuditRow[] },
): void {
  const record = (l: unknown, where: string): void => {
    const r = l as Partial<RecordLabel> | null;
    if (
      !r ||
      !CORRECTNESS.includes(r.correctness as never) ||
      !VALUE.includes(r.value as never) ||
      !r.reason?.trim()
    )
      throw new Error(
        `${where}: a record label needs correctness ${CORRECTNESS.join("/")}, value ${VALUE.join("/")}, and a reason`,
      );
  };
  const audit = (l: unknown, where: string): void => {
    const a = l as Partial<AuditLabel> | null;
    if (!a || !VERDICT.includes(a.verdict as never) || !a.reason?.trim())
      throw new Error(`${where}: an adoption label needs verdict ${VERDICT.join("/")} and a reason`);
  };
  const rows = <T extends { n: number }>(
    got: T[],
    want: { n: number }[],
    name: string,
    same: (g: T, w: never) => boolean,
  ) => {
    if (got.length !== want.length) throw new Error(`${name}: ${got.length} labelled, ${want.length} drawn`);
    got.forEach((g, i) => {
      if (g.n !== want[i]?.n || !same(g, want[i] as never))
        throw new Error(`${name} ${i + 1}: not the row drawn there`);
    });
  };
  rows(labels.sample, drawn.sample, "sample", (g, w: Drawn) => g.unit === w.unit);
  rows(labels.extra, drawn.extra, "extra", (g, w: Drawn) => g.unit === w.unit);
  rows(labels.audit, drawn.audit, "audit", (g, w: AuditRow) => g.adoption === w.adoption);
  for (const [name, list] of [
    ["sample", labels.sample],
    ["extra", labels.extra],
  ] as const)
    for (const l of list) {
      for (const who of ["claude", "codex", "settled"] as const) record(l[who], `${name} ${l.n} ${who}`);
      if (l.owner === null && name === "sample")
        throw new Error(`sample ${l.n}: the owner has not confirmed it`);
      if (l.owner !== null) {
        record(l.owner, `${name} ${l.n} owner`);
        if (l.owner.correctness !== l.settled.correctness || l.owner.value !== l.settled.value)
          throw new Error(`${name} ${l.n}: settled is not the owner's label`);
      }
    }
  for (const l of labels.audit) {
    for (const who of ["claude", "codex", "settled"] as const) audit(l[who], `audit ${l.n} ${who}`);
    if (l.owner !== null) {
      audit(l.owner, `audit ${l.n} owner`);
      if (l.owner.verdict !== l.settled.verdict)
        throw new Error(`audit ${l.n}: settled is not the owner's label`);
    }
  }
}

/**
 * The three bars fixed before labelling, each on its own. The useful rate counts the random sample only: confirmed when correct and
 * useful, possible unless wrong or not-needed, so unknowns fall on both sides. The token share is judged on Claude Code; any gap there,
 * a zero total, or proxies and bounds that disagree leave it to the owner.
 */
export function decide(
  labels: Labels,
  drawn: { sample: Drawn[]; extra: Drawn[]; audit: AuditRow[] },
  population: Population,
  hosts: ReturnType<typeof shares>,
): Decision {
  const size = drawn.sample.length;
  const need = USEFUL_NEED;
  const confirmed = labels.sample.filter(
    (l) => l.settled.correctness === "correct" && l.settled.value === "useful",
  );
  const possible = labels.sample.filter(
    (l) => l.settled.correctness !== "wrong" && l.settled.value !== "not-needed",
  );
  // The bar was fixed for this sample size; any other sample leaves it to the owner
  const usefulBar: Bar =
    size !== SAMPLE_SIZE
      ? "undecided"
      : confirmed.length >= need
        ? "pass"
        : possible.length < need
          ? "fail"
          : "undecided";
  const route = new Map(drawn.audit.map((a) => [a.adoption, a.route]));
  const ownerRows = labels.audit.filter((l) => route.get(l.adoption) !== "agent");
  const agentRows = labels.audit.filter((l) => route.get(l.adoption) === "agent");
  const count = (ls: typeof labels.audit, v: AuditLabel["verdict"]) =>
    ls.filter((l) => l.settled.verdict === v).length;
  const misattributed = count(ownerRows, "misattributed");
  const unknown = count(ownerRows, "unknown");
  const adoptionBar: Bar = misattributed ? "fail" : unknown ? "undecided" : "pass";
  const claude = hosts["claude-code"];
  const bounds = claude
    ? [claude.output.share_low, claude.output.share_high, claude.all.share_low, claude.all.share_high]
    : [];
  const gaps = claude ? claude.output.gaps : 0;
  const emptyBar =
    !claude || gaps > 0 || bounds.some((b) => b === null)
      ? "undecided"
      : bounds.every((b) => (b as number) > 0.3)
        ? "experiment"
        : bounds.every((b) => (b as number) <= 0.3)
          ? "no experiment"
          : "undecided";
  const unitRun = new Map(population.runs.flatMap((r) => r.units.map((u) => [u, r.id])));
  const saved = population.runs.filter((r) => r.units.length);
  const useful = new Set(confirmed.map((l) => unitRun.get(l.unit)));
  const actions: string[] = [];
  if (usefulBar === "fail") actions.push("plan a fix of what the automatic trace extracts");
  if (adoptionBar === "fail") actions.push("file an issue for the misattributed owner adoptions");
  if (emptyBar === "experiment") actions.push("plan #259's stage-1 mechanical filter experiment");
  for (const [name, bar] of [
    ["the useful rate", usefulBar],
    ["the owner adoptions", adoptionBar],
    ["the empty-run token share", emptyBar],
  ] as const)
    if (bar === "undecided") actions.push(`the owner decides ${name}`);
  if (!actions.length) actions.push("keep the automatic trace as it is");
  return {
    useful: { size, need, confirmed: confirmed.length, possible: possible.length, bar: usefulBar },
    adoption: {
      owner_rows: ownerRows.length,
      misattributed,
      unknown,
      bar: adoptionBar,
      agent: {
        audited: agentRows.length,
        misattributed: count(agentRows, "misattributed"),
        unknown: count(agentRows, "unknown"),
      },
    },
    empty: {
      host: "claude-code",
      output: [claude?.output.share_low ?? null, claude?.output.share_high ?? null],
      all: [claude?.all.share_low ?? null, claude?.all.share_high ?? null],
      gaps,
      bar: emptyBar,
    },
    runs: {
      total: population.runs.length,
      saved: saved.length,
      confirmed_useful: useful.size,
      sampled: new Set(labels.sample.map((l) => unitRun.get(l.unit))).size,
      undetermined: saved.filter((r) => !useful.has(r.id)).length,
    },
    actions,
  };
}

type Baseline = {
  note: string;
  inputs: Inputs;
  population: Population;
  usage?: {
    rule: string;
    hosts: ReturnType<typeof shares>;
    spans: SpanResult[];
    responses: Attributed[];
  };
  time?: ReturnType<typeof times>;
  sampling?: { method: string; seed: number; size: number; population_sha256: string };
  sample?: Drawn[];
  extra?: Drawn[];
  audit?: AuditRow[];
  labels?: Labels;
  result?: Decision;
};

/** An argument's date and time in the form the database stores, so comparing the strings compares the instants */
function instant(name: string, value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`--${name} ${value} is not a date and time`);
  return d.toISOString();
}

function window(from: string, to: string): Window {
  const w = { from: instant("from", from), to: instant("to", to) };
  if (w.from >= w.to) throw new Error(`--from must be before --to (${w.from}, ${w.to})`);
  return w;
}

function directory(name: string, value: string): string {
  if (!fs.existsSync(value) || !fs.statSync(value).isDirectory())
    throw new Error(`--${name} ${value} is not a directory`);
  return value;
}

const NOTE =
  "#259 stage 1: the automatic trace runs of 0.6.30 and later, pinned from the owner's database and logs; see .claude/plans for the bars fixed before labelling";

/**
 * Pins the population and its inputs, or with a baseline already there, extracts again from the live data and names what differs.
 * between runs after the live data is first read and before the result is written, where a write by another process can land.
 */
export async function pin(
  values: Record<string, string | undefined>,
  between: () => void = () => {},
): Promise<void> {
  const dirs = {
    claude: directory("claude", values.claude as string),
    codex: directory("codex", values.codex as string),
  };
  const w = window(values.from as string, values.to as string);
  const [out, project, root] = [values.out as string, values.project as string, values.root as string];
  const logs = readLogs(dirs);
  if (fs.existsSync(out)) {
    const db = openReader(values.db as string);
    let fresh: Population;
    try {
      fresh = await extract(db, project, w, logs, root);
    } finally {
      await db.destroy();
    }
    const pinned = (JSON.parse(fs.readFileSync(out, "utf8")) as Baseline).population;
    const diff = differences(pinned, fresh);
    if (diff.length)
      throw new Error(`the live data no longer gives the pinned population:\n${diff.join("\n")}`);
    console.log(`${fresh.runs.length} runs and ${fresh.units} records, the same as ${out}`);
    return;
  }
  between();
  const frozen = values.frozen as string;
  const inputs = await freeze({
    repo: values.repo as string,
    db: values.db as string,
    project,
    frozen,
    logs,
    dirs,
  });
  // Extracted from the copies, so what is pinned is exactly what the frozen inputs give
  const thawed = thaw(frozen, inputs);
  const db = openReader(thawed.db);
  let population: Population;
  try {
    population = await extract(db, project, w, thawed.logs, root);
  } finally {
    await db.destroy();
  }
  const baseline: Baseline = { note: NOTE, inputs, population };
  fs.writeFileSync(out, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(
    `${population.runs.length} runs, ${population.units} records, ${population.spans.length} spans, ${population.unmatched.length} unmatched run ids pinned to ${out}`,
  );
}

/** Counts tokens and time from the frozen inputs, and writes them into the baseline */
function countUsage(values: Record<string, string | undefined>): void {
  const file = values.baseline as string;
  const baseline = JSON.parse(fs.readFileSync(file, "utf8")) as Baseline;
  if (populationDigest(baseline.population) !== baseline.population.sha256)
    throw new Error(`${file} does not hash to its population's sha256`);
  const { logs } = thaw(directory("frozen", values.frozen as string), baseline.inputs);
  const owner = values["owner-work"]
    ? (JSON.parse(fs.readFileSync(values["owner-work"], "utf8")) as { entries: OwnerWork[] }).entries
    : [];
  const { responses, spans } = attribute(baseline.population, logs, owner);
  baseline.usage = { rule: USAGE_RULE, hosts: shares(responses), spans, responses };
  baseline.time = times(baseline.population, spans);
  fs.writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(JSON.stringify(baseline.usage.hosts, null, 2));
}

/** A whole-number argument at or above min, so a typo cannot draw another sample than the one asked for */
function whole(name: string, value: string, min: number): number {
  const n = Number(value);
  if (!/^-?\d+$/.test(value.trim()) || !Number.isSafeInteger(n) || n < min)
    throw new Error(`--${name} ${value} is not a whole number${min > 0 ? " above 0" : ""}`);
  return n;
}

/** Draws the sample from the frozen database into the baseline, or checks a baseline that has one draws the same, and writes the sheet */
async function drawSample(values: Record<string, string | undefined>): Promise<void> {
  const file = values.baseline as string;
  const baseline = JSON.parse(fs.readFileSync(file, "utf8")) as Baseline;
  if (populationDigest(baseline.population) !== baseline.population.sha256)
    throw new Error(`${file} does not hash to its population's sha256`);
  const seed = whole("seed", values.seed as string, 0);
  const size = whole("size", values.size as string, 1);
  const { db: snapshot } = thaw(directory("frozen", values.frozen as string), baseline.inputs);
  const db = openReader(snapshot);
  try {
    const drawn = await draw(db, baseline.population, seed, size);
    if (baseline.sampling) {
      const same =
        baseline.sampling.seed === seed &&
        baseline.sampling.size === size &&
        JSON.stringify([baseline.sample, baseline.extra, baseline.audit]) ===
          JSON.stringify([drawn.sample, drawn.extra, drawn.audit]);
      if (!same) throw new Error(`${file} already holds another sample; it is drawn once`);
    } else {
      baseline.sampling = {
        method: "records ordered by (created_at, id), shuffled with mulberry32 and the seed, first size",
        seed,
        size,
        population_sha256: baseline.population.sha256,
      };
      Object.assign(baseline, drawn);
      fs.writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`);
    }
    fs.writeFileSync(values.sheet as string, await sheet(db, baseline.population, drawn));
    console.log(
      `${drawn.sample.length} sampled, ${drawn.extra.length} extra AI decisions, ${drawn.audit.length} adoptions to audit; sheet ${values.sheet}`,
    );
  } finally {
    await db.destroy();
  }
}

/**
 * Applies the bars. The first run takes the labels into the baseline; every run recomputes the tokens, the sample, and the result from
 * the frozen inputs and the baseline's labels, and a baseline that already holds a result must come out the same.
 */
async function decideBars(values: Record<string, string | undefined>): Promise<void> {
  const file = values.baseline as string;
  const baseline = JSON.parse(fs.readFileSync(file, "utf8")) as Baseline;
  if (populationDigest(baseline.population) !== baseline.population.sha256)
    throw new Error(`${file} does not hash to its population's sha256`);
  if (!baseline.sampling || !baseline.sample || !baseline.extra || !baseline.audit)
    throw new Error(`${file} holds no sample; draw it with --sample first`);
  if (values.labels && baseline.labels) throw new Error(`${file} already holds labels; they are taken once`);
  const labels =
    baseline.labels ??
    (values.labels ? (JSON.parse(fs.readFileSync(values.labels, "utf8")) as Labels) : null);
  if (!labels) throw new Error("--decide needs --labels the first time");
  const { db: snapshot, logs } = thaw(directory("frozen", values.frozen as string), baseline.inputs);
  const db = openReader(snapshot);
  let drawn: Awaited<ReturnType<typeof draw>>;
  try {
    drawn = await draw(db, baseline.population, baseline.sampling.seed, baseline.sampling.size);
  } finally {
    await db.destroy();
  }
  if (
    JSON.stringify([drawn.sample, drawn.extra, drawn.audit]) !==
    JSON.stringify([baseline.sample, baseline.extra, baseline.audit])
  )
    throw new Error("the frozen inputs no longer draw the baseline's sample");
  checkLabels(labels, drawn);
  const { responses, spans } = attribute(baseline.population, logs, labels.owner_work);
  const hosts = shares(responses);
  const result = decide(labels, drawn, baseline.population, hosts);
  const usage = { rule: USAGE_RULE, hosts, spans, responses };
  const time = times(baseline.population, spans);
  if (baseline.result) {
    // Every published number is checked, not only the verdict built from them
    if (
      JSON.stringify([baseline.result, baseline.usage, baseline.time]) !==
      JSON.stringify([result, usage, time])
    )
      throw new Error("the frozen inputs and labels no longer give the baseline's result");
    console.log("the frozen inputs and labels give the baseline's result again");
    return;
  }
  baseline.labels = labels;
  baseline.usage = usage;
  baseline.time = time;
  baseline.result = result;
  fs.writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      freeze: { type: "boolean" },
      db: { type: "string" },
      claude: { type: "string" },
      codex: { type: "string" },
      project: { type: "string" },
      root: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      repo: { type: "string" },
      frozen: { type: "string" },
      out: { type: "string" },
      usage: { type: "boolean" },
      baseline: { type: "string" },
      "owner-work": { type: "string" },
      sample: { type: "boolean" },
      seed: { type: "string" },
      size: { type: "string" },
      sheet: { type: "string" },
      decide: { type: "boolean" },
      labels: { type: "string" },
    },
  });
  const need = (mode: string, keys: (keyof typeof values)[]) => {
    const missing = keys.filter((k) => !values[k]);
    if (missing.length) throw new Error(`${mode} needs ${missing.map((k) => `--${k}`).join(", ")}`);
  };
  if (values.freeze) {
    need("--freeze", ["db", "claude", "codex", "project", "root", "from", "to", "repo", "frozen", "out"]);
    await pin(values as Record<string, string | undefined>);
    return;
  }
  if (values.usage) {
    need("--usage", ["baseline", "frozen"]);
    countUsage(values as Record<string, string | undefined>);
    return;
  }
  if (values.sample) {
    need("--sample", ["baseline", "frozen", "seed", "size", "sheet"]);
    await drawSample(values as Record<string, string | undefined>);
    return;
  }
  if (values.decide) {
    need("--decide", ["baseline", "frozen"]);
    await decideBars(values as Record<string, string | undefined>);
    return;
  }
  throw new Error(
    "pass --freeze to pin the population and its inputs, --usage to count tokens and time, --sample to draw records and write the sheet, or --decide to apply the bars",
  );
}

if (process.argv[1] && /auto-trace\.(ts|js)$/.test(process.argv[1])) await main();
