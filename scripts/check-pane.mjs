#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Checks the sphica-pane mod as it ships: the files git tracks under pane/, copied outside the repository, go through the pinned Claude
// Code CLI's plugin validate --strict and plugin test there. A mod runs with Claude Code's permissions, so the hooks, the calls on $, and
// the state validate reports must match the lists below exactly: a new event, call, or state key fails here until it is added on purpose.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runClaude } from "./claude-cli.mjs";
import { fail, finding, guard, report } from "./lib/finding.mjs";
import { differences, reported } from "./lib/pane-report.mjs";

guard("pane", () => findings);
const findings = [];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WHY = "the pane mod runs with Claude Code's permissions, so it may do only what was reviewed";
const SHIPS =
  "users install pane/ as it is at the release tag, so a mod that fails here breaks in their Claude Code";

/** Copies the files git tracks under pane/ into dir, as the marketplace's git-subdir source fetches them */
function copyShipped(dir) {
  const files = execFileSync("git", ["ls-files", "-z", "--", "pane"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  if (!files.includes("pane/hooks/register.tsx"))
    fail({
      where: "pane/",
      what: "git tracks no pane/hooks/register.tsx",
      why: WHY,
      fix: "add the mod's files to git",
    });
  for (const file of files) {
    const to = path.join(dir, path.relative("pane", file));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(root, file), to);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-pane-"));
  try {
    copyShipped(dir);
    const validate = runClaude(["plugin", "validate", "--strict", "--json", dir]);
    let parsed;
    try {
      parsed = JSON.parse(validate.stdout);
    } catch {
      fail({
        where: "claude plugin validate --json",
        what: "its output is not JSON",
        why: SHIPS,
        fix: "read the output below",
        detail: `${validate.stdout}\n${validate.stderr}`,
      });
    }
    if (validate.status !== 0 || parsed.success !== true)
      findings.push(
        finding({
          where: "claude plugin validate --strict pane",
          what: `validation failed (exit ${validate.status})`,
          why: SHIPS,
          fix: "fix what it reports",
          detail: JSON.stringify(parsed, null, 2),
        }),
      );
    for (const line of differences(reported(parsed)))
      findings.push(
        finding({
          where: "pane/hooks/register.tsx",
          what: line,
          why: WHY,
          fix: "remove it, or add it to ALLOWED in scripts/lib/pane-report.mjs after review",
        }),
      );
    const test = runClaude(["plugin", "test", dir]);
    if (test.status !== 0)
      findings.push(
        finding({
          where: "claude plugin test pane",
          what: `the mod's tests failed (exit ${test.status})`,
          why: SHIPS,
          fix: "fix the failing tests",
          detail: `${test.stdout}\n${test.stderr}`,
        }),
      );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (!report("pane", findings))
    console.log(
      `pane: validate and test pass on the tracked pane/ files, and the mod does only what ALLOWED lists`,
    );
}
