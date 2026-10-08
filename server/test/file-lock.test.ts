import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { replaceFile, withFileLock } from "../src/file-lock.ts";
import { tempDir } from "./temp-dir.ts";

const tmp = () => tempDir("sphica-lock-");

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

test("a waiter takes the lock once its holder releases it", async (t) => {
  const dir = tmp();
  const lock = path.join(dir, "x.lock");
  const ready = path.join(dir, "ready");
  // The holder takes the lock, says so, and releases it after 300 ms. The script is fixed text; the paths come in as arguments
  const holder = spawn(process.execPath, [
    "-e",
    'const fs=require("fs");const [lock,ready]=process.argv.slice(1);fs.writeFileSync(lock,String(process.pid),{flag:"wx"});fs.writeFileSync(ready,"");setTimeout(()=>fs.rmSync(lock),300);',
    lock,
    ready,
  ]);
  const exited = new Promise((resolve) => holder.on("exit", resolve));
  // A failed check must not leave the holder writing into a directory being removed
  t.after(async () => {
    holder.kill();
    await exited;
  });
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

test("when the pid write fails after the exclusive create, the lock is removed and the error is thrown", (t) => {
  const lock = path.join(tmp(), "x.lock");
  const write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    // Created, then the disk is full: by path the file appears empty first, by descriptor it already exists
    if (target === lock) write(lock, "", { flag: "wx" });
    if (target === lock || typeof target === "number")
      throw Object.assign(new Error("no space"), { code: "ENOSPC" });
    return (write as (...a: unknown[]) => void)(target, ...rest);
  });
  let ran = false;
  assert.throws(
    () =>
      withFileLock(lock, () => {
        ran = true;
      }),
    /no space/,
  );
  t.mock.restoreAll();
  assert.equal(ran, false);
  assert.equal(fs.existsSync(lock), false, "the lock this call created was left behind");
});

test("a remove Windows refuses for a moment is retried until the lock is gone", (t) => {
  const lock = path.join(tmp(), "x.lock");
  const rm = fs.rmSync;
  let refused = 0;
  t.mock.method(fs, "rmSync", (target: fs.PathLike, options?: fs.RmOptions) => {
    if (target === lock && refused++ < 2) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    rm(target, options);
  });
  assert.equal(
    withFileLock(lock, () => 7),
    7,
  );
  t.mock.restoreAll();
  assert.equal(fs.existsSync(lock), false);
});

test("a lock it cannot remove is reported, not left behind silently (cannot remove)", (t) => {
  const lock = path.join(tmp(), "x.lock");
  t.mock.method(fs, "rmSync", () => {
    throw Object.assign(new Error("busy"), { code: "EBUSY" });
  });
  assert.throws(
    () => withFileLock(lock, () => 7),
    (e: Error) => e.message.includes(`could not remove ${lock}`),
  );
  // An error from fn itself wins over the failed remove
  assert.throws(
    () => withFileLock(path.join(path.dirname(lock), "y.lock"), () => assert.fail("fn failed")),
    /fn failed/,
  );
  t.mock.restoreAll();
});

test("a pid write that fails, then a remove refused for a moment, still removes the lock and keeps the first error (cleanup)", (t) => {
  const lock = path.join(tmp(), "x.lock");
  const write = fs.writeFileSync;
  const rm = fs.rmSync;
  let refused = 0;
  t.mock.method(fs, "writeFileSync", (target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (typeof target === "number") throw Object.assign(new Error("no space"), { code: "ENOSPC" });
    return (write as (...a: unknown[]) => void)(target, ...rest);
  });
  t.mock.method(fs, "rmSync", (target: fs.PathLike, options?: fs.RmOptions) => {
    if (target === lock && refused++ < 1) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    rm(target, options);
  });
  assert.throws(() => withFileLock(lock, () => assert.fail("ran")), /no space/);
  t.mock.restoreAll();
  assert.equal(fs.existsSync(lock), false);
});

test("a descriptor that fails to close after the pid is written removes the lock and does not run fn (cleanup)", (t) => {
  const lock = path.join(tmp(), "x.lock");
  const close = fs.closeSync;
  let failed = false;
  t.mock.method(fs, "closeSync", (fd: number) => {
    close(fd);
    if (!failed) {
      failed = true;
      throw Object.assign(new Error("io"), { code: "EIO" });
    }
  });
  assert.throws(() => withFileLock(lock, () => assert.fail("ran")), /io/);
  t.mock.restoreAll();
  assert.equal(fs.existsSync(lock), false);
});

test("a lock it cannot read back after fn is reported, not left behind silently (cleanup)", (t) => {
  const lock = path.join(tmp(), "x.lock");
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (target === lock) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return (read as (...a: unknown[]) => unknown)(target, ...rest);
  });
  assert.throws(
    () => withFileLock(lock, () => 7),
    (e: Error) => e.message.includes(`could not remove ${lock}`),
  );
  t.mock.restoreAll();
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

// Windows answers a create with EPERM, not EEXIST, while the last holder's delete is still pending (a scanner has it open)
test("a create refused while the previous lock is being deleted is waited out, not thrown (busy create)", (t) => {
  const lock = path.join(tmp(), "x.lock");
  const open = fs.openSync;
  let refused = 0;
  t.mock.method(fs, "openSync", (target: fs.PathLike, ...rest: unknown[]) => {
    if (target === lock && refused++ < 2) throw Object.assign(new Error("delete pending"), { code: "EPERM" });
    return (open as (...a: unknown[]) => number)(target, ...rest);
  });
  assert.equal(
    withFileLock(lock, () => 7),
    7,
  );
  t.mock.restoreAll();
  assert.equal(refused, 3);
});

test("a create refused for good fails with its own error once the wait is over (busy create)", (t) => {
  const lock = path.join(tmp(), "x.lock");
  t.mock.method(fs, "openSync", () => {
    throw Object.assign(new Error("access denied"), { code: "EACCES" });
  });
  assert.throws(() => withFileLock(lock, () => assert.fail("ran"), 200), /access denied/);
  t.mock.restoreAll();
});

test("a failed replace whose cleanup is refused for a moment still removes the temporary file and keeps the first error (busy cleanup)", (t) => {
  const dir = tmp();
  const file = path.join(dir, "t.json");
  fs.writeFileSync(file, "old");
  const rm = fs.rmSync;
  let refused = 0;
  t.mock.method(fs, "renameSync", () => {
    throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
  });
  t.mock.method(fs, "rmSync", (target: fs.PathLike, options?: fs.RmOptions) => {
    if (String(target).endsWith(".tmp") && refused++ < 1)
      throw Object.assign(new Error("busy"), { code: "EBUSY" });
    rm(target, options);
  });
  assert.throws(() => replaceFile(file, "new"), /cross-device/);
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(file, "utf8"), "old");
  assert.deepEqual(fs.readdirSync(dir), ["t.json"]);
});
