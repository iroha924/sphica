// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

import "./isolate-home.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import url from "node:url";
import {
  CheckFailure,
  crashFinding,
  finding,
  formatFinding,
  report,
  ruleMessage,
} from "../../scripts/lib/finding.mjs";
import { assertFindings } from "./finding-shape.ts";
import { tempDir } from "./temp-dir.ts";

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
  // Unicode's line and paragraph separators break a line in some renderers, so they start an indented line too
  const forged = finding({
    ...parts,
    what: "a\u2028b",
    detail: "safe\u2028forged.ts: x. Why: y. Fix: z\u2029end",
  });
  assert.deepEqual(formatFinding(forged).split("\n").slice(1), [
    "    safe",
    "    forged.ts: x. Why: y. Fix: z",
    "    end",
  ]);
  assert.equal(forged.what, "a b");
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

/** A check script of the given body run as a child, with guard() and the helpers imported first */
function script(body: string) {
  const dir = tempDir("sphica-guard-");
  const file = path.join(dir, "check-x.mjs");
  const helper = url.pathToFileURL(
    path.join(import.meta.dirname, "..", "..", "scripts", "lib", "finding.mjs"),
  ).href;
  fs.writeFileSync(
    file,
    `import { fail, finding, guard, report } from ${JSON.stringify(helper)};\n${body}\n`,
  );
  const r = spawnSync(process.execPath, [file], { encoding: "utf8" });
  return { status: r.status, err: r.stderr, out: r.stdout };
}

test("guard() turns whatever the check does not catch into a finding, before and after an await, and fails the process", () => {
  const stopped = script(`guard("lane");\nfail(${JSON.stringify(parts)});`);
  assert.deepEqual(stopped, {
    status: 1,
    err: `${formatFinding(finding(parts))}\nlane: 1 finding(s)\n`,
    out: "",
  });
  // Argument parsing right after guard() is covered too
  const parsed = script(
    'guard("lane");\nimport("node:util").then((u) => u.parseArgs({ options: { base: { type: "string" } }, args: ["--base"] }));',
  );
  assert.equal(parsed.status, 1);
  assert.match(
    parsed.err,
    /^lane: the check crashed: Option '--base <value>' argument missing\. Why: .+\. Fix: .+\n {4}\S/,
  );
  const late = script('guard("lane");\nawait Promise.resolve();\nthrow new Error("boom");');
  assert.equal(late.status, 1);
  assert.match(late.err, /^lane: the check crashed: boom\. Why: .+\. Fix: .+\n {4}Error: boom\n/);
  assertFindings(late.err, "guard");
  assert.deepEqual(script('guard("lane");\nconsole.log("passed");'), { status: 0, err: "", out: "passed\n" });
});

test("guard() prints the findings collected before a crash, and the last call names the check", () => {
  const r = script(
    `const found = [];\nguard("first", () => found);\nguard("lane", () => found);\nfound.push(finding(${JSON.stringify(parts)}));\nthrow new Error("boom");`,
  );
  assert.equal(r.status, 1);
  const lines = r.err.split("\n");
  assert.equal(lines[0], formatFinding(finding(parts)));
  assert.match(lines[1] ?? "", /^lane: the check crashed: boom\./);
  assert.match(r.err, /\nlane: 2 finding\(s\)\n$/);
  assert.doesNotMatch(r.err, /first/);
  const thrown = new CheckFailure(parts);
  assert.equal(crashFinding("lane", thrown), thrown.finding);
  assert.equal(crashFinding("lane", "not an error").what, "the check crashed: not an error");
});
