// The record server's flows against real SQLite and a real git repository: begin binds a run, context, check, and save take its id,
// and glean's changes cite owner messages, fetched GitHub sources, or file excerpts read from git.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
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
import type { Get } from "../src/github.ts";
import { insert, message, project, session, type TempDb, tempDb } from "./temp-db.ts";

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

test("trace: pending lists the session, begin binds it, and check and save take the run id", async () => {
  const db: TempDb = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "SQLite にしよう。" });
    assert.match(await pendingText(db.ingest, p), /1 session to trace[\s\S]*- s1 claude-code/);
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
    assert.match(await saveText(db.ingest, run, p, null, record), /trace:ext-s1\/storage active/);
    await assert.rejects(saveText(db.ingest, run, p, null, record), /already saved/);
    await assert.rejects(contextText(db.ingest, run, p + 1, null), /another project/);
    await assert.rejects(contextText(db.ingest, "missing", p, null), /No run/);
    assert.match(await pendingText(db.ingest, p), /1 session to trace[\s\S]*- s9 claude-code/);
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
  } finally {
    await db.done();
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
    const run = await beginGlean(db.ingest, p, "g1");
    assert.match(
      await contextText(db.ingest, run, p, root),
      /glean:<key>[\s\S]*## s\d+ owner[\s\S]*木村さん/,
    );
    const fetched = await gleanFetch(
      db.ingest,
      run,
      place(p, root),
      "https://github.com/o/r/issues/9",
      fakeGet,
    );
    const issue = Number(/s(\d+) issue_body/.exec(fetched)?.[1]);
    assert.ok(issue > 0, fetched);
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
    await refused(
      { op: "add_evidence", source: `s${reply}`, quote: "了解。", role: "states", reported_speaker: "x" },
      /must cite an owner message/,
    );
    await refused({ op: "adopt", source: `s${merge}`, quote: "merged" }, /merge does not adopt/);
    await refused({ op: "adopt", source: `s${reply}`, quote: "了解。" }, /only the owner or a maintainer/);
    await refused({ op: "adopt", source: "s99999", quote: "x" }, /not a source of this project/);
    await refused({ op: "anchor", path: "/etc/passwd", role: "applies_to" }, /not inside the repository/);
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
