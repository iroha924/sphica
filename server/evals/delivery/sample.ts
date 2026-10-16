// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The delivery precision sample: every record a hook delivered in a window, pinned to a file so the same sample can be drawn again after
// the delivery log has pruned rows, then a seeded sample with labelling sheets, and the bar fixed before labelling.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { ReadonlyKysely } from "kysely/readonly";
import { openReader } from "../../src/db.ts";
import type { DB } from "../../src/db-types.ts";
import { head } from "../../src/text.ts";
import { shuffled } from "../post-write/replay.ts";

export type Window = { from: string; to: string };

/** One delivered record: the delivery row's id and the unit's id */
export type DeliveredPair = [number, number];

export type Population = {
  project: string;
  window: Window;
  condition: string;
  extracted_at: string;
  size: number;
  sha256: string;
  pairs: DeliveredPair[];
};

const CONDITION =
  "delivery_unit pairs of the project's delivery rows with outcome emitted and from <= at < to, every event, main and subagent, ordered by at, delivery id, unit id";

/** The delivered pairs of one project in the window, in the order the sample shuffles them from */
export async function extract(
  db: ReadonlyKysely<DB>,
  projectId: number,
  w: Window,
): Promise<DeliveredPair[]> {
  const rows = await db
    .selectFrom("delivery as d")
    .innerJoin("session as s", "s.id", "d.session_id")
    .innerJoin("delivery_unit as du", "du.delivery_id", "d.id")
    .where("s.project_id", "=", projectId)
    .where("d.outcome", "=", "emitted")
    .where("d.at", ">=", w.from)
    .where("d.at", "<", w.to)
    .select(["d.id as delivery", "du.unit_id as unit"])
    .orderBy("d.at")
    .orderBy("d.id")
    .orderBy("du.unit_id")
    .execute();
  return rows.map((r) => [r.delivery, r.unit]);
}

export const digest = (pairs: DeliveredPair[]): string =>
  crypto.createHash("sha256").update(JSON.stringify(pairs)).digest("hex");

/** What differs between the pinned population and one extracted again: empty when they match */
export function differences(pinned: Population, fresh: DeliveredPair[]): string[] {
  const out: string[] = [];
  if (digest(pinned.pairs) !== pinned.sha256)
    out.push(`the pinned pairs do not hash to the pinned sha256 ${pinned.sha256}`);
  const key = (p: DeliveredPair) => `${p[0]}:${p[1]}`;
  const now = new Set(fresh.map(key));
  const then = new Set(pinned.pairs.map(key));
  const gone = pinned.pairs.filter((p) => !now.has(key(p)));
  const added = fresh.filter((p) => !then.has(key(p)));
  if (gone.length)
    out.push(
      `${gone.length} pinned pairs are no longer in the database, first ${key(gone[0] as DeliveredPair)}`,
    );
  if (added.length)
    out.push(
      `${added.length} pairs are in the database but not pinned, first ${key(added[0] as DeliveredPair)}`,
    );
  if (!gone.length && !added.length && digest(fresh) !== pinned.sha256)
    out.push("the same pairs come back in another order");
  return out;
}

/** An argument's date and time in the form the delivery log stores, so comparing the strings compares the instants */
function instant(name: string, value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`--${name} ${value} is not a date and time`);
  return d.toISOString();
}

/** project is the project's key: names are not unique, since the same owner and repository can live on two hosts */
async function pin(file: string, project: string, w: Window, population: string): Promise<void> {
  const db = openReader(file);
  try {
    const p = await db.selectFrom("project").select("id").where("key", "=", project).executeTakeFirst();
    if (!p) throw new Error(`no project with the key ${project} in ${file}`);
    const pairs = await extract(db, p.id, w);
    if (fs.existsSync(population)) {
      const pinned = JSON.parse(fs.readFileSync(population, "utf8")) as Population;
      if (pinned.project !== project || pinned.window.from !== w.from || pinned.window.to !== w.to)
        throw new Error(
          `${population} pins ${pinned.project} from ${pinned.window.from} to ${pinned.window.to}, not this extraction`,
        );
      const diff = differences(pinned, pairs);
      if (diff.length)
        throw new Error(`the database no longer gives the pinned population:\n${diff.join("\n")}`);
      console.log(`${pairs.length} pairs, the same as ${population}`);
      return;
    }
    const out: Population = {
      project,
      window: w,
      condition: CONDITION,
      extracted_at: new Date().toISOString(),
      size: pairs.length,
      sha256: digest(pairs),
      pairs,
    };
    fs.writeFileSync(population, `${JSON.stringify(out)}\n`);
    console.log(`${pairs.length} pairs pinned to ${population}`);
  } finally {
    await db.destroy();
  }
}

export type Drawn = { n: number; delivery: number; unit: number };

/** The first size pairs of the pinned population shuffled with the seed: the sample is fixed before anyone labels it */
export function draw(population: Population, seed: number, size: number): Drawn[] {
  return shuffled(population.pairs, seed)
    .slice(0, size)
    .map(([delivery, unit], i) => ({ n: i + 1, delivery, unit }));
}

/** One line of a conversation the sheet shows: the prompt that opened a turn, a tool call, or a reply */
export type Entry = { at: string; kind: "prompt" | "call" | "reply"; text: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const texts = (content: unknown, type: string) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((c) => isObject(c) && c.type === type && typeof c.text === "string")
          .map((c) => (c as { text: string }).text)
          .join("\n")
      : "";
const callText = (name: unknown, input: unknown) =>
  `${String(name ?? "")} ${typeof input === "string" ? input : JSON.stringify(input ?? {})}`;

/** A Claude Code transcript's prompts (not tool results, meta lines, or compaction summaries), tool calls, and replies */
function claudeLine(d: Record<string, unknown>, at: string): Entry[] {
  const content = isObject(d.message) ? d.message.content : undefined;
  if (d.type === "assistant" && Array.isArray(content))
    return content.flatMap((c): Entry[] =>
      !isObject(c)
        ? []
        : c.type === "tool_use"
          ? [{ at, kind: "call", text: callText(c.name, c.input) }]
          : c.type === "text" && typeof c.text === "string" && c.text.trim()
            ? [{ at, kind: "reply", text: c.text }]
            : [],
    );
  if (d.type !== "user" || d.isMeta === true || d.isCompactSummary === true) return [];
  if (Array.isArray(content) && content.some((c) => isObject(c) && c.type === "tool_result")) return [];
  const text = texts(content, "text");
  return text.trim() ? [{ at, kind: "prompt", text }] : [];
}

/** A Codex session log's user and assistant messages (not the injected context that starts with a tag) and tool calls */
function codexLine(d: Record<string, unknown>, at: string): Entry[] {
  const p = d.payload;
  if (d.type !== "response_item" || !isObject(p)) return [];
  if (p.type === "custom_tool_call") return [{ at, kind: "call", text: callText(p.name, p.input) }];
  if (p.type === "function_call") return [{ at, kind: "call", text: callText(p.name, p.arguments) }];
  if (p.type !== "message") return [];
  if (p.role === "user") {
    const text = texts(p.content, "input_text");
    return text.trim() && !text.trimStart().startsWith("<") ? [{ at, kind: "prompt", text }] : [];
  }
  if (p.role === "assistant") {
    const text = texts(p.content, "output_text");
    return text.trim() ? [{ at, kind: "reply", text }] : [];
  }
  return [];
}

export function readTimeline(file: string, host: string): Entry[] {
  const out: Entry[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let d: unknown;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(d) || typeof d.timestamp !== "string") continue;
    out.push(...(host === "codex" ? codexLine(d, d.timestamp) : claudeLine(d, d.timestamp)));
  }
  return out;
}

/** Where a delivery's conversation is: a Claude Code session or one of its subagents by name, a Codex session by the id its log names */
function locate(
  roots: { claude: string; codex: string },
  host: string,
  external: string,
  agent: string | null,
  codexFiles: () => string[],
): string | null {
  const file =
    host === "codex"
      ? codexFiles().find((f) => path.basename(f).endsWith(`-${external}.jsonl`))
      : agent
        ? path.join(roots.claude, external, "subagents", `agent-${agent}.jsonl`)
        : path.join(roots.claude, `${external}.jsonl`);
  return file && fs.existsSync(file) ? file : null;
}

/** Around a delivery: the prompt that opened its turn, the last lines before it, and what the agent did next until the next prompt */
export function around(
  entries: Entry[],
  at: string,
): { prompt: Entry | null; before: Entry[]; after: Entry[] } {
  const i = entries.findIndex((e) => e.at > at);
  const cut = i < 0 ? entries.length : i;
  const earlier = entries.slice(0, cut);
  const opened = earlier.map((e) => e.kind).lastIndexOf("prompt");
  const next = entries.slice(cut);
  const stop = next.findIndex((e) => e.kind === "prompt");
  return {
    prompt: opened < 0 ? null : (earlier[opened] as Entry),
    before: earlier.slice(Math.max(opened + 1, cut - 3)),
    after: next.slice(0, stop < 0 ? 10 : Math.min(stop, 10)),
  };
}

const indent = (s: string) => s.replaceAll("\n", "\n    ");
const show = (e: Entry) => `  - ${e.at} ${e.kind}: ${indent(head(e.text, e.kind === "reply" ? 600 : 300))}`;

/** The labelling material for one drawn pair: the delivery, the record as delivered, and the conversation around it */
async function sheetEntry(
  db: ReadonlyKysely<DB>,
  d: Drawn,
  roots: { claude: string; codex: string },
  codexFiles: () => string[],
  timelines: Map<string, Entry[]>,
): Promise<string> {
  const row = await db
    .selectFrom("delivery as d")
    .innerJoin("session as s", "s.id", "d.session_id")
    .select(["d.at", "d.event", "d.path", "d.agent_id", "s.host", "s.external_id"])
    .where("d.id", "=", d.delivery)
    .executeTakeFirst();
  const u = await db
    .selectFrom("unit")
    .select(["key", "kind", "stance", "text", "why"])
    .where("id", "=", d.unit)
    .executeTakeFirst();
  if (!row || !u) return `## ${d.n}. delivery ${d.delivery} unit ${d.unit}: not in the database\n`;
  const options = await db
    .selectFrom("unit_option")
    .select(["outcome", "text"])
    .where("unit_id", "=", d.unit)
    .orderBy("id")
    .execute();
  const file = locate(roots, row.host, row.external_id, row.agent_id, codexFiles);
  const lines = [
    `## ${d.n}. ${row.event} ${row.path ?? ""} (${row.host}${row.agent_id ? ` subagent ${row.agent_id}` : ""}, ${row.at})`,
    `delivery ${d.delivery}, unit ${d.unit}: ${u.key} (${u.kind}${u.stance ? ` ${u.stance}` : ""})`,
    `  ${indent(u.text)}`,
    ...(u.why ? [`  why: ${indent(u.why)}`] : []),
    ...options.map((o) => `  - ${o.outcome}: ${o.text}`),
  ];
  if (!file) lines.push("conversation: no transcript found");
  else {
    let t = timelines.get(file);
    if (!t) {
      t = readTimeline(file, row.host);
      timelines.set(file, t);
    }
    const a = around(t, row.at);
    lines.push(
      `conversation: ${file}`,
      "the prompt that opened the turn:",
      a.prompt ? `    ${indent(head(a.prompt.text, 1500))}` : "    (none before the delivery)",
      "just before the delivery:",
      ...a.before.map(show),
      "after the delivery, until the next prompt (at most 10):",
      ...a.after.map(show),
    );
  }
  lines.push("label: useful / irrelevant / unknown", "");
  return lines.join("\n");
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith(".jsonl") ? [p] : [];
  });
}

async function sheet(
  file: string,
  drawn: Drawn[],
  roots: { claude: string; codex: string },
): Promise<string> {
  let files: string[] | null = null;
  const codexFiles = () => {
    files ??= walk(roots.codex);
    return files;
  };
  const timelines = new Map<string, Entry[]>();
  const db = openReader(file);
  try {
    const out: string[] = [];
    for (const d of drawn) out.push(await sheetEntry(db, d, roots, codexFiles, timelines));
    return out.join("\n");
  } finally {
    await db.destroy();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      project: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      population: { type: "string" },
      sample: { type: "boolean" },
      seed: { type: "string" },
      size: { type: "string" },
      out: { type: "string" },
      sheet: { type: "string" },
      claude: { type: "string" },
      codex: { type: "string" },
    },
  });
  const need = (mode: string, keys: (keyof typeof values)[]) => {
    const missing = keys.filter((k) => !values[k]);
    if (missing.length) throw new Error(`${mode} needs ${missing.map((k) => `--${k}`).join(", ")}`);
  };
  if (values.sample) {
    need("--sample", ["population", "seed", "size", "out"]);
    const population = JSON.parse(fs.readFileSync(values.population as string, "utf8")) as Population;
    if (digest(population.pairs) !== population.sha256)
      throw new Error(`${values.population} does not hash to its pinned sha256`);
    const drawn = draw(population, Number(values.seed), Number(values.size));
    const out = {
      population_sha256: population.sha256,
      seed: Number(values.seed),
      size: Number(values.size),
      pairs: drawn,
    };
    fs.writeFileSync(values.out as string, `${JSON.stringify(out, null, 2)}\n`);
    console.log(drawn.map((d) => `${d.n} ${d.delivery}:${d.unit}`).join("\n"));
    return;
  }
  if (values.sheet) {
    need("--sheet", ["db", "claude", "codex", "out"]);
    const drawn = (JSON.parse(fs.readFileSync(values.sheet, "utf8")) as { pairs: Drawn[] }).pairs;
    const text = await sheet(values.db as string, drawn, {
      claude: values.claude as string,
      codex: values.codex as string,
    });
    fs.writeFileSync(values.out as string, text);
    console.log(`${drawn.length} entries written to ${values.out}`);
    return;
  }
  if (values.db) {
    need("--db", ["project", "from", "to", "population"]);
    await pin(
      values.db,
      values.project as string,
      { from: instant("from", values.from as string), to: instant("to", values.to as string) },
      values.population as string,
    );
    return;
  }
  throw new Error(
    "pass --db to pin a population, --sample to draw from it, or --sheet to write labelling sheets",
  );
}

if (process.argv[1] && /sample\.(ts|js)$/.test(process.argv[1])) await main();
