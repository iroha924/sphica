// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { measuredFiles, unmeasured } from "../../scripts/lib/coverage-report.mjs";

const report = [
  "ℹ tests 3",
  "ℹ start of coverage report",
  "ℹ ----------------------------------------------",
  "ℹ file        | line % | branch % | funcs % | uncovered lines",
  "ℹ ----------------------------------------------",
  "ℹ src         |        |          |         | ",
  "ℹ  admin.ts   |  97.56 |    90.43 |   97.73 | 12-14",
  "ℹ  cli        |        |          |         | ",
  "ℹ   view.ts   | 100.00 |   100.00 |  100.00 | ",
  "ℹ  cli.ts     |  97.48 |    73.53 |   81.03 | ",
  "ℹ ----------------------------------------------",
  "ℹ all files   |  98.41 |    91.91 |   95.84 | ",
  "ℹ end of coverage report",
].join("\n");

test("the files a report measured are the ones it gives a line percentage, with their directories", () => {
  assert.deepEqual([...measuredFiles(report)].sort(), ["src/admin.ts", "src/cli.ts", "src/cli/view.ts"]);
  // The TAP reporter prefixes the same rows with a hash
  assert.deepEqual([...measuredFiles(report.replaceAll("ℹ", "#"))].sort(), [
    "src/admin.ts",
    "src/cli.ts",
    "src/cli/view.ts",
  ]);
});

test("a source file the report does not list is unmeasured unless it only holds types", () => {
  const src = ["src/admin.ts", "src/cli.ts", "src/cli/view.ts"];
  assert.deepEqual(unmeasured(report, [...src, "src/db-types.ts"], ["src/db-types.ts"]), []);
  assert.deepEqual(unmeasured(report, [...src, "src/new.ts"], ["src/db-types.ts"]), ["src/new.ts"]);
});

test("a file of the same name in another directory does not count as measured", () => {
  assert.deepEqual(unmeasured(report, ["src/cli/view.ts", "src/other/view.ts"], []), ["src/other/view.ts"]);
  assert.deepEqual(unmeasured(report, ["src/view.ts"], []), ["src/view.ts"]);
});

test("a report that measured nothing leaves every source file unmeasured", () => {
  const empty =
    "ℹ start of coverage report\nℹ all files | 100.00 | 100.00 | 100.00 | \nℹ end of coverage report";
  assert.deepEqual(unmeasured(empty, ["src/admin.ts"], []), ["src/admin.ts"]);
  // A file row outside the report does not count
  assert.deepEqual(unmeasured("ℹ  admin.ts | 97.56 | 90.43 | 97.73 | ", ["src/admin.ts"], []), [
    "src/admin.ts",
  ]);
});
