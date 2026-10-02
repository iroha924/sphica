// The offline retrieval benchmark: corpus.json's records are saved through the real save path into one database, and every question
// goes to searchUnits. Answerable questions give recall@k and MRR; questions with no gold give how often search returned anything.
// A record may carry anchors and the time it was saved; each is checked as stored before any question runs.
// No model is called, so two versions of search can be compared on the same corpus (run.ts --compare).
import fs from "node:fs";
import path from "node:path";
import { inTransaction } from "../../src/db.ts";
import { checkRecord, saveRecord, type Target } from "../../src/record.ts";
import { searchUnits } from "../../src/search.ts";
import { queryTerms, terms } from "../../src/text.ts";
import { openRun } from "../../src/trace.ts";
import { hash, insert, message, project, type TempDb, tempDb } from "../../test/temp-db.ts";

type Option = { text: string; outcome: string; why?: string };
type CorpusRecord = {
  key: string;
  kind: string;
  stance: string | null;
  message: string;
  quote: string;
  text: string;
  why: string | null;
  options: Option[];
  aliases: string[];
  supersedes: string | null;
  anchors?: { path: string; symbol?: string }[];
  /** When the record was saved (ISO); the save time otherwise */
  created_at?: string;
};
/** set: which group of questions it belongs to (base when absent), so an experiment is judged on the set it targets */
type Question = {
  id: string;
  lang: string;
  overlap: boolean | null;
  text: string;
  gold: string[];
  set?: string;
};
export type Corpus = { records: CorpusRecord[]; questions: Question[] };

const CORPUS = path.join(import.meta.dirname, "corpus.json");
/** How many hits a question may read, the deepest k reported */
const LIMIT = 10;
const KS = [1, 5, 10] as const;

export type Scores = {
  answerable: number;
  recall: Record<(typeof KS)[number], number>;
  mrr: number;
  unanswerable: number;
  /** Share of questions with no gold that still returned a hit */
  falseHit: number;
};
export type Result = {
  all: Scores;
  byLang: Map<string, Scores>;
  byOverlap: Map<string, Scores>;
  bySet: Map<string, Scores>;
  /** Per question: the 1-based rank of the first gold hit (0 when missed), or the number of hits for a question with no gold */
  rows: { id: string; lang: string; set: string; overlap: boolean | null; rank: number; hits: number }[];
};

const keyOf = (key: string) => `trace:ext-${key}/${key}`;

/** A database holding the corpus; closed again when a record cannot be saved, so a failed load leaves nothing open. */
async function load(corpus: Corpus) {
  const db = tempDb();
  try {
    return { db, p: await fill(db, corpus) };
  } catch (e) {
    await db.done();
    throw e;
  }
}

/** Saves each record from its own session, in file order, so a record can supersede one saved before it. */
async function fill(db: TempDb, corpus: Corpus): Promise<number> {
  const p = project(db);
  for (const r of corpus.records) {
    const source = message(db, p, { id: `${r.key}-1`, text: r.message, session: r.key });
    const quote = [{ source: `s${source}`, quote: r.quote }];
    // An active implementation needs code evidence: the same words as a commit message it implements
    const commit =
      r.kind === "implementation"
        ? insert(db, "source", {
            project_id: p,
            kind: "commit_message",
            artifact: `commit:${r.key}`,
            external_id: r.key,
            revision: 1,
            author_kind: "person",
            created_at: r.created_at ?? "2026-09-10T00:00:00.000Z",
            captured_at: r.created_at ?? "2026-09-10T00:00:00.000Z",
            text: r.message,
            original_bytes: Buffer.byteLength(r.message),
            content_hash: hash(),
            indexed: 1,
          })
        : null;
    const unit = {
      key: r.key,
      kind: r.kind,
      ...(r.stance ? { stance: r.stance } : {}),
      text: r.text,
      ...(r.why ? { why: r.why } : {}),
      ...(r.options.length ? { options: r.options } : {}),
      ...(r.aliases.length ? { aliases: r.aliases } : {}),
      ...(r.supersedes ? { supersedes: keyOf(r.supersedes) } : {}),
      ...(r.anchors?.length ? { anchors: r.anchors.map((a) => ({ ...a, role: "applies_to" })) } : {}),
      evidence: [
        { ...quote[0], role: "states" },
        ...(commit ? [{ source: `s${commit}`, quote: r.quote, role: "implements" }] : []),
      ],
      ...(r.kind === "decision" || r.kind === "constraint" ? { adoption: quote } : {}),
    };
    const t: Target = {
      projectId: p,
      origin: "trace",
      prefix: `trace:ext-${r.key}/`,
      sessionId: r.key,
      root: null,
      sources: null,
    };
    await inTransaction(db.ingest, async (trx) => {
      const runId = await openRun(trx, {
        projectId: p,
        origin: "trace",
        target: `session:${r.key}`,
        sessionId: r.key,
        draftId: `bench-${r.key}`,
      });
      const checked = await checkRecord(trx, t, { units: [unit] });
      // A record saved partly would score as a search miss, so any refusal or left-out part stops the benchmark
      if (checked.errors.length || checked.problems.length)
        throw new Error(`record ${r.key}: ${[...checked.errors, ...checked.problems].join("; ")}`);
      // The save path stamps Date.now(); the bench process alone sees a fixed clock while this record is saved
      const now = Date.now;
      if (r.created_at) {
        const fixed = Date.parse(r.created_at);
        Date.now = () => fixed;
      }
      try {
        await saveRecord(trx, t, runId, checked, []);
      } finally {
        Date.now = now;
      }
    });
  }
  await stored(db, p, corpus);
  return p;
}

/** Stops the benchmark when a record was not stored as written: a wrong time, anchor, or lifecycle would score as a search result. */
async function stored(db: TempDb, p: number, corpus: Corpus) {
  const replaced = new Set(corpus.records.flatMap((r) => (r.supersedes ? [r.supersedes] : [])));
  for (const r of corpus.records) {
    const u = await db.reader
      .selectFrom("unit")
      .select(["id", "lifecycle", "created_at"])
      .where("project_id", "=", p)
      .where("key", "=", keyOf(r.key))
      .executeTakeFirstOrThrow();
    const want = replaced.has(r.key) ? "superseded" : "active";
    if (u.lifecycle !== want) throw new Error(`record ${r.key}: stored as ${u.lifecycle}, not ${want}`);
    if (r.created_at && u.created_at !== new Date(r.created_at).toISOString())
      throw new Error(`record ${r.key}: stored at ${u.created_at}, not ${r.created_at}`);
    const anchors = await db.reader
      .selectFrom("unit_anchor")
      .select(["path", "symbol"])
      .where("unit_id", "=", u.id)
      .where("retired_at", "is", null)
      .orderBy("id")
      .execute();
    const got = anchors.map((a) => `${a.path}#${a.symbol ?? ""}`).join(", ");
    const wanted = (r.anchors ?? []).map((a) => `${a.path}#${a.symbol ?? ""}`).join(", ");
    if (got !== wanted) throw new Error(`record ${r.key}: anchors stored as [${got}], not [${wanted}]`);
  }
}

function score(rows: Result["rows"], answerable: (r: Result["rows"][number]) => boolean): Scores {
  const yes = rows.filter(answerable);
  const no = rows.filter((r) => !answerable(r));
  const share = (n: number, of: number) => (of ? n / of : Number.NaN);
  return {
    answerable: yes.length,
    recall: Object.fromEntries(
      KS.map((k) => [k, share(yes.filter((r) => r.rank > 0 && r.rank <= k).length, yes.length)]),
    ) as Scores["recall"],
    mrr: share(
      yes.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0),
      yes.length,
    ),
    unanswerable: no.length,
    falseHit: share(no.filter((r) => r.hits > 0).length, no.length),
  };
}

export async function bench(corpus: Corpus = JSON.parse(fs.readFileSync(CORPUS, "utf8"))): Promise<Result> {
  const { db, p } = await load(corpus);
  try {
    const gold = new Map(corpus.questions.map((q) => [q.id, q]));
    const rows: Result["rows"] = [];
    for (const q of corpus.questions) {
      const { hits } = await searchUnits(db.reader, p, { question: q.text, limit: LIMIT });
      const keys = hits.map((h) => h.key);
      const rank = q.gold.length ? keys.findIndex((k) => q.gold.map(keyOf).includes(k)) + 1 : 0;
      rows.push({
        id: q.id,
        lang: q.lang,
        set: q.set ?? "base",
        overlap: q.overlap,
        rank,
        hits: keys.length,
      });
    }
    const answerable = (r: Result["rows"][number]) => (gold.get(r.id)?.gold.length ?? 0) > 0;
    const group = (by: (r: Result["rows"][number]) => string) => {
      const out = new Map<string, Scores>();
      for (const g of [...new Set(rows.map(by))].sort())
        out.set(
          g,
          score(
            rows.filter((r) => by(r) === g),
            answerable,
          ),
        );
      return out;
    };
    return {
      all: score(rows, answerable),
      byLang: group((r) => r.lang),
      byOverlap: group((r) => (r.overlap === null ? "no gold" : r.overlap ? "overlap" : "no overlap")),
      bySet: group((r) => `set ${r.set}`),
      rows,
    };
  } finally {
    await db.done();
  }
}

/**
 * Why a missing question term is not in the gold record's terms: split when the gold holds its characters inside a longer word,
 * identifier when those characters are Latin (a part of an identifier, which #204's identifier experiment covers), vocabulary otherwise.
 * The check is by characters, so a one-character term found inside an unrelated word also counts as split.
 */
export type MissCause = "split" | "identifier" | "vocabulary";
export type Miss = {
  id: string;
  lang: string;
  gold: string;
  matched: string[];
  missing: { term: string; cause: MissCause }[];
  /** The one cause of its missing terms, or mixed; ranked when every term matched and the record was still not returned */
  cause: MissCause | "mixed" | "ranked";
  /** Whether the question would hold more than half of its terms if only the Japanese split misses were fixed */
  splitAlone: boolean;
};

/** The Japanese-side questions the bench missed (ja>ja and ja>en), with each missing term and its cause. */
export function misses(result: Result, corpus: Corpus = JSON.parse(fs.readFileSync(CORPUS, "utf8"))): Miss[] {
  const records = new Map(corpus.records.map((r) => [r.key, r]));
  const out: Miss[] = [];
  for (const row of result.rows) {
    const q = corpus.questions.find((x) => x.id === row.id);
    if (!q?.gold.length || row.rank > 0 || !["ja>ja", "ja>en"].includes(q.lang)) continue;
    // The closest gold: the one holding most of the question's terms
    const judged = q.gold.map((key) => {
      const r = records.get(key);
      if (!r) throw new Error(`question ${q.id}: no record ${key}`);
      const body = [
        r.text,
        r.why,
        ...r.options.flatMap((o) => [o.text, o.why]),
        ...(r.anchors ?? []).flatMap((a) => [a.path, a.symbol]),
        ...r.aliases,
      ]
        .filter(Boolean)
        .join("\n");
      const own = new Set(terms(body));
      const flat = body.normalize("NFKC").toLowerCase();
      const wanted = queryTerms(q.text);
      const matched = wanted.filter((w) => own.has(w));
      // A term the gold holds as characters but not as a term was cut differently; one it lacks entirely is another word
      const missing = wanted
        .filter((w) => !own.has(w))
        .map((term) => ({
          term,
          cause: (!flat.includes(term)
            ? "vocabulary"
            : /^[\p{Script=Latin}0-9]/u.test(term)
              ? "identifier"
              : "split") as MissCause,
        }));
      const fixable = matched.length + missing.filter((m) => m.cause === "split").length;
      return { key, matched, missing, splitAlone: fixable * 2 > wanted.length };
    });
    const best = judged.sort((a, b) => b.matched.length - a.matched.length)[0];
    if (!best) continue;
    const causes = new Set(best.missing.map((m) => m.cause));
    out.push({
      id: q.id,
      lang: q.lang,
      gold: best.key,
      matched: best.matched,
      missing: best.missing,
      cause: causes.size === 0 ? "ranked" : causes.size > 1 ? "mixed" : (best.missing[0]?.cause ?? "ranked"),
      splitAlone: best.splitAlone && causes.has("split"),
    });
  }
  return out;
}
