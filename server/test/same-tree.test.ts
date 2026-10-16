// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Whether a push to main may skip the heavy jobs: only a merge whose tree is the one its pull request's latest run passed on. Every
// fact that is missing, odd, or unreadable keeps the jobs running. The script is driven against a throwaway repository, without network.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  limitsPullRequestsToMain,
  PR_TO_MAIN,
  type Run,
  runsFrom,
  sameTree,
} from "../../scripts/lib/same-tree.mjs";

const ROOT = path.join(import.meta.dirname, "..", "..");
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const run = (over: Partial<Run> = {}): Run => ({
  id: 1,
  head_sha: HEAD,
  event: "pull_request",
  status: "completed",
  conclusion: "success",
  created_at: "2026-10-16T01:00:00Z",
  run_attempt: 1,
  path: ".github/workflows/check.yml",
  ...over,
});
const facts = (over: Partial<Parameters<typeof sameTree>[0]> = {}) => ({
  parents: [BASE, HEAD],
  before: BASE,
  ancestor: true,
  tree: "t",
  headTree: "t",
  workflow: `on:\n${PR_TO_MAIN}`,
  runs: [run()],
  ...over,
});

test("a merge of an up-to-date head whose latest pull request run passed is tested", () => {
  const d = sameTree(facts());
  assert.equal(d.tested, true, d.reason);
});

test("every way the evidence falls short keeps the heavy jobs running, with the reason", () => {
  const cases: [string, Partial<Parameters<typeof sameTree>[0]>, RegExp][] = [
    ["one parent", { parents: [BASE] }, /1 parent/],
    ["three parents", { parents: [BASE, HEAD, "c".repeat(40)] }, /3 parent/],
    ["first parent not before", { before: "c".repeat(40) }, /not main before the push/],
    ["not an ancestor", { ancestor: false }, /not an ancestor/],
    ["tree differs", { headTree: "u" }, /tree differs/],
    ["no tree", { tree: null, headTree: null }, /tree differs/],
    ["no branch filter", { workflow: "on:\n  pull_request:\n" }, /does not limit pull request runs to main/],
    ["no workflow", { workflow: null }, /does not limit/],
    ["API error", { runs: "the API answered 500" }, /could not be read: the API answered 500/],
    ["no run", { runs: [] }, /no check.yml pull request run/],
    ["a run on another commit", { runs: [run({ head_sha: BASE })] }, /no check.yml pull request run/],
    ["a push run", { runs: [run({ event: "push" })] }, /no check.yml pull request run/],
    [
      "a newer unfinished run over an older success",
      {
        runs: [
          run(),
          run({ id: 2, created_at: "2026-10-16T02:00:00Z", status: "in_progress", conclusion: null }),
        ],
      },
      /latest run on the merged head is in_progress/,
    ],
    [
      "a rerun attempt that failed",
      { runs: [run({ run_attempt: 2, conclusion: "failure" })] },
      /ended failure/,
    ],
    ["a tie", { runs: [run(), run({ id: 2 })] }, /same time/],
    ["cancelled", { runs: [run({ conclusion: "cancelled" })] }, /ended cancelled/],
    ["unreadable time", { runs: [run({ created_at: "soon" })] }, /no readable start time/],
  ];
  for (const [name, over, why] of cases) {
    const d = sameTree(facts(over));
    assert.equal(d.tested, false, name);
    assert.match(d.reason, why, name);
  }
  // The latest run decides even when an older one failed
  assert.equal(
    sameTree(
      facts({ runs: [run({ conclusion: "failure" }), run({ id: 2, created_at: "2026-10-16T02:00:00Z" })] }),
    ).tested,
    true,
  );
});

test("an API reply is read as runs only when it lists them all with every field", () => {
  const ok = { total_count: 1, workflow_runs: [run()] };
  assert.deepEqual(runsFrom(ok), [run()]);
  assert.match(String(runsFrom({ total_count: 101, workflow_runs: [run()] })), /lists 1 of 101/);
  assert.match(String(runsFrom({ message: "Not Found" })), /no workflow_runs/);
  assert.match(String(runsFrom(null)), /no workflow_runs/);
  const { status: _, ...noStatus } = run();
  assert.match(String(runsFrom({ total_count: 1, workflow_runs: [noStatus] })), /lacks a field/);
});

/** A repository whose main merged a branch with --no-ff, the branch's check.yml written as `workflow` */
function merged(t: { after: (fn: () => void) => void }, workflow: string) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-same-tree-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd: dir,
      env,
      encoding: "utf8",
    }).trim();
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "chore: start");
  const before = git("rev-parse", "HEAD");
  git("switch", "-q", "-c", "work");
  fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".github", "workflows", "check.yml"), workflow);
  git("add", ".");
  git("commit", "-q", "-m", "ci: add check");
  git("switch", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", "Merge work", "work");
  return (envOver: NodeJS.ProcessEnv) => {
    const out = path.join(dir, "output");
    fs.rmSync(out, { force: true });
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "same-tree.mjs")], {
      cwd: dir,
      encoding: "utf8",
      env: { ...env, BEFORE: before, GITHUB_REPOSITORY: "", GH_TOKEN: "", GITHUB_OUTPUT: out, ...envOver },
    });
    return {
      status: r.status,
      out: `${r.stdout}${r.stderr}`,
      output: fs.existsSync(out) ? fs.readFileSync(out, "utf8") : null,
    };
  };
}

test("the script reads the merge from git and writes tested=false when anything is missing, without the network", (t) => {
  const push = merged(t, `on:\n${PR_TO_MAIN}`);
  // Every git fact holds, so it reaches the runs, which it cannot read here
  const unread = push({});
  assert.equal(unread.status, 0, unread.out);
  assert.equal(unread.output, "tested=false\n");
  assert.match(unread.out, /runs could not be read: GITHUB_REPOSITORY is not owner\/name/);
  const moved = push({ BEFORE: "c".repeat(40) });
  assert.equal(moved.output, "tested=false\n");
  assert.match(moved.out, /not main before the push/);
  const unfiltered = merged(t, "on:\n  pull_request:\n")({});
  assert.equal(unfiltered.output, "tested=false\n");
  assert.match(unfiltered.out, /does not limit pull request runs to main/);
});

test("the script fails, writing nothing, when it has nowhere to write its answer", (t) => {
  const r = merged(t, `on:\n${PR_TO_MAIN}`)({ GITHUB_OUTPUT: "" });
  assert.notEqual(r.status, 0);
});

test("the branch filter counts only as the pull_request trigger under on:, not as text anywhere in the file", () => {
  const elsewhere = [
    `name: |\n${PR_TO_MAIN}on:\n  pull_request:\n    branches: [release]\n`,
    `env:\n  X: |\n  ${PR_TO_MAIN}on: [push, pull_request]\n`,
    "on:\n  pull_request:\n    branches: [main, release]\n",
    "on:\n  pull_request:\n    branches: [main]\n    paths: [src/**]\n",
    `on:\n${PR_TO_MAIN}"on":\n  pull_request:\n`,
  ];
  for (const workflow of elsewhere) {
    const d = sameTree(facts({ workflow }));
    assert.equal(d.tested, false, workflow);
    assert.match(d.reason, /does not limit pull request runs to main/, workflow);
  }
  // This repository's own check.yml must read as limited, or no push would ever reuse a run
  assert.equal(
    limitsPullRequestsToMain(fs.readFileSync(path.join(ROOT, ".github", "workflows", "check.yml"), "utf8")),
    true,
  );
  // Comments and other triggers around it are fine
  const ok =
    "name: check\n\non:\n  push:\n    branches: [main]\n  # into main only\n  pull_request:\n    branches: [main]\n\njobs: {}\n";
  assert.equal(sameTree(facts({ workflow: ok })).tested, true);
});

test("a run of another workflow file, or a candidate whose start time cannot be read, never counts", () => {
  const other = sameTree(facts({ runs: [run({ path: ".github/workflows/other.yml" })] }));
  assert.equal(other.tested, false);
  assert.match(other.reason, /no check.yml pull request run/);
  const unreadable = sameTree(
    facts({
      runs: [
        run({ created_at: "2026-10-16T02:00:00Z" }),
        run({ id: 2, created_at: "unreadable", status: "in_progress", conclusion: null }),
      ],
    }),
  );
  assert.equal(unreadable.tested, false);
  assert.match(unreadable.reason, /no readable start time/);
  const { path: _, ...noPath } = run();
  assert.match(String(runsFrom({ total_count: 1, workflow_runs: [noPath] })), /lacks a field/);
});

test("a token the request refuses never reaches the log", (t) => {
  const r = merged(t, `on:\n${PR_TO_MAIN}`)({ GITHUB_REPOSITORY: "o/r", GH_TOKEN: "FAKE_TOKEN_VALUE\nTAIL" });
  assert.equal(r.output, "tested=false\n");
  assert.doesNotMatch(r.out, /FAKE_TOKEN_VALUE|TAIL/);
  assert.match(r.out, /the API request failed/);
});

test("two runs started in the same second are unordered, whatever their attempts, so nothing is skipped", () => {
  const d = sameTree(
    facts({
      runs: [
        run({ id: 1, run_attempt: 2 }),
        run({ id: 2, run_attempt: 1, status: "in_progress", conclusion: null }),
      ],
    }),
  );
  assert.equal(d.tested, false, d.reason);
  assert.match(d.reason, /same time/);
});
