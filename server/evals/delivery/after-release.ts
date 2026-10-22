// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Recipients are read as agent-runs.ts reads them, from the delivery row and the Codex session log: no log tells a claude -p run that was
// not held from a person's Claude Code session, so such a run counts as interactive.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { openReader } from "../../src/db.ts";
import { type Recipient, recipientOf, STOPS } from "./agent-runs.ts";
import { directory, type Window, walk, window } from "./sample.ts";

/** One conversation (a session's main conversation, or one subagent or child thread) and its delivery rows in a window */
export type Conversation = {
  recipient: Recipient;
  /** Its start was held back, in the window or before it, so a person does not run it */
  heldRun?: boolean;
  rows: { event: string; outcome: string; reason: string | null; units: number }[];
};

export type Summary = {
  conversations: Partial<Record<Recipient, number>>;
  pairs: { total: number } & Partial<Record<Recipient, number>>;
  /** Starts held back, by recipient */
  held: Partial<Record<Recipient, number>>;
  /** Codex exec or log-less runs that still got their start or a read other than a dead-end stop */
  not_held: { conversations: number; pairs: number };
  subagent_starts: { total: number; with_records: number; pairs: number };
  /** Claude Code main sessions with no held start, and Codex terminal sessions */
  interactive: { conversations: number; pairs: number; per_conversation: number | null };
};

const AGENT_RUNS = new Set<Recipient>(["codex-exec", "codex-no-log"]);
const SUBAGENTS = new Set<Recipient>(["claude-subagent", "codex-child"]);

const pairsOf = (rows: Conversation["rows"]) =>
  rows.reduce((n, r) => n + (r.outcome === "emitted" ? r.units : 0), 0);

const bump = <K extends string>(m: Partial<Record<K, number>>, k: K, by = 1) => {
  m[k] = (m[k] ?? 0) + by;
};

export function summarize(conversations: Conversation[]): Summary {
  const s: Summary = {
    conversations: {},
    pairs: { total: 0 },
    held: {},
    not_held: { conversations: 0, pairs: 0 },
    subagent_starts: { total: 0, with_records: 0, pairs: 0 },
    interactive: { conversations: 0, pairs: 0, per_conversation: null },
  };
  for (const c of conversations) {
    const pairs = pairsOf(c.rows);
    bump(s.conversations, c.recipient);
    bump(s.pairs, c.recipient, pairs);
    s.pairs.total += pairs;
    const starts = c.rows.filter((r) => r.event === "session_start");
    const held = starts.filter((r) => r.outcome === "suppressed").length;
    if (held) bump(s.held, c.recipient, held);
    if (AGENT_RUNS.has(c.recipient)) {
      // A start that showed only current work or a trace notice is logged as emitted with no units: the run still got its start
      const missed = c.rows.filter(
        (r) =>
          r.outcome === "emitted" &&
          (r.event === "session_start" || (r.event === "pre_read" && !STOPS.has(r.reason ?? ""))),
      );
      if (missed.length) {
        s.not_held.conversations++;
        s.not_held.pairs += pairsOf(missed);
      }
    }
    if (SUBAGENTS.has(c.recipient))
      for (const r of starts) {
        s.subagent_starts.total++;
        const carried = pairsOf([r]);
        if (carried) {
          s.subagent_starts.with_records++;
          s.subagent_starts.pairs += carried;
        }
      }
    if ((c.recipient === "claude-main" && !held && !c.heldRun) || c.recipient === "codex-tui") {
      s.interactive.conversations++;
      s.interactive.pairs += pairs;
    }
  }
  if (s.interactive.conversations)
    s.interactive.per_conversation =
      Math.round((s.interactive.pairs / s.interactive.conversations) * 100) / 100;
  return s;
}

async function conversations(
  file: string,
  project: string,
  w: Window,
  codexLog: (thread: string) => string | null,
): Promise<Conversation[]> {
  const db = openReader(file);
  try {
    const p = await db.selectFrom("project").select("id").where("key", "=", project).executeTakeFirst();
    if (!p) throw new Error(`no project with the key ${project} in ${file}`);
    const rows = await db
      .selectFrom("delivery as d")
      .innerJoin("session as s", "s.id", "d.session_id")
      .leftJoin("delivery_unit as du", "du.delivery_id", "d.id")
      .where("s.project_id", "=", p.id)
      .where("d.at", ">=", w.from)
      .where("d.at", "<", w.to)
      .groupBy("d.id")
      .select((eb) => [
        "d.session_id",
        "d.agent_id",
        "d.event",
        "d.outcome",
        "d.reason",
        "s.host",
        "s.external_id",
        eb.fn.count<number>("du.unit_id").as("units"),
      ])
      .orderBy("d.at")
      .orderBy("d.id")
      .execute();
    // A run's start can fall before the window while its edits fall inside it
    const heldRuns = new Set(
      (
        await db
          .selectFrom("delivery as d")
          .innerJoin("session as s", "s.id", "d.session_id")
          .where("s.project_id", "=", p.id)
          .where("d.event", "=", "session_start")
          .where("d.outcome", "=", "suppressed")
          .where("d.agent_id", "is", null)
          .where("d.at", "<", w.to)
          .select("d.session_id")
          .distinct()
          .execute()
      ).map((r) => r.session_id),
    );
    const byKey = new Map<string, Conversation>();
    for (const r of rows) {
      // A subagent's start the host sent without its agent id belongs to no conversation it can be told from, so it stands alone
      const alone = !r.agent_id && r.event === "session_start" && r.reason === "subagent";
      const key = alone ? `start:${byKey.size}` : `${r.session_id}\0${r.agent_id ?? ""}`;
      let c = byKey.get(key);
      if (!c) {
        c = {
          recipient: recipientOf(r, codexLog),
          heldRun: !alone && !r.agent_id && heldRuns.has(r.session_id),
          rows: [],
        };
        byKey.set(key, c);
      }
      c.rows.push({ event: r.event, outcome: r.outcome, reason: r.reason, units: Number(r.units) });
    }
    return [...byKey.values()];
  } finally {
    await db.destroy();
  }
}

const NOTE =
  "Counts per window of what the #353 change did: held starts by recipient, Codex exec or log-less runs that still got their start or a read other than a dead-end stop (not_held), subagent and child-thread starts that still carried records, and pairs per interactive session. Recipients come from the delivery row and the Codex session log, as in agent-runs.ts: no log tells a claude -p run from a person's Claude Code session, so one that was not held counts as interactive, and a window before the release counts what the change would have held as not_held.";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      project: { type: "string" },
      codex: { type: "string" },
      window: { type: "string", multiple: true },
      out: { type: "string" },
    },
  });
  const missing = (["db", "project", "codex", "window", "out"] as const).filter((k) => !values[k]);
  if (missing.length) throw new Error(`pass ${missing.map((k) => `--${k}`).join(", ")}`);
  if (path.resolve(values.out as string) === path.resolve(values.db as string))
    throw new Error("--out is the database --db reads; write the output elsewhere");
  const windows = (values.window as string[]).map((v) => {
    const [from, to, ...rest] = v.split("/");
    if (!from || !to || rest.length) throw new Error(`--window ${v} is not from/to`);
    return window(from, to);
  });
  // A missing log directory would count every Codex session as log-less
  const logs = walk(directory("codex", values.codex as string));
  const codexLog = (thread: string) =>
    logs.find((f) => path.basename(f).endsWith(`-${thread}.jsonl`)) ?? null;
  const out = {
    note: NOTE,
    project: values.project,
    extracted_at: new Date().toISOString(),
    windows: [] as { window: Window; summary: Summary }[],
  };
  for (const w of windows) {
    const summary = summarize(
      await conversations(values.db as string, values.project as string, w, codexLog),
    );
    out.windows.push({ window: w, summary });
    console.log(`${w.from} .. ${w.to}: ${JSON.stringify(summary)}`);
  }
  fs.writeFileSync(values.out as string, `${JSON.stringify(out, null, 2)}\n`);
}

if (process.argv[1] && /after-release\.(ts|js)$/.test(process.argv[1])) await main();
