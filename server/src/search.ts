// Search over records (units) and retained sources. Ranked word search (FTS5 bm25) finds candidates; a candidate counts as a hit only
// when it holds more than half of the question's content terms (text.ts queryTerms). Weaker matches are counted, not shown, so a question
// with no answer comes back empty instead of returning whatever shares one word with it.
import { type Kysely, sql } from "kysely";
import type { DB } from "./db-types.ts";
import type { LIFECYCLES, UNIT_KINDS } from "./knowledge.ts";
import { ftsQuery, queryTerms, terms } from "./text.ts";

/** Candidates taken from the index before the term check. */
const POOL = 200;
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
): Promise<{ hits: UnitHit[]; weaker: number; terms: string[] }> {
  const wanted = queryTerms(q.question);
  const match = ftsQuery(q.question);
  if (!match) return { hits: [], weaker: 0, terms: wanted };
  let query = db
    .selectFrom(
      sql<{
        rowid: number;
        rank: number;
      }>`(select rowid, bm25(unit_fts, 3, 2, 1) as rank from unit_fts where unit_fts match ${match} limit ${POOL})`.as(
        "f",
      ),
    )
    .innerJoin("unit as u", "u.id", "f.rowid")
    .where("u.project_id", "=", projectId)
    .where("u.extraction", "=", "supported")
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
    ]);
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
  const rows = await query.execute();
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
  const hits: (UnitHit & { rank: number })[] = [];
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
    if (!strong(matched.length, wanted.length)) {
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
  // A superseded hit points to what replaced it: the live successor joins the hits even when it shares no word with the question
  const shown = new Set(hits.map((h) => h.id));
  for (const h of [...hits].filter((x) => x.lifecycle === "superseded")) {
    const next = await db
      .selectFrom("unit_link as l")
      .innerJoin("unit as n", "n.id", "l.from_unit")
      .where("l.to_unit", "=", h.id)
      .where("l.kind", "=", "supersedes")
      .where("n.extraction", "=", "supported")
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
  return { hits: hits.slice(0, q.limit).map(({ rank: _rank, ...h }) => h), weaker, terms: wanted };
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
): Promise<{ hits: SourceHit[]; weaker: number; terms: string[] }> {
  const wanted = queryTerms(question);
  const match = ftsQuery(question);
  if (!match) return { hits: [], weaker: 0, terms: wanted };
  const rows = await db
    .selectFrom(
      sql<{
        rowid: number;
        rank: number;
      }>`(select rowid, bm25(source_fts) as rank from source_fts where source_fts match ${match} limit ${POOL})`.as(
        "f",
      ),
    )
    .innerJoin("source as s", "s.id", "f.rowid")
    .where("s.project_id", "=", projectId)
    .select([
      "s.id",
      "s.kind",
      "s.artifact",
      "s.author_kind",
      "s.author_login",
      "s.created_at",
      "s.text",
      "f.rank",
    ])
    .orderBy("f.rank")
    .execute();
  let weaker = 0;
  const hits: SourceHit[] = [];
  for (const r of rows) {
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
  }
  return { hits: hits.slice(0, limit), weaker, terms: wanted };
}
