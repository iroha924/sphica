// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Search over records (units) and retained sources. Ranked word search (FTS5 bm25) finds candidates; a candidate counts as a hit only
// when it holds more than half of the question's content terms (text.ts queryTerms). Weaker matches are counted, not shown, so a question
// with no answer comes back empty instead of returning whatever shares one word with it.

import { type SqlBool, sql } from "kysely";
import { AI_DECIDED, AUTHORITY, type Authority, authorityOf } from "./authority.ts";
import type { Reads } from "./db.ts";
import { framed } from "./frame.ts";
import type { LIFECYCLES, UNIT_KINDS } from "./knowledge.ts";
import { repoPath } from "./record.ts";
import { fitCount, keyShown, leftOut, preview, READ_BUDGET } from "./reply-budget.ts";
import { ftsQuery, identTerm, queryTerms, terms } from "./text.ts";

/** Candidates are read from the index in rank order, a page at a time, up to a cap; a search that hits the cap says it stopped. */
const UNIT_PAGE = 200;
const UNIT_SCAN_MAX = 2000;
// Sources can be 1 MiB file excerpts (term extraction takes ~50 ms per MiB), so they are read in smaller pages and capped by bytes too
const SOURCE_PAGE = 50;
const SOURCE_SCAN_MAX = 600;
const SOURCE_SCAN_BYTES = 64 * 1024 * 1024;
const LIFE_ORDER: Record<string, number> = { active: 0, candidate: 1, superseded: 2, withdrawn: 3 };
// As of a past time: candidates today's index cannot find by the words they held then, and records saved later that match now
const EXTRA_MAX = 200;
const EXTRA_RANK = Number.MAX_SAFE_INTEGER;
const LATER_SHOWN = 10;

export type UnitHit = {
  id: number;
  key: string;
  kind: string;
  stance: string | null;
  lifecycle: string;
  text: string;
  why: string | null;
  revisit_when: string | null;
  options: { text: string; outcome: string; why: string | null }[];
  anchors: { path: string; symbol: string | null; role: string }[];
  /** The question's content terms this unit holds, and whether aliases alone supplied them */
  matched: string[];
  aliasOnly: boolean;
  /** Set when the unit is here because it replaced a hit */
  successorOf?: string;
  /** The id of that replaced unit: what read takes when its key is too long to show whole */
  successorOfId?: number;
  /** Whose decision a decision or constraint is now, or as of the time searched */
  authority?: Authority;
  /** Searched as of a past time: the state the record has now, when it differs from its state then */
  now?: string;
  /**
   * Searched as of a past time: a decision or constraint with no adoption in effect then on record. Nobody may have adopted it, or
   * the words that did were forgotten or retracted since; the rows that are left cannot tell which, so the reply does not say
   */
  noAdoptionKept?: true;
};

export type UnitQuery = {
  question: string;
  kinds?: (typeof UNIT_KINDS)[number][] | undefined;
  lifecycles?: (typeof LIFECYCLES)[number][] | undefined;
  /** Only units anchored to this repository path */
  path?: string | undefined;
  limit: number;
  /**
   * Only records saved by this time, judged by the states, anchors, aliases, fields, replacements, and adoption of that time.
   * The order still follows today's index, whose ranks count every record held now.
   */
  asOf?: string | undefined;
};

/** What a search as of a past time left out, for the caller to say. */
type AsOfNotes = {
  /** Records saved after that time that match now, oldest first; not hits, since nothing says they were known then */
  later: { id: number; created_at: string }[];
  laterMore: number;
  laterStopped: boolean;
  /** Whether the candidates today's index no longer finds by their words of that time were cut at their cap */
  extraStopped: boolean;
};

type Found = {
  hits: UnitHit[];
  weaker: number;
  terms: string[];
  stopped: boolean;
  read: number;
  refused?: string;
  asOf?: AsOfNotes;
};

/** The index's matches for a query in this project, each joined to its record. */
const indexed = (db: Reads, projectId: number, match: string) =>
  // cross join fixes the order: the index's matches drive, instead of every row of the project running MATCH once (seconds on large projects)
  db
    .selectFrom(
      sql<{
        rowid: number;
        rank: number;
      }>`(select unit_fts.rowid as rowid, bm25(unit_fts, 3, 2, 1) as rank from unit_fts cross join unit on unit.id = unit_fts.rowid where unit_fts match ${match} and unit.project_id = ${projectId})`.as(
        "f",
      ),
    )
    .innerJoin("unit as u", "u.id", "f.rowid")
    .where("u.project_id", "=", projectId)
    .where("u.extraction", "=", "supported");

/** The index's matches narrowed by the caller's filters as the records are now. */
function filtered(db: Reads, projectId: number, q: UnitQuery, path: string | undefined, match: string) {
  let query = indexed(db, projectId, match);
  if (q.kinds?.length) query = query.where("u.kind", "in", q.kinds);
  if (q.lifecycles?.length) query = query.where("u.lifecycle", "in", q.lifecycles);
  if (path)
    query = query.where(({ exists, selectFrom }) =>
      exists(
        selectFrom("unit_anchor as a")
          .select("a.id")
          .whereRef("a.unit_id", "=", "u.id")
          .where("a.path", "=", path)
          .where("a.retired_at", "is", null),
      ),
    );
  return query;
}

const strong = (matched: number, of: number) => matched * 2 > of;

const PATH_REFUSED =
  "path must be relative to the repository root, such as src/x.ts: absolute paths, .., backslashes, and empty parts are refused";

export async function searchUnits(db: Reads, projectId: number, q: UnitQuery): Promise<Found> {
  const wanted = queryTerms(q.question);
  // Anchors are stored by these rules, so a path written another way would match nothing and look like no record
  const path = q.path === undefined ? undefined : repoPath(q.path);
  if (path === null)
    return { hits: [], weaker: 0, terms: wanted, stopped: false, read: 0, refused: PATH_REFUSED };
  const match = ftsQuery(q.question);
  if (!match) return { hits: [], weaker: 0, terms: wanted, stopped: false, read: 0 };
  if (q.asOf !== undefined) return searchAsOf(db, projectId, q, q.asOf, wanted, path, match);
  const query = filtered(db, projectId, q, path, match);
  // The order is taken in one statement, after every filter, so a write between pages shifts nothing and matches a filter drops
  // never crowd out the ones it keeps. Hits are sorted at the end, so every candidate up to the cap is read; the row past the cap
  // only tells whether more remain.
  const ranked = await query
    .select(["u.id", "f.rank"])
    .orderBy("f.rank")
    .orderBy("u.id")
    .limit(UNIT_SCAN_MAX + 1)
    .execute();
  const stopped = ranked.length > UNIT_SCAN_MAX;
  let weaker = 0;
  let read = 0;
  const hits: (UnitHit & { rank: number })[] = [];
  for (let at = 0; at < Math.min(ranked.length, UNIT_SCAN_MAX); at += UNIT_PAGE) {
    const part = ranked.slice(at, Math.min(at + UNIT_PAGE, UNIT_SCAN_MAX));
    // Rows are read through the same filters, so a unit gone or changed since the order was taken is simply not read,
    // and they are judged in the order taken (ties by id)
    const order = new Map(part.map((r, i) => [r.id, i]));
    const rows = (
      await query
        .select([
          "u.id",
          "u.key",
          "u.kind",
          "u.stance",
          "u.lifecycle",
          "u.text",
          "u.why",
          "u.scope_note",
          "u.revisit_when",
          "u.content_hash",
          "f.rank",
        ])
        .where(
          "u.id",
          "in",
          part.map((r) => r.id),
        )
        .execute()
    ).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    read += rows.length;
    weaker += await judgeUnits(db, rows, wanted, hits);
  }
  // A superseded hit points to what replaced it: the record at the end of the chain joins the hits even when it shares no word with
  // the question. The caller's kind and lifecycle filters hold for it too; a path filter does not, since it replaces a record anchored there
  const shown = new Set(hits.map((h) => h.id));
  for (const h of [...hits].filter((x) => x.lifecycle === "superseded"))
    for (const n of await liveSuccessors(db, h.id))
      if (
        !shown.has(n.id) &&
        (!q.kinds?.length || (q.kinds as string[]).includes(n.kind)) &&
        (!q.lifecycles?.length || (q.lifecycles as string[]).includes(n.lifecycle))
      ) {
        shown.add(n.id);
        hits.push({
          ...n,
          options: [],
          anchors: [],
          matched: [],
          aliasOnly: false,
          successorOf: h.key,
          successorOfId: h.id,
          rank: h.rank,
        });
      }
  hits.sort(
    (a, b) =>
      (LIFE_ORDER[a.lifecycle] ?? 9) - (LIFE_ORDER[b.lifecycle] ?? 9) ||
      b.matched.length - a.matched.length ||
      a.rank - b.rank,
  );
  const top = hits.slice(0, q.limit);
  const whose = await authorityOf(
    db,
    top.filter((h) => ["decision", "constraint"].includes(h.kind)).map((h) => h.id),
  );
  return {
    hits: top.map(({ rank: _rank, ...h }) => ({ ...h, authority: whose.get(h.id) })),
    weaker,
    terms: wanted,
    stopped,
    read,
  };
}

/**
 * searchUnits as of a past time. Candidates come from today's index, plus the records it can no longer find by their words of that
 * time (an anchor retired since, an alias set replaced since), and each is judged by what it held then.
 */
async function searchAsOf(
  db: Reads,
  projectId: number,
  q: UnitQuery,
  asOf: string,
  wanted: string[],
  path: string | undefined,
  match: string,
): Promise<Found> {
  const life = sql<string>`coalesce((select t.to_state from unit_state as t where t.unit_id = u.id and t.at <= ${asOf} order by t.id desc limit 1), 'candidate')`;
  const held = sql<SqlBool>`u.created_at <= ${asOf}${q.kinds?.length ? sql` and u.kind in (${sql.join(q.kinds)})` : sql``}${
    q.lifecycles?.length ? sql` and ${life} in (${sql.join(q.lifecycles)})` : sql``
  }${
    path
      ? sql` and exists (select 1 from unit_anchor as a where a.unit_id = u.id and a.path = ${path} and a.added_at <= ${asOf} and (a.retired_at is null or a.retired_at > ${asOf}))`
      : sql``
  }`;
  const lostWords = sql<SqlBool>`(exists (select 1 from unit_anchor as a where a.unit_id = u.id and a.added_at <= ${asOf} and a.retired_at > ${asOf})
    or (exists (select 1 from unit_alias as x where x.unit_id = u.id and x.added_at > ${asOf})
      and exists (select 1 from unit_alias as x where x.unit_id = u.id and x.added_at <= ${asOf})))`;
  const units = () =>
    db
      .selectFrom("unit as u")
      .where("u.project_id", "=", projectId)
      .where("u.extraction", "=", "supported")
      .where(held);

  const ranked = await indexed(db, projectId, match)
    .where(held)
    .select(["u.id", "f.rank"])
    .orderBy("f.rank")
    .orderBy("u.id")
    .limit(UNIT_SCAN_MAX + 1)
    .execute();
  const stopped = ranked.length > UNIT_SCAN_MAX;
  const taken = ranked.slice(0, UNIT_SCAN_MAX);
  const known = new Set(taken.map((r) => r.id));
  const lost = (
    await units()
      .where(lostWords)
      .select("u.id")
      .orderBy("u.id")
      .limit(EXTRA_MAX + taken.length + 1)
      .execute()
  ).filter((r) => !known.has(r.id));
  const extra = lost.slice(0, EXTRA_MAX).map((r) => ({ id: r.id, rank: EXTRA_RANK }));

  let weaker = 0;
  let read = 0;
  const hits: (UnitHit & { rank: number })[] = [];
  for (const [list, counted] of [
    [taken, true],
    [extra, false],
  ] as const)
    for (let at = 0; at < list.length; at += UNIT_PAGE) {
      const part = list.slice(at, at + UNIT_PAGE);
      const order = new Map(part.map((r, i) => [r.id, { i, rank: r.rank }]));
      const rows = (
        await units()
          .select([
            "u.id",
            "u.key",
            "u.kind",
            "u.stance",
            life.as("lifecycle"),
            "u.lifecycle as now",
            "u.text",
            "u.why",
            "u.scope_note",
            "u.revisit_when",
            "u.content_hash",
          ])
          .where(
            "u.id",
            "in",
            part.map((r) => r.id),
          )
          .execute()
      )
        .map((r) => ({ ...r, rank: order.get(r.id)?.rank ?? EXTRA_RANK }))
        .sort((a, b) => (order.get(a.id)?.i ?? 0) - (order.get(b.id)?.i ?? 0));
      const left = await judgeUnits(db, rows, wanted, hits, asOf);
      // A record the index did not match is not a weaker match of the question: it was only looked at
      if (counted) {
        read += rows.length;
        weaker += left;
      }
    }
  const shown = new Set(hits.map((h) => h.id));
  for (const h of [...hits].filter((x) => x.lifecycle === "superseded"))
    for (const n of await liveSuccessors(db, h.id, asOf))
      if (
        !shown.has(n.id) &&
        (!q.kinds?.length || (q.kinds as string[]).includes(n.kind)) &&
        (!q.lifecycles?.length || (q.lifecycles as string[]).includes(n.lifecycle))
      ) {
        shown.add(n.id);
        hits.push({
          ...n,
          options: [],
          anchors: [],
          matched: [],
          aliasOnly: false,
          successorOf: h.key,
          successorOfId: h.id,
          rank: h.rank,
        });
      }
  hits.sort(
    (a, b) =>
      (LIFE_ORDER[a.lifecycle] ?? 9) - (LIFE_ORDER[b.lifecycle] ?? 9) ||
      b.matched.length - a.matched.length ||
      a.rank - b.rank,
  );
  const top = hits.slice(0, q.limit);
  const whose = await authorityOf(
    db,
    top.filter((h) => ["decision", "constraint"].includes(h.kind)).map((h) => h.id),
    asOf,
  );

  // Saved after that time and matching now, by the caller's filters as the records are now: named apart, never counted as hits.
  // Read oldest first, not best first, up to the same cap as the candidates: the ones named are those saved soonest after the time
  const after = await filtered(db, projectId, q, path, match)
    .where("u.created_at", ">", asOf)
    .select(["u.id", "u.created_at"])
    .orderBy("u.created_at")
    .orderBy("u.id")
    .limit(UNIT_SCAN_MAX + 1)
    .execute();
  const laterHits: (UnitHit & { rank: number })[] = [];
  for (let at = 0; at < Math.min(after.length, UNIT_SCAN_MAX); at += UNIT_PAGE) {
    const part = after.slice(at, Math.min(at + UNIT_PAGE, UNIT_SCAN_MAX));
    const order = new Map(part.map((r, i) => [r.id, i]));
    const rows = (
      await filtered(db, projectId, q, path, match)
        .select([
          "u.id",
          "u.key",
          "u.kind",
          "u.stance",
          "u.lifecycle",
          "u.text",
          "u.why",
          "u.scope_note",
          "u.revisit_when",
          "u.content_hash",
          "f.rank",
        ])
        .where(
          "u.id",
          "in",
          part.map((r) => r.id),
        )
        .execute()
    ).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    await judgeUnits(db, rows, wanted, laterHits);
  }
  const savedAt = new Map(after.map((r) => [r.id, r.created_at]));
  const later = laterHits.map((h) => ({ id: h.id, created_at: savedAt.get(h.id) ?? "" }));
  return {
    hits: top.map(({ rank: _rank, ...h }) => ({
      ...h,
      authority: whose.get(h.id),
      ...(whose.get(h.id) === "none" ? { noAdoptionKept: true as const } : {}),
    })),
    weaker,
    terms: wanted,
    stopped,
    read,
    asOf: {
      later: later.slice(0, LATER_SHOWN),
      laterMore: Math.max(later.length - LATER_SHOWN, 0),
      laterStopped: after.length > UNIT_SCAN_MAX,
      extraStopped: lost.length > EXTRA_MAX,
    },
  };
}

export type Successor = {
  id: number;
  key: string;
  kind: string;
  stance: string | null;
  lifecycle: string;
  text: string;
  why: string | null;
  revisit_when: string | null;
  now?: string;
};

/**
 * The record in effect at the end of a record's chain of replacements, following open replacement rows until a record nothing replaces.
 * A record has at most one open row into it, so the chain is a line; a proposal waiting for the place has no row and is never shown.
 * As of a past time, a row is open when that time falls in its period, and the successor carries the state it had then.
 */
export async function liveSuccessors(db: Reads, id: number, asOf?: string): Promise<Successor[]> {
  const seen = new Set([id]);
  let end: Successor | undefined;
  for (let at = id; ; ) {
    const next =
      asOf === undefined
        ? await db
            .selectFrom("unit_replacement as h")
            .innerJoin("unit as n", "n.id", "h.from_unit")
            .where("h.to_unit", "=", at)
            .where("h.ended_at", "is", null)
            .select([
              "n.id",
              "n.key",
              "n.kind",
              "n.stance",
              "n.lifecycle",
              "n.text",
              "n.why",
              "n.revisit_when",
            ])
            .executeTakeFirst()
        : await pastSuccessor(db, at, asOf);
    // Rows only open along acyclic intents; the visited set keeps a damaged database from looping a read
    if (!next || seen.has(next.id)) break;
    seen.add(next.id);
    end = next;
    at = next.id;
  }
  return end ? [end] : [];
}

/** The record whose replacement of `id` was in effect at `asOf`, with the state it had then. */
async function pastSuccessor(db: Reads, id: number, asOf: string): Promise<Successor | undefined> {
  const n = await db
    .selectFrom("unit_replacement as h")
    .innerJoin("unit as n", "n.id", "h.from_unit")
    .where("h.to_unit", "=", id)
    .where("h.started_at", "<=", asOf)
    .where((eb) => eb.or([eb("h.ended_at", "is", null), eb("h.ended_at", ">", asOf)]))
    .select([
      "n.id",
      "n.key",
      "n.kind",
      "n.stance",
      sql<string>`coalesce((select t.to_state from unit_state as t where t.unit_id = n.id and t.at <= ${asOf} order by t.id desc limit 1), 'candidate')`.as(
        "lifecycle",
      ),
      "n.lifecycle as now",
      "n.text",
      "n.why",
      "n.revisit_when",
    ])
    .executeTakeFirst();
  if (!n) return undefined;
  const { now, ...rest } = n;
  return now === rest.lifecycle ? rest : { ...rest, now };
}

type UnitRow = {
  id: number;
  key: string;
  kind: string;
  stance: string | null;
  lifecycle: string;
  text: string;
  why: string | null;
  scope_note: string | null;
  revisit_when: string | null;
  content_hash: Uint8Array | Buffer;
  rank: number;
  /** The state now, on a row whose lifecycle is the one of a past time */
  now?: string;
};

/**
 * Runs the term check on one page of candidates, adding the hits; returns how many were weaker. With `asOf`, a candidate is judged by the
 * anchors and alias set it had at that time (options, commands, and field values are written with the record and never added later).
 */
async function judgeUnits(
  db: Reads,
  rows: UnitRow[],
  wanted: string[],
  hits: (UnitHit & { rank: number })[],
  asOf?: string,
): Promise<number> {
  const ids = rows.map((r) => r.id);
  const [options, anchors, aliases, fields, commands] = ids.length
    ? await Promise.all([
        db
          .selectFrom("unit_option")
          .select(["unit_id", "text", "outcome", "why", "reconsider_when"])
          .where("unit_id", "in", ids)
          .orderBy("position")
          .execute(),
        db
          .selectFrom("unit_anchor")
          .select(["unit_id", "path", "symbol", "role"])
          .where("unit_id", "in", ids)
          .$if(asOf === undefined, (a) => a.where("retired_at", "is", null))
          .$if(asOf !== undefined, (a) =>
            a
              .where("added_at", "<=", asOf ?? "")
              .where((eb) => eb.or([eb("retired_at", "is", null), eb("retired_at", ">", asOf ?? "")])),
          )
          .orderBy("id")
          .execute(),
        db
          .selectFrom("unit_alias")
          .select(["unit_id", "terms", "content_hash"])
          .where("unit_id", "in", ids)
          .$if(asOf !== undefined, (a) => a.where("added_at", "<=", asOf ?? ""))
          .orderBy("id", "desc")
          .execute(),
        db
          .selectFrom("unit_field as f")
          .innerJoin("field_def as d", "d.id", "f.field_def_id")
          .select(["f.unit_id", "d.name", "f.value"])
          .where("f.unit_id", "in", ids)
          .execute(),
        // Written with the record and never retired, like options
        db.selectFrom("unit_command").select(["unit_id", "command"]).where("unit_id", "in", ids).execute(),
      ])
    : [[], [], [], [], []];

  let weaker = 0;
  for (const r of rows) {
    const opts = options.filter((o) => o.unit_id === r.id);
    const anch = anchors.filter((a) => a.unit_id === r.id);
    // Only the newest alias set written for this text counts (the index follows the same rule)
    const alias = aliases.find(
      (a) => a.unit_id === r.id && Buffer.from(a.content_hash).equals(Buffer.from(r.content_hash)),
    );
    const own = new Set(
      terms(
        [
          r.text,
          r.why,
          r.scope_note,
          r.revisit_when,
          ...opts.flatMap((o) => [o.text, o.why, o.reconsider_when]),
          ...anch.flatMap((a) => [a.path, a.symbol]),
          ...commands.filter((c) => c.unit_id === r.id).map((c) => c.command),
          ...fields.filter((f) => f.unit_id === r.id).flatMap((f) => [f.name, f.value]),
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    );
    const extra = new Set(alias ? terms((JSON.parse(alias.terms) as string[]).join(" ")) : []);
    const matched = wanted.filter((w) => own.has(w) || extra.has(w));
    // Naming an anchored path or symbol exactly is a strong signal on its own, however many other words the query has.
    // Each is compared whole, folded as the query's terms are, so getUsers meets the term getuser and src alone stays weak
    const ident = new Set(anch.flatMap((a) => [a.path, a.symbol].flatMap((x) => (x ? [identTerm(x)] : []))));
    if (!strong(matched.length, wanted.length) && !matched.some((w) => ident.has(w))) {
      weaker++;
      continue;
    }
    hits.push({
      id: r.id,
      key: r.key,
      kind: r.kind,
      stance: r.stance,
      lifecycle: r.lifecycle,
      text: r.text,
      why: r.why,
      revisit_when: r.revisit_when,
      options: opts.map((o) => ({ text: o.text, outcome: o.outcome, why: o.why })),
      anchors: anch.map((a) => ({ path: a.path, symbol: a.symbol, role: a.role })),
      matched,
      aliasOnly: matched.every((w) => !own.has(w)),
      rank: r.rank,
      ...(r.now !== undefined && r.now !== r.lifecycle ? { now: r.now } : {}),
    });
  }
  return weaker;
}

export type SourceHit = {
  id: number;
  kind: string;
  artifact: string;
  author: string;
  created_at: string;
  text: string;
  matched: string[];
  session: string | null;
  turn: string | null;
};

/**
 * Retained sources (conversation and pull request text) holding more than half of the question's content terms, best first.
 * `owner` narrows them to the owner's own messages outside the given sessions, before the caps, so other text never uses them up.
 */
export async function searchSources(
  db: Reads,
  projectId: number,
  question: string,
  limit: number,
  owner?: { notSessions: string[] },
): Promise<{ hits: SourceHit[]; weaker: number; terms: string[]; stopped: boolean; read: number }> {
  const wanted = queryTerms(question);
  const match = ftsQuery(question);
  if (!match) return { hits: [], weaker: 0, terms: wanted, stopped: false, read: 0 };
  // cross join: the index's matches drive, as in searchUnits
  const query = db
    .selectFrom(
      sql<{
        rowid: number;
        rank: number;
      }>`(select source_fts.rowid as rowid, bm25(source_fts) as rank from source_fts cross join source on source.id = source_fts.rowid where source_fts match ${match} and source.project_id = ${projectId})`.as(
        "f",
      ),
    )
    .innerJoin("source as s", "s.id", "f.rowid")
    .where("s.project_id", "=", projectId)
    .$if(owner !== undefined, (q) =>
      q
        .where("s.kind", "=", "session_message")
        .where("s.author_kind", "=", "owner")
        .$if((owner?.notSessions.length ?? 0) > 0, (q2) =>
          q2.where("s.session_id", "not in", owner?.notSessions ?? []),
        ),
    );
  // The order is taken in one statement, so a write between pages shifts nothing; texts are then read a page at a time.
  // Hits come in rank order, so reading ends once there are enough (that is not a stop). The caps are checked before each candidate.
  const ranked = await query
    .select(["s.id", "f.rank"])
    .orderBy("f.rank")
    .orderBy("s.id")
    .limit(SOURCE_SCAN_MAX + 1)
    .execute();
  let weaker = 0;
  let stopped = false;
  const hits: SourceHit[] = [];
  let read = 0;
  let bytes = 0;
  scan: for (let at = 0; at < ranked.length; at += SOURCE_PAGE) {
    const ids = ranked.slice(at, at + SOURCE_PAGE).map((r) => r.id);
    const byId = new Map(
      (
        await db
          .selectFrom("source")
          .select([
            "id",
            "kind",
            "artifact",
            "author_kind",
            "author_login",
            "created_at",
            "text",
            "session_id",
            "turn_id",
          ])
          .where("id", "in", ids)
          .execute()
      ).map((r) => [r.id, r]),
    );
    for (const id of ids) {
      if (read >= SOURCE_SCAN_MAX || bytes >= SOURCE_SCAN_BYTES) {
        stopped = true;
        break scan;
      }
      // A source gone since the order was taken (forgotten) is simply not read
      const r = byId.get(id);
      if (!r) continue;
      read++;
      bytes += Buffer.byteLength(r.text);
      const own = new Set(terms(r.text));
      const matched = wanted.filter((w) => own.has(w));
      if (!strong(matched.length, wanted.length)) {
        weaker++;
        continue;
      }
      hits.push({
        id: r.id,
        kind: r.kind,
        artifact: r.artifact,
        author: r.author_login ?? r.author_kind,
        created_at: r.created_at,
        text: r.text,
        matched,
        session: r.session_id,
        turn: r.turn_id,
      });
      if (hits.length >= limit) break scan;
    }
  }
  // Every id taken was looked at, but the order was cut at the cap: candidates past it were never taken
  if (!stopped && hits.length < limit && ranked.length > SOURCE_SCAN_MAX) stopped = true;
  return { hits, weaker, terms: wanted, stopped, read };
}

/** How much of each part of a hit search shows, in UTF-8 bytes and counts: a preview, with the whole record one read away */
const SHOWN = {
  key: 200,
  text: 600,
  why: 400,
  revisit: 200,
  options: 8,
  option: 160,
  anchors: 8,
  path: 200,
  symbol: 100,
  matched: 300,
} as const;

function hitText(h: UnitHit): string {
  const key = preview(h.key, SHOWN.key);
  const more = (n: number, what: string) => `and ${n} more ${what} (read u${h.id})`;
  const options = h.options
    .slice(0, SHOWN.options)
    .map(
      (o) =>
        `${preview(o.text, SHOWN.option)} (${o.outcome}${o.why ? `: ${preview(o.why, SHOWN.option)}` : ""})`,
    );
  if (h.options.length > SHOWN.options) options.push(more(h.options.length - SHOWN.options, "options"));
  const anchors = h.anchors
    .slice(0, SHOWN.anchors)
    .map(
      (a) =>
        `${preview(a.path, SHOWN.path)}${a.symbol ? ` ${preview(a.symbol, SHOWN.symbol)}` : ""} (${a.role})`,
    );
  if (h.anchors.length > SHOWN.anchors) anchors.push(more(h.anchors.length - SHOWN.anchors, "anchors"));
  return [
    // A key cut for display is not one read takes: the id beside it is
    `## ${key}${key.endsWith("…") && key !== h.key ? " [key cut]" : ""} (u${h.id}): ${h.kind}${h.stance ? ` ${h.stance}` : ""}, ${h.lifecycle}${h.now ? `, now ${h.now}` : ""}${h.noAdoptionKept ? ", no adoption in effect then is on record" : h.authority ? `, ${AUTHORITY[h.authority]}` : ""}`,
    preview(h.text, SHOWN.text, true),
    ...(h.why ? [`Why: ${preview(h.why, SHOWN.why, true)}`] : []),
    ...(h.revisit_when ? [`Revisit when: ${preview(h.revisit_when, SHOWN.revisit, true)}`] : []),
    ...(options.length ? [`Options: ${options.join(" / ")}`] : []),
    ...(anchors.length ? [`Code: ${anchors.join(", ")}`] : []),
    h.successorOf
      ? `Replaces ${h.successorOfId === undefined ? preview(h.successorOf, SHOWN.key) : keyShown(h.successorOf, h.successorOfId)}, which matched`
      : `Matched: ${preview(h.matched.join(", "), SHOWN.matched)}${h.aliasOnly ? " (search aliases only)" : ""}`,
  ].join("\n");
}

/** The frame around what was found, then Sphica's own lines after it, one to a line */
const withNotes = (body: string, notes: string[]) => [framed(body), ...notes.filter(Boolean)].join("\n");

/**
 * What a search as of a past time says around its hits: first the time and what it covers, then what it left out. Sphica's own words,
 * so they go outside the frame.
 */
export function asOfLines(at: string, n: AsOfNotes | undefined): { lead: string; notes: string[] } {
  const more = n?.laterMore
    ? `, and ${n.laterMore} more${n.laterStopped ? " at least" : ""}`
    : n?.laterStopped
      ? ", and possibly more"
      : "";
  return {
    lead: `As of ${at}: which records existed, and their states, anchors, aliases, and replacements, are as Sphica held them then (by when it saved them, not when the words were said); the order follows today's index. read shows each record as it is now, with its dated history.`,
    notes: [
      n?.later.length
        ? `Saved after this time and not counted: ${n.later.map((l) => `u${l.id} (saved ${l.created_at})`).join(", ")}${more}.`
        : // An empty list with the reading cut is not "none saved later"
          n?.laterStopped
          ? `Records saved after this time were read up to ${UNIT_SCAN_MAX} from the oldest and none matched; newer ones were not read.`
          : "",
      n?.extraStopped
        ? `Records found only by an anchor or alias they have lost since were looked at up to ${EXTRA_MAX}; more may match.`
        : "",
    ].filter(Boolean),
  };
}

/**
 * search's whole reply for record hits within READ_BUDGET: the hits in the frame, with Sphica's words for an AI's decision when one is
 * shown, then outside it the hits that did not fit, named by u<id> for read, and after (where the search stopped). A search as of a
 * past time opens with that time and names what it left out.
 */
export function hitsReply(
  hits: UnitHit[],
  after: string,
  asOf?: { at: string; notes: AsOfNotes | undefined },
): string {
  const parts = hits.map(hitText);
  const lines = asOf ? asOfLines(asOf.at, asOf.notes) : undefined;
  const reply = (kept: number) =>
    [
      ...(lines ? [lines.lead] : []),
      withNotes(
        [
          ...parts.slice(0, kept),
          ...(hits.slice(0, kept).some((h) => h.authority === "agent") ? [AI_DECIDED] : []),
        ].join("\n\n"),
        [
          leftOut(
            hits.slice(kept).map((h) => `u${h.id}`),
            "hits",
          ),
          ...(lines?.notes ?? []),
          after,
          "Read a record by its key before relying on it.",
        ],
      ),
    ].join("\n");
  return reply(fitCount(parts, READ_BUDGET, reply));
}

/** search's whole reply for source hits within READ_BUDGET; hits that do not fit are named by s<id> for read, outside the frame */
export function sourcesReply(hits: SourceHit[], after: string): string {
  const parts = hits.map(
    (h) =>
      `## s${h.id}: ${h.kind} ${preview(h.artifact, SHOWN.path)}, ${preview(h.author, SHOWN.symbol)}, ${h.created_at}\n${preview(h.text, 800, true)}\nMatched: ${preview(h.matched.join(", "), SHOWN.matched)}`,
  );
  const reply = (kept: number) =>
    withNotes(parts.slice(0, kept).join("\n\n"), [
      leftOut(
        hits.slice(kept).map((h) => `s${h.id}`),
        "hits",
      ),
      after,
    ]);
  return reply(fitCount(parts, READ_BUDGET, reply));
}
