#!/usr/bin/env node
// Checks a merged release and creates its GitHub Release from the notes recorded before approval (release.yml's finish job).
// --notes-digest --pull <N> prints that record in prepare; --dry-run checks the latest published release and writes nothing.
// The arguments and checks are in .agents/skills/plugin-release/SKILL.md (Shipping steps 5 and 8). Needs GH_TOKEN and GITHUB_REPOSITORY.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
    "approved-notes": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "notes-digest": { type: "boolean", default: false },
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

const digest = (notes) => createHash("sha256").update(notes).digest("hex");
// The PR's Release notes, which must exist before anything is published
const prNotes = (pull) => {
  const pr = JSON.parse(run("gh", ["api", `repos/${repo}/pulls/${pull}`]));
  const notes = releaseNotes(pr.body);
  if (notes === null) fail(`PR #${pull} has no Release notes section, or it is empty`);
  return { pr, notes };
};

try {
  if (values["notes-digest"]) {
    if (!/^\d+$/.test(values.pull ?? "")) fail("pass --pull as a PR number");
    console.log(digest(prNotes(values.pull).notes));
  } else {
    finish(values);
  }
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
    const pulls = JSON.parse(run("gh", ["api", `repos/${repo}/commits/${commit}/pulls`]));
    pull = String(pulls.find((candidate) => candidate.head?.sha === commit)?.number ?? "");
  }
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag ?? "")) fail("pass --tag v<version>");
  for (const [name, sha] of Object.entries({ commit, merge })) {
    if (!/^[0-9a-f]{40}$/.test(sha ?? "")) fail(`pass --${name} as a 40-character sha`);
  }
  if (!/^\d+$/.test(pull ?? "")) fail("pass --pull as a PR number");
  const approved = values["approved-notes"];
  if (!dryRun && !/^[0-9a-f]{64}$/.test(approved ?? ""))
    fail("pass --approved-notes as the sha256 prepare recorded");
  const version = tag.slice(1);

  // 1. The tag, the PR, and the merge all name the same commit, and the merge brought in exactly its tree
  const tagged = run("git", ["rev-parse", `${tag}^{commit}`]);
  if (tagged !== commit) fail(`${tag} points to ${tagged}, not ${commit}`);
  // The Release is created from the remote tag, which could have moved after publish. For an annotated tag, take the `^{}` line
  const refs = run("git", ["ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`])
    .split("\n")
    .map((line) => line.split("\t"));
  const remote =
    refs.find(([, ref]) => ref === `refs/tags/${tag}^{}`)?.[0] ??
    refs.find(([, ref]) => ref === `refs/tags/${tag}`)?.[0];
  if (remote !== commit) fail(`remote tag ${tag} points to ${remote ?? "nothing"}, not ${commit}`);
  const pr = JSON.parse(run("gh", ["api", `repos/${repo}/pulls/${pull}`]));
  if (pr.head?.sha !== commit)
    fail(`PR #${pull} has head ${pr.head?.sha ?? "unknown"}, not the tag commit ${commit}`);
  if (pr.base?.ref !== "main") fail(`PR #${pull} targets ${pr.base?.ref ?? "unknown"}, not main`);
  if (pr.merged !== true || pr.merge_commit_sha !== merge) fail(`PR #${pull} is not merged at ${merge}`);
  if (run("git", ["rev-parse", `${merge}^2`]) !== commit) fail(`${merge} does not merge ${tag} (${commit})`);
  if (!succeeds("git", ["diff", "--quiet", commit, merge])) fail(`the tree of ${merge} differs from ${tag}`);

  if (!dryRun) waitForNpm(version);

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
    const notes = releaseNotes(pr.body);
    if (notes === null) fail(`PR #${pull} has no Release notes section, or it is empty`);
    if (!dryRun && digest(notes) !== approved) {
      fail(
        "the Release notes changed after the owner approved; ask the owner and create the Release by hand",
      );
    }

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
    // A merge by GITHUB_TOKEN does not close the issues the PR closes (0.5.4), so close the ones still open
    const linked = JSON.parse(
      run("gh", ["pr", "view", pull, "--repo", repo, "--json", "closingIssuesReferences"]),
    );
    for (const { number } of linked.closingIssuesReferences ?? []) {
      if (!Number.isInteger(number)) continue;
      // closingIssuesReferences carries no state, so read it from the issue
      const { state } = JSON.parse(
        run("gh", ["issue", "view", String(number), "--repo", repo, "--json", "state"]),
      );
      if (state !== "OPEN") continue;
      run("gh", [
        "issue",
        "close",
        String(number),
        "--repo",
        repo,
        "--reason",
        "completed",
        "--comment",
        `Closed by #${pull}, released in ${tag}.`,
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

// npm accepts a publish and serves it minutes later (2 min 15 s for 0.5.4, about 6 min for 0.5.5 and 0.5.6).
// Wait up to 12 minutes, within finish's 20-minute timeout
function waitForNpm(version) {
  const seconds = Number(process.env.RELEASE_FINISH_WAIT_SECONDS ?? 20);
  for (let attempt = 0; attempt < 36; attempt++) {
    if (attempt > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
    if (succeeds("npm", ["view", `sphica@${version}`, "version"])) return;
  }
  fail(`npm does not serve sphica@${version} yet; wait a few minutes and rerun finish`);
}
