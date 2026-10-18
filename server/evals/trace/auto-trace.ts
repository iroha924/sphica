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
import { openReader } from "../../src/db.ts";
import type { DB } from "../../src/db-types.ts";

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
    const message = isObject(d.message) ? d.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    if (d.type === "assistant") {
      const key =
        typeof message.id === "string" ? message.id : typeof d.requestId === "string" ? d.requestId : null;
      let r = key === null ? undefined : byKey.get(key);
      if (r === undefined) {
        r = log.responses.push({ key, line: n, at, turn: null, usage: null, gap: null }) - 1;
        if (key !== null) byKey.set(key, r);
      }
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
      if (key === null) response.gap = "no message.id or requestId";
      else if (!counts || counts.some((c) => c === null)) response.gap = "no usage";
      else {
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
          const call: Call = {
            id: c.id,
            ...claudeTool(String(c.name ?? "")),
            input: isObject(c.input) ? c.input : {},
            line: n,
            at,
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
  let lastTurn: string | null = null;
  let turnTotal: Record<string, unknown> | null = null;
  for (const [n, d] of lines(raw, log.unreadable)) {
    const p = isObject(d.payload) ? d.payload : {};
    const at = typeof d.timestamp === "string" ? d.timestamp : null;
    if (d.type === "session_meta" && typeof p.id === "string" && !log.session) log.session = p.id;
    if (d.type === "turn_context" && typeof p.model === "string") model = p.model;
    if (d.type === "token_usage_record") {
      const key = typeof p.response_id === "string" ? p.response_id : null;
      const turn = typeof p.turn_id === "string" ? p.turn_id : null;
      if (key !== null && log.responses.at(-1)?.key === key) continue;
      log.responses.push({
        key,
        line: n,
        at,
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
    log.calls.push({
      id: String(item.id ?? `line-${n}`),
      ...codexTool(item.server, item.tool),
      input: isObject(item.arguments) ? item.arguments : {},
      line: n,
      at,
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
  window: Window;
  condition: string;
  runs: Run[];
  unmatched: Unmatched[];
  spans: SpanStart[];
  units: number;
  sha256: string;
};

const CONDITION =
  "trace runs of the project whose run id a record_context call with auto: true names in a log, started from <= started_at < to, ordered by started_at and id; spans start at each trace_pending call with auto: true made in the window";

const inWindow = (at: string | null, w: Window) => at !== null && at >= w.from && at < w.to;

const populationDigest = (p: Pick<Population, "runs" | "unmatched" | "spans">): string =>
  sha256(JSON.stringify({ runs: p.runs, unmatched: p.unmatched, spans: p.spans }));

export async function extract(
  db: ReadonlyKysely<DB>,
  project: string,
  w: Window,
  logs: Log[],
): Promise<Population> {
  const p = await db.selectFrom("project").select("id").where("key", "=", project).executeTakeFirst();
  if (!p) throw new Error(`no project with the key ${project}`);
  const named = new Map<
    string,
    { host: Host; file: string; line: number; at: string | null; error: string | null }[]
  >();
  const spans: SpanStart[] = [];
  for (const log of logs)
    for (const c of log.calls) {
      if (c.server !== "record" || c.input.auto !== true) continue;
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
  logs: { count: number; sha256: string; files: { host: Host; file: string; sha256: string }[] };
};

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
  const files = o.logs.map((l) => ({ host: l.host, file: l.file, sha256: l.sha256 }));
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
    const end = closed ? last + 1 : stop - 1;
    const endAt = log.responses[end]?.at ?? null;
    const unanswered = record(last).some((c) => c.result === null);
    const truncated =
      unanswered || !endAt || endAt >= population.window.to || (!closed && stop === log.responses.length);
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

/** Pins the population and its inputs, or with a baseline already there, extracts again from the live data and names what differs */
async function pin(values: Record<string, string | undefined>): Promise<void> {
  const dirs = {
    claude: directory("claude", values.claude as string),
    codex: directory("codex", values.codex as string),
  };
  const w = window(values.from as string, values.to as string);
  const out = values.out as string;
  const logs = readLogs(dirs);
  const db = openReader(values.db as string);
  let fresh: Population;
  try {
    fresh = await extract(db, values.project as string, w, logs);
  } finally {
    await db.destroy();
  }
  if (fs.existsSync(out)) {
    const pinned = (JSON.parse(fs.readFileSync(out, "utf8")) as Baseline).population;
    const diff = differences(pinned, fresh);
    if (diff.length)
      throw new Error(`the live data no longer gives the pinned population:\n${diff.join("\n")}`);
    console.log(`${fresh.runs.length} runs and ${fresh.units} records, the same as ${out}`);
    return;
  }
  const inputs = await freeze({
    repo: values.repo as string,
    db: values.db as string,
    project: values.project as string,
    frozen: values.frozen as string,
    logs,
    dirs,
  });
  const baseline: Baseline = { note: NOTE, inputs, population: fresh };
  fs.writeFileSync(out, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(
    `${fresh.runs.length} runs, ${fresh.units} records, ${fresh.spans.length} spans, ${fresh.unmatched.length} unmatched run ids pinned to ${out}`,
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

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      freeze: { type: "boolean" },
      db: { type: "string" },
      claude: { type: "string" },
      codex: { type: "string" },
      project: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      repo: { type: "string" },
      frozen: { type: "string" },
      out: { type: "string" },
      usage: { type: "boolean" },
      baseline: { type: "string" },
      "owner-work": { type: "string" },
    },
  });
  const need = (mode: string, keys: (keyof typeof values)[]) => {
    const missing = keys.filter((k) => !values[k]);
    if (missing.length) throw new Error(`${mode} needs ${missing.map((k) => `--${k}`).join(", ")}`);
  };
  if (values.freeze) {
    need("--freeze", ["db", "claude", "codex", "project", "from", "to", "repo", "frozen", "out"]);
    await pin(values as Record<string, string | undefined>);
    return;
  }
  if (values.usage) {
    need("--usage", ["baseline", "frozen"]);
    countUsage(values as Record<string, string | undefined>);
    return;
  }
  throw new Error("pass --freeze to pin the population and its inputs, or --usage to count tokens and time");
}

if (process.argv[1] && /auto-trace\.(ts|js)$/.test(process.argv[1])) await main();
