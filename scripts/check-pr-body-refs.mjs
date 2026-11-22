#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Pull request body check for the pr-body workflow: `BODY=<body> node scripts/check-pr-body-refs.mjs`.
// The body is untrusted, so it comes through the environment and only the matched keyword and reference are printed.

import { finding, guard, report } from "./lib/finding.mjs";
import { strayClosingRefs } from "./lib/pr-body.mjs";

guard("pr body");

const found = strayClosingRefs(process.env.BODY ?? "").map(({ line, text }) =>
  finding({
    where: `line ${line}`,
    what: `${text} links that issue to this pull request`,
    why: "GitHub reads a closing keyword before an issue reference without reading the sentence, and the release run closes every linked issue",
    fix: "put the keyword and the reference alone on a line at the top for an issue this closes; elsewhere name the issue without the keyword (Refs, or say it stays open)",
  }),
);
if (!report("pr body", found)) console.log("pr body: no closing keyword outside its own line");
