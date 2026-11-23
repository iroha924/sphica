#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Pull request body check for the pr-body workflow: `BODY=<body> LINKED=<JSON array of issue numbers> node scripts/check-pr-body-refs.mjs`.
// LINKED is what GitHub reports as closingIssuesReferences. The body is untrusted, so it comes through the environment and is not printed.

import { fail, finding, guard, report } from "./lib/finding.mjs";
import { undeclaredClosing } from "./lib/pr-body.mjs";

guard("pr body");

const { BODY, LINKED } = process.env;
if (BODY === undefined || LINKED === undefined)
  fail({
    where: "environment",
    what: "BODY or LINKED is not set",
    why: "an unset input would pass every body",
    fix: "pass the pull request body as BODY and its closingIssuesReferences numbers as LINKED",
  });
let linked;
try {
  linked = JSON.parse(LINKED);
} catch {
  linked = undefined;
}
if (!Array.isArray(linked) || !linked.every((n) => Number.isInteger(n) && n > 0))
  fail({
    where: "LINKED",
    what: "not a JSON array of issue numbers",
    why: "the check compares the issues GitHub linked with the ones the body declares",
    fix: "pass the numbers as a JSON array, such as [12, 13]",
  });

const found = undeclaredClosing(BODY, linked).map((n) =>
  finding({
    where: `#${n}`,
    what: "GitHub links this issue to the pull request, but the top of the body does not declare it",
    why: "GitHub reads a closing keyword before an issue number anywhere in the body without reading the sentence, and the release run closes every linked issue",
    fix: "for an issue this closes, put `Closes` and its number alone on a line at the top; otherwise reword the line that names it so no close, fix, or resolve stands right before the number",
  }),
);
if (!report("pr body", found)) console.log("pr body: every linked issue is declared at the top");
