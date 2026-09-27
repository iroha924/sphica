import assert from "node:assert/strict";
import { test } from "node:test";
import { gateProblems } from "../../scripts/lib/release-gate.mjs";

const COMMIT = "a".repeat(40);
const REPO = "iroha924/sphica";
const versions = { package: "1.2.3", claude: "1.2.3", codex: "1.2.3", marketplace: "1.2.3" };
const pull = {
  state: "open",
  number: 7,
  base: { ref: "main" },
  head: { sha: COMMIT, repo: { full_name: REPO } },
};
const run = (name: string, conclusion = "success", id = 1) => ({
  id,
  name,
  event: "pull_request",
  head_sha: COMMIT,
  status: "completed",
  conclusion,
  pull_requests: [{ number: 7, base: { ref: "main" } }],
});
const ok = {
  tag: "v1.2.3",
  commit: COMMIT,
  repo: REPO,
  versions,
  mainIsAncestor: true,
  tagCommit: COMMIT,
  published: false,
  pulls: [pull],
  runs: [run("check"), run("pr-body"), run("release")],
};

test("passes and returns the PR number when the tag, all versions, the PR, and CI line up", () => {
  assert.deepEqual(gateProblems(ok), { problems: [], pull: 7 });
});

test("rejects a mismatch between the tag and versions", () => {
  assert.match(gateProblems({ ...ok, tag: "v1.2.4" }).problems.join("\n"), /tag v1\.2\.4/);
  for (const key of ["package", "claude", "codex", "marketplace"] as const)
    assert.match(
      gateProblems({ ...ok, versions: { ...versions, [key]: "1.2.2" } }).problems.join("\n"),
      new RegExp(key),
      key,
    );
  assert.match(gateProblems({ ...ok, tag: "1.2.3" }).problems.join("\n"), /v<version>/);
});

test("rejects a commit that does not include main", () => {
  assert.match(gateProblems({ ...ok, mainIsAncestor: false }).problems.join("\n"), /main/);
});

test("rejects a commit that is not the head of an open same-repository PR into main", () => {
  for (const pulls of [
    [],
    [{ ...pull, state: "closed" }],
    [{ ...pull, base: { ref: "other" } }],
    [{ ...pull, head: { sha: COMMIT, repo: { full_name: "someone/fork" } } }],
    [{ ...pull, head: { sha: "b".repeat(40), repo: { full_name: REPO } } }],
  ])
    assert.match(gateProblems({ ...ok, pulls }).problems.join("\n"), /PR/);
  assert.match(gateProblems({ ...ok, pulls: [pull, { ...pull, number: 8 }] }).problems.join("\n"), /PR/);
});

test("rejects a commit whose latest check and pr-body runs did not succeed", () => {
  assert.match(gateProblems({ ...ok, runs: [run("check")] }).problems.join("\n"), /pr-body/);
  assert.match(
    gateProblems({ ...ok, runs: [run("check", "failure"), run("pr-body")] }).problems.join("\n"),
    /check/,
  );
  assert.match(
    gateProblems({
      ...ok,
      runs: [run("check", "success", 1), run("check", "failure", 2), run("pr-body")],
    }).problems.join("\n"),
    /check/,
  );
  assert.deepEqual(
    gateProblems({
      ...ok,
      runs: [run("check", "failure", 1), run("check", "success", 2), run("pr-body"), run("release")],
    }).problems,
    [],
  );
  assert.match(
    gateProblems({
      ...ok,
      runs: [{ ...run("check"), status: "in_progress", conclusion: null }, run("pr-body")],
    }).problems.join("\n"),
    /check/,
  );
  assert.match(
    gateProblems({
      ...ok,
      runs: [{ ...run("check"), head_sha: "b".repeat(40) }, run("pr-body")],
    }).problems.join("\n"),
    /check/,
  );
  assert.match(
    gateProblems({ ...ok, runs: [{ ...run("check"), event: "push" }, run("pr-body")] }).problems.join("\n"),
    /check/,
  );
});

test("runs from other PRs do not count", () => {
  const other = (name: string) => ({
    ...run(name),
    pull_requests: [{ number: 9, base: { ref: "release" } }],
  });
  assert.match(
    gateProblems({ ...ok, runs: [other("check"), other("pr-body")] }).problems.join("\n"),
    /check/,
  );
  assert.match(
    gateProblems({ ...ok, runs: [{ ...run("check"), pull_requests: [] }, run("pr-body")] }).problems.join(
      "\n",
    ),
    /check/,
  );
});

test("rejects when the remote tag no longer points to the commit", () => {
  assert.match(gateProblems({ ...ok, tagCommit: "b".repeat(40) }).problems.join("\n"), /tag/);
  assert.match(gateProblems({ ...ok, tagCommit: null }).problems.join("\n"), /tag/);
});

test("rejects a tag version already on npm (stopping before publish fails after the owner approves)", () => {
  assert.match(gateProblems({ ...ok, published: true }).problems.join("\n"), /already on npm/);
});

// The PR's release run is the dry run of publish and finish; a defect it finds must stop the tag before anything is published
test("rejects a commit whose release dry run failed or did not run", () => {
  assert.match(
    gateProblems({ ...ok, runs: [run("check"), run("pr-body"), run("release", "failure")] }).problems.join(
      "\n",
    ),
    /release run did not succeed/,
  );
  assert.match(
    gateProblems({ ...ok, runs: [run("check"), run("pr-body")] }).problems.join("\n"),
    /release has not run/,
  );
});
