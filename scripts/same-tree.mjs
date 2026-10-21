#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// For a push to main in check.yml: writes tested=true, with that run's id and attempt, to GITHUB_OUTPUT when the pushed merge has the
// tree its pull request's last passed run tested (scripts/lib/same-tree.mjs), else tested=false. Anything it cannot read is a reason for false, never true.
// Env: BEFORE (main before the push), GITHUB_REPOSITORY, GH_TOKEN (read access to Actions), GITHUB_OUTPUT.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { runsFrom, sameTree } from "./lib/same-tree.mjs";

const raw = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const git = (...args) => raw(...args).trim();
/** The command's output, or null when git fails (a missing file or object) */
const gitOr = (read, ...args) => {
  try {
    return read(...args);
  } catch {
    return null;
  }
};

async function runsOf(sha) {
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return "GITHUB_REPOSITORY is not owner/name";
  if (!/^[0-9a-f]{40}$/.test(sha)) return "the merged head is not a commit id";
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/check.yml/runs?event=pull_request&head_sha=${sha}&per_page=100`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${process.env.GH_TOKEN ?? ""}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok) return `the API answered ${res.status}`;
    return runsFrom(await res.json());
  } catch (e) {
    // The message can quote the request's headers, token included
    return `the API request failed (${e instanceof Error ? e.name : "unknown error"})`;
  }
}

async function main() {
  const parents = git("rev-list", "--parents", "-n", "1", "HEAD").split(" ").slice(1);
  const [base, head] = parents;
  const ancestor =
    parents.length === 2 &&
    spawnSync("git", ["merge-base", "--is-ancestor", base ?? "", head ?? ""], { stdio: "ignore" }).status ===
      0;
  const decision = sameTree({
    parents,
    before: process.env.BEFORE ?? "",
    ancestor,
    tree: gitOr(git, "rev-parse", "HEAD^{tree}"),
    headTree: parents.length === 2 ? gitOr(git, "rev-parse", "HEAD^2^{tree}") : null,
    workflow: parents.length === 2 ? gitOr(raw, "show", "HEAD^2:.github/workflows/check.yml") : null,
    runs: head ? await runsOf(head) : "no merged head",
  });
  console.log(`same tree: ${decision.tested ? "tested" : "not tested"}: ${decision.reason}`);
  const run = decision.run ? `run=${decision.run.id}\nattempt=${decision.run.attempt}\n` : "";
  fs.appendFileSync(process.env.GITHUB_OUTPUT ?? "", `tested=${decision.tested}\n${run}`);
}

await main();
