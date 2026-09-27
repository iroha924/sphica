#!/usr/bin/env node
// Checks a published and merged release, creates its GitHub Release from the PR's Release notes, and reports on the PR.
// release.yml runs it after the merge job; with --dry-run it checks the latest published release and creates or posts nothing.
// Usage: node scripts/release-finish.mjs --tag v1.2.3 --commit <tag sha> --merge <merge sha> --pull <N> | --dry-run
// (needs GH_TOKEN and GITHUB_REPOSITORY)

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { releaseMerge, releaseNotes } from "./lib/release-finish.mjs";

const { values } = parseArgs({
  options: {
    tag: { type: "string" },
    commit: { type: "string" },
    merge: { type: "string" },
    pull: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
const dryRun = values["dry-run"];
const repo = process.env.GITHUB_REPOSITORY;
if (!repo) throw new Error("pass GITHUB_REPOSITORY");
const run = (command, args) => execFileSync(command, args, { encoding: "utf8" }).trim();
const succeeds = (command, args) => spawnSync(command, args, { stdio: "ignore" }).status === 0;
class Stop extends Error {}
const fail = (message) => {
  throw new Stop(message);
};

try {
  finish(values);
} catch (error) {
  if (!(error instanceof Stop)) throw error;
  console.error(error.message);
  process.exitCode = 1;
}

function finish({ tag, commit, merge, pull }) {
  if (dryRun) {
    // The latest published release and its merge on main stand in for the release this run would finish
    tag = `v${run("npm", ["view", "sphica", "version"])}`;
    commit = run("git", ["rev-parse", `${tag}^{commit}`]);
    run("git", ["fetch", "--quiet", "origin", "main"]);
    merge = releaseMerge(run("git", ["log", "FETCH_HEAD", "--merges", "--format=%H %P"]), commit);
    if (!merge) fail(`no merge commit on main has ${tag} (${commit}) as its second parent`);
    pull = String(JSON.parse(run("gh", ["api", `repos/${repo}/commits/${commit}/pulls`]))[0]?.number ?? "");
  }
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag ?? "")) fail("pass --tag v<version>");
  for (const [name, sha] of Object.entries({ commit, merge })) {
    if (!/^[0-9a-f]{40}$/.test(sha ?? "")) fail(`pass --${name} as a 40-character sha`);
  }
  if (!/^\d+$/.test(pull ?? "")) fail("pass --pull as a PR number");
  const version = tag.slice(1);

  // 1. The merge brought in exactly the tag commit's tree
  if (run("git", ["rev-parse", `${merge}^2`]) !== commit) fail(`${merge} does not merge ${tag} (${commit})`);
  if (!succeeds("git", ["diff", "--quiet", commit, merge])) fail(`the tree of ${merge} differs from ${tag}`);

  // 2. npm serves the bytes the publish job attested, which it had compared with prepare's SHA-512 first
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-release-finish-"));
  try {
    const tgz = run("npm", ["pack", `sphica@${version}`, "--silent", "--pack-destination", dir]);
    const attested = succeeds("gh", [
      "attestation",
      "verify",
      path.join(dir, tgz),
      "--repo",
      repo,
      "--predicate-type",
      "https://cyclonedx.org/bom",
      "--signer-workflow",
      `${repo}/.github/workflows/release.yml`,
      "--source-ref",
      `refs/tags/${tag}`,
    ]);
    if (!attested) fail(`the npm tarball of ${version} has no SBOM attestation from release.yml at ${tag}`);

    // 3. The approval made it the default install
    const latest = JSON.parse(run("npm", ["view", "sphica", "dist-tags", "--json"])).latest;
    if (latest !== version) fail(`npm latest is ${latest}, not ${version}`);

    // 4. The owner reviewed the notes in the PR body; a release without them goes back to the owner
    const notes = releaseNotes(JSON.parse(run("gh", ["api", `repos/${repo}/pulls/${pull}`])).body);
    if (notes === null) fail(`PR #${pull} has no Release notes section, or it is empty`);

    if (dryRun) {
      console.log(`${tag}: tree, attestation, npm latest, and Release notes check out (dry run)`);
      return;
    }

    // 5. Create the Release once; a rerun finds it and moves on
    if (!succeeds("gh", ["release", "view", tag, "--repo", repo])) {
      const notesFile = path.join(dir, "notes.md");
      fs.writeFileSync(notesFile, `${notes}\n`);
      run("gh", [
        "release",
        "create",
        tag,
        "--repo",
        repo,
        "--verify-tag",
        "--title",
        tag,
        "--notes-file",
        notesFile,
      ]);
    }
    const url = JSON.parse(run("gh", ["release", "view", tag, "--repo", repo, "--json", "url"])).url;
    const commentFile = path.join(dir, "comment.md");
    fs.writeFileSync(
      commentFile,
      `${tag} is released: npm latest is ${version}, the merged tree matches the tag, and the tarball's SBOM attestation verifies.\n\nGitHub Release: ${url}\n`,
    );
    run("gh", ["pr", "comment", pull, "--repo", repo, "--body-file", commentFile]);
    console.log(`${tag}: released (${url})`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
