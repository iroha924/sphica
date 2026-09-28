// Search over records (units) and retained sources. Ranked word search (FTS5 bm25) finds candidates; a candidate counts as a hit only
// when it holds more than half of the question's content terms (text.ts queryTerms). Weaker matches are counted, not shown, so a question
// with no answer comes back empty instead of returning whatever shares one word with it.
import { type Kysely, sql } from "kysely";
import type { DB } from "./db-types.ts";
import type { LIFECYCLES, UNIT_KINDS } from "./knowledge.ts";
import { ftsQuery, queryTerms, terms } from "./text.ts";

/** Candidates are read from the index in rank order, a page at a time, up to a cap; a search that hits the cap says it stopped. */
const UNIT_PAGE = 200;
const UNIT_SCAN_MAX = 2000;
// Sources can be 1 MiB file excerpts (term extraction takes ~50 ms per MiB), so they are read in smaller pages and capped by bytes too
const SOURCE_PAGE = 50;
const SOURCE_SCAN_MAX = 600;
const SOURCE_SCAN_BYTES = 64 * 1024 * 1024;
const LIFE_ORDER: Record<string, number> = { active: 0, candidate: 1, superseded: 2, withdrawn: 3 };

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
};

export type UnitQuery = {
  question: string;
  kinds?: (typeof UNIT_KINDS)[number][] | undefined;
  lifecycles?: (typeof LIFECYCLES)[number][] | undefined;
  /** Only units anchored to this repository path */
  path?: string | undefined;
  limit: number;
};

const strong = (matched: number, of: number) => matched * 2 > of;

export async function searchUnits(
  db: Kysely<DB>,
  projectId: number,
  q: UnitQuery,
): Promise<{ hits: UnitHit[]; weaker: number; terms: string[]; stopped: boolean; read: number }> {
  const wanted = queryTerms(q.question);
  const match = ftsQuery(q.question);
  if (!match) return { hits: [], weaker: 0, terms: wanted, stopped: false, read: 0 };
  let query = db
    .selectFrom(
      sql<{
        rowid: number;
        rank: number;
      }>`(select unit_fts.rowid as rowid, bm25(unit_fts, 3, 2, 1) as rank from unit_fts join unit on unit.id = unit_fts.rowid where unit_fts match ${match} and unit.project_id = ${projectId})`.as(
        "f",
      ),
    )
    .innerJoin("unit as u", "u.id", "f.rowid")
    .where("u.project_id", "=", projectId)
    .where("u.extraction", "=", "supported");
  if (q.kinds?.length) query = query.where("u.kind", "in", q.kinds);
  if (q.lifecycles?.length) query = query.where("u.lifecycle", "in", q.lifecycles);
  if (q.path)
    query = query.where(({ exists, selectFrom }) =>
      exists(
        selectFrom("unit_anchor as a")
          .select("a.id")
          .whereRef("a.unit_id", "=", "u.id")
          .where("a.path", "=", q.path ?? "")
          .where("a.retired_at", "is", null),
      ),
    );
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
  // A superseded hit points to what replaced it: the live successor joins the hits even when it shares no word with the question.
  // The caller's kind and lifecycle filters hold for it too; a path filter does not, since it replaces a record anchored there
  const shown = new Set(hits.map((h) => h.id));
  for (const h of [...hits].filter((x) => x.lifecycle === "superseded")) {
    let successors = db
      .selectFrom("unit_link as l")
      .innerJoin("unit as n", "n.id", "l.from_unit")
      .where("l.to_unit", "=", h.id)
      .where("l.kind", "=", "supersedes")
      .where("n.extraction", "=", "supported");
    if (q.kinds?.length) successors = successors.where("n.kind", "in", q.kinds);
    if (q.lifecycles?.length) successors = successors.where("n.lifecycle", "in", q.lifecycles);
    const next = await successors
      .select(["n.id", "n.key", "n.kind", "n.stance", "n.lifecycle", "n.text", "n.why", "n.revisit_when"])
      .execute();
    for (const n of next)
      if (!shown.has(n.id)) {
        shown.add(n.id);
        hits.push({
          ...n,
          options: [],
          anchors: [],
          matched: [],
          aliasOnly: false,
          successorOf: h.key,
          rank: h.rank,
        });
      }
  }
  hits.sort(
    (a, b) =>
      (LIFE_ORDER[a.lifecycle] ?? 9) - (LIFE_ORDER[b.lifecycle] ?? 9) ||
      b.matched.length - a.matched.length ||
      a.rank - b.rank,
  );
  return {
    hits: hits.slice(0, q.limit).map(({ rank: _rank, ...h }) => h),
    weaker,
    terms: wanted,
    stopped,
    read,
  };
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
};

/** Runs the term check on one page of candidates, adding the hits; returns how many were weaker. */
async function judgeUnits(
  db: Kysely<DB>,
  rows: UnitRow[],
  wanted: string[],
  hits: (UnitHit & { rank: number })[],
): Promise<number> {
  const ids = rows.map((r) => r.id);
  const [options, anchors, aliases] = ids.length
    ? await Promise.all([
        db
          .selectFrom("unit_option")
          .select(["unit_id", "text", "outcome", "why"])
          .where("unit_id", "in", ids)
          .orderBy("position")
          .execute(),
        db
          .selectFrom("unit_anchor")
          .select(["unit_id", "path", "symbol", "role"])
          .where("unit_id", "in", ids)
          .where("retired_at", "is", null)
          .orderBy("id")
          .execute(),
        db
          .selectFrom("unit_alias")
          .select(["unit_id", "terms", "content_hash"])
          .where("unit_id", "in", ids)
          .orderBy("id", "desc")
          .execute(),
      ])
    : [[], [], []];

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
          ...opts.flatMap((o) => [o.text, o.why]),
          ...anch.flatMap((a) => [a.path, a.symbol]),
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    );
    const extra = new Set(alias ? terms((JSON.parse(alias.terms) as string[]).join(" ")) : []);
    const matched = wanted.filter((w) => own.has(w) || extra.has(w));
    // Naming an anchored path or symbol exactly is a strong signal on its own, however many other words the query has
    const ident = new Set(
      anch.flatMap((a) => [a.path, a.symbol].flatMap((x) => (x ? [x.normalize("NFKC").toLowerCase()] : []))),
    );
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
};

/** Retained sources (conversation and pull request text) holding more than half of the question's content terms, best first. */
export async function searchSources(
  db: Kysely<DB>,
  projectId: number,
  question: string,
  limit: number,
): Promise<{ hits: SourceHit[]; weaker: number; terms: string[]; stopped: boolean; read: number }> {
  const wanted = queryTerms(question);
  const match = ftsQuery(question);
  if (!match) return { hits: [], weaker: 0, terms: wanted, stopped: false, read: 0 };
  const query = db
    .selectFrom(
      sql<{
        rowid: number;
        rank: number;
      }>`(select source_fts.rowid as rowid, bm25(source_fts) as rank from source_fts join source on source.id = source_fts.rowid where source_fts match ${match} and source.project_id = ${projectId})`.as(
        "f",
      ),
    )
    .innerJoin("source as s", "s.id", "f.rowid")
    .where("s.project_id", "=", projectId);
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
          .select(["id", "kind", "artifact", "author_kind", "author_login", "created_at", "text"])
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
      });
      if (hits.length >= limit) break scan;
    }
  }
  // Every id taken was looked at, but the order was cut at the cap: candidates past it were never taken
  if (!stopped && hits.length < limit && ranked.length > SOURCE_SCAN_MAX) stopped = true;
  return { hits, weaker, terms: wanted, stopped, read };
}
