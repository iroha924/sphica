// What a delivery says about each record: when it was saved, who adopted it, whose words it rests on, and where its anchors stand now.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inTransaction } from "../src/db.ts";
import { provenance, speakerOf } from "../src/provenance.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { openRun } from "../src/trace.ts";
import { insert, message, project, type TempDb, tempDb } from "./temp-db.ts";

async function save(db: TempDb, p: number, record: unknown, root: string) {
  const t: Target = {
    projectId: p,
    origin: "trace",
    prefix: "trace:ext-s1/",
    sessionId: "s1",
    root,
    sources: null,
  };
  return inTransaction(db.ingest, async (trx) => {
    const run = await openRun(trx, {
      projectId: p,
      origin: "trace",
      target: "session:s1",
      sessionId: "s1",
      draftId: `d${Math.random()}`,
    });
    return saveRecord(trx, t, run, await checkRecord(trx, t, record), []);
  });
}

/** A pull request comment by someone with this association, as harvest would keep it. */
function comment(db: TempDb, p: number, id: string, association: string, text: string): number {
  const now = "2026-09-10T00:00:00.000Z";
  return insert(db, "source", {
    project_id: p,
    kind: "pr_comment",
    artifact: "pr:41",
    external_id: id,
    revision: 1,
    author_kind: "person",
    author_login: id,
    author_association: association,
    created_at: now,
    available_at: now,
    captured_at: now,
    text,
    original_bytes: Buffer.byteLength(text),
    content_hash: Buffer.from(id.padEnd(32, "0")),
    indexed: 1,
  });
}

test("speakers: the owner, a maintainer by membership, an agent or bot, and everyone else", () => {
  assert.equal(speakerOf({ author_kind: "owner", author_association: null }), "owner");
  assert.equal(speakerOf({ author_kind: "person", author_association: "OWNER" }), "owner");
  assert.equal(speakerOf({ author_kind: "person", author_association: "MEMBER" }), "maintainer");
  assert.equal(speakerOf({ author_kind: "person", author_association: "COLLABORATOR" }), "maintainer");
  assert.equal(speakerOf({ author_kind: "person", author_association: "CONTRIBUTOR" }), "third_party");
  assert.equal(speakerOf({ author_kind: "bot", author_association: "NONE" }), "assistant");
  assert.equal(speakerOf({ author_kind: "assistant", author_association: null }), "assistant");
});

test("provenance reads the saved month, the strongest live adopter, live speakers with hearsay as a third party, the worst anchor, and the quote", async (t) => {
  const db = tempDb();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-prov-")));
  t.after(async () => {
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
  });
  execFileSync("git", ["init", "-q", root]);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const keep = 1;\nexport const moved = 2;\n");
  fs.writeFileSync(path.join(root, "src", "b.ts"), "export const gone = 1;\n");
  const p = project(db);
  const m = message(db, p, { id: "m1", text: "Keep it. Kai said ship on Fridays. Move it." });
  const saved = await save(
    db,
    p,
    {
      units: [
        {
          key: "keep",
          kind: "decision",
          stance: "do",
          text: "Keep it",
          evidence: [{ source: `s${m}`, quote: "Keep it.", role: "states" }],
          adoption: [{ source: `s${m}`, quote: "Keep it." }],
          anchors: [
            { path: "src/a.ts", symbol: "keep", role: "applies_to" },
            { path: "src/b.ts", symbol: "gone", role: "applies_to" },
          ],
        },
        {
          key: "hearsay",
          kind: "decision",
          stance: "do",
          text: "Ship on Fridays",
          evidence: [
            { source: `s${m}`, quote: "Kai said ship on Fridays.", role: "states", reported_speaker: "Kai" },
          ],
          anchors: [{ path: "src/a.ts", symbol: "moved", role: "applies_to" }],
        },
      ],
    },
    root,
  );
  assert.ok(saved, "saved");
  const ids = Object.fromEntries(
    db.owner
      .prepare("select key, id from unit")
      .all()
      .map((r) => [String(r.key), Number(r.id)]),
  ) as Record<string, number>;
  // The code moves on: one anchor's symbol moves down, another's is deleted
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const keep = 1;\n\n\nexport const moved = 2;\n");
  fs.writeFileSync(path.join(root, "src", "b.ts"), "export const other = 1;\n");
  // A contributor's words and a maintainer's reply adopting them, and a retracted owner adoption that no longer counts
  const runId = Number(db.owner.prepare("select run_id from unit_evidence limit 1").get()?.run_id);
  const now = "2026-09-11T00:00:00.000Z";
  const c = comment(db, p, "c1", "CONTRIBUTOR", "Upload every backup.");
  const r = comment(db, p, "c2", "MEMBER", "Sounds good.");
  insert(db, "unit_evidence", {
    unit_id: ids["trace:ext-s1/hearsay"] ?? 0,
    source_id: c,
    span_start: 0,
    span_end: 20,
    role: "states",
    run_id: runId,
    added_at: now,
  });
  insert(db, "unit_adoption", {
    unit_id: ids["trace:ext-s1/hearsay"] ?? 0,
    route: "explicit",
    source_id: r,
    span_start: 0,
    span_end: 12,
    run_id: runId,
    added_at: now,
  });
  const got = await provenance(db.reader, Object.values(ids), root);
  const keep = got.get(ids["trace:ext-s1/keep"] ?? 0);
  const hearsay = got.get(ids["trace:ext-s1/hearsay"] ?? 0);
  assert.match(keep?.saved ?? "", /^\d{4}-\d{2}$/);
  assert.equal(keep?.adopter, "owner");
  assert.deepEqual(keep?.speakers, ["owner"]);
  assert.equal(keep?.anchor, "missing", "the worst of located and missing");
  assert.equal(keep?.quote, "Keep it.");
  assert.equal(hearsay?.adopter, "maintainer");
  assert.deepEqual(
    hearsay?.speakers,
    ["third_party"],
    "the owner's hearsay and the contributor are both third parties",
  );
  assert.equal(hearsay?.anchor, "moved");
  // A third party's words added to the owner's record count, and stop counting once retracted
  const extra = insert(db, "unit_evidence", {
    unit_id: ids["trace:ext-s1/keep"] ?? 0,
    source_id: c,
    span_start: 0,
    span_end: 20,
    role: "explains",
    run_id: runId,
    added_at: now,
  });
  const keepId = ids["trace:ext-s1/keep"] ?? 0;
  assert.deepEqual((await provenance(db.reader, [keepId], root)).get(keepId)?.speakers, [
    "owner",
    "third_party",
  ]);
  db.owner
    .prepare(
      "update unit_evidence set retracted_at = ?, retraction_reason = 'wrong', retraction_source_id = ?, retraction_span_start = 0, retraction_span_end = 4 where id = ?",
    )
    .run("2026-09-12T00:00:00.000Z", m, extra);
  assert.deepEqual((await provenance(db.reader, [keepId], root)).get(keepId)?.speakers, ["owner"]);
  assert.equal((await provenance(db.reader, [], root)).size, 0);
});
