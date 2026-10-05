// The overview views against real SQLite: live lists every active decision and constraint once, grouped by directory, page by page
// without skipping any; nothing superseded, withdrawn, or still a candidate shows. look names gone files, lost symbols, conditions to
// reconsider, and marked instruction lines whose record changed, and says what it could not check.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AI_DECIDED } from "../src/authority.ts";
import { inTransaction } from "../src/db.ts";
import { framed } from "../src/frame.ts";
import { liveOverview, lookCursor, lookOverview, OVERVIEW_LIMITS } from "../src/overview.ts";
import { READ_BUDGET } from "../src/read.ts";
import { reconcile } from "../src/reconcile.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { openRun } from "../src/trace.ts";
import { aiDecided, message, project, run, type TempDb, tempDb } from "./temp-db.ts";

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
      .run(new Date().toISOString());
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
      /^## \(repository root\)\n- trace:ext-s1\/top \(u\d+, constraint do\): top text \[README\.md\]$/m,
    );
    assert.match(
      page,
      /^## server\/src\/\n- trace:ext-s1\/db \(u\d+, decision do\): db text \[server\/src\/db\.ts, cli\/main\.ts\]$/m,
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
      .run(new Date().toISOString());

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

test("look counts what it could not check, follows a long chain to its live end, reads long keys, and keeps each page within the reply budget", async () => {
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
    // Many long lines fill the first page, which says where to go on; the rest come on later pages
    const pages = await lookPages(db, p, root);
    assert.match(pages[0] ?? "", /^Partial: more follow\. Call overview with view look and after: "/m);
    const look = pages.join("\n");
    assert.match(look, /- 1 code locations whose file could not be scanned/);
    assert.match(look, /AGENTS\.md:1: trace:ext-s1\/v0 was superseded by trace:ext-s1\/v25\n/);
    assert.match(look, /AGENTS\.md:2: trace:s{400}\/k was superseded by trace:s{400}\/k2/);
    assert.equal([...look.matchAll(/^- AGENTS\.md:\d+: /gm)].length, 62);
    assert.equal([...look.matchAll(/^- trace:ext-s1\/g\d+ \(constraint\): /gm)].length, 150);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    await db.done();
  }
});

test("live names each record by id too, so a clipped key can still be read, and never merges directories a clipped heading makes look alike", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: said });
    const common = "c".repeat(130);
    await save(db, p, [
      record(m, "x", "constraint", { anchors: [{ path: `${common}/x/a.ts`, role: "applies_to" }] }),
      record(m, "y", "constraint", { anchors: [{ path: `${common}/y/b.ts`, role: "applies_to" }] }),
    ]);
    const page = await liveOverview(db.reader, p, null);
    assert.equal([...page.matchAll(/^## /gm)].length, 2);
    assert.match(page, /^- trace:ext-s1\/x \(u\d+, constraint do\): x text/m);
  } finally {
    await db.done();
  }
});

test("look reads more distinct markers than SQLite takes in one query", async () => {
  const db = tempDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-look-"));
  try {
    const p = project(db);
    fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
    for (let f = 0; f < 6; f++)
      fs.writeFileSync(
        path.join(root, ".claude", "rules", `r${f}.md`),
        Array.from({ length: 6000 }, (_, i) => `<!-- sphica: trace:x/${f}-${i} -->`).join("\n"),
      );
    const look = await lookOverview(db.reader, p, root);
    assert.match(look, /- \.claude\/rules\/r0\.md:1: trace:x\/0-0 is not a record of this project/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    await db.done();
  }
});

test("look follows a replaced record's chain once, however many lines mark it", async () => {
  const db = tempDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-look-"));
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: said });
    await save(db, p, [record(m, "old", "constraint")]);
    await save(db, p, [record(m, "new", "constraint", { supersedes: "trace:ext-s1/old" })]);
    fs.writeFileSync(
      path.join(root, "AGENTS.md"),
      Array.from({ length: 1000 }, () => "- rule <!-- sphica: trace:ext-s1/old -->").join("\n"),
    );
    let queries = 0;
    const counted = db.reader.withPlugin({
      transformQuery: (a) => {
        queries++;
        return a.node;
      },
      transformResult: async (a) => a.result,
    });
    const look = await lookOverview(counted, p, root);
    assert.match(look, /AGENTS\.md:1: trace:ext-s1\/old was superseded by trace:ext-s1\/new/);
    assert.ok(queries < 20, `${queries} queries`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    await db.done();
  }
});

test("look follows only replacements in effect: a chain of three ends at its live record, and one withdrawn hands the place back", async () => {
  const db = tempDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-look-"));
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: said });
    await save(db, p, [record(m, "old", "constraint")], root);
    await save(db, p, [record(m, "mid", "constraint", { supersedes: "trace:ext-s1/old" })], root);
    await save(db, p, [record(m, "new", "constraint", { supersedes: "trace:ext-s1/mid" })], root);
    fs.writeFileSync(
      path.join(root, "CLAUDE.md"),
      ["old", "mid", "new"].map((k) => `- rule <!-- sphica: trace:ext-s1/${k} -->`).join("\n"),
    );
    const look = await lookOverview(db.reader, p, root);
    assert.match(look, /CLAUDE\.md:1: trace:ext-s1\/old was superseded by trace:ext-s1\/new\n/);
    assert.match(look, /CLAUDE\.md:2: trace:ext-s1\/mid was superseded by trace:ext-s1\/new\n/);
    // The end of the chain is withdrawn: its replacement of mid ends, so mid is live again and old leads to it
    const id = Number(db.owner.prepare("select id from unit where key = 'trace:ext-s1/new'").get()?.id);
    const runId = run(db, p);
    await inTransaction(db.ingest, (trx) =>
      reconcile(
        trx,
        [id],
        { runId },
        { withdraw: new Map([[id, { reason: "the owner withdrew it", source: null }]]) },
      ),
    );
    const after = await lookOverview(db.reader, p, root);
    assert.match(after, /CLAUDE\.md:1: trace:ext-s1\/old was superseded by trace:ext-s1\/mid\n/);
    assert.doesNotMatch(after, /CLAUDE\.md:2:/);
    assert.match(after, /CLAUDE\.md:3: trace:ext-s1\/new was withdrawn/);
  } finally {
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("look names the successor that took the owner's decision's place, not a proposal still waiting beside it", async () => {
  const db = tempDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-look-"));
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: said });
    await save(db, p, [record(m, "old-rule", "constraint")], root);
    await save(
      db,
      p,
      [record(m, "waiting", "constraint", { adoption: [], supersedes: "trace:ext-s1/old-rule" })],
      root,
    );
    await save(db, p, [record(m, "new-rule", "constraint", { supersedes: "trace:ext-s1/old-rule" })], root);
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "- An old rule <!-- sphica: trace:ext-s1/old-rule -->\n");
    assert.match(
      await lookOverview(db.reader, p, root),
      /CLAUDE\.md:1: trace:ext-s1\/old-rule was superseded by trace:ext-s1\/new-rule\n/,
    );
  } finally {
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the live overview marks an AI's decision, with Sphica's words for it", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    aiDecided(db, p, "pool", "I keep the connection pool small.", "src/db.ts");
    const page = await liveOverview(db.reader, p, null);
    assert.match(
      page,
      /^- trace:ext-s1\/pool \(u\d+, decision do, decided by an AI\): I keep the connection pool small\./m,
    );
    assert.ok(page.includes(AI_DECIDED));
  } finally {
    await db.done();
  }
});

/** Every page of look, following the cursor each page names, with each page's size checked */
async function lookPages(db: TempDb, p: number, root: string | null) {
  const pages: string[] = [];
  let after: string | undefined;
  for (let n = 0; n < 50; n++) {
    const page = await lookOverview(db.reader, p, root, after);
    assert.ok(
      Buffer.byteLength(framed(page)) <= READ_BUDGET,
      `page ${n}: ${Buffer.byteLength(framed(page))} bytes`,
    );
    pages.push(page);
    after = /after: "([^"]+)"/.exec(page)?.[1];
    if (!after) break;
  }
  return pages;
}

test("look cursor: 2,500 anchors are all checked across pages, a page of anchors with nothing to show moves on, and the last says Complete", async () => {
  const db = tempDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-look-cursor-"));
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: said });
    for (let s = 0; s < 3; s++)
      await save(
        db,
        p,
        Array.from({ length: 50 }, (_, i) =>
          record(m, `a${s}-${i}`, "constraint", {
            anchors: Array.from({ length: 20 }, (_, k) => ({
              path: `d/${s}-${i}-${k}.ts`,
              role: "applies_to",
            })),
          }),
        ).slice(0, s === 2 ? 25 : 50),
      );
    fs.mkdirSync(path.join(root, "d"));
    for (let s = 0; s < 3; s++)
      for (let i = 0; i < 50; i++)
        for (let k = 0; k < 20; k++) fs.writeFileSync(path.join(root, "d", `${s}-${i}-${k}.ts`), "x\n");
    // Only the last of the 2,500 anchors points at a file that is gone
    fs.rmSync(path.join(root, "d", "2-24-19.ts"));
    const pages = await lookPages(db, p, root);
    const all = pages.join("\n");
    assert.equal([...all.matchAll(/d\/2-24-19\.ts/g)].length, 1, all.slice(0, 2000));
    assert.match(pages.at(-1) ?? "", /Complete: every section was listed to its end\./);
    assert.ok(pages.length >= 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    await db.done();
  }
});

test("look cursor: gone and lost anchors, long lists of conditions of both kinds, and markers across files each come once over the pages", async () => {
  const db = tempDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-look-stages-"));
  try {
    const p = project(db);
    const when = "if replicas are ever needed";
    const m = message(db, p, { id: "m1", text: `${said} If replicas are ever needed, look again.` });
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "keep.ts"), "export function open() {}\n");
    fs.writeFileSync(path.join(root, "src", "gone.ts"), "export const x = 1;\n");
    const long = (n: number) => `${"o".repeat(100)}${n}`;
    await save(db, p, [
      record(m, "gone-file", "decision", { anchors: [{ path: "src/gone.ts", role: "applies_to" }] }),
      record(m, "lost-symbol", "constraint", {
        anchors: [{ path: "src/keep.ts", symbol: "close", role: "applies_to" }],
      }),
      record(m, "fine", "decision", {
        anchors: [{ path: "src/keep.ts", symbol: "open", role: "applies_to" }],
      }),
      // 120 rejected options with conditions, 12 to a record
      ...Array.from({ length: 10 }, (_, r) =>
        record(m, `opts${r}`, "decision", {
          options: Array.from({ length: 12 }, (_, o) => ({
            text: `${long(r * 12 + o)}`,
            outcome: "rejected",
            reconsider_when: `${when} ${"w".repeat(320)}`,
            reconsider_quote: { source: `s${m}`, quote: "If replicas are ever needed, look again." },
          })),
        }),
      ),
    ]);
    // 120 deferred records, saved 50 at a time
    for (let b = 0; b < 3; b++)
      await save(
        db,
        p,
        Array.from({ length: b === 2 ? 20 : 50 }, (_, i) => ({
          ...record(m, `later${b * 50 + i}`, "decision"),
          stance: "defer",
          text: long(b * 50 + i),
          revisit_when: `after the release ${"r".repeat(320)}`,
        })),
      );
    fs.rmSync(path.join(root, "src", "gone.ts"));
    // Markers in two files, two on some lines, naming records that are not this project's
    const mark = (k: string) => `<!-- sphica: trace:${"u".repeat(900)}/${k} -->`;
    fs.writeFileSync(
      path.join(root, "CLAUDE.md"),
      `${Array.from({ length: 40 }, (_, i) => `- ${mark(`c${i}a`)} ${mark(`c${i}b`)}`).join("\n")}\n`,
    );
    fs.writeFileSync(
      path.join(root, "AGENTS.md"),
      `${Array.from({ length: 10 }, (_, i) => `- ${mark(`a${i}`)}`).join("\n")}\n`,
    );
    const pages = await lookPages(db, p, root);
    const all = pages.join("\n");
    assert.ok(pages.length >= 4, `${pages.length} pages`);
    assert.equal([...all.matchAll(/^- trace:ext-s1\/gone-file \(decision\): src\/gone\.ts/gm)].length, 1);
    assert.equal(
      [...all.matchAll(/^- trace:ext-s1\/lost-symbol \(constraint\): close in src\/keep\.ts/gm)].length,
      1,
    );
    assert.doesNotMatch(all, /trace:ext-s1\/fine/);
    for (let n = 0; n < 120; n++) {
      assert.equal(
        [...all.matchAll(new RegExp(`rejected option ${long(n)},`, "g"))].length,
        1,
        `option ${n}`,
      );
      assert.equal([...all.matchAll(new RegExp(`deferred ${long(n)},`, "g"))].length, 1, `deferred ${n}`);
    }
    for (const k of [
      ...Array.from({ length: 40 }, (_, i) => [`c${i}a`, `c${i}b`]).flat(),
      ...Array.from({ length: 10 }, (_, i) => `a${i}`),
    ])
      assert.equal([...all.matchAll(new RegExp(`u{900}/${k} is not a record`, "g"))].length, 1, k);
    assert.match(
      pages.at(-1) ?? "",
      /Complete: every section was listed to its end\. Not checked entries on any page still apply\./,
    );
    for (const page of pages.slice(0, -1)) assert.match(page, /^Partial: more follow\./m);
    // A cursor that is not one a page gave is refused
    await assert.rejects(lookOverview(db.reader, p, root, "bm90IGEgY3Vyc29y"), /not a cursor/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    await db.done();
  }
});

test("overview refuses a cursor for the other view, and a broken one, before reading anything", async () => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "mcp.ts")],
      env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", SPHICA_DB: "/nonexistent/sphica.db" },
      stderr: "ignore",
    }),
  );
  try {
    const call = async (args: Record<string, unknown>) => {
      const r = await client.callTool({ name: "overview", arguments: { ...args, cwd: "/nonexistent" } });
      return { error: r.isError === true, text: (r.content as { text: string }[])[0]?.text ?? "" };
    };
    assert.deepEqual(await call({ view: "live", after: "abc" }), {
      error: true,
      text: "after: with view live, pass the id the previous page gave",
    });
    assert.deepEqual(await call({ view: "look", after: 3 }), {
      error: true,
      text: "after: with view look, pass the cursor the previous page gave, as it is",
    });
    assert.deepEqual(await call({ view: "look", after: "not-a-cursor" }), {
      error: true,
      text: "after: not a cursor a look page gave; call look without after to start again",
    });
  } finally {
    await client.close();
  }
});

test("look cursor strict: only the exact text a page gave is a cursor, not one with characters base64url decoding skips", () => {
  const given = Buffer.from(JSON.stringify({ s: "anchors", id: 2000 })).toString("base64url");
  assert.deepEqual(lookCursor(given), { s: "anchors", id: 2000 });
  for (const broken of [`${given}!`, `!${given}`, `${given.slice(0, 4)} ${given.slice(4)}`, `${given}=`])
    assert.equal(lookCursor(broken), null, broken);
});
