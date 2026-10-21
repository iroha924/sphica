// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CheckFailure,
  crashFinding,
  fail,
  finding,
  formatFinding,
  report,
  ruleMessage,
  runCheck,
} from "../../scripts/lib/finding.mjs";

const parts = { where: "a.ts:3", what: "it broke", why: "the rule exists", fix: "do this instead" };

/** stderr and the exit code a call leaves, with both put back afterwards */
async function captured(run: () => unknown) {
  const lines: string[] = [];
  const error = console.error;
  const before = process.exitCode;
  console.error = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    await run();
    return { out: lines.join("\n"), code: process.exitCode };
  } finally {
    console.error = error;
    process.exitCode = before;
  }
}

test("a finding prints as one line of where, what, why, and fix", () => {
  assert.equal(formatFinding(finding(parts)), "a.ts:3: it broke. Why: the rule exists. Fix: do this instead");
  assert.equal(
    ruleMessage({ what: "it broke.", why: "the rule exists", fix: "do this instead." }),
    "it broke. Why: the rule exists. Fix: do this instead",
  );
});

test("a part left out, empty, blank, or not a string is refused, so no line can lack one", () => {
  for (const name of ["where", "what", "why", "fix"] as const) {
    for (const value of [undefined, "", "  \n ", 3]) {
      const broken = { ...parts, [name]: value } as unknown as typeof parts;
      assert.throws(() => finding(broken), new RegExp(`non-empty ${name}`), `${name} = ${String(value)}`);
    }
  }
  assert.throws(() => ruleMessage({ what: "x", why: "", fix: "y" }), /non-empty why/);
  assert.throws(() => finding({ ...parts, detail: 3 as unknown as string }), /detail is a string/);
  assert.throws(() => finding(null as unknown as typeof parts), /object of parts/);
});

test("text from outside cannot start a line or rewrite the terminal, in a part or in the detail", () => {
  const f = finding({ ...parts, what: "line one\nline two\u001b[2J\r", detail: "out\r\nmore\u0007\n" });
  const [line, ...rest] = formatFinding(f).split("\n");
  assert.equal(line, "a.ts:3: line one line two?[2J. Why: the rule exists. Fix: do this instead");
  assert.deepEqual(rest, ["    out", "    more?"]);
});

test("only a finding prints, so a string or a look-alike object cannot pass for one", () => {
  for (const fake of ["a.ts:3: it broke", { ...parts, detail: undefined }])
    assert.throws(() => formatFinding(fake as unknown as ReturnType<typeof finding>), /only a finding/);
});

test("report prints the findings and their count and fails the process, and does nothing without findings", async () => {
  const none = await captured(() => assert.equal(report("names", []), false));
  assert.deepEqual(none, { out: "", code: undefined });
  const some = await captured(() =>
    assert.equal(report("names", [finding(parts), finding({ ...parts, detail: "tool said\nno" })]), true),
  );
  assert.equal(
    some.out,
    [
      "a.ts:3: it broke. Why: the rule exists. Fix: do this instead",
      "a.ts:3: it broke. Why: the rule exists. Fix: do this instead",
      "    tool said",
      "    no",
      "names: 2 finding(s)",
    ].join("\n"),
  );
  assert.equal(some.code, 1);
});

test("runCheck reports a fail() as its finding and any other error as a crash with its stack", async () => {
  const stopped = await captured(() => runCheck("lane", () => fail(parts)));
  assert.equal(stopped.out, `${formatFinding(finding(parts))}\nlane: 1 finding(s)`);
  assert.equal(stopped.code, 1);
  const crashed = await captured(() =>
    runCheck("lane", async () => {
      await Promise.resolve();
      throw new Error("boom");
    }),
  );
  assert.match(crashed.out, /^lane: the check crashed: boom\. Why: .+\. Fix: .+\n {4}Error: boom\n/);
  assert.equal(crashed.code, 1);
  const passed = await captured(() => runCheck("lane", () => undefined));
  assert.deepEqual(passed, { out: "", code: undefined });
  const thrown = new CheckFailure(parts);
  assert.equal(crashFinding("lane", thrown), thrown.finding);
  assert.equal(crashFinding("lane", "not an error").what, "the check crashed: not an error");
});
