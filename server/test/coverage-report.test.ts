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
  "ℹ ----------------------------------------------",
  "ℹ all files   |  98.41 |    91.91 |   95.84 | ",
  "ℹ end of coverage report",
].join("\n");

test("the files a report measured are the ones it gives a line percentage", () => {
  assert.deepEqual([...measuredFiles(report)].sort(), ["admin.ts", "view.ts"]);
  // The TAP reporter prefixes the same rows with a hash
  assert.deepEqual([...measuredFiles(report.replaceAll("ℹ", "#"))].sort(), ["admin.ts", "view.ts"]);
});

test("a source file the report does not list is unmeasured unless it only holds types", () => {
  assert.deepEqual(unmeasured(report, ["admin.ts", "view.ts", "db-types.ts"], ["db-types.ts"]), []);
  assert.deepEqual(unmeasured(report, ["admin.ts", "view.ts", "new.ts"], ["db-types.ts"]), ["new.ts"]);
});

test("a report that measured nothing leaves every source file unmeasured", () => {
  const empty =
    "ℹ start of coverage report\nℹ all files | 100.00 | 100.00 | 100.00 | \nℹ end of coverage report";
  assert.deepEqual(unmeasured(empty, ["admin.ts", "view.ts"], []), ["admin.ts", "view.ts"]);
  // A file name outside the report does not count
  assert.deepEqual(unmeasured("ℹ  admin.ts | 97.56 | 90.43 | 97.73 | ", ["admin.ts"], []), ["admin.ts"]);
});
