// The decision export against real SQLite: chosen active decisions with their standing quotes and the decisions they replaced, all or
// nothing, with every outside string fenced so it cannot change the document's structure; and the save path checked where it lands.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inTransaction } from "../src/db.ts";
import { EXPORT_LIMITS, exportDecisions, exportPath, exportReply } from "../src/export.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { openRun } from "../src/trace.ts";
import { at, hash, insert, message, project, session, type TempDb, tempDb } from "./temp-db.ts";

async function save(db: TempDb, p: number, units: unknown[], session = "s1") {
  const t: Target = {
    projectId: p,
    origin: "trace",
    prefix: "trace:ext-s1/",
    sessionId: session,
    root: null,
    sources: null,
  };
  return inTransaction(db.ingest, async (trx) => {
    const runId = await openRun(trx, {
      projectId: p,
      origin: "trace",
      target: `session:${session}`,
      sessionId: session,
      draftId: `d${Math.random()}`,
    });
    return saveRecord(trx, t, runId, await checkRecord(trx, t, { units }), []);
  });
}

const decision = (m: number, quote: string, key: string, extra: Record<string, unknown> = {}) => ({
  key,
  kind: "decision",
  stance: "do",
  text: `${key} text`,
  evidence: [{ source: `s${m}`, quote, role: "states" }],
  adoption: [{ source: `s${m}`, quote }],
  ...extra,
});

const exported = async (db: TempDb, p: number, refs: string[]) => {
  const r = await exportDecisions(db.reader, p, "o/r", refs);
  if ("error" in r) assert.fail(r.error);
  return r.document;
};
const refused = async (db: TempDb, p: number, refs: string[]) => {
  const r = await exportDecisions(db.reader, p, "o/r", refs);
  assert.ok("error" in r, "nothing is exported");
  return r.error;
};

test("a chosen decision comes with its quotes and every decision it replaced, newest first", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m1 = message(db, p, { id: "m1", text: "Store in one SQLite file. Decided." });
    const m2 = message(db, p, { id: "m2", text: "Move to Postgres for sharing. Decided." });
    const m3 = message(db, p, { id: "m3", text: "Go back to SQLite with a sync file. Decided." });
    await save(db, p, [
      decision(m1, "Store in one SQLite file. Decided.", "sqlite", {
        why: "no server for each user",
        options: [
          { text: "SQLite", outcome: "chosen" },
          { text: "Postgres", outcome: "rejected", why: "each user runs a server" },
        ],
      }),
      decision(m1, "Store in one SQLite file. Decided.", "unrelated"),
    ]);
    await save(db, p, [
      decision(m2, "Move to Postgres for sharing. Decided.", "postgres", {
        supersedes: "trace:ext-s1/sqlite",
      }),
    ]);
    await save(db, p, [
      decision(m3, "Go back to SQLite with a sync file. Decided.", "sync", {
        supersedes: "trace:ext-s1/postgres",
      }),
    ]);
    const doc = await exported(db, p, ["trace:ext-s1/sync"]);
    assert.match(doc, /^# Decisions exported from Sphica\n/);
    assert.deepEqual(
      [...doc.matchAll(/^#+ .*$/gm)].map((h) => h[0]),
      ["# Decisions exported from Sphica", "## Decision 1", "### Superseded 1.1", "### Superseded 1.2"],
    );
    const [, first = "", second = "", third = ""] = doc.split(/^#{2,3} .*$/m);
    assert.match(first, /key: trace:ext-s1\/sync \(u\d+\)/);
    assert.match(
      first,
      /the owner, [^,]+, session_message session:\S+ \(states\): "Go back to SQLite with a sync file\. Decided\."/,
    );
    assert.match(
      first,
      /adopted by:\n {2}- the owner, [^"]+: "Go back to SQLite with a sync file\. Decided\."/,
    );
    assert.match(second, /^\n\n`{3}text\ntrace:ext-s1\/sync supersedes trace:ext-s1\/postgres\n/);
    assert.match(second, /"Move to Postgres for sharing\. Decided\."/);
    assert.match(third, /trace:ext-s1\/postgres supersedes trace:ext-s1\/sqlite/);
    assert.match(third, /why: no server for each user/);
    assert.match(third, /- Postgres: rejected, because each user runs a server/);
    assert.doesNotMatch(doc, /unrelated/, "only what was chosen and its chain");
    assert.doesNotMatch(
      doc,
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \(export|exported at/i,
      "no export time",
    );
    assert.equal(await exported(db, p, ["trace:ext-s1/sync"]), doc, "the same choice writes the same bytes");
  } finally {
    await db.done();
  }
});

test("a deferred decision keeps when to revisit it, and a quote keeps the URL it came from", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const text = "Wait with sharding. Decided.";
    const m = insert(db, "source", {
      project_id: p,
      kind: "session_message",
      artifact: `session:${session(db, p)}`,
      external_id: "m1",
      revision: 1,
      session_id: "s1",
      author_kind: "owner",
      url: "https://example.com/thread/1",
      created_at: at("2026-09-10T00:00:00Z"),
      available_at: at("2026-09-10T00:00:00Z"),
      captured_at: at("2026-09-10T00:00:00Z"),
      text,
      original_bytes: Buffer.byteLength(text),
      content_hash: hash(),
      indexed: 1,
    });
    await save(db, p, [
      { ...decision(m, text, "later"), stance: "defer", revisit_when: "after the 1.0 release" },
    ]);
    const doc = await exported(db, p, ["trace:ext-s1/later"]);
    assert.match(doc, /\nrevisit when: after the 1\.0 release\n/);
    assert.match(doc, /\(states\): "Wait with sharding\. Decided\." <https:\/\/example\.com\/thread\/1>/);
    assert.match(
      doc,
      /adopted by:\n {2}- the owner, [^,]+, session_message session:s1: "Wait with sharding\. Decided\." <https:\/\/example\.com\/thread\/1>/,
    );
  } finally {
    await db.done();
  }
});

test("a quote spanning lines keeps its line breaks inside the fence", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const text = "Use:\n  bun test\n```\nDecided.";
    const m = message(db, p, { id: "m1", text });
    await save(db, p, [decision(m, text, "cmd")]);
    const doc = await exported(db, p, ["trace:ext-s1/cmd"]);
    assert.match(doc, /\(states\): "Use:\n {6} {2}bun test\n {6}```\n {6}Decided\."/);
    assert.deepEqual(
      [...doc.matchAll(/^#+ .*$/gm)].map((h) => h[0]),
      ["# Decisions exported from Sphica", "## Decision 1"],
    );
  } finally {
    await db.done();
  }
});

test("a record that changes while the export reads it refuses the export", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "Use pnpm. Decided. An aside." });
    await save(db, p, [
      decision(m, "Use pnpm. Decided.", "pnpm", {
        evidence: [
          { source: `s${m}`, quote: "Use pnpm. Decided.", role: "states" },
          { source: `s${m}`, quote: "An aside.", role: "explains" },
        ],
      }),
    ]);
    // Another connection retracts a quote after the export checked the record and before it reads the quotes
    let done = false;
    const racing = new Proxy(db.reader, {
      get(target, prop, receiver) {
        if (prop === "selectFrom")
          return (from: string) => {
            if (!done && from === "unit_option") {
              done = true;
              db.owner
                .prepare(
                  "update unit_evidence set retracted_at = '2099-01-01T00:00:00.000Z', retraction_reason = 'wrong', retraction_source_id = source_id, retraction_span_start = span_start, retraction_span_end = span_end where role = 'explains'",
                )
                .run();
            }
            return target.selectFrom(from as never);
          };
        return Reflect.get(target, prop, receiver);
      },
    });
    const r = await exportDecisions(racing, p, "o/r", ["trace:ext-s1/pnpm"]);
    assert.ok(done, "the change happened during the export");
    assert.ok("error" in r && /changed while/.test(r.error), JSON.stringify(r));
  } finally {
    await db.done();
  }
});

test("a retracted quote is left out", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "Use pnpm. Decided. Also a wrong aside." });
    await save(db, p, [
      decision(m, "Use pnpm. Decided.", "pnpm", {
        evidence: [
          { source: `s${m}`, quote: "Use pnpm. Decided.", role: "states" },
          { source: `s${m}`, quote: "Also a wrong aside.", role: "explains" },
        ],
      }),
    ]);
    db.owner
      .prepare(
        "update unit_evidence set retracted_at = '2099-01-01T00:00:00.000Z', retraction_reason = 'wrong', retraction_source_id = source_id, retraction_span_start = span_start, retraction_span_end = span_end where role = 'explains'",
      )
      .run();
    const doc = await exported(db, p, ["trace:ext-s1/pnpm"]);
    assert.match(doc, /"Use pnpm\. Decided\."/);
    assert.doesNotMatch(doc, /wrong aside/);
  } finally {
    await db.done();
  }
});

test("any record that is not an active decision of this project refuses the whole export", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const other = project(db, "git:github.com/o/other", "o/other");
    const m = message(db, p, { id: "m1", text: "Keep it simple. Decided." });
    const q = "Keep it simple. Decided.";
    await save(db, p, [
      decision(m, q, "ok"),
      decision(m, q, "old"),
      { ...decision(m, q, "rule"), kind: "constraint" },
      { ...decision(m, q, "maybe"), adoption: [] },
    ]);
    await save(db, p, [decision(m, q, "new", { supersedes: "trace:ext-s1/old" })]);
    const error = await refused(db, p, [
      "trace:ext-s1/ok",
      "trace:ext-s1/rule",
      "trace:ext-s1/maybe",
      "trace:ext-s1/old",
      "nope",
    ]);
    assert.match(error, /^Nothing was exported\./);
    assert.match(error, /- trace:ext-s1\/rule: a constraint, not a decision/);
    assert.match(error, /- trace:ext-s1\/maybe: candidate, not active/);
    assert.match(error, /- trace:ext-s1\/old: superseded, not active/);
    assert.match(error, /- nope: no such record in this project/);
    assert.doesNotMatch(error, /ok:/);
    assert.match(await refused(db, other, ["trace:ext-s1/ok"]), /no such record in this project/);
    // The same key saved first in another project does not hide this project's decision
    const first = tempDb();
    try {
      const a1 = project(first, "git:github.com/o/a", "o/a");
      const b1 = project(first, "git:github.com/o/b", "o/b");
      const ma = message(first, a1, { id: "ma", text: q, session: "sa" });
      await save(first, a1, [decision(ma, q, "ok")], "sa");
      const mb = message(first, b1, { id: "mb", text: q, session: "sb" });
      await save(first, b1, [decision(mb, q, "ok")], "sb");
      assert.match(await exported(first, b1, ["trace:ext-s1/ok"]), /"Keep it simple\. Decided\."/);
    } finally {
      await first.done();
    }
  } finally {
    await db.done();
  }
});

test("a chain deeper than the limit refuses the export, and one at the limit is printed in full", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "Step. Decided." });
    const q = "Step. Decided.";
    await save(db, p, [decision(m, q, "d0")]);
    const step = (i: number) =>
      save(db, p, [decision(m, q, `d${i}`, { supersedes: `trace:ext-s1/d${i - 1}` })]);
    for (let i = 1; i <= EXPORT_LIMITS.depth; i++) await step(i);
    const full = await exported(db, p, [`trace:ext-s1/d${EXPORT_LIMITS.depth}`]);
    assert.equal([...full.matchAll(/^### Superseded /gm)].length, EXPORT_LIMITS.depth);
    await step(EXPORT_LIMITS.depth + 1);
    assert.match(
      await refused(db, p, [`trace:ext-s1/d${EXPORT_LIMITS.depth + 1}`]),
      new RegExp(`deeper than ${EXPORT_LIMITS.depth}`),
    );
  } finally {
    await db.done();
  }
});

test("a document over the byte cap is refused, not cut", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const long = `${"a long reason ".repeat(300)}Decided.`;
    const m = message(db, p, { id: "m1", text: long });
    const keys: string[] = [];
    for (let i = 0; i < 20; i++) {
      await save(db, p, [decision(m, long, `big${i}`)]);
      keys.push(`trace:ext-s1/big${i}`);
    }
    assert.match(await refused(db, p, keys), /over 61440 bytes\. Choose fewer decisions\./);
    // A quote full of backticks is refused for its size too, not by a crash on the way
    const ticks = `${"`a".repeat(200_000)} Decided.`;
    const mt = message(db, p, { id: "mt", text: ticks });
    await save(db, p, [decision(mt, ticks, "ticks")]);
    assert.match(await refused(db, p, ["trace:ext-s1/ticks"]), /Choose fewer decisions\./);
  } finally {
    await db.done();
  }
});

test("quotes cannot add headings, links, HTML, or close their fence", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const nasty =
      "Use ````` fences.\r\n# Owned\n<script>alert(1)</script> [x](http://evil.example) ![i](http://evil.example/i.png) https://evil.example Decided.";
    const m = message(db, p, { id: "m1", text: nasty });
    await save(db, p, [decision(m, nasty, "nasty", { text: "## not a heading [y](http://evil.example)" })]);
    const doc = await exported(db, p, ["trace:ext-s1/nasty"]);
    assert.deepEqual(
      [...doc.matchAll(/^#+ .*$/gm)].map((h) => h[0]),
      ["# Decisions exported from Sphica", "## Decision 1"],
    );
    // Every outside string sits inside a fence longer than any backtick run it holds
    const blocks = [...doc.matchAll(/^(`{3,})text\n([\s\S]*?)\n\1$/gm)];
    assert.equal(blocks.length, 2);
    const last = blocks[1] ?? assert.fail("no record block");
    assert.equal(last[1], "``````");
    assert.match(last[2] ?? "", /<script>alert\(1\)<\/script>/);
    const outside = doc.replace(/^(`{3,})text\n[\s\S]*?\n\1$/gm, "");
    assert.doesNotMatch(outside, /evil|script|Owned/);
  } finally {
    await db.done();
  }
});

test("the save path must land inside the repository, through any symbolic link", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-export-"));
  try {
    const root = path.join(base, "repo");
    const outside = path.join(base, "outside");
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(root, "docs", "decisions.md"), "old");
    fs.symlinkSync(outside, path.join(root, "away"), "dir");
    fs.symlinkSync(path.join(root, "docs", "decisions.md"), path.join(root, "link.md"));
    assert.deepEqual(exportPath(root, "docs/decisions.md"), { relative: "docs/decisions.md", exists: true });
    assert.deepEqual(exportPath(root, "docs/new/decisions.md"), {
      relative: "docs/new/decisions.md",
      exists: false,
    });
    assert.match(
      String(Object.values(exportPath(root, path.join(root, "x.md")))),
      /relative to the repository root/,
    );
    assert.match(String(Object.values(exportPath(root, "../outside/x.md"))), /leaves the repository/);
    assert.match(String(Object.values(exportPath(root, "away/x.md"))), /leads outside the repository/);
    assert.match(String(Object.values(exportPath(root, "away/deeper/x.md"))), /leads outside the repository/);
    assert.match(String(Object.values(exportPath(root, "link.md"))), /symbolic link/);
    fs.mkdirSync(path.join(root, "docs", "folder.md"));
    assert.match(String(Object.values(exportPath(root, "docs/folder.md"))), /not a regular file/);
    assert.match(String(Object.values(exportPath(root, "docs/decisions.md/x.md"))), /not a folder/);
    // What the agent is told to write to is exactly what was checked: no character the reply would hide or change
    for (const bad of ["docs/safe\u200b.md", "docs/a\nb.md", "docs/\u001b[31mx.md", "docs/a\tb.md"])
      assert.match(
        String(Object.values(exportPath(root, bad))),
        /cannot be shown as typed/,
        JSON.stringify(bad),
      );
    assert.ok("error" in exportPath(root, "."));
    assert.deepEqual(exportPath(root, "..notes.md"), { relative: "..notes.md", exists: false });
    // Files hosts load as instructions are never an export target: quoted words would become standing instructions
    for (const rule of [
      "CLAUDE.md",
      "claude.md",
      "AGENTS.md",
      "sub/AGENTS.override.md",
      ".claude/rules/x.md",
      ".claude/skills/a/SKILL.md",
      ".agents/skills/a/SKILL.md",
      ".codex/x.md",
      ".Claude/rules/x.md",
      ".cursor/rules/x.md",
      ".github/copilot-instructions.md",
      ".GitHub/Copilot-Instructions.md",
    ])
      assert.match(String(Object.values(exportPath(root, rule))), /instructions/, rule);
    // Only a Markdown file of the working tree, and no name Windows would silently shorten
    for (const odd of [
      ".git/config",
      ".git/x.md",
      "src/index.ts",
      "notes",
      "AGENTS.md.",
      "CLAUDE.md ",
      "docs./x.md",
      "docs /x.md",
    ])
      assert.ok("error" in exportPath(root, odd), odd);
    fs.linkSync(path.join(outside, "..", "repo", "docs", "decisions.md"), path.join(root, "hard.md"));
    assert.match(String(Object.values(exportPath(root, "hard.md"))), /more than one name/);
    fs.symlinkSync(path.join(root, "docs", "decisions.md"), path.join(root, "filelink"));
    assert.match(String(Object.values(exportPath(root, "filelink/new.md"))), /not a folder/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the reply is one line saying where to write, then the document and nothing else", () => {
  const doc = "# Decisions exported from Sphica\n\nbody\n";
  const reply = exportReply({ relative: "docs/decisions.md", exists: false }, doc);
  const [first, ...rest] = reply.split("\n");
  assert.match(first ?? "", /^Write to docs\/decisions\.md, a new file\. /);
  assert.equal(rest.join("\n"), doc);
  assert.match(
    exportReply({ relative: "d.md", exists: true }, doc),
    /^Write to d\.md, replacing an existing file/,
  );
});
