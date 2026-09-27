// Checking and saving records against real SQLite: quotes become spans of retained text, adoption follows who spoke, and lifecycle
// moves only when the schema's activation rules pass.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inTransaction } from "../src/db.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { liveUnits, openRun, pendingSessions, runOf, sessionEdits, sessionSources } from "../src/trace.ts";
import { at, hash, insert, message, project, type TempDb, tempDb } from "./temp-db.ts";

const now = at("2026-09-27T00:00:00Z");

/** A third-party source on a pull request. */
const prSource = (
  db: TempDb,
  p: number,
  v: { id: string; kind: string; text: string; login: string; assoc: string; event?: string },
) =>
  insert(db, "source", {
    project_id: p,
    kind: v.kind,
    artifact: "pr:12",
    external_id: v.id,
    revision: 1,
    author_kind: "person",
    author_login: v.login,
    author_association: v.assoc,
    event_kind: v.event ?? null,
    created_at: now,
    captured_at: now,
    text: v.text,
    original_bytes: Buffer.byteLength(v.text),
    content_hash: hash(),
    indexed: 1,
  });

const target = (p: number, sessionId: string | null = "s1"): Target => ({
  projectId: p,
  origin: "trace",
  prefix: "trace:ext-s1/",
  sessionId,
  root: null,
  sources: null,
});

async function save(db: TempDb, t: Target, record: unknown, looked: number[] = []) {
  return inTransaction(db.ingest, async (trx) => {
    const runId = await openRun(trx, {
      projectId: t.projectId,
      origin: t.origin,
      target: "session:s1",
      sessionId: t.sessionId,
      draftId: `d${Math.random()}`,
    });
    const checked = await checkRecord(trx, t, record);
    return { checked, saved: await saveRecord(trx, t, runId, checked, looked) };
  });
}

const state = (db: TempDb, key: string) =>
  db.owner.prepare("select lifecycle, extraction, extraction_reason from unit where key = ?").get(key);

test("an owner's directive becomes an active decision whose spans cut the quoted bytes, with a rejected option", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, {
      id: "m1",
      text: "保存先は Postgres じゃなくて SQLite にしよう。サーバーは要らない。",
    });
    const other = message(db, p, { id: "m2", text: "了解です。", speaker: "assistant" });
    const { saved } = await save(
      db,
      target(p),
      {
        units: [
          {
            key: "storage",
            kind: "decision",
            stance: "do",
            text: "保存先は SQLite",
            options: [
              {
                text: "Postgres",
                outcome: "rejected",
                evidence: [{ source: `s${m}`, quote: "サーバーは要らない" }],
              },
            ],
            evidence: [{ source: `s${m}`, quote: "SQLite にしよう。", role: "states" }],
            adoption: [{ source: `s${m}`, quote: "SQLite にしよう。" }],
            anchors: [{ path: "./src/db.ts", symbol: "open", role: "applies_to" }],
            aliases: ["データベース", "storage", "storage"],
          },
        ],
        work: { key: "w", title: "保存先", goal: "決める", current: "決めた", status: "done" },
      },
      [m, other],
    );
    assert.deepEqual(saved.active, ["trace:ext-s1/storage"]);
    const ev = db.owner
      .prepare(
        "select e.role, e.option_id is not null as opt, substr(cast(s.text as blob), e.span_start + 1, e.span_end - e.span_start) as cut from unit_evidence e join source s on s.id = e.source_id order by e.id",
      )
      .all()
      .map((r) => [r.role, r.opt, Buffer.from(r.cut as Uint8Array).toString("utf8")]);
    assert.deepEqual(ev, [
      ["rejects", 1, "サーバーは要らない"],
      ["states", 0, "SQLite にしよう。"],
    ]);
    assert.equal(db.owner.prepare("select route from unit_adoption").get()?.route, "owner_statement");
    assert.equal(db.owner.prepare("select path from unit_anchor").get()?.path, "src/db.ts");
    assert.equal(db.owner.prepare("select terms from unit_alias").get()?.terms, '["データベース","storage"]');
    assert.equal(db.owner.prepare("select status from work").get()?.status, "done");
    assert.deepEqual(
      db.owner
        .prepare("select source_id, outcome from source_processing order by source_id")
        .all()
        .map((r) => [r.source_id, r.outcome]),
      [
        [m, "units"],
        [other, "no_unit"],
      ],
    );
    assert.equal(db.owner.prepare("select status from extraction_run").get()?.status, "saved");
  } finally {
    await db.done();
  }
});

test("a quote missing from the text quarantines the unit, and a unit without evidence is quarantined too", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "zod を使うかは未定。" });
    const { saved } = await save(db, target(p), {
      units: [
        {
          key: "zod",
          kind: "decision",
          stance: "do",
          text: "zod を使う",
          evidence: [{ source: `s${m}`, quote: "zod を使うことに決めた。", role: "states" }],
          adoption: [{ source: `s${m}`, quote: "決めた" }],
        },
        { key: "bare", kind: "finding", text: "根拠の無い発見" },
      ],
    });
    assert.equal(saved.quarantined.length, 2);
    assert.match(String(state(db, "trace:ext-s1/zod")?.extraction_reason), /quote not found/);
    assert.match(String(state(db, "trace:ext-s1/bare")?.extraction_reason), /no evidence cited/);
    assert.equal(state(db, "trace:ext-s1/zod")?.lifecycle, "candidate");
  } finally {
    await db.done();
  }
});

test("a merge or a contributor cannot adopt; the unit is kept as a candidate and check says why", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const review = prSource(db, p, {
      id: "r1",
      kind: "review_comment",
      text: "Consider synchronous = OFF for speed.",
      login: "drive-by",
      assoc: "CONTRIBUTOR",
    });
    const merge = prSource(db, p, {
      id: "merge",
      kind: "pr_event",
      text: "merged",
      login: "hana",
      assoc: "OWNER",
      event: "merged",
    });
    const t = { ...target(p, null), origin: "harvest" as const, prefix: "harvest:12/" };
    const { checked, saved } = await save(db, t, {
      units: [
        {
          key: "sync-off",
          kind: "decision",
          stance: "do",
          text: "synchronous = OFF",
          evidence: [
            { source: `s${review}`, quote: "Consider synchronous = OFF for speed.", role: "proposes" },
          ],
          adoption: [
            { source: `s${merge}`, quote: "" },
            { source: `s${review}`, quote: "Consider" },
          ],
        },
        {
          key: "note",
          kind: "finding",
          text: "OFF is faster",
          evidence: [{ source: `s${review}`, quote: "for speed", role: "states" }],
          adoption: [{ source: `s${review}`, quote: "for speed" }],
        },
      ],
    });
    assert.ok(checked.problems.some((x) => x.includes("merge does not adopt")));
    assert.ok(checked.problems.some((x) => x.includes("only the owner or a maintainer can adopt")));
    assert.ok(checked.problems.some((x) => x.includes("adoption applies to decisions and constraints")));
    assert.match(saved.candidates[0]?.why ?? "", /needs unretracted evidence and adoption/);
    assert.equal(state(db, "harvest:12/sync-off")?.lifecycle, "candidate");
    assert.equal(state(db, "harvest:12/note")?.lifecycle, "active");
  } finally {
    await db.done();
  }
});

test("supersedes retires the old record with evidence, and conflicts link both", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const a = message(db, p, { id: "m1", text: "SQLite にする。" });
    const b = message(db, p, { id: "m2", text: "やっぱり Postgres に移す。" });
    const unit = (key: string, source: number, quote: string, extra = {}) => ({
      key,
      kind: "decision",
      stance: "do",
      text: quote,
      evidence: [{ source: `s${source}`, quote, role: "states" }],
      adoption: [{ source: `s${source}`, quote }],
      ...extra,
    });
    await save(db, target(p), { units: [unit("sqlite", a, "SQLite にする。")] });
    const { saved } = await save(db, target(p), {
      units: [unit("postgres", b, "やっぱり Postgres に移す。", { supersedes: "trace:ext-s1/sqlite" })],
    });
    assert.deepEqual(saved.superseded, ["trace:ext-s1/sqlite"]);
    const last = db.owner
      .prepare(
        "select to_state, source_id from unit_state where unit_id = (select id from unit where key = 'trace:ext-s1/sqlite') order by id desc",
      )
      .get();
    assert.deepEqual([last?.to_state, last?.source_id], ["superseded", b]);
    await save(db, target(p), {
      units: [
        {
          key: "maybe",
          kind: "question",
          text: "どちらか",
          evidence: [{ source: `s${b}`, quote: "Postgres", role: "states" }],
          conflicts: ["trace:ext-s1/postgres"],
        },
      ],
    });
    assert.equal(
      db.owner.prepare("select count(*) as n from unit_link where kind = 'conflicts'").get()?.n,
      1,
    );
  } finally {
    await db.done();
  }
});

test("check refuses malformed records, reused keys, stance mistakes, foreign sources, and unknown links", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const other = project(db, "git:github.com/o/other", "o/other");
    const theirs = message(db, other, { id: "x", text: "他のプロジェクトの発言", session: "s9" });
    const m = message(db, p, { id: "m1", text: "決めた。" });
    await save(db, target(p), {
      units: [
        {
          key: "k",
          kind: "finding",
          text: "t",
          evidence: [{ source: `s${m}`, quote: "決めた", role: "states" }],
        },
      ],
    });
    const check = (record: unknown) => inTransaction(db.ingest, (trx) => checkRecord(trx, target(p), record));
    assert.match((await check({ units: "x" })).errors.join(), /units/);
    const c = await check({
      units: [
        {
          key: "k",
          kind: "finding",
          text: "t",
          evidence: [{ source: `s${theirs}`, quote: "他", role: "states" }],
        },
        { key: "d", kind: "decision", text: "no stance", revisit_when: "later" },
        { key: "d", kind: "finding", text: "dup", supersedes: "trace:ext-s1/none", conflicts: ["nope"] },
        {
          key: "a",
          kind: "finding",
          text: "a",
          anchors: [{ path: "../x", role: "applies_to" }],
          aliases: ["x".repeat(41)],
        },
      ],
    });
    for (const want of [
      /already recorded/,
      new RegExp(`s${theirs}: not a source of this project`),
      /stance is required/,
      /revisit_when goes only with stance defer/,
      /appears twice/,
      /not a record of this project/,
    ])
      assert.ok(
        c.errors.some((e) => want.test(e)),
        `${want}: ${c.errors.join(" | ")}`,
      );
    assert.ok(c.problems.some((x) => /not inside the repository/.test(x)));
    assert.ok(c.problems.some((x) => /aliases must be 1 to 40/.test(x)));
    await assert.rejects(
      inTransaction(db.ingest, (trx) => saveRecord(trx, target(p), 1, c, [])),
      /not valid/,
    );
  } finally {
    await db.done();
  }
});

test("an evidence anchor without a commit cites this session's edit observation of the path", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "toCsv を直した。" });
    insert(db, "edit_observation", {
      session_id: "s1",
      turn_id: "t1",
      path: "src/export.ts",
      via: "tool",
      observed_at: now,
    });
    await save(db, target(p), {
      units: [
        {
          key: "csv",
          kind: "implementation",
          text: "toCsv を直した",
          evidence: [{ source: `s${m}`, quote: "toCsv を直した。", role: "implements" }],
          anchors: [{ path: "src/export.ts", symbol: "toCsv", role: "evidence" }],
        },
      ],
    });
    assert.equal(state(db, "trace:ext-s1/csv")?.lifecycle, "active");
  } finally {
    await db.done();
  }
});

test("trace reads pending sessions, a draft's run, a session's messages and edits, and live records", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "やること" });
    message(db, p, { id: "m2", text: "返事", speaker: "assistant" });
    message(db, p, { id: "m3", text: "返事だけ", speaker: "assistant", session: "s2" });
    insert(db, "edit_observation", {
      session_id: "s1",
      turn_id: "t1",
      path: "a.ts",
      via: "status",
      observed_at: now,
    });
    const pending = await pendingSessions(db.reader, p);
    assert.deepEqual(
      pending.map((r) => [r.id, Number(r.waiting), Number(r.first)]),
      [["s1", 1, m]],
    );
    const runId = await openRun(db.ingest, {
      projectId: p,
      origin: "trace",
      target: "session:s1",
      sessionId: "s1",
      draftId: "dx",
    });
    assert.equal((await runOf(db.reader, "dx"))?.id, runId);
    assert.equal(await runOf(db.reader, "none"), null);
    assert.deepEqual(
      (await sessionSources(db.reader, "s1")).map((s) => [s.author_kind, Number(s.looked)]),
      [
        ["owner", 0],
        ["assistant", 0],
      ],
    );
    assert.deepEqual(await sessionEdits(db.reader, "s1"), [{ path: "a.ts", via: "status", turn_id: "t1" }]);
    assert.deepEqual(await liveUnits(db.reader, p), []);
  } finally {
    await db.done();
  }
});

test("a trace or harvest run cites only the sources it was given; another session's words are refused", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const mine = message(db, p, { id: "m1", text: "Use SQLite." });
    const theirs = message(db, p, { id: "m2", text: "Use Postgres.", session: "s2" });
    const record = (source: number, quote: string) => ({
      units: [
        {
          key: "db",
          kind: "decision",
          stance: "do",
          text: quote,
          evidence: [{ source: `s${source}`, quote, role: "states" }],
          adoption: [{ source: `s${source}`, quote }],
        },
      ],
    });
    const scoped: Target = { ...target(p), sources: [mine] };
    const refused = await checkRecord(db.reader, scoped, record(theirs, "Use Postgres."));
    assert.ok(
      refused.errors.some((e) => e.includes(`s${theirs}: not a source of this run`)),
      refused.errors.join(" | "),
    );
    assert.deepEqual((await checkRecord(db.reader, scoped, record(mine, "Use SQLite."))).errors, []);
  } finally {
    await db.done();
  }
});

test("an implementation's commit anchor counts only when that commit holds the path in the repository", async () => {
  const db = tempDb();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-commit-")));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
        encoding: "utf8",
      }).trim();
    git("init", "-q");
    fs.writeFileSync(path.join(root, "db.ts"), "export const open = () => 1;\n");
    git("add", "-A");
    git("commit", "-qm", "db");
    const real = git("rev-parse", "HEAD");
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "open を足した。" });
    const built = (key: string, commit: string, file = "db.ts") => ({
      units: [
        {
          key,
          kind: "implementation",
          text: "open を足した",
          evidence: [{ source: `s${m}`, quote: "open を足した。", role: "states" }],
          anchors: [{ path: file, role: "evidence", commit }],
        },
      ],
    });
    const t: Target = { ...target(p), root };
    const forged = await save(db, t, built("forged", "0".repeat(40)));
    assert.deepEqual(forged.saved.active, [], "an unknown commit is not code evidence");
    assert.ok(
      forged.checked.problems.some((x) => /commit .* does not hold db\.ts/.test(x)),
      forged.checked.problems.join(" | "),
    );
    assert.deepEqual((await save(db, t, built("elsewhere", real, "missing.ts"))).saved.active, []);
    assert.deepEqual((await save(db, t, built("real", real))).saved.active, ["trace:ext-s1/real"]);
  } finally {
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an older session traced after a newer one never overwrites the newer work state", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const older = message(db, p, { id: "m1", text: "まだ途中。" });
    const newer = message(db, p, { id: "m2", text: "終わった。", session: "s2" });
    db.owner.prepare("update session set started_at = ? where id = 's2'").run(at("2026-09-05T00:00:00Z"));
    const work = (status: string, current: string) => ({
      units: [],
      work: { key: "w", title: "移行", goal: "終える", current, status },
    });
    const run = (sessionId: string) => ({ ...target(p, sessionId), prefix: `trace:ext-${sessionId}/` });
    // trace_pending lists the newest session first, so it is traced first
    await save(db, run("s2"), work("done", "終わった"), [newer]);
    await save(db, run("s1"), work("active", "まだ途中"), [older]);
    assert.deepEqual(
      { ...db.owner.prepare("select status, current from work where key = 'w'").get() },
      { status: "done", current: "終わった" },
    );
  } finally {
    await db.done();
  }
});

test("a traced work item carries its session's branch", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "途中。" });
    db.owner.prepare("update session set branch = 'feature/x' where id = 's1'").run();
    await save(
      db,
      target(p),
      { units: [], work: { key: "w", title: "移行", goal: "終える", current: "途中", status: "active" } },
      [m],
    );
    assert.equal(db.owner.prepare("select branch from work where key = 'w'").get()?.branch, "feature/x");
  } finally {
    await db.done();
  }
});
