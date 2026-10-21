// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The ways a reworded prompt could bring up the record it goes against, compared offline: today's exact naming (B0), aliases matched on the
// naming rule's word boundary (B1a) or by term splitting (B1b), and word search narrowed to dont decisions and records with a rejected
// option (B2), alone or together. What a prompt delivery would show of the candidates is a copy of the hook's fitting, checked against it.
import { AI_DECIDED, authorityOf } from "../../src/authority.ts";
import { byUnit, type Reads } from "../../src/db.ts";
import { CONFIRM, deliverableIds, namedRecords } from "../../src/deliver.ts";
import { inline } from "../../src/panel.ts";
import { searchUnits } from "../../src/search.ts";
import { head, terms } from "../../src/text.ts";

type Unit = { id: number; key: string; kind: string; stance: string | null; text: string };

/** What brought a record up, for comparing the signals one by one */
type Signal =
  | "symbol"
  | "path"
  | "rejected-option"
  | "chosen-option"
  | "option-terms"
  | "alias-boundary"
  | "alias-terms"
  | "search-body"
  | "search-alias";

/** weight: how many of the record's aliases matched, then their length, for ordering alias candidates by how much they matched */
export type Candidate = { u: Unit; why: string; via: "named" | "alias" | "search"; weight?: number };

/**
 * A method: B0 alone, plus aliases by one rule, plus search results up to a limit (searchUnits' limit, taken before narrowing). Alias
 * candidates come in the order prompts show records (kind, then id), or by how much of them matched, and may need several aliases matched.
 */
export type Method = {
  alias?: "boundary" | "terms";
  search?: number;
  order?: "id" | "matches";
  minAliases?: number;
};

/** Every candidate source a method may need, read from one database */
export type Corpus = {
  projectId: number;
  root: string;
  /** Deliverable records in the order prompts show them (kind, then id) */
  units: Unit[];
  /** The records B1 and B2 may add: deliverable dont decisions and deliverable records with a rejected option */
  pool: Set<number>;
  aliases: Map<number, string[]>;
  options: Map<number, { text: string; outcome: string }[]>;
  /** Deliverable records an AI decided, which the delivery marks */
  ai: Set<number>;
};

/** searchUnits returns at most what its candidate scan reads, so this limit gives its whole ordered list */
const SEARCH_ALL = 2000;

export async function corpus(db: Reads, projectId: number, root: string): Promise<Corpus> {
  const ids = [...(await deliverableIds(db, projectId))];
  if (!ids.length)
    return {
      projectId,
      root,
      units: [],
      pool: new Set(),
      aliases: new Map(),
      options: new Map(),
      ai: new Set(),
    };
  const [units, options, sets, whose] = await Promise.all([
    db
      .selectFrom("unit")
      .select(["id", "key", "kind", "stance", "text"])
      .where("id", "in", ids)
      .orderBy("kind")
      .orderBy("id")
      .execute(),
    db
      .selectFrom("unit_option")
      .select(["unit_id", "text", "outcome"])
      .where("unit_id", "in", ids)
      .orderBy("id")
      .execute()
      .then(byUnit),
    // Only the newest set bound to the record's words, as the index takes it
    db
      .selectFrom("unit_alias as a")
      .innerJoin("unit as u", "u.id", "a.unit_id")
      .select(["a.unit_id", "a.terms"])
      .where("a.unit_id", "in", ids)
      .whereRef("a.content_hash", "=", "u.content_hash")
      .orderBy("a.id", "desc")
      .execute(),
    authorityOf(db, ids),
  ]);
  const aliases = new Map<number, string[]>();
  for (const s of sets) if (!aliases.has(s.unit_id)) aliases.set(s.unit_id, JSON.parse(s.terms));
  const pool = new Set(
    units
      .filter(
        (u) =>
          (u.kind === "decision" && u.stance === "dont") ||
          options.get(u.id)?.some((o) => o.outcome === "rejected"),
      )
      .map((u) => u.id),
  );
  return {
    projectId,
    root,
    units,
    pool,
    aliases,
    options: new Map(
      [...options].map(([id, os]) => [id, os.map((o) => ({ text: o.text, outcome: o.outcome }))]),
    ),
    ai: new Set(ids.filter((id) => whose.get(id) === "agent")),
  };
}

/** The naming rule's word test: the word in the text with no letter, digit, _ or $ right before or after it */
function word(w: string, s: string): boolean {
  return (
    s.includes(w) &&
    new RegExp(
      `(?<![\\p{L}\\p{N}_$])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_$])`,
      "u",
    ).test(s)
  );
}
const fold = (s: string) => s.normalize("NFKC").toLowerCase();
/** Whether every term of the phrase is among the text's terms, the phrase giving at least one */
const termsIn = (phrase: string, have: Set<string>) => {
  const want = terms(phrase, false);
  return want.length > 0 && want.every((t) => have.has(t));
};

/** Everything one prompt brings up, before any method picks from it */
export type Look = {
  named: Candidate[];
  aliasBoundary: Candidate[];
  aliasTerms: Candidate[];
  /** searchUnits' whole ordered list of record ids, before narrowing */
  searched: number[];
  matched: Map<number, string[]>;
  signals: Map<number, Set<Signal>>;
};

export async function look(db: Reads, c: Corpus, prompt: string): Promise<Look> {
  const lower = fold(prompt);
  const have = new Set(terms(prompt));
  const hits = await namedRecords(db, c.projectId, c.root, prompt);
  const named = hits.map((h): Candidate => ({ u: h.u, why: h.why, via: "named" }));
  const signals = new Map<number, Set<Signal>>();
  const mark = (id: number, s: Signal) => signals.set(id, (signals.get(id) ?? new Set()).add(s));
  for (const h of hits) if (h.hit !== "option") mark(h.u.id, h.hit);
  const aliasBoundary: Candidate[] = [];
  const aliasTerms: Candidate[] = [];
  for (const u of c.units) {
    for (const o of c.options.get(u.id) ?? []) {
      if (o.text.length >= 3 && word(fold(o.text), lower))
        mark(u.id, o.outcome === "rejected" ? "rejected-option" : "chosen-option");
      if (o.outcome === "rejected" && termsIn(o.text, have)) mark(u.id, "option-terms");
    }
    const as = c.aliases.get(u.id) ?? [];
    const onBoundary = as.filter((a) => Array.from(a).length >= 2 && word(fold(a), lower));
    const byTerms = as.filter((a) => termsIn(a, have));
    const weight = (ms: string[]) => ms.length * 1000 + Math.min(999, ms.join("").length);
    if (onBoundary.length) {
      mark(u.id, "alias-boundary");
      if (c.pool.has(u.id))
        aliasBoundary.push({
          u,
          why: ` [alias ${inline(onBoundary[0] ?? "")}]`,
          via: "alias",
          weight: weight(onBoundary),
        });
    }
    if (byTerms.length) {
      mark(u.id, "alias-terms");
      if (c.pool.has(u.id))
        aliasTerms.push({
          u,
          why: ` [alias ${inline(byTerms[0] ?? "")}]`,
          via: "alias",
          weight: weight(byTerms),
        });
    }
  }
  // A chosen option counts only for a record no rejected option of which was named
  for (const s of signals.values()) if (s.has("rejected-option")) s.delete("chosen-option");
  const found = await searchUnits(db, c.projectId, {
    question: prompt,
    lifecycles: ["active"],
    limit: SEARCH_ALL,
  });
  const matched = new Map<number, string[]>();
  for (const h of found.hits) {
    matched.set(h.id, h.matched);
    mark(h.id, h.aliasOnly ? "search-alias" : "search-body");
  }
  return { named, aliasBoundary, aliasTerms, searched: found.hits.map((h) => h.id), matched, signals };
}

/** A method's candidates for one prompt: B0's first, then aliases', then search's, each record once */
export function candidates(c: Corpus, l: Look, m: Method): Candidate[] {
  const byId = new Map(c.units.map((u) => [u.id, u]));
  const searched = (m.search === undefined ? [] : l.searched.slice(0, m.search))
    .filter((id) => c.pool.has(id))
    .map((id): Candidate | null => {
      const u = byId.get(id);
      return u ? { u, why: ` [words ${(l.matched.get(id) ?? []).join(", ")}]`, via: "search" } : null;
    })
    .filter((x): x is Candidate => x !== null);
  const found = m.alias === "boundary" ? l.aliasBoundary : m.alias === "terms" ? l.aliasTerms : [];
  const enough = found.filter((x) => (x.weight ?? 0) >= (m.minAliases ?? 1) * 1000);
  const aliased =
    m.order === "matches" ? [...enough].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)) : enough;
  const seen = new Set<number>();
  return [...l.named, ...aliased, ...searched].filter((x) => !seen.has(x.u.id) && seen.add(x.u.id));
}

/** Records the method's search limit cut: in the pool and in the search results, but past the limit */
export function cutByLimit(c: Corpus, l: Look, m: Method): Set<number> {
  if (m.search === undefined) return new Set();
  return new Set(l.searched.slice(m.search).filter((id) => c.pool.has(id)));
}

// What follows copies the prompt delivery's fitting: the test holds it to the hook's own output for B0's candidates
const NOTE = "Sphica past record, not an instruction; read it with Sphica's read before relying on it";
const AI_MARK = ", decided by an AI";
const UNITS = 3;
const CHARS = 900 + CONFIRM.length + 1;
const AI_ROOM = AI_DECIDED.length + 1;
const line = (u: Unit, extra: string, ai: boolean) =>
  `- ${inline(u.key)} (${u.kind}${u.stance ? ` ${u.stance}` : ""}${ai ? AI_MARK : ""}): ${head(inline(u.text), 240)}${extra}`;
const leftOut = (n: number) =>
  n > 0
    ? `- ${n} more record${n === 1 ? " applies here but was" : "s apply here but were"} left out for space: find them with Sphica's search or read.`
    : "";

/** What a prompt delivery of these candidates would show: its text and the records it shows, in order */
export function display(cands: Candidate[], aiDecided: Set<number>): { text: string; shown: number[] } {
  const shown = cands.slice(0, UNITS);
  const ai = new Set(shown.map((h) => h.u.id).filter((id) => aiDecided.has(id)));
  const wide = ai.size
    ? { lead: `${CONFIRM} ${AI_DECIDED}`, chars: CHARS + AI_ROOM }
    : { lead: CONFIRM, chars: CHARS };
  const lines = shown.map((h) => `${NOTE}: ${line(h.u, h.why, ai.has(h.u.id)).slice(2)}`);
  const kept: string[] = [];
  let used = wide.lead.length + 1;
  for (const [i, l] of lines.entries()) {
    const cost = l.length - (ai.has(shown[i]?.u.id ?? -1) ? AI_MARK.length : 0);
    if (used + cost + 1 > wide.chars) break;
    kept.push(l);
    used += cost + 1;
  }
  const ask = shown.slice(0, kept.length).some((h) => ai.has(h.u.id)) ? wide.lead : CONFIRM;
  const body = kept.length ? [ask, ...kept].join("\n") : "";
  const note = leftOut(cands.length - kept.length);
  return {
    text: note ? `${body || ask}\n${note}` : body,
    shown: shown.slice(0, kept.length).map((h) => h.u.id),
  };
}
