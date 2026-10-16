#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Installs the git hooks (lefthook) from the main working tree only. Worktrees share .git/hooks and lefthook writes its own binary's path
// into each hook, so an install from a worktree points every hook at a directory that goes away with the worktree. CI needs no hooks.
// Usage: node scripts/install-hooks.mjs, from inside the repository (`bun run setup` runs it after installing the dependencies)

import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

// The same reading of CI as lefthook's own install script
const enabled = (v) => Boolean(v) && v !== "0" && v !== "false";

function main() {
  if (enabled(process.env.CI)) {
    console.log("hooks: not installed in CI");
    return;
  }
  let top, gitDir, common;
  try {
    [top, gitDir, common] = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n");
  } catch (e) {
    console.error(`hooks: cannot tell whether this is the main working tree: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  if (path.resolve(gitDir) !== path.resolve(common)) {
    console.log(
      `hooks: not installed from the worktree ${top}; the hooks the main working tree installed serve it too`,
    );
    return;
  }
  const lefthook = path.join(top, "server", "node_modules", "lefthook", "bin", "index.js");
  const r = spawnSync(process.execPath, [lefthook, "install"], { cwd: top, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`hooks: lefthook install ended with ${r.status ?? r.signal ?? r.error?.message}`);
    process.exitCode = 1;
  }
}

main();
