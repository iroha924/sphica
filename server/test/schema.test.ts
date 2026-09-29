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

test("the database carries its generation and revision", () => {
  assert.deepEqual({ ...one("select generation from sphica_generation") }, { generation: 2 });
  assert.equal(one("pragma user_version").user_version, 3);
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
  for (const bad of ["C:\\Windows\\win.ini", "../x", "/etc/passwd", "a//b", "./a", "a/./b", "a\\b"])
    refuses(() => excerpt(bad), /constraint failed/);
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

test("only a retracted row whose retraction reason was forgotten can be removed, and removing it raises the unit's revision", () => {
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
  tombstone(reason, forgetBatch());
  refuses(() => sql("delete from unit_evidence where unit_id = ? and role = 'explains'", u), /never deleted/);
  refuses(() => sql("delete from unit_adoption where unit_id = ?", u), /never deleted/);
  sql("delete from unit_evidence where unit_id = ? and role = 'states'", u);
  assert.equal(Number(one("select revision from unit where id = ?", u).revision), before + 1);
  sql("delete from source where id = ?", src);
  assert.equal(Number(one("select revision from unit where id = ?", u).revision), before + 3);
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
