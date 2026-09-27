#!/usr/bin/env node
// Checks that only the repository owner can approve the npm-release environment. release.yml runs it before and after approval.
// Usage: node scripts/release-env.mjs (needs GH_TOKEN, GITHUB_REPOSITORY, and GITHUB_REPOSITORY_OWNER_ID)

import { execFileSync } from "node:child_process";
import { envProblems } from "./lib/release-env.mjs";

const repo = process.env.GITHUB_REPOSITORY;
const ownerId = process.env.GITHUB_REPOSITORY_OWNER_ID;
if (!repo || !ownerId) throw new Error("pass GITHUB_REPOSITORY and GITHUB_REPOSITORY_OWNER_ID");
// An API failure throws and stops the release
const api = (endpoint) => JSON.parse(execFileSync("gh", ["api", endpoint], { encoding: "utf8" }));

const environment = api(`repos/${repo}/environments/npm-release`);
const policies = api(
  `repos/${repo}/environments/npm-release/deployment-branch-policies?per_page=100`,
).branch_policies;
const problems = envProblems({ environment, policies, ownerId });
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("npm-release: only the owner can approve, from v* tags");
