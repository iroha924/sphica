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
    rules: { "sphica/comment-refs": "error", "sphica/sql-style": "error" },
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
