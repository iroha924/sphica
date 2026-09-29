// Earlier owner messages like the current question, on request: what records cite each one, whether a decision was recorded, and
// the same matter asked across sessions with none. Only direct quotes tie a record to a message; the rest of its turn is context.
import type { Kysely } from "kysely";
import type { DB } from "./db-types.ts";
import type { LIFECYCLES, UNIT_KINDS } from "./knowledge.ts";
import { inline } from "./panel.ts";
import { liveSuccessors, type SourceHit, type Successor, searchSources } from "./search.ts";
import { head } from "./text.ts";

/** Kinds that record a decision the owner made. A candidate is not adopted yet, so it never counts. */
const DECIDED_KINDS = new Set(["decision", "constraint"]);
const DECIDED_LIFECYCLES = new Set(["active", "superseded", "withdrawn"]);

type Tied = { id: number; key: string; kind: string; lifecycle: string; now: Successor[] };
type Context = { key: string; kind: string; lifecycle: string; speaker: string; role: string };

type Earlier = {
  message: SourceHit;
  led: Tied[];
  /** Direct ties the kind or lifecycle filters left out */
  hidden: number;
  context: Context[];
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
  db: Kysely<DB>,
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
    const shown = direct.filter(
      (u) =>
        (!q.kinds?.length || (q.kinds as string[]).includes(u.kind)) &&
        (!q.lifecycles?.length || (q.lifecycles as string[]).includes(u.lifecycle)),
    );
    all.push({
      message: m,
      led: await Promise.all(
        shown.map(async (u) => ({
          ...u,
          now: u.lifecycle === "superseded" ? await liveSuccessors(db, u.id) : [],
        })),
      ),
      hidden: direct.length - shown.length,
      context: [],
      decided: decided.has(m.id),
      traced: traced.has(m.id),
      reply: null,
    });
  }
  const messages = all.slice(0, q.limit);
  for (const e of messages) await sameTurn(db, e);
  const sessions = new Map<string, { decided: boolean; traced: boolean }>();
  for (const e of all) {
    const s = e.message.session ?? "";
    const was = sessions.get(s) ?? { decided: false, traced: false };
    sessions.set(s, { decided: was.decided || e.decided, traced: was.traced || e.traced });
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
async function citing(db: Kysely<DB>, sources: number[]): Promise<(Cited & { role: string })[]> {
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
async function sameTurn(db: Kysely<DB>, e: Earlier): Promise<void> {
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
  e.reply = others.find((o) => o.author_kind === "assistant")?.id ?? null;
  if (!others.length) return;
  const speaker = new Map(others.map((o) => [o.id, o.author_kind]));
  const direct = new Set(e.led.map((u) => u.id));
  const seen = new Set<string>();
  for (const c of await citing(
    db,
    others.map((o) => o.id),
  )) {
    const k = `${c.id}\0${c.source_id}\0${c.role}`;
    if (direct.has(c.id) || seen.has(k)) continue;
    seen.add(k);
    e.context.push({
      key: c.key,
      kind: c.kind,
      lifecycle: c.lifecycle,
      speaker: speaker.get(c.source_id) ?? "",
      role: c.role,
    });
  }
}

/** The result as the read MCP server returns it. Record keys and message text are data from the database, kept on single lines. */
export function askedText(r: Asked): string {
  const parts = r.messages.map((e) => {
    const m = e.message;
    const lines = [`## s${m.id}: ${inline(m.artifact)}, ${m.created_at}`, head(m.text, 600)];
    if (e.led.length) {
      lines.push("Led to:");
      for (const u of e.led)
        lines.push(
          `- ${inline(u.key)} (${u.kind}, ${u.lifecycle}${u.now.length ? `; now ${u.now.map((n) => `${inline(n.key)} (${n.lifecycle})`).join(", ")}` : ""})`,
        );
    }
    if (e.hidden) lines.push(`${e.hidden} tied record${e.hidden === 1 ? "" : "s"} hidden by the filters.`);
    if (!e.decided)
      lines.push(
        `No recorded decision.${e.traced ? "" : ` Not traced yet: run /sphica:trace ${inline(m.session ?? "")}.`}`,
      );
    if (e.context.length) {
      lines.push("Same turn (context, not necessarily the answer):");
      for (const c of e.context)
        lines.push(`- ${inline(c.key)} (${c.kind}, ${c.lifecycle}): quotes the ${c.speaker} (${c.role})`);
    }
    if (e.reply !== null) lines.push(`Reply: s${e.reply} (read it with read)`);
    return lines.join("\n");
  });
  const out = [`Earlier owner messages matching: ${r.terms.join(", ")}`, ...parts];
  if (r.repeats) {
    const n = r.repeats.untraced.length + r.repeats.traced.length;
    const within = r.stopped ? ` (within the first ${r.read} candidates by rank)` : "";
    out.push(
      [
        `Asked in ${n} sessions with no recorded decision${within}:`,
        ...(r.repeats.untraced.length
          ? [`- not traced yet: ${r.repeats.untraced.map(inline).join(", ")} (run /sphica:trace with each)`]
          : []),
        ...(r.repeats.traced.length ? [`- traced: ${r.repeats.traced.map(inline).join(", ")}`] : []),
      ].join("\n"),
    );
  }
  if (r.stopped) out.push(`Stopped after ${r.read} candidates by rank; more may match.`);
  return out.join("\n\n");
}
