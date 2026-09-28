#!/usr/bin/env node
// Checks whether a tag may be published to npm. release.yml calls it twice, before and after the owner approves.
// Usage: node scripts/release-gate.mjs --tag v1.2.3 --commit <sha> (needs GH_TOKEN and GITHUB_REPOSITORY)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { gateProblems, reviewProblems } from "./lib/release-gate.mjs";

const root = path.resolve(import.meta.dirname, "..");
const { tag, commit } = parseArgs({
  options: { tag: { type: "string" }, commit: { type: "string" } },
}).values;
const repo = process.env.GITHUB_REPOSITORY;
if (!tag || !commit || !/^[0-9a-f]{40}$/.test(commit) || !repo) {
  throw new Error("pass --tag, --commit (a 40-character sha), and GITHUB_REPOSITORY");
}
const THREADS = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewThreads(first: 100, after: $after) { nodes { isResolved } pageInfo { hasNextPage endCursor } } } }
}`;
const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim();
const api = (endpoint) => JSON.parse(run("gh", ["api", endpoint]));
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

run("git", ["fetch", "--quiet", "origin", "main"]);
let mainIsAncestor = true;
try {
  run("git", ["merge-base", "--is-ancestor", "FETCH_HEAD", commit]);
} catch {
  mainIsAncestor = false;
}

// For an annotated tag, take the commit on the `^{}` line
const refs = run("git", ["ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`])
  .split("\n")
  .filter(Boolean)
  .map((line) => line.split("\t"));
// ls-remote also matches on the end of a ref (it returns `x/refs/tags/v1` too), so select by exact name
const exact = (name) => refs.find(([, ref]) => ref === name)?.[0];
const tagCommit = exact(`refs/tags/${tag}^{}`) ?? exact(`refs/tags/${tag}`) ?? null;

// Whether npm already has this version. If not, npm view fails with E404 (any other failure throws and stops)
let published = false;
try {
  published = run("npm", ["view", `sphica@${tag.replace(/^v/, "")}`, "version"]) !== "";
} catch (e) {
  if (!String(e instanceof Error && "stderr" in e ? e.stderr : e).includes("E404")) throw e;
}

const { problems, pull } = gateProblems({
  tag,
  commit,
  repo,
  versions: {
    package: read("plugin/package.json").version,
    claude: read("plugin/.claude-plugin/plugin.json").version,
    codex: read("plugin/.codex-plugin/plugin.json").version,
    marketplace: read(".claude-plugin/marketplace.json").plugins.find((entry) => entry.name === "sphica")
      ?.source?.version,
  },
  mainIsAncestor,
  tagCommit,
  published,
  pulls: api(`repos/${repo}/commits/${commit}/pulls`),
  runs: api(`repos/${repo}/actions/runs?head_sha=${commit}&event=pull_request&per_page=100`).workflow_runs,
});
// Codex reviews after CI, so its state is read here, at tag time, not by a pull_request check. Every page is read; an API failure throws
if (pull !== null) {
  const [owner, name] = repo.split("/");
  const comments = JSON.parse(
    run("gh", ["api", "--paginate", "--slurp", `repos/${repo}/issues/${pull}/comments?per_page=100`]),
  ).flat();
  const threads = [];
  for (let after = null; ; ) {
    const page = JSON.parse(
      run("gh", [
        "api",
        "graphql",
        "-f",
        `query=${THREADS}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-F",
        `number=${pull}`,
        ...(after ? ["-f", `after=${after}`] : []),
      ]),
    ).data.repository.pullRequest.reviewThreads;
    threads.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  problems.push(...reviewProblems({ commit, comments, threads }));
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`${tag}: head ${commit} of PR #${pull} may be released`);
// release.yml reads the PR number from here to comment on the PR
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `pull=${pull}\n`);
