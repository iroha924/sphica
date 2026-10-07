// The delivery view of MCP overview: what the delivery hooks logged for one project over a period, for the owner to judge each record shown.
// The log keeps record ids, never the text delivered then, so records are named by key and read as they are now.
import type { ExpressionBuilder } from "kysely";
import { iso, type Reads } from "./db.ts";
import type { DB } from "./db-types.ts";
import { framed } from "./frame.ts";
import { inline } from "./panel.ts";
import { READ_BUDGET } from "./read.ts";
import { bytes, head } from "./text.ts";

export const DELIVERY_DAYS = { min: 1, max: 90, default: 7 } as const;
/** Most records, sessions, deliveries per session, and keys per delivery shown, and the bytes each part from outside is clipped to */
export const DELIVERY_LIMITS = {
  records: 20,
  sessions: 5,
  deliveries: 15,
  keys: 8,
  key: 200,
  path: 200,
  agent: 40,
  session: 80,
} as const;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Room kept for each "more not shown" line: one for the records, one for the sessions, one per session shown */
const MORE_LINE = 120;

type Who = "main" | "subagent" | "subagent, id unknown";
const WHO: Who[] = ["main", "subagent", "subagent, id unknown"];

/** A subagent's start the host sent without its agent id is logged with reason subagent; other rows without an id count as the host sent them */
const who = (named: boolean, event: string, reason: string | null): Who =>
  named ? "subagent" : event === "session_start" && reason === "subagent" ? "subagent, id unknown" : "main";

export const DELIVERY_LIMITS_TEXT = [
  "Counted are the logged delivery rows only: since 0.6.16 a read or edit that showed nothing is not logged (older rows show it as nothing), and a delivery answered while the write lock was busy, or whose log write failed, is not either.",
  "A session's rows are dropped once its last delivery is older than 90 days, so a long period is not a rolling window.",
  "The text delivered then is not kept, only the record ids: a record shown now may have changed since.",
  "Outcomes suppressed and unavailable are not written today, so only emitted and nothing appear.",
  "Rows without an agent id count as main, as the host reported them, except a subagent start logged without one: subagent, id unknown.",
  "named later: a captured reply of the same session, after the delivery, writes the key whole (questions asked with AskUserQuestion are not counted). An agent may use a record without naming it, naming it does not mean it helped, a reply may be missing, cut, or redacted in capture, and it may come from any agent of the session.",
];

const CLOSING =
  "Read a record by its key or u<id> before relying on it. Change a record only through /sphica:trace, with the owner's words.";

/** Characters a key goes on with on its left, and on its right; a dot on the right ends a sentence unless KEY_AFTER_DOT follows it */
const BEFORE_KEY = /[A-Za-z0-9_./:-]/;
const AFTER_KEY = /[A-Za-z0-9_/-]/;
const KEY_AFTER_DOT = /[A-Za-z0-9_./-]/;
/** A question asked with AskUserQuestion, captured as the assistant's message: not a reply */
const QUESTION = /:ask:.*:q:/s;

/** Whether text writes key whole: not as part of a longer key or word on either side. */
export function namesKey(text: string, key: string): boolean {
  for (let i = text.indexOf(key); i !== -1 && key; i = text.indexOf(key, i + 1)) {
    const before = text[i - 1];
    const after = text[i + key.length];
    const next = text[i + key.length + 1];
    const goesOn =
      after !== undefined &&
      (AFTER_KEY.test(after) || (after === "." && next !== undefined && KEY_AFTER_DOT.test(next)));
    if ((before === undefined || !BEFORE_KEY.test(before)) && !goesOn) return true;
  }
  return false;
}

/** The delivery view's body for overview, held with its frame within READ_BUDGET. now is the end of the period. */
export async function deliveryOverview(
  db: Reads,
  projectId: number,
  days: number,
  now = new Date(),
): Promise<string> {
  const to = iso(now);
  const from = iso(now.getTime() - days * DAY_MS);
  const logged = () =>
    db
      .selectFrom("delivery as d")
      .innerJoin("session as s", "s.id", "d.session_id")
      .where("s.project_id", "=", projectId)
      .where("d.at", ">=", from)
      .where("d.at", "<", to);
  const keyed = () =>
    logged().where((eb) =>
      eb.exists(
        eb.selectFrom("delivery_unit as k").whereRef("k.delivery_id", "=", "d.id").select("k.unit_id"),
      ),
    );
  const delivered = () =>
    db
      .selectFrom("delivery_unit as du")
      .innerJoin("delivery as d", "d.id", "du.delivery_id")
      .innerJoin("session as s", "s.id", "d.session_id")
      .where("s.project_id", "=", projectId)
      .where("d.at", ">=", from)
      .where("d.at", "<", to);

  const [oldest, groups, top, units, recent, sessions] = await Promise.all([
    db
      .selectFrom("delivery as d")
      .innerJoin("session as s", "s.id", "d.session_id")
      .where("s.project_id", "=", projectId)
      .select((eb) => eb.fn.min("d.at").as("at"))
      .executeTakeFirst(),
    // The reader may not call sum, so rows are grouped down to the values summed here
    logged()
      .select((eb) => [
        "d.event",
        "d.outcome",
        "d.reason",
        "d.omitted",
        eb("d.agent_id", "is not", null).as("named"),
        eb
          .exists(
            eb.selectFrom("delivery_unit as k").whereRef("k.delivery_id", "=", "d.id").select("k.unit_id"),
          )
          .as("keyed"),
        eb.fn.countAll<number>().as("n"),
      ])
      .groupBy(["d.event", "d.outcome", "d.reason", "d.omitted", "named", "keyed"])
      .execute(),
    delivered()
      .innerJoin("unit as u", "u.id", "du.unit_id")
      .select((eb) => [
        "u.id",
        "u.key",
        "u.kind",
        "u.lifecycle",
        eb.fn.count<number>("d.session_id").distinct().as("sessions"),
        eb.fn.countAll<number>().as("deliveries"),
      ])
      .groupBy("u.id")
      .orderBy("sessions", "desc")
      .orderBy("deliveries", "desc")
      .orderBy("u.id")
      .limit(DELIVERY_LIMITS.records)
      .execute(),
    delivered()
      .select((eb) => eb.fn.count<number>("du.unit_id").distinct().as("n"))
      .executeTakeFirst(),
    keyed()
      .select((eb) => ["s.id", "s.host", "s.external_id", "s.branch", eb.fn.max("d.at").as("last")])
      .groupBy("s.id")
      .orderBy("last", "desc")
      .orderBy("s.id")
      .limit(DELIVERY_LIMITS.sessions)
      .execute(),
    keyed()
      .select((eb) => eb.fn.count<number>("d.session_id").distinct().as("n"))
      .executeTakeFirst(),
  ]);

  const via = top.length
    ? await delivered()
        .where(
          "du.unit_id",
          "in",
          top.map((t) => t.id),
        )
        .select(["du.unit_id", "d.event"])
        .distinct()
        .orderBy("d.event")
        .execute()
    : [];
  const shown = await Promise.all(
    recent.map(async (r) => {
      const rows = keyed().where("d.session_id", "=", r.id);
      const [list, n] = await Promise.all([
        rows
          .select(["d.id", "d.at", "d.event", "d.agent_id", "d.reason", "d.path"])
          .orderBy("d.at")
          .orderBy("d.id")
          .limit(DELIVERY_LIMITS.deliveries)
          .execute(),
        rows.select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirst(),
      ]);
      return { session: r, list, total: Number(n?.n ?? 0) };
    }),
  );
  const ids = shown.flatMap((s) => s.list.map((d) => d.id));
  const keys = ids.length
    ? await db
        .selectFrom("delivery_unit as du")
        .innerJoin("unit as u", "u.id", "du.unit_id")
        .where("du.delivery_id", "in", ids)
        .select(["du.delivery_id", "u.id", "u.key"])
        .orderBy("du.delivery_id")
        .orderBy("u.id")
        .execute()
    : [];

  const byDelivery = new Map<number, { id: number; key: string }[]>();
  for (const k of keys) byDelivery.set(k.delivery_id, [...(byDelivery.get(k.delivery_id) ?? []), k]);
  // Replies are fetched only when they hold a key's text; whether one names the key whole is judged here
  const replies = () =>
    db
      .selectFrom("source as m")
      .where("m.kind", "=", "session_message")
      .where("m.author_kind", "=", "assistant")
      .where("m.created_at", "<", to);
  const holding = (keys: string[]) => (eb: ExpressionBuilder<DB & { m: DB["source"] }, "m">) =>
    eb.or(keys.map((k) => eb(eb.fn("instr", ["m.text", eb.val(k)]), ">", 0)));
  const reply = (r: { external_id: string }) => !QUESTION.test(r.external_id);

  // Each displayed record, over every session it was delivered in, after its first delivery there (the same time is not after)
  const namedIn = new Map<number, number>();
  for (const t of top) {
    const found = await replies()
      .innerJoin(
        delivered()
          .where("du.unit_id", "=", t.id)
          .select((f) => ["d.session_id", f.fn.min<string>("d.at").as("first")])
          .groupBy("d.session_id")
          .as("f"),
        (j) => j.onRef("f.session_id", "=", "m.session_id"),
      )
      .whereRef("m.created_at", ">", "f.first")
      .where(holding([t.key]))
      .select(["m.session_id", "m.external_id", "m.text"])
      .execute();
    namedIn.set(
      t.id,
      new Set(found.filter((r) => reply(r) && namesKey(r.text, t.key)).map((r) => r.session_id)).size,
    );
  }
  // Each example delivery, after its own time
  const later = new Map<string, { created_at: string; text: string }[]>();
  for (const s of shown) {
    const wanted = [...new Set(s.list.flatMap((d) => (byDelivery.get(d.id) ?? []).map((k) => k.key)))];
    const since = s.list[0]?.at;
    if (since && wanted.length)
      later.set(
        s.session.id,
        (
          await replies()
            .where("m.session_id", "=", s.session.id)
            .where("m.created_at", ">", since)
            .where(holding(wanted))
            .select(["m.external_id", "m.created_at", "m.text"])
            .execute()
        ).filter(reply),
      );
  }

  const counts = countTable(groups);
  const fixedTop = [
    `# Delivery log of the last ${days} day${days === 1 ? "" : "s"}`,
    `Period: from ${from} up to ${to} (UTC). Oldest delivery still logged for this project: ${oldest?.at ?? "none"}.`,
    "",
    "## Logged delivery rows",
    ...counts,
    "",
  ];
  const fixedEnd = ["", "## Limits", ...DELIVERY_LIMITS_TEXT.map((l) => `- ${l}`), "", CLOSING];
  let room =
    READ_BUDGET -
    bytes(framed("")) -
    bytes(fixedTop.join("\n")) -
    bytes(fixedEnd.join("\n")) -
    MORE_LINE * (2 + shown.length) -
    // the two section headings, what an empty section says, and the line breaks between the parts
    512;
  const fit = (lines: string[]) => {
    const b = lines.reduce((sum, l) => sum + bytes(l) + 1, 0);
    if (b > room) return false;
    room -= b;
    return true;
  };

  const events = new Map<number, string[]>();
  for (const v of via) events.set(v.unit_id, [...(events.get(v.unit_id) ?? []), v.event]);
  const topLines: string[] = [];
  for (const t of top) {
    const line = `- ${head(inline(t.key), DELIVERY_LIMITS.key)} (u${t.id}, ${t.kind}, ${t.lifecycle} now): ${t.sessions} session${Number(t.sessions) === 1 ? "" : "s"}, ${t.deliveries} deliver${Number(t.deliveries) === 1 ? "y" : "ies"}, via ${(events.get(t.id) ?? []).join(", ")}; named later in ${namedIn.get(t.id) ?? 0} of those sessions`;
    if (!fit([line])) break;
    topLines.push(line);
  }
  const recordsLeft = Number(units?.n ?? 0) - topLines.length;

  const sessionParts: string[] = [];
  let sessionsShown = 0;
  for (const s of shown) {
    const heading = `### ${inline(s.session.host)} session ${head(inline(s.session.external_id), DELIVERY_LIMITS.session)}${s.session.branch ? ` (branch ${head(inline(s.session.branch), DELIVERY_LIMITS.path)})` : ""}, last delivery with a record ${s.session.last}`;
    const replies = later.get(s.session.id) ?? [];
    const lines = s.list.map((d) =>
      deliveryLine(d, byDelivery.get(d.id) ?? [], (key) =>
        replies.some((r) => r.created_at > d.at && namesKey(r.text, key)),
      ),
    );
    if (!lines.length || !fit([heading, lines[0] ?? ""])) break;
    const part = [heading, lines[0] ?? ""];
    let n = 1;
    for (const l of lines.slice(1)) {
      if (!fit([l])) break;
      part.push(l);
      n++;
    }
    if (s.total > n)
      part.push(
        `(${s.total - n} more deliver${s.total - n === 1 ? "y" : "ies"} with records in this session not shown.)`,
      );
    sessionParts.push(...part);
    sessionsShown++;
  }
  const sessionsLeft = Number(sessions?.n ?? 0) - sessionsShown;

  return [
    ...fixedTop,
    "## Records delivered most",
    ...(topLines.length ? topLines : ["No record was delivered in this period."]),
    ...(recordsLeft > 0
      ? [`(${recordsLeft} more delivered record${recordsLeft === 1 ? "" : "s"} not shown.)`]
      : []),
    "",
    "## Example sessions, the most recent first",
    ...(sessionParts.length ? sessionParts : ["No session was delivered a record in this period."]),
    ...(sessionsLeft > 0
      ? [
          `(${sessionsLeft} more session${sessionsLeft === 1 ? "" : "s"} delivered records in this period, not shown.)`,
        ]
      : []),
    ...fixedEnd,
  ].join("\n");
}

/** Event x outcome rows with main and subagent columns, the rows without a logged record key, and what each row logged as left out. */
function countTable(
  groups: {
    event: string;
    outcome: string;
    reason: string | null;
    omitted: number;
    named: unknown;
    keyed: unknown;
    n: number;
  }[],
): string[] {
  const rows = new Map<string, { by: Map<Who, number>; keyless: number; left: number }>();
  for (const g of groups) {
    const id = `${g.event}\0${g.outcome}`;
    const row = rows.get(id) ?? { by: new Map(), keyless: 0, left: 0 };
    const w = who(Boolean(Number(g.named)), g.event, g.reason);
    const n = Number(g.n);
    row.by.set(w, (row.by.get(w) ?? 0) + n);
    if (g.outcome === "emitted" && !Number(g.keyed)) row.keyless += n;
    row.left += Number(g.omitted) * n;
    rows.set(id, row);
  }
  if (!rows.size) return ["No delivery was logged for this project in this period."];
  return [
    `| event | outcome | ${WHO.join(" | ")} | emitted rows with no logged record key | left out |`,
    `|${" --- |".repeat(WHO.length + 4)}`,
    ...[...rows.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, r]) => {
        const [event, outcome] = id.split("\0");
        return `| ${event} | ${outcome} | ${WHO.map((w) => r.by.get(w) ?? 0).join(" | ")} | ${outcome === "emitted" ? r.keyless : "-"} | ${r.left} |`;
      }),
    "left out: the sum of the counts each row logged of what applied but was not shown; a session start also counts work items.",
  ];
}

function deliveryLine(
  d: { at: string; event: string; agent_id: string | null; reason: string | null; path: string | null },
  units: { id: number; key: string }[],
  namedLater: (key: string) => boolean,
): string {
  const w = who(d.agent_id !== null, d.event, d.reason);
  const agent = w === "subagent" && d.agent_id ? ` ${head(inline(d.agent_id), DELIVERY_LIMITS.agent)}` : "";
  const named = units
    .slice(0, DELIVERY_LIMITS.keys)
    .map(
      (u) =>
        `${head(inline(u.key), DELIVERY_LIMITS.key)} (u${u.id}${namedLater(u.key) ? ", named later" : ""})`,
    )
    .join(", ");
  const more = units.length > DELIVERY_LIMITS.keys ? ` (+${units.length - DELIVERY_LIMITS.keys} more)` : "";
  return `- ${d.at} ${d.event}, ${w}${agent}${d.path ? ` ${head(inline(d.path), DELIVERY_LIMITS.path)}` : ""}: ${named}${more}`;
}
