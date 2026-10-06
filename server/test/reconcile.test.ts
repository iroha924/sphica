// Saves that reconcile lifecycles and replacements, on real connections: a broken state is repaired or the whole save goes back, the order
// of saves does not change where they settle, and one save into a crowded place holds the write lock only briefly.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { DatabaseSync, type SQLInputValue, type StatementResultingChanges } from "node:sqlite";
import { test } from "node:test";
import { inTransaction } from "../src/db.ts";
import { checkText } from "../src/extract.ts";
import { checkGlean, saveGlean } from "../src/glean.ts";
import { checkRecord, finishRun, prepareRecord, saveRecord, type Target } from "../src/record.ts";
import { sha256 } from "../src/text.ts";
import { openRun } from "../src/trace.ts";
import { at, message, project, session, type TempDb, tempDb } from "./temp-db.ts";

const now = at("2026-10-01T00:00:00Z");
const PREFIX = "trace:ext-s1/";

const target = (p: number): Target => ({
  projectId: p,
  origin: "trace",
  prefix: PREFIX,
  sessionId: "s1",
  root: null,
  sources: null,
});

const runIn = (db: TempDb, p: number) =>
  openRun(db.ingest, {
    projectId: p,
    origin: "trace",
    target: "session:s1",
    sessionId: "s1",
    draftId: `d${Math.random()}`,
  });

/** One save as the record server makes it: the repository is read before the lock, then check, save, and finishing the run under it */
async function save(db: TempDb, p: number, record: unknown) {
  const runId = await runIn(db, p);
  const facts = prepareRecord(null, record);
  return inTransaction(db.ingest, async (trx) => {
    const saved = await saveRecord(
      trx,
      target(p),
      runId,
      await checkRecord(trx, target(p), record, facts),
      [],
    );
    await finishRun(trx, runId);
    return saved;
  });
}

/** A decision quoting a source; adopted when the quote is the owner's own decision */
const decided = (key: string, source: number, quote: string, adopt: boolean, supersedes?: string) => ({
  key,
  kind: "decision",
  stance: "do",
  text: quote,
  evidence: [{ source: `s${source}`, quote, role: "states" }],
  ...(adopt ? { adoption: [{ source: `s${source}`, quote }] } : {}),
  ...(supersedes ? { supersedes: `${PREFIX}${supersedes}` } : {}),
});

const life = (db: TempDb, key: string) =>
  (
    db.owner.prepare("select lifecycle from unit where key = ?").get(`${PREFIX}${key}`) as {
      lifecycle: string;
    }
  )?.lifecycle;

/** Every replacement row as successor → replaced, and whether it is still in effect */
const rows = (db: TempDb) =>
  db.owner
    .prepare(
      `select f.key as from_key, t.key as to_key, r.ended_at is null as open from unit_replacement r
       join unit f on f.id = r.from_unit join unit t on t.id = r.to_unit order by r.id`,
    )
    .all()
    .map((r) => `${r.from_key} → ${r.to_key}${r.open ? "" : " (ended)"}`);

const count = (db: TempDb, table: string) =>
  Number((db.owner.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n);

test("rollback: a superseded record whose replacement row was lost is put right by the next save that reaches it", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const owner = message(db, p, { id: "m1", text: "SQLite にする。DuckDB に移す。" });
    const ai = message(db, p, { id: "m2", text: "Postgres のほうが良さそうです。", speaker: "assistant" });
    await save(db, p, { units: [decided("sqlite", owner, "SQLite にする。", true)] });
    await save(db, p, { units: [decided("duckdb", owner, "DuckDB に移す。", true, "sqlite")] });
    // The broken state: the record stays superseded while nothing replaces it
    db.owner
      .prepare(
        "update unit_replacement set ended_at = ?, end_reason = 'lost', end_run_id = run_id where ended_at is null",
      )
      .run(new Date().toISOString());
    assert.deepEqual(rows(db), [`${PREFIX}duckdb → ${PREFIX}sqlite (ended)`]);
    assert.equal(life(db, "sqlite"), "superseded");

    // A proposal into the successor reaches the broken record through the chain of intents
    const saved = await save(db, p, {
      units: [decided("postgres", ai, "Postgres のほうが良さそうです。", false, "duckdb")],
    });
    assert.deepEqual(rows(db), [
      `${PREFIX}duckdb → ${PREFIX}sqlite (ended)`,
      `${PREFIX}duckdb → ${PREFIX}sqlite`,
    ]);
    assert.deepEqual(
      ["sqlite", "duckdb", "postgres"].map((k) => life(db, k)),
      ["superseded", "active", "candidate"],
    );
    assert.deepEqual(saved.candidates, [
      {
        key: `${PREFIX}postgres`,
        why: "an active decision or constraint needs unretracted evidence and adoption",
      },
    ]);
  } finally {
    await db.done();
  }
});

test("rollback: a save that fails while reconciling leaves nothing it wrote, the run and the new record included", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const owner = message(db, p, { id: "m1", text: "SQLite にする。DuckDB に移す。" });
    await save(db, p, { units: [decided("sqlite", owner, "SQLite にする。", true)] });
    // Refuses the replaced record's state only once the replacement row is already written in the same transaction
    db.owner.exec(`create trigger refuse_after_open before insert on unit_state
      when new.to_state = 'superseded' and exists (select 1 from unit_replacement where to_unit = new.unit_id and ended_at is null)
      begin select raise(abort, 'refused after the replacement opened'); end`);
    const tables = [
      "extraction_run",
      "unit",
      "unit_evidence",
      "unit_adoption",
      "unit_link",
      "unit_state",
      "unit_replacement",
    ];
    const before = tables.map((t) => count(db, t));
    const runId = await runIn(db, p);
    const record = { units: [decided("duckdb", owner, "DuckDB に移す。", true, "sqlite")] };
    await assert.rejects(
      inTransaction(db.ingest, async (trx) => {
        await saveRecord(trx, target(p), runId, await checkRecord(trx, target(p), record), []);
      }),
      /refused after the replacement opened/,
    );
    // The run was opened before the lock, as begin does; everything under the lock is gone
    assert.deepEqual(
      tables.map((t) => count(db, t)),
      before.map((n, i) => (tables[i] === "extraction_run" ? n + 1 : n)),
    );
    assert.equal(life(db, "sqlite"), "active");
    assert.equal(life(db, "duckdb"), undefined);
  } finally {
    await db.done();
  }
});

// A proposal into a record already replaced is refused at check, so these saves are ones every order accepts
test("order: the same saves in any order settle to the same lifecycles and replacement rows", async () => {
  const saves: [string, (o: number, ai: number) => unknown][] = [
    ["owner's successor", (o) => ({ units: [decided("duckdb", o, "DuckDB に移す。", true, "sqlite")] })],
    [
      "AI's proposal",
      (_, ai) => ({ units: [decided("postgres", ai, "Postgres のほうが良さそうです。", false, "cache")] }),
    ],
    [
      "finding's successor",
      (o) => ({
        units: [
          {
            key: "wal2",
            kind: "finding",
            text: "WAL は読み手を止めない。",
            supersedes: `${PREFIX}wal`,
            evidence: [{ source: `s${o}`, quote: "WAL は読み手を止めない。", role: "states" }],
          },
        ],
      }),
    ],
  ];
  const orders = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  const settled: { order: string; lifecycles: Record<string, string>; rows: string[] }[] = [];
  for (const order of orders) {
    const db = tempDb();
    try {
      const p = project(db);
      const o = message(db, p, {
        id: "m1",
        text: "SQLite にする。DuckDB に移す。表紙はメモリに置く。WAL は書き手を待たせる。WAL は読み手を止めない。",
      });
      const ai = message(db, p, { id: "m2", text: "Postgres のほうが良さそうです。", speaker: "assistant" });
      await save(db, p, {
        units: [
          decided("sqlite", o, "SQLite にする。", true),
          decided("cache", o, "表紙はメモリに置く。", true),
          {
            key: "wal",
            kind: "finding",
            text: "WAL は書き手を待たせる。",
            evidence: [{ source: `s${o}`, quote: "WAL は書き手を待たせる。", role: "states" }],
          },
        ],
      });
      for (const i of order) await save(db, p, (saves[i] as (typeof saves)[number])[1](o, ai));
      settled.push({
        order: order.map((i) => saves[i]?.[0]).join(", "),
        lifecycles: Object.fromEntries(
          ["sqlite", "duckdb", "cache", "postgres", "wal", "wal2"].map((k) => [k, life(db, k)]),
        ),
        rows: rows(db).sort(),
      });
    } finally {
      await db.done();
    }
  }
  for (const s of settled.slice(1))
    assert.deepEqual(
      { ...s, order: "" },
      { ...(settled[0] as (typeof settled)[number]), order: "" },
      s.order,
    );
  assert.deepEqual(settled[0]?.lifecycles, {
    sqlite: "superseded",
    duckdb: "active",
    cache: "active",
    postgres: "candidate",
    wal: "superseded",
    wal2: "active",
  });
  assert.deepEqual(
    settled[0]?.rows,
    [`${PREFIX}duckdb → ${PREFIX}sqlite`, `${PREFIX}wal2 → ${PREFIX}wal`].sort(),
  );
});

test("order: withdrawing the owner's successor and adopting the waiting proposal settle the same in either order of one glean", async () => {
  const settled: { lifecycles: string[]; rows: string[] }[] = [];
  for (const withdrawFirst of [true, false]) {
    const db = tempDb();
    try {
      const p = project(db);
      const o = message(db, p, { id: "m1", text: "SQLite にする。DuckDB に移す。" });
      const ai = message(db, p, { id: "m2", text: "Postgres のほうが良さそうです。", speaker: "assistant" });
      await save(db, p, { units: [decided("sqlite", o, "SQLite にする。", true)] });
      await save(db, p, {
        units: [decided("postgres", ai, "Postgres のほうが良さそうです。", false, "sqlite")],
      });
      await save(db, p, { units: [decided("duckdb", o, "DuckDB に移す。", true, "sqlite")] });
      session(db, p, "g1");
      const said = message(db, p, {
        id: "g",
        text: "DuckDB はやめる。Postgres にする。",
        session: "g1",
      });
      const revision = (key: string) =>
        Number(
          (
            db.owner.prepare("select revision from unit where key = ?").get(`${PREFIX}${key}`) as {
              revision: number;
            }
          ).revision,
        );
      const withdraw = {
        op: "withdraw",
        unit: `${PREFIX}duckdb`,
        revision: revision("duckdb"),
        reason_source: `s${said}`,
        reason_quote: "DuckDB はやめる。",
      };
      const adopt = {
        op: "adopt",
        unit: `${PREFIX}postgres`,
        revision: revision("postgres"),
        source: `s${said}`,
        quote: "Postgres にする。",
      };
      const gleaned: Target = {
        projectId: p,
        origin: "glean",
        prefix: "glean:",
        sessionId: "g1",
        root: null,
        sources: null,
      };
      const runId = await openRun(db.ingest, {
        projectId: p,
        origin: "glean",
        target: "session:g1",
        sessionId: "g1",
        draftId: "g",
      });
      const record = { ops: withdrawFirst ? [withdraw, adopt] : [adopt, withdraw] };
      await inTransaction(db.ingest, async (trx) =>
        saveGlean(trx, gleaned, runId, await checkGlean(trx, gleaned, record)),
      );
      settled.push({
        lifecycles: ["sqlite", "duckdb", "postgres"].map((k) => life(db, k)),
        rows: rows(db),
      });
    } finally {
      await db.done();
    }
  }
  assert.deepEqual(settled[0], {
    lifecycles: ["superseded", "withdrawn", "active"],
    rows: [`${PREFIX}duckdb → ${PREFIX}sqlite (ended)`, `${PREFIX}postgres → ${PREFIX}sqlite`],
  });
  assert.deepEqual(settled[1], settled[0]);
});

/**
 * How long a call holds the write lock on this process's connections, from begin immediate returning to its rollback or commit returning,
 * and how long it waited to take it
 */
async function lockTimes(
  fn: () => Promise<unknown>,
  beforeBegin: () => void = () => {},
): Promise<{ held: number; waited: number; askedAt: number; beganAt: number }> {
  const prepare = DatabaseSync.prototype.prepare;
  const at = { asked: 0, began: 0, ended: 0, askedAt: 0, beganAt: 0 };
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, ...args: Parameters<typeof prepare>) {
    const st = prepare.apply(this, args);
    const text = String(args[0]);
    if (["begin immediate", "rollback", "commit"].includes(text)) {
      const run = st.run.bind(st) as (...a: SQLInputValue[]) => StatementResultingChanges;
      st.run = ((...a: SQLInputValue[]) => {
        if (text === "begin immediate") {
          beforeBegin();
          [at.asked, at.askedAt] = [performance.now(), Date.now()];
        }
        const out = run(...a);
        if (text === "begin immediate") [at.began, at.beganAt] = [performance.now(), Date.now()];
        else at.ended = performance.now();
        return out;
      }) as typeof st.run;
    }
    return st;
  };
  try {
    await fn();
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
  return { held: at.ended - at.began, waited: at.began - at.asked, askedAt: at.askedAt, beganAt: at.beganAt };
}

const CHAINS = 150;
const CHAIN = 20;
const PROPOSALS = 200;
const BUDGET_MS = 200;

test("judge budget: one check or save into a place with a long chain and many waiting proposals holds the write lock under 200 ms", async (t) => {
  const db = tempDb();
  try {
    const p = project(db);
    const said = "Keep it.";
    const owner = message(db, p, { id: "m1", text: said });
    const ai = message(db, p, { id: "m2", text: said, speaker: "assistant" });
    const fresh = message(db, p, { id: "m3", text: "Move to the new store." });
    const run = Number(
      (
        db.owner
          .prepare(
            "insert into extraction_run (project_id, origin, target, status, started_at) values (?, 'trace', 'session:s1', 'running', ?) returning id",
          )
          .get(p, now) as { id: number }
      ).id,
    );
    const q = (text: string) => db.owner.prepare(text);
    const unit = q(
      "insert into unit (project_id, key, kind, stance, text, extraction, run_id, created_at, content_hash) values (?, ?, 'decision', 'do', ?, 'supported', ?, ?, ?) returning id",
    );
    const evidence = q(
      "insert into unit_evidence (unit_id, source_id, span_start, span_end, role, run_id, added_at) values (?, ?, 0, 8, 'states', ?, ?)",
    );
    const adoption = q(
      "insert into unit_adoption (unit_id, route, source_id, span_start, span_end, run_id, added_at) values (?, 'owner_statement', ?, 0, 8, ?, ?)",
    );
    const link = q(
      "insert into unit_link (from_unit, to_unit, kind, run_id, added_at) values (?, ?, 'supersedes', ?, ?)",
    );
    const replacement = q(
      "insert into unit_replacement (from_unit, to_unit, run_id, started_at) values (?, ?, ?, ?)",
    );
    const state = q(
      "insert into unit_state (unit_id, from_state, to_state, at, reason, run_id) values (?, ?, ?, ?, 'setup', ?)",
    );
    const add = (key: string, adopted: boolean) => {
      const id = Number(
        (unit.get(p, `${PREFIX}${key}`, `decision ${key}`, run, now, sha256(key)) as { id: number }).id,
      );
      evidence.run(id, adopted ? owner : ai, run, now);
      if (adopted) adoption.run(id, owner, run, now);
      state.run(id, null, "candidate", now, run);
      return id;
    };
    const started = performance.now();
    db.owner.exec("begin");
    // Chains of decisions each replacing the one before; the end of each is the one in effect
    const ends: number[] = [];
    for (let c = 0; c < CHAINS; c++) {
      const chain = Array.from({ length: CHAIN }, (_, i) => add(`c${c}-${i}`, true));
      for (let i = 1; i < CHAIN; i++) {
        const [from, to] = [chain[i] as number, chain[i - 1] as number];
        link.run(from, to, run, now);
        replacement.run(from, to, run, now);
        state.run(to, "candidate", "superseded", now, run);
      }
      const end = chain[CHAIN - 1] as number;
      state.run(end, "candidate", "active", now, run);
      ends.push(end);
    }
    // Proposals nobody adopted, all waiting on the end of the first chain
    const crowded = ends[0] as number;
    for (let i = 0; i < PROPOSALS; i++) link.run(add(`proposal-${i}`, false), crowded, run, now);
    db.owner.exec("commit");
    const setup = performance.now() - started;
    assert.equal(count(db, "unit"), CHAINS * CHAIN + PROPOSALS);

    const record = {
      units: [
        {
          ...decided("new-store", fresh, "Move to the new store.", true),
          supersedes: `${PREFIX}c0-${CHAIN - 1}`,
        },
      ],
    };
    // record_check runs this same save and rolls it back, holding the lock as long
    const draft = "budget-check";
    await openRun(db.ingest, {
      projectId: p,
      origin: "trace",
      target: "session:s1",
      sessionId: "s1",
      draftId: draft,
    });
    let checked = "";
    const check = await lockTimes(async () => {
      checked = (await checkText(db.ingest, draft, p, null, record)).text;
    });
    t.diagnostic(
      `judge budget: record_check held the lock ${check.held.toFixed(1)} ms after waiting ${check.waited.toFixed(1)} ms`,
    );
    assert.match(checked, new RegExp(`✓ would be active: ${PREFIX}new-store`));
    assert.ok(check.held < BUDGET_MS, `the check held the write lock ${check.held.toFixed(1)} ms`);
    const runId = await runIn(db, p);
    const facts = prepareRecord(null, record);
    const t0 = performance.now();
    const saved = await inTransaction(db.ingest, async (trx) => {
      const out = await saveRecord(
        trx,
        target(p),
        runId,
        await checkRecord(trx, target(p), record, facts),
        [],
      );
      await finishRun(trx, runId);
      return out;
    });
    const held = performance.now() - t0;
    t.diagnostic(
      `judge budget: ${CHAINS * CHAIN + PROPOSALS} units, the lock held ${held.toFixed(1)} ms (setup ${setup.toFixed(0)} ms)`,
    );
    assert.deepEqual(saved.active, [`${PREFIX}new-store`]);
    assert.deepEqual(saved.superseded, [`${PREFIX}c0-${CHAIN - 1}`]);
    assert.equal(life(db, "proposal-0"), "candidate");
    assert.ok(held < BUDGET_MS, `the save held the write lock ${held.toFixed(1)} ms`);
  } finally {
    await db.done();
  }
});

test("a replacement that ends after the clock went back ends no earlier than it started", async (t) => {
  const db = tempDb();
  try {
    const p = project(db);
    const said = message(db, p, { id: "m1", text: "Use SQLite. Use Postgres. That was wrong." });
    await save(db, p, { units: [decided("old", said, "Use SQLite.", true)] });
    // The successor takes effect while the clock is an hour ahead
    const ahead = Date.now() + 3_600_000;
    const clock = t.mock.method(Date, "now", () => ahead);
    await save(db, p, { units: [decided("next", said, "Use Postgres.", true, "old")] });
    clock.mock.restore();
    const revision = Number(
      db.owner.prepare("select revision from unit where key = ?").get(`${PREFIX}next`)?.revision,
    );
    const gleaned: Target = { ...target(p), origin: "glean", prefix: "glean:" };
    const runId = await openRun(db.ingest, {
      projectId: p,
      origin: "glean",
      target: "session:s1",
      sessionId: "s1",
      draftId: "g1",
    });
    const record = {
      ops: [
        {
          op: "withdraw",
          unit: `${PREFIX}next`,
          revision,
          reason_source: `s${said}`,
          reason_quote: "That was wrong.",
        },
      ],
    };
    await inTransaction(db.ingest, async (trx) =>
      saveGlean(trx, gleaned, runId, await checkGlean(trx, gleaned, record)),
    );
    const row = db.owner.prepare("select started_at, ended_at from unit_replacement").get() as {
      started_at: string;
      ended_at: string;
    };
    assert.equal(row.ended_at, row.started_at);
    assert.equal(
      db.owner.prepare("select lifecycle from unit where key = ?").get(`${PREFIX}old`)?.lifecycle,
      "active",
    );
  } finally {
    await db.done();
  }
});

// A lock another process holds blocks this thread's busy wait, so only another process can hold it while the check waits
test("record_check waits for a write lock another process holds, as save does, and then runs", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "Keep it." });
    const draft = "waits";
    await openRun(db.ingest, {
      projectId: p,
      origin: "trace",
      target: "session:s1",
      sessionId: "s1",
      draftId: draft,
    });
    // The holder lets go only after the check asks for the lock, told by a file written just before (this thread blocks while it waits, so no
    // message it sends could be delivered), and says when, so the wait is checked by order, not by how long either side took to get there
    const signal = `${db.file}.asking`;
    const holder = spawn(
      process.execPath,
      [
        "-e",
        `const { DatabaseSync } = require("node:sqlite");
const c = new DatabaseSync(process.argv[1]);
c.exec("begin immediate");
process.stdout.write("held\\n");
const fs = require("node:fs");
const poll = setInterval(() => {
  if (!fs.existsSync(process.argv[2])) return;
  clearInterval(poll);
  setTimeout(() => { process.stdout.write("released " + Date.now() + "\\n"); c.exec("rollback"); c.close(); }, 500);
}, 10);`,
        db.file,
        signal,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let out = "";
    holder.stdout.on("data", (b: Buffer) => {
      out += b.toString();
    });
    const exited = new Promise<number | null>((resolve) => holder.on("exit", resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout.on("data", () => out.includes("held\n") && resolve());
        holder.on("error", reject);
        void exited.then((code) =>
          reject(new Error(`the lock holder exited (${code}) before it held the lock`)),
        );
      });
      let checked = "";
      const times = await lockTimes(
        async () => {
          checked = (
            await checkText(db.ingest, draft, p, null, { units: [decided("kept", m, "Keep it.", true)] })
          ).text;
        },
        () => fs.writeFileSync(signal, ""),
      );
      assert.equal(await exited, 0);
      const released = Number(/released (\d+)/.exec(out)?.[1]);
      assert.match(checked, new RegExp(`✓ would be active: ${PREFIX}kept`));
      assert.ok(
        times.askedAt <= released && released <= times.beganAt,
        `asked ${times.askedAt}, released ${released}, began ${times.beganAt}`,
      );
    } finally {
      if (holder.exitCode === null) holder.kill();
      await exited;
    }
  } finally {
    await db.done();
  }
});
