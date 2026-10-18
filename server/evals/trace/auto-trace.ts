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

/** One model response: Claude Code writes one over several lines that share message.id, Codex ends one with a token_usage_record */
type Response = { key: string | null; line: number; at: string | null; turn: string | null };

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
        r = log.responses.push({ key, line: n, at, turn: null }) - 1;
        if (key !== null) byKey.set(key, r);
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
    for (const c of content)
      if (isObject(c) && c.type === "tool_result" && typeof c.tool_use_id === "string") {
        const call = byCall.get(c.tool_use_id);
        if (call) call.result = { line: n, ok: c.is_error !== true, text: resultText(c.content) };
      }
  }
  return log;
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
  for (const [n, d] of lines(raw, log.unreadable)) {
    const p = isObject(d.payload) ? d.payload : {};
    const at = typeof d.timestamp === "string" ? d.timestamp : null;
    if (d.type === "session_meta" && typeof p.id === "string" && !log.session) log.session = p.id;
    if (d.type === "token_usage_record") {
      log.responses.push({
        key: typeof p.response_id === "string" ? p.response_id : null,
        line: n,
        at,
        turn: typeof p.turn_id === "string" ? p.turn_id : null,
      });
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

type Baseline = {
  note: string;
  inputs: Inputs;
  population: Population;
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
  throw new Error("pass --freeze to pin the population and its inputs");
}

if (process.argv[1] && /auto-trace\.(ts|js)$/.test(process.argv[1])) await main();
