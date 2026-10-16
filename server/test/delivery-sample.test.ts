// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The delivery precision sample on a real database: the population a window pins, and a database that no longer gives it.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  around,
  differences,
  digest,
  draw,
  extract,
  type Population,
  readTimeline,
} from "../evals/delivery/sample.ts";
import { at, hash, insert, project, run, session, type TempDb, tempDb } from "./temp-db.ts";

const SCRIPT = path.join(import.meta.dirname, "..", "evals", "delivery", "sample.ts");
const WINDOW = { from: at("2026-10-09T00:00:00Z"), to: at("2026-10-16T00:00:00Z") };

function unit(db: TempDb, p: number, key: string): number {
  return insert(db, "unit", {
    project_id: p,
    key,
    kind: "decision",
    stance: "do",
    text: key,
    extraction: "supported",
    run_id: run(db, p),
    created_at: at("2026-10-01T00:00:00Z"),
    content_hash: hash(key.length),
  });
}

function delivered(db: TempDb, s: string, when: string, units: number[], outcome = "emitted"): number {
  const id = insert(db, "delivery", { session_id: s, event: "pre_read", outcome, at: at(when) });
  for (const u of units) insert(db, "delivery_unit", { delivery_id: id, unit_id: u });
  return id;
}

/** Two projects, rows inside and at the edges of the window, a row that showed nothing, and two rows at one time */
function fixture(db: TempDb) {
  const p = project(db);
  const other = project(db, "git:github.com/o/other", "o/other");
  const s = session(db, p, "s1");
  const t = session(db, other, "s2");
  const [a, b, c] = [unit(db, p, "a"), unit(db, p, "b"), unit(db, other, "c")];
  const before = delivered(db, s, "2026-10-08T23:59:59.999Z", [a]);
  const first = delivered(db, s, "2026-10-09T00:00:00Z", [b, a]);
  const lowId = delivered(db, s, "2026-10-12T00:00:00Z", [b]);
  const highId = delivered(db, s, "2026-10-12T00:00:00Z", [a]);
  delivered(db, s, "2026-10-13T00:00:00Z", [], "nothing");
  delivered(db, t, "2026-10-13T00:00:00Z", [c]);
  const edge = delivered(db, s, "2026-10-16T00:00:00Z", [a]);
  return { p, a, b, before, first, lowId, highId, edge };
}

test("the population is the project's emitted pairs inside the window, ordered by time, delivery, and unit", async () => {
  const db = tempDb();
  try {
    const f = fixture(db);
    assert.deepEqual(await extract(db.reader, f.p, WINDOW), [
      [f.first, f.a],
      [f.first, f.b],
      [f.lowId, f.b],
      [f.highId, f.a],
    ]);
  } finally {
    await db.done();
  }
});

test("a pinned population matches itself and names what a database lost or gained since", async () => {
  const db = tempDb();
  try {
    const f = fixture(db);
    const pairs = await extract(db.reader, f.p, WINDOW);
    const pinned: Population = {
      project: "git:github.com/o/r",
      window: WINDOW,
      condition: "",
      extracted_at: at("2026-10-16T00:00:00Z"),
      size: pairs.length,
      sha256: digest(pairs),
      pairs,
    };
    assert.deepEqual(differences(pinned, pairs), []);
    const lost = differences(pinned, pairs.slice(1));
    assert.equal(lost.length, 1);
    assert.match(
      lost[0] ?? "",
      new RegExp(`^1 pinned pairs are no longer in the database, first ${f.first}:${f.a}$`),
    );
    assert.match(
      differences(pinned, [...pairs, [999, f.a]])[0] ?? "",
      /^1 pairs are in the database but not pinned/,
    );
    assert.deepEqual(differences(pinned, [...pairs].reverse()), [
      "the same pairs come back in another order",
    ]);
    assert.match(differences({ ...pinned, sha256: "0" }, pairs)[0] ?? "", /do not hash to the pinned sha256/);
  } finally {
    await db.done();
  }
});

test("the script pins the population once, and stops with the difference when the database no longer gives it", async () => {
  const db = tempDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-sample-"));
  try {
    const f = fixture(db);
    const population = path.join(dir, "population.json");
    const args = [
      "--db",
      db.file,
      "--project",
      "git:github.com/o/r",
      "--from",
      WINDOW.from,
      "--to",
      WINDOW.to,
      "--population",
      population,
    ];
    const go = () =>
      spawnSync(process.execPath, [SCRIPT, ...args], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: dir },
      });
    const first = go();
    assert.equal(first.status, 0, first.stderr);
    const pinned = JSON.parse(fs.readFileSync(population, "utf8")) as Population;
    assert.equal(pinned.size, 4);
    assert.equal(pinned.sha256, digest(pinned.pairs));
    const again = go();
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /4 pairs, the same as/);
    db.owner.prepare("delete from delivery where id = ?").run(f.highId);
    const changed = go();
    assert.notEqual(changed.status, 0);
    assert.match(
      changed.stderr,
      new RegExp(`1 pinned pairs are no longer in the database, first ${f.highId}:${f.a}`),
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(population, "utf8")), pinned);
  } finally {
    await db.done();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the script names the arguments a mode is missing", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--db", "x.db", "--from", WINDOW.from], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--db needs --project, --to, --population/);
});

test("a window given without milliseconds keeps the delivery at its first instant", async () => {
  const db = tempDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-sample-"));
  try {
    fixture(db);
    const population = path.join(dir, "population.json");
    const r = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "--db",
        db.file,
        "--project",
        "git:github.com/o/r",
        "--from",
        "2026-10-09T00:00:00Z",
        "--to",
        "2026-10-16T00:00:00Z",
        "--population",
        population,
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir } },
    );
    assert.equal(r.status, 0, r.stderr);
    const pinned = JSON.parse(fs.readFileSync(population, "utf8")) as Population;
    assert.equal(pinned.size, 4);
    assert.deepEqual(pinned.window, WINDOW);
    const bad = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "--db",
        db.file,
        "--project",
        "git:github.com/o/r",
        "--from",
        "yesterday",
        "--to",
        WINDOW.to,
        "--population",
        path.join(dir, "x.json"),
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir } },
    );
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /--from yesterday is not a date and time/);
  } finally {
    await db.done();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the project is picked by its key, since two hosts can give the same name", async () => {
  const db = tempDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-sample-"));
  try {
    fixture(db);
    const lab = project(db, "git:gitlab.com/o/r", "o/r");
    const s = session(db, lab, "s3");
    const u = unit(db, lab, "d");
    const only = delivered(db, s, "2026-10-10T00:00:00Z", [u]);
    const population = path.join(dir, "population.json");
    const r = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "--db",
        db.file,
        "--project",
        "git:gitlab.com/o/r",
        "--from",
        WINDOW.from,
        "--to",
        WINDOW.to,
        "--population",
        population,
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir } },
    );
    assert.equal(r.status, 0, r.stderr);
    const pinned = JSON.parse(fs.readFileSync(population, "utf8")) as Population;
    assert.deepEqual(pinned.pairs, [[only, u]]);
    assert.equal(pinned.project, "git:gitlab.com/o/r");
  } finally {
    await db.done();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const pinnedOf = (pairs: [number, number][]): Population => ({
  project: "git:github.com/o/r",
  window: WINDOW,
  condition: "",
  extracted_at: WINDOW.to,
  size: pairs.length,
  sha256: digest(pairs),
  pairs,
});

test("a draw is the seeded shuffle of the pinned pairs, the same every time for the same seed", () => {
  const pairs = Array.from({ length: 200 }, (_, i): [number, number] => [i + 1, (i % 7) + 1]);
  const p = pinnedOf(pairs);
  const a = draw(p, 20261016, 80);
  assert.equal(a.length, 80);
  assert.deepEqual(draw(p, 20261016, 80), a);
  assert.deepEqual(
    a.map((d) => d.n),
    Array.from({ length: 80 }, (_, i) => i + 1),
  );
  assert.equal(new Set(a.map((d) => `${d.delivery}:${d.unit}`)).size, 80);
  assert.notDeepEqual(draw(p, 1, 80), a);
  assert.equal(draw(pinnedOf(pairs.slice(0, 4)), 20261016, 80).length, 4);
});

const claudeLines = [
  {
    type: "user",
    timestamp: "2026-10-10T00:00:00.000Z",
    origin: { kind: "human" },
    message: { content: "fix the search ranking" },
  },
  { type: "user", timestamp: "2026-10-10T00:00:01.000Z", isMeta: true, message: { content: "meta line" } },
  {
    type: "assistant",
    timestamp: "2026-10-10T00:00:02.000Z",
    message: {
      content: [
        { type: "text", text: "Reading search.ts" },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "server/src/search.ts" } },
      ],
    },
  },
  {
    type: "user",
    timestamp: "2026-10-10T00:00:03.000Z",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "..." }] },
  },
  {
    type: "assistant",
    timestamp: "2026-10-10T00:00:04.000Z",
    message: {
      content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "server/src/search.ts" } }],
    },
  },
  {
    type: "user",
    timestamp: "2026-10-10T00:05:00.000Z",
    origin: { kind: "human" },
    message: { content: "now the tests" },
  },
];
const codexLines = [
  {
    timestamp: "2026-10-11T00:00:00.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }],
    },
  },
  {
    timestamp: "2026-10-11T00:00:01.000Z",
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Review commit abc" }] },
  },
  {
    timestamp: "2026-10-11T00:00:02.000Z",
    type: "response_item",
    payload: { type: "custom_tool_call", name: "exec", input: "git show abc" },
  },
  {
    timestamp: "2026-10-11T00:00:03.000Z",
    type: "response_item",
    payload: { type: "function_call", name: "shell", arguments: '{"cmd":"rg deliver"}' },
  },
  {
    timestamp: "2026-10-11T00:00:04.000Z",
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "No defects" }] },
  },
];
const jsonl = (lines: unknown[]) => `${lines.map((l) => JSON.stringify(l)).join("\n")}\nnot json\n`;

test("a timeline keeps prompts, calls, and replies of both hosts, and leaves out meta lines, tool results, and injected context", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-timeline-"));
  try {
    fs.writeFileSync(path.join(dir, "c.jsonl"), jsonl(claudeLines));
    fs.writeFileSync(path.join(dir, "x.jsonl"), jsonl(codexLines));
    assert.deepEqual(
      readTimeline(path.join(dir, "c.jsonl"), "claude-code").map((e) => `${e.kind} ${e.text}`),
      [
        "prompt fix the search ranking",
        "reply Reading search.ts",
        'call Read {"file_path":"server/src/search.ts"}',
        'call Edit {"file_path":"server/src/search.ts"}',
        "prompt now the tests",
      ],
    );
    assert.deepEqual(
      readTimeline(path.join(dir, "x.jsonl"), "codex").map((e) => `${e.kind} ${e.text}`),
      [
        "prompt Review commit abc",
        "call exec git show abc",
        'call shell {"cmd":"rg deliver"}',
        "reply No defects",
      ],
    );
    const a = around(readTimeline(path.join(dir, "c.jsonl"), "claude-code"), "2026-10-10T00:00:02.500Z");
    assert.equal(a.prompt?.text, "fix the search ranking");
    assert.deepEqual(
      a.before.map((e) => e.kind),
      ["reply", "call"],
    );
    assert.deepEqual(
      a.after.map((e) => e.text),
      ['Edit {"file_path":"server/src/search.ts"}'],
    );
    assert.deepEqual(around([], "2026-10-10T00:00:00.000Z"), { prompt: null, before: [], after: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the script draws the same sample twice and writes a sheet with each conversation, or says there is none", async () => {
  const db = tempDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-sample-"));
  try {
    const p = project(db);
    session(db, p, "s1");
    db.owner.prepare("update session set external_id = 'cc-1' where id = 's1'").run();
    session(db, p, "s2", "codex");
    db.owner.prepare("update session set external_id = '01ab-cd' where id = 's2'").run();
    session(db, p, "s3");
    const u = unit(db, p, "search-rank");
    insert(db, "unit_option", { unit_id: u, position: 1, text: "rank by recency", outcome: "rejected" });
    const main = delivered(db, "s1", "2026-10-10T00:00:02.500Z", [u]);
    const sub = insert(db, "delivery", {
      session_id: "s1",
      agent_id: "ag1",
      event: "pre_read",
      outcome: "emitted",
      at: at("2026-10-10T00:00:02.500Z"),
    });
    insert(db, "delivery_unit", { delivery_id: sub, unit_id: u });
    const codex = delivered(db, "s2", "2026-10-11T00:00:02.500Z", [u]);
    const none = delivered(db, "s3", "2026-10-12T00:00:00Z", [u]);
    const claude = path.join(dir, "claude");
    fs.mkdirSync(path.join(claude, "cc-1", "subagents"), { recursive: true });
    fs.writeFileSync(path.join(claude, "cc-1.jsonl"), jsonl(claudeLines));
    fs.writeFileSync(path.join(claude, "cc-1", "subagents", "agent-ag1.jsonl"), jsonl(claudeLines.slice(2)));
    const codexDir = path.join(dir, "codex", "2026", "10", "11");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, "rollout-2026-10-11T00-00-00-01ab-cd.jsonl"), jsonl(codexLines));
    const population = path.join(dir, "population.json");
    const env = { PATH: process.env.PATH, HOME: dir };
    const go = (args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
    const pinned = go([
      "--db",
      db.file,
      "--project",
      "git:github.com/o/r",
      "--from",
      WINDOW.from,
      "--to",
      WINDOW.to,
      "--population",
      population,
    ]);
    assert.equal(pinned.status, 0, pinned.stderr);
    const drawArgs = (out: string) => [
      "--sample",
      "--population",
      population,
      "--seed",
      "20261016",
      "--size",
      "80",
      "--out",
      out,
    ];
    const first = go(drawArgs(path.join(dir, "a.json")));
    const second = go(drawArgs(path.join(dir, "b.json")));
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, second.stdout);
    assert.equal(
      fs.readFileSync(path.join(dir, "a.json"), "utf8"),
      fs.readFileSync(path.join(dir, "b.json"), "utf8"),
    );
    const drawn = JSON.parse(fs.readFileSync(path.join(dir, "a.json"), "utf8")) as {
      population_sha256: string;
      pairs: unknown[];
    };
    assert.equal(drawn.pairs.length, 4);
    assert.equal(
      drawn.population_sha256,
      (JSON.parse(fs.readFileSync(population, "utf8")) as Population).sha256,
    );
    const sheetFile = path.join(dir, "sheet.md");
    const sheet = go([
      "--sheet",
      path.join(dir, "a.json"),
      "--db",
      db.file,
      "--claude",
      claude,
      "--codex",
      path.join(dir, "codex"),
      "--out",
      sheetFile,
    ]);
    assert.equal(sheet.status, 0, sheet.stderr);
    const text = fs.readFileSync(sheetFile, "utf8");
    const entry = (delivery: number) =>
      text.split(/^## /m).find((e) => e.includes(`delivery ${delivery}, unit ${u}`)) ?? "";
    assert.match(entry(main), /fix the search ranking[\s\S]*after the delivery[\s\S]*Edit/);
    assert.match(entry(main), /- rejected: rank by recency/);
    assert.match(entry(sub), /subagent ag1[\s\S]*agent-ag1\.jsonl/);
    assert.match(entry(codex), /Review commit abc[\s\S]*No defects/);
    assert.match(entry(none), /conversation: no transcript found/);
    fs.writeFileSync(
      population,
      fs.readFileSync(population, "utf8").replace(/"sha256":"[0-9a-f]+"/, '"sha256":"00"'),
    );
    const tampered = go(drawArgs(path.join(dir, "c.json")));
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /does not hash to its pinned sha256/);
  } finally {
    await db.done();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
