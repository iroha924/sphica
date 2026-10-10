// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The hidden test runner's fences: Node's permission flags, and on macOS the OS sandbox that holds where Node's does not. Each check tries the
// way out for real and expects it refused, so a weaker profile fails here rather than in an evaluation.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  hiddenEnv,
  hiddenNodeArgs,
  hiddenProfile,
  NO_PARTS,
  runHiddenTest,
} from "../evals/cloud/hidden-test.ts";

test("the runner passes each Node permission as its own flag and gives the test nothing but its paths", () => {
  assert.deepEqual(hiddenNodeArgs("/c", "/s"), [
    "--permission",
    "--allow-fs-read=/c",
    "--allow-fs-read=/s",
    "--allow-fs-write=/s",
    "--test",
    "--test-isolation=none",
    "test/hidden.test.ts",
  ]);
  assert.deepEqual(hiddenEnv("/c", "/s"), { PATH: "/usr/bin:/bin", HOME: "/c", HIDDEN_SCRATCH: "/s" });
  const profile = hiddenProfile("/c", "/s", "/n/bin/node");
  // Node itself is read as its binary alone, never its install directory (a .pkg Node's would be all of /usr/local)
  assert.ok(profile.includes('(literal "/n/bin/node")'));
  assert.doesNotMatch(profile, /subpath "\/n(\/bin)?"/);
  for (const rule of [
    "(deny network*)",
    "(deny file-write*)",
    '(allow file-write* (subpath "/s") (literal "/dev/null"))',
    "(deny file-read-data)",
    '(deny file-read-data (subpath "/System/Volumes/Data"))',
  ])
    assert.ok(profile.includes(rule), rule);
  assert.doesNotMatch(profile, /allow file-write\*[^)]*"\/c"/, "the checkout is never writable");
});

/** A checkout holding nothing but the hidden test, and a directory beside the scratch that a run must not reach */
function fixture(t: { after: (fn: () => void) => void }) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-runner-")));
  const sibling = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-hidden-")));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(sibling, { recursive: true, force: true });
  });
  const work = path.join(base, "work");
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(sibling, "secret.txt"), "sibling-secret");
  const db = new DatabaseSync(path.join(sibling, "other.db"));
  db.exec("create table t (x text); insert into t values ('sibling-secret')");
  db.close();
  return { work, sibling };
}

test("on macOS the sandbox lets the test write its scratch and refuses every way out; elsewhere the run is recorded as not run", async (t) => {
  const { work, sibling } = fixture(t);
  // A listener the run is asked to reach: the OS must refuse the connection, so it never sees one
  let connections = 0;
  const server = net.createServer((c) => {
    connections++;
    c.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = (server.address() as net.AddressInfo).port;
  const source = `import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
const scratch = process.env.HIDDEN_SCRATCH ?? "";
const sibling = ${JSON.stringify(sibling)};
const refused = (fn) => {
  try {
    fn();
  } catch {
    return true;
  }
  return false;
};
test("completion: files and databases in the scratch work", () => {
  fs.writeFileSync(path.join(scratch, "a.json"), "[1]");
  assert.equal(fs.readFileSync(path.join(scratch, "a.json"), "utf8"), "[1]");
  const db = new DatabaseSync(path.join(scratch, "own.db"));
  db.exec("create table t (x)");
  db.close();
});
test("completion: the checkout is not writable", () => {
  assert.ok(refused(() => fs.writeFileSync("written.txt", "x")));
  assert.ok(refused(() => new DatabaseSync("written.db").exec("create table t (x)")));
});
test("completion: the directory beside the scratch is neither readable nor writable", () => {
  assert.ok(refused(() => fs.readFileSync(path.join(sibling, "secret.txt"), "utf8")));
  assert.ok(refused(() => new DatabaseSync(path.join(sibling, "other.db")).prepare("select x from t").all()));
  assert.ok(refused(() => new DatabaseSync(path.join(sibling, "made.db")).exec("create table t (x)")));
});
test("completion: a link in the scratch leads nowhere outside it", () => {
  const link = path.join(scratch, "out");
  // Making the link is refused today; were it allowed, going through it must still be
  const made = !refused(() => fs.symlinkSync(sibling, link));
  assert.ok(
    !made ||
      (refused(() => new DatabaseSync(path.join(link, "through.db")).exec("create table t (x)")) &&
        refused(() => fs.readFileSync(path.join(link, "secret.txt"), "utf8"))),
  );
});
test("completion: the network is closed by the OS", async () => {
  const e = await fetch("http://127.0.0.1:" + process.env.PROBE_PORT + "/", { signal: AbortSignal.timeout(5000) }).then(
    () => null,
    (x) => x,
  );
  assert.equal(e?.cause?.code, "EPERM");
});
`;
  const r = runHiddenTest(
    work,
    source.replace("process.env.PROBE_PORT", JSON.stringify(String(port))),
    60_000,
  );
  if (process.platform === "darwin") {
    assert.equal(r.tests, "5 passed, 0 failed", JSON.stringify(r));
    assert.equal(r.parts.completion, "pass");
    for (const made of ["written.txt", "written.db"])
      assert.equal(fs.existsSync(path.join(work, made)), false, made);
    assert.deepEqual(fs.readdirSync(sibling).sort(), ["other.db", "secret.txt"]);
    assert.ok(r.scratch && !fs.existsSync(r.scratch), "the scratch is removed after the run");
    // A connection the kernel accepted while this process was blocked surfaces now
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(connections, 0);
  } else {
    assert.match(r.tests, /^not run to the end/);
    assert.deepEqual(r.parts, NO_PARTS);
  }
});

test("a test that ignores the polite stop is killed at the limit, its parts unknown and its scratch removed", (t) => {
  const { work } = fixture(t);
  const source = `import { test } from "node:test";
process.on("SIGTERM", () => {});
test("completion: never ends", async () => {
  await new Promise(() => setInterval(() => {}, 1000));
});
`;
  const started = Date.now();
  const r = runHiddenTest(work, source, 3_000);
  const took = Date.now() - started;
  assert.deepEqual(r.parts, NO_PARTS);
  if (process.platform === "darwin") {
    // The limit itself ended it: the run lasted the limit, and the error is the time-out, not an early death
    assert.match(r.tests, /^not run to the end \(.*ETIMEDOUT/);
    assert.ok(took >= 3_000 && took < 30_000, `${took} ms`);
    assert.ok(r.scratch && !fs.existsSync(r.scratch));
  } else assert.match(r.tests, /^not run to the end/);
});

test("a scratch that would overlap the checkout is never used", (t) => {
  const { work } = fixture(t);
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = work;
  try {
    const r = runHiddenTest(work, 'import { test } from "node:test";\ntest("completion: x", () => {});\n');
    assert.equal(r.tests, "not run (the scratch directory and the checkout overlap)");
    assert.deepEqual(r.parts, NO_PARTS);
    assert.ok(r.scratch && !fs.existsSync(r.scratch));
    // The hidden test is not left in the checkout either, where a later run reading old runs could find it
    assert.ok(!fs.existsSync(path.join(work, "test", "hidden.test.ts")));
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
});

test("a test that locks its own scratch still gets its result back, and the scratch is removed", (t) => {
  const { work } = fixture(t);
  const source = `import fs from "node:fs";
import { test } from "node:test";
test("completion: locks the scratch", () => {
  fs.mkdirSync(process.env.HIDDEN_SCRATCH + "/inner");
  fs.chmodSync(process.env.HIDDEN_SCRATCH + "/inner", 0o000);
  fs.chmodSync(process.env.HIDDEN_SCRATCH ?? "", 0o000);
});
`;
  const r = runHiddenTest(work, source, 60_000);
  if (process.platform === "darwin") {
    assert.equal(r.tests, "1 passed, 0 failed");
    assert.ok(r.scratch && !fs.existsSync(r.scratch));
  } else assert.match(r.tests, /^not run to the end/);
});

test("a checkout that is a link is never written into", (t) => {
  const { work } = fixture(t);
  const link = path.join(path.dirname(work), "work-link");
  fs.symlinkSync(work, link);
  t.after(() => fs.rmSync(link, { force: true }));
  const r = runHiddenTest(link, 'import { test } from "node:test";\ntest("completion: x", () => {});\n');
  assert.equal(r.tests, "0 passed, 1 failed (the checkout is a link)");
  assert.ok(!fs.existsSync(path.join(work, "test", "hidden.test.ts")));
});

test("the hidden test is removed from the checkout even when its scratch directory cannot be made", (t) => {
  const { work } = fixture(t);
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = path.join(work, "no-such-dir", "tmp");
  try {
    assert.throws(() =>
      runHiddenTest(work, 'import { test } from "node:test";\ntest("completion: x", () => {});\n'),
    );
    assert.ok(!fs.existsSync(path.join(work, "test", "hidden.test.ts")));
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
});
