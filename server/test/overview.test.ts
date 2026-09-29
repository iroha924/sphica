// The overview views against real SQLite: live lists every active decision and constraint once, grouped by directory, page by page
// without skipping any; nothing superseded, withdrawn, or still a candidate shows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { inTransaction } from "../src/db.ts";
import { liveOverview, OVERVIEW_LIMITS } from "../src/overview.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { openRun } from "../src/trace.ts";
import { at, message, project, type TempDb, tempDb } from "./temp-db.ts";

const now = at("2026-09-29T00:00:00Z");

async function save(db: TempDb, p: number, units: unknown[]) {
  const t: Target = {
    projectId: p,
    origin: "trace",
    prefix: "trace:ext-s1/",
    sessionId: "s1",
    root: null,
    sources: null,
  };
  return inTransaction(db.ingest, async (trx) => {
    const runId = await openRun(trx, {
      projectId: p,
      origin: "trace",
      target: "session:s1",
      sessionId: "s1",
      draftId: `d${Math.random()}`,
    });
    return saveRecord(trx, t, runId, await checkRecord(trx, t, { units }), []);
  });
}

const said = "Keep it simple. Decided.";
const record = (m: number, key: string, kind: string, extra: Record<string, unknown> = {}) => ({
  key,
  kind,
  ...(["decision", "constraint"].includes(kind) ? { stance: "do" } : {}),
  text: `${key} text`,
  evidence: [{ source: `s${m}`, quote: said, role: "states" }],
  ...(["decision", "constraint"].includes(kind) ? { adoption: [{ source: `s${m}`, quote: said }] } : {}),
  ...extra,
});
const keys = (page: string) => [...page.matchAll(/^- (trace:\S+) /gm)].map((x) => x[1]);
const next = (page: string) => Number(/after: (\d+)\./.exec(page)?.[1] ?? Number.NaN);

test("live lists every active decision and constraint once by directory, and nothing superseded, withdrawn, or a candidate", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: said });
    await save(db, p, [
      record(m, "db", "decision", {
        anchors: [
          { path: "server/src/db.ts", role: "applies_to" },
          { path: "cli/main.ts", role: "applies_to" },
        ],
      }),
      record(m, "top", "constraint", { anchors: [{ path: "README.md", role: "applies_to" }] }),
      record(m, "wide", "constraint"),
      record(m, "only-evidence", "decision", { anchors: [{ path: "server/src/x.ts", role: "evidence" }] }),
      record(m, "found", "finding"),
      record(m, "old", "decision"),
      record(m, "gone", "decision"),
      { ...record(m, "maybe", "decision"), adoption: [] },
    ]);
    await save(db, p, [record(m, "new", "decision", { supersedes: "trace:ext-s1/old" })]);
    db.owner
      .prepare(
        "insert into unit_state (unit_id, from_state, to_state, at, reason, run_id) select id, 'active', 'withdrawn', ?, 'r', run_id from unit where key = 'trace:ext-s1/gone'",
      )
      .run(now);
    const page = await liveOverview(db.reader, p, null);
    assert.deepEqual(keys(page).sort(), [
      "trace:ext-s1/db",
      "trace:ext-s1/new",
      "trace:ext-s1/only-evidence",
      "trace:ext-s1/top",
      "trace:ext-s1/wide",
    ]);
    // Grouped by the first applies_to anchor's directory, root files together, records with no place last; all paths on the line
    assert.match(
      page,
      /^## \(repository root\)\n- trace:ext-s1\/top \(constraint do\): top text \[README\.md\]$/m,
    );
    assert.match(
      page,
      /^## server\/src\/\n- trace:ext-s1\/db \(decision do\): db text \[server\/src\/db\.ts, cli\/main\.ts\]$/m,
    );
    assert.ok(page.indexOf("## Project-wide") > page.indexOf("## server/src/"));
    assert.match(page, /^5 shown of 5 active decisions and constraints\.\nThat is the end of the list\.$/m);
    assert.match(
      await liveOverview(db.reader, project(db, "git:github.com/o/empty", "o/empty"), null),
      /No active decision/,
    );
  } finally {
    await db.done();
  }
});

test("live pages by id: a record superseded between pages skips nothing after it, and its successor comes on a later page", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: said });
    const count = OVERVIEW_LIMITS.records + 5;
    for (let i = 0; i < count; i += 25)
      await save(
        db,
        p,
        Array.from({ length: Math.min(25, count - i) }, (_, k) =>
          record(m, `c${String(i + k).padStart(3, "0")}`, "constraint"),
        ),
      );
    const first = await liveOverview(db.reader, p, null);
    assert.equal(keys(first).length, OVERVIEW_LIMITS.records);
    assert.match(first, new RegExp(`^${OVERVIEW_LIMITS.records} shown of ${count} `, "m"));
    // Replacing a record already shown moves nothing: the cursor is an id, not a position
    await save(db, p, [record(m, "c000-next", "constraint", { supersedes: "trace:ext-s1/c000" })]);
    const second = await liveOverview(db.reader, p, next(first));
    assert.deepEqual(keys(second), [
      "trace:ext-s1/c050",
      "trace:ext-s1/c051",
      "trace:ext-s1/c052",
      "trace:ext-s1/c053",
      "trace:ext-s1/c054",
      "trace:ext-s1/c000-next",
    ]);
    assert.match(second, /That is the end of the list\./);
    assert.match(
      await liveOverview(db.reader, p, 1_000_000),
      /No active decision or constraint after id 1000000/,
    );
  } finally {
    await db.done();
  }
});
