// read against real SQLite and a real Git working tree: what one reply carries, and that a record reads the same whatever else is read.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { inTransaction } from "../src/db.ts";
import { READ_BUDGET, readRefs, readUnit } from "../src/read.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { openRun } from "../src/trace.ts";
import { at, hash, insert, message, project, type TempDb, tempDb } from "./temp-db.ts";

async function save(db: TempDb, p: number, root: string | null, record: unknown) {
  const t: Target = {
    projectId: p,
    origin: "trace",
    prefix: "trace:ext-s1/",
    sessionId: "s1",
    root,
    sources: null,
  };
  return inTransaction(db.ingest, async (trx) => {
    const run = await openRun(trx, {
      projectId: p,
      origin: "trace",
      target: "session:s1",
      sessionId: "s1",
      draftId: `d${Math.random()}`,
    });
    return saveRecord(trx, t, run, await checkRecord(trx, t, record), []);
  });
}

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/** The read MCP server on a temporary database, answering for a repository registered as git:github.com/o/r */
async function server(db: TempDb, root: string) {
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/o/r.git"]);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(SRC, "mcp.ts")],
      env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", SPHICA_DB: db.file },
      stderr: "ignore",
    }),
  );
  const read = async (refs: string[]) => {
    const r = await client.callTool({ name: "read", arguments: { refs, cwd: root } });
    return (r.content as { text: string }[])[0]?.text ?? "";
  };
  return { client, read };
}

function repo(): { root: string; git: (...args: string[]) => string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-read-")));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
      encoding: "utf8",
    }).trim();
  git("init", "-q");
  return { root, git };
}

test("read rename budget: a record reads the same alone and after a record that used up its own rename lookups", async () => {
  const db = tempDb();
  const { root, git } = repo();
  try {
    const commits: string[] = [];
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(root, `f${i}.ts`), `export const f${i} = ${i};\n`);
      git("add", "-A");
      git("commit", "-qm", `f${i}`);
      commits.push(git("rev-parse", "HEAD"));
    }
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "f を足した。g を足した。" });
    const finding = (key: string, quote: string, anchors: unknown[]) => ({
      key,
      kind: "finding",
      text: quote,
      evidence: [{ source: `s${m}`, quote, role: "states" }],
      anchors,
    });
    await save(db, p, root, {
      units: [
        finding(
          "five",
          "f を足した。",
          commits.slice(0, 5).map((commit, i) => ({ path: `f${i}.ts`, role: "evidence", commit })),
        ),
        finding("sixth", "g を足した。", [{ path: "f5.ts", role: "evidence", commit: commits[5] }]),
      ],
    });
    for (let i = 0; i < 6; i++) fs.rmSync(path.join(root, `f${i}.ts`));
    const alone = (await readUnit(db.reader, p, "trace:ext-s1/sixth", root)) ?? "";
    assert.doesNotMatch(alone, /rename not checked/);
    // One read shares what git said, but each record counts its own lookups
    const shared = new Map();
    const first = (await readUnit(db.reader, p, "trace:ext-s1/five", root, undefined, shared)) ?? "";
    assert.doesNotMatch(first, /rename not checked/);
    assert.equal((await readUnit(db.reader, p, "trace:ext-s1/sixth", root, undefined, shared)) ?? "", alone);
  } finally {
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("read budget: ten long sources in one read stay within the reply budget through the MCP server", async () => {
  const db = tempDb();
  const { root } = repo();
  const p = project(db);
  const ids = Array.from({ length: 10 }, (_, n) =>
    message(db, p, { id: `m${n}`, text: `${"long words ".repeat(5_000)}end of ${n}` }),
  );
  const { client, read } = await server(db, root);
  try {
    const reply = await read(ids.map((id) => `s${id}`));
    assert.ok(Buffer.byteLength(reply) <= READ_BUDGET, `${Buffer.byteLength(reply)} bytes`);
  } finally {
    await client.close();
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** The text a reply carries for its last (cut) ref, and the refs it names for the rest; [] when it ends. */
function pageOf(reply: string): { body: string; next: string[] } {
  const lines = reply.split("\n");
  const body = lines.slice(2, -1).join("\n");
  const stop = new RegExp(
    `\\n\\n\\(This reply stops here to stay within ${READ_BUDGET / 1024} KiB\\. Call read with refs (\\[.*\\]) for the rest\\.\\)$`,
  ).exec(body);
  return { body: stop ? body.slice(0, stop.index) : body, next: stop ? JSON.parse(stop[1] ?? "[]") : [] };
}

/** Follows the continuations of one ref until nothing is left, checking each reply's size, and returns the text it showed in order. */
async function follow(
  db: TempDb,
  p: number,
  ref: string,
  root: string | null,
  strip: (body: string) => string,
) {
  let refs = [ref];
  let text = "";
  let offset = -1;
  for (let n = 0; n < 100 && refs.length; n++) {
    const reply = await readRefs(db.reader, p, refs, root);
    assert.ok(Buffer.byteLength(reply) <= READ_BUDGET, `reply ${n}: ${Buffer.byteLength(reply)} bytes`);
    const { body, next } = pageOf(reply);
    const cut = /\n\((\d+) bytes(?: of this record)? more; read (\S+) for the rest\)$/.exec(body);
    text += strip(cut ? body.slice(0, cut.index) : body);
    const at = Number(/@(\d+)/.exec(next[0] ?? "")?.[1] ?? Number.POSITIVE_INFINITY);
    assert.ok(at > offset, `offset ${at} after ${offset}`);
    offset = at;
    refs = next;
  }
  assert.deepEqual(refs, []);
  return text;
}

test("read budget: long sources are read to their last byte through continuations, whatever characters fall on a boundary", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    // 1, 2, 3, and 4 bytes per character, so cuts fall inside every width
    const text = `${Array.from({ length: 30_000 }, (_, n) => ["a", "é", "あ", "😀"][n % 4] ?? "").join("")}\nend`;
    const ids = [message(db, p, { id: "m1", text }), message(db, p, { id: "m2", text: `${text}2` })];
    for (const [n, id] of ids.entries()) {
      const got = await follow(db, p, `s${id}`, null, (b) => b.replace(/^s\d+: [^\n]*\n/, ""));
      assert.equal(got, n ? `${text}2` : text);
    }
    // Ten refs in one read: each reply stays in the budget and names what is left, the cut one first
    const many = Array.from({ length: 10 }, (_, n) =>
      message(db, p, { id: `x${n}`, text: `${"x".repeat(20_000)}${n}` }),
    );
    const first = pageOf(
      await readRefs(
        db.reader,
        p,
        many.map((id) => `s${id}`),
        null,
      ),
    );
    const cut = Number(/^s(\d+)@\d+$/.exec(first.next[0] ?? "")?.[1]);
    assert.ok(many.indexOf(cut) > 0, first.next[0]);
    assert.deepEqual(
      first.next.slice(1),
      many.slice(many.indexOf(cut) + 1).map((id) => `s${id}`),
    );
    // A source whose header fields from outside are long still leaves room for text
    const long = "z".repeat(5_000);
    const id = insert(db, "source", {
      project_id: p,
      kind: "pr_comment",
      artifact: `pr:${long}`,
      external_id: "c1",
      revision: 1,
      author_kind: "person",
      author_login: long,
      author_association: "NONE",
      url: `https://example.com/${long}`,
      path: `src/${long}.ts`,
      line_start: 1,
      created_at: at("2026-09-10T00:00:00Z"),
      captured_at: at("2026-09-10T00:00:00Z"),
      text: "y".repeat(100_000),
      original_bytes: 100_000,
      content_hash: hash(),
      indexed: 1,
    });
    const reply = await readRefs(db.reader, p, [`s${id}`], null);
    const header = pageOf(reply).body.split("\n")[0] ?? "";
    assert.ok(Buffer.byteLength(header) < 1_600, `${Buffer.byteLength(header)} bytes of header`);
    assert.match(header, /…/);
    assert.equal(
      await follow(db, p, `s${id}`, null, (b) => b.replace(/^s\d+: [^\n]*\n/, "")),
      "y".repeat(100_000),
    );
  } finally {
    await db.done();
  }
});

test("read budget: a record longer than a reply, one quote over a reply, goes on by byte and digest, and a change sends it back to the start", async () => {
  const db = tempDb();
  const { root, git } = repo();
  try {
    fs.writeFileSync(path.join(root, "f.ts"), "export const f = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "f");
    const commit = git("rev-parse", "HEAD");
    const p = project(db);
    const quote = `${"長い引用 ".repeat(15_000)}おわり。`;
    const m = message(db, p, { id: "m1", text: quote });
    await save(db, p, root, {
      units: [
        {
          key: "big",
          kind: "finding",
          text: "長い引用がある",
          evidence: [{ source: `s${m}`, quote, role: "states" }],
          anchors: [{ path: "f.ts", role: "evidence", commit }],
        },
      ],
    });
    fs.rmSync(path.join(root, "f.ts"));
    const whole = (await readUnit(db.reader, p, "trace:ext-s1/big", root)) ?? "";
    assert.ok(Buffer.byteLength(whole) > READ_BUDGET);
    const strip = (b: string) => b.replace(/^\(u\d+ continued from byte \d+\)\n/, "");
    assert.equal(await follow(db, p, "trace:ext-s1/big", root, strip), whole);
    // Begun after other refs, its continuation read alone matches: the rendering does not depend on what else was read
    const begun = pageOf(await readRefs(db.reader, p, ["trace:ext-s1/nothing", "trace:ext-s1/big"], root));
    const go = begun.next[0] ?? "";
    assert.match(go, /^u\d+@\d+:[0-9a-f]{12}$/);
    assert.doesNotMatch(
      pageOf(await readRefs(db.reader, p, [go], root)).body,
      /changed since the previous page/,
    );
    // A record that changed between pages is read again from the start
    await save(db, p, root, {
      units: [
        {
          key: "other",
          kind: "finding",
          text: "おわり",
          evidence: [{ source: `s${m}`, quote: "おわり。", role: "states" }],
          conflicts: ["trace:ext-s1/big"],
        },
      ],
    });
    const id = /^u(\d+)@/.exec(go)?.[1];
    assert.equal(
      pageOf(await readRefs(db.reader, p, [go], root)).body,
      `u${id} changed since the previous page; read u${id} again from the start`,
    );
  } finally {
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("read cut terminal: a cut inside a terminal string sequence keeps the continuation, and the text after it is reached", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const id = message(db, p, {
      id: "m1",
      text: `${"a".repeat(65_000)}\u001b]0;${"x".repeat(300)}\u0007VISIBLE END`,
    });
    let refs = [`s${id}`];
    let seen = "";
    for (let n = 0; n < 5 && refs.length; n++) {
      const reply = await readRefs(db.reader, p, refs, null);
      assert.ok(Buffer.byteLength(reply) <= READ_BUDGET);
      seen += reply;
      refs = pageOf(reply).next;
    }
    assert.match(seen, /VISIBLE END/);
    // Text from outside never carries the sequence into the reply
    assert.ok(!seen.includes("\u001b"));
  } finally {
    await db.done();
  }
});

test("read header terminal: a header field holding a terminal sequence is cleaned before it is clipped, so the body still shows", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const id = insert(db, "source", {
      project_id: p,
      kind: "pr_comment",
      artifact: "pr:1",
      external_id: "c1",
      revision: 1,
      author_kind: "person",
      author_login: "someone",
      author_association: "NONE",
      url: `https://example.invalid/\u001b]0;${"x".repeat(500)}\u0007`,
      created_at: at("2026-09-10T00:00:00Z"),
      captured_at: at("2026-09-10T00:00:00Z"),
      text: "VISIBLE BODY",
      original_bytes: 12,
      content_hash: hash(),
      indexed: 1,
    });
    const reply = await readRefs(db.reader, p, [`s${id}`], null);
    assert.match(reply, /VISIBLE BODY/);
    assert.ok(!reply.includes("\u001b"));
  } finally {
    await db.done();
  }
});

test("read hidden sequence: a terminal string longer than a page stays hidden on every page, and the text after it shows", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    // Visible text before and after, so the cut falls inside the sequence and the rest is still more than a page
    const id = message(db, p, {
      id: "m1",
      text: `intro ${"a".repeat(30_000)}\u001b]0;${"H".repeat(100_000)}\u0007${"b".repeat(40_000)}VISIBLE TAIL`,
    });
    let refs = [`s${id}`];
    let seen = "";
    for (let n = 0; n < 10 && refs.length; n++) {
      const reply = await readRefs(db.reader, p, refs, null);
      assert.ok(Buffer.byteLength(reply) <= READ_BUDGET);
      seen += reply;
      refs = pageOf(reply).next;
    }
    assert.deepEqual(refs, []);
    assert.match(seen, /intro /);
    assert.match(seen, /VISIBLE TAIL/);
    assert.doesNotMatch(seen, /HHHHHHHH/);
  } finally {
    await db.done();
  }
});

test("read hidden csi: a control sequence with a long parameter list is never cut, so its parameters do not show on the next page", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const id = message(db, p, {
      id: "m1",
      text: `intro ${"a".repeat(30_000)}\u001b[${"1;".repeat(50_000)}31m${"b".repeat(40_000)}VISIBLE TAIL`,
    });
    let refs = [`s${id}`];
    let seen = "";
    for (let n = 0; n < 10 && refs.length; n++) {
      const reply = await readRefs(db.reader, p, refs, null);
      assert.ok(Buffer.byteLength(reply) <= READ_BUDGET);
      seen += reply;
      refs = pageOf(reply).next;
    }
    assert.deepEqual(refs, []);
    assert.match(seen, /VISIBLE TAIL/);
    assert.doesNotMatch(seen, /(?:1;){8}/);
    // A sequence plain does not drop whole (colons in its parameters) is ordinary text: it is cut like any text, within the budget
    const colon = message(db, p, {
      id: "m2",
      text: `${"a".repeat(30_000)}\u001b[${"1:".repeat(50_000)}31m${"b".repeat(40_000)}END`,
    });
    let more = [`s${colon}`];
    let tail = "";
    for (let n = 0; n < 20 && more.length; n++) {
      const reply = await readRefs(db.reader, p, more, null);
      assert.ok(Buffer.byteLength(reply) <= READ_BUDGET, `reply ${n}: ${Buffer.byteLength(reply)} bytes`);
      tail += reply;
      more = pageOf(reply).next;
    }
    assert.deepEqual(more, []);
    assert.match(tail, /END/);
  } finally {
    await db.done();
  }
});

test("read shows retired anchors with the words that retired them, a move's new place, and none of those retired after an as-of time", async () => {
  const db = tempDb();
  const { root, git } = repo();
  try {
    fs.writeFileSync(path.join(root, "a.ts"), "export function open() {}\n");
    git("add", "-A");
    git("commit", "-qm", "a");
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "a.ts の open を使う。" });
    await save(db, p, root, {
      units: [
        {
          key: "open",
          kind: "finding",
          text: "open を使う",
          evidence: [{ source: `s${m}`, quote: "a.ts の open を使う。", role: "states" }],
          anchors: [
            { path: "a.ts", symbol: "open", role: "applies_to" },
            { path: "CLAUDE.md", role: "applies_to" },
            { path: "AGENTS.md", role: "applies_to" },
          ],
        },
      ],
    });
    const said = message(db, p, { id: "m2", text: "CLAUDE.md からは外して。" });
    const u = Number(
      db.owner.prepare("select id, run_id from unit where key = 'trace:ext-s1/open'").get()?.id,
    );
    const runId = Number(db.owner.prepare("select run_id from unit where id = ?").get(u)?.run_id);
    const anchorId = (p2: string) =>
      Number(
        db.owner.prepare("select id from unit_anchor where path = ? and retired_at is null").get(p2)?.id,
      );
    // After the save (anchors are added now), so an as-of time between the two sees them live
    const retiredAt = new Date(Date.now() + 86_400_000).toISOString();
    // Retired with the owner's words, moved with nothing kept (as before revision 12), and one left live
    const claude = anchorId("CLAUDE.md");
    db.owner.prepare("update unit_anchor set retired_at = ? where id = ?").run(retiredAt, claude);
    insert(db, "unit_anchor_retirement", {
      anchor_id: claude,
      run_id: runId,
      source_id: said,
      span_start: 0,
      span_end: Buffer.byteLength("CLAUDE.md からは外して。"),
      added_at: retiredAt,
    });
    const agents = anchorId("AGENTS.md");
    const moved = insert(db, "unit_anchor", {
      unit_id: u,
      path: "a.ts",
      symbol: "close",
      role: "applies_to",
      run_id: runId,
      added_at: retiredAt,
    });
    db.owner
      .prepare("update unit_anchor set retired_at = ?, replaced_by = ? where id = ?")
      .run(retiredAt, moved, agents);
    const out = (await readUnit(db.reader, p, "trace:ext-s1/open", root)) ?? "";
    assert.match(out, /Code \(checked[^\n]*\n {2}- a\.ts open \(applies_to\): located/);
    assert.match(out, /\n {2}- a\.ts close \(applies_to\)/);
    assert.match(
      out,
      new RegExp(
        `Retired anchors \\(they no longer count for delivery; a live anchor on the same path still does[^\\n]*\\n  - CLAUDE\\.md \\(applies_to\\): retired ${retiredAt}; s${said}, the owner, \\S+: "CLAUDE\\.md からは外して。"\\n  - AGENTS\\.md \\(applies_to\\): retired ${retiredAt}, moved to a\\.ts close; reason not recorded`,
      ),
    );
    // Before the retirement, both were live and nothing was retired
    const before =
      (await readUnit(
        db.reader,
        p,
        "trace:ext-s1/open",
        root,
        new Date(Date.now() + 3_600_000).toISOString(),
      )) ?? "";
    assert.doesNotMatch(before, /Retired anchors/);
    assert.match(before, /- CLAUDE\.md \(applies_to\)/);
    // Many retired anchors with long reasons still come back within the reply budget, with a way to read on
    const long = message(db, p, { id: "m3", text: `${"外す理由 ".repeat(2_000)}end` });
    for (let i = 0; i < 300; i++) {
      const id = insert(db, "unit_anchor", {
        unit_id: u,
        path: `old/f${i}.ts`,
        role: "applies_to",
        run_id: runId,
        added_at: retiredAt,
      });
      db.owner.prepare("update unit_anchor set retired_at = ? where id = ?").run(retiredAt, id);
      insert(db, "unit_anchor_retirement", {
        anchor_id: id,
        run_id: runId,
        source_id: long,
        span_start: 0,
        span_end: Buffer.byteLength("外す理由 ".repeat(200)),
        added_at: retiredAt,
      });
    }
    const page = await readRefs(db.reader, p, ["trace:ext-s1/open"], root);
    assert.ok(Buffer.byteLength(page) <= READ_BUDGET, `${Buffer.byteLength(page)} bytes`);
    assert.match(page, /Call read with refs/);
  } finally {
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
