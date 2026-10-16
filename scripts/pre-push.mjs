#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The pre-push hook: checks the pushed commits' messages, then runs `bun run verify` when the push updates main and `bun run check`
// otherwise (CI runs verify on every pull request). Lefthook gives stdin to one job only, so this one job reads Git's lines for both.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pushLines, scriptFor } from "./lib/pre-push.mjs";

function main() {
  const stdin = fs.readFileSync(0, "utf8");
  const parsed = pushLines(stdin);
  if (parsed.bad) {
    console.error(`pre-push: ${parsed.bad}`);
    process.exitCode = 1;
    return;
  }
  const messages = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, "check-commit-msg.mjs"), "--pre-push"],
    {
      input: stdin,
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  if (messages.status !== 0) {
    process.exitCode = messages.status ?? 1;
    return;
  }
  // If left set, git in the temp repositories the tests create points at this repository
  // (measured: it wrote core.bare=true and user.*, and added 2 commits)
  const env = { ...process.env };
  for (const name of execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" }).split("\n"))
    if (name) delete env[name];
  const script = scriptFor(parsed.lines);
  console.log(`pre-push: bun run ${script}`);
  const r = spawnSync("bun", ["run", script], { env, stdio: "inherit" });
  process.exitCode = r.status ?? 1;
}

main();
