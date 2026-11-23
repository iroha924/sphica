// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// GitHub links an issue from a closing keyword before its number anywhere in the body, even in a sentence that says the opposite, and the
// release run closes every linked issue. The check fails on a linked issue the body does not declare on a line of its own
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { declaredClosing, undeclaredClosing } from "../../scripts/lib/pr-body.mjs";

const CLI = path.join(import.meta.dirname, "..", "..", "scripts", "check-pr-body-refs.mjs");
const run = (env: Record<string, string>) =>
  spawnSync(process.execPath, [CLI], { env: { ...process.env, ...env }, encoding: "utf8" });

test("an issue GitHub linked from a sentence lower in the body is undeclared", () => {
  const body = "Refs #394\n\n## Decisions\n\n- zod stays. So this PR does not close #394.\n";
  assert.deepEqual(undeclaredClosing(body, [394]), [394]);
});

test("every closing keyword, in any case and with a colon, declares an issue on a line of its own", () => {
  const keywords = ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"];
  const body = `${keywords.map((k, i) => `${i % 2 ? k.toUpperCase() : k}${i === 4 ? ":" : ""} #${i + 1}`).join("\n")}\n\n## What changed\n`;
  assert.deepEqual(declaredClosing(body), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(undeclaredClosing(body, [1, 2, 3, 4, 5, 6, 7, 8, 9]), []);
});

test("lines made only of references declare wherever they stand, and HTML comments declare nothing", () => {
  const body = [
    "<!--",
    "If this PR resolves an issue, put `Closes #12` on one line at the top of the body",
    "-->",
    "_Requested by the owner_",
    "Refs #3. Closes #4.",
    "<!-->",
    "Fixes #5, resolves #6",
    "",
    "## What changed",
    "",
    "Closes #7",
  ].join("\r\n");
  assert.deepEqual(declaredClosing(body), [4, 5, 6, 7]);
  assert.deepEqual(undeclaredClosing(body, [4, 5, 6, 7, 12]), [12]);
});

test("a declared issue GitHub did not link, and a body with no links, pass; a keyword inside a sentence declares nothing", () => {
  assert.deepEqual(undeclaredClosing("Closes #7\n\nDone.", []), []);
  assert.deepEqual(undeclaredClosing("No issue here.", []), []);
  assert.deepEqual(
    undeclaredClosing('Only closingRefs ignores comments that contain "Closes #12".', [12]),
    [12],
  );
});

test("the command fails on an undeclared linked issue and passes a declared one", () => {
  const bad = run({ BODY: "Refs #1\n\nThis does not close #2.", LINKED: "[2]" });
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stderr, /#2: GitHub links this issue/);
  assert.doesNotMatch(bad.stdout + bad.stderr, /does not close/);
  const good = run({ BODY: "Closes #1\n\nDone.", LINKED: "[1]" });
  assert.equal(good.status, 0, good.stdout + good.stderr);
});

test("the command fails when an input is missing or LINKED is not a list of issue numbers", () => {
  const env = { ...process.env };
  delete env.BODY;
  delete env.LINKED;
  const unset = spawnSync(process.execPath, [CLI], { env: { ...env, LINKED: "[]" }, encoding: "utf8" });
  assert.equal(unset.status, 1, unset.stdout + unset.stderr);
  for (const LINKED of ["", "nope", "{}", '["1"]', "[0]", "[1.5]"]) {
    const r = spawnSync(process.execPath, [CLI], {
      env: { ...env, BODY: "Done.", LINKED },
      encoding: "utf8",
    });
    assert.equal(r.status, 1, `${LINKED}: ${r.stdout}${r.stderr}`);
  }
});
