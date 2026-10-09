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
    const reads = mock.method(fs, "openSync");
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
    const realOpen = fs.openSync;
    let opens = 0;
    const churn = mock.method(fs, "openSync", (p: fs.PathLike, ...rest: unknown[]) => {
      const out = (realOpen as (...a: unknown[]) => number)(p, ...rest);
      if (String(p).endsWith("a.ts")) {
        opens++;
        fs.writeFileSync(path.join(root, "a.ts"), `${Math.random()}\n`);
      }
      return out;
    });
    try {
      const s = takeStates(root, ["a.ts"], new Map(), FAR());
      assert.deepEqual(s["a.ts"], { kind: "unknown", reason: "changed while read" });
      assert.equal(opens, 3, "read three times before giving up");
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

test("reads stay inside the checkout and within the deadline on every try, and odd names and times keep their state", () => {
  const root = checkout();
  const outside = checkout();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-home-"));
  process.env.SPHICA_HOME = home;
  try {
    fs.mkdirSync(path.join(root, "d"));
    fs.writeFileSync(path.join(root, "d", "a.ts"), "inside\n");
    fs.writeFileSync(path.join(outside, "a.ts"), "outside secret\n");
    // The first read finds the file changed and the directory swapped for a link out of the checkout: the retry must not follow it
    const realOpen = fs.openSync;
    let swapped = false;
    const swap = mock.method(fs, "openSync", (p: fs.PathLike, ...rest: unknown[]) => {
      const out = (realOpen as (...a: unknown[]) => number)(p, ...rest);
      if (!swapped && String(p).endsWith(path.join("d", "a.ts"))) {
        swapped = true;
        fs.rmSync(path.join(root, "d"), { recursive: true });
        fs.symlinkSync(outside, path.join(root, "d"), process.platform === "win32" ? "junction" : "dir");
      }
      return out;
    });
    try {
      const st = takeStates(root, ["d/a.ts"], new Map(), FAR())["d/a.ts"];
      assert.notEqual(st?.kind, "ok", "a file reached through a link out of the checkout is never hashed");
    } finally {
      swap.mock.restore();
    }
    // A read that changes once is read again and succeeds: two reads in all
    fs.writeFileSync(path.join(root, "b.ts"), "b\n");
    let once = false;
    const reads: string[] = [];
    const flip = mock.method(fs, "openSync", (p: fs.PathLike, ...rest: unknown[]) => {
      const out = (realOpen as (...a: unknown[]) => number)(p, ...rest);
      if (String(p).endsWith("b.ts")) {
        reads.push(String(p));
        if (!once) {
          once = true;
          fs.writeFileSync(path.join(root, "b.ts"), "b2\n");
        }
      }
      return out;
    });
    try {
      assert.equal(takeStates(root, ["b.ts"], new Map(), FAR())["b.ts"]?.kind, "ok");
      assert.equal(reads.length, 2, "read again once after it changed");
    } finally {
      flip.mock.restore();
    }
    // A slow read past the deadline stops there, never three times over
    let clock = 0;
    const now = mock.method(Date, "now", () => clock);
    const realRead = fs.readSync;
    const slow = mock.method(fs, "readSync", (...a: unknown[]) => {
      clock += 4000;
      return (realRead as (...x: unknown[]) => number)(...a);
    });
    try {
      assert.deepEqual(takeStates(root, ["b.ts"], new Map(), 3500)["b.ts"], {
        kind: "unknown",
        reason: "deadline",
      });
      assert.ok(clock <= 4000, `stopped after the read that passed the deadline (clock ${clock})`);
    } finally {
      slow.mock.restore();
      now.mock.restore();
    }
    // A file that vanishes between the existence check and realpath is missing, not an error for the whole call
    const realpath = fs.realpathSync.native;
    const vanish = mock.method(fs.realpathSync, "native", (p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p).endsWith("gone.ts")) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return (realpath as (...a: unknown[]) => string)(p, ...rest);
    });
    try {
      fs.writeFileSync(path.join(root, "gone.ts"), "x");
      const s = takeStates(root, ["gone.ts", "b.ts"], new Map(), FAR());
      assert.equal(s["gone.ts"]?.kind, "missing");
      assert.equal(s["b.ts"]?.kind, "ok", "the other paths still get their state");
    } finally {
      vanish.mock.restore();
    }
    // Names that only look like a parent or a prototype are ordinary files
    fs.mkdirSync(path.join(root, "..settings"));
    fs.writeFileSync(path.join(root, "..settings", "f.ts"), "f");
    fs.writeFileSync(path.join(root, "__proto__"), "p");
    assert.ok(inside(root, "..settings/f.ts"), "a name starting with two dots is inside");
    const odd = takeStates(root, ["..settings/f.ts", "__proto__"], new Map(), FAR());
    assert.deepEqual(Object.keys(odd).sort(), ["..settings/f.ts", "__proto__"]);
    assert.equal(Object.getOwnPropertyDescriptor(odd, "__proto__")?.value?.kind, "ok");
    // A time before 1970 is a valid signature that survives the cache
    fs.writeFileSync(path.join(root, "old.ts"), "o");
    fs.utimesSync(path.join(root, "old.ts"), new Date(-86_400_000), new Date(-86_400_000));
    const cache = loadCache(root);
    takeStates(root, ["old.ts"], cache, FAR());
    saveCache(root, cache);
    assert.equal(loadCache(root).has("old.ts"), true, "a negative time is kept");
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
    writeSnapshot({ ...s, paths: true as never });
    assert.equal(
      takeSnapshot(key),
      null,
      "paths that are not a map are refused, never read as nothing changed",
    );
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
