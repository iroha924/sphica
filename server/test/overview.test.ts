// The overview views against real SQLite: live lists every active decision and constraint once, grouped by directory, page by page
// without skipping any; nothing superseded, withdrawn, or still a candidate shows. look names gone files, lost symbols, conditions to
// reconsider, and marked instruction lines whose record changed, and says what it could not check.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inTransaction } from "../src/db.ts";
import { liveOverview, lookOverview, OVERVIEW_LIMITS } from "../src/overview.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { openRun } from "../src/trace.ts";
import { at, message, project, type TempDb, tempDb } from "./temp-db.ts";

const now = at("2026-09-29T00:00:00Z");

async function save(db: TempDb, p: number, units: unknown[], root: string | null = null) {
  const t: Target = {
    projectId: p,
    origin: "trace",
    prefix: "trace:ext-s1/",
    sessionId: "s1",
    root,
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

test("look names gone files apart from lost symbols, conditions to reconsider, and marked lines whose record changed", async () => {
  const db = tempDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-look-"));
  try {
    const p = project(db);
    const m = message(db, p, {
      id: "m1",
      text: `${said} If replicas are ever needed, look at Postgres again.`,
    });
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(
      path.join(root, "src", "keep.ts"),
      "export function open() {}\nexport function close() {}\n",
    );
    fs.writeFileSync(path.join(root, "src", "gone.ts"), "export const x = 1;\n");
    await save(
      db,
      p,
      [
        record(m, "gone-file", "decision", { anchors: [{ path: "src/gone.ts", role: "applies_to" }] }),
        record(m, "lost-symbol", "constraint", {
          anchors: [{ path: "src/keep.ts", symbol: "close", role: "applies_to" }],
        }),
        record(m, "fine", "decision", {
          anchors: [{ path: "src/keep.ts", symbol: "open", role: "applies_to" }],
        }),
        record(m, "storage", "decision", {
          options: [
            {
              text: "Postgres",
              outcome: "rejected",
              reconsider_when: "if replicas are ever needed",
              reconsider_quote: {
                source: `s${m}`,
                quote: "If replicas are ever needed, look at Postgres again.",
              },
            },
          ],
        }),
        { ...record(m, "later", "decision"), stance: "defer", revisit_when: "after the 1.0 release" },
        record(m, "old-rule", "constraint"),
        record(m, "dropped-rule", "constraint"),
        record(m, "kept-rule", "constraint"),
      ],
      root,
    );
    fs.rmSync(path.join(root, "src", "gone.ts"));
    fs.writeFileSync(path.join(root, "src", "keep.ts"), "export function open() {}\n");
    fs.writeFileSync(
      path.join(root, "CLAUDE.md"),
      [
        "- Keep one rule <!-- sphica: trace:ext-s1/kept-rule -->",
        "- An old rule <!-- sphica: trace:ext-s1/old-rule -->",
        "- A dropped rule <!--sphica:trace:ext-s1/dropped-rule-->",
        "- A made-up one <!-- sphica: trace:ext-s1/nothing -->",
        "- Not a Sphica marker <!-- invariant: x -->",
      ].join("\n"),
    );
    await save(db, p, [record(m, "new-rule", "constraint", { supersedes: "trace:ext-s1/old-rule" })]);
    db.owner
      .prepare(
        "insert into unit_state (unit_id, from_state, to_state, at, reason, run_id) select id, 'active', 'withdrawn', ?, 'r', run_id from unit where key = 'trace:ext-s1/dropped-rule'",
      )
      .run(now);

    const look = await lookOverview(db.reader, p, root);
    const under = (title: string) => look.split("\n\n").find((x) => x.startsWith(`## ${title}`)) ?? "";
    assert.equal(
      under("Files gone"),
      "## Files gone\n- trace:ext-s1/gone-file (decision): src/gone.ts (applies_to)",
    );
    assert.equal(
      under("Symbol not found"),
      "## Symbol not found (the file is still there)\n- trace:ext-s1/lost-symbol (constraint): close in src/keep.ts (applies_to)",
    );
    assert.match(
      under("Conditions to reconsider"),
      /- trace:ext-s1\/storage: rejected option Postgres, reconsider when: if replicas are ever needed\n- trace:ext-s1\/later: deferred later text, revisit when: after the 1\.0 release$/,
    );
    assert.equal(
      under("Rule markers"),
      [
        "## Rule markers whose record changed",
        "- CLAUDE.md:2: trace:ext-s1/old-rule was superseded by trace:ext-s1/new-rule",
        "- CLAUDE.md:3: trace:ext-s1/dropped-rule was withdrawn",
        "- CLAUDE.md:4: trace:ext-s1/nothing is not a record of this project",
      ].join("\n"),
    );
    assert.match(under("Not checked"), /nothing: every place above was checked/);
    // A symlink leading outside and no working tree at all are said, never read as "none"
    fs.symlinkSync(os.tmpdir(), path.join(root, "out"));
    await save(db, p, [
      record(m, "outside", "decision", { anchors: [{ path: "out/x.ts", role: "applies_to" }] }),
    ]);
    assert.match(
      await lookOverview(db.reader, p, root),
      /- 1 code locations that lead outside the repository/,
    );
    const blind = await lookOverview(db.reader, p, null);
    assert.match(blind, /## Files gone\nnot checked/);
    assert.match(blind, /## Rule markers whose record changed\nnot checked/);
    assert.match(blind, /- instruction files: no working tree/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    await db.done();
  }
});

test("live keeps every record on one line with its paths, and a page stays under 64 KiB whatever the text, keys, and paths", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: said });
    const long = "x".repeat(2000);
    await save(
      db,
      p,
      Array.from({ length: 49 }, (_, i) =>
        record(m, `r${i}`, "constraint", {
          text: long,
          anchors: [{ path: `${"d".repeat(440)}${i}/f.ts`, role: "applies_to" }],
        }),
      ),
    );
    // A key's session part comes from the host; a line break in it must not start a line of its own
    const forged: Target = {
      projectId: p,
      origin: "trace",
      prefix: "trace:ext\n## forged/",
      sessionId: "s1",
      root: null,
      sources: null,
    };
    await inTransaction(db.ingest, async (trx) => {
      const runId = await openRun(trx, {
        projectId: p,
        origin: "trace",
        target: "session:s1",
        sessionId: "s1",
        draftId: "forged",
      });
      await saveRecord(
        trx,
        forged,
        runId,
        await checkRecord(trx, forged, { units: [record(m, "k", "constraint")] }),
        [],
      );
    });
    const page = await liveOverview(db.reader, p, null);
    assert.ok(Buffer.byteLength(page) < 64 * 1024, `${Buffer.byteLength(page)} bytes`);
    assert.doesNotMatch(page, /^## forged/m);
    assert.equal([...page.matchAll(/\/f\.ts\]/g)].length, 49);
  } finally {
    await db.done();
  }
});

test("look counts what it could not check, follows a long chain to its live end, reads long keys, and stays under 64 KiB", async () => {
  const db = tempDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-look-"));
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: said });
    // A file too large to scan for its symbol is there, but whether the symbol is cannot be said
    fs.writeFileSync(path.join(root, "big.ts"), "export function open() {}\n");
    await save(
      db,
      p,
      [record(m, "big", "decision", { anchors: [{ path: "big.ts", symbol: "open", role: "applies_to" }] })],
      root,
    );
    fs.writeFileSync(path.join(root, "big.ts"), "x".repeat(3 * 1024 * 1024));
    // Many gone files with long paths: the reply stops within its budget and says how many it left out
    await save(
      db,
      p,
      Array.from({ length: 50 }, (_, i) =>
        record(m, `g${i}`, "constraint", {
          anchors: Array.from({ length: 3 }, (_, k) => ({
            path: `${"p".repeat(200)}/${"q".repeat(200)}/${i}-${k}.ts`,
            role: "applies_to",
          })),
        }),
      ),
    );
    // A chain of 25 replacements
    await save(db, p, [record(m, "v0", "constraint")]);
    for (let i = 1; i <= 25; i++)
      await save(db, p, [record(m, `v${i}`, "constraint", { supersedes: `trace:ext-s1/v${i - 1}` })]);
    // A key longer than 300 characters, as a long session id makes it
    const long: Target = {
      projectId: p,
      origin: "trace",
      prefix: `trace:${"s".repeat(400)}/`,
      sessionId: "s1",
      root: null,
      sources: null,
    };
    await inTransaction(db.ingest, async (trx) => {
      const runId = await openRun(trx, {
        projectId: p,
        origin: "trace",
        target: "session:s1",
        sessionId: "s1",
        draftId: "long",
      });
      await saveRecord(
        trx,
        long,
        runId,
        await checkRecord(trx, long, { units: [record(m, "k", "constraint")] }),
        [],
      );
      await saveRecord(
        trx,
        long,
        runId,
        await checkRecord(trx, long, {
          units: [record(m, "k2", "constraint", { supersedes: `trace:${"s".repeat(400)}/k` })],
        }),
        [],
      );
    });
    fs.writeFileSync(
      path.join(root, "AGENTS.md"),
      `- first <!-- sphica: trace:ext-s1/v0 -->\n- long <!-- sphica: trace:${"s".repeat(400)}/k -->\n${Array.from(
        { length: 60 },
        (_, i) => `- made up <!-- sphica: trace:${"u".repeat(900)}/${i} -->`,
      ).join("\n")}\n`,
    );
    const look = await lookOverview(db.reader, p, root);
    assert.ok(Buffer.byteLength(look) < 64 * 1024, `${Buffer.byteLength(look)} bytes`);
    assert.match(look, /- 1 code locations whose file could not be scanned/);
    assert.match(look, /AGENTS\.md:1: trace:ext-s1\/v0 was superseded by trace:ext-s1\/v25\n/);
    assert.match(look, /AGENTS\.md:2: trace:s{400}\/k was superseded by trace:s{400}\/k2/);
    assert.match(look, /\(\d+ more not shown/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    await db.done();
  }
});
