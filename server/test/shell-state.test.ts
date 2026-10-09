// What a shell call changed among anchored files, on real files: content changes, creation, deletion, and replacement count; metadata,
// same-content rewrites, and writes undone within the call do not; the cache, snapshots, deadline, and paths leaving the checkout.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { inTransaction } from "../src/db.ts";
import { deliverablePaths } from "../src/deliver.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import {
  compare,
  inside,
  loadCache,
  pruneSnapshots,
  SNAPSHOT_LIFE_MS,
  type Snapshot,
  saveCache,
  snapshotKey,
  takeSnapshot,
  takeStates,
  writeSnapshot,
} from "../src/shell-state.ts";
import { openRun } from "../src/trace.ts";
import { message, project, tempDb } from "./temp-db.ts";

function checkout(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-shell-state-")));
}

const FAR = () => Date.now() + 60_000;

/** The changed and unknown paths across one simulated call: states before, the call's effect, states after */
function around(root: string, rels: string[], call: () => void) {
  const cache = loadCache(root);
  const before = takeStates(root, rels, cache, FAR());
  call();
  const after = takeStates(root, rels, cache, FAR());
  saveCache(root, cache);
  return compare(before, after);
}

test("a call changes a file when its content, existence, or replacement changes, not its metadata or a write it undid", () => {
  const root = checkout();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-home-"));
  process.env.SPHICA_HOME = home;
  try {
    const f = (rel: string) => path.join(root, rel);
    fs.mkdirSync(f("src"));
    for (const rel of ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/g.ts", "src/h.ts"])
      fs.writeFileSync(f(rel), `original ${rel}\n`);
    const rels = [
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
      "src/e.ts",
      "src/g.ts",
      "src/h.ts",
      "src/new.ts",
    ];
    assert.deepEqual(around(root, rels, () => fs.writeFileSync(f("src/a.ts"), "rewritten\n")).changed, [
      "src/a.ts",
    ]);
    assert.deepEqual(
      around(root, rels, () => fs.chmodSync(f("src/b.ts"), 0o600)).changed,
      [],
      "chmod is metadata",
    );
    assert.deepEqual(
      around(root, rels, () => fs.utimesSync(f("src/b.ts"), new Date(0), new Date(0))).changed,
      [],
      "touch is metadata",
    );
    assert.deepEqual(
      around(root, rels, () => fs.writeFileSync(f("src/c.ts"), "original src/c.ts\n")).changed,
      [],
      "a same-content rewrite changes nothing",
    );
    assert.deepEqual(
      around(root, rels, () => {
        const t = fs.statSync(f("src/d.ts"));
        fs.writeFileSync(f("src/d.ts"), "ORIGINAL src/d.ts\n");
        fs.utimesSync(f("src/d.ts"), t.atime, t.mtime);
      }).changed,
      ["src/d.ts"],
      "a same-size rewrite with its time put back still changes the content",
    );
    assert.deepEqual(
      around(root, rels, () => {
        fs.writeFileSync(f("src/e.ts"), "temporary\n");
        fs.writeFileSync(f("src/e.ts"), "original src/e.ts\n");
      }).changed,
      [],
      "a write undone within the call changes nothing",
    );
    assert.deepEqual(around(root, rels, () => fs.writeFileSync(f("src/new.ts"), "x")).changed, [
      "src/new.ts",
    ]);
    assert.deepEqual(around(root, rels, () => fs.rmSync(f("src/g.ts"))).changed, ["src/g.ts"]);
    assert.deepEqual(
      around(root, rels, () => {
        fs.writeFileSync(f("src/h.tmp"), "replaced\n");
        fs.renameSync(f("src/h.tmp"), f("src/h.ts"));
      }).changed,
      ["src/h.ts"],
      "an atomic replace with new content",
    );
  } finally {
    delete process.env.SPHICA_HOME;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the cache spares unchanged files a read, a broken cache is rebuilt, and a file changing while read is retried", () => {
  const root = checkout();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-home-"));
  process.env.SPHICA_HOME = home;
  try {
    fs.writeFileSync(path.join(root, "a.ts"), "a\n");
    const cache = loadCache(root);
    takeStates(root, ["a.ts"], cache, FAR());
    saveCache(root, cache);
    const reads = mock.method(fs, "readFileSync");
    try {
      takeStates(root, ["a.ts"], loadCache(root), FAR());
      assert.equal(
        reads.mock.calls.filter((c) => String(c.arguments[0]).endsWith("a.ts")).length,
        0,
        "an unchanged signature reuses the cached hash",
      );
    } finally {
      reads.mock.restore();
    }
    const [cacheFile] = fs.readdirSync(path.join(home, "shell-state", "cache"));
    fs.writeFileSync(path.join(home, "shell-state", "cache", String(cacheFile)), "{not json");
    assert.equal(loadCache(root).size, 0, "a broken cache is an empty one");
    // The file changes on every read: after three tries it is unknown, never a hash of a half-written file
    const real = fs.readFileSync;
    const churn = mock.method(fs, "readFileSync", (p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      const out = (real as (...a: unknown[]) => Buffer)(p, ...rest);
      if (String(p).endsWith("a.ts")) fs.writeFileSync(path.join(root, "a.ts"), `${Math.random()}\n`);
      return out;
    });
    try {
      const s = takeStates(root, ["a.ts"], new Map(), FAR());
      assert.deepEqual(s["a.ts"], { kind: "unknown", reason: "changed while read" });
    } finally {
      churn.mock.restore();
    }
    assert.deepEqual(takeStates(root, ["a.ts"], new Map(), Date.now() - 1)["a.ts"], {
      kind: "unknown",
      reason: "deadline",
    });
  } finally {
    delete process.env.SPHICA_HOME;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a path that is not a regular file, or leaves the checkout, is not compared; either side unknown leaves it unknown", () => {
  const root = checkout();
  const outside = checkout();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-home-"));
  process.env.SPHICA_HOME = home;
  try {
    fs.mkdirSync(path.join(root, "dir"));
    fs.writeFileSync(path.join(outside, "secret.ts"), "s");
    fs.symlinkSync(outside, path.join(root, "out"), process.platform === "win32" ? "junction" : "dir");
    assert.equal(
      inside(root, "out/secret.ts"),
      null,
      "a link pointing out of the checkout is never followed",
    );
    assert.equal(inside(root, "out/missing.ts"), null, "nor is a missing file under such a link");
    assert.equal(inside(root, "../x.ts"), null);
    const s = takeStates(root, ["dir", "out/secret.ts"], new Map(), FAR());
    assert.deepEqual(s.dir, { kind: "unreadable", reason: "not a regular file" });
    assert.deepEqual(s["out/secret.ts"], { kind: "unreadable", reason: "outside the checkout" });
    assert.deepEqual(
      compare(
        { a: { kind: "missing" }, b: { kind: "unknown", reason: "deadline" } },
        { a: { kind: "missing" } },
      ),
      { changed: [], unknown: ["b"] },
    );
  } finally {
    delete process.env.SPHICA_HOME;
    for (const d of [root, outside, home]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("a snapshot is taken once, checked as it is read, and removed when it outlives its call", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-home-"));
  process.env.SPHICA_HOME = home;
  try {
    const key = snapshotKey("claude-code", "/r", "s", null, "toolu_1");
    assert.notEqual(
      key,
      snapshotKey("claude-code", "/r", "s", "agent", "toolu_1"),
      "a subagent's call is its own",
    );
    assert.match(key, /^[0-9a-f]{64}$/, "the file name never carries a host-given id");
    const s: Snapshot = {
      v: 1,
      key,
      at: new Date().toISOString(),
      root: "/r",
      paths: { "a.ts": { kind: "missing" } },
    };
    writeSnapshot(s);
    assert.deepEqual(takeSnapshot(key), s);
    assert.equal(takeSnapshot(key), null, "taken once");
    writeSnapshot({ ...s, paths: { "a.ts": { kind: "ok", sig: { dev: "x" }, hash: "h" } as never } });
    assert.equal(takeSnapshot(key), null, "a snapshot that does not hold together is refused");
    writeSnapshot(s);
    const file = path.join(home, "shell-state", "calls", `${key}.json`);
    const old = new Date(Date.now() - SNAPSHOT_LIFE_MS - 1000);
    fs.utimesSync(file, old, old);
    assert.equal(pruneSnapshots(), 1);
    assert.equal(takeSnapshot(key), null);
  } finally {
    delete process.env.SPHICA_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the watched paths are the applies_to paths of deliverable decisions and constraints", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "Keep utc. Dates are tricky." });
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
        draftId: "d",
      });
      const record = {
        units: [
          {
            key: "utc",
            kind: "constraint",
            stance: "do",
            text: "Keep utc.",
            evidence: [{ source: `s${m}`, quote: "Keep utc.", role: "states" }],
            adoption: [{ source: `s${m}`, quote: "Keep utc." }],
            anchors: [
              { path: "src/dates.ts", role: "applies_to" },
              { path: "src/dates.ts", symbol: "toStored", role: "applies_to" },
            ],
          },
          {
            key: "tricky",
            kind: "finding",
            text: "Dates are tricky.",
            evidence: [{ source: `s${m}`, quote: "Dates are tricky.", role: "states" }],
            anchors: [{ path: "src/finding.ts", role: "applies_to" }],
          },
        ],
      };
      return saveRecord(trx, t, run, await checkRecord(trx, t, record), []);
    });
    assert.deepEqual(
      await deliverablePaths(db.reader, p),
      ["src/dates.ts"],
      "once each, and never a finding's",
    );
  } finally {
    await db.done();
  }
});
