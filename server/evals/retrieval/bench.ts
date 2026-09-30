// The offline retrieval benchmark: corpus.json's records are saved through the real save path into one database, and every question
// goes to searchUnits. Answerable questions give recall@k and MRR; questions with no gold give how often search returned anything.
// No model is called, so two versions of search can be compared on the same corpus (run.ts --compare).
import fs from "node:fs";
import path from "node:path";
import { inTransaction } from "../../src/db.ts";
import { checkRecord, saveRecord, type Target } from "../../src/record.ts";
import { searchUnits } from "../../src/search.ts";
import { openRun } from "../../src/trace.ts";
import { message, project, tempDb } from "../../test/temp-db.ts";

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
};
type Question = { id: string; lang: string; overlap: boolean | null; text: string; gold: string[] };
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
  /** Per question: the 1-based rank of the first gold hit (0 when missed), or the number of hits for a question with no gold */
  rows: { id: string; lang: string; overlap: boolean | null; rank: number; hits: number }[];
};

const keyOf = (key: string) => `trace:ext-${key}/${key}`;

/** Saves each record from its own session, in file order, so a record can supersede one saved before it. */
async function load(corpus: Corpus) {
  const db = tempDb();
  const p = project(db);
  for (const r of corpus.records) {
    const source = message(db, p, { id: `${r.key}-1`, text: r.message, session: r.key });
    const quote = [{ source: `s${source}`, quote: r.quote }];
    const unit = {
      key: r.key,
      kind: r.kind,
      ...(r.stance ? { stance: r.stance } : {}),
      text: r.text,
      ...(r.why ? { why: r.why } : {}),
      ...(r.options.length ? { options: r.options } : {}),
      ...(r.aliases.length ? { aliases: r.aliases } : {}),
      ...(r.supersedes ? { supersedes: keyOf(r.supersedes) } : {}),
      evidence: [{ ...quote[0], role: "states" }],
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
      await saveRecord(trx, t, runId, checked, []);
    });
  }
  return { db, p };
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
      rows.push({ id: q.id, lang: q.lang, overlap: q.overlap, rank, hits: keys.length });
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
      rows,
    };
  } finally {
    await db.done();
  }
}
