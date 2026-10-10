// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Loaded before every test file (the test script's --import): HOME and the temp directory move to a fresh directory of this process, so
// no test reaches the owner's ~/.sphica (Sphica keeps its isolated git directories there), and HOME's .sphica is apart from the temp
// directory, as Sphica requires before it compares a work tree.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// First, so the directories tempDir made are removed at exit before what is left in the temp directory is counted below
import "./temp-dir.ts";

// Also imported first by every test file, so running one file directly is isolated too; the second load in a process does nothing
if (!process.env.SPHICA_TEST_ISOLATED) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-test-")));
  const home = path.join(base, "home");
  const tmp = path.join(base, "tmp");
  fs.mkdirSync(home);
  fs.mkdirSync(tmp);
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    // git reads its global config and ignore file under XDG_CONFIG_HOME before HOME, and runners set it to the real one
    XDG_CONFIG_HOME: path.join(home, ".config"),
    SPHICA_TEST_ISOLATED: base,
  });
  // Either would point Sphica past the swapped HOME at the owner's database or queue
  delete process.env.SPHICA_DB;
  delete process.env.SPHICA_HOME;
  // What a test file leaves in the temp directory fails it by name, as sql:reach would have seen it had the temp directory not moved here
  process.on("exit", () => {
    let left: string[] = [];
    try {
      left = fs.readdirSync(tmp).filter((name) => name !== "node-compile-cache");
    } catch {
      // the directory is gone: nothing was left
    }
    if (left.length) {
      process.stderr.write(
        `the test file left ${left.length} in its temp directory: ${left.slice(0, 20).join(", ")}\n`,
      );
      process.exitCode = 1;
    }
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      // a directory a test locked stays; sql:reach then names it
    }
  });
}
