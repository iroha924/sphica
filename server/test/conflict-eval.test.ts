// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The offline conflict evaluation's candidate methods against real SQLite: what aliases and narrowed search add to exact naming, which
// records the search limit cut, and that the copy of the prompt delivery's fitting shows what the hook itself shows.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { candidates, corpus, cutByLimit, display, look, type Method } from "../evals/conflict/methods.ts";
import { inTransaction } from "../src/db.ts";
import { deliver } from "../src/deliver.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { searchUnits } from "../src/search.ts";
import { openRun } from "../src/trace.ts";
import { aiDecided, message, project, type TempDb, tempDb } from "./temp-db.ts";
import { ownTmpdir } from "./temp-dir.ts";

ownTmpdir("sphica-conflict-eval-tmp-");

// Run from a host's shell, these would make the prompt look like a child's, and the hook would show nothing
const ISOLATED = ["SPHICA_PARENT_SESSION", "CLAUDE_CODE_ENTRYPOINT"] as const;
const saved = Object.fromEntries(ISOLATED.map((k) => [k, process.env[k]]));
before(() => {
  for (const k of ISOLATED) delete process.env[k];
});
after(() => {
  for (const k of ISOLATED) if (saved[k] !== undefined) process.env[k] = saved[k];
});

function checkout(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-conflict-")));
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/o/r.git"], {
    stdio: "ignore",
  });
  return dir;
}

async function save(db: TempDb, p: number, units: unknown[]) {
  const t: Target = {
    projectId: p,
    origin: "trace",
    prefix: "trace:ext-s1/",
    sessionId: "s1",
    root: null,
    sources: null,
  };
  await inTransaction(db.ingest, async (trx) => {
    const run = await openRun(trx, {
      projectId: p,
      origin: "trace",
      target: "session:s1",
      sessionId: "s1",
      draftId: `d${Math.random()}`,
    });
    return saveRecord(trx, t, run, await checkRecord(trx, t, { units }), []);
  });
}

const decided = (key: string, source: number, quote: string, extra: Record<string, unknown> = {}) => ({
  key,
  kind: "decision",
  stance: "do",
  text: quote,
  evidence: [{ source: `s${source}`, quote, role: "states" }],
  adoption: [{ source: `s${source}`, quote }],
  ...extra,
});

async function within(fn: (db: TempDb, p: number, repo: string) => Promise<void>) {
  const db = tempDb();
  const repo = checkout();
  try {
    await fn(db, project(db), repo);
  } finally {
    await db.done();
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

const keys = (cs: { u: { key: string } }[]) => cs.map((x) => x.u.key.replace("trace:ext-s1/", ""));

/** The hook's own prompt delivery and the copy over B0's candidates, for the same prompt */
async function both(db: TempDb, p: number, repo: string, prompt: string) {
  const hook = await deliver(
    { hook_event_name: "UserPromptSubmit", prompt, session_id: `s-${Math.random()}`, cwd: repo },
    "claude-code",
    db.file,
  );
  const c = await corpus(db.reader, p, repo);
  return { hook, copy: display(candidates(c, await look(db.reader, c, prompt), {}), c.ai) };
}

test("the copy of the prompt fitting shows what the hook shows, on both sides of the character limit", async () => {
  const seen = new Set<number>();
  for (let size = 140; size <= 172; size += 4)
    await within(async (db, p, repo) => {
      const m = message(db, p, { id: "m1", text: "Keep it." });
      await save(
        db,
        p,
        [0, 1, 2, 3].map((n) =>
          decided(`r${n}`, m, "Keep it.", {
            text: `Rule ${n} ${"z".repeat(size)}`,
            anchors: [{ path: "src/db.ts", role: "applies_to" }],
          }),
        ),
      );
      const { hook, copy } = await both(db, p, repo, "src/db.ts を直して");
      assert.equal(copy.text, hook, `text of ${size}`);
      seen.add(copy.shown.length);
    });
  assert.deepEqual([...seen].sort(), [2, 3], "the sizes reach both sides of the limit");
});

test("the copy stops at a long first record as the hook does, and marks an AI's decision as it does", async () => {
  await within(async (db, p, repo) => {
    const long = `cache ${"w".repeat(480)}`;
    const m = message(db, p, { id: "m1", text: "Keep it." });
    await save(db, p, [
      decided("long", m, "Keep it.", {
        text: `Keep it. ${"q".repeat(240)}`,
        options: [{ text: long, outcome: "rejected" }],
      }),
      decided("short", m, "Keep it.", { anchors: [{ path: "src/db.ts", role: "applies_to" }] }),
    ]);
    const { hook, copy } = await both(db, p, repo, `${long} と src/db.ts を直して`);
    assert.equal(copy.text, hook);
    assert.equal(copy.shown.length, 1, "the long record fills the room and the next one is not tried");
    assert.match(copy.text, /1 more record applies here/);
  });
  for (const size of [100, 230])
    await within(async (db, p, repo) => {
      aiDecided(db, p, "ai-a", `I keep the pool small. ${"x".repeat(size)}`, "src/db.ts");
      aiDecided(db, p, "ai-b", `I keep the pool warm. ${"y".repeat(size)}`, "src/db.ts");
      const { hook, copy } = await both(db, p, repo, "src/db.ts を直して");
      assert.equal(copy.text, hook, `text of ${size}`);
      assert.match(copy.text, /decided by an AI/);
    });
});

test("aliases add only dont decisions and records with a rejected option, by the word boundary or by term splitting", async () => {
  await within(async (db, p, repo) => {
    const m = message(db, p, {
      id: "m1",
      text: "No automatic delivery. Keep SQLite, not Postgres. Prompts stay quiet.",
    });
    await save(db, p, [
      decided("no-auto", m, "No automatic delivery.", {
        stance: "dont",
        aliases: ["自動配信", "auto delivery"],
      }),
      decided("sqlite", m, "Keep SQLite, not Postgres.", {
        options: [
          { text: "SQLite", outcome: "chosen" },
          { text: "Postgres", outcome: "rejected" },
        ],
        aliases: ["database server"],
      }),
      decided("quiet", m, "Prompts stay quiet.", { kind: "constraint", aliases: ["自動配信"] }),
    ]);
    const c = await corpus(db.reader, p, repo);
    const at = async (prompt: string, m: Method) => keys(candidates(c, await look(db.reader, c, prompt), m));

    // Japanese written right after the alias is a letter to the boundary rule, so only term splitting finds it
    assert.deepEqual(await at("自動配信を追加して", { alias: "boundary" }), []);
    assert.deepEqual(
      await at("自動配信を追加して", { alias: "terms" }),
      ["no-auto"],
      "a record outside the pool is not added",
    );
    assert.deepEqual(await at("Add auto delivery to prompts", { alias: "boundary" }), ["no-auto"]);
    assert.deepEqual(await at("Add auto delivery to prompts", { alias: "terms" }), ["no-auto"]);
    assert.deepEqual(await at("Add auto delivery to prompts", {}), [], "B0 never counts aliases");

    const named = await look(db.reader, c, "Postgres の database server に移したい");
    const both = candidates(c, named, { alias: "terms" });
    assert.deepEqual(keys(both), ["sqlite"], "a record B0 names comes once");
    assert.equal(both[0]?.via, "named");

    const id = (key: string) => c.units.find((u) => u.key === `trace:ext-s1/${key}`)?.id ?? -1;
    const signals = async (prompt: string) =>
      [...((await look(db.reader, c, prompt)).signals.get(id("sqlite")) ?? [])].sort();
    assert.deepEqual(await signals("SQLite のまま"), ["chosen-option", "search-body"]);
    assert.deepEqual(await signals("SQLite をやめて Postgres に"), [
      "option-terms",
      "rejected-option",
      "search-body",
    ]);
    const quiet = (await look(db.reader, c, "自動配信を追加して")).signals.get(id("quiet"));
    assert.ok(
      quiet?.has("alias-terms") && !quiet.has("alias-boundary"),
      "signals are kept for records outside the pool too",
    );
  });
});

test("search adds pool records past B0's, and the records its limit cut are told apart from those it never found", async () => {
  await within(async (db, p, repo) => {
    const m = message(db, p, { id: "m1", text: "Cache eviction policy notes." });
    await save(db, p, [
      ...[0, 1, 2, 3, 4, 5].map((n) =>
        decided(`plain-${n}`, m, "Cache eviction policy notes.", { text: `Cache eviction policy ${n}` }),
      ),
      decided("no-lru", m, "Cache eviction policy notes.", {
        stance: "dont",
        text: "Do not tune cache eviction by hand",
        options: [{ text: "write-through", outcome: "rejected" }],
      }),
    ]);
    const c = await corpus(db.reader, p, repo);
    const l = await look(db.reader, c, "cache eviction policy");
    for (const k of [1, 5, 10]) {
      const alone = await searchUnits(db.reader, p, {
        question: "cache eviction policy",
        lifecycles: ["active"],
        limit: k,
      });
      assert.deepEqual(
        l.searched.slice(0, k),
        alone.hits.map((h) => h.id),
        `the first ${k} are what a search of ${k} returns`,
      );
    }
    assert.equal(l.searched.length, 7, "the six records with all three words come before the one with two");
    assert.deepEqual(keys(candidates(c, l, { search: 5 })), [], "records outside the pool are never added");
    assert.deepEqual(
      keys(
        [...cutByLimit(c, l, { search: 5 })].map((id) => ({
          u: c.units.find((u) => u.id === id) ?? { key: "" },
        })),
      ),
      ["no-lru"],
    );
    assert.deepEqual(keys(candidates(c, l, { search: 10 })), ["no-lru"]);
    assert.equal(cutByLimit(c, l, { search: 10 }).size, 0);
    assert.equal(cutByLimit(c, l, {}).size, 0, "a method without search cuts nothing");

    const named = await look(db.reader, c, "cache eviction policy を write-through にして");
    const all = candidates(c, named, { alias: "terms", search: 20 });
    assert.deepEqual(keys(all), ["no-lru"]);
    assert.equal(all[0]?.via, "named", "B0's candidate keeps its place and reason");
  });
});
