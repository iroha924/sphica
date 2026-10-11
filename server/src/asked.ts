// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Earlier owner messages like the current question, on request: what records cite each one, whether a decision was recorded, and
// the same matter asked across sessions with none. Only direct quotes tie a record to a message; the rest of its turn is context.

import type { Reads } from "./db.ts";
import { framed } from "./frame.ts";
import type { LIFECYCLES, UNIT_KINDS } from "./knowledge.ts";
import { inline } from "./panel.ts";
import { fitCount, keyShown, leftOut, preview, READ_BUDGET } from "./reply-budget.ts";
import { liveSuccessors, type SourceHit, type Successor, searchSources } from "./search.ts";
import { bytes, head } from "./text.ts";

/** Kinds that record a decision the owner made. A candidate is not adopted yet, so it never counts. */
const DECIDED_KINDS = new Set(["decision", "constraint"]);
const DECIDED_LIFECYCLES = new Set(["active", "superseded", "withdrawn"]);
/** Records listed per message, tied and in the same turn each; the rest are counted, so one message cannot fill the result. */
const PER_MESSAGE = 10;

type Tied = { id: number; key: string; kind: string; lifecycle: string; now: Successor[] };
type Context = { id: number; key: string; kind: string; lifecycle: string; speaker: string; role: string };

type Earlier = {
  message: SourceHit;
  led: Tied[];
  /** Direct ties the kind or lifecycle filters left out */
  hidden: number;
  context: Context[];
  /** Every record quoting the message itself, shown or not: none of them is context */
  direct: Set<number>;
  decided: boolean;
  traced: boolean;
  /** The assistant's reply in the same turn, by source id */
  reply: number | null;
};

export type Asked = {
  messages: Earlier[];
  /** Sessions whose matching messages have no recorded decision, when the matter came up in two or more */
  repeats: { untraced: string[]; traced: string[] } | null;
  terms: string[];
  weaker: number;
  stopped: boolean;
  read: number;
};

export async function askedBefore(
  db: Reads,
  projectId: number,
  q: {
    question: string;
    limit: number;
    notSessions: string[];
    kinds?: (typeof UNIT_KINDS)[number][] | undefined;
    lifecycles?: (typeof LIFECYCLES)[number][] | undefined;
  },
): Promise<Asked> {
  // Every match up to the caps, so a matter repeated past the first few sessions is still counted
  const kept = (u: { kind: string; lifecycle: string }) =>
    (!q.kinds?.length || (q.kinds as string[]).includes(u.kind)) &&
    (!q.lifecycles?.length || (q.lifecycles as string[]).includes(u.lifecycle));
  const found = await searchSources(db, projectId, q.question, Number.POSITIVE_INFINITY, {
    notSessions: q.notSessions,
  });
  const ids = found.hits.map((h) => h.id);
  const cited = ids.length ? await citing(db, ids) : [];
  const traced = new Set(
    ids.length
      ? (
          await db.selectFrom("source_processing").select("source_id").where("source_id", "in", ids).execute()
        ).map((r) => r.source_id)
      : [],
  );
  const decided = new Set(
    cited
      .filter((c) => DECIDED_KINDS.has(c.kind) && DECIDED_LIFECYCLES.has(c.lifecycle))
      .map((c) => c.source_id),
  );
  const all: Earlier[] = [];
  for (const m of found.hits) {
    const direct = unique(cited.filter((c) => c.source_id === m.id));
    const shown = direct.filter(kept);
    all.push({
      message: m,
      led: shown.map((u) => ({ ...u, now: [] })),
      hidden: direct.length - shown.length,
      context: [],
      direct: new Set(direct.map((u) => u.id)),
      decided: decided.has(m.id),
      traced: traced.has(m.id),
      reply: null,
    });
  }
  // Successors and the same turn only for the messages shown; the rest count toward repeats alone
  const messages = all.slice(0, q.limit);
  for (const e of messages) {
    for (const u of e.led) if (u.lifecycle === "superseded") u.now = await liveSuccessors(db, u.id);
    await sameTurn(db, e, kept);
  }
  // A session is traced only when a trace looked at every matching message in it
  const sessions = new Map<string, { decided: boolean; traced: boolean }>();
  for (const e of all) {
    const s = e.message.session ?? "";
    const was = sessions.get(s) ?? { decided: false, traced: true };
    sessions.set(s, { decided: was.decided || e.decided, traced: was.traced && e.traced });
  }
  const none = [...sessions.values()].every((s) => !s.decided);
  const repeats =
    sessions.size >= 2 && none
      ? {
          untraced: [...sessions].filter(([, s]) => !s.traced).map(([id]) => id),
          traced: [...sessions].filter(([, s]) => s.traced).map(([id]) => id),
        }
      : null;
  return {
    messages,
    repeats,
    terms: found.terms,
    weaker: found.weaker,
    stopped: found.stopped,
    read: found.read,
  };
}

type Cited = { source_id: number; id: number; key: string; kind: string; lifecycle: string };

/** Supported records whose standing evidence or adoption quotes one of the sources. */
async function citing(db: Reads, sources: number[]): Promise<(Cited & { role: string })[]> {
  const [evidence, adoption] = await Promise.all([
    db
      .selectFrom("unit_evidence as e")
      .innerJoin("unit as u", "u.id", "e.unit_id")
      .where("e.source_id", "in", sources)
      .where("e.retracted_at", "is", null)
      .where("u.extraction", "=", "supported")
      .select(["e.source_id", "e.role", "u.id", "u.key", "u.kind", "u.lifecycle"])
      .orderBy("u.id")
      .execute(),
    db
      .selectFrom("unit_adoption as a")
      .innerJoin("unit as u", "u.id", "a.unit_id")
      .where("a.source_id", "in", sources)
      .where("a.retracted_at", "is", null)
      .where("u.extraction", "=", "supported")
      .select(["a.source_id", "u.id", "u.key", "u.kind", "u.lifecycle"])
      .orderBy("u.id")
      .execute(),
  ]);
  return [...evidence, ...adoption.map((a) => ({ ...a, role: "adoption" }))];
}

const unique = <T extends { id: number }>(xs: T[]): T[] => [...new Map(xs.map((x) => [x.id, x])).values()];

/** Records quoting other words of the same turn, and the assistant's reply there. Context only: they need not answer the message. */
async function sameTurn(
  db: Reads,
  e: Earlier,
  kept: (u: { kind: string; lifecycle: string }) => boolean,
): Promise<void> {
  const { session, turn, id } = e.message;
  if (!session || !turn) return;
  const others = await db
    .selectFrom("source")
    .select(["id", "author_kind"])
    .where("session_id", "=", session)
    .where("turn_id", "=", turn)
    .where("id", "<>", id)
    .orderBy("id")
    .execute();
  // The turn's last assistant message is its answer; earlier ones can be questions it asked the owner
  e.reply = others.findLast((o) => o.author_kind === "assistant")?.id ?? null;
  if (!others.length) return;
  const speaker = new Map(others.map((o) => [o.id, o.author_kind]));
  const seen = new Set<string>();
  for (const c of await citing(
    db,
    others.map((o) => o.id),
  )) {
    const k = `${c.id}\0${c.source_id}\0${c.role}`;
    if (e.direct.has(c.id) || !kept(c) || seen.has(k)) continue;
    seen.add(k);
    e.context.push({
      id: c.id,
      key: c.key,
      kind: c.kind,
      lifecycle: c.lifecycle,
      speaker: speaker.get(c.source_id) ?? "",
      role: c.role,
    });
  }
}

/** Said when neither the caller nor the host named the current session: its own messages may be among the results. */
export const UNKNOWN_SESSION =
  "Current session unknown; results and session counts may include its messages. Pass session to exclude it.";

/** How many live successors a tied record names: one message's part then has a size it cannot pass, and fits a reply alone */
const NOW = 3;

/** How many sessions a list names before it counts the rest: a matter raised in hundreds of sessions is still one line */
const SESSIONS = 20;

/** A key, artifact, or session id from the database as a line shows it: one line, marked when cut. The whole value is one read away */
const shown = (s: string, n = 200) => preview(s, n);

/** What to do about a message no trace looked at. An id too long to show whole is not offered as the command's argument */
const untraced = (session: string): string => {
  const id = shown(session, 100);
  return id === inline(session)
    ? `Not traced yet: run /sphica:trace ${id}.`
    : `Not traced yet: its session id is too long to show whole here (${id} [id cut]); /sphica:trace pending lists the sessions that wait.`;
};

/**
 * How many ids the line of a message left out names, tried in this order: every one, since read on the message itself does not lead to
 * its records, and fewer only when the ids alone would pass the budget
 */
const BRIEF_IDS = [Number.POSITIVE_INFINITY, 1000, 300, 100, 30, PER_MESSAGE];

/** A message left out of the reply, as one line of ids: what it led to stays reachable, record by record, with read */
const brief = (e: Earlier, cap: number): string => {
  const ids = (us: { id: number }[]) =>
    `${us
      .slice(0, cap)
      .map((u) => `u${u.id}`)
      .join(", ")}${us.length > cap ? `, and ${us.length - cap} more` : ""}`;
  return [
    `- s${e.message.id}: ${e.led.length ? `led to ${ids(e.led)}` : "led to no record"}`,
    ...(e.hidden ? [`${e.hidden} tied record${e.hidden === 1 ? "" : "s"} hidden by the filters`] : []),
    ...(e.context.length ? [`same turn ${ids(e.context)}`] : []),
    ...(e.reply !== null ? [`reply s${e.reply}`] : []),
    ...(e.decided ? [] : [`no recorded decision${e.traced ? "" : ", not traced yet"}`]),
  ].join("; ");
};

/**
 * The result as the read MCP server returns it, framed, within READ_BUDGET. Record keys and message text are data from the database, kept
 * on single lines. Messages that do not fit are named by s<id> for read. `known` says whether the current session was left out; if not,
 * nothing is called earlier.
 */
export function askedText(r: Asked, known = true): string {
  const parts = r.messages.map((e) => {
    const m = e.message;
    // The message is kept on one line, so its own words cannot pass for a heading or a verdict
    const lines = [`## s${m.id}: ${shown(m.artifact)}, ${m.created_at}`, preview(m.text, 600)];
    if (e.led.length) {
      lines.push("Led to:");
      for (const u of e.led.slice(0, PER_MESSAGE))
        lines.push(
          `- ${keyShown(u.key, u.id)} (${u.kind}, ${u.lifecycle}${
            u.now.length
              ? `; now ${u.now
                  .slice(0, NOW)
                  .map((n) => `${keyShown(n.key, n.id)} (${n.lifecycle})`)
                  .join(", ")}${u.now.length > NOW ? `, and ${u.now.length - NOW} more` : ""}`
              : ""
          })`,
        );
    }
    if (e.led.length > PER_MESSAGE) lines.push(`and ${e.led.length - PER_MESSAGE} more tied records`);
    if (e.hidden) lines.push(`${e.hidden} tied record${e.hidden === 1 ? "" : "s"} hidden by the filters.`);
    if (!e.decided) lines.push(`No recorded decision.${e.traced ? "" : ` ${untraced(m.session ?? "")}`}`);
    if (e.context.length) {
      lines.push("Same turn (context, not necessarily the answer):");
      for (const c of e.context.slice(0, PER_MESSAGE))
        lines.push(
          `- ${keyShown(c.key, c.id)} (${c.kind}, ${c.lifecycle}): quotes the ${c.speaker} (${c.role})`,
        );
      if (e.context.length > PER_MESSAGE)
        lines.push(`and ${e.context.length - PER_MESSAGE} more in the same turn`);
    }
    if (e.reply !== null) lines.push(`Reply: s${e.reply} (read it with read)`);
    return lines.join("\n");
  });
  const sessions = (ids: string[]) =>
    `${ids
      .slice(0, SESSIONS)
      // An id is what /sphica:trace takes, so one too long to show whole is marked, not passed off as usable
      .map((id) => (shown(id, 100) === inline(id) ? inline(id) : `${shown(id, 100)} [id cut]`))
      .join(", ")}${ids.length > SESSIONS ? `, and ${ids.length - SESSIONS} more` : ""}`;
  const after: string[] = [];
  if (r.repeats) {
    const n = r.repeats.untraced.length + r.repeats.traced.length;
    const within = r.stopped ? ` (within the first ${r.read} candidates by rank)` : "";
    after.push(
      [
        known
          ? `Asked in ${n} sessions with no recorded decision${within}:`
          : `Matching messages in ${n} sessions with no recorded decision (current session may be included)${within}:`,
        ...(r.repeats.untraced.length
          ? [`- not traced yet: ${sessions(r.repeats.untraced)} (run /sphica:trace with each)`]
          : []),
        ...(r.repeats.traced.length ? [`- traced: ${sessions(r.repeats.traced)}`] : []),
      ].join("\n"),
    );
  }
  if (r.stopped) after.push(`Stopped after ${r.read} candidates by rank; more may match.`);
  if (!known) after.push(UNKNOWN_SESSION);
  const lead = `${known ? "Earlier owner" : "Owner"} messages matching: ${head(r.terms.join(", "), 400)}`;
  // What is said about the whole result (the sessions, where the search stopped) is kept; the messages give way. The messages
  // left out are named after the frame's closing line, where only Sphica writes
  const reply = (kept: number, cap: number) => {
    const left = r.messages.slice(kept);
    return [
      framed([lead, ...parts.slice(0, kept), ...after].join("\n\n")),
      leftOut(
        left.map((e) => `s${e.message.id}`),
        "messages",
      ),
      // Only ids and counts, so nothing a record or a message says is outside the frame
      ...(left.length
        ? ["What each of them led to (read a record by its u<id>):", ...left.map((e) => brief(e, cap))]
        : []),
    ]
      .filter(Boolean)
      .join("\n");
  };
  // Reaching every record comes first: the cap is the largest with which the reply fits when no message is shown in full, and the
  // messages shown in full take the room that leaves
  const cap = BRIEF_IDS.find((c) => bytes(reply(0, c)) <= READ_BUDGET) ?? PER_MESSAGE;
  return reply(
    fitCount(parts, READ_BUDGET, (n) => reply(n, cap)),
    cap,
  );
}
