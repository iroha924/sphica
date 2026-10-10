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
  assert.deepEqual([...(measuredFiles(report) ?? [])].sort(), [
    "src/admin.ts",
    "src/cli.ts",
    "src/cli/view.ts",
  ]);
  // The TAP reporter prefixes the same rows with a hash
  assert.deepEqual([...(measuredFiles(report.replaceAll("ℹ", "#")) ?? [])].sort(), [
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
});

test("output that does not hold exactly one report is not read", () => {
  // No report at all: a file row on its own does not count
  assert.equal(unmeasured("ℹ  admin.ts | 97.56 | 90.43 | 97.73 | ", ["src/admin.ts"], []), null);
  // A report a test printed before the real one, listing a file the real one does not
  const forged = [
    "ℹ start of coverage report",
    "ℹ src         |        |          |         | ",
    "ℹ  other      |        |          |         | ",
    "ℹ   view.ts   | 100.00 |   100.00 |  100.00 | ",
    "ℹ end of coverage report",
  ].join("\n");
  assert.equal(unmeasured(`${forged}\n${report}`, ["src/cli/view.ts", "src/other/view.ts"], []), null);
  // A line that only mentions the marker is not one, so the one real report is still read
  const mention = `# test diagnostic: start of coverage report\n#  other.ts | 100.00 | 100.00 | 100.00 |\n${report}`;
  assert.deepEqual(unmeasured(mention, ["src/cli/view.ts", "src/other.ts"], []), ["src/other.ts"]);
  // A report cut off before its end
  assert.equal(measuredFiles(report.replace("ℹ end of coverage report", "")), null);
});

test("color codes around a report do not hide it", () => {
  const colored = report.replaceAll("ℹ", "\u001b[34mℹ").replaceAll("\n", "\u001b[39m\n");
  assert.deepEqual(unmeasured(colored, ["src/admin.ts", "src/new.ts"], []), ["src/new.ts"]);
});
