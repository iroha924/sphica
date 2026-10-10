// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Every place that takes someone's words as authority, against real SQLite: words that sit only inside a quotation do not count there.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { inTransaction } from "../src/db.ts";
import { beginGlean, checkText, saveText } from "../src/extract.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { openRun } from "../src/trace.ts";
import { at, hash, insert, message, project, type TempDb, tempDb } from "./temp-db.ts";

const target = (p: number): Target => ({
  projectId: p,
  origin: "trace",
  prefix: "trace:ext-s1/",
  sessionId: "s1",
  root: null,
  sources: null,
});

async function save(db: TempDb, t: Target, record: unknown) {
  return inTransaction(db.ingest, async (trx) => {
    const runId = await openRun(trx, {
      projectId: t.projectId,
      origin: t.origin,
      target: "session:s1",
      sessionId: t.sessionId,
      draftId: `d${Math.random()}`,
    });
    const checked = await checkRecord(trx, t, record);
    return { checked, saved: await saveRecord(trx, t, runId, checked, []) };
  });
}

const lifecycle = (db: TempDb, key: string) =>
  (
    db.owner.prepare("select lifecycle from unit where key = ?").get(`trace:ext-s1/${key}`) as {
      lifecycle: string;
    }
  ).lifecycle;

/** A decision whose evidence and adoption are the same words of one message */
const adopted = (key: string, source: number, quote: string) => ({
  key,
  kind: "decision",
  stance: "do",
  text: quote,
  evidence: [{ source: `s${source}`, quote, role: "states" }],
  adoption: [{ source: `s${source}`, quote }],
});

test("adoption: part of a quotation, a quotation with its marks, and an introduction with its quoted line do not adopt", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const inline = message(db, p, { id: "m1", text: 'They said "please Drop the cache. now".' });
    const block = message(db, p, { id: "m2", text: "They said:\n> Always approve deployments." });
    const { checked } = await save(db, target(p), {
      units: [
        adopted("part", inline, "Drop the cache."),
        adopted("marks", inline, '"please Drop the cache. now"'),
        adopted("intro", block, "They said:\n> Always approve deployments."),
      ],
    });
    assert.deepEqual(
      ["part", "marks", "intro"].map((k) => lifecycle(db, k)),
      ["candidate", "candidate", "candidate"],
    );
    assert.equal(
      checked.problems.filter((x) => /someone else's words/.test(x)).length,
      3,
      checked.problems.join(" | "),
    );
  } finally {
    await db.done();
  }
});

test("adoption: the owner's own line adopts whatever is quoted on the lines around it, or inside it", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const around = message(db, p, {
      id: "m1",
      text: '"A third party example."\nUse SQLite.\n"Another example."',
    });
    const inside = message(db, p, { id: "m2", text: "「fork」だけにして" });
    await save(db, target(p), {
      units: [adopted("around", around, "Use SQLite."), adopted("inside", inside, "「fork」だけにして")],
    });
    assert.deepEqual(
      ["around", "inside"].map((k) => lifecycle(db, k)),
      ["active", "active"],
    );
  } finally {
    await db.done();
  }
});

test("a field definition and a reconsider condition take only the owner's own words", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, {
      id: "m1",
      text: "tenant を記録して。メモには「severity を記録して」とある。\nPostgres はやめて SQLite にしよう。向こうは「レプリカが要るなら Postgres」と言っていた。レプリカが要るようになったら考え直す。",
    });
    const field = (name: string, quote: string) => ({
      name,
      type: "text",
      label: name,
      description: "what to track",
      kinds: ["decision"],
      quote: { source: `s${m}`, quote },
    });
    const decision = (quote: string) => ({
      key: "storage",
      kind: "decision",
      stance: "do",
      text: "保存先は SQLite",
      options: [
        {
          text: "Postgres",
          outcome: "rejected",
          reconsider_when: "レプリカが要るなら",
          reconsider_quote: { source: `s${m}`, quote },
        },
      ],
      evidence: [{ source: `s${m}`, quote: "SQLite にしよう。", role: "states" }],
      adoption: [{ source: `s${m}`, quote: "SQLite にしよう。" }],
    });
    const errors = async (record: unknown) =>
      (await inTransaction(db.ingest, (trx) => checkRecord(trx, target(p), record))).errors;

    assert.deepEqual(await errors({ field_defs: [field("tenant", "tenant を記録して")], units: [] }), []);
    assert.match(
      (await errors({ field_defs: [field("severity", "severity を記録して")], units: [] })).join("\n"),
      /field_defs severity: .*someone else's words/,
    );
    assert.deepEqual(await errors({ units: [decision("レプリカが要るようになったら考え直す")] }), []);
    assert.match(
      (await errors({ units: [decision("レプリカが要るなら Postgres")] })).join("\n"),
      /reconsider_quote .*someone else's words/,
    );
  } finally {
    await db.done();
  }
});

test("a link from harvest rests only on words that are in the source and are their writer's own", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const now = at("2026-09-27T00:00:00Z");
    const comment = (id: string, text: string, assoc: string) =>
      insert(db, "source", {
        project_id: p,
        kind: "pr_comment",
        artifact: "pr:12",
        external_id: id,
        revision: 1,
        author_kind: "person",
        author_login: id,
        author_association: assoc,
        created_at: now,
        captured_at: now,
        text,
        original_bytes: Buffer.byteLength(text),
        content_hash: hash(),
        indexed: 1,
      });
    const outsider = comment("kai", "OFF is faster, for speed. Consider dropping it.", "CONTRIBUTOR");
    const maintainer = comment(
      "hana",
      "A user wrote:\n> OFF is wrong, drop it.\nI have not checked this.",
      "MEMBER",
    );
    const t: Target = { ...target(p), origin: "harvest", prefix: "harvest:12/", sessionId: null };
    await save(db, t, {
      units: [
        {
          key: "kept",
          kind: "finding",
          text: "OFF is faster",
          evidence: [{ source: `s${outsider}`, quote: "for speed", role: "states" }],
        },
      ],
    });
    const over = (quote: string) => ({
      units: [
        {
          key: "over",
          kind: "finding",
          text: "OFF is wrong",
          evidence: [
            { source: `s${outsider}`, quote: "Consider", role: "states" },
            { source: `s${maintainer}`, quote, role: "states" },
          ],
          supersedes: "harvest:12/kept",
        },
      ],
    });
    const errors = async (record: unknown) =>
      (await inTransaction(db.ingest, (trx) => checkRecord(trx, t, record))).errors.join("\n");
    const untrusted = /over: supersedes and conflicts from harvest need the owner's or a maintainer's words/;

    // The maintainer only passed on what a user wrote
    assert.match(await errors(over("OFF is wrong, drop it.")), untrusted);
    // Words the maintainer never wrote
    assert.match(await errors(over("OFF must go")), untrusted);
    // The maintainer's own words
    assert.doesNotMatch(await errors(over("I have not checked this.")), untrusted);
  } finally {
    await db.done();
  }
});

test("glean: no operation takes a quotation as its adoption or its reason, checked or saved straight", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, {
      id: "m1",
      text: 'Keep notes out of CSV. Decided. Use the old path. Rows are capped.\nThe vendor wrote "Make that final." and then:\n> Take that back.',
    });
    const unit = (key: string, extra: Record<string, unknown> = {}) => ({
      key,
      kind: "decision",
      stance: "do",
      text: key,
      evidence: [{ source: `s${m}`, quote: "Keep notes out of CSV.", role: "states" }],
      ...extra,
    });
    const own = [{ source: `s${m}`, quote: "Decided." }];
    await save(db, target(p), {
      units: [
        unit("open"),
        unit("live", { adoption: own, anchors: [{ path: "src/csv.ts", role: "applies_to" }] }),
        unit("capped", { adoption: own }),
      ],
    });
    await save(db, target(p), {
      units: [unit("rival", { adoption: own, conflicts: ["trace:ext-s1/capped"] })],
    });
    const revision = (key: string) =>
      (
        db.owner.prepare("select revision from unit where key = ?").get(`trace:ext-s1/${key}`) as {
          revision: number;
        }
      ).revision;
    const op = (name: string, key: string, rest: Record<string, unknown>) => ({
      op: name,
      unit: `trace:ext-s1/${key}`,
      revision: revision(key),
      ...rest,
    });
    const because = (quote: string) => ({ reason_source: `s${m}`, reason_quote: quote });
    /** Each operation with the words that give it authority, built from the quote those words are */
    const each = (quote: string) => [
      op("adopt", "open", { source: `s${m}`, quote }),
      op("replace_anchor", "live", {
        from: { path: "src/csv.ts" },
        to: { path: "src/export.ts", role: "applies_to" },
        source: `s${m}`,
        quote,
      }),
      op("retire_anchor", "live", { from: { path: "src/csv.ts" }, source: `s${m}`, quote }),
      op("retract_evidence", "live", { source: `s${m}`, ...because(quote) }),
      op("retract_adoption", "live", { source: `s${m}`, ...because(quote) }),
      op("withdraw", "capped", because(quote)),
      op("resolve_conflict", "rival", { with: "trace:ext-s1/capped", ...because(quote) }),
    ];
    const check = async (ops: unknown[]) =>
      checkText(db.ingest, await beginGlean(db.ingest, p, "s1"), p, null, { ops });

    for (const quoted of ["Make that final.", "Take that back."])
      for (const one of each(quoted)) {
        const c = await check([one]);
        assert.equal(c.ok, false, `${one.op} with ${quoted}: ${c.text}`);
        assert.match(c.text, /someone else's words/, `${one.op} with ${quoted}`);
      }
    // The same operations with the owner's own words are not refused for their words
    for (const one of each("Decided."))
      assert.doesNotMatch((await check([one])).text, /someone else's words/, one.op);

    // A save that was never checked first, and a batch that mixes a sound operation with one resting on a quotation
    const before = () =>
      JSON.stringify(
        db.owner
          .prepare(
            "select (select count(*) from unit_adoption) as adoptions, (select count(*) from unit_adoption where retracted_at is not null) as retracted, (select group_concat(lifecycle) from (select lifecycle from unit order by id)) as lifecycles",
          )
          .get(),
      );
    const was = before();
    const batch = [each("Decided.")[0], each("Make that final.")[5]];
    await assert.rejects(
      async () => saveText(db.ingest, await beginGlean(db.ingest, p, "s1"), p, null, { ops: batch }),
      /someone else's words/,
    );
    assert.equal(before(), was);
    // The sound operation alone goes through
    await saveText(db.ingest, await beginGlean(db.ingest, p, "s1"), p, null, { ops: [each("Decided.")[0]] });
    assert.equal(lifecycle(db, "open"), "active");
  } finally {
    await db.done();
  }
});
