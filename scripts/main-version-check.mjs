#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The version check of a push to main (check.yml's same-tree job), with the release verdict of the pull request run same-tree reused.
// Env: BASE (main before the push), TESTED, RUN, ATTEMPT (same-tree's outputs), GITHUB_REPOSITORY, GH_TOKEN (read access to Actions).

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mainCheckArgs } from "./lib/main-version.mjs";

const env = process.env;
const repo = env.GITHUB_REPOSITORY ?? "";
const gh = (args) =>
  execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "main-version-"));
let apiRun = null;
let verdict = null;
if (
  env.TESTED === "true" &&
  /^\d+$/.test(env.RUN ?? "") &&
  /^\d+$/.test(env.ATTEMPT ?? "") &&
  /^[\w.-]+\/[\w.-]+$/.test(repo)
) {
  try {
    apiRun = JSON.parse(gh(["api", `repos/${repo}/actions/runs/${env.RUN}`]));
  } catch {
    apiRun = "the API request failed";
  }
  try {
    gh(["run", "download", env.RUN ?? "", "--repo", repo, "-n", `release-verdict-${env.ATTEMPT}`, "-D", dir]);
    verdict = JSON.parse(fs.readFileSync(path.join(dir, "release-verdict.json"), "utf8"));
  } catch {
    verdict = null;
  }
}
const file = path.join(dir, "release-verdict.json");
const { args, reason } = mainCheckArgs({
  tested: env.TESTED,
  run: env.RUN,
  attempt: env.ATTEMPT,
  repo,
  apiRun,
  verdict,
  file,
});
console.log(`version check: ${reason}`);
const r = spawnSync(
  process.execPath,
  [path.join(import.meta.dirname, "check-mcp-version.mjs"), "--base", env.BASE ?? "", ...args],
  { stdio: "inherit" },
);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(r.status ?? 1);
