// The record server's flows against real SQLite and a real git repository: begin binds a run, context, check, and save take its id,
// and glean's changes cite owner messages, fetched GitHub sources, or file excerpts read from git.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { bindOwner } from "../src/admin.ts";
import { openReader } from "../src/db.ts";
import {
  beginGlean,
  beginHarvest,
  beginTrace,
  checkText,
  contextText,
  gleanFetch,
  pendingText,
  saveText,
} from "../src/extract.ts";
import { applyForget, previewForget } from "../src/forget.ts";
import { type Get, gh } from "../src/github.ts";
import { readRefs, readUnit } from "../src/read.ts";
import { PROBE, type Probe } from "../src/repo-facts.ts";
import { searchUnits } from "../src/search.ts";
import { dump, insert, message, plan, project, session, statements, type TempDb, tempDb } from "./temp-db.ts";

// begin sends the recording queue first; it must read an empty queue under a temporary HOME, never the owner's
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-extract-home-"));
const saved = {
  HOME: process.env.HOME,
  SPHICA_DB: process.env.SPHICA_DB,
  CLAUDE: process.env.CLAUDE_CODE_SESSION_ID,
  CODEX: process.env.CODEX_THREAD_ID,
};
before(() => {
  process.env.HOME = home;
  process.env.SPHICA_DB = path.join(home, "none.db");
  // SPHICA_HOME would win over the swapped HOME, and flush would read that directory's queue
  delete process.env.SPHICA_HOME;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CODEX_THREAD_ID;
});
after(() => {
  for (const [k, v] of [
    ["HOME", saved.HOME],
    ["SPHICA_DB", saved.SPHICA_DB],
    ["CLAUDE_CODE_SESSION_ID", saved.CLAUDE],
    ["CODEX_THREAD_ID", saved.CODEX],
  ] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  fs.rmSync(home, { recursive: true, force: true });
});

/** A committed repository with a CRLF note, a symlink, a binary file, and an oversized file. */
function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-extract-repo-"));
  const git = (...a: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        dir,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...a,
      ],
      { stdio: "ignore" },
    );
  git("init", "-q");
  fs.mkdirSync(path.join(dir, "docs"));
  fs.writeFileSync(path.join(dir, "docs", "note.md"), "# Notes\r\n\r\nBack up before a release.\r\n");
  fs.writeFileSync(path.join(dir, "src.ts"), "export function openStore() {}\n");
  fs.writeFileSync(path.join(dir, "logo.bin"), Buffer.from([1, 0, 2]));
  fs.writeFileSync(path.join(dir, "huge.txt"), "x".repeat(1024 * 1024 + 1));
  fs.writeFileSync(path.join(dir, "latin1.txt"), Buffer.from([0xe9, 0x0a]));
  fs.symlinkSync("../outside.txt", path.join(dir, "link.ts"));
  git("add", "-A");
  git("commit", "-qm", "first");
  return dir;
}

const fakeGet: Get = async (p) => {
  const key = p.split("?")[0] ?? "";
  const user = { login: "kai", id: 4, type: "User" };
  const answers: Record<string, unknown> = {
    "pulls/3": {
      number: 3,
      title: "t",
      body: "Keep notes out of CSV.",
      html_url: "u",
      created_at: "2026-03-01T00:00:00Z",
      merged_at: null,
      user,
      author_association: "MEMBER",
    },
    "issues/3/comments": [],
    "pulls/3/reviews": [],
    "pulls/3/comments": [],
    "pulls/3/commits": [],
    "issues/9": {
      number: 9,
      body: "Notes must never be exported.",
      html_url: "u",
      created_at: "2026-03-01T00:00:00Z",
      user,
      author_association: "MEMBER",
    },
    "issues/9/comments": [
      {
        id: 91,
        body: "Agreed by the team.",
        user,
        author_association: "MEMBER",
        created_at: "2026-03-01T01:00:00Z",
        html_url: "u",
      },
    ],
  };
  if (!(key in answers)) throw new Error(`no answer for ${p}`);
  return answers[key];
};

const place = (p: number, root: string) => ({ key: "git:github.com/o/r", root, name: "o/r", projectId: p });

test("check reports what save would, and leaves the database as it was: trace with work, and glean with a file excerpt", async () => {
  const db = tempDb();
  const root = repo();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "SQLite にしよう。" });
    const aside = message(db, p, { id: "m2", text: "ところで昼は何にする？" });
    const run = await beginTrace(db.ingest, p, "s1");
    await contextText(db.ingest, run, p, null);
    const record = {
      units: [
        {
          key: "storage",
          kind: "decision",
          stance: "do",
          text: "SQLite に保存する",
          evidence: [{ source: `s${m}`, quote: "SQLite にしよう。", role: "states" }],
          adoption: [{ source: `s${m}`, quote: "SQLite にしよう。" }],
          aliases: ["保存先", "storage"],
        },
      ],
      work: {
        key: "storage",
        title: "保存先",
        goal: "1 ファイル",
        current: "決めた",
        next: [],
        status: "done",
      },
    };
    const found = async () =>
      (await searchUnits(db.reader, p, { question: "保存先", limit: 5 })).hits.map((h) => h.key);
    const before = dump(db);
    // Checked twice: neither check leaves anything, and the save after them still marks what context showed
    for (let i = 0; i < 2; i++) {
      const checked = await checkText(db.ingest, run, p, null, record);
      assert.equal(checked.ok, true);
      assert.match(checked.text, /✓ would be active: trace:ext-s1\/storage/);
      assert.deepEqual(dump(db), before);
      assert.deepEqual(await found(), []);
    }
    assert.match(await saveText(db.ingest, run, p, null, record), /✓ trace:ext-s1\/storage active/);
    assert.deepEqual(await found(), ["trace:ext-s1/storage"]);
    assert.deepEqual(
      db.owner.prepare("select outcome from source_processing where source_id = ?").all(aside),
      [{ outcome: "no_unit" }].map((r) => Object.assign(Object.create(null), r)),
    );

    session(db, p, "g1");
    const o = message(db, p, { id: "o1", text: "src.ts の openStore を見る。", session: "g1" });
    const first = await beginGlean(db.ingest, p, "g1");
    const look = {
      units: [
        {
          key: "look",
          kind: "finding",
          text: "openStore を見る",
          evidence: [{ source: `s${o}`, quote: "src.ts の openStore を見る。", role: "states" }],
        },
      ],
    };
    const unsourced = await checkText(db.ingest, first, p, root, look);
    assert.match(unsourced.text, /△ glean:look: its only evidence is the owner's words in this session/);
    assert.match(unsourced.text, /△ would stay a candidate: glean:look/);
    await saveText(db.ingest, first, p, root, look);
    const g = await beginGlean(db.ingest, p, "g1");
    const rev = Number(
      db.owner.prepare("select revision from unit where key = 'glean:look'").get()?.revision,
    );
    const ops = {
      ops: [
        {
          op: "add_evidence",
          unit: "glean:look",
          revision: rev,
          file: { path: "docs/note.md", lines: [3, 3] },
          quote: "Back up before a release.",
          role: "explains",
        },
      ],
    };
    const gleaned = dump(db);
    const checked = await checkText(db.ingest, g, p, root, ops);
    assert.match(checked.text, /✓ would: glean:look: evidence added/);
    assert.deepEqual(dump(db), gleaned);
    assert.match(await saveText(db.ingest, g, p, root, ops), /✓ glean:look: evidence added/);
    assert.equal(
      Number(db.owner.prepare("select count(*) as n from source where kind = 'file_excerpt'").get()?.n),
      1,
    );
  } finally {
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("trace: pending lists the session, begin binds it, and check and save take the run id", async () => {
  const db: TempDb = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "SQLite にしよう。" });
    assert.match(
      await pendingText(db.ingest, p, new Date("2026-09-20T00:00:00Z")),
      /1 session to trace[\s\S]*- s1 claude-code/,
    );
    await assert.rejects(beginTrace(db.ingest, p), /Pass the session/);
    await assert.rejects(beginTrace(db.ingest, p, "nope"), /No captured session/);
    const run = await beginTrace(db.ingest, p, "s1");
    assert.match(
      await contextText(db.ingest, run, p, null),
      /## s\d+ owner[\s\S]*SQLite にしよう。[\s\S]*Live records of this project/,
    );
    const record = {
      units: [
        {
          key: "storage",
          kind: "decision",
          stance: "do",
          text: "SQLite",
          evidence: [{ source: `s${m}`, quote: "SQLite にしよう。", role: "states" }],
          adoption: [{ source: `s${m}`, quote: "SQLite にしよう。" }],
        },
      ],
    };
    assert.deepEqual(await checkText(db.ingest, run, p, null, { units: "x" }).then((c) => c.ok), false);
    // Another session's words cannot back this run's record, even in the same project
    const elsewhere = message(db, p, { id: "m9", text: "Postgres にしよう。", session: "s9" });
    const borrowed = JSON.parse(
      JSON.stringify(record)
        .replaceAll(`s${m}`, `s${elsewhere}`)
        .replaceAll("SQLite にしよう。", "Postgres にしよう。"),
    );
    assert.match(
      (await checkText(db.ingest, run, p, null, borrowed)).text,
      new RegExp(`s${elsewhere}: not a source of this run`),
    );
    assert.match((await checkText(db.ingest, run, p, null, record)).text, /✓ 1 record can be saved/);
    // A message captured after the run began was never shown to it: saving must not mark it traced
    const late = message(db, p, {
      id: "m3",
      text: "やっぱり Postgres も考えたい。",
      sent: "2099-01-01T00:00:00Z",
    });
    // Nor is it shown or citable now: it waits for the next trace, which will look at it
    assert.doesNotMatch(await contextText(db.ingest, run, p, null), /やっぱり Postgres/);
    const citesLate = JSON.parse(
      JSON.stringify(record)
        .replaceAll(`s${m}`, `s${late}`)
        .replaceAll("SQLite にしよう。", "やっぱり Postgres も考えたい。"),
    );
    assert.match(
      (await checkText(db.ingest, run, p, null, citesLate)).text,
      new RegExp(`s${late}: not a source of this run`),
    );
    assert.match(await saveText(db.ingest, run, p, null, record), /trace:ext-s1\/storage active/);
    await assert.rejects(saveText(db.ingest, run, p, null, record), /already saved/);
    await assert.rejects(contextText(db.ingest, run, p + 1, null), /another project/);
    await assert.rejects(contextText(db.ingest, "missing", p, null), /No run/);
    assert.match(
      await pendingText(db.ingest, p, new Date("2026-09-20T00:00:00Z")),
      /2 sessions to trace[\s\S]*- s(1|9) claude-code[\s\S]*- s(1|9) claude-code/,
    );
  } finally {
    await db.done();
  }
});

test("harvest: begin keeps the pull request as sources and context lists them with who wrote them", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const begun = await beginHarvest(db.ingest, p, 3, fakeGet);
    assert.equal(begun.sources, 1);
    const ctx = await contextText(db.ingest, begun.run, p, null);
    assert.match(ctx, /## s\d+ pr_body pr:3 by kai \(MEMBER\)[\s\S]*Keep notes out of CSV\./);
    assert.match(await saveText(db.ingest, begun.run, p, null, { units: [] }), /✓ saved/);
    // tombstone: an item the owner forgot is not stored again, so it is not counted as kept
    const body = Number(
      (db.owner.prepare("select id from source where kind = 'pr_body'").get() as { id: number }).id,
    );
    await applyForget(db.file, p, [body], await previewForget(db.file, p, [body]));
    assert.equal((await beginHarvest(db.ingest, p, 3, fakeGet)).sources, 0);
  } finally {
    await db.done();
  }
});

test("harvest: context marks the sources an earlier run looked at, not a new comment or an edited body", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const user = { login: "kai", id: 4, type: "User" };
    const comment = (id: number, body: string) => ({
      id,
      body,
      html_url: "u",
      created_at: "2026-03-02T00:00:00Z",
      user,
      author_association: "MEMBER",
    });
    const pull =
      (body: string, comments: unknown[]): Get =>
      async (q) =>
        (
          ({
            "pulls/3": {
              number: 3,
              title: "t",
              body,
              html_url: "u",
              created_at: "2026-03-01T00:00:00Z",
              merged_at: null,
              user,
              author_association: "MEMBER",
            },
            "issues/3/comments": comments,
            "pulls/3/reviews": [],
            "pulls/3/comments": [],
            "pulls/3/commits": [],
          }) as Record<string, unknown>
        )[q.split("?")[0] ?? ""];
    const first = await beginHarvest(
      db.ingest,
      p,
      3,
      pull("Keep notes out of CSV.", [comment(1, "Old comment.")]),
    );
    const firstCtx = await contextText(db.ingest, first.run, p, null);
    assert.doesNotMatch(firstCtx, /harvested before/);
    assert.match(await saveText(db.ingest, first.run, p, null, { units: [] }), /✓ saved/);

    const second = await beginHarvest(
      db.ingest,
      p,
      3,
      pull("Keep notes and drafts out of CSV.", [comment(1, "Old comment."), comment(2, "New comment.")]),
    );
    // Each source is its heading line and its text on the next line
    const heading = (text: string) => {
      const lines = ctx.split("\n");
      return lines[lines.indexOf(text) - 1] ?? "";
    };
    const ctx = await contextText(db.ingest, second.run, p, null);
    assert.match(heading("Old comment."), /^## s\d+ pr_comment .* \(harvested before\)$/);
    assert.match(heading("New comment."), /^## s\d+ pr_comment /);
    assert.doesNotMatch(heading("New comment."), /harvested before/);
    assert.match(heading("Keep notes and drafts out of CSV."), /^## s\d+ pr_body pr:3 revision 2 /);
    assert.doesNotMatch(heading("Keep notes and drafts out of CSV."), /harvested before/);
  } finally {
    await db.done();
  }
});

// Another harvest of the same pull request stores new revisions and changes which issues it closes; a run already begun keeps
// what it began with, so its citations stay valid until it saves
test("harvest run keeps the sources it began with while another harvest of the pull request changes them", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const user = { login: "kai", id: 4, type: "User" };
    const issue = (n: number, body: string) => ({
      number: n,
      body,
      html_url: "u",
      created_at: "2026-03-01T00:00:00Z",
      user,
      author_association: "MEMBER",
    });
    const pull =
      (body: string, comment: string): Get =>
      async (q) =>
        (
          ({
            "pulls/3": {
              number: 3,
              title: "t",
              body,
              html_url: "u",
              created_at: "2026-03-01T00:00:00Z",
              merged_at: null,
              user,
              author_association: "MEMBER",
            },
            "issues/3/comments": [
              {
                id: 1,
                body: comment,
                html_url: "u",
                created_at: "2026-03-02T00:00:00Z",
                user,
                author_association: "MEMBER",
              },
            ],
            "pulls/3/reviews": [],
            "pulls/3/comments": [],
            "pulls/3/commits": [],
            "issues/9": issue(9, "Notes must never be exported."),
            "issues/9/comments": [],
            "issues/12": issue(12, "Drafts are exported too."),
            "issues/12/comments": [],
          }) as Record<string, unknown>
        )[q.split("?")[0] ?? ""];
    const a = await beginHarvest(db.ingest, p, 3, pull("Closes #9. Keep notes out of CSV.", "Old words."));
    const b = await beginHarvest(db.ingest, p, 3, pull("Closes #12. Keep notes out of CSV.", "New words."));
    const id = (text: string) =>
      Number((db.owner.prepare("select id from source where text = ?").get(text) as { id: number }).id);
    const old = id("Old words.");
    for (const reads of [db.reader, openReader(db.file)]) {
      const ctx = await contextText(reads, a.run, p, null);
      assert.match(ctx, new RegExp(`## s${old} pr_comment [^\n]*\nOld words.`));
      assert.match(ctx, /Notes must never be exported\./);
      assert.doesNotMatch(ctx, /New words\.|Drafts are exported too\./);
      if (reads !== db.reader) await reads.destroy();
    }
    const bCtx = await contextText(db.reader, b.run, p, null);
    assert.match(bCtx, /New words\./);
    assert.match(bCtx, /Drafts are exported too\./);
    assert.doesNotMatch(bCtx, /Old words\.|Notes must never be exported\./);
    const record = {
      units: [
        {
          key: "old-words",
          kind: "finding",
          text: "The comment said old words",
          evidence: [{ source: `s${old}`, quote: "Old words.", role: "states" }],
          aliases: ["old", "words", "comment", "コメント", "古い", "言葉", "harvest", "収穫"],
        },
      ],
    };
    const checked = await checkText(db.ingest, a.run, p, null, record);
    assert.ok(checked.ok, checked.text);
    assert.match(await saveText(db.ingest, a.run, p, null, record), /✓ harvest:3\/old-words active/);
    await assert.rejects(checkText(db.ingest, "gone-run", p, null, record), /Begin again/);
  } finally {
    await db.done();
  }
});

// Forgetting reaches a run already begun: the forgotten source leaves it, and so does an older revision of a forgotten one
test("harvest run keeps the sources it began with, except what the owner forgets meanwhile", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const user = { login: "kai", id: 4, type: "User" };
    const pull =
      (body: string, comment: string): Get =>
      async (q) =>
        (
          ({
            "pulls/3": {
              number: 3,
              title: "t",
              body,
              html_url: "u",
              created_at: "2026-03-01T00:00:00Z",
              merged_at: null,
              user,
              author_association: "MEMBER",
            },
            "issues/3/comments": [
              {
                id: 1,
                body: comment,
                html_url: "u",
                created_at: "2026-03-02T00:00:00Z",
                user,
                author_association: "MEMBER",
              },
            ],
            "pulls/3/reviews": [],
            "pulls/3/comments": [],
            "pulls/3/commits": [],
          }) as Record<string, unknown>
        )[q.split("?")[0] ?? ""];
    const a = await beginHarvest(db.ingest, p, 3, pull("Keep notes out of CSV.", "Old words."));
    await beginHarvest(db.ingest, p, 3, pull("Keep notes and drafts out of CSV.", "Old words."));
    const id = (text: string) =>
      Number((db.owner.prepare("select id from source where text = ?").get(text) as { id: number }).id);
    assert.match(await contextText(db.reader, a.run, p, null), /Keep notes out of CSV\.[\s\S]*Old words\./);
    // The comment A holds itself
    const comment = id("Old words.");
    await applyForget(db.file, p, [comment], await previewForget(db.file, p, [comment]));
    // The body's newer revision, which only B holds: A's older revision is not the body's current text either
    const newer = id("Keep notes and drafts out of CSV.");
    await applyForget(db.file, p, [newer], await previewForget(db.file, p, [newer]));
    const ctx = await contextText(db.reader, a.run, p, null);
    assert.doesNotMatch(ctx, /Old words\.|Keep notes out of CSV\.|drafts/);
  } finally {
    await db.done();
  }
});

/** Whether another connection could take the write lock on the database file right now (it does not wait). */
function lockFree(file: string): boolean {
  const c = new DatabaseSync(file);
  try {
    c.exec("pragma busy_timeout = 0");
    c.exec("begin immediate");
    c.exec("rollback");
    return true;
  } catch {
    return false;
  } finally {
    c.close();
  }
}

/** Puts a git in bin that notes in log whether the database's write lock was free when it ran, then runs the real git. */
function writeLockGit(bin: string, file: string, log: string): void {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  fs.writeFileSync(
    path.join(bin, "git"),
    [
      `#!${process.execPath}`,
      `const { DatabaseSync } = require("node:sqlite");`,
      `const c = new DatabaseSync(${JSON.stringify(file)});`,
      `let free = true;`,
      `try { c.exec("pragma busy_timeout = 0"); c.exec("begin immediate"); c.exec("rollback"); } catch { free = false; }`,
      `c.close();`,
      `require("node:fs").appendFileSync(${JSON.stringify(log)}, free ? "free\\n" : "locked\\n");`,
      `const r = require("node:child_process").spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: "inherit" });`,
      `process.exit(r.status ?? 1);`,
    ].join("\n"),
    { mode: 0o755 },
  );
}

// Capture and delivery wait on the write lock: git runs before a save takes it
test("save: git is asked about an anchor's commit before the write lock is taken", async () => {
  const db = tempDb();
  const root = repo();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-fake-git-"));
  const log = path.join(bin, "locks.txt");
  const savedPath = process.env.PATH;
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "openStore を使う。" });
    const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeLockGit(bin, db.file, log);
    const run = await beginTrace(db.ingest, p, "s1");
    await contextText(db.ingest, run, p, root);
    const record = {
      units: [
        {
          key: "store",
          kind: "implementation",
          text: "openStore を使う",
          evidence: [{ source: `s${m}`, quote: "openStore を使う。", role: "states" }],
          anchors: [{ path: "src.ts", symbol: "openStore", role: "evidence", commit }],
        },
      ],
    };
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
    assert.match(await saveText(db.ingest, run, p, root, record), /✓ saved/);
    process.env.PATH = savedPath;
    assert.equal(
      db.owner.prepare("select commit_sha from unit_anchor").get()?.commit_sha,
      commit,
      "the fake git answered for the real one",
    );
    assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), ["free"]);
  } finally {
    process.env.PATH = savedPath;
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

// Inside the lock a file is only read again; it is judged anew only when its content changed, before each anchor is written
test("save: under the write lock files are only read again, and a file changed meanwhile is judged anew", async () => {
  const db = tempDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-lock-"));
  try {
    const p = project(db);
    const calls: { fn: string; rel?: string; locked: boolean }[] = [];
    // Files turned into keys while the lock is held (just before their anchor is written), or right after the read before the lock
    let rewrite = new Set<string>();
    let rewriteAfterRead = new Set<string>();
    const toKey = (rel: string) =>
      fs.writeFileSync(
        path.join(root, rel),
        `API_KEY=${rel === "a.ts" ? "tokenValue123abc" : "tokenValue456def"}\n`,
      );
    const probe: Probe = {
      read: (r, rel) => {
        const locked = !lockFree(db.file);
        calls.push({ fn: "read", rel, locked });
        if (locked && rewrite.delete(rel)) toKey(rel);
        const got = PROBE.read(r, rel);
        if (!locked && rewriteAfterRead.delete(rel)) toKey(rel);
        return got;
      },
      masks: (t, sym) => {
        calls.push({ fn: "masks", locked: !lockFree(db.file) });
        return PROBE.masks(t, sym);
      },
      locate: (t, sym) => {
        calls.push({ fn: "locate", locked: !lockFree(db.file) });
        return PROBE.locate(t, sym);
      },
      holds: (r, c, rel) => {
        calls.push({ fn: "holds", locked: !lockFree(db.file) });
        return PROBE.holds(r, c, rel);
      },
      kind: (r, rel) => {
        calls.push({ fn: "kind", rel, locked: !lockFree(db.file) });
        return PROBE.kind(r, rel);
      },
      files: (r) => {
        calls.push({ fn: "files", locked: !lockFree(db.file) });
        return PROBE.files(r);
      },
    };
    const saveWith = async (sessionId: string) => {
      fs.writeFileSync(path.join(root, "a.ts"), "const tokenValue123abc = loadConfig();\n");
      fs.writeFileSync(path.join(root, "b.ts"), "const tokenValue456def = loadConfig();\n");
      const m = message(db, p, { id: `m-${sessionId}`, text: "ここを見る。", session: sessionId });
      const run = await beginTrace(db.ingest, p, sessionId);
      await contextText(db.ingest, run, p, root);
      calls.length = 0;
      await saveText(
        db.ingest,
        run,
        p,
        root,
        {
          units: [
            {
              key: "look",
              kind: "finding",
              text: "ここを見る",
              evidence: [{ source: `s${m}`, quote: "ここを見る。", role: "states" }],
              anchors: [
                { path: "a.ts", symbol: "tokenValue123abc", role: "applies_to" },
                { path: "b.ts", symbol: "tokenValue456def", role: "applies_to" },
              ],
            },
          ],
        },
        probe,
      );
      return db.owner
        .prepare(
          "select a.path, a.symbol from unit_anchor a join unit u on u.id = a.unit_id where u.key like ? order by a.id",
        )
        .all(`trace:%${sessionId}/look`)
        .map((r) => [r.path, r.symbol]);
    };

    assert.deepEqual(await saveWith("s1"), [
      ["a.ts", "tokenValue123abc"],
      ["b.ts", "tokenValue456def"],
    ]);
    assert.ok(
      calls.some((c) => !c.locked && c.fn === "masks"),
      "judged before the lock",
    );
    assert.deepEqual(
      calls.filter((c) => c.locked).map((c) => `${c.fn} ${c.rel}`),
      ["read a.ts", "read b.ts"],
    );

    // Each file turns its symbol into a key when the save reads it under the lock, just before writing that file's anchor
    rewrite = new Set(["a.ts", "b.ts"]);
    assert.deepEqual(await saveWith("s2"), [
      ["a.ts", null],
      ["b.ts", null],
    ]);
    assert.equal(calls.filter((c) => c.locked && c.fn === "masks").length, 2);

    // Changed after the read before the lock: the read under the lock sees it
    rewrite = new Set();
    rewriteAfterRead = new Set(["b.ts"]);
    assert.deepEqual(await saveWith("s3"), [
      ["a.ts", "tokenValue123abc"],
      ["b.ts", null],
    ]);
    // Only the changed file is judged again: whether it is masked, and what kind of path it is now
    assert.deepEqual(
      calls.filter((c) => c.locked && c.fn !== "read").map((c) => c.fn),
      ["masks", "kind"],
    );
  } finally {
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("check shows what save would quarantine, and anchors judged again under the lock, once each", async () => {
  const db = tempDb();
  const root = repo();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "openStore を見る。" });
    // openStore leaves src.ts once the check holds the lock, after preparation judged it
    const probe: Probe = {
      ...PROBE,
      read: (r, rel) => {
        if (rel === "src.ts" && !lockFree(db.file))
          fs.writeFileSync(path.join(root, rel), "export function closeStore() {}\n");
        return PROBE.read(r, rel);
      },
    };
    const record = {
      units: [
        {
          key: "look",
          kind: "finding",
          text: "openStore を見る",
          evidence: [{ source: `s${m}`, quote: "openStore を見る。", role: "states" }],
          anchors: [{ path: "src.ts", symbol: "openStore", role: "applies_to" }],
        },
        {
          key: "ghost",
          kind: "finding",
          text: "誰も言っていない",
          evidence: [{ source: `s${m}`, quote: "誰も言っていない", role: "states" }],
        },
      ],
    };
    const run = await beginTrace(db.ingest, p, "s1");
    const checked = (await checkText(db.ingest, run, p, root, record, undefined, probe)).text;
    assert.match(checked, /△ would be quarantined: trace:ext-s1\/ghost \(quote not found/);
    assert.doesNotMatch(checked, /will be quarantined/);
    const gone = /△ trace:ext-s1\/look: symbol "openStore" is not found in src\.ts/g;
    assert.equal(checked.match(gone)?.length, 1, checked);
    // Prepared after the file changed, the warning comes from validation and from the save alike: still shown once
    const again = (await checkText(db.ingest, run, p, root, record, undefined, probe)).text;
    assert.equal(again.match(gone)?.length, 1, again);
  } finally {
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("check and save: an anchor changed under the lock is reported by both, without asking git under the lock", async () => {
  const db = tempDb();
  const root = repo();
  try {
    const p = project(db);
    const calls: { fn: string; locked: boolean }[] = [];
    let remove = "";
    const probe: Probe = {
      ...PROBE,
      read: (r, rel) => {
        // The file goes away once the save holds the lock, after everything before it was judged
        if (rel === remove && !lockFree(db.file)) fs.rmSync(path.join(root, rel));
        return PROBE.read(r, rel);
      },
      holds: (r, c, rel) => {
        calls.push({ fn: "holds", locked: !lockFree(db.file) });
        return PROBE.holds(r, c, rel);
      },
      files: (r) => {
        calls.push({ fn: "files", locked: !lockFree(db.file) });
        return PROBE.files(r);
      },
    };
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const m = message(db, p, { id: "m1", text: "openStore を見る。" });
    const record = {
      units: [
        {
          key: "look",
          kind: "finding",
          text: "openStore を見る",
          evidence: [{ source: `s${m}`, quote: "openStore を見る。", role: "states" }],
          anchors: [
            { path: "src.ts", symbol: "openStore", role: "applies_to" },
            // A commit makes preparation ask git, so "nothing under the lock" is about calls that happened
            { path: "docs/note.md", role: "evidence", commit: head },
          ],
        },
      ],
    };
    const run = await beginTrace(db.ingest, p, "s1");
    await contextText(db.ingest, run, p, root);
    assert.doesNotMatch((await checkText(db.ingest, run, p, root, record)).text, /anchor path/);
    const missing =
      /△ trace:ext-s1\/look: anchor path src\.ts is not in the working tree \(near paths not checked\)/;
    // check runs the same steps: it sees the change under the lock too, and asks git nothing while it holds it
    remove = "src.ts";
    assert.match((await checkText(db.ingest, run, p, root, record, undefined, probe)).text, missing);
    assert.ok(
      calls.some((c) => c.fn === "holds" && !c.locked),
      "the check asked git before the lock",
    );
    fs.writeFileSync(path.join(root, "src.ts"), "export function openStore() {}\n");
    const out = await saveText(db.ingest, run, p, root, record, probe);
    assert.match(out, missing);
    assert.deepEqual(
      calls.filter((c) => c.locked),
      [],
      "git is not asked while the lock is held",
    );

    // A glean anchor whose symbol leaves the file under the lock is reported the same way
    session(db, p, "g1");
    fs.writeFileSync(path.join(root, "src.ts"), "export function openStore() {}\n");
    const g = await beginGlean(db.ingest, p, "g1");
    const rev = Number(
      db.owner.prepare("select revision from unit where key = 'trace:ext-s1/look'").get()?.revision,
    );
    const symbolGone: Probe = {
      ...probe,
      read: (r, rel) => {
        if (rel === "src.ts" && !lockFree(db.file))
          fs.writeFileSync(path.join(root, rel), "export function closeStore() {}\n");
        return PROBE.read(r, rel);
      },
    };
    const gleaned = await saveText(
      db.ingest,
      g,
      p,
      root,
      {
        ops: [
          {
            op: "anchor",
            unit: "trace:ext-s1/look",
            revision: rev,
            path: "src.ts",
            symbol: "openStore",
            role: "evidence",
          },
        ],
      },
      symbolGone,
    );
    assert.match(gleaned, /△ trace:ext-s1\/look: symbol "openStore" is not found in src\.ts/);
  } finally {
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// glean reads its file excerpts and anchors before the lock too; a read that fails counts only for an operation the checks reach
test("save: glean reads excerpts and commits before the write lock, and judges a changed anchor file again", async () => {
  const db = tempDb();
  const root = repo();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-fake-git-"));
  const log = path.join(bin, "locks.txt");
  const savedPath = process.env.PATH;
  try {
    const p = project(db);
    session(db, p, "g1");
    const m = message(db, p, { id: "o1", text: "src.ts の openStore を見る。", session: "g1" });
    const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const first = await beginGlean(db.ingest, p, "g1");
    await saveText(db.ingest, first, p, root, {
      units: [
        {
          key: "look",
          kind: "finding",
          text: "openStore を見る",
          evidence: [{ source: `s${m}`, quote: "src.ts の openStore を見る。", role: "states" }],
        },
      ],
    });
    const rev = () =>
      Number(db.owner.prepare("select revision from unit where key = 'glean:look'").get()?.revision);
    // A missing unit or a stale revision is refused for that, not for its excerpt that cannot be read, by check and by save alike
    const unreadable = (unit: string, revision: number) => ({
      op: "add_evidence",
      unit,
      revision,
      file: { path: "docs/note.md", commit: "f".repeat(40), lines: [3, 3] },
      quote: "Back up before a release.",
      role: "explains",
    });
    for (const [op, want] of [
      [unreadable("glean:nope", 1), /glean:nope: not a record of this project/],
      [unreadable("glean:look", rev() + 1), /glean:look: changed since you read it/],
    ] as const) {
      const stray = await beginGlean(db.ingest, p, "g1");
      const checked = (await checkText(db.ingest, stray, p, root, { ops: [op] })).text;
      assert.match(checked, want);
      assert.doesNotMatch(checked, /is not a commit/);
      await assert.rejects(saveText(db.ingest, stray, p, root, { ops: [op] }), (e: Error) => {
        assert.match(e.message, want);
        assert.doesNotMatch(e.message, /is not a commit/);
        return true;
      });
    }

    writeLockGit(bin, db.file, log);
    const run = await beginGlean(db.ingest, p, "g1");
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
    assert.match(
      await saveText(db.ingest, run, p, root, {
        ops: [
          {
            op: "add_evidence",
            unit: "glean:look",
            revision: rev(),
            file: { path: "docs/note.md", lines: [3, 3] },
            quote: "Back up before a release.",
            role: "explains",
          },
          { op: "anchor", unit: "glean:look", revision: rev(), path: "src.ts", role: "evidence", commit },
        ],
      }),
      /evidence added/,
    );
    process.env.PATH = savedPath;
    const locks = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.ok(locks.length >= 2, "the fake git answered");
    assert.deepEqual([...new Set(locks)], ["free"]);

    // src.ts turns openStore into a key after the check, while the lock is held
    const probe: Probe = {
      ...PROBE,
      read: (r, rel) => {
        if (rel === "src.ts" && !lockFree(db.file))
          fs.writeFileSync(path.join(root, rel), "API_KEY=openStore\n");
        return PROBE.read(r, rel);
      },
    };
    const again = await beginGlean(db.ingest, p, "g1");
    await saveText(
      db.ingest,
      again,
      p,
      root,
      {
        ops: [
          {
            op: "anchor",
            unit: "glean:look",
            revision: rev(),
            path: "src.ts",
            symbol: "openStore",
            role: "applies_to",
          },
        ],
      },
      probe,
    );
    assert.deepEqual(
      db.owner
        .prepare("select symbol from unit_anchor where role = 'applies_to'")
        .all()
        .map((r) => r.symbol),
      [null],
    );
  } finally {
    process.env.PATH = savedPath;
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("glean: sourced additions, adoption, anchors, retractions, and withdrawal, with stale and unsafe inputs refused", async () => {
  const db = tempDb();
  const root = repo();
  try {
    const p = project(db);
    session(db, p, "g1");
    const said = message(db, p, {
      id: "o1",
      text: "木村さんが合意済みと言ってた。これで決まり。取り消す。",
      session: "g1",
    });
    const reply = message(db, p, { id: "a1", text: "了解。", speaker: "assistant", session: "g1" });
    const merge = insert(db, "source", {
      project_id: p,
      kind: "pr_event",
      artifact: "pr:3",
      external_id: "pr:3#merged",
      revision: 1,
      author_kind: "person",
      event_kind: "merged",
      created_at: "2026-03-01T00:00:00.000Z",
      captured_at: "2026-03-01T00:00:00.000Z",
      text: "merged",
      original_bytes: 6,
      content_hash: Buffer.alloc(32),
      indexed: 0,
    });
    // An AskUserQuestion question is shown beside the owner's answer, marked as not the owner's words
    message(db, p, {
      id: "t1:ask:toolu_1:q:0123456789abcdef",
      text: "Q1: どの DB？",
      speaker: "assistant",
      session: "g1",
    });
    message(db, p, {
      id: "t1:assistant:0123456789abcdef",
      text: "ただの返事",
      speaker: "assistant",
      session: "g1",
    });
    const run = await beginGlean(db.ingest, p, "g1");
    const glCtx = await contextText(db.ingest, run, p, root);
    assert.match(glCtx, /glean:<key>[\s\S]*## s\d+ owner[\s\S]*木村さん/);
    assert.match(
      glCtx,
      /## s\d+ assistant question \(not the owner's words; cannot adopt\)[^\n]*\nQ1: どの DB？/,
    );
    assert.doesNotMatch(glCtx, /ただの返事/);
    const fetched = await gleanFetch(
      db.ingest,
      run,
      place(p, root),
      "https://github.com/o/r/issues/9",
      fakeGet,
    );
    const issue = Number(/s(\d+) issue_body/.exec(fetched)?.[1]);
    assert.ok(issue > 0, fetched);
    // A gh that stops answering ends the fetch with its reason instead of holding the tool call
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-fake-gh-"));
    const savedPath = process.env.PATH;
    try {
      fs.writeFileSync(path.join(bin, "gh"), `#!${process.execPath}\nsetTimeout(() => {}, 20_000);\n`, {
        mode: 0o755,
      });
      process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
      await assert.rejects(
        gleanFetch(db.ingest, run, place(p, root), "https://github.com/o/r/issues/9", gh("o/r", 500)),
        /issues\/9 did not answer within 0\.5 seconds/,
      );
    } finally {
      process.env.PATH = savedPath;
      fs.rmSync(bin, { recursive: true, force: true });
    }
    await assert.rejects(
      gleanFetch(db.ingest, run, place(p, root), "https://example.com/notes", fakeGet),
      /Only issues and pull requests/,
    );
    assert.match(
      await gleanFetch(db.ingest, run, place(p, root), "https://github.com/o/r/pull/3", fakeGet),
      /pr_body/,
    );
    const units = {
      units: [
        {
          key: "csv/no-notes",
          kind: "constraint",
          stance: "dont",
          text: "CSV にメモを含めない",
          evidence: [
            { source: `s${issue}`, quote: "Notes must never be exported.", role: "states" },
            {
              source: `s${said}`,
              quote: "木村さんが合意済みと言ってた。",
              role: "states",
              reported_speaker: "木村さん",
            },
          ],
        },
        {
          key: "remember",
          kind: "finding",
          text: "覚えている",
          evidence: [{ source: `s${said}`, quote: "これで決まり。", role: "states" }],
        },
      ],
    };
    assert.match(
      (await checkText(db.ingest, run, p, root, units)).text,
      /glean:remember: its only evidence is the owner's words[\s\S]*ask the owner for a source/,
    );
    await saveText(db.ingest, run, p, root, units);
    const u = (key: string) =>
      db.owner.prepare("select id, lifecycle, revision, unsourced from unit where key = ?").get(key) as {
        id: number;
        lifecycle: string;
        revision: number;
        unsourced: number;
      };
    assert.deepEqual([u("glean:csv/no-notes").lifecycle, u("glean:remember").unsourced], ["candidate", 1]);

    const ops = async (list: Record<string, unknown>[]) => {
      const r = await beginGlean(db.ingest, p, "g1");
      const record = { ops: list };
      const c = await checkText(db.ingest, r, p, root, record);
      return c.ok ? saveText(db.ingest, r, p, root, record) : Promise.reject(new Error(c.text));
    };
    const rev = () => u("glean:csv/no-notes").revision;
    assert.match(
      await ops([
        {
          op: "adopt",
          unit: "glean:csv/no-notes",
          revision: rev(),
          source: `s${said}`,
          quote: "これで決まり。",
        },
        {
          op: "add_evidence",
          unit: "glean:csv/no-notes",
          revision: rev(),
          file: { path: "docs/note.md", lines: [3, 3] },
          quote: "Back up before a release.",
          role: "explains",
        },
        {
          op: "anchor",
          unit: "glean:csv/no-notes",
          revision: rev(),
          path: "src.ts",
          symbol: "open",
          role: "applies_to",
        },
        {
          op: "add_evidence",
          unit: "glean:csv/no-notes",
          revision: rev(),
          source: `s${issue}`,
          quote: "Notes must never",
          role: "explains",
        },
      ]),
      /glean:csv\/no-notes: active/,
    );
    const excerpt = db.owner
      .prepare("select text, line_start, truncated, blob_sha from source where kind = 'file_excerpt'")
      .get();
    assert.deepEqual(
      [excerpt?.text, excerpt?.line_start, excerpt?.truncated],
      ["Back up before a release.\r\n", 3, 1],
    );
    assert.match(String(excerpt?.blob_sha), /^[0-9a-f]{40}$/);
    await ops([
      {
        op: "replace_anchor",
        unit: "glean:csv/no-notes",
        revision: rev(),
        from: { path: "src.ts", symbol: "open" },
        to: { path: "src.ts", symbol: "openStore", role: "applies_to" },
        source: `s${said}`,
        quote: "これで決まり。",
      },
    ]);
    assert.equal(
      db.owner.prepare("select count(*) as n from unit_anchor where retired_at is not null").get()?.n,
      1,
    );
    // Two pieces of evidence cite the issue: a retraction without a quote cannot say which one it means
    await assert.rejects(
      ops([
        {
          op: "retract_evidence",
          unit: "glean:csv/no-notes",
          revision: rev(),
          source: `s${issue}`,
          reason_source: `s${said}`,
          reason_quote: "取り消す。",
        },
      ]),
      /2 pieces of evidence cite s\d+; add quote/,
    );
    assert.match(
      await ops([
        {
          op: "retract_adoption",
          unit: "glean:csv/no-notes",
          revision: rev(),
          source: `s${said}`,
          reason_source: `s${said}`,
          reason_quote: "取り消す。",
        },
        {
          op: "retract_evidence",
          unit: "glean:csv/no-notes",
          revision: rev(),
          source: `s${issue}`,
          quote: "Notes must never",
          reason_source: `s${said}`,
          reason_quote: "取り消す。",
        },
      ]),
      /candidate/,
    );
    assert.deepEqual(
      db.owner
        .prepare(
          "select e.role, e.retracted_at is not null as gone from unit_evidence e where e.unit_id = ? and e.source_id = ? order by e.role",
        )
        .all(u("glean:csv/no-notes").id, issue)
        .map((r) => [r.role, r.gone]),
      [
        ["explains", 1],
        ["states", 0],
      ],
      "only the quoted evidence is retracted",
    );
    await ops([
      {
        op: "withdraw",
        unit: "glean:remember",
        revision: u("glean:remember").revision,
        reason_source: `s${said}`,
        reason_quote: "取り消す。",
      },
    ]);
    assert.equal(u("glean:remember").lifecycle, "withdrawn");

    const refused = async (op: Record<string, unknown>, want: RegExp) =>
      assert.rejects(ops([{ unit: "glean:csv/no-notes", revision: rev(), ...op }]), want);
    const file = (p2: string, extra = {}) => ({
      op: "add_evidence",
      file: { path: p2, lines: [1, 1], ...extra },
      quote: "x",
      role: "explains",
    });
    await refused(file("../x"), /not a path inside the repository/);
    await refused(file("link.ts"), /symbolic link/);
    await refused(file("logo.bin"), /binary/);
    await refused(file("huge.txt"), /over the/);
    await refused(file("latin1.txt"), /not UTF-8/);
    await refused(file("gone.md"), /is not in commit/);
    await refused(file("docs/note.md", { commit: "nope" }), /is not a commit/);
    await refused(file("docs/note.md", { lines: [9, 9] }), /lines 9-9 are not in it/);
    await refused({ ...file("docs/note.md"), quote: "absent" }, /quote not found in docs\/note.md/);
    await refused({ op: "add_evidence", quote: "x", role: "explains" }, /either a source or a file/);
    // A reconsider quote belongs to an option's condition, which glean never writes
    await refused({ ...file("docs/note.md"), role: "reconsiders" }, /role/);
    await refused(
      { op: "add_evidence", source: `s${reply}`, quote: "了解。", role: "states", reported_speaker: "x" },
      /must cite an owner message/,
    );
    await refused({ op: "adopt", source: `s${merge}`, quote: "merged" }, /merge does not adopt/);
    await refused({ op: "adopt", source: `s${reply}`, quote: "了解。" }, /only the owner or a maintainer/);
    await refused({ op: "adopt", source: "s99999", quote: "x" }, /not a source of this project/);
    await refused({ op: "anchor", path: "/etc/passwd", role: "applies_to" }, /not inside the repository/);
    await refused(
      { op: "anchor", path: "src.ts", role: "evidence", commit: "0".repeat(40) },
      /commit 000000000000 does not hold src\.ts/,
    );
    const replace = (from: Record<string, unknown>) => ({
      op: "replace_anchor",
      from,
      to: { path: "src.ts", symbol: "other", role: "applies_to" },
      source: `s${said}`,
      quote: "これで決まり。",
    });
    await refused(replace({ path: "src/missing.ts" }), /no live anchor on src\/missing\.ts/);
    // Moving a record's location redirects its delivery: only the owner's words can do it
    await refused(
      { ...replace({ path: "src.ts", symbol: "openStore" }), source: `s${issue}`, quote: "Notes must never" },
      /only the owner's words can move an anchor/,
    );
    await refused(replace({ path: "./src.ts", symbol: "nope" }), /no live anchor on src\.ts nope/);
    // An anchor the record already has, or one added twice in a batch, would leave two that replace_anchor cannot tell apart
    const pin = { op: "anchor", path: "src.ts", symbol: "openStore", role: "applies_to" };
    await refused(pin, /already has a live anchor on src\.ts openStore/);
    const fresh = {
      unit: "glean:csv/no-notes",
      revision: rev(),
      op: "anchor",
      path: "src.ts",
      symbol: "close",
      role: "applies_to",
    };
    await assert.rejects(
      ops([fresh, fresh]),
      /ops\.1 .*another operation in this batch already anchors src\.ts close/,
    );
    // Pinning a commit to an unpinned place is a different anchor, and an anchor a batch retires does not count as live
    const checks = async (list: Record<string, unknown>[]) =>
      (await checkText(db.ingest, await beginGlean(db.ingest, p, "g1"), p, root, { ops: list })).ok;
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(await checks([{ unit: "glean:csv/no-notes", revision: rev(), ...pin, commit: head }]), true);
    const moveOff = {
      unit: "glean:csv/no-notes",
      revision: rev(),
      ...replace({ path: "src.ts", symbol: "openStore" }),
    };
    const back = { unit: "glean:csv/no-notes", revision: rev(), ...pin };
    assert.equal(await checks([moveOff, back]), true);
    assert.equal(await checks([back, moveOff]), true);
    // And it saves: the move lands first, so the place is never held twice
    await ops([back, moveOff]);
    // Two replacements of one anchor would leave both new anchors live
    const twice = {
      unit: "glean:csv/no-notes",
      revision: rev(),
      ...replace({ path: "src.ts", symbol: "openStore" }),
    };
    await assert.rejects(
      ops([twice, twice]),
      /ops\.1 .*another operation in this batch already replaces src\.ts openStore/,
    );
    // A chain of moves: each lands before the one after it retires its old anchor, so the move off a place comes first
    const offOther = {
      unit: "glean:csv/no-notes",
      revision: rev(),
      ...replace({ path: "src.ts", symbol: "other" }),
      to: { path: "src.ts", role: "applies_to" },
    };
    const ontoOther = {
      unit: "glean:csv/no-notes",
      revision: rev(),
      ...replace({ path: "src.ts", symbol: "openStore" }),
    };
    await assert.rejects(
      ops([ontoOther, offOther]),
      /ops\.0 .*a later operation of this batch moves the anchor off src\.ts other; put that replacement before this one, or make the moves in two saves/,
    );
    await ops([offOther, ontoOther]);
    assert.deepEqual(
      db.owner
        .prepare(
          "select coalesce(symbol, '-') as symbol from unit_anchor where unit_id = (select id from unit where key = 'glean:csv/no-notes') and retired_at is null and path = 'src.ts' order by symbol",
        )
        .all()
        .map((r) => r.symbol),
      ["-", "other"],
    );
    await refused(
      { op: "retract_evidence", source: `s${issue}`, reason_source: `s${reply}`, reason_quote: "了解。" },
      /only the owner's words/,
    );
    await refused(
      { op: "adopt", revision: 1, source: `s${said}`, quote: "これで決まり。" },
      /changed since you read it/,
    );
    await assert.rejects(
      ops([{ op: "adopt", unit: "glean:none", revision: 1, source: `s${said}`, quote: "x" }]),
      /not a record of this project/,
    );
    await assert.rejects(ops([{ op: "nope" }]), /ops\.0/);
    const harvestRun = (await beginHarvest(db.ingest, p, 3, fakeGet)).run;
    await assert.rejects(
      gleanFetch(db.ingest, harvestRun, place(p, root), "https://github.com/o/r/issues/9", fakeGet),
      /for glean runs/,
    );
  } finally {
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("glean: a cited file excerpt is stored masked, and quotes touching masked text or a cut key are refused", async () => {
  const db = tempDb();
  const root = repo();
  try {
    const raw = "# Config\nAPI_KEY=abc123def456\nRotate the key before a release.\n";
    fs.writeFileSync(
      path.join(root, "config.md"),
      `${raw}-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----\nuse abc123def456 here\nAPI_KEY=\nzz99yy88xx77\n`,
    );
    const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
    git("add", "-A");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "config",
    );
    const p = project(db);
    session(db, p, "g1");
    const said = message(db, p, { id: "o1", text: "鍵は回す。", session: "g1" });
    const units = {
      units: [
        {
          key: "rotate",
          kind: "finding",
          text: "鍵を回す",
          evidence: [{ source: `s${said}`, quote: "鍵は回す。", role: "states" }],
        },
      ],
    };
    await saveText(db.ingest, await beginGlean(db.ingest, p, "g1"), p, root, units);
    // An excerpt an older version stored unmasked is kept, and a masked revision is added beside it
    const external = `file:config.md@${git("rev-parse", "HEAD:config.md")}#L1-3`;
    const old = insert(db, "source", {
      project_id: p,
      kind: "file_excerpt",
      artifact: "file:config.md",
      external_id: external,
      revision: 1,
      author_kind: "person",
      created_at: "2026-03-01T00:00:00.000Z",
      captured_at: "2026-03-01T00:00:00.000Z",
      text: raw,
      truncated: 1,
      original_bytes: 200,
      content_hash: Buffer.alloc(32),
      path: "config.md",
      line_start: 1,
      line_end: 3,
      commit_sha: git("rev-parse", "HEAD"),
      blob_sha: git("rev-parse", "HEAD:config.md"),
      indexed: 1,
    });
    const rev = () =>
      (db.owner.prepare("select revision from unit where key = 'glean:rotate'").get() as { revision: number })
        .revision;
    const cite = async (lines: [number, number], quote: string) => {
      const record = {
        ops: [
          {
            op: "add_evidence",
            unit: "glean:rotate",
            revision: rev(),
            file: { path: "config.md", lines },
            quote,
            role: "explains",
          },
        ],
      };
      const r = await beginGlean(db.ingest, p, "g1");
      const c = await checkText(db.ingest, r, p, root, record);
      return c.ok ? saveText(db.ingest, r, p, root, record) : Promise.reject(new Error(c.text));
    };
    const asked = await statements(() => cite([1, 3], "Rotate the key before a release."));
    // Looking an excerpt up by its id uses the unique index of items, not a scan of the project's sources
    const lookups = asked.filter((s) => /^select .* from "source" .*"external_id" = \?/.test(s));
    assert.ok(lookups.length > 0);
    for (const s of lookups) assert.match(plan(db, s), /source_item_once/, s);
    const rows = db.owner
      .prepare(
        "select id, revision, text, redacted, truncated from source where external_id = ? order by revision",
      )
      .all(external) as { id: number; revision: number; text: string; redacted: number; truncated: number }[];
    assert.equal(rows.length, 2);
    const masked = rows[1];
    assert.ok(masked && masked.id !== old);
    assert.doesNotMatch(masked.text, /abc123def456/);
    assert.match(masked.text, /API_KEY=\[redacted\]/);
    assert.deepEqual([masked.redacted, masked.truncated], [1, 1]);
    const ev = db.owner
      .prepare("select source_id, span_start, span_end from unit_evidence where source_id in (?, ?)")
      .get(old, masked.id) as { source_id: number; span_start: number; span_end: number };
    assert.equal(ev.source_id, masked.id);
    assert.equal(
      Buffer.from(masked.text).subarray(ev.span_start, ev.span_end).toString(),
      "Rotate the key before a release.",
    );
    // Only the older unmasked row still holds the key in the index
    const hits = db.owner
      .prepare("select rowid from source_fts where source_fts match '\"abc123def456\"'")
      .all() as { rowid: number }[];
    assert.deepEqual(
      hits.map((h) => h.rowid),
      [old],
    );
    await assert.rejects(cite([1, 3], "abc123def456"), /the quote also appears in text Sphica masks/);
    await assert.rejects(cite([2, 7], "abc123def456"), /the quote also appears in text Sphica masks/);
    await assert.rejects(cite([5, 5], "MIIEvQ"), /lines 5-5 are inside a private key/);
    await assert.rejects(cite([3, 5], "Rotate the key"), /lines 3-5 are inside a private key/);
    // The key name is on the line before: the value alone does not look like a key, but the whole file masks it
    await assert.rejects(cite([9, 9], "zz99yy88xx77"), /lines 9-9 cut through text Sphica masks/);
    const pin = async (symbol: string) => {
      const record = {
        ops: [
          {
            op: "anchor",
            unit: "glean:rotate",
            revision: rev(),
            path: "config.md",
            symbol,
            role: "applies_to",
          },
        ],
      };
      const r = await beginGlean(db.ingest, p, "g1");
      const c = await checkText(db.ingest, r, p, root, record);
      return c.ok ? saveText(db.ingest, r, p, root, record) : Promise.reject(new Error(c.text));
    };
    await assert.rejects(pin("zz99yy88xx77"), /the symbol is text Sphica masks/);
    await assert.rejects(pin(`sk-${"b2".repeat(15)}`), /the symbol is text Sphica masks/);
    await assert.rejects(pin(" zz99yy88xx77 "), /the symbol is text Sphica masks/);
    assert.equal(
      db.owner.prepare("select count(*) as n from source where text like '%zz99yy88xx77%'").get()?.n,
      0,
    );
  } finally {
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("glean: a successor that becomes active later supersedes the record it replaces", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const old = message(db, p, { id: "o1", text: "SQLite にしよう。" });
    const traced = await beginTrace(db.ingest, p, "s1");
    const decided = (key: string, source: number, quote: string, extra: Record<string, unknown> = {}) => ({
      key,
      kind: "decision",
      stance: "do",
      text: quote,
      evidence: [{ source: `s${source}`, quote, role: "states" }],
      ...extra,
    });
    await saveText(db.ingest, traced, p, null, {
      units: [
        decided("storage", old, "SQLite にしよう。", {
          adoption: [{ source: `s${old}`, quote: "SQLite にしよう。" }],
        }),
      ],
    });
    session(db, p, "g1");
    const said = message(db, p, { id: "g", text: "Postgres に変える。これで決まり。", session: "g1" });
    const assistant = message(db, p, {
      id: "a",
      text: "Postgres に変えましょう。",
      speaker: "assistant",
      session: "g1",
    });
    const glean = async (record: unknown) =>
      saveText(db.ingest, await beginGlean(db.ingest, p, "g1"), p, null, record);
    // Evidence without adoption keeps the successor a candidate, so the old record stays active for now
    await glean({
      units: [
        decided("storage-2", assistant, "Postgres に変えましょう。", { supersedes: "trace:ext-s1/storage" }),
      ],
    });
    const state = (key: string) =>
      db.owner.prepare("select lifecycle from unit where key = ?").get(key)?.lifecycle;
    assert.deepEqual([state("glean:storage-2"), state("trace:ext-s1/storage")], ["candidate", "active"]);
    await glean({
      ops: [
        {
          op: "adopt",
          unit: "glean:storage-2",
          revision: db.owner.prepare("select revision from unit where key = 'glean:storage-2'").get()
            ?.revision,
          source: `s${said}`,
          quote: "これで決まり。",
        },
      ],
    });
    assert.deepEqual([state("glean:storage-2"), state("trace:ext-s1/storage")], ["active", "superseded"]);
    // The replaced record is no longer live: withdrawing it is refused by name, before anything is written
    await assert.rejects(
      glean({
        ops: [
          {
            op: "withdraw",
            unit: "trace:ext-s1/storage",
            revision: db.owner.prepare("select revision from unit where key = 'trace:ext-s1/storage'").get()
              ?.revision,
            reason_source: `s${said}`,
            reason_quote: "Postgres に変える。",
          },
        ],
      }),
      /trace:ext-s1\/storage is superseded, so there is nothing live to withdraw/,
    );
    assert.equal(state("trace:ext-s1/storage"), "superseded");
  } finally {
    await db.done();
  }
});

test("glean: withdrawing the successor brings back the record it replaced, and a record takes one live successor of its kind", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const old = message(db, p, { id: "o1", text: "SQLite にしよう。" });
    const decided = (key: string, source: number, quote: string, extra: Record<string, unknown> = {}) => ({
      key,
      kind: "decision",
      stance: "do",
      text: quote,
      evidence: [{ source: `s${source}`, quote, role: "states" }],
      adoption: [{ source: `s${source}`, quote }],
      ...extra,
    });
    const cache = message(db, p, { id: "o2", text: "Redis を使う。" });
    await saveText(db.ingest, await beginTrace(db.ingest, p, "s1"), p, null, {
      units: [decided("storage", old, "SQLite にしよう。"), decided("cache", cache, "Redis を使う。")],
    });
    session(db, p, "g1");
    const said = message(db, p, {
      id: "g",
      text: "Postgres にする。やっぱり Postgres はやめる。",
      session: "g1",
    });
    const glean = async (record: unknown) =>
      saveText(db.ingest, await beginGlean(db.ingest, p, "g1"), p, null, record);
    const state = (key: string) =>
      db.owner.prepare("select lifecycle from unit where key = ?").get(key)?.lifecycle;
    await glean({
      units: [decided("storage-2", said, "Postgres にする。", { supersedes: "trace:ext-s1/storage" })],
    });
    assert.deepEqual([state("trace:ext-s1/storage"), state("glean:storage-2")], ["superseded", "active"]);
    // A finding cannot replace a decision, and a second successor waits for the first to be withdrawn
    await assert.rejects(
      glean({
        units: [
          {
            key: "note",
            kind: "finding",
            text: "Postgres",
            evidence: [{ source: `s${said}`, quote: "Postgres にする。", role: "states" }],
            supersedes: "glean:storage-2",
          },
        ],
      }),
      /a finding cannot supersede glean:storage-2, a decision/,
    );
    await assert.rejects(
      glean({
        units: [decided("storage-3", said, "Postgres にする。", { supersedes: "trace:ext-s1/storage" })],
      }),
      /trace:ext-s1\/storage is already superseded/,
    );
    const out = await glean({
      ops: [
        {
          op: "withdraw",
          unit: "glean:storage-2",
          revision: db.owner.prepare("select revision from unit where key = 'glean:storage-2'").get()
            ?.revision,
          reason_source: `s${said}`,
          reason_quote: "やっぱり Postgres はやめる。",
        },
      ],
    });
    assert.match(out, /glean:storage-2: withdrawn/);
    assert.match(out, /trace:ext-s1\/storage: no longer superseded/);
    assert.match(out, /trace:ext-s1\/storage: active/);
    assert.deepEqual([state("trace:ext-s1/storage"), state("glean:storage-2")], ["active", "withdrawn"]);
    // Its successor withdrawn, the record can be replaced again
    await glean({
      units: [decided("storage-4", said, "Postgres にする。", { supersedes: "trace:ext-s1/storage" })],
    });
    assert.deepEqual([state("trace:ext-s1/storage"), state("glean:storage-4")], ["superseded", "active"]);
    // A successor still waiting for adoption holds no place of the owner's decision: the owner's own successor goes ahead,
    // and the waiting one can no longer become active beside it
    // Quoting the earlier session keeps it sourced, and without adoption it waits as a candidate
    const { adoption: _, ...unadopted } = decided("storage-5", old, "SQLite にしよう。", {
      supersedes: "glean:storage-4",
    });
    await glean({ units: [unadopted] });
    assert.equal(state("glean:storage-5"), "candidate");
    await glean({
      units: [decided("storage-6", said, "Postgres にする。", { supersedes: "glean:storage-4" })],
    });
    assert.deepEqual([state("glean:storage-4"), state("glean:storage-6")], ["superseded", "active"]);
    await assert.rejects(
      glean({
        ops: [
          {
            op: "adopt",
            unit: "glean:storage-5",
            revision: db.owner.prepare("select revision from unit where key = 'glean:storage-5'").get()
              ?.revision,
            source: `s${said}`,
            quote: "Postgres にする。",
          },
        ],
      }),
      /glean:storage-4 already has a successor, glean:storage-6 \(in effect\); withdraw it first, or supersede it instead/,
    );
    assert.equal(state("glean:storage-5"), "candidate");
    // A successor whose quote was not found is quarantined: it can never be adopted or withdrawn, so it holds no place
    await glean({
      units: [decided("cache-q", said, "引用に無い言葉。", { supersedes: "trace:ext-s1/cache" })],
    });
    assert.equal(
      db.owner.prepare("select extraction from unit where key = 'glean:cache-q'").get()?.extraction,
      "quarantined",
    );
    await glean({
      units: [decided("cache-2", said, "Postgres にする。", { supersedes: "trace:ext-s1/cache" })],
    });
    assert.deepEqual([state("trace:ext-s1/cache"), state("glean:cache-2")], ["superseded", "active"]);
    // In one save too: a quarantined successor takes no place from a sound one beside it
    await glean({
      units: [
        decided("storage-9", said, "Postgres にする。", { supersedes: "glean:cache-2" }),
        decided("storage-8", said, "また別の引用に無い言葉。", { supersedes: "glean:cache-2" }),
      ],
    });
    assert.deepEqual([state("glean:storage-8"), state("glean:storage-9")], ["candidate", "active"]);
  } finally {
    await db.done();
  }
});

test("glean: a record is withdrawn beside a successor that stays a candidate, and left alone once this save superseded it", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const old = message(db, p, { id: "o1", text: "SQLite にしよう。Redis も使う。" });
    const decided = (key: string, source: number, quote: string, extra: Record<string, unknown> = {}) => ({
      key,
      kind: "decision",
      stance: "do",
      text: quote,
      evidence: [{ source: `s${source}`, quote, role: "states" }],
      ...extra,
    });
    await saveText(db.ingest, await beginTrace(db.ingest, p, "s1"), p, null, {
      units: [
        decided("storage", old, "SQLite にしよう。", {
          adoption: [{ source: `s${old}`, quote: "SQLite にしよう。" }],
        }),
        decided("cache", old, "Redis も使う。", {
          adoption: [{ source: `s${old}`, quote: "Redis も使う。" }],
        }),
      ],
    });
    session(db, p, "g1");
    const said = message(db, p, {
      id: "g",
      text: "SQLite はやめる。Redis もやめる。Postgres に変える。これで決まり。",
      session: "g1",
    });
    const assistant = message(db, p, {
      id: "a",
      text: "Memcached にしましょう。",
      speaker: "assistant",
      session: "g1",
    });
    const state = (key: string) =>
      db.owner.prepare("select lifecycle from unit where key = ?").get(key)?.lifecycle;
    const revision = (key: string) =>
      db.owner.prepare("select revision from unit where key = ?").get(key)?.revision;
    // The successor has no adoption, so it stays a candidate and replaces nothing: the owner's withdrawal of the old record stands
    const kept = await saveText(db.ingest, await beginGlean(db.ingest, p, "g1"), p, null, {
      units: [
        decided("cache-2", assistant, "Memcached にしましょう。", { supersedes: "trace:ext-s1/cache" }),
      ],
      ops: [
        {
          op: "withdraw",
          unit: "trace:ext-s1/cache",
          revision: revision("trace:ext-s1/cache"),
          reason_source: `s${said}`,
          reason_quote: "Redis もやめる。",
        },
      ],
    });
    assert.match(kept, /trace:ext-s1\/cache: withdrawn/);
    assert.deepEqual([state("trace:ext-s1/cache"), state("glean:cache-2")], ["withdrawn", "candidate"]);
    // Here the successor becomes active in the same save and supersedes the old record first: there is nothing live left to withdraw
    const replaced = await saveText(db.ingest, await beginGlean(db.ingest, p, "g1"), p, null, {
      units: [
        decided("storage-2", said, "Postgres に変える。", {
          adoption: [{ source: `s${said}`, quote: "これで決まり。" }],
          supersedes: "trace:ext-s1/storage",
        }),
      ],
      ops: [
        {
          op: "withdraw",
          unit: "trace:ext-s1/storage",
          revision: revision("trace:ext-s1/storage"),
          reason_source: `s${said}`,
          reason_quote: "SQLite はやめる。",
        },
      ],
    });
    assert.match(replaced, /trace:ext-s1\/storage: superseded by a record of this save, so not withdrawn/);
    assert.deepEqual([state("trace:ext-s1/storage"), state("glean:storage-2")], ["superseded", "active"]);
  } finally {
    await db.done();
  }
});

test("glean: a successor that becomes active later supersedes a predecessor that was still a candidate", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const old = message(db, p, { id: "o1", text: "SQLite にしよう。" });
    const traced = await beginTrace(db.ingest, p, "s1");
    const decided = (key: string, source: number, quote: string, extra: Record<string, unknown> = {}) => ({
      key,
      kind: "decision",
      stance: "do",
      text: quote,
      evidence: [{ source: `s${source}`, quote, role: "states" }],
      ...extra,
    });
    await saveText(db.ingest, traced, p, null, {
      units: [decided("storage", old, "SQLite にしよう。")],
    });
    session(db, p, "g1");
    const said = message(db, p, { id: "g", text: "Postgres に変える。これで決まり。", session: "g1" });
    const assistant = message(db, p, {
      id: "a",
      text: "Postgres に変えましょう。",
      speaker: "assistant",
      session: "g1",
    });
    const glean = async (record: unknown) =>
      saveText(db.ingest, await beginGlean(db.ingest, p, "g1"), p, null, record);
    await glean({
      units: [
        decided("storage-2", assistant, "Postgres に変えましょう。", { supersedes: "trace:ext-s1/storage" }),
      ],
    });
    const state = (key: string) =>
      db.owner.prepare("select lifecycle from unit where key = ?").get(key)?.lifecycle;
    assert.deepEqual([state("glean:storage-2"), state("trace:ext-s1/storage")], ["candidate", "candidate"]);
    await glean({
      ops: [
        {
          op: "adopt",
          unit: "glean:storage-2",
          revision: db.owner.prepare("select revision from unit where key = 'glean:storage-2'").get()
            ?.revision,
          source: `s${said}`,
          quote: "これで決まり。",
        },
      ],
    });
    assert.deepEqual([state("glean:storage-2"), state("trace:ext-s1/storage")], ["active", "superseded"]);
  } finally {
    await db.done();
  }
});

test("glean: the owner's words resolve a conflict, and only an unresolved one between the two records", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "o1", text: "SQLite にしよう。いや Postgres かも。" });
    const traced = await beginTrace(db.ingest, p, "s1");
    await saveText(db.ingest, traced, p, null, {
      units: [
        {
          key: "sqlite",
          kind: "decision",
          stance: "do",
          text: "SQLite",
          evidence: [{ source: `s${m}`, quote: "SQLite にしよう。", role: "states" }],
          adoption: [{ source: `s${m}`, quote: "SQLite にしよう。" }],
        },
      ],
    });
    // conflicts names an existing record, so the question goes in a second run
    await saveText(db.ingest, await beginTrace(db.ingest, p, "s1"), p, null, {
      units: [
        {
          key: "maybe",
          kind: "question",
          text: "Postgres かも",
          evidence: [{ source: `s${m}`, quote: "いや Postgres かも。", role: "states" }],
          conflicts: ["trace:ext-s1/sqlite"],
        },
      ],
    });
    session(db, p, "g1");
    const said = message(db, p, { id: "g", text: "SQLite で確定。Postgres の話は終わり。", session: "g1" });
    const glean = async (op: Record<string, unknown>) => {
      const run = await beginGlean(db.ingest, p, "g1");
      const record = { ops: [op] };
      const c = await checkText(db.ingest, run, p, null, record);
      return c.ok ? saveText(db.ingest, run, p, null, record) : Promise.reject(new Error(c.text));
    };
    const rev = (key: string) =>
      db.owner.prepare("select revision from unit where key = ?").get(key)?.revision;
    const resolve = {
      op: "resolve_conflict",
      unit: "trace:ext-s1/sqlite",
      revision: rev("trace:ext-s1/sqlite"),
      with: "trace:ext-s1/maybe",
      reason_source: `s${said}`,
      reason_quote: "Postgres の話は終わり。",
    };
    await assert.rejects(glean({ ...resolve, with: "trace:ext-s1/nope" }), /no unresolved conflict/);
    assert.match(await glean(resolve), /conflict with trace:ext-s1\/maybe resolved/);
    assert.deepEqual(
      {
        ...db.owner
          .prepare("select resolution is not null as done from unit_link where kind = 'conflicts'")
          .get(),
      },
      { done: 1 },
    );
    await assert.rejects(
      glean({ ...resolve, revision: rev("trace:ext-s1/sqlite") }),
      /no unresolved conflict/,
    );
  } finally {
    await db.done();
  }
});

// Retracting words withdraws every citation of them, the record's and its options', and says so
test("glean: a retraction of words cited by the record and an option says it retracted both", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "o1", text: "Use SQLite. It is enough." });
    await saveText(db.ingest, await beginTrace(db.ingest, p, "s1"), p, null, {
      units: [
        {
          key: "db",
          kind: "finding",
          text: "SQLite",
          evidence: [
            { source: `s${m}`, quote: "Use SQLite.", role: "states" },
            { source: `s${m}`, quote: "It is enough.", role: "explains" },
          ],
          options: [
            { text: "SQLite", outcome: "chosen", evidence: [{ source: `s${m}`, quote: "Use SQLite." }] },
          ],
        },
      ],
    });
    session(db, p, "g1");
    const said = message(db, p, { id: "g", text: "I never said SQLite.", session: "g1" });
    const out = await saveText(db.ingest, await beginGlean(db.ingest, p, "g1"), p, null, {
      ops: [
        {
          op: "retract_evidence",
          unit: "trace:ext-s1/db",
          revision: db.owner.prepare("select revision from unit where key = 'trace:ext-s1/db'").get()
            ?.revision,
          source: `s${m}`,
          quote: "Use SQLite.",
          reason_source: `s${said}`,
          reason_quote: "I never said SQLite.",
        },
      ],
    });
    assert.match(out, /evidence retracted \(2 citations of those words: the record's and its options'\)/);
    assert.equal(
      db.owner.prepare("select count(*) as n from unit_evidence where retracted_at is null").get()?.n,
      1,
    );
  } finally {
    await db.done();
  }
});

test("a save marks its run saved with one update: trace, glean with changes only, and glean with a new record", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    // Counts the updates of a run each save asks the database for, whatever they set; saves go in the order of their runs
    const updates: number[] = [];
    const counted = async (save: () => Promise<unknown>) =>
      updates.push((await statements(save)).filter((s) => /^update "extraction_run"/.test(s)).length);
    const runs = () =>
      db.owner
        .prepare("select origin, status, finished_at is not null as finished from extraction_run order by id")
        .all()
        .map((r, i) => [r.origin, r.status, r.finished, updates[i] ?? 0]);
    const m = message(db, p, { id: "o1", text: "Use SQLite. It is enough." });
    const traced = await beginTrace(db.ingest, p, "s1");
    assert.deepEqual(runs(), [["trace", "running", 0, 0]]);
    await counted(async () =>
      saveText(db.ingest, traced, p, null, {
        units: [
          {
            key: "db",
            kind: "finding",
            text: "SQLite",
            evidence: [
              { source: `s${m}`, quote: "Use SQLite.", role: "states" },
              { source: `s${m}`, quote: "It is enough.", role: "explains" },
            ],
          },
        ],
      }),
    );
    assert.deepEqual(runs(), [["trace", "saved", 1, 1]]);
    session(db, p, "g1");
    const said = message(db, p, { id: "g", text: "It is not enough. Postgres is needed.", session: "g1" });
    const revision = () =>
      db.owner.prepare("select revision from unit where key = 'trace:ext-s1/db'").get()?.revision;
    await counted(async () =>
      saveText(db.ingest, await beginGlean(db.ingest, p, "g1"), p, null, {
        ops: [
          {
            op: "retract_evidence",
            unit: "trace:ext-s1/db",
            revision: revision(),
            source: `s${m}`,
            quote: "It is enough.",
            reason_source: `s${said}`,
            reason_quote: "It is not enough.",
          },
        ],
      }),
    );
    assert.deepEqual(runs().at(-1), ["glean", "saved", 1, 1]);
    await counted(async () =>
      saveText(db.ingest, await beginGlean(db.ingest, p, "g1"), p, null, {
        units: [
          {
            key: "pg",
            kind: "finding",
            text: "Postgres",
            evidence: [{ source: `s${said}`, quote: "Postgres is needed.", role: "states" }],
          },
        ],
        ops: [
          {
            op: "add_evidence",
            unit: "trace:ext-s1/db",
            revision: revision(),
            source: `s${said}`,
            quote: "It is not enough.",
            role: "explains",
          },
        ],
      }),
    );
    assert.deepEqual(runs(), [
      ["trace", "saved", 1, 1],
      ["glean", "saved", 1, 1],
      ["glean", "saved", 1, 1],
    ]);
    assert.equal(db.owner.prepare("select count(*) as n from unit where key = 'glean:pg'").get()?.n, 1);
  } finally {
    await db.done();
  }
});

// An implementation is active only with code proof: replacing its commit-pinned anchor judges it again
test("glean: replacing an implementation's only code proof puts it back to candidate", async () => {
  const db = tempDb();
  const root = repo();
  try {
    const p = project(db);
    const m = message(db, p, { id: "o1", text: "openStore を実装した。" });
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    await saveText(db.ingest, await beginTrace(db.ingest, p, "s1"), p, root, {
      units: [
        {
          key: "open",
          kind: "implementation",
          text: "openStore",
          evidence: [{ source: `s${m}`, quote: "openStore を実装した。", role: "states" }],
          anchors: [{ path: "src.ts", symbol: "openStore", role: "evidence", commit: head }],
        },
      ],
    });
    const state = () =>
      db.owner.prepare("select lifecycle, revision from unit where key = 'trace:ext-s1/open'").get();
    assert.equal(state()?.lifecycle, "active");
    session(db, p, "g1");
    const said = message(db, p, { id: "g", text: "場所が変わった。", session: "g1" });
    await saveText(db.ingest, await beginGlean(db.ingest, p, "g1"), p, root, {
      ops: [
        {
          op: "replace_anchor",
          unit: "trace:ext-s1/open",
          revision: state()?.revision,
          from: { path: "src.ts", symbol: "openStore" },
          to: { path: "src.ts", symbol: "openStore", role: "applies_to" },
          source: `s${said}`,
          quote: "場所が変わった。",
        },
      ],
    });
    assert.equal(state()?.lifecycle, "candidate");
    // Replacing an anchor with the place it already is would leave two live anchors on one place for a moment: refused by name
    await assert.rejects(
      saveText(db.ingest, await beginGlean(db.ingest, p, "g1"), p, root, {
        ops: [
          {
            op: "replace_anchor",
            unit: "trace:ext-s1/open",
            revision: state()?.revision,
            from: { path: "src.ts", symbol: "openStore" },
            to: { path: "src.ts", symbol: "openStore", role: "applies_to" },
            source: `s${said}`,
            quote: "場所が変わった。",
          },
        ],
      }),
      /the anchor on src\.ts openStore is already that place/,
    );
    assert.deepEqual(
      db.owner
        .prepare("select role, retired_at is null as live from unit_anchor order by id")
        .all()
        .map((a) => [a.role, a.live]),
      [
        ["evidence", 0],
        ["applies_to", 1],
      ],
    );
  } finally {
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("glean: anchor problem on a missing path or a symbol not in the file, and the anchor is still added", async () => {
  const db = tempDb();
  const root = repo();
  try {
    const p = project(db);
    session(db, p, "g1");
    const m = message(db, p, { id: "o1", text: "src.ts の openStore を見る。", session: "g1" });
    await saveText(db.ingest, await beginGlean(db.ingest, p, "g1"), p, root, {
      units: [
        {
          key: "look",
          kind: "finding",
          text: "openStore を見る",
          evidence: [{ source: `s${m}`, quote: "src.ts の openStore を見る。", role: "states" }],
        },
      ],
    });
    const rev = () =>
      Number(db.owner.prepare("select revision from unit where key = 'glean:look'").get()?.revision);
    const said = message(db, p, { id: "o2", text: "置き場所を直す。", session: "g1" });
    const ops = () => [
      { op: "anchor", unit: "glean:look", revision: rev(), path: "src/store.ts", role: "applies_to" },
      {
        op: "anchor",
        unit: "glean:look",
        revision: rev(),
        path: "src.ts",
        symbol: "openStores",
        role: "applies_to",
      },
      { op: "anchor", unit: "glean:look", revision: rev(), path: "docs", role: "applies_to" },
      // Deleted in this session: evidence of it is not a problem
      { op: "anchor", unit: "glean:look", revision: rev(), path: "old.ts", role: "evidence" },
    ];
    insert(db, "edit_observation", {
      session_id: "g1",
      turn_id: "t1",
      path: "old.ts",
      via: "tool",
      observed_at: "2026-09-01T00:00:00.000Z",
    });
    const checked = (
      await checkText(db.ingest, await beginGlean(db.ingest, p, "g1"), p, root, { ops: ops() })
    ).text;
    assert.match(checked, /anchor path src\/store\.ts is not in the working tree/);
    assert.match(checked, /symbol "openStores" is not found in src\.ts/);
    assert.match(checked, /anchor path docs is a directory/);
    assert.doesNotMatch(checked, /old\.ts/);
    assert.match(
      await saveText(db.ingest, await beginGlean(db.ingest, p, "g1"), p, root, { ops: ops() }),
      /anchor added/,
    );
    // replace_anchor's destination is checked the same way
    const moved = (
      await checkText(db.ingest, await beginGlean(db.ingest, p, "g1"), p, root, {
        ops: [
          {
            op: "replace_anchor",
            unit: "glean:look",
            revision: rev(),
            from: { path: "src/store.ts" },
            to: { path: "src/stores.ts", role: "applies_to" },
            source: `s${said}`,
            quote: "置き場所を直す。",
          },
        ],
      })
    ).text;
    assert.match(moved, /anchor path src\/stores\.ts is not in the working tree/);
  } finally {
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("glean: unsourced cannot become active, adding evidence or adoption says so, and a successor replaces it", async () => {
  const db = tempDb();
  const root = repo();
  try {
    const p = project(db);
    // An older session holds the owner's words that later turn up as the source
    const older = message(db, p, { id: "o0", text: "CSV にメモは入れない。これで決まり。", session: "s0" });
    session(db, p, "g1");
    const now = message(db, p, { id: "o1", text: "CSV にメモは入れないことにしたはず。", session: "g1" });
    const glean = async (record: unknown) => {
      const run = await beginGlean(db.ingest, p, "g1");
      const checked = (await checkText(db.ingest, run, p, root, record)).text;
      return { checked, saved: await saveText(db.ingest, run, p, root, record) };
    };
    const remembered = (key: string, kind: string) => ({
      key,
      kind,
      ...(kind === "decision" ? { stance: "dont" } : {}),
      text: "CSV にメモを入れない",
      evidence: [{ source: `s${now}`, quote: "CSV にメモは入れないことにしたはず。", role: "states" }],
    });
    await glean({ units: [remembered("csv", "decision"), remembered("csv-seen", "finding")] });
    const unit = (key: string) =>
      db.owner.prepare("select lifecycle, revision, unsourced from unit where key = ?").get(key) as {
        lifecycle: string;
        revision: number;
        unsourced: number;
      };
    assert.deepEqual([unit("glean:csv").unsourced, unit("glean:csv-seen").unsourced], [1, 1]);

    const added = await glean({
      ops: [
        {
          op: "add_evidence",
          unit: "glean:csv",
          revision: unit("glean:csv").revision,
          source: `s${older}`,
          quote: "CSV にメモは入れない。",
          role: "states",
        },
        {
          op: "adopt",
          unit: "glean:csv",
          revision: unit("glean:csv").revision,
          source: `s${older}`,
          quote: "これで決まり。",
        },
      ],
    });
    const said =
      /glean:csv is unsourced and cannot become active; adding evidence or adoption does not clear the flag/;
    assert.match(added.checked, said);
    assert.equal(added.checked.match(new RegExp(said.source, "g"))?.length, 1, "said once per record");
    assert.match(added.checked, /save a successor that supersedes it/);
    assert.equal(
      unit("glean:csv").lifecycle,
      "candidate",
      "the quotes are saved, the record stays a candidate",
    );
    assert.equal(
      Number(db.owner.prepare("select count(*) as n from unit_adoption").get()?.n),
      1,
      "the adoption is kept",
    );

    // An adoption alone is told the same
    const adopted = await glean({
      ops: [
        {
          op: "adopt",
          unit: "glean:csv",
          revision: unit("glean:csv").revision,
          source: `s${older}`,
          quote: "これで決まり。",
        },
      ],
    });
    assert.match(adopted.checked, said);
    assert.match(adopted.checked, /save a successor that supersedes it/);

    // A successor citing the found source becomes active and replaces it, for a decision and for a finding
    const successor = (key: string, kind: string, replaces: string) => ({
      key,
      kind,
      ...(kind === "decision"
        ? { stance: "dont", adoption: [{ source: `s${older}`, quote: "これで決まり。" }] }
        : {}),
      text: "CSV にメモを入れない",
      evidence: [{ source: `s${older}`, quote: "CSV にメモは入れない。", role: "states" }],
      supersedes: replaces,
    });
    const replaced = await glean({
      units: [
        successor("csv-2", "decision", "glean:csv"),
        successor("csv-seen-2", "finding", "glean:csv-seen"),
      ],
    });
    assert.match(replaced.saved, /glean:csv-2 active/);
    assert.deepEqual(
      [unit("glean:csv").lifecycle, unit("glean:csv-seen").lifecycle, unit("glean:csv-seen-2").lifecycle],
      ["superseded", "superseded", "active"],
    );

    // Withdrawn or superseded: still said, but no successor is suggested
    const late = await glean({
      ops: [
        {
          op: "add_evidence",
          unit: "glean:csv-seen",
          revision: unit("glean:csv-seen").revision,
          source: `s${older}`,
          quote: "CSV にメモは入れない。",
          role: "states",
        },
      ],
    });
    assert.match(late.checked, /glean:csv-seen is unsourced and cannot become active/);
    assert.doesNotMatch(late.checked, /successor/);
  } finally {
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("control character alias: trace leaves it out at check, so the save does not fail on it", async () => {
  const db = tempDb();
  const root = repo();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "時刻は協定世界時で保存する。" });
    const record = {
      units: [
        {
          key: "utc",
          kind: "finding",
          text: "時刻は協定世界時で保存する",
          evidence: [{ source: `s${m}`, quote: "時刻は協定世界時で保存する。", role: "states" }],
          aliases: ["\u0000offset", "timezone"],
        },
      ],
    };
    const run = await beginTrace(db.ingest, p, "s1");
    await contextText(db.ingest, run, p, root);
    assert.match(
      (await checkText(db.ingest, run, p, root, record)).text,
      /aliases must be 1 to 40 characters/,
    );
    assert.match(await saveText(db.ingest, run, p, root, record), /✓ saved/);
    assert.deepEqual(
      db.owner
        .prepare("select terms from unit_alias")
        .all()
        .map((r) => r.terms),
      ['["timezone"]'],
    );
  } finally {
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("replace_aliases: glean replaces a saved record's search words, and clears them with an empty set", async () => {
  const db = tempDb();
  const root = repo();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "時刻は協定世界時で保存する。" });
    await saveText(db.ingest, await beginTrace(db.ingest, p, "s1"), p, root, {
      units: [
        {
          key: "utc",
          kind: "finding",
          text: "時刻は協定世界時で保存する",
          evidence: [{ source: `s${m}`, quote: "時刻は協定世界時で保存する。", role: "states" }],
          aliases: ["timezone"],
        },
      ],
    });
    session(db, p, "g1");
    const key = "trace:ext-s1/utc";
    const rev = () => Number(db.owner.prepare("select revision from unit where key = ?").get(key)?.revision);
    const found = async (q: string) =>
      (await searchUnits(db.reader, p, { question: q, limit: 5 })).hits.map((h) => h.key);
    const replace = (aliases: unknown, revision = rev()) => ({
      ops: [{ op: "replace_aliases", unit: key, revision, aliases }],
    });
    assert.deepEqual(await found("timezone"), [key]);
    const before = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));

    // Not words from the record's text: only the alias can find it
    const stale = rev();
    assert.match(
      await saveText(
        db.ingest,
        await beginGlean(db.ingest, p, "g1"),
        p,
        root,
        replace([" offset ", "UTC offset", "offset"]),
      ),
      /trace:ext-s1\/utc: aliases replaced/,
    );
    assert.deepEqual(await found("offset"), [key]);
    assert.deepEqual(await found("timezone"), [], "a dropped alias no longer finds it");
    assert.match(
      (await readUnit(db.reader, p, key, root)) ?? "",
      /Aliases \(search only\): offset, UTC offset\n/,
    );
    assert.match(
      (await readUnit(db.reader, p, key, root, before)) ?? "",
      /Aliases \(search only\): timezone\n/,
    );

    for (const [aliases, revision, want] of [
      [["timezone"], stale, /changed since you read it/],
      [[" "], undefined, /aliases must be 1 to 40 characters/],
      [["x".repeat(41)], undefined, /aliases must be 1 to 40 characters/],
      [["\u0000offset"], undefined, /aliases must be 1 to 40 characters/],
      [["pay\u200Bload"], undefined, /aliases must be 1 to 40 characters/],
      [Array.from({ length: 13 }, (_, i) => `a${i}`), undefined, /aliases/],
    ] as const) {
      const run = await beginGlean(db.ingest, p, "g1");
      assert.match((await checkText(db.ingest, run, p, root, replace(aliases, revision))).text, want);
      await assert.rejects(saveText(db.ingest, run, p, root, replace(aliases, revision)), want);
    }
    assert.deepEqual(await found("offset"), [key], "a refused change leaves the aliases");
    // 21 characters outside the BMP are 42 UTF-16 units; the schema counts characters
    assert.match(
      await saveText(
        db.ingest,
        await beginGlean(db.ingest, p, "g1"),
        p,
        root,
        replace(["😀".repeat(21), "offset"]),
      ),
      /aliases replaced/,
    );

    await saveText(db.ingest, await beginGlean(db.ingest, p, "g1"), p, root, replace([]));
    assert.deepEqual(await found("offset"), []);
    assert.doesNotMatch((await readUnit(db.reader, p, key, root)) ?? "", /Aliases/);
  } finally {
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A record is active on its own evidence: an option's citation does not keep a decision whose own words were retracted active
test("glean: a decision whose own evidence is retracted stays a candidate even with option evidence", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "o1", text: "Use SQLite. SQLite is small." });
    await saveText(db.ingest, await beginTrace(db.ingest, p, "s1"), p, null, {
      units: [
        {
          key: "db",
          kind: "decision",
          stance: "do",
          text: "SQLite",
          evidence: [{ source: `s${m}`, quote: "Use SQLite.", role: "states" }],
          adoption: [{ source: `s${m}`, quote: "Use SQLite." }],
          options: [
            { text: "SQLite", outcome: "chosen", evidence: [{ source: `s${m}`, quote: "SQLite is small." }] },
          ],
        },
      ],
    });
    const state = () =>
      db.owner.prepare("select lifecycle, revision from unit where key = 'trace:ext-s1/db'").get();
    assert.equal(state()?.lifecycle, "active");
    session(db, p, "g1");
    const said = message(db, p, { id: "g", text: "I never decided that.", session: "g1" });
    await saveText(db.ingest, await beginGlean(db.ingest, p, "g1"), p, null, {
      ops: [
        {
          op: "retract_evidence",
          unit: "trace:ext-s1/db",
          revision: state()?.revision,
          source: `s${m}`,
          quote: "Use SQLite.",
          reason_source: `s${said}`,
          reason_quote: "I never decided that.",
        },
      ],
    });
    assert.equal(state()?.lifecycle, "candidate");
  } finally {
    await db.done();
  }
});

test("glean: retracting support from a superseded record leaves it superseded", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, {
      id: "o1",
      text: "The cache is slow. It misses on cold start. The cache is fine now.",
    });
    const finding = (key: string, quotes: string[], extra: Record<string, unknown> = {}) => ({
      key,
      kind: "finding",
      text: quotes[0],
      evidence: quotes.map((quote) => ({ source: `s${m}`, quote, role: "states" })),
      ...extra,
    });
    await saveText(db.ingest, await beginTrace(db.ingest, p, "s1"), p, null, {
      units: [finding("slow", ["The cache is slow.", "It misses on cold start."])],
    });
    await saveText(db.ingest, await beginTrace(db.ingest, p, "s1"), p, null, {
      units: [finding("fine", ["The cache is fine now."], { supersedes: "trace:ext-s1/slow" })],
    });
    const state = (key: string) =>
      db.owner.prepare("select lifecycle from unit where key = ?").get(key)?.lifecycle;
    assert.equal(state("trace:ext-s1/slow"), "superseded");
    session(db, p, "g1");
    const said = message(db, p, { id: "g", text: "Cold start is not the cause.", session: "g1" });
    const run = await beginGlean(db.ingest, p, "g1");
    const record = {
      ops: [
        {
          op: "retract_evidence",
          unit: "trace:ext-s1/slow",
          revision: db.owner.prepare("select revision from unit where key = 'trace:ext-s1/slow'").get()
            ?.revision,
          source: `s${m}`,
          quote: "It misses on cold start.",
          reason_source: `s${said}`,
          reason_quote: "Cold start is not the cause.",
        },
      ],
    };
    const c = await checkText(db.ingest, run, p, null, record);
    assert.ok(c.ok, c.text);
    await saveText(db.ingest, run, p, null, record);
    assert.deepEqual([state("trace:ext-s1/slow"), state("trace:ext-s1/fine")], ["superseded", "active"]);
  } finally {
    await db.done();
  }
});

// A contributor to someone else's repository adopts nothing, unless the account is the owner's own, bound by sphica init
test("harvest: the bound owner's words adopt in a pull request where they are only a contributor", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const contributor =
      (n: number): Get =>
      async (path) => {
        const key = path.split("?")[0] ?? "";
        if (key === `pulls/${n}`)
          return {
            number: n,
            title: "t",
            body: "Keep notes out of CSV.",
            html_url: "u",
            created_at: "2026-03-01T00:00:00Z",
            merged_at: null,
            user: { login: "hana", id: 42, type: "User" },
            author_association: "CONTRIBUTOR",
          };
        return [];
      };
    const record = (source: string) => ({
      units: [
        {
          key: "notes",
          kind: "decision",
          stance: "do",
          text: "Keep notes out of CSV.",
          evidence: [{ source, quote: "Keep notes out of CSV.", role: "states" }],
          adoption: [{ source, quote: "Keep notes out of CSV." }],
        },
      ],
    });
    const updates: number[] = [];

    const harvest = async (n: number) => {
      const run = (await beginHarvest(db.ingest, p, n, contributor(n))).run;
      const body = db.owner
        .prepare("select id, author_kind from source where artifact = ? and kind = 'pr_body'")
        .get(`pr:${n}`) as { id: number; author_kind: string };
      return {
        kind: body.author_kind,
        context: await contextText(db.ingest, run, p, null),
        saved: await (async () => {
          let text = "";
          const asked = await statements(async () => {
            text = await saveText(db.ingest, run, p, null, record(`s${body.id}`));
          });
          updates.push(asked.filter((s) => /^update "extraction_run"/.test(s)).length);
          return text;
        })(),
      };
    };
    const before = await harvest(5);
    assert.equal(before.kind, "person");
    assert.match(before.saved, /harvest:5\/notes candidate/);
    assert.deepEqual(bindOwner({ id: 42, login: "hana" }, db.file), { kind: "bound" });
    const after = await harvest(6);
    assert.equal(after.kind, "owner");
    // context tells the agent these are the owner's words, or it would take a CONTRIBUTOR's text as a proposal
    assert.match(after.context, /pr_body pr:6 by hana \(CONTRIBUTOR, the owner\)/);
    assert.match(before.context, /pr_body pr:5 by hana \(CONTRIBUTOR\) /);
    assert.match(after.saved, /harvest:6\/notes active/);
    // Each harvest run is marked saved by one update, after its record is written
    assert.deepEqual(
      db.owner
        .prepare("select status from extraction_run order by id")
        .all()
        .map((r, i) => [r.status, updates[i]]),
      [
        ["saved", 1],
        ["saved", 1],
      ],
    );
  } finally {
    await db.done();
  }
});

test("tombstone: glean does not store a file excerpt the owner forgot, and says so", async () => {
  const db = tempDb();
  const root = repo();
  try {
    const p = project(db);
    session(db, p, "g1");
    const said = message(db, p, { id: "o1", text: "Back up first.", session: "g1" });
    const units = {
      units: [
        {
          key: "backup",
          kind: "finding",
          text: "Back up before a release",
          evidence: [{ source: `s${said}`, quote: "Back up first.", role: "states" }],
        },
      ],
    };
    await saveText(db.ingest, await beginGlean(db.ingest, p, "g1"), p, root, units);
    const revision = () =>
      (db.owner.prepare("select revision from unit where key = 'glean:backup'").get() as { revision: number })
        .revision;
    const cite = async () => {
      const record = {
        ops: [
          {
            op: "add_evidence",
            unit: "glean:backup",
            revision: revision(),
            file: { path: "docs/note.md", lines: [3, 3] },
            quote: "Back up before a release.",
            role: "explains",
          },
        ],
      };
      const r = await beginGlean(db.ingest, p, "g1");
      const c = await checkText(db.ingest, r, p, root, record);
      return c.ok ? saveText(db.ingest, r, p, root, record) : Promise.reject(new Error(c.text));
    };
    await cite();
    const excerpt = Number(
      (db.owner.prepare("select id from source where kind = 'file_excerpt'").get() as { id: number }).id,
    );
    await applyForget(db.file, p, [excerpt], await previewForget(db.file, p, [excerpt]));
    await assert.rejects(cite(), /the owner forgot docs\/note.md lines 3-3; cite something else/);
    // Saving without checking first is refused the same way
    const direct = {
      ops: [
        {
          op: "add_evidence",
          unit: "glean:backup",
          revision: revision(),
          file: { path: "docs/note.md", lines: [3, 3] },
          quote: "Back up before a release.",
          role: "explains",
        },
      ],
    };
    await assert.rejects(
      saveText(db.ingest, await beginGlean(db.ingest, p, "g1"), p, root, direct),
      /the owner forgot docs\/note.md lines 3-3/,
    );
    assert.equal(
      (
        db.owner.prepare("select count(*) as n from source where kind = 'file_excerpt'").get() as {
          n: number;
        }
      ).n,
      0,
    );
  } finally {
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("trace: context comes in pages, and saving marks as looked at only the messages the run was shown", async () => {
  const db: TempDb = tempDb();
  try {
    const p = project(db);
    const ids = Array.from({ length: 40 }, (_, i) =>
      message(db, p, {
        id: `m${i}`,
        text: `発言 ${i}: ${"あ".repeat(1500)}`,
        sent: `2026-09-10T00:${String(i).padStart(2, "0")}:00Z`,
      }),
    );
    const untraced = () =>
      Number(
        db.owner
          .prepare(
            "select count(*) as n from source s where s.session_id = 's1' and not exists (select 1 from source_processing p where p.source_id = s.id)",
          )
          .get()?.n,
      );
    // Reading only the first page and saving leaves the unread messages waiting for the next trace
    const first = await beginTrace(db.ingest, p, "s1");
    const page = await contextText(db.ingest, first, p, null);
    assert.ok(page.length < 21_000, `a page of ${page.length} characters`);
    assert.match(page, /\d+ more sources follow: call record_context with after: "s\d+"/);
    assert.doesNotMatch(page, /Live records of this project/);
    assert.doesNotMatch(page, /発言 39:/);
    await saveText(db.ingest, first, p, null, { units: [] });
    const shown = [...page.matchAll(/^## s(\d+) /gm)].length;
    assert.ok(shown > 0 && shown < 40);
    assert.equal(untraced(), 40 - shown);
    assert.match(await pendingText(db.ingest, p, new Date("2026-09-20T00:00:00Z")), /1 session to trace/);
    // Reading every page to the end marks them all; a page starts only after a cursor the run was given
    const second = await beginTrace(db.ingest, p, "s1");
    await assert.rejects(
      contextText(db.ingest, second, p, null, `s${ids[30]}`),
      /not a page this run was given; call record_context without after/,
    );
    let text = await contextText(db.ingest, second, p, null);
    const pages = [text];
    for (let m = /after: "(s\d+)"/.exec(text); m; m = /after: "(s\d+)"/.exec(text)) {
      text = await contextText(db.ingest, second, p, null, m[1]);
      pages.push(text);
    }
    assert.ok(pages.length > 1);
    assert.match(pages.at(-1) ?? "", /発言 39:[\s\S]*Live records of this project/);
    assert.equal(pages.join("\n").match(/^## s\d+ /gm)?.length, 40);
    await saveText(db.ingest, second, p, null, { units: [] });
    assert.equal(untraced(), 0);
    assert.ok(ids.length === 40);
  } finally {
    await db.done();
  }
});

test("trace: one message longer than a page is cut with a pointer to read the rest, and a quote not found marks nothing looked at", async () => {
  const db: TempDb = tempDb();
  try {
    const p = project(db);
    const long = message(db, p, { id: "m1", text: `始まり ${"い".repeat(30_000)} 終わり` });
    const other = message(db, p, { id: "m2", text: "Postgres は使わない。", sent: "2026-09-10T00:01:00Z" });
    const run = await beginTrace(db.ingest, p, "s1");
    const page = await contextText(db.ingest, run, p, null);
    assert.ok(page.length < 21_000, `a page of ${page.length} characters`);
    const rest = new RegExp(`read (s${long}@\\d+) for the rest`).exec(page)?.[1] ?? "";
    assert.ok(rest, page.slice(-200));
    assert.doesNotMatch(page, /終わり/);
    // The pointer reads on from where the page cut off
    const tail = await readRefs(db.reader, p, [rest], null);
    assert.match(tail, /終わり/);
    assert.doesNotMatch(tail, /始まり/);
    // The record cites the unread message with words it does not hold: that proves no reading, so it is not marked
    await saveText(db.ingest, run, p, null, {
      units: [
        {
          key: "no-postgres",
          kind: "finding",
          text: "Postgres",
          evidence: [{ source: `s${other}`, quote: "MySQL も使わない。", role: "states" }],
        },
      ],
    });
    const looked = (id: number) =>
      Number(db.owner.prepare("select count(*) as n from source_processing where source_id = ?").get(id)?.n);
    assert.equal(looked(long), 1);
    assert.equal(looked(other), 0);
  } finally {
    await db.done();
  }
});

test("trace: the live records go on a page of their own when they do not fit beside the last messages", async () => {
  const db: TempDb = tempDb();
  try {
    const p = project(db);
    message(db, p, { id: "m1", text: "う".repeat(19_900) });
    const run = await beginTrace(db.ingest, p, "s1");
    const first = await contextText(db.ingest, run, p, null);
    const next = /The live records follow: call record_context with after: "(s\d+)"/.exec(first)?.[1];
    assert.ok(next, first.slice(-300));
    assert.doesNotMatch(first, /Live records of this project/);
    const last = await contextText(db.ingest, run, p, null, next);
    assert.match(last, /Live records of this project/);
    assert.doesNotMatch(last, /^## s/m);
  } finally {
    await db.done();
  }
});

test("trace: a page stays within its size for emoji text, and every edit of a long session is listed", async () => {
  const db: TempDb = tempDb();
  try {
    const p = project(db);
    const emoji = message(db, p, { id: "m1", text: "😀".repeat(30_000) });
    for (let i = 0; i < 150; i++)
      insert(db, "edit_observation", {
        session_id: "s1",
        turn_id: "t1",
        tool_event_id: `e${i}`,
        path: `src/file-${i}.ts`,
        via: "tool",
        observed_at: "2026-09-10T00:00:00.000Z",
      });
    const run = await beginTrace(db.ingest, p, "s1");
    const first = await contextText(db.ingest, run, p, null);
    assert.ok(first.length < 21_000, `a page of ${first.length} characters`);
    assert.match(first, new RegExp(`read s${emoji}@\\d+ for the rest`));
    let page = first;
    for (let m = /after: "(s\d+)"/.exec(page); m; m = /after: "(s\d+)"/.exec(page))
      page = await contextText(db.ingest, run, p, null, m[1]);
    // Every edit is listed: a long session edits more than a hundred times, and the anchors come from these paths
    assert.match(page, /- src\/file-0\.ts[\s\S]*- src\/file-149\.ts/);
    assert.ok(page.length < 21_000, `a page of ${page.length} characters`);
  } finally {
    await db.done();
  }
});

test("trace: a tail too long for a page is cut, with the number of lines left out", async () => {
  const db: TempDb = tempDb();
  try {
    const p = project(db);
    const said = message(db, p, { id: "m1", text: "Track these fields." });
    const r = Number(
      db.owner
        .prepare(
          "insert into extraction_run (project_id, origin, target, status, started_at) values (?, 'trace', 'session:s1', 'saved', '2026-09-10T00:00:00.000Z') returning id",
        )
        .get(p)?.id,
    );
    for (let i = 0; i < 60; i++)
      insert(db, "field_def", {
        project_id: p,
        name: `field_${i}`,
        type: "text",
        label: `Field ${i}`,
        description: "d".repeat(500),
        source_id: said,
        span_start: 0,
        span_end: 5,
        run_id: r,
        added_at: "2026-09-10T00:00:00.000Z",
      });
    const run = await beginTrace(db.ingest, p, "s1");
    let page = await contextText(db.ingest, run, p, null);
    for (let m = /after: "(s\d+)"[^\n]*$/.exec(page); m; m = /after: "(s\d+)"[^\n]*$/.exec(page)) {
      assert.ok(page.length < 21_000, `a page of ${page.length} characters`);
      page = await contextText(db.ingest, run, p, null, m[1]);
    }
    assert.ok(page.length < 21_000, `a page of ${page.length} characters`);
    assert.match(
      page,
      /- and \d+ more lines left out: find records with search, and every field definition with the fields tool/,
    );
  } finally {
    await db.done();
  }
});

// One glean on the owner's decision O and A, a proposal to replace it: what the batch asks for together, judged together
const gleanBench = async () => {
  const db = tempDb();
  const p = project(db);
  const old = message(db, p, { id: "o1", text: "SQLite にしよう。" });
  await saveText(db.ingest, await beginTrace(db.ingest, p, "s1"), p, null, {
    units: [
      {
        key: "storage",
        kind: "decision",
        stance: "do",
        text: "SQLite にしよう。",
        evidence: [{ source: `s${old}`, quote: "SQLite にしよう。", role: "states" }],
        adoption: [{ source: `s${old}`, quote: "SQLite にしよう。" }],
      },
    ],
  });
  session(db, p, "g1");
  const said = message(db, p, { id: "g", text: "Postgres に変える。これで決まり。やめる。", session: "g1" });
  const assistant = message(db, p, {
    id: "a",
    text: "Postgres に変えましょう。",
    speaker: "assistant",
    session: "g1",
  });
  const glean = async (record: unknown) =>
    saveText(db.ingest, await beginGlean(db.ingest, p, "g1"), p, null, record);
  await glean({
    units: [
      {
        key: "pg",
        kind: "decision",
        stance: "do",
        text: "Postgres に変えましょう。",
        evidence: [{ source: `s${assistant}`, quote: "Postgres に変えましょう。", role: "states" }],
        supersedes: "trace:ext-s1/storage",
      },
    ],
  });
  const revision = (key: string) =>
    db.owner.prepare("select revision from unit where key = ?").get(key)?.revision;
  const state = (key: string) =>
    db.owner.prepare("select lifecycle from unit where key = ?").get(key)?.lifecycle;
  return { db, p, said, glean, revision, state };
};

test("glean: withdrawing both a record and the proposal that would replace it in one save withdraws both", async () => {
  const { db, said, glean, revision, state } = await gleanBench();
  try {
    await glean({
      ops: [
        {
          op: "adopt",
          unit: "glean:pg",
          revision: revision("glean:pg"),
          source: `s${said}`,
          quote: "これで決まり。",
        },
        {
          op: "withdraw",
          unit: "trace:ext-s1/storage",
          revision: revision("trace:ext-s1/storage"),
          reason_source: `s${said}`,
          reason_quote: "やめる。",
        },
        {
          op: "withdraw",
          unit: "glean:pg",
          revision: revision("glean:pg"),
          reason_source: `s${said}`,
          reason_quote: "やめる。",
        },
      ],
    });
    assert.deepEqual([state("trace:ext-s1/storage"), state("glean:pg")], ["withdrawn", "withdrawn"]);
  } finally {
    await db.done();
  }
});

test("glean: a new record the owner adopts and an adopted proposal racing for one place in one save are refused by name", async () => {
  const { db, said, glean, revision, state } = await gleanBench();
  try {
    await assert.rejects(
      glean({
        units: [
          {
            key: "duck",
            kind: "decision",
            stance: "do",
            text: "Postgres に変える。",
            evidence: [{ source: `s${said}`, quote: "Postgres に変える。", role: "states" }],
            adoption: [{ source: `s${said}`, quote: "Postgres に変える。" }],
            supersedes: "trace:ext-s1/storage",
          },
        ],
        ops: [
          {
            op: "adopt",
            unit: "glean:pg",
            revision: revision("glean:pg"),
            source: `s${said}`,
            quote: "これで決まり。",
          },
        ],
      }),
      /glean:duck: another record in this save already supersedes trace:ext-s1\/storage/,
    );
    assert.deepEqual([state("trace:ext-s1/storage"), state("glean:pg")], ["active", "candidate"]);
  } finally {
    await db.done();
  }
});
