// The post_write entry check (M0): past successful writes from Claude Code transcripts, matched against the records deliverable at each
// write's result, less what had already reached that conversation (read from its transcript, never from the delivery log), so what a
// delivery right after the write would have shown can be counted and labelled before it is built.
// node server/evals/post-write/replay.ts --db <sphica.db> --transcripts <dir> --repo <checkout> --snapshot <file> --out <replay.json>
// node server/evals/post-write/replay.ts --sample <replay.json> --seed <n> --size 40 --out <sample.json>
// node server/evals/post-write/replay.ts --sheet <sample.json> --db <snapshot> --transcripts <dir> > sheet.md
// node server/evals/post-write/replay.ts --decide <labels.json>
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { ReadonlyKysely } from "kysely/readonly";
import { authorityOf } from "../../src/authority.ts";
import { openReader } from "../../src/db.ts";
import type { DB } from "../../src/db-types.ts";
import { namedRecords } from "../../src/deliver.ts";
import { inline } from "../../src/panel.ts";
import { identify, projectId } from "../../src/project.ts";
import { head } from "../../src/text.ts";
import {
  type Conversation,
  deliveryObserved,
  freeze,
  type Inputs,
  lastCompact,
  readConversations,
  turnStart,
} from "./transcript.ts";

/** What one delivery would show, as the plan fixes it for post_write: 3 records within 900 characters, each in its shortest line */
const PER_WRITE = 3;
const CHARS = 900;
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const DOCUMENT = /\.(md|mdx|markdown|txt|rst)$/i;

export type Pair = {
  session: string;
  agent: string | null;
  toolUseId: string;
  at: string;
  path: string;
  document: boolean;
  key: string;
  unit: number;
  hit: "symbol" | "path" | "option";
  why: string;
  shown: boolean;
};

export type Replay = {
  inputs?: Inputs;
  counts: {
    conversations: number;
    unreadable: number;
    writes: number;
    failed: number;
    outside: number;
    notObserved: number;
    /** Writes where an earlier delivery in the window could not be read completely, so what was shown is not known */
    unknown: number;
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
 * The project and root of a write's working directory. A Claude Code worktree removed since (`<checkout>/.claude/worktrees/<name>`) is the
 * checkout's project, with paths taken from the worktree's own root.
 */
export function placeOf(cwd: string): { key: string; root: string } | null {
  if (fs.existsSync(cwd)) return identify(cwd);
  const m = /^(.*?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+/.exec(cwd);
  const main = m?.[1] && fs.existsSync(m[1]) ? identify(m[1]) : null;
  return main && m ? { key: main.key, root: m[0] } : null;
}

/** A record's line without its reason, the form delivery fitting starts from */
const shortLine = (h: Awaited<ReturnType<typeof namedRecords>>[number]) =>
  `- ${inline(h.u.key)} (${h.u.kind}${h.u.stance ? ` ${h.u.stance}` : ""}): ${head(inline(h.u.text), 240)}${h.why}`;

/**
 * Each successful write matched as post_write would match it at its result: the records deliverable then that it names, less those that
 * reached the conversation since its last compaction (its own pre-edit delivery included, and this replay's own earlier deliveries). Of
 * the first PER_WRITE, those whose shortest lines fit in CHARS are shown. A conversation where Sphica's delivery was not seen before the
 * write's turn is out of scope, and a write after a delivery that could not be read completely is unknown; both are counted apart.
 */
export async function replay(db: ReadonlyKysely<DB>, conversations: Conversation[]): Promise<Replay> {
  const counts = {
    conversations: conversations.length,
    unreadable: conversations.reduce((n, c) => n + c.unreadable, 0),
    writes: 0,
    failed: 0,
    outside: 0,
    notObserved: 0,
    unknown: 0,
  };
  const pairs: Pair[] = [];
  const sessions = new Map<string, Replay["sessions"][number]>();
  const projects = new Map<string, { id: number; root: string } | null>();
  for (const c of conversations) {
    const own = new Map<number, Set<number>>();
    for (const e of c.events) {
      if (e.kind !== "call" || !WRITE_TOOLS.has(e.name)) continue;
      const text = writtenText(e.name, e.input);
      const target = e.input.file_path ?? e.input.notebook_path;
      if (text === null || typeof target !== "string") continue;
      const result = c.events.find((r) => r.kind === "result" && r.id === e.id);
      if (result?.kind !== "result" || !result.ok || !result.at) {
        counts.failed++;
        continue;
      }
      counts.writes++;
      if (!projects.has(e.cwd)) {
        const place = placeOf(e.cwd);
        const id = place ? await projectId(db, place.key) : null;
        projects.set(e.cwd, place && id !== null ? { id, root: place.root } : null);
      }
      const p = projects.get(e.cwd);
      const rel = p ? path.relative(p.root, path.resolve(e.cwd, target)) : "";
      if (!p || !rel || rel.startsWith("..") || path.isAbsolute(rel)) {
        counts.outside++;
        continue;
      }
      if (!deliveryObserved(c, result.n)) {
        counts.notObserved++;
        continue;
      }
      const from = lastCompact(c, result.n);
      const window = c.events.filter((d) => d.kind === "delivery" && d.n > from && d.n < result.n);
      const reached = new Set(window.flatMap((d) => (d.kind === "delivery" ? d.keys : [])));
      const sent = own.get(from) ?? new Set<number>();
      own.set(from, sent);
      const named = (await namedRecords(db, p.id, p.root, text, result.at)).filter(
        (h) => !reached.has(h.u.key) && !sent.has(h.u.id),
      );
      // A delivery not read completely may have shown any of these, so what this write would add is not known
      if (named.length && window.some((d) => d.kind === "delivery" && !d.complete)) {
        counts.unknown++;
        continue;
      }
      const conv = `${c.session}\0${c.agent ?? ""}`;
      const tally = sessions.get(conv) ?? { session: c.session, agent: c.agent, writes: 0, fires: 0 };
      sessions.set(conv, tally);
      tally.writes++;
      if (named.length) tally.fires++;
      let used = 0;
      const shown = new Set<number>();
      for (const h of named.slice(0, PER_WRITE)) {
        const cost = shortLine(h).length + 1;
        if (used + cost > CHARS) continue;
        used += cost;
        shown.add(h.u.id);
        sent.add(h.u.id);
      }
      for (const h of named)
        pairs.push({
          session: c.session,
          agent: c.agent,
          toolUseId: e.id,
          at: result.at,
          path: rel.split(path.sep).join("/"),
          document: DOCUMENT.test(rel) || rel.split(path.sep).includes("plans"),
          key: h.u.key,
          unit: h.u.id,
          hit: h.hit,
          why: h.why.trim(),
          shown: shown.has(h.u.id),
        });
    }
  }
  return { counts, pairs, sessions: [...sessions.values()] };
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

export type Label = { n: number; label: "R" | "H" | "N" | "unknown" };

/**
 * The bar fixed before labelling, with U unknown among n labels: build only if 3(N+U) <= n and R >= 1 (every resolution passes), not
 * built if 3N > n or R + U = 0 (no resolution passes), undecided otherwise. Fewer than 20 labelled pairs decide nothing.
 */
export function decide(labels: Label[]): {
  n: number;
  R: number;
  H: number;
  N: number;
  U: number;
  verdict: "build" | "not built" | "undecided";
} {
  labels.forEach((l, i) => {
    if (l.n !== i + 1)
      throw new Error(`labels must run 1, 2, 3, … without gaps or repeats; found ${l.n} at ${i + 1}`);
    if (!["R", "H", "N", "unknown"].includes(l.label))
      throw new Error(`label ${l.n}: ${l.label} is not R, H, N, or unknown`);
  });
  const n = labels.length;
  const count = (k: Label["label"]) => labels.filter((l) => l.label === k).length;
  const [R, H, N, U] = [count("R"), count("H"), count("N"), count("unknown")];
  const verdict =
    n < 20
      ? "undecided"
      : 3 * (N + U) <= n && R >= 1
        ? "build"
        : 3 * N > n || R + U === 0
          ? "not built"
          : "undecided";
  return { n, R, H, N, U, verdict };
}

/** What a pair's hit named: the symbol, path, or option text inside `[names …]` */
const named = (why: string) => /^\[names (?:the \w+ option )?(.*)\]$/.exec(why)?.[1] ?? "";

/** Up to three windows of the written text around the name (case and width folded as the matching folds them), or its start */
function around(text: string, name: string): string[] {
  const folded = text.normalize("NFKC").toLowerCase();
  const target = name.normalize("NFKC").toLowerCase();
  const out: string[] = [];
  for (
    let i = target ? folded.indexOf(target) : -1;
    i >= 0 && out.length < 3;
    i = folded.indexOf(target, i + target.length)
  )
    out.push(text.slice(Math.max(0, i - 500), i + target.length + 500));
  return out.length ? out : [head(text, 1000)];
}

/** The labelling material for one sampled pair: the record as it stood then, the write, and the owner's prompt that opened the turn */
async function sheetEntry(
  db: ReadonlyKysely<DB>,
  n: number,
  p: Pair,
  c: Conversation | undefined,
  dir: string,
): Promise<string> {
  const u = await db
    .selectFrom("unit")
    .select(["kind", "stance", "text"])
    .where("id", "=", p.unit)
    .executeTakeFirst();
  const options = await db
    .selectFrom("unit_option")
    .select(["outcome", "text"])
    .where("unit_id", "=", p.unit)
    .orderBy("id")
    .execute();
  const authority = (await authorityOf(db, [p.unit], p.at)).get(p.unit);
  const call = c?.events.find((e) => e.kind === "call" && e.id === p.toolUseId);
  const written = call?.kind === "call" ? (writtenText(call.name, call.input) ?? "") : "";
  const old = call?.kind === "call" && typeof call.input.old_string === "string" ? call.input.old_string : "";
  let prompt = "";
  if (c && call) {
    const start = turnStart(c, call.n);
    if (start !== null) {
      const line = fs.readFileSync(path.join(dir, c.file), "utf8").split("\n")[start] ?? "";
      const content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content;
      prompt = typeof content === "string" ? content : JSON.stringify(content ?? "");
    }
  }
  return [
    `## ${n}. ${p.document ? "document" : "code"} ${p.path} (${p.why})`,
    `record ${p.key}: ${u?.kind}${u?.stance ? ` ${u.stance}` : ""}, ${authority} as of the write`,
    `  ${u?.text}`,
    ...options.map((o) => `  - ${o.outcome}: ${o.text}`),
    "the owner's prompt that opened the turn:",
    `  ${head(prompt, 1500).replaceAll("\n", "\n  ")}`,
    ...(old ? ["replaced text (old_string):", `  ${head(old, 1500).replaceAll("\n", "\n  ")}`] : []),
    "written text, around what it named:",
    ...around(written, named(p.why)).map((w) => `  …${w.replaceAll("\n", "\n  ")}…`),
    "label: R (proposes or carries out what the record rejected or rules out) / H (same subject, harmless) / N (unrelated) / unknown",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      transcripts: { type: "string" },
      repo: { type: "string" },
      snapshot: { type: "string" },
      out: { type: "string" },
      sample: { type: "string" },
      seed: { type: "string" },
      size: { type: "string", default: "40" },
      sheet: { type: "string" },
      decide: { type: "string" },
    },
  });
  if (values.decide) {
    const labels = (JSON.parse(fs.readFileSync(values.decide, "utf8")) as { labels: Label[] }).labels;
    console.log(JSON.stringify(decide(labels), null, 2));
    return;
  }
  if (values.sample) {
    if (!values.seed || !values.out) throw new Error("--seed and --out are required with --sample");
    const r = JSON.parse(fs.readFileSync(values.sample, "utf8")) as Replay;
    const s = sample(r.pairs, Number(values.seed), Number(values.size));
    fs.writeFileSync(values.out, `${JSON.stringify({ seed: Number(values.seed), pairs: s }, null, 2)}\n`);
    console.log(`${s.length} pairs (${s.filter((p) => p.document).length} documents)`);
    return;
  }
  if (values.sheet) {
    if (!values.db || !values.transcripts)
      throw new Error("--db and --transcripts are required with --sheet");
    const s = JSON.parse(fs.readFileSync(values.sheet, "utf8")) as { pairs: Pair[] };
    const dir = values.transcripts;
    const conversations = readConversations(dir);
    const db = openReader(values.db);
    try {
      for (const [i, p] of s.pairs.entries()) {
        const c = conversations.find((x) => x.events.some((e) => e.kind === "call" && e.id === p.toolUseId));
        console.log(await sheetEntry(db, i + 1, p, c, dir));
      }
    } finally {
      await db.destroy();
    }
    return;
  }
  const { db: file, transcripts: dir, repo, snapshot, out } = values;
  if (!file || !dir || !repo || !snapshot || !out)
    throw new Error("--db, --transcripts, --repo, --snapshot, and --out are required");
  const conversations = readConversations(dir);
  const reader = openReader(file);
  const projects = await reader.selectFrom("project").select("id").execute();
  await reader.destroy();
  if (projects.length !== 1 || !projects[0]) throw new Error("the database must hold exactly one project");
  const inputs = await freeze({ repo, db: file, projectId: projects[0].id, out: snapshot, conversations });
  const db = openReader(inputs.snapshot.path);
  try {
    const r = { ...(await replay(db, conversations)), inputs };
    fs.writeFileSync(out, `${JSON.stringify(r, null, 2)}\n`);
    const fired = r.sessions.reduce((n, s) => n + s.fires, 0);
    console.log(
      `${r.counts.writes} writes (${r.counts.failed} failed, ${r.counts.outside} outside a project, ${r.counts.notObserved} where Sphica's delivery was not seen, ${r.counts.unknown} unknown); ${fired} would deliver; ${r.pairs.length} pairs`,
    );
  } finally {
    await db.destroy();
  }
}

if (process.argv[1] && /replay\.(ts|js)$/.test(process.argv[1])) await main();
