// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Stryker lives here with its own lockfile, not in server/, whose tree the shipped notices and the release SBOM are read from.
// It runs from the repository root so the sandbox holds db/ beside server/ as the code expects; the paths below start at the root.

export default {
  testRunner: "tap",
  mutate: ["server/src/db-write.ts", "server/src/authority.ts", "server/src/judge.ts"],
  tap: {
    // The files that import the three modules or run their SQL, without the slowest (admin, capture, deliver, overview: over 8 s each).
    // What only those reach (capture's authorizer, deliver's reads as of a time) shows as no coverage
    testFiles: [
      "server/test/judge.test.ts",
      "server/test/reconcile.test.ts",
      "server/test/authority.test.ts",
      "server/test/db.test.ts",
      "server/test/migrate.test.ts",
      "server/test/record.test.ts",
      "server/test/forget.test.ts",
      "server/test/project.test.ts",
    ],
    // Each file runs alone, isolated as the test script isolates it; the hook file lets Stryker count which file reached which mutant
    nodeArgs: ["--import", "./server/test/isolate-home.ts", "--test-reporter=tap", "-r", "{{hookFile}}", "{{testFile}}"],
    // The tests start child processes, which forceBail can leave running
    forceBail: false,
  },
  reporters: ["clear-text", "html", "json", "progress"],
  htmlReporter: { fileName: "reports/mutation/mutation.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  // The sandbox holds only what the listed tests read; the rest of the tree has links Stryker cannot copy (.claude/skills)
  ignorePatterns: [
    "/**",
    "!/db/**",
    "!/plugin/**",
    "/plugin/dist/**",
    "!/server/src/**",
    "!/server/test/**",
    "!/server/package.json",
  ],
};
