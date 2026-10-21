// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The repository's own Oxlint rules (scripts/lint-plugin.mjs) run by the pinned Oxlint on files in a temp tree
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import plugin from "../../scripts/lint-plugin.mjs";
import { tempDir } from "./temp-dir.ts";

const REPO = path.join(import.meta.dirname, "..", "..");
const OXLINT = path.join(
  path.dirname(createRequire(import.meta.url).resolve("oxlint/package.json")),
  "bin",
  "oxlint",
);

/** Built from parts, so this file does not hold the forms the rules look for */
const REPLACING = ["insert or ", "re", "place into t"].join("");
const ORDER_IN_STRING = [".order", 'By("x desc")'].join("");
const ISSUE = ["issue #", "12"].join("");

/** Oxlint's findings for files written under a temp root, with only the repository's own rules on */
function lint(files: Record<string, string>) {
  const root = tempDir("sphica-lint-plugin-");
  const config = {
    plugins: [],
    jsPlugins: [path.join(REPO, "scripts", "lint-plugin.mjs")],
    categories: {},
    rules: Object.fromEntries(Object.keys(plugin.rules).map((r) => [`sphica/${r}`, "error"])),
  };
  fs.writeFileSync(path.join(root, ".oxlintrc.json"), JSON.stringify(config));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  const r = spawnSync(process.execPath, [OXLINT, "--format=unix", ...Object.keys(files)], {
    cwd: root,
    encoding: "utf8",
  });
  const found = r.stdout
    .split("\n")
    .map((l) => /^(.+?):(\d+):\d+: (.*) \[Error\/sphica\((.+?)\)\]$/.exec(l))
    .filter((m) => m !== null)
    .map((m) => [m[1], Number(m[2]), m[4], m[3]]);
  return { status: r.status, found };
}

test("comment-refs reports a comment that points at an issue, and not the same words in a string", () => {
  const { status, found } = lint({
    "server/src/a.ts": `export const a = 1;\n// see ${ISSUE} for why\nexport const b = "${ISSUE}";\n`,
  });
  assert.equal(status, 1);
  assert.deepEqual(
    found.map((f) => f.slice(0, 3)),
    [["server/src/a.ts", 2, "comment-refs"]],
  );
  assert.match(String(found[0]?.[3]), /Write the reason itself/);
});

test("sql-style reports raw connections outside the allowed files, and REPLACE and string directions anywhere it looks", () => {
  const raw = 'import { DatabaseSync } from "node:sqlite";\nexport { DatabaseSync };\n';
  const { found } = lint({
    "server/src/app.ts": `${raw}export const q = (db: any) => db${ORDER_IN_STRING};\nexport const r = "${REPLACING}";\n`,
    "server/src/sqlite.ts": raw,
    "server/test/fixture.test.ts": `${raw}export const r = "${REPLACING}";\n`,
    "server/evals/x.ts": `export const r = "${REPLACING}";\n`,
  });
  assert.deepEqual(found.map((f) => f.slice(0, 3)).sort(), [
    ["server/src/app.ts", 1, "sql-style"],
    ["server/src/app.ts", 3, "sql-style"],
    ["server/src/app.ts", 4, "sql-style"],
    ["server/test/fixture.test.ts", 3, "sql-style"],
  ]);
});

test("files that break neither rule pass", () => {
  const { status, found } = lint({
    "server/src/ok.ts": "// Kept short: the hook has five seconds\nexport const a = 1;\n",
  });
  assert.deepEqual(found, []);
  assert.equal(status, 0);
});

test("no-skipped-tests and no-focused-tests report node:test's skip and only, which the jest plugin does not see", () => {
  const { found } = lint({
    "server/test/a.test.ts": [
      'import { describe, test } from "node:test";',
      'test.skip("a", () => {});',
      'describe.only("b", () => {});',
      'test("c", () => {});',
      'test["skip"]("d", () => {});',
      "",
    ].join("\n"),
  });
  assert.deepEqual(
    found.map((f) => f.slice(0, 3)),
    [
      ["server/test/a.test.ts", 2, "no-skipped-tests"],
      ["server/test/a.test.ts", 3, "no-focused-tests"],
      ["server/test/a.test.ts", 5, "no-skipped-tests"],
    ],
  );
});

test("the repository's .oxlintrc.json loads the plugin and turns every one of its rules on", () => {
  const config = JSON.parse(fs.readFileSync(path.join(REPO, ".oxlintrc.json"), "utf8"));
  assert.deepEqual(config.jsPlugins, ["./scripts/lint-plugin.mjs"]);
  const on = { ...config.rules };
  for (const o of config.overrides ?? []) Object.assign(on, o.rules);
  for (const rule of Object.keys(plugin.rules)) assert.equal(on[`sphica/${rule}`], "error", rule);
  for (const rule of ["typescript/no-floating-promises", "typescript/no-misused-promises"])
    assert.equal([on[rule]].flat()[0], "error", rule);
});
