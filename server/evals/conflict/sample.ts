// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The offline conflict evaluation's population, pinned by seed before any prompt is written: deliverable dont decisions and rejected
// options split by record into tune and held-out, and the owner's prompts of a window split by session. The public file holds ids and
// hashes only; the drawn texts and the key of their hashes stay in private files beside the database copy.
import crypto from "node:crypto";
import fs from "node:fs";
import { parseArgs } from "node:util";
import type { Reads } from "../../src/db.ts";
import { openReader } from "../../src/db.ts";
import { deliverableIds } from "../../src/deliver.ts";
import { projectId } from "../../src/project.ts";
import { shuffled } from "../post-write/replay.ts";
import { digest } from "./measure.ts";

type Side = "tune" | "held_out";
type Targets = { dont: number[]; rejected: [number, number][] };
type Window = { from: string; to: string };

export type Population = {
  issue: number;
  taken_at: string;
  db_sha256: string;
  project: string;
  seed: number;
  per_split: { dont: number; rejected: number; ordinary: number };
  records: {
    deliverable: number;
    dont: number[];
    /** [unit id, option id] of every rejected option of a deliverable record */
    rejected: [number, number][];
    sha256: string;
    split: Record<Side, number[]>;
    targets: Record<Side, Targets>;
  };
  ordinary: {
    window: Window;
    found: number;
    excluded: { ask_answer: number; injected: number };
    sessions: string[];
    /** [source id, index into sessions] of every prompt left after the exclusions */
    eligible: [number, number][];
    sha256: string;
    /** Indexes into sessions */
    split: Record<Side, number[]>;
    /** [source id, keyed hash of its text] */
    drawn: Record<Side, [number, string][]>;
  };
  /** Sessions that wrote or labelled this evaluation, which other measurements of real use can leave out */
  eval_sessions: { host: "claude-code" | "codex"; external: string; id: string; from: string }[];
};

const SIDES: Side[] = ["tune", "held_out"];
const byNumber = (a: number, b: number) => a - b;
/** HMAC-SHA256 of a prompt's text under the private key */
export const textMac = (key: string, text: string): string =>
  crypto.createHmac("sha256", Buffer.from(key, "hex")).update(text).digest("hex");

/** The private key of the prompt hashes: 64 hex digits in a file kept beside the private texts */
export function readKey(file: string): string {
  const key = fs.readFileSync(file, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error(`${file} does not hold a key of 64 hex digits`);
  return key;
}

/** The deliverable dont decisions and every rejected option of a deliverable record */
export async function extractRecords(
  db: Reads,
  project: number,
): Promise<{ deliverable: number; dont: number[]; rejected: [number, number][] }> {
  const ids = [...(await deliverableIds(db, project))];
  if (!ids.length) return { deliverable: 0, dont: [], rejected: [] };
  const [dont, rejected] = await Promise.all([
    db
      .selectFrom("unit")
      .select("id")
      .where("id", "in", ids)
      .where("kind", "=", "decision")
      .where("stance", "=", "dont")
      .orderBy("id")
      .execute(),
    db
      .selectFrom("unit_option")
      .select(["unit_id", "id"])
      .where("unit_id", "in", ids)
      .where("outcome", "=", "rejected")
      .orderBy("unit_id")
      .orderBy("id")
      .execute(),
  ]);
  return {
    deliverable: ids.length,
    dont: dont.map((r) => r.id),
    rejected: rejected.map((r): [number, number] => [r.unit_id, r.id]),
  };
}

// The shapes the hosts add as a user message, as capture and the delivery sample drop them: a prompt captured before capture knew a shape
// may still hold one
const INJECTED =
  /^\s*(<(environment_context|skill|external_codex_apps_open_page|user_instructions|task-notification|channel|cross-session-message|teammate-message|agent-message|slack-ping|slack-tag-message|fetched-web-content|remote-review|remote-review-progress)[\s>]|# AGENTS\.md instructions\b|\d+ background agents were stopped by the user:|Background agent ".*" was stopped by the user\.|(Another Claude|A peer) session sent a message( while you were working)?:)/;

/** The owner's messages of the window on both hosts, without AskUserQuestion answers and injected text, in the order they were said */
export async function extractOrdinary(
  db: Reads,
  project: number,
  w: Window,
): Promise<{
  found: number;
  excluded: { ask_answer: number; injected: number };
  rows: { id: number; session: string; text: string }[];
}> {
  const all = await db
    .selectFrom("source")
    .select(["id", "session_id", "external_id", "text"])
    .where("project_id", "=", project)
    .where("kind", "=", "session_message")
    .where("author_kind", "=", "owner")
    .where("created_at", ">=", w.from)
    .where("created_at", "<", w.to)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  // Capture keys an answer by its turn and tool call (turn:ask:call:hash) and a prompt by its turn (turn:owner:hash)
  const ask = all.filter((r) => r.external_id.includes(":ask:"));
  const rest = all.filter((r) => !r.external_id.includes(":ask:"));
  const injected = rest.filter((r) => INJECTED.test(r.text ?? ""));
  return {
    found: all.length,
    excluded: { ask_answer: ask.length, injected: injected.length },
    rows: rest
      .filter((r) => !INJECTED.test(r.text ?? ""))
      .map((r) => ({ id: r.id, session: r.session_id ?? "", text: r.text ?? "" })),
  };
}

/**
 * Splits the pool by record, dont decisions and the other records with a rejected option each in alternate halves of a seeded order, and
 * draws each side's targets: dont decisions first, then rejected options of records not already a target there.
 */
export function splitRecords(
  seed: number,
  dont: number[],
  rejected: [number, number][],
  per: { dont: number; rejected: number },
): { split: Record<Side, number[]>; targets: Record<Side, Targets> } {
  const dontSet = new Set(dont);
  const others = [...new Set(rejected.map(([u]) => u))].filter((u) => !dontSet.has(u)).sort(byNumber);
  const halves = (ids: number[], s: number) => {
    const order = shuffled([...ids].sort(byNumber), s);
    return { tune: order.filter((_, i) => i % 2 === 0), held_out: order.filter((_, i) => i % 2 === 1) };
  };
  const d = halves(dont, seed);
  const o = halves(others, seed + 1);
  const split = {
    tune: [...d.tune, ...o.tune].sort(byNumber),
    held_out: [...d.held_out, ...o.held_out].sort(byNumber),
  };
  const targets = {} as Record<Side, Targets>;
  for (const [n, side] of SIDES.entries()) {
    const dontTargets = d[side].slice(0, per.dont);
    if (dontTargets.length < per.dont)
      throw new Error(`${side} has ${dontTargets.length} dont decisions, short of ${per.dont}`);
    const taken = new Set(dontTargets);
    const here = new Set(split[side]);
    const units = shuffled(
      [...new Set(rejected.map(([u]) => u))].filter((u) => here.has(u) && !taken.has(u)).sort(byNumber),
      seed + 2 + n,
    ).slice(0, per.rejected);
    if (units.length < per.rejected)
      throw new Error(
        `${side} has ${units.length} records with a rejected option left, short of ${per.rejected}`,
      );
    targets[side] = {
      dont: dontTargets,
      rejected: units.map((u): [number, number] => {
        const option = shuffled(
          rejected.filter(([x]) => x === u).map(([, id]) => id),
          seed + u,
        )[0];
        return [u, option as number];
      }),
    };
  }
  return { split, targets };
}

/**
 * Splits the sessions in a seeded order, each to the side with fewer prompts so far, then draws each side's prompts by seed: prompts of
 * one session never land on both sides.
 */
function splitOrdinary(
  seed: number,
  eligible: [number, number][],
  sessions: number,
  per: number,
): { split: Record<Side, number[]>; drawn: Record<Side, number[]> } {
  const count = new Map<number, number>();
  for (const [, s] of eligible) count.set(s, (count.get(s) ?? 0) + 1);
  const split: Record<Side, number[]> = { tune: [], held_out: [] };
  const size = { tune: 0, held_out: 0 };
  for (const s of shuffled(
    Array.from({ length: sessions }, (_, i) => i),
    seed + 3,
  )) {
    const side = size.tune <= size.held_out ? "tune" : "held_out";
    split[side].push(s);
    size[side] += count.get(s) ?? 0;
  }
  const drawn = {} as Record<Side, number[]>;
  for (const [n, side] of SIDES.entries()) {
    split[side].sort(byNumber);
    const mine = new Set(split[side]);
    const pick = shuffled(
      eligible
        .filter(([, s]) => mine.has(s))
        .map(([id]) => id)
        .sort(byNumber),
      seed + 4 + n,
    ).slice(0, per);
    if (pick.length < per) throw new Error(`${side} has ${pick.length} ordinary prompts, short of ${per}`);
    drawn[side] = pick;
  }
  return { split, drawn };
}

const HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PROJECT = /^git:[A-Za-z0-9._/-]+$/;
const KEYS = new Set([
  ...[
    "issue",
    "taken_at",
    "db_sha256",
    "project",
    "seed",
    "per_split",
    "records",
    "ordinary",
    "eval_sessions",
  ],
  ...["dont", "rejected", "deliverable", "sha256", "split", "targets", "tune", "held_out"],
  ...["window", "from", "to", "found", "excluded", "ask_answer", "injected", "sessions", "eligible", "drawn"],
  ...["host", "external", "id"],
]);

/** Every way the file is not what its own lists, seed, and hashes say, or holds something other than ids, hashes, and times */
export function checkPopulation(v: unknown): string[] {
  const out: string[] = [];
  const walk = (x: unknown, at: string): void => {
    if (Array.isArray(x)) for (const [i, y] of x.entries()) walk(y, `${at}[${i}]`);
    else if (typeof x === "object" && x !== null)
      for (const [k, y] of Object.entries(x)) {
        if (!KEYS.has(k)) out.push(`${at}.${k}: a key outside the allowlist`);
        walk(y, `${at}.${k}`);
      }
    else if (typeof x === "string") {
      if (![HEX, UUID, TIME, PROJECT].some((re) => re.test(x)) && x !== "claude-code" && x !== "codex")
        out.push(`${at}: a string that is not an id, hash, or time`);
    } else if (typeof x !== "number") out.push(`${at}: not a number or string`);
  };
  walk(v, "population");
  if (out.length) return out;
  const p = v as Population;
  const r = p.records;
  if (digest({ dont: r.dont, rejected: r.rejected }) !== r.sha256)
    out.push("records do not hash to records.sha256");
  try {
    const again = splitRecords(p.seed, r.dont, r.rejected, p.per_split);
    if (JSON.stringify(again.split) !== JSON.stringify(r.split))
      out.push("records.split is not what the seed gives");
    if (JSON.stringify(again.targets) !== JSON.stringify(r.targets))
      out.push("records.targets are not what the seed gives");
  } catch (e) {
    out.push(`records: ${(e as Error).message}`);
  }
  const o = p.ordinary;
  if (digest(o.eligible) !== o.sha256) out.push("ordinary.eligible does not hash to ordinary.sha256");
  if (o.found !== o.eligible.length + o.excluded.ask_answer + o.excluded.injected)
    out.push("ordinary.found is not the eligible prompts plus the excluded ones");
  if (o.eligible.some(([, s]) => s < 0 || s >= o.sessions.length))
    out.push("ordinary.eligible names a session not listed");
  try {
    const again = splitOrdinary(p.seed, o.eligible, o.sessions.length, p.per_split.ordinary);
    if (JSON.stringify(again.split) !== JSON.stringify(o.split))
      out.push("ordinary.split is not what the seed gives");
    for (const side of SIDES)
      if (JSON.stringify(again.drawn[side]) !== JSON.stringify(o.drawn[side].map(([id]) => id)))
        out.push(`ordinary.drawn.${side} is not what the seed gives`);
  } catch (e) {
    out.push(`ordinary: ${(e as Error).message}`);
  }
  return out;
}

/** The population of one project in a database, and the drawn ordinary prompts with their text for the private file */
export async function build(
  db: Reads,
  o: {
    project: string;
    seed: number;
    window: Window;
    per: Population["per_split"];
    /** host:external id of each session that worked on this evaluation */
    evals: string[];
    takenAt: string;
    dbSha256: string;
    key: string;
  },
): Promise<{ population: Population; drawn: { id: number; split: Side; mac: string; text: string }[] }> {
  const project = await projectId(db, o.project);
  if (project === null) throw new Error(`no project ${o.project}`);
  const records = await extractRecords(db, project);
  const found = await extractOrdinary(db, project, o.window);
  const sessions = [...new Set(found.rows.map((r) => r.session))].sort();
  const at = new Map(sessions.map((s, i) => [s, i]));
  const eligible = found.rows.map((r): [number, number] => [r.id, at.get(r.session) ?? -1]);
  const ordinary = splitOrdinary(o.seed, eligible, sessions.length, o.per.ordinary);
  const text = new Map(found.rows.map((r) => [r.id, r.text]));
  const evalSessions: Population["eval_sessions"] = [];
  for (const e of o.evals) {
    const [host, external = ""] = e.split(":");
    if (host !== "claude-code" && host !== "codex")
      throw new Error(`${e}: the host must be claude-code or codex`);
    const row = await db
      .selectFrom("session")
      .select(["id", "started_at"])
      .where("project_id", "=", project)
      .where("host", "=", host)
      .where("external_id", "=", external)
      .executeTakeFirst();
    if (!row) throw new Error(`no session ${e}`);
    evalSessions.push({ host, external, id: row.id, from: row.started_at });
  }
  const drawn = SIDES.flatMap((side) =>
    ordinary.drawn[side].map((id) => ({
      id,
      split: side,
      mac: textMac(o.key, text.get(id) ?? ""),
      text: text.get(id) ?? "",
    })),
  );
  const population: Population = {
    issue: 260,
    taken_at: o.takenAt,
    db_sha256: o.dbSha256,
    project: o.project,
    seed: o.seed,
    per_split: o.per,
    records: {
      ...records,
      sha256: digest({ dont: records.dont, rejected: records.rejected }),
      ...splitRecords(o.seed, records.dont, records.rejected, o.per),
    },
    ordinary: {
      window: o.window,
      found: found.found,
      excluded: found.excluded,
      sessions,
      eligible,
      sha256: digest(eligible),
      split: ordinary.split,
      drawn: {
        tune: drawn.filter((d) => d.split === "tune").map((d): [number, string] => [d.id, d.mac]),
        held_out: drawn.filter((d) => d.split === "held_out").map((d): [number, string] => [d.id, d.mac]),
      },
    },
    eval_sessions: evalSessions,
  };
  const problems = checkPopulation(population);
  if (problems.length) throw new Error(problems.join("\n"));
  return { population, drawn };
}

export const fileSha = (file: string) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      check: { type: "string" },
      db: { type: "string" },
      project: { type: "string" },
      seed: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      eval: { type: "string", multiple: true },
      out: { type: "string" },
      private: { type: "string" },
      key: { type: "string" },
    },
  });
  if (values.check) {
    const problems = checkPopulation(JSON.parse(fs.readFileSync(values.check, "utf8")));
    if (problems.length) {
      for (const p of problems) console.error(p);
      process.exitCode = 1;
      return;
    }
    const p = JSON.parse(fs.readFileSync(values.check, "utf8")) as Population;
    const n = (side: Side) =>
      `${side}: ${p.records.split[side].length} records, targets ${p.records.targets[side].dont.length} dont + ${p.records.targets[side].rejected.length} rejected, ${p.ordinary.drawn[side].length} ordinary prompts`;
    console.log(
      `${values.check}: as its seed ${p.seed} and hashes say; ${p.records.deliverable} deliverable, ${p.records.dont.length} dont, ${p.records.rejected.length} rejected options; ${p.ordinary.found} owner messages, ${p.ordinary.excluded.ask_answer} answers and ${p.ordinary.excluded.injected} injected left out; ${n("tune")}; ${n("held_out")}; ${p.eval_sessions.length} eval sessions`,
    );
    return;
  }
  const need = ["db", "project", "seed", "from", "to", "out", "private", "key"] as const;
  const missing = need.filter((k) => !values[k]);
  if (missing.length) throw new Error(`needs ${missing.map((k) => `--${k}`).join(", ")}`);
  const seed = Number(values.seed);
  if (!Number.isSafeInteger(seed)) throw new Error(`--seed ${values.seed} is not a whole number`);
  const file = values.db as string;
  const key = readKey(values.key as string);
  const db = openReader(file);
  try {
    const { population, drawn } = await build(db, {
      project: values.project as string,
      seed,
      window: {
        from: new Date(values.from as string).toISOString(),
        to: new Date(values.to as string).toISOString(),
      },
      per: { dont: 15, rejected: 15, ordinary: 200 },
      evals: values.eval ?? [],
      takenAt: fs.statSync(file).mtime.toISOString(),
      dbSha256: fileSha(file),
      key,
    });
    fs.writeFileSync(values.out as string, `${JSON.stringify(population, null, 2)}\n`);
    fs.writeFileSync(values.private as string, `${JSON.stringify({ ordinary: drawn }, null, 2)}\n`);
    console.log(`${values.out}: written; ${drawn.length} ordinary prompts' text in ${values.private}`);
  } finally {
    await db.destroy();
  }
}

if (process.argv[1] && /sample\.(ts|js)$/.test(process.argv[1])) await main();
