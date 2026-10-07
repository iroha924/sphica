// Forgetting chosen sources on a real database: rows and index entries go, units that cited them are judged again, and the bytes
// do not stay in the file.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { beginGlean, checkText } from "../src/extract.ts";
import { applyForget, type ForgetOutcome, forgetText, previewForget } from "../src/forget.ts";
import { lookOverview } from "../src/overview.ts";
import { readUnit } from "../src/read.ts";
import { sha256 } from "../src/text.ts";
import { at, insert, message, plan, project, run, statements, type TempDb, tempDb } from "./temp-db.ts";

let db: TempDb;
let p: number;
beforeEach(() => {
  db = tempDb();
  p = project(db);
});
afterEach(() => db.done());

const now = at("2026-09-20T00:00:00Z");
type Values = Record<string, string | number | Buffer | null>;
const one = (text: string, ...args: (string | number)[]) =>
  db.owner.prepare(text).get(...args) as Record<string, unknown>;
const sql = (text: string, ...args: (string | number | null)[]) => db.owner.prepare(text).run(...args);

const unit = (key: string, kind: string, v: Values = {}) =>
  insert(db, "unit", {
    project_id: p,
    key,
    kind,
    stance: ["decision", "constraint"].includes(kind) ? "do" : null,
    text: key,
    extraction: "supported",
    run_id: run(db, p),
    created_at: now,
    content_hash: sha256(key),
    ...v,
  });
const runOf = (u: number) => Number(one("select run_id from unit where id = ?", u).run_id);
const evidence = (u: number, source: number, v: Values = {}) =>
  insert(db, "unit_evidence", {
    unit_id: u,
    source_id: source,
    span_start: 0,
    span_end: 3,
    role: "states",
    run_id: runOf(u),
    added_at: now,
    ...v,
  });
const adoption = (u: number, source: number) =>
  insert(db, "unit_adoption", {
    unit_id: u,
    route: "owner_statement",
    source_id: source,
    span_start: 0,
    span_end: 3,
    run_id: runOf(u),
    added_at: now,
  });
const move = (u: number, from: string | null, to: string, source: number | null = null) =>
  sql(
    "insert into unit_state (unit_id, from_state, to_state, at, reason, source_id, run_id) values (?, ?, ?, ?, 'r', ?, ?)",
    u,
    from,
    to,
    now,
    source,
    runOf(u),
  );
const activate = (u: number, source: number | null = null) => {
  move(u, null, "candidate");
  move(u, "candidate", "active", source);
};
const lifecycle = (u: number) => one("select lifecycle from unit where id = ?", u).lifecycle;
const exists = (id: number) => Number(one("select count(*) as n from source where id = ?", id).n) === 1;
const indexed = (word: string) =>
  Number(one("select count(*) as n from source_fts where source_fts match ?", word).n);

/**
 * Previews, then applies what the preview showed (the owner's confirmation). On the way it checks that nothing either step asks the
 * database scans a table that grows with the records.
 */
async function forget(...ids: number[]) {
  let seen: Awaited<ReturnType<typeof previewForget>> | undefined;
  let done: Awaited<ReturnType<typeof applyForget>> | undefined;
  const asked = await statements(async () => {
    seen = await previewForget(db.file, p, ids);
    done = await applyForget(db.file, p, ids, seen);
  });
  const queries = asked.filter((s) => /^(select|delete|update|insert)/i.test(s));
  // Sources still held that nobody asked about would pass the check below by default
  if (seen?.sources.length)
    assert.ok(
      queries.some((s) => /"unit_evidence"/.test(s)),
      "the forget looks at what cites the sources",
    );
  for (const s of queries)
    assert.doesNotMatch(
      plan(db, s),
      /SCAN (unit_evidence|unit_adoption|unit_state|unit_field|field_def|source_forgotten|source_processing)\b/,
      s,
    );
  if (!done) throw new Error("the forget did not finish");
  return done;
}

test("forgetting the only source of an active decision removes the row and its index entry, and the decision leaves active", async () => {
  const src = message(db, p, { id: "m1", text: "Use SQLite. Decided." });
  const u = unit("u1", "decision");
  evidence(u, src);
  adoption(u, src);
  activate(u, src);
  assert.equal(indexed("sqlite"), 1);
  const { outcome, cleanup } = await forget(src);
  assert.equal(exists(src), false);
  assert.equal(indexed("sqlite"), 0);
  assert.equal(lifecycle(u), "candidate");
  assert.deepEqual(outcome.units, [{ key: "u1", before: "active", after: "candidate", removed: 2 }]);
  assert.equal(cleanup, "done");
  // The state history keeps its rows; the one that cited the source no longer points at it
  assert.deepEqual(
    db.owner
      .prepare(
        "select source_id, forget_id is not null as forgot from unit_state where unit_id = ? order by id",
      )
      .all(u)
      .map((r) => ({ ...r })),
    [
      { source_id: null, forgot: 0 },
      { source_id: null, forgot: 0 },
      { source_id: null, forgot: 1 },
    ],
  );
});

test("a decision with another source for its evidence and adoption stays active", async () => {
  const a = message(db, p, { id: "m1", text: "Use SQLite." });
  const b = message(db, p, { id: "m2", text: "Yes, SQLite. Decided." });
  const u = unit("u1", "decision");
  evidence(u, a);
  evidence(u, b);
  adoption(u, b);
  activate(u, b);
  const { outcome } = await forget(a);
  assert.equal(lifecycle(u), "active");
  assert.deepEqual(outcome.units, [{ key: "u1", before: "active", after: "active", removed: 1 }]);
});

test("an implementation stays active on its commit anchor, and leaves active when the forgotten commit was its only support", async () => {
  const said = message(db, p, { id: "m1", text: "Implemented the cache." });
  const anchored = unit("impl-anchor", "implementation");
  evidence(anchored, said, { role: "implements" });
  insert(db, "unit_anchor", {
    unit_id: anchored,
    path: "server/src/cache.ts",
    commit_sha: "a".repeat(40),
    role: "evidence",
    run_id: runOf(anchored),
    added_at: now,
  });
  activate(anchored);
  const commit = insert(db, "source", {
    project_id: p,
    kind: "commit_message",
    artifact: `commit:${"b".repeat(40)}`,
    external_id: "b".repeat(40),
    revision: 1,
    author_kind: "person",
    created_at: now,
    captured_at: now,
    text: "feat: add the cache",
    original_bytes: 19,
    content_hash: sha256("feat: add the cache"),
    indexed: 1,
  });
  const committed = unit("impl-commit", "implementation");
  evidence(committed, commit, { role: "implements" });
  activate(committed);
  await forget(said, commit);
  assert.equal(lifecycle(anchored), "active");
  assert.equal(lifecycle(committed), "candidate");
});

test("superseded, withdrawn, and candidate units keep their state and lose only the forgotten rows", async () => {
  const src = message(db, p, { id: "m1", text: "Use SQLite." });
  const next = message(db, p, { id: "m2", text: "Use Postgres." });
  const old = unit("old", "finding");
  evidence(old, src);
  activate(old);
  const successor = unit("new", "finding");
  evidence(successor, next);
  activate(successor);
  insert(db, "unit_link", {
    from_unit: successor,
    to_unit: old,
    kind: "supersedes",
    run_id: runOf(successor),
    added_at: now,
  });
  insert(db, "unit_replacement", {
    from_unit: successor,
    to_unit: old,
    run_id: runOf(successor),
    started_at: now,
  });
  move(old, "active", "superseded");
  const gone = unit("gone", "finding");
  evidence(gone, src);
  move(gone, null, "candidate");
  move(gone, "candidate", "withdrawn");
  const waiting = unit("waiting", "finding");
  evidence(waiting, src);
  move(waiting, null, "candidate");
  const { outcome } = await forget(src);
  assert.deepEqual([old, gone, waiting].map(lifecycle), ["superseded", "withdrawn", "candidate"]);
  assert.deepEqual(
    outcome.units.map((u) => [u.key, u.before, u.after]),
    [
      ["old", "superseded", "superseded"],
      ["gone", "withdrawn", "withdrawn"],
      ["waiting", "candidate", "candidate"],
    ],
  );
});

test("forgetting a retraction's reason removes the retracted row it explained", async () => {
  const src = message(db, p, { id: "m1", text: "Use SQLite." });
  const reason = message(db, p, { id: "m2", text: "No, that was wrong. See https://notes.example/x" });
  const u = unit("u1", "finding");
  evidence(u, src);
  evidence(u, src, { role: "explains" });
  sql(
    "update unit_evidence set retracted_at = ?, retraction_reason = 'wrong', retraction_source_id = ?, retraction_span_start = 0, retraction_span_end = 3 where unit_id = ? and role = 'states'",
    now,
    reason,
    u,
  );
  const { outcome } = await forget(reason);
  // Judged from what is left, as a save would: its live evidence makes the finding active
  assert.deepEqual(outcome.units, [{ key: "u1", before: "candidate", after: "active", removed: 1 }]);
  assert.deepEqual(
    db.owner
      .prepare("select role from unit_evidence where unit_id = ?")
      .all(u)
      .map((r) => r.role),
    ["explains"],
  );
});

test("nothing is forgotten when what the sources support changed after the preview", async () => {
  const src = message(db, p, { id: "m1", text: "Use SQLite." });
  const u = unit("u1", "finding");
  evidence(u, src);
  const seen: ForgetOutcome = await previewForget(db.file, p, [src]);
  assert.equal(exists(src), true, "the preview rolls back");
  const later = unit("u2", "finding");
  evidence(later, src);
  await assert.rejects(applyForget(db.file, p, [src], seen), /changed after you confirmed/);
  assert.equal(exists(src), true);
  assert.equal(Number(one("select count(*) as n from source_forgotten").n), 0);
});

test("an unknown id or another project's id is refused, and an id already forgotten runs only the cleanup", async () => {
  const other = project(db, "git:github.com/o/other", "o/other");
  const foreign = message(db, other, { id: "m9", text: "someone else's", session: "s9" });
  const src = message(db, p, { id: "m1", text: "Use SQLite." });
  await assert.rejects(previewForget(db.file, p, [999]), /s999 is not a source of this project/);
  await assert.rejects(
    previewForget(db.file, p, [foreign]),
    new RegExp(`s${foreign} is not a source of this project`),
  );
  await forget(src);
  const again = await forget(src);
  assert.deepEqual(again.outcome, {
    sources: [],
    already: [src],
    units: [],
    fields: { definitions: 0, values: 0 },
    anchorReasons: 0,
  });
  assert.equal(again.cleanup, "done");
});

const secret = "zq-secret-7d41c9e2";
const inFiles = () =>
  [db.file, `${db.file}-wal`].some((f) => fs.existsSync(f) && fs.readFileSync(f).includes(secret));

test("the forgotten text leaves no bytes in the database file or its WAL", async () => {
  const src = message(db, p, { id: "m1", text: `the token is ${secret} for staging` });
  const u = unit("u1", "finding");
  evidence(u, src);
  db.owner.exec("pragma wal_checkpoint(TRUNCATE)");
  assert.equal(inFiles(), true);
  const { cleanup } = await forget(src);
  assert.equal(cleanup, "done");
  assert.equal(inFiles(), false);
});

test("a unit's own copy of the forgotten text stays in the bytes (a documented limit)", async () => {
  const src = message(db, p, { id: "m1", text: `the token is ${secret}` });
  const u = unit(`uses ${secret}`, "finding");
  evidence(u, src);
  await forget(src);
  assert.equal(inFiles(), true);
  assert.equal(one("select text from unit where id = ?", u).text, `uses ${secret}`);
});

test("a reader holding the WAL leaves the cleanup incomplete, and running the same ids again finishes it", async () => {
  const src = message(db, p, { id: "m1", text: "Use SQLite." });
  db.owner.exec("begin");
  db.owner.prepare("select count(*) from source").get();
  const first = await forget(src);
  db.owner.exec("commit");
  assert.equal(first.cleanup, "incomplete");
  assert.equal(exists(src), false);
  const again = await forget(src);
  assert.equal(again.cleanup, "done");
});

test("a call cancelled before the commit forgets nothing", async () => {
  const src = message(db, p, { id: "m1", text: "Use SQLite." });
  const seen = await previewForget(db.file, p, [src]);
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(
    applyForget(db.file, p, [src], seen, stop.signal),
    /cancelled, so nothing was forgotten/,
  );
  assert.equal(exists(src), true);
});

test("forgetting only a reconsider condition's quote leaves the decision active, and its condition shows as unsupported", async () => {
  const said = message(db, p, { id: "m1", text: "Use SQLite. Decided." });
  const cond = message(db, p, { id: "m2", text: "If we need replicas, look at Postgres again." });
  const u = unit("u1", "decision");
  const option = insert(db, "unit_option", {
    unit_id: u,
    position: 1,
    text: "Postgres",
    outcome: "rejected",
    reconsider_when: "if replicas are needed",
  });
  evidence(u, said);
  evidence(u, cond, { option_id: option, role: "reconsiders", span_start: 0, span_end: 20 });
  adoption(u, said);
  activate(u, said);
  const { outcome } = await forget(cond);
  assert.equal(lifecycle(u), "active");
  assert.deepEqual(outcome.units, [{ key: "u1", before: "active", after: "active", removed: 1 }]);
  assert.match(
    (await readUnit(db.reader, p, "u1", null)) ?? "",
    /Reconsider when: if replicas are needed \[unsupported/,
  );
  assert.match(
    await lookOverview(db.reader, p, null),
    /- u1: rejected option Postgres, reconsider when: if replicas are needed \[unsupported/,
  );
});

/** A tenant field defined from `defined`, and a value on each unit quoting `quoted` (or the definition's source when not given). */
const fields = (defined: number, values: { unit: number; quoted?: number }[]) => {
  const d = insert(db, "field_def", {
    project_id: p,
    name: "tenant",
    type: "text",
    label: "Tenant",
    description: "The tenant affected",
    source_id: defined,
    span_start: 0,
    span_end: 5,
    run_id: run(db, p),
    added_at: now,
  });
  for (const v of values)
    insert(db, "unit_field", {
      unit_id: v.unit,
      field_def_id: d,
      value: "acme",
      source_id: v.quoted ?? defined,
      span_start: 0,
      span_end: 4,
      run_id: runOf(v.unit),
      added_at: now,
    });
};
const values = () => Number(one("select count(*) as n from unit_field").n);
const definitions = () => Number(one("select count(*) as n from field_def").n);
const units = (word: string) =>
  Number(one("select count(*) as n from unit_fts where unit_fts match ?", `"${word}"`).n);
const revision = (u: number) => Number(one("select revision from unit where id = ?", u).revision);

test("forgetting a field definition's source removes the definition and every value of it, as the preview counted", async () => {
  const defined = message(db, p, { id: "m1", text: "Track the tenant." });
  const said = message(db, p, { id: "m2", text: "acme hit it." });
  const u1 = unit("u1", "finding");
  const u2 = unit("u2", "finding");
  evidence(u1, said);
  evidence(u2, said);
  fields(defined, [{ unit: u1 }, { unit: u2, quoted: said }]);
  assert.equal(units("acme"), 2);
  const seen = await previewForget(db.file, p, [defined]);
  assert.deepEqual(seen.fields, { definitions: 1, values: 2 });
  assert.match(forgetText(seen, db.file), /1 field definition and 2 field values go with them/);
  assert.equal(values(), 2, "the preview rolls back");
  const [r1, r2] = [revision(u1), revision(u2)];
  const { outcome, cleanup } = await applyForget(db.file, p, [defined], seen);
  assert.deepEqual(outcome.fields, { definitions: 1, values: 2 });
  assert.equal(cleanup, "done");
  assert.equal(definitions(), 0);
  assert.equal(values(), 0);
  assert.equal(units("acme"), 0);
  assert.ok(revision(u1) > r1 && revision(u2) > r2);
});

test("forgetting only a value's quoted source removes that value, keeps the definition, and a glean made before is refused", async () => {
  const defined = message(db, p, { id: "m1", text: "Track the tenant." });
  const said = message(db, p, { id: "m2", text: "acme hit it." });
  const reason = message(db, p, { id: "m3", text: "Drop that finding." });
  const u = unit("u1", "finding");
  evidence(u, reason);
  fields(defined, [{ unit: u, quoted: said }]);
  const read = revision(u);
  const seen = await previewForget(db.file, p, [said]);
  assert.deepEqual(seen.fields, { definitions: 0, values: 1 });
  await applyForget(db.file, p, [said], seen);
  assert.equal(definitions(), 1);
  assert.equal(values(), 0);
  assert.equal(units("acme"), 0);
  const withdraw = {
    ops: [
      { op: "withdraw", unit: "u1", revision: read, reason_source: `s${reason}`, reason_quote: "Drop that" },
    ],
  };
  const checked = await checkText(db.ingest, await beginGlean(db.ingest, p, "s1"), p, null, withdraw);
  assert.equal(checked.ok, false);
  assert.match(checked.text, /changed since you read it/);
});

test("a value's words leave no bytes once its quoted source is forgotten, and the owner is told records keep their own text", async () => {
  const defined = message(db, p, { id: "m1", text: "Track the tenant." });
  const said = message(db, p, { id: "m2", text: `${secret} hit it.` });
  const reason = message(db, p, { id: "m3", text: "It is slow." });
  const u = unit("u1", "finding");
  evidence(u, reason);
  const d = insert(db, "field_def", {
    project_id: p,
    name: "tenant",
    type: "text",
    label: "Tenant",
    description: "The tenant affected",
    source_id: defined,
    span_start: 0,
    span_end: 5,
    run_id: run(db, p),
    added_at: now,
  });
  insert(db, "unit_field", {
    unit_id: u,
    field_def_id: d,
    value: secret,
    source_id: said,
    span_start: 0,
    span_end: secret.length,
    run_id: runOf(u),
    added_at: now,
  });
  db.owner.exec("pragma wal_checkpoint(TRUNCATE)");
  assert.equal(inFiles(), true);
  const seen = await previewForget(db.file, p, [said]);
  assert.deepEqual(seen.units, []);
  assert.match(forgetText(seen, db.file), /Records keep their own text/);
  const { cleanup } = await applyForget(db.file, p, [said], seen);
  assert.equal(cleanup, "done");
  assert.equal(inFiles(), false);
});

// A backup made before a migration still holds the words; the owner is told where, before typing the count and after
test("the preview and the result name the backups made before migrating, and say nothing of them when there are none", async () => {
  const src = message(db, p, { id: "m1", text: "a secret" });
  const seen = await previewForget(db.file, p, [src]);
  assert.doesNotMatch(forgetText(seen, db.file), /backup/);
  const dir = path.join(path.dirname(db.file), "backups");
  fs.mkdirSync(dir);
  for (const name of [
    "sphica.rev2.20260901T000000000Z.10.db",
    "sphica.rev3.20260902T000000000Z.11.db",
    "sphica.rev3.20260903T000000000Z.12.db.partial",
  ])
    fs.writeFileSync(path.join(dir, name), "");
  const told = forgetText(seen, db.file);
  assert.ok(told.includes(`2 backups made before migrating, in ${dir}`), told);
  assert.match(told, /Delete those backups yourself/);
  // A directory that cannot be listed does not stop forgetting; the owner is told to look there
  fs.chmodSync(dir, 0o300);
  try {
    assert.ok(
      forgetText(seen, db.file).includes(`Backups made before migrating in ${dir} could not be listed`),
    );
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});

test("forgetting the words that moved an anchor removes only that reason: the chain of moves and the live anchor stay", async () => {
  const kept = message(db, p, { id: "m1", text: "Decided: keep it." });
  const moved = message(db, p, { id: "m2", text: "Move it to b.ts." });
  const again = message(db, p, { id: "m3", text: "Move it to c.ts." });
  const u = unit("u1", "decision");
  evidence(u, kept);
  adoption(u, kept);
  activate(u, kept);
  const anchor = (path: string) =>
    insert(db, "unit_anchor", { unit_id: u, path, role: "applies_to", run_id: runOf(u), added_at: now });
  const reason = (id: number, source: number) =>
    insert(db, "unit_anchor_retirement", {
      anchor_id: id,
      run_id: runOf(u),
      source_id: source,
      span_start: 0,
      span_end: 4,
      added_at: now,
    });
  const [a, b] = [anchor("a.ts"), anchor("b.ts")];
  sql("update unit_anchor set retired_at = ?, replaced_by = ? where id = ?", now, b, a);
  reason(a, moved);
  const c = anchor("c.ts");
  sql("update unit_anchor set retired_at = ?, replaced_by = ? where id = ?", now, c, b);
  reason(b, again);
  const seen = await previewForget(db.file, p, [moved]);
  assert.equal(seen.anchorReasons, 1);
  assert.match(
    forgetText(seen, db.file),
    /1 reason for retiring or moving an anchor goes with them; the anchors stay retired/,
  );
  const before = revision(u);
  const { outcome } = await applyForget(db.file, p, [moved], seen);
  assert.equal(outcome.anchorReasons, 1);
  const anchors = db.owner
    .prepare(
      "select id, retired_at is not null as retired, replaced_by from unit_anchor where unit_id = ? order by id",
    )
    .all(u)
    .map((r) => ({ ...r }));
  assert.deepEqual(anchors, [
    { id: a, retired: 1, replaced_by: b },
    { id: b, retired: 1, replaced_by: c },
    { id: c, retired: 0, replaced_by: null },
  ]);
  assert.deepEqual(
    db.owner
      .prepare("select anchor_id from unit_anchor_retirement order by anchor_id")
      .all()
      .map((r) => r.anchor_id),
    [b],
  );
  assert.equal(lifecycle(u), "active");
  assert.ok(revision(u) > before);
});
