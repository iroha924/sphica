// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Measures `search` with `asked` on a fixed corpus: of the earlier owner messages it returns, how many a person would call unrelated,
// and how many related ones it misses. Relatedness comes from the corpus, never from a model. Run: node evals/asked/run.ts (from server/)
import fs from "node:fs";
import path from "node:path";
import { askedBefore } from "../../src/asked.ts";
import { message, project, tempDb } from "../../test/temp-db.ts";

type Corpus = {
  sessions: { id: string; messages: { id: string; text: string }[] }[];
  queries: { id: string; lang: string; text: string; related: string[] }[];
};

const corpus = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "corpus.json"), "utf8")) as Corpus;
const db = tempDb();
try {
  const p = project(db);
  const external = new Map<number, string>();
  for (const s of corpus.sessions)
    for (const m of s.messages) external.set(message(db, p, { id: m.id, text: m.text, session: s.id }), m.id);
  let returned = 0;
  let unrelated = 0;
  let missed = 0;
  let related = 0;
  const rows: string[] = [];
  for (const q of corpus.queries) {
    const r = await askedBefore(db.reader, p, { question: q.text, limit: 8, notSessions: ["now"] });
    const got = r.messages.map((e) => external.get(e.message.id) ?? String(e.message.id)).sort();
    const bad = got.filter((id) => !q.related.includes(id));
    const miss = q.related.filter((id) => !got.includes(id));
    returned += got.length;
    unrelated += bad.length;
    missed += miss.length;
    related += q.related.length;
    rows.push(
      `${q.id} (${q.lang}): returned ${got.length}, unrelated ${bad.length}${bad.length ? ` [${bad.join(", ")}]` : ""}, missed ${miss.length}${miss.length ? ` [${miss.join(", ")}]` : ""}${got.length ? "" : ", empty"}${r.stopped ? ", stopped" : ""}`,
    );
  }
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");
  console.log(rows.join("\n"));
  console.log(
    `\nunrelated / returned: ${unrelated} / ${returned} (${pct(unrelated, returned)})\nmissed / related: ${missed} / ${related} (${pct(missed, related)})`,
  );
} finally {
  await db.done();
}
