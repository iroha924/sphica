// The post_write entry check (M0): past writes from Claude Code transcripts, matched against the current records the way a delivery right
// after the write would match them, so what it would have delivered can be counted and labelled before it is built. Current records replayed
// on past inputs, not what past sessions missed.
// node server/evals/post-write/replay.ts --db <sphica.db> --out <file.json> <transcript dir>...
// node server/evals/post-write/replay.ts --sample <replay.json> --seed <n> --size 40 --out <sample.json>
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { ReadonlyKysely } from "kysely/readonly";
import { openReader } from "../../src/db.ts";
import type { DB } from "../../src/db-types.ts";
import { namedRecords } from "../../src/deliver.ts";
import { sessionId } from "../../src/knowledge.ts";
import { identify, projectId } from "../../src/project.ts";

/** What one delivery would show, as the plan fixes it for post_write */
const PER_WRITE = 3;
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const DOCUMENT = /\.(md|mdx|markdown|txt|rst)$/i;

export type Write = {
  session: string;
  agent: string | null;
  toolUseId: string;
  at: string;
  cwd: string;
  file: string;
  text: string;
};

export type Pair = {
  session: string;
  agent: string | null;
  toolUseId: string;
  at: string;
  path: string;
  document: boolean;
  key: string;
  hit: "symbol" | "path" | "option";
  why: string;
  shown: boolean;
};

export type Replay = {
  inputs: {
    files: number;
    lines: number;
    unreadable: number;
    writes: number;
    failed: number;
    outside: number;
  };
  pairs: Pair[];
  sessions: { session: string; agent: string | null; writes: number; fires: number }[];
};

/** The text a write put in the file: replaced or written text only, never what it replaced, and nothing for a deleted notebook cell */
export function writtenText(name: string, input: Record<string, unknown>): string | null {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  if (name === "Edit") return s(input.new_string);
  if (name === "Write") return s(input.content);
  if (name === "MultiEdit")
    return Array.isArray(input.edits)
      ? input.edits.map((e) => s((e as Record<string, unknown> | null)?.new_string)).join("\n")
      : "";
  if (name === "NotebookEdit") return input.edit_mode === "delete" ? null : s(input.new_source);
  return null;
}

/**
 * The successful writes in Claude Code transcript files. A write whose result is an error, or that has no result, is left out (the host
 * runs PostToolUse only after a tool succeeds), and counted.
 */
export function readTranscripts(files: string[]): { writes: Write[]; inputs: Replay["inputs"] } {
  const inputs = { files: files.length, lines: 0, unreadable: 0, writes: 0, failed: 0, outside: 0 };
  const writes: Write[] = [];
  for (const file of files) {
    const calls = new Map<string, Write>();
    const ok = new Set<string>();
    for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
      if (!raw.trim()) continue;
      inputs.lines++;
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        inputs.unreadable++;
        continue;
      }
      const content = (d.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content as Record<string, unknown>[]) {
        if (d.type === "assistant" && c.type === "tool_use" && WRITE_TOOLS.has(String(c.name))) {
          const input = (c.input ?? {}) as Record<string, unknown>;
          const text = writtenText(String(c.name), input);
          const target = input.file_path ?? input.notebook_path;
          if (text === null || typeof target !== "string" || typeof c.id !== "string") continue;
          calls.set(c.id, {
            session: String(d.sessionId ?? ""),
            agent: typeof d.agentId === "string" ? d.agentId : null,
            toolUseId: c.id,
            at: String(d.timestamp ?? ""),
            cwd: String(d.cwd ?? ""),
            file: target,
            text,
          });
        }
        if (
          d.type === "user" &&
          c.type === "tool_result" &&
          typeof c.tool_use_id === "string" &&
          c.is_error !== true
        )
          ok.add(c.tool_use_id);
      }
    }
    for (const [id, w] of calls) {
      if (ok.has(id)) writes.push(w);
      else inputs.failed++;
    }
  }
  inputs.writes = writes.length;
  writes.sort((a, b) => a.at.localeCompare(b.at) || a.toolUseId.localeCompare(b.toolUseId));
  return { writes, inputs };
}

/** Where this conversation's context last restarted before t: the main conversation restarts on compact and clear, a subagent never */
async function restartBefore(
  db: ReadonlyKysely<DB>,
  session: string,
  agent: string | null,
  t: string,
): Promise<string> {
  if (agent !== null) return "";
  const r = await db
    .selectFrom("delivery")
    .select("at")
    .where("session_id", "=", session)
    .where("agent_id", "is", null)
    .where("event", "=", "session_start")
    .where("reason", "in", ["compact", "clear"])
    .where("at", "<=", t)
    .orderBy("at", "desc")
    .limit(1)
    .executeTakeFirst();
  return r?.at ?? "";
}

/** The records already emitted to this conversation between its last restart and the write */
async function emittedBefore(
  db: ReadonlyKysely<DB>,
  session: string,
  agent: string | null,
  from: string,
  t: string,
): Promise<Set<number>> {
  const rows = await db
    .selectFrom("delivery as d")
    .innerJoin("delivery_unit as du", "du.delivery_id", "d.id")
    .select("du.unit_id")
    .where("d.session_id", "=", session)
    .where((eb) => (agent === null ? eb("d.agent_id", "is", null) : eb("d.agent_id", "=", agent)))
    .where("d.outcome", "=", "emitted")
    .where("d.at", ">=", from)
    .where("d.at", "<", t)
    .execute();
  return new Set(rows.map((r) => r.unit_id));
}

/**
 * The project and root of a write's working directory. A Claude Code worktree removed since (`<checkout>/.claude/worktrees/<name>`) is the
 * checkout's project, with paths taken from the worktree's own root.
 */
export function placeOf(cwd: string): { key: string; root: string } | null {
  if (fs.existsSync(cwd)) return identify(cwd);
  const m = /^(.*?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+/.exec(cwd);
  const main = m?.[1] && fs.existsSync(m[1]) ? identify(m[1]) : null;
  return main && m ? { key: main.key, root: m[0] } : null;
}

/**
 * Each write matched as post_write would match it: records it names, less those emitted to the conversation since its last restart (by
 * the hooks that ran then, or by this replay's own earlier deliveries), the first PER_WRITE of them shown.
 */
export async function replay(file: string, writes: Write[], inputs: Replay["inputs"]): Promise<Replay> {
  const db = openReader(file);
  try {
    const pairs: Pair[] = [];
    const sessions = new Map<string, Replay["sessions"][number]>();
    const own = new Map<string, { from: string; units: Set<number> }>();
    const projects = new Map<string, { id: number; root: string } | null>();
    for (const w of writes) {
      if (!projects.has(w.cwd)) {
        const place = placeOf(w.cwd);
        const id = place ? await projectId(db, place.key) : null;
        projects.set(w.cwd, place && id !== null ? { id, root: place.root } : null);
      }
      const p = projects.get(w.cwd);
      const rel = p ? path.relative(p.root, path.resolve(w.cwd, w.file)) : "";
      if (!p || !rel || rel.startsWith("..") || path.isAbsolute(rel)) {
        inputs.outside++;
        continue;
      }
      const sid = sessionId(p.id, "claude-code", w.session);
      const conv = `${w.session}\0${w.agent ?? ""}`;
      const tally = sessions.get(conv) ?? { session: w.session, agent: w.agent, writes: 0, fires: 0 };
      sessions.set(conv, tally);
      tally.writes++;
      const from = await restartBefore(db, sid, w.agent, w.at);
      const mine = own.get(conv);
      if (!mine || mine.from !== from) own.set(conv, { from, units: new Set() });
      const sent = own.get(conv)?.units ?? new Set<number>();
      const before = await emittedBefore(db, sid, w.agent, from, w.at);
      const hits = (await namedRecords(db, p.id, p.root, w.text)).filter(
        (h) => !before.has(h.u.id) && !sent.has(h.u.id),
      );
      if (hits.length) tally.fires++;
      for (const [i, h] of hits.entries()) {
        if (i < PER_WRITE) sent.add(h.u.id);
        pairs.push({
          session: w.session,
          agent: w.agent,
          toolUseId: w.toolUseId,
          at: w.at,
          path: rel.split(path.sep).join("/"),
          document: DOCUMENT.test(rel) || rel.split(path.sep).includes("plans"),
          key: h.u.key,
          hit: h.hit,
          why: h.why.trim(),
          shown: i < PER_WRITE,
        });
      }
    }
    return { inputs, pairs, sessions: [...sessions.values()] };
  } finally {
    await db.destroy();
  }
}

/** A seeded generator (mulberry32), so a sample is fixed before anyone labels it */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: T[], seed: number): T[] {
  const r = seeded(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Up to size shown pairs, split evenly between documents and code (the rest from the other stratum when one runs short) */
export function sample(pairs: Pair[], seed: number, size: number): Pair[] {
  const shown = shuffled(
    pairs.filter((p) => p.shown),
    seed,
  );
  const docs = shown.filter((p) => p.document);
  const code = shown.filter((p) => !p.document);
  const half = Math.ceil(size / 2);
  const d = docs.slice(0, Math.max(half, size - code.length));
  const c = code.slice(0, size - d.length);
  return [...d, ...c];
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      db: { type: "string" },
      out: { type: "string" },
      sample: { type: "string" },
      seed: { type: "string" },
      size: { type: "string", default: "40" },
    },
  });
  if (!values.out) throw new Error("--out is required");
  if (values.sample) {
    if (!values.seed) throw new Error("--seed is required with --sample");
    const r = JSON.parse(fs.readFileSync(values.sample, "utf8")) as Replay;
    const s = sample(r.pairs, Number(values.seed), Number(values.size));
    fs.writeFileSync(values.out, `${JSON.stringify({ seed: Number(values.seed), pairs: s }, null, 2)}\n`);
    console.log(`${s.length} pairs (${s.filter((p) => p.document).length} documents)`);
    return;
  }
  if (!values.db || !positionals.length)
    throw new Error("--db and at least one transcript directory are required");
  const files = positionals.flatMap((dir) =>
    fs
      .readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(dir, f)),
  );
  const { writes, inputs } = readTranscripts(files);
  const r = await replay(values.db, writes, inputs);
  fs.writeFileSync(values.out, `${JSON.stringify(r, null, 2)}\n`);
  const fired = r.sessions.reduce((n, s) => n + s.fires, 0);
  console.log(
    `${r.inputs.writes} writes (${r.inputs.failed} failed, ${r.inputs.outside} outside a project, ${r.inputs.unreadable} unreadable lines); ${fired} would deliver; ${r.pairs.length} pairs`,
  );
}

if (process.argv[1] && /replay\.(ts|js)$/.test(process.argv[1])) await main();
