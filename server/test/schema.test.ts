// Whether the constraints and triggers in db/schema.sql refuse what they should and accept what they should.
// Writes use the owner connection (testing the schema itself, not the authorizer); the capture views are tested through their triggers.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { sha256, terms } from "../src/text.ts";
import { at, insert, message, project, run, session, type TempDb, tempDb } from "./temp-db.ts";

let db: TempDb;
let p: number;
let other: number;
beforeEach(() => {
  db = tempDb();
  p = project(db);
  other = project(db, "git:github.com/o/other", "o/other");
});
afterEach(() => db.done());

const now = at("2026-09-27T00:00:00Z");
type Values = Record<string, string | number | Buffer | null>;
const refuses = (fn: () => unknown, why: RegExp) => assert.throws(fn, why);
const sql = (text: string, ...args: (string | number | Buffer | null)[]) =>
  db.owner.prepare(text).run(...args);
const one = (text: string, ...args: (string | number | null)[]) =>
  db.owner.prepare(text).get(...args) as Record<string, unknown>;

const unit = (v: Values & { key: string; kind: string }, projectId = p, runId?: number) =>
  insert(db, "unit", {
    project_id: projectId,
    stance: ["decision", "constraint"].includes(v.kind) ? "do" : null,
    text: v.key,
    extraction: "supported",
    run_id: runId ?? run(db, projectId),
    created_at: now,
    content_hash: sha256(v.key),
    ...v,
  });
const state = (unitId: number, from: string | null, to: string) =>
  sql(
    "insert into unit_state (unit_id, from_state, to_state, at, reason, run_id) values (?, ?, ?, ?, 'r', (select run_id from unit where id = ?))",
    unitId,
    from,
    to,
    now,
    unitId,
  );
const evidence = (unitId: number, sourceId: number, v: Values = {}) =>
  insert(db, "unit_evidence", {
    unit_id: unitId,
    source_id: sourceId,
    span_start: 0,
    span_end: 3,
    role: "states",
    run_id: Number(one("select run_id from unit where id = ?", unitId).run_id),
    added_at: now,
    ...v,
  });
const adoption = (unitId: number, sourceId: number, v: Values = {}) =>
  insert(db, "unit_adoption", {
    unit_id: unitId,
    route: "owner_statement",
    source_id: sourceId,
    span_start: 0,
    span_end: 3,
    run_id: Number(one("select run_id from unit where id = ?", unitId).run_id),
    added_at: now,
    ...v,
  });
const external = (v: Values) =>
  insert(db, "source", {
    project_id: p,
    revision: 1,
    author_kind: "person",
    created_at: now,
    captured_at: now,
    text: "Consider X",
    original_bytes: 10,
    content_hash: sha256(String(v.external_id)),
    indexed: 1,
    ...v,
  });

// Removing or moving a parent row makes SQLite look for its children. Without an index led by the child's key, that is a scan of the child table
test("every foreign key is led by an index on its own columns", () => {
  const tables = (
    db.owner
      .prepare(
        "select name from sqlite_schema where type = 'table' and sql not like 'CREATE VIRTUAL%' and name not glob '*_fts_*' and name not glob 'sqlite_*'",
      )
      .all() as { name: string }[]
  ).map((t) => t.name);
  assert.ok(tables.length >= 25, tables.join(" "));
  const unled: string[] = [];
  let keys = 0;
  for (const table of tables) {
    const parts = new Map<number, { seq: number; from: string }[]>();
    for (const f of db.owner.prepare(`pragma foreign_key_list(${table})`).all() as {
      id: number;
      seq: number;
      from: string;
    }[])
      parts.set(f.id, [...(parts.get(f.id) ?? []), f]);
    const primary = (db.owner.prepare(`pragma table_info(${table})`).all() as { name: string; pk: number }[])
      .filter((c) => c.pk)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    const indexes = (
      db.owner.prepare(`pragma index_list(${table})`).all() as { name: string; partial: number }[]
    ).map((i) => ({
      columns: (db.owner.prepare(`pragma index_info(${i.name})`).all() as { name: string }[]).map(
        (c) => c.name,
      ),
      // A partial index serves the key only when it leaves out nothing but the rows whose key is null
      where: i.partial
        ? String(one("select sql from sqlite_schema where name = ?", i.name).sql)
            .split(/\bwhere\b/)[1]
            ?.trim()
        : null,
    }));
    for (const key of parts.values()) {
      keys++;
      const columns = key.sort((a, b) => a.seq - b.seq).map((c) => c.from);
      const leads = (index: string[]) => columns.every((c) => index.slice(0, columns.length).includes(c));
      const led =
        leads(primary) ||
        indexes.some(
          (i) =>
            leads(i.columns) &&
            (i.where === null || (columns.length === 1 && i.where === `${columns[0]} is not null`)),
        );
      if (!led) unled.push(`${table} (${columns.join(", ")})`);
    }
  }
  assert.ok(keys >= 50, `${keys} foreign keys`);
  assert.deepEqual(unled, []);
});

test("an edit is observed once per turn, also outside any turn, and a record holds one live anchor per place", () => {
  session(db, p, "s1");
  const observe = (turn: string | null) =>
    sql(
      "insert into capture_edit (session_id, turn_id, tool_event_id, path, via, observed_at) values ('s1', ?, 'e', 'src/a.ts', 'tool', ?)",
      turn,
      now,
    );
  observe(null);
  observe(null);
  observe("t1");
  observe("t1");
  assert.equal(one("select count(*) as n from edit_observation").n, 2);
  const u = unit({ key: "u1", kind: "finding" });
  const runId = Number(one("select run_id from unit where id = ?", u).run_id);
  const anchor = (v: Values) =>
    insert(db, "unit_anchor", {
      unit_id: u,
      path: "src/a.ts",
      role: "applies_to",
      run_id: runId,
      added_at: now,
      ...v,
    });
  const first = anchor({ symbol: "open", line_start: 3, line_end: 3 });
  refuses(() => anchor({ symbol: "open", line_start: 9, line_end: 9 }), /UNIQUE constraint failed/);
  // Without a symbol the lines tell places apart
  anchor({ line_start: 1, line_end: 2 });
  anchor({ line_start: 5, line_end: 6 });
  refuses(() => anchor({ line_start: 5, line_end: 6 }), /UNIQUE constraint failed/);
  anchor({ symbol: "open", role: "evidence" });
  // Retired, the place is free again
  sql("update unit_anchor set retired_at = ? where id = ?", now, first);
  anchor({ symbol: "open" });
});

test("the small checks: lines, retraction spans and times, whole characters, dates, replacements, web addresses, and aliases", () => {
  const src = message(db, p, { id: "m1", text: "日本語で決めた。" });
  refuses(
    () => external({ kind: "pr_comment", artifact: "pr:1", external_id: "c1", line_end: 3 }),
    /constraint failed/,
  );
  refuses(
    () => external({ kind: "pr_body", artifact: "pr:2", external_id: "b2", url: "javascript:alert(1)" }),
    /constraint failed/,
  );
  external({ kind: "pr_body", artifact: "pr:3", external_id: "b3", url: "https://github.com/o/r/pull/3" });
  refuses(
    () =>
      insert(db, "source", {
        project_id: p,
        kind: "session_message",
        artifact: "session:s1",
        external_id: "a1",
        revision: 1,
        session_id: "s1",
        author_kind: "assistant",
        created_at: now,
        captured_at: now,
        text: "reply",
        original_bytes: 5,
        content_hash: sha256("reply"),
        indexed: 1,
      }),
    /constraint failed/,
  );
  const u = unit({ key: "u1", kind: "finding" });
  // The first character is three bytes: a span from byte 1 starts inside it, and one ending at byte 4 ends inside the second
  refuses(() => evidence(u, src, { span_start: 1, span_end: 6 }), /inside a character/);
  refuses(() => evidence(u, src, { span_start: 0, span_end: 4 }), /inside a character/);
  const e = evidence(u, src, { span_start: 0, span_end: 6 });
  const retract = (start: number, end: number, when = now) =>
    sql(
      "update unit_evidence set retracted_at = ?, retraction_reason = 'wrong', retraction_source_id = ?, retraction_span_start = ?, retraction_span_end = ? where id = ?",
      when,
      src,
      start,
      end,
      e,
    );
  refuses(() => retract(-1, 3), /constraint failed/);
  refuses(() => retract(0, 3, at("2026-01-01T00:00:00Z")), /constraint failed/);
  refuses(() => retract(1, 3), /inside a character/);
  retract(0, 3);
  const late = unit({ key: "late", kind: "finding", created_at: at("2026-12-01T00:00:00Z") });
  refuses(() => state(late, null, "candidate"), /comes after its unit was created/);
  const r = run(db, p);
  refuses(
    () =>
      sql(
        "update extraction_run set status = 'saved', finished_at = ? where id = ?",
        at("2020-01-01T00:00:00Z"),
        r,
      ),
    /constraint failed/,
  );
  const runId = Number(one("select run_id from unit where id = ?", u).run_id);
  const anchor = (unitId: number, path: string) =>
    insert(db, "unit_anchor", { unit_id: unitId, path, role: "applies_to", run_id: runId, added_at: now });
  const a1 = anchor(u, "a.ts");
  const elsewhere = anchor(late, "b.ts");
  refuses(
    () => sql("update unit_anchor set retired_at = ?, replaced_by = ? where id = ?", now, a1, a1),
    /same record/,
  );
  refuses(
    () => sql("update unit_anchor set retired_at = ?, replaced_by = ? where id = ?", now, elsewhere, a1),
    /same record/,
  );
  refuses(
    () =>
      insert(db, "unit_alias", {
        unit_id: u,
        terms: '["x"]',
        content_hash: sha256("other words"),
        run_id: runId,
        added_at: now,
      }),
    /bound to the words of its unit/,
  );
  insert(db, "unit_alias", {
    unit_id: u,
    terms: '["x"]',
    content_hash: sha256("u1"),
    run_id: runId,
    added_at: now,
  });
});

test("the database carries its generation and revision", () => {
  assert.deepEqual({ ...one("select generation from sphica_generation") }, { generation: 2 });
  assert.equal(one("pragma user_version").user_version, 5);
});

test("capture writes only owner or assistant messages into a session's own project, and refuses a changed resend", () => {
  session(db, p, "s1");
  const put = (id: string, speaker: string, text: string) =>
    sql(
      "insert into capture_message (external_id, session_id, turn_id, speaker, created_at, captured_at, text, truncated, redacted, original_bytes, content_hash) values (?, 's1', 't', ?, ?, ?, ?, 0, 0, ?, ?)",
      id,
      speaker,
      now,
      now,
      text,
      Buffer.byteLength(text),
      sha256(text),
    );
  put("m1", "owner", "SQLite にしよう");
  put("m1", "owner", "SQLite にしよう");
  assert.deepEqual(
    { ...one("select project_id, artifact, indexed from source where external_id = 'm1'") },
    {
      project_id: p,
      artifact: "session:s1",
      indexed: 1,
    },
  );
  refuses(() => put("m2", "person", "hi"), /owner or assistant/);
  refuses(() => put("m1", "owner", "Postgres にしよう"), /different content/);
  refuses(
    () =>
      sql(
        "insert into capture_message (external_id, session_id, turn_id, speaker, created_at, captured_at, text, truncated, redacted, original_bytes, content_hash) values ('m1', 's1', 't', 'assistant', ?, ?, 'forged', 0, 0, 6, ?)",
        now,
        now,
        sha256("SQLite にしよう"),
      ),
    /different content/,
  );
  // A message id is unique within its session only: another session may carry the same id and text
  session(db, p, "s2");
  sql(
    "insert into capture_message (external_id, session_id, turn_id, speaker, created_at, captured_at, text, truncated, redacted, original_bytes, content_hash) values ('m1', 's2', 't', 'owner', ?, ?, 'SQLite にしよう', 0, 0, ?, ?)",
    now,
    now,
    Buffer.byteLength("SQLite にしよう"),
    sha256("SQLite にしよう"),
  );
  assert.equal(one("select count(*) as n from source where external_id = 'm1'")?.n, 2);
});

test("an external source claims the owner only through a bound identity, and sources are never rewritten", () => {
  refuses(
    () =>
      external({
        kind: "pr_comment",
        artifact: "pr:1",
        external_id: "c1",
        author_kind: "owner",
        author_external_id: "9",
      }),
    /bound owner identity/,
  );
  sql(
    "insert into owner_identity (provider, external_id, login, bound_at) values ('github', '9', 'me', ?)",
    now,
  );
  const id = external({
    kind: "pr_comment",
    artifact: "pr:1",
    external_id: "c2",
    author_kind: "owner",
    author_external_id: "9",
  });
  refuses(() => sql("update source set text = 'x' where id = ?", id), /never rewritten/);
});

test("file excerpts need a normalized repository path, both line bounds, and hex object ids", () => {
  const excerpt = (path: string, extra: Values = {}) =>
    external({
      kind: "file_excerpt",
      artifact: `file:${path}`,
      external_id: `${path}@x`,
      path,
      line_start: 1,
      line_end: 1,
      commit_sha: "a".repeat(40),
      blob_sha: "b".repeat(40),
      indexed: 0,
      ...extra,
    });
  excerpt("docs/運用メモ.md");
  for (const bad of [
    "C:\\Windows\\win.ini",
    "../x",
    "/etc/passwd",
    "a//b",
    "./a",
    "a/./b",
    "a\\b",
    "a/.",
    "src/a\u0001.ts",
    "a\u007f",
  ])
    refuses(() => excerpt(bad), /constraint failed/);
  // Edit observations and anchors take the same rule: an anchor meets an observation by its exact path
  session(db, p, "s1");
  const u = unit({ key: "paths", kind: "finding" });
  for (const bad of ["a//b", "./a", "a/./b", "src/a\u0001.ts", "a\u007f", "a/.."]) {
    refuses(
      () =>
        sql(
          "insert into edit_observation (session_id, turn_id, path, via, observed_at) values ('s1', 't', ?, 'tool', ?)",
          bad,
          now,
        ),
      /constraint failed/,
    );
    refuses(
      () =>
        insert(db, "unit_anchor", {
          unit_id: u,
          path: bad,
          role: "applies_to",
          run_id: Number(one("select run_id from unit where id = ?", u).run_id),
          added_at: now,
        }),
      /constraint failed/,
    );
  }
  refuses(() => excerpt("src/a.ts", { line_end: null }), /constraint failed/);
  refuses(() => excerpt("src/b.ts", { commit_sha: "G".repeat(40) }), /constraint failed/);
});

test("units start as candidates and change lifecycle only through state events that check the rules", () => {
  const src = message(db, p, { id: "m1", text: "Use SQLite. Decided." });
  refuses(() => unit({ key: "u0", kind: "decision", lifecycle: "active" }), /start as candidates/);
  const u = unit({ key: "u1", kind: "decision" });
  state(u, null, "candidate");
  refuses(() => state(u, "candidate", "active"), /needs unretracted evidence and adoption/);
  evidence(u, src);
  adoption(u, src);
  state(u, "candidate", "active");
  assert.equal(one("select lifecycle from unit where id = ?", u).lifecycle, "active");
  refuses(() => sql("update unit set lifecycle = 'withdrawn' where id = ?", u), /only through unit_state/);
  refuses(() => sql("update unit set text = 'x' where id = ?", u), /never rewritten/);
  refuses(() => sql("update unit_state set to_state = 'candidate' where unit_id = ?", u), /append-only/);
  refuses(() => state(u, "candidate", "withdrawn"), /from_state must be the current lifecycle/);
});

test("what a unit was saved with stays as saved: a quarantined unit is never marked supported, and revision rises only by one", () => {
  const src = message(db, p, { id: "m1", text: "Use SQLite. Decided." });
  const u = unit({ key: "u1", kind: "decision", no_code_surface: "a policy, no code" });
  state(u, null, "candidate");
  evidence(u, src);
  adoption(u, src);
  state(u, "candidate", "active");
  refuses(() => sql("update unit set no_code_surface = null where id = ?", u), /never rewritten/);
  refuses(
    () => sql("update unit set created_at = ? where id = ?", at("2020-01-01T00:00:00Z"), u),
    /never rewritten/,
  );
  const revision = Number(one("select revision from unit where id = ?", u).revision);
  refuses(() => sql("update unit set revision = 1 where id = ?", u), /rises by one/);
  refuses(() => sql("update unit set revision = revision + 2 where id = ?", u), /rises by one/);
  refuses(() => sql("update unit set revision = revision where id = ?", u), /rises by one/);
  assert.equal(one("select revision from unit where id = ?", u).revision, revision);
  // The path a quarantined or unsourced unit would take to become active: marked supported or sourced while still a candidate
  const q = unit({
    key: "u2",
    kind: "finding",
    extraction: "quarantined",
    extraction_reason: "quote not found",
  });
  state(q, null, "candidate");
  refuses(
    () => sql("update unit set extraction = 'supported', extraction_reason = null where id = ?", q),
    /never rewritten/,
  );
  refuses(() => sql("update unit set extraction_reason = 'other' where id = ?", q), /never rewritten/);
  const n = unit({ key: "u3", kind: "finding", unsourced: 1 });
  refuses(() => sql("update unit set unsourced = 0 where id = ?", n), /never rewritten/);
  // Relations still raise the revision, one step at a time
  evidence(q, src);
  assert.equal(one("select revision from unit where id = ?", q).revision, 3);
});

test("a lifecycle moves only along the listed transitions, and withdrawn is final", () => {
  const src = message(db, p, { id: "m1", text: "Use SQLite. Decided." });
  const fresh = unit({ key: "fresh", kind: "finding" });
  evidence(fresh, src);
  refuses(() => state(fresh, null, "active"), /first state of a unit is candidate/);
  refuses(() => state(fresh, "withdrawn", "candidate"), /first state of a unit is candidate/);
  const old = unit({ key: "old", kind: "finding" });
  evidence(old, src);
  state(old, null, "candidate");
  refuses(() => state(old, null, "candidate"), /current lifecycle/);
  refuses(() => state(old, "candidate", "candidate"), /not a lifecycle change/);
  state(old, "candidate", "active");
  refuses(() => state(old, "active", "active"), /not a lifecycle change/);
  const next = unit({ key: "next", kind: "finding" });
  evidence(next, src);
  state(next, null, "candidate");
  insert(db, "unit_link", {
    from_unit: next,
    to_unit: old,
    kind: "supersedes",
    run_id: Number(one("select run_id from unit where id = ?", next).run_id),
    added_at: now,
  });
  // A successor that is not active yet replaces nothing
  refuses(() => state(old, "active", "superseded"), /needs a supersedes link from an active successor/);
  state(next, "candidate", "active");
  state(old, "active", "superseded");
  // Two live answers: the old one cannot come back beside its successor
  refuses(() => state(old, "superseded", "active"), /not a lifecycle change/);
  refuses(() => state(old, "superseded", "withdrawn"), /not a lifecycle change/);
  refuses(() => state(old, "superseded", "candidate"), /not a lifecycle change/);
  state(next, "active", "candidate");
  refuses(() => state(old, "superseded", "candidate"), /not a lifecycle change/);
  state(next, "candidate", "withdrawn");
  for (const to of ["candidate", "active", "superseded"])
    refuses(() => state(next, "withdrawn", to), /not a lifecycle change/);
  // Its last live successor withdrawn, the old record is a candidate again, by a state the schema writes
  assert.deepEqual(
    {
      ...one(
        "select from_state, to_state, reason from unit_state where unit_id = ? order by id desc limit 1",
        old,
      ),
    },
    { from_state: "superseded", to_state: "candidate", reason: "its successor was withdrawn" },
  );
  state(old, "candidate", "active");
  state(old, "active", "withdrawn");
  assert.deepEqual(
    [old, next].map((u) => one("select lifecycle from unit where id = ?", u).lifecycle),
    ["withdrawn", "withdrawn"],
  );
});

test("a record has one live successor at a time, of a kind that can replace it", () => {
  const src = message(db, p, { id: "m1", text: "Use SQLite. Decided." });
  const link = (from: number, to: number) =>
    insert(db, "unit_link", {
      from_unit: from,
      to_unit: to,
      kind: "supersedes",
      run_id: Number(one("select run_id from unit where id = ?", from).run_id),
      added_at: now,
    });
  const made = (key: string, kind: string) => {
    const u = unit({ key, kind });
    evidence(u, src);
    state(u, null, "candidate");
    return u;
  };
  const old = made("old", "decision");
  refuses(() => link(made("finding", "finding"), old), /supersedes one of its own kind/);
  const first = made("first", "constraint");
  link(first, old);
  // A candidate successor holds the place: a second one would make two answers once both are adopted
  const second = made("second", "decision");
  refuses(() => link(second, old), /already has a successor that is not withdrawn/);
  state(first, "candidate", "withdrawn");
  link(second, old);
  // A quarantined or unsourced successor can never become active or be withdrawn, so it takes no place
  const other = made("other", "finding");
  const quarantined = unit({
    key: "q",
    kind: "finding",
    extraction: "quarantined",
    extraction_reason: "quote not found",
  });
  state(quarantined, null, "candidate");
  link(quarantined, other);
  const unsourced = unit({ key: "n", kind: "finding", unsourced: 1 });
  state(unsourced, null, "candidate");
  link(unsourced, other);
  const sourced = made("sourced", "finding");
  link(sourced, other);
  // Its only live successor withdrawn, the record comes back, though the quarantined and unsourced ones still point at it
  state(other, "candidate", "active");
  state(sourced, "candidate", "active");
  state(other, "active", "superseded");
  state(sourced, "active", "withdrawn");
  assert.equal(one("select lifecycle from unit where id = ?", other).lifecycle, "candidate");
  // And from there a superseded record with only quarantined or unsourced successors left may be moved back by hand too
  state(other, "candidate", "withdrawn");
  assert.deepEqual(
    db.owner
      .prepare("select from_unit from unit_link where to_unit = ? order by from_unit")
      .all(old)
      .map((r) => r.from_unit),
    [first, second],
    "the withdrawn successor's link stays",
  );
});

test("support is judged by one rule: a retraction or a retired anchor that takes it away is refused while the unit is active", () => {
  const src = message(db, p, { id: "m1", text: "Use SQLite. Decided." });
  const retract = (id: number) =>
    sql(
      "update unit_evidence set retracted_at = ?, retraction_reason = 'wrong', retraction_source_id = ?, retraction_span_start = 0, retraction_span_end = 3 where id = ?",
      now,
      src,
      id,
    );
  // Evidence on an option supports the option: left alone with it, the decision has none of its own
  const d = unit({ key: "d1", kind: "decision" });
  const option = insert(db, "unit_option", { unit_id: d, position: 1, text: "SQLite", outcome: "chosen" });
  const own = evidence(d, src);
  evidence(d, src, { option_id: option });
  adoption(d, src);
  state(d, null, "candidate");
  state(d, "candidate", "active");
  refuses(() => retract(own), /back to candidate before retracting its last evidence/);
  state(d, "active", "candidate");
  retract(own);
  refuses(() => state(d, "candidate", "active"), /needs unretracted evidence and adoption/);
  // An implementation's proof can be a commit-pinned anchor: retiring it is the same loss
  const i = unit({ key: "i1", kind: "implementation" });
  evidence(i, src, { role: "implements" });
  const runId = Number(one("select run_id from unit where id = ?", i).run_id);
  const anchor = (path: string, commit: string | null) =>
    insert(db, "unit_anchor", {
      unit_id: i,
      path,
      role: "evidence",
      commit_sha: commit,
      run_id: runId,
      added_at: now,
    });
  const proof = anchor("src/db.ts", "a".repeat(40));
  const plain = anchor("src/other.ts", null);
  state(i, null, "candidate");
  state(i, "candidate", "active");
  const retire = (id: number) => sql("update unit_anchor set retired_at = ? where id = ?", now, id);
  retire(plain);
  refuses(() => retire(proof), /back to candidate before retiring its last code anchor/);
  state(i, "active", "candidate");
  retire(proof);
  refuses(() => state(i, "candidate", "active"), /needs code or commit evidence/);
  assert.deepEqual(
    db.owner
      .prepare("select unit_id, missing from unit_support where unit_id in (?, ?) order by unit_id")
      .all(d, i)
      .map((r) => r.missing),
    [
      "an active decision or constraint needs unretracted evidence and adoption",
      "an active implementation needs code or commit evidence",
    ],
  );
});

test("an unsourced or quarantined unit never becomes active", () => {
  const src = message(db, p, { id: "m1", text: "Use SQLite. Decided." });
  const u = unit({ key: "u2", kind: "constraint", unsourced: 1 });
  evidence(u, src);
  adoption(u, src);
  state(u, null, "candidate");
  refuses(() => state(u, "candidate", "active"), /unsourced unit cannot become active/);
  refuses(() => unit({ key: "u3", kind: "finding", extraction: "quarantined" }), /constraint failed/);
});

test("evidence and adoption stay in their project, inside the text, once, and are retracted rather than deleted", () => {
  const src = message(db, p, { id: "m1", text: "Use SQLite. Decided." });
  const foreign = message(db, other, { id: "m9", text: "other project", session: "s9" });
  const u = unit({ key: "u1", kind: "decision" });
  refuses(() => evidence(u, foreign), /different projects/);
  refuses(() => evidence(u, src, { span_end: 999 }), /outside the source text/);
  evidence(u, src);
  refuses(() => evidence(u, src), /UNIQUE/);
  refuses(() => sql("delete from unit_evidence where unit_id = ?", u), /never deleted/);
  adoption(u, src);
  state(u, null, "candidate");
  state(u, "candidate", "active");
  const retract = (table: string) =>
    sql(
      `update ${table} set retracted_at = ?, retraction_reason = 'wrong', retraction_source_id = ?, retraction_span_start = 0, retraction_span_end = 3 where unit_id = ?`,
      now,
      src,
      u,
    );
  refuses(() => retract("unit_adoption"), /back to candidate/);
  state(u, "active", "candidate");
  retract("unit_adoption");
  refuses(() => retract("unit_adoption"), /retracted, once/);
});

test("only the owner or a maintainer adopts; a contributor's suggestion, a merge, or a thread resolution never does", () => {
  const u = unit({ key: "u1", kind: "decision" });
  const suggestion = external({
    kind: "review_comment",
    artifact: "pr:1",
    external_id: "r1",
    author_association: "CONTRIBUTOR",
  });
  refuses(() => adoption(u, suggestion, { route: "explicit" }), /owner or a maintainer/);
  refuses(() => adoption(u, suggestion), /owner-authored source/);
  const merged = external({
    kind: "pr_event",
    artifact: "pr:1",
    external_id: "e1",
    event_kind: "merged",
    author_association: "OWNER",
    text: "merged",
    original_bytes: 6,
    indexed: 0,
  });
  refuses(() => adoption(u, merged, { route: "explicit" }), /not adoption/);
  const maintainer = external({
    kind: "pr_comment",
    artifact: "pr:1",
    external_id: "c1",
    author_association: "MEMBER",
  });
  adoption(u, maintainer, { route: "explicit" });
});

test("a reported speaker marks the owner's own report, so it must cite an owner session message", () => {
  const owner = message(db, p, { id: "m1", text: "Kimura said it is agreed." });
  const comment = external({ kind: "pr_comment", artifact: "pr:1", external_id: "c1" });
  const u = unit({ key: "u1", kind: "constraint" });
  refuses(() => evidence(u, comment, { reported_speaker: "Kimura" }), /owner session message/);
  evidence(u, owner, { reported_speaker: "Kimura" });
});

test("an implementation becomes active from commit evidence, or from an observed edit of the same path in the same project", () => {
  session(db, p, "s1");
  const said = message(db, p, { id: "m2", text: "Changed src/db.ts to open SQLite.", speaker: "assistant" });
  sql(
    "insert into capture_edit (session_id, turn_id, tool_event_id, path, via, observed_at) values ('s1', 't', 'e1', 'src/db.ts', 'tool', ?)",
    now,
  );
  session(db, other, "s9");
  sql(
    "insert into capture_edit (session_id, turn_id, tool_event_id, path, via, observed_at) values ('s9', 't', 'e9', 'src/other.ts', 'tool', ?)",
    now,
  );
  const u = unit({ key: "i1", kind: "implementation" });
  evidence(u, said, { role: "implements", span_end: 7 });
  const anchor = (path: string, observed: string) =>
    insert(db, "unit_anchor", {
      unit_id: u,
      path,
      role: "evidence",
      edit_observation_id: Number(one("select id from edit_observation where path = ?", observed).id),
      run_id: Number(one("select run_id from unit where id = ?", u).run_id),
      added_at: now,
    });
  refuses(() => anchor("src/db.ts", "src/other.ts"), /same project/);
  state(u, null, "candidate");
  refuses(() => state(u, "candidate", "active"), /code or commit evidence/);
  anchor("src/db.ts", "src/db.ts");
  state(u, "candidate", "active");
});

test("options are sealed with the unit, and aliases are append-only strings", () => {
  const u = unit({ key: "u1", kind: "decision" });
  sql("insert into unit_option (unit_id, position, text, outcome) values (?, 1, 'Postgres', 'rejected')", u);
  refuses(() => sql("update unit_option set text = 'MySQL' where unit_id = ?", u), /never rewritten/);
  const alias = (terms: string) =>
    sql(
      "insert into unit_alias (unit_id, terms, content_hash, run_id, added_at) values (?, ?, ?, (select run_id from unit where id = ?), ?)",
      u,
      terms,
      sha256("u1"),
      u,
      now,
    );
  refuses(() => alias("[null]"), /non-empty string/);
  alias('["database", "データベース"]');
  refuses(
    () =>
      sql("insert into unit_option (unit_id, position, text, outcome) values (?, 2, 'MySQL', 'rejected')", u),
    /before its first state/,
  );
  refuses(() => sql("delete from unit_alias where unit_id = ?", u), /append-only/);
  alias("[]");
});

test("a reconsider condition sits only on a rejected option, and its quote is the owner's on that option", () => {
  const said = message(db, p, {
    id: "m1",
    text: "Use SQLite. If we ever need replicas, look at Postgres again.",
  });
  const ai = message(db, p, {
    id: "m2",
    text: "Postgres would be back if replicas are needed.",
    speaker: "assistant",
  });
  const u = unit({ key: "u1", kind: "decision" });
  const option = (position: number, outcome: string, condition: string | null) =>
    insert(db, "unit_option", {
      unit_id: u,
      position,
      text: `option ${position}`,
      outcome,
      reconsider_when: condition,
    });
  refuses(() => option(1, "chosen", "if replicas are needed"), /CHECK/);
  refuses(() => option(1, "rejected", ""), /CHECK/);
  const plain = option(1, "rejected", null);
  const pg = option(2, "rejected", "if replicas are needed");
  const why = /reconsiders quotes the owner/;
  refuses(() => evidence(u, said, { role: "reconsiders" }), why);
  refuses(() => evidence(u, said, { role: "reconsiders", option_id: plain }), why);
  refuses(() => evidence(u, ai, { role: "reconsiders", option_id: pg }), why);
  evidence(u, said);
  adoption(u, said);
  state(u, null, "candidate");
  refuses(() => state(u, "candidate", "active"), /reconsider condition needs a quote of the owner/);
  // A quote on the option alone is written before the first state in real saves; here the unit is back to a fresh one
  const v = unit({ key: "u2", kind: "decision" });
  const cond = insert(db, "unit_option", {
    unit_id: v,
    position: 1,
    text: "Postgres",
    outcome: "rejected",
    reconsider_when: "if replicas are needed",
  });
  evidence(v, said);
  const quote = evidence(v, said, { role: "reconsiders", option_id: cond, span_start: 12, span_end: 40 });
  adoption(v, said);
  state(v, null, "candidate");
  state(v, "candidate", "active");
  // Retracting only the condition's quote leaves the decision active: the unit still has its own evidence
  sql(
    "update unit_evidence set retracted_at = ?, retraction_reason = 'misread', retraction_source_id = ?, retraction_span_start = 0, retraction_span_end = 3 where id = ?",
    now,
    said,
    quote,
  );
  assert.equal(one("select lifecycle from unit where id = ?", v).lifecycle, "active");
  // Judged again after that retraction (as glean does), the decision comes back: the condition had the owner's words when saved,
  // and readers now show it as unsupported. Forget's recheck, whose quote row is gone, comes back too
  state(v, "active", "candidate");
  state(v, "candidate", "active");
  state(v, "active", "candidate");
  sql(
    "insert into unit_state (unit_id, from_state, to_state, at, reason, forget_id) values (?, 'candidate', 'active', ?, 'r', ?)",
    v,
    now,
    forgetBatch(),
  );
  assert.equal(one("select lifecycle from unit where id = ?", v).lifecycle, "active");
});

test("the unit index finds body, options, and the newest matching aliases, and stops finding cleared aliases", () => {
  const u = unit({ key: "u1", kind: "decision" });
  sql("insert into unit_option (unit_id, position, text, outcome) values (?, 1, 'Postgres', 'rejected')", u);
  // Queries go through the same splitting as the index (Postgres is indexed as its singular form)
  const hits = (q: string) =>
    db.owner.prepare("select rowid from unit_fts where unit_fts match ?").all(`"${terms(q)[0]}"`).length;
  sql(
    "insert into unit_alias (unit_id, terms, content_hash, run_id, added_at) values (?, '[\"データベース\"]', ?, (select run_id from unit where id = ?), ?)",
    u,
    sha256("u1"),
    u,
    now,
  );
  assert.deepEqual([hits("Postgres"), hits("データベース")], [1, 1]);
  sql(
    "insert into unit_alias (unit_id, terms, content_hash, run_id, added_at) values (?, '[]', ?, (select run_id from unit where id = ?), ?)",
    u,
    sha256("u1"),
    u,
    now,
  );
  assert.equal(hits("データベース"), 0);
});

test("links stay in one project, supersedes never cycles, and a conflict is resolved once", () => {
  const a = unit({ key: "a", kind: "question" });
  const b = unit({ key: "b", kind: "question" });
  const r = Number(one("select run_id from unit where id = ?", a).run_id);
  const foreign = unit({ key: "c", kind: "question" }, other);
  const link = (from: number, to: number, kind: string) =>
    sql(
      "insert into unit_link (from_unit, to_unit, kind, run_id, added_at) values (?, ?, ?, ?, ?)",
      from,
      to,
      kind,
      r,
      now,
    );
  refuses(() => link(a, foreign, "conflicts"), /different projects/);
  link(a, b, "supersedes");
  refuses(() => link(b, a, "supersedes"), /cycle/);
  link(a, b, "conflicts");
  refuses(
    () => sql("update unit_link set to_unit = ? where from_unit = ? and kind = 'conflicts'", foreign, a),
    /frozen/,
  );
  sql(
    "update unit_link set resolved_at = ?, resolution = 'chose a' where from_unit = ? and kind = 'conflicts'",
    now,
    a,
  );
  refuses(
    () =>
      sql(
        "update unit_link set resolved_at = ?, resolution = 'chose b' where from_unit = ? and kind = 'conflicts'",
        now,
        a,
      ),
    /frozen/,
  );
});

test("a delivery can list only units of the delivered session's project", () => {
  session(db, p, "s1");
  const foreign = unit({ key: "c", kind: "question" }, other);
  const own = unit({ key: "d", kind: "question" });
  sql(
    "insert into capture_delivery (session_id, event, outcome, at, units) values ('s1', 'pre_edit', 'emitted', ?, json_array(?))",
    now,
    own,
  );
  assert.equal(db.owner.prepare("select count(*) as n from delivery_unit where unit_id = ?").get(own)?.n, 1);
  refuses(
    () =>
      sql(
        "insert into capture_delivery (session_id, event, outcome, at, units) values ('s1', 'pre_edit', 'emitted', ?, json_array(?))",
        now,
        foreign,
      ),
    /different projects/,
  );
});

test("forgetting a project removes everything under it despite the no-delete rules", () => {
  const src = message(db, p, { id: "m1", text: "Use SQLite. Decided." });
  const u = unit({ key: "u1", kind: "decision" });
  evidence(u, src);
  adoption(u, src);
  state(u, null, "candidate");
  state(u, "candidate", "active");
  sql("delete from project where id = ?", p);
  assert.deepEqual(
    ["unit", "source", "unit_evidence", "unit_state", "extraction_run"].map((t) =>
      Number(one(`select count(*) as n from ${t}`).n),
    ),
    [0, 0, 0, 0, 0],
  );
});

const forgetBatch = (projectId = p) => insert(db, "forget_batch", { project_id: projectId, at: now });
const tombstone = (sourceId: number, batch: number) =>
  sql(
    "insert into source_forgotten (source_id, project_id, artifact, kind, external_id, revision, content_hash, batch_id) select id, project_id, artifact, kind, external_id, revision, content_hash, ? from source where id = ?",
    batch,
    sourceId,
  );

test("a forgotten source clears the state that cited it, and state history stays append-only otherwise", () => {
  const src = message(db, p, { id: "m1", text: "Use SQLite. Decided." });
  const kept = message(db, p, { id: "m2", text: "Keep this one." });
  const u = unit({ key: "u1", kind: "decision" });
  evidence(u, src);
  adoption(u, src);
  state(u, null, "candidate");
  sql(
    "insert into unit_state (unit_id, from_state, to_state, at, reason, source_id, run_id) values (?, 'candidate', 'active', ?, 'r', ?, (select run_id from unit where id = ?))",
    u,
    now,
    src,
    u,
  );
  sql(
    "insert into unit_state (unit_id, from_state, to_state, at, reason, source_id, run_id) values (?, 'active', 'candidate', ?, 'r', ?, (select run_id from unit where id = ?))",
    u,
    now,
    kept,
    u,
  );
  sql("delete from source where id = ?", src);
  assert.deepEqual(
    db.owner
      .prepare("select source_id from unit_state where unit_id = ? order by id")
      .all(u)
      .map((r) => r.source_id),
    [null, null, kept],
  );
  refuses(() => sql("update unit_state set source_id = null where source_id = ?", kept), /append-only/);
  refuses(() => sql("update unit_state set reason = 'edited' where unit_id = ?", u), /append-only/);
});

test("a state change comes from exactly one of a run or a forget batch of the unit's project", () => {
  const u = unit({ key: "u1", kind: "finding" });
  const put = (runId: number | null, forgetId: number | null) =>
    sql(
      "insert into unit_state (unit_id, from_state, to_state, at, reason, run_id, forget_id) values (?, null, 'candidate', ?, 'r', ?, ?)",
      u,
      now,
      runId,
      forgetId,
    );
  const runId = Number(one("select run_id from unit where id = ?", u).run_id);
  refuses(() => put(null, null), /CHECK/);
  refuses(() => put(runId, forgetBatch()), /CHECK/);
  refuses(() => put(null, forgetBatch(other)), /different projects/);
  put(null, forgetBatch());
  assert.equal(one("select lifecycle from unit where id = ?", u).lifecycle, "candidate");
});

test("a retracted row goes with the source of its retraction reason, never on its own, and going raises the unit's revision", () => {
  const src = message(db, p, { id: "m1", text: "Use SQLite. Decided." });
  const reason = message(db, p, { id: "m2", text: "That was wrong." });
  const u = unit({ key: "u1", kind: "decision" });
  evidence(u, src);
  evidence(u, src, { role: "explains" });
  adoption(u, src);
  sql(
    "update unit_evidence set retracted_at = ?, retraction_reason = 'wrong', retraction_source_id = ?, retraction_span_start = 0, retraction_span_end = 4 where unit_id = ? and role = 'states'",
    now,
    reason,
    u,
  );
  const before = Number(one("select revision from unit where id = ?", u).revision);
  refuses(() => sql("delete from unit_evidence where unit_id = ? and role = 'states'", u), /never deleted/);
  refuses(() => sql("delete from unit_evidence where unit_id = ? and role = 'explains'", u), /never deleted/);
  refuses(() => sql("delete from unit_adoption where unit_id = ?", u), /never deleted/);
  // Removing the reason's source takes the row it explained, and nothing else
  sql("delete from source where id = ?", reason);
  assert.deepEqual(
    db.owner
      .prepare("select role from unit_evidence where unit_id = ? order by id")
      .all(u)
      .map((r) => r.role),
    ["explains"],
  );
  assert.equal(Number(one("select revision from unit where id = ?", u).revision), before + 1);
  sql("delete from source where id = ?", src);
  assert.equal(Number(one("select revision from unit where id = ?", u).revision), before + 3);
});

test("a run changes once, when it finishes", () => {
  session(db, p, "s1");
  const r = insert(db, "extraction_run", {
    project_id: p,
    origin: "trace",
    target: "session:s1",
    session_id: "s1",
    status: "running",
    started_at: now,
  });
  refuses(() => sql("update extraction_run set target = 'session:other' where id = ?", r), /changes once/);
  sql("update extraction_run set status = 'saved', finished_at = ? where id = ?", now, r);
  refuses(
    () => sql("update extraction_run set status = 'running', finished_at = null where id = ?", r),
    /changes once/,
  );
  refuses(
    () => sql("update extraction_run set finished_at = ? where id = ?", at("2026-09-28T00:00:00Z"), r),
    /changes once/,
  );
  refuses(() => sql("update extraction_run set session_id = null where id = ?", r), /changes once/);
  assert.deepEqual(
    { ...one("select status, finished_at from extraction_run where id = ?", r) },
    { status: "saved", finished_at: now },
  );
});

test("a delete takes what belongs to the deleted row: a whole project, or a session nothing cites; a cited session is refused", () => {
  const src = message(db, p, { id: "m1", text: "Use SQLite. Decided." });
  const u = unit({ key: "u1", kind: "decision" });
  evidence(u, src);
  adoption(u, src);
  state(u, null, "candidate");
  state(u, "candidate", "active");
  // A second session holds only what nothing cites: its message, an edit, a running run and a saved one, a delivery
  session(db, p, "s2");
  message(db, p, { id: "m2", text: "just talk", session: "s2" });
  sql(
    "insert into capture_edit (session_id, turn_id, tool_event_id, path, via, observed_at) values ('s2', 't', 'e', 'src/a.ts', 'tool', ?)",
    now,
  );
  for (const status of ["running", "saved"])
    insert(db, "extraction_run", {
      project_id: p,
      origin: "trace",
      target: "session:s2",
      session_id: "s2",
      status,
      started_at: now,
    });
  sql("insert into delivery (session_id, event, outcome, at) values ('s2', 'prompt', 'nothing', ?)", now);
  refuses(() => sql("delete from session where id = 's1'"), /records cite this session/);
  // Each way a record can cite a session keeps it: adoption, a retraction reason, a state's source, a field, and an anchor on its edit
  const cited = (name: string, cite: (message: number, sessionId: string) => void) => {
    const said = message(db, p, { id: `c-${name}`, text: "Use SQLite. Decided.", session: `c-${name}` });
    cite(said, `c-${name}`);
    refuses(() => sql("delete from session where id = ?", `c-${name}`), /records cite this session/);
  };
  const other = unit({ key: "u2", kind: "decision" });
  evidence(other, src);
  cited("adoption", (m) => adoption(other, m));
  cited("retraction", (m) =>
    sql(
      "update unit_evidence set retracted_at = ?, retraction_reason = 'wrong', retraction_source_id = ?, retraction_span_start = 0, retraction_span_end = 3 where unit_id = ?",
      now,
      m,
      other,
    ),
  );
  cited("state", (m) =>
    sql(
      "insert into unit_state (unit_id, from_state, to_state, at, reason, source_id, run_id) values (?, null, 'candidate', ?, 'r', ?, (select run_id from unit where id = ?))",
      other,
      now,
      m,
      other,
    ),
  );
  cited("field", (m) =>
    insert(db, "field_def", {
      project_id: p,
      name: "tenant",
      type: "text",
      label: "Tenant",
      description: "Who it affects",
      source_id: m,
      span_start: 0,
      span_end: 3,
      run_id: run(db, p),
      added_at: now,
    }),
  );
  cited("anchor", (_, sessionId) => {
    sql(
      "insert into capture_edit (session_id, turn_id, tool_event_id, path, via, observed_at) values (?, 't', 'e', 'src/b.ts', 'tool', ?)",
      sessionId,
      now,
    );
    insert(db, "unit_anchor", {
      unit_id: other,
      path: "src/b.ts",
      role: "applies_to",
      edit_observation_id: Number(one("select id from edit_observation where session_id = ?", sessionId).id),
      run_id: Number(one("select run_id from unit where id = ?", other).run_id),
      added_at: now,
    });
  });
  sql("delete from session where id = 's2'");
  assert.equal(one("select count(*) as n from source where session_id = 's2'").n, 0);
  assert.equal(one("select count(*) as n from edit_observation where session_id = 's2'").n, 0);
  assert.equal(
    one("select count(*) as n from extraction_run where target = 'session:s2' and session_id is null").n,
    2,
  );
  assert.deepEqual(db.owner.prepare("pragma foreign_key_check").all(), []);
  // A whole project goes, cited or not
  sql("delete from project where id = ?", p);
  const left = (table: string) => Number(one(`select count(*) as n from ${table}`).n);
  assert.deepEqual(
    ["session", "source", "unit", "unit_evidence", "unit_adoption", "unit_state", "delivery"].map(left),
    [0, 0, 0, 0, 0, 0, 0],
  );
  assert.equal(one("select count(*) as n from extraction_run where project_id = ?", p).n, 0);
  assert.deepEqual(db.owner.prepare("pragma foreign_key_check").all(), []);
});

test("tombstone: capture skips a message the owner forgot, and stores it again only with other text", () => {
  session(db, p, "s1");
  const put = (text: string) =>
    sql(
      "insert into capture_message (external_id, session_id, turn_id, speaker, created_at, captured_at, text, truncated, redacted, original_bytes, content_hash) values ('m1', 's1', 't', 'owner', ?, ?, ?, 0, 0, ?, ?)",
      now,
      now,
      text,
      Buffer.byteLength(text),
      sha256(text),
    );
  put("token is abc123");
  const src = Number(one("select id from source where external_id = 'm1'").id);
  tombstone(src, forgetBatch());
  sql("delete from source where id = ?", src);
  put("token is abc123");
  assert.equal(one("select count(*) as n from source where external_id = 'm1'").n, 0);
  put("token is [redacted]");
  assert.equal(one("select count(*) as n from source where external_id = 'm1'").n, 1);
});

test("a field definition quotes the owner inside its source, in trace, once per name, and is never rewritten", () => {
  const said = message(db, p, { id: "m1", text: "Track the tenant on every decision." });
  const ai = message(db, p, { id: "m2", text: "Shall I track the tenant?", speaker: "assistant" });
  const elsewhere = message(db, other, { id: "m3", text: "Track the tenant.", session: "s2" });
  const r = run(db, p);
  const define = (v: Values) =>
    insert(db, "field_def", {
      project_id: p,
      name: "tenant",
      type: "text",
      label: "Tenant",
      description: "The tenant affected",
      source_id: said,
      span_start: 0,
      span_end: 5,
      run_id: r,
      added_at: now,
      ...v,
    });
  refuses(() => define({ source_id: ai }), /quotes the owner/);
  refuses(() => define({ source_id: elsewhere }), /one project/);
  refuses(() => define({ run_id: run(db, p, "harvest", "pr:1") }), /defined by trace/);
  refuses(() => define({ span_end: 400 }), /outside the source text/);
  refuses(() => define({ name: "Tenant" }), /CHECK constraint failed/);
  refuses(() => define({ type: "enum" }), /CHECK constraint failed/);
  refuses(() => define({ type: "enum", enum_values: '["a", "a"]' }), /distinct/);
  refuses(() => define({ kinds: '["decision", "idea"]' }), /distinct unit kinds/);
  const d = define({ kinds: '["decision"]' });
  refuses(() => define({ label: "Another" }), /UNIQUE constraint failed/);
  refuses(() => sql("update field_def set label = 'T' where id = ?", d), /never rewritten/);
  refuses(() => sql("delete from field_def where id = ?", d), /only with their quoted source/);
});

test("a field value is sealed with its unit, fits its field's kinds and type, and goes with its quoted source", () => {
  const said = message(db, p, {
    id: "m1",
    text: "Track tenant, p95, severity, and due. acme had p95 320 at high, due 2026-10-01.",
  });
  const r = run(db, p);
  const define = (name: string, type: string, extra: Values = {}) =>
    insert(db, "field_def", {
      project_id: p,
      name,
      type,
      label: name,
      description: name,
      source_id: said,
      span_start: 0,
      span_end: 5,
      run_id: r,
      added_at: now,
      ...extra,
    });
  const tenant = define("tenant", "text", { kinds: '["decision"]' });
  const p95 = define("p95", "integer");
  const severity = define("severity", "enum", { enum_values: '["low", "high"]' });
  const due = define("due", "date");
  const u = unit({ key: "u1", kind: "decision" }, p, r);
  const finding = unit({ key: "u2", kind: "finding" }, p, r);
  const value = (fieldId: number, v: string, unitId = u, extra: Values = {}) =>
    insert(db, "unit_field", {
      unit_id: unitId,
      field_def_id: fieldId,
      value: v,
      source_id: said,
      span_start: 38,
      span_end: 42,
      run_id: r,
      added_at: now,
      ...extra,
    });
  refuses(() => value(tenant, "acme", finding), /does not apply/);
  refuses(() => value(p95, "3.2"), /optional minus sign and digits/);
  refuses(() => value(p95, "-"), /optional minus sign and digits/);
  refuses(() => value(p95, "1e3"), /optional minus sign and digits/);
  refuses(() => value(due, "2026-02-30"), /valid YYYY-MM-DD/);
  refuses(() => value(due, "2026-10-1"), /valid YYYY-MM-DD/);
  refuses(() => value(severity, "High"), /one of its values/);
  refuses(() => value(tenant, "acme", u, { span_end: 900 }), /outside the source text/);
  refuses(() => value(tenant, "acme", u, { run_id: run(db, p, "harvest", "pr:1") }), /written by trace/);
  const revision = () => Number(one("select revision from unit where id = ?", u).revision);
  const before = revision();
  const v = value(tenant, "acme");
  value(p95, "-320");
  value(severity, "high");
  value(due, "2026-10-01");
  assert.equal(revision(), before + 4);
  refuses(() => value(tenant, "globex"), /UNIQUE constraint failed/);
  refuses(() => sql("update unit_field set value = 'globex' where id = ?", v), /never rewritten/);
  refuses(() => sql("delete from unit_field where id = ?", v), /only with their unit or a quoted source/);
  const hits = (word: string) =>
    db.owner
      .prepare("select rowid from unit_fts where unit_fts match ?")
      .all(`"${word}"`)
      .map((row) => Number(row.rowid));
  assert.deepEqual(hits("acme"), [u]);
  state(u, null, "candidate");
  refuses(() => value(tenant, "acme", finding), /does not apply/);
  refuses(() => value(p95, "7", u), /before its first state/);
  // Removing the quoted source takes the values with it, raises the unit's revision, and drops the words from search
  const after = revision();
  sql("delete from source where id = ?", said);
  assert.equal(Number(one("select count(*) as n from unit_field").n), 0);
  assert.equal(Number(one("select count(*) as n from field_def").n), 0);
  assert.ok(revision() > after);
  assert.deepEqual(hits("acme"), []);
});
