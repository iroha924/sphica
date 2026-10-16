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
/** A notice is a user line the host wrote, not the owner: a background task's notification or a subagent's report */
export type Entry = { at: string; kind: "prompt" | "notice" | "call" | "reply"; text: string };

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

/** A Claude Code transcript's prompts and notices (not tool results, meta lines, or compaction summaries), tool calls, and replies */
function claudeLine(d: Record<string, unknown>, at: string): (Entry & { unmarked?: true })[] {
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
  const origin = isObject(d.origin) ? d.origin.kind : undefined;
  if (!text.trim()) return [];
  // A user line with no origin waits for the next message line: only one the model answers is a prompt
  return origin === undefined
    ? [{ at, kind: "notice", text, unmarked: true }]
    : [{ at, kind: origin === "human" ? "prompt" : "notice", text }];
}

/** How the context Codex adds as a user message starts in its session logs (tags, and AGENTS.md's text); a request of the user's may start with a tag */
const INJECTED =
  /^\s*(<(environment_context|skill|external_codex_apps_open_page|user_instructions)>|# AGENTS\.md instructions\b)/;

/** A Codex session log's user and assistant messages (not the context Codex injects) and tool calls */
function codexLine(d: Record<string, unknown>, at: string): Entry[] {
  const p = d.payload;
  if (d.type !== "response_item" || !isObject(p)) return [];
  if (p.type === "custom_tool_call") return [{ at, kind: "call", text: callText(p.name, p.input) }];
  if (p.type === "function_call") return [{ at, kind: "call", text: callText(p.name, p.arguments) }];
  if (p.type !== "message") return [];
  if (p.role === "user") {
    const text = texts(p.content, "input_text");
    return text.trim() && !INJECTED.test(text) ? [{ at, kind: "prompt", text }] : [];
  }
  if (p.role === "assistant") {
    const text = texts(p.content, "output_text");
    return text.trim() ? [{ at, kind: "reply", text }] : [];
  }
  return [];
}

export function readTimeline(file: string, host: string): Entry[] {
  const out: Entry[] = [];
  /** Where in out the Claude Code user lines with no origin are that no message line has followed yet */
  let waiting: number[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let d: unknown;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(d)) continue;
    // The model answers only a prompt, not a local command's output or an interruption marker; a meta line (a Skill's text) sits between
    // a prompt and its answer, and a line without a time still counts
    if (
      host !== "codex" &&
      (d.type === "user" || d.type === "assistant") &&
      d.isMeta !== true &&
      d.isCompactSummary !== true
    ) {
      for (const i of waiting) (out[i] as Entry).kind = d.type === "assistant" ? "prompt" : "notice";
      waiting = [];
    }
    if (typeof d.timestamp !== "string") continue;
    const lines: (Entry & { unmarked?: true })[] =
      host === "codex" ? codexLine(d, d.timestamp) : claudeLine(d, d.timestamp);
    for (const { unmarked, ...e } of lines) {
      if (unmarked) waiting.push(out.length);
      out.push(e);
    }
  }
  for (const i of waiting) (out[i] as Entry).kind = "notice";
  return out;
}

/** Where a delivery's conversation is: a Claude Code session or one of its subagents by name, a Codex thread (a child's own) by the id its log names */
function locate(
  roots: { claude: string; codex: string },
  host: string,
  external: string,
  agent: string | null,
  codexFiles: () => string[],
): string | null {
  const file =
    host === "codex"
      ? codexFiles().find((f) => path.basename(f).endsWith(`-${agent ?? external}.jsonl`))
      : agent
        ? path.join(roots.claude, external, "subagents", `agent-${agent}.jsonl`)
        : path.join(roots.claude, `${external}.jsonl`);
  return file && fs.existsSync(file) ? file : null;
}

/** Lines of the turn after a delivery the sheet shows from its start and from its end; what lies between is counted */
const HEAD = 20;
const TAIL = 10;

/** Around a delivery: the prompt that opened its turn, the last lines before it, and what the agent did next until the next prompt */
export function around(
  entries: Entry[],
  at: string,
): {
  prompt: Entry | null;
  opensAfter: boolean;
  before: Entry[];
  after: Entry[];
  more: number;
  tail: Entry[];
} {
  const i = entries.findIndex((e) => e.at > at);
  const cut = i < 0 ? entries.length : i;
  const earlier = entries.slice(0, cut);
  const opened = earlier.map((e) => e.kind).lastIndexOf("prompt");
  const next = entries.slice(cut);
  // A delivery before any prompt (a session's start) bears on the first turn, so that turn is shown instead
  const first = opened < 0 ? next.findIndex((e) => e.kind === "prompt") : -1;
  const rest = first < 0 ? next : next.slice(first + 1);
  const stop = rest.findIndex((e) => e.kind === "prompt");
  const turn = stop < 0 ? rest : rest.slice(0, stop);
  return {
    prompt: opened >= 0 ? (earlier[opened] as Entry) : first >= 0 ? (next[first] as Entry) : null,
    opensAfter: first >= 0,
    before: earlier.slice(Math.max(opened + 1, cut - 3)),
    after: turn.length > HEAD + TAIL ? turn.slice(0, HEAD) : turn,
    more: Math.max(turn.length - HEAD - TAIL, 0),
    tail: turn.length > HEAD + TAIL ? turn.slice(-TAIL) : [],
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
      a.opensAfter ? "the first prompt, which came after the delivery:" : "the prompt that opened the turn:",
      a.prompt ? `    ${indent(head(a.prompt.text, 1500))}` : "    (none before the delivery)",
      "just before the delivery:",
      ...a.before.map(show),
      a.opensAfter ? "that turn, until the next prompt:" : "after the delivery, until the next prompt:",
      ...a.after.map(show),
      ...(a.more ? [`  … ${a.more} lines left out`] : []),
      ...a.tail.map(show),
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

const LABELS = ["useful", "irrelevant", "unknown"] as const;
const CLASSES = ["finished-plan", "open-plan", "plan-unknown", "standing", "other"] as const;

export type Labelled = { n: number; settled: (typeof LABELS)[number]; class: (typeof CLASSES)[number] };

export type Decision = {
  n: number;
  F: number;
  I: number;
  U: number;
  R: number;
  verdict: "too few" | "go" | "not adopted" | "undecided";
  classes: Record<(typeof CLASSES)[number], Record<(typeof LABELS)[number], number>>;
};

/**
 * The bar fixed before labelling, over the finished-plan pairs (I irrelevant, U unknown, R useful, F all of them): go only if every way the
 * unknowns resolve still passes (5I >= 4F and R + U <= 1), not adopted if none does, undecided otherwise. Fewer than 8 decide nothing.
 */
export function decide(labels: Labelled[]): Decision {
  labels.forEach((l, i) => {
    if (l.n !== i + 1)
      throw new Error(`labels must run 1, 2, 3, … without gaps or repeats; found ${l.n} at ${i + 1}`);
    if (!LABELS.includes(l.settled))
      throw new Error(`label ${l.n}: ${l.settled} is not ${LABELS.join(", ")}`);
    if (!CLASSES.includes(l.class))
      throw new Error(`label ${l.n}: class ${l.class} is not ${CLASSES.join(", ")}`);
  });
  const classes = Object.fromEntries(
    CLASSES.map((c) => [
      c,
      Object.fromEntries(
        LABELS.map((k) => [k, labels.filter((l) => l.class === c && l.settled === k).length]),
      ),
    ]),
  ) as Decision["classes"];
  const f = classes["finished-plan"];
  const [I, U, R] = [f.irrelevant, f.unknown, f.useful];
  const F = I + U + R;
  const verdict =
    F < 8
      ? "too few"
      : 5 * I >= 4 * F && R + U <= 1
        ? "go"
        : 5 * (I + U) < 4 * F || R >= 2
          ? "not adopted"
          : "undecided";
  return { n: labels.length, F, I, U, R, verdict, classes };
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
      decide: { type: "string" },
    },
  });
  const need = (mode: string, keys: (keyof typeof values)[]) => {
    const missing = keys.filter((k) => !values[k]);
    if (missing.length) throw new Error(`${mode} needs ${missing.map((k) => `--${k}`).join(", ")}`);
  };
  if (values.decide) {
    const labels = (JSON.parse(fs.readFileSync(values.decide, "utf8")) as { labels: Labelled[] }).labels;
    console.log(JSON.stringify(decide(labels), null, 2));
    return;
  }
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
    "pass --db to pin a population, --sample to draw from it, --sheet to write labelling sheets, or --decide to apply the bar",
  );
}

if (process.argv[1] && /sample\.(ts|js)$/.test(process.argv[1])) await main();
