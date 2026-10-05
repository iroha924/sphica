import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { replaceFile, withFileLock } from "../src/file-lock.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sphica-lock-"));

/** A pid that has exited: a child that ran and finished */
const deadPid = (): number => {
  const r = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(r.pid);
  return r.pid;
};

test("the lock is held while fn runs and removed after, also when fn throws", () => {
  const lock = path.join(tmp(), "x.lock");
  const got = withFileLock(lock, () => {
    assert.equal(fs.readFileSync(lock, "utf8"), String(process.pid));
    return 7;
  });
  assert.equal(got, 7);
  assert.equal(fs.existsSync(lock), false);
  assert.throws(() => withFileLock(lock, () => assert.fail("boom")), /boom/);
  assert.equal(fs.existsSync(lock), false);
});

test("a waiter takes the lock once its holder releases it", async () => {
  const dir = tmp();
  const lock = path.join(dir, "x.lock");
  const ready = path.join(dir, "ready");
  // The holder takes the lock, says so, and releases it after 300 ms
  const holder = spawn(process.execPath, [
    "-e",
    `const fs=require("fs");fs.writeFileSync(${JSON.stringify(lock)},String(process.pid),{flag:"wx"});fs.writeFileSync(${JSON.stringify(ready)},"");setTimeout(()=>fs.rmSync(${JSON.stringify(lock)}),300);`,
  ]);
  const exited = new Promise((resolve) => holder.on("exit", resolve));
  const until = Date.now() + 10_000;
  while (!fs.existsSync(ready)) {
    assert.ok(Date.now() < until, "the holder never took the lock");
    await new Promise((r) => setTimeout(r, 10));
  }
  const start = performance.now();
  assert.equal(
    withFileLock(lock, () => "ran"),
    "ran",
  );
  assert.ok(performance.now() - start >= 100, "fn ran while the holder still had the lock");
  await exited;
});

test("a lock held by a running process is never taken over; the timeout names the file and the pid", () => {
  const lock = path.join(tmp(), "x.lock");
  fs.writeFileSync(lock, String(process.ppid));
  let ran = false;
  assert.throws(
    () =>
      withFileLock(
        lock,
        () => {
          ran = true;
        },
        200,
      ),
    (e: Error) =>
      e.message.includes(lock) &&
      e.message.includes(`process ${process.ppid}`) &&
      !e.message.includes("not running"),
  );
  assert.equal(ran, false);
  assert.equal(fs.readFileSync(lock, "utf8"), String(process.ppid));
});

test("a lock whose holder is gone is not taken over either; the timeout says to delete it", () => {
  const lock = path.join(tmp(), "x.lock");
  const pid = deadPid();
  fs.writeFileSync(lock, String(pid));
  assert.throws(
    () => withFileLock(lock, () => assert.fail("ran"), 200),
    (e: Error) =>
      e.message.includes(`process ${pid}, which is not running`) && e.message.includes(`delete ${lock}`),
  );
  assert.equal(fs.readFileSync(lock, "utf8"), String(pid));
});

test("a lock created but with no pid written yet is treated as held", () => {
  const lock = path.join(tmp(), "x.lock");
  fs.writeFileSync(lock, "");
  assert.throws(() => withFileLock(lock, () => assert.fail("ran"), 200), /held by another process/);
  assert.equal(fs.existsSync(lock), true);
});

test("the holder removes only a lock that still holds its own pid", () => {
  const lock = path.join(tmp(), "x.lock");
  withFileLock(lock, () => {
    // Someone deleted the lock by hand and another process took it
    fs.writeFileSync(lock, String(process.ppid));
  });
  assert.equal(fs.readFileSync(lock, "utf8"), String(process.ppid));
});

test("replaceFile replaces an existing file and leaves no temporary file", () => {
  const dir = tmp();
  const file = path.join(dir, "t.json");
  fs.writeFileSync(file, "old");
  replaceFile(file, "new");
  assert.equal(fs.readFileSync(file, "utf8"), "new");
  assert.deepEqual(fs.readdirSync(dir), ["t.json"]);
});

test("replaceFile retries a rename Windows refuses while the file is open, then succeeds", (t) => {
  const dir = tmp();
  const file = path.join(dir, "t.json");
  fs.writeFileSync(file, "old");
  const rename = fs.renameSync;
  let calls = 0;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (++calls <= 2) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    rename(from, to);
  });
  replaceFile(file, "new");
  t.mock.restoreAll();
  assert.equal(calls, 3);
  assert.equal(fs.readFileSync(file, "utf8"), "new");
  assert.deepEqual(fs.readdirSync(dir), ["t.json"]);
});

test("a failed replace keeps the old file whole and removes the temporary file", (t) => {
  const dir = tmp();
  const file = path.join(dir, "t.json");
  fs.writeFileSync(file, "old");
  t.mock.method(fs, "renameSync", () => {
    throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
  });
  assert.throws(() => replaceFile(file, "new"), /cross-device/);
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(file, "utf8"), "old");
  assert.deepEqual(fs.readdirSync(dir), ["t.json"]);
});
