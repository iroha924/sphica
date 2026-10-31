#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  DEPENDENCY_INPUTS,
  isPackageInput,
  releaseKind,
  releaseVersions,
  VERSION_FILES,
  withoutReleaseVersion,
} from "./lib/release-scope.mjs";
import { latestRun, verdictMismatch } from "./lib/release-verdict.mjs";
import { observe, settingsState } from "./lib/repo-settings.mjs";
import { runsFrom } from "./lib/same-tree.mjs";

const root = path.resolve(import.meta.dirname, "..");
const { base, json } = parseArgs({
  options: { base: { type: "string" }, json: { type: "boolean", default: false } },
}).values;
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

function defaultBase() {
  try {
    return git("describe", "--tags", "--abbrev=0");
  } catch {
    try {
      return git("rev-parse", "HEAD^");
    } catch {
      return git("rev-parse", "HEAD");
    }
  }
}

const ref = base ?? defaultBase();
const at = (revision, file) => {
  try {
    return git("show", `${revision}:${file}`);
  } catch {
    return null;
  }
};
// Paths come NUL-separated and untrimmed, so that names outside ASCII are not quoted and leading spaces stay part of the name
const paths = (...args) =>
  execFileSync("git", [...args, "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
// A file name can hold a line break, U+2028 and U+2029 included (JSON.stringify leaves those two as they are): shown escaped as a
// JSON string, it cannot print a line of its own
const shown = (file) =>
  /[\p{Cc}\u2028\u2029]/u.test(file)
    ? JSON.stringify(file).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029")
    : file;
// What is staged is what the commit will hold, so the base is compared with the index
const files = paths("diff", "--name-only", ref, "--cached")
  .filter(isPackageInput)
  .filter(
    (file) =>
      !VERSION_FILES.has(file) ||
      withoutReleaseVersion(at(ref, file)) !== withoutReleaseVersion(at("", file)),
  );
let kind = releaseKind(files);
const unstaged = [
  ...new Set([...paths("diff", "--name-only"), ...paths("ls-files", "--others", "--exclude-standard")]),
]
  .filter(isPackageInput)
  .sort();
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const versions = releaseVersions(read);
const packageVersion = versions.package;
// A release relies on settings only an admin can read (release.yml's GITHUB_TOKEN cannot); read them with the owner's gh
const gh = (args) =>
  execFileSync("gh", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
let repo = null;
try {
  repo = gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).trim();
} catch {}
// A change to the server's dependency files alone ships nothing new when the PR's CI found the packed tarball the same as the base's
// release. The verdict is read from that run's artifact, and only for the tree staged here and the version the base released
let verdict = null;
if (kind === "plugin" && files.every((file) => DEPENDENCY_INPUTS.has(file))) verdict = readVerdict();
if (verdict?.same) kind = "none";

/** owner/name of the origin remote on GitHub, or null */
function originRepo() {
  let url;
  try {
    url = git("remote", "get-url", "origin");
  } catch {
    return null;
  }
  return (
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
      url,
    )?.[1] ?? null
  );
}

function readVerdict() {
  const no = (reason) => ({ same: false, reason });
  if (!repo) return no("the repository name could not be read with gh");
  // gh can be pointed at another repository (GH_REPO), so the checkout's own origin has to name the same one
  const origin = originRepo();
  if (repo !== origin) return no(`gh answers ${repo}, but origin is ${origin ?? "not a GitHub repository"}`);
  const head = git("rev-parse", "HEAD");
  let runs;
  try {
    runs = runsFrom(
      JSON.parse(
        gh([
          "api",
          `repos/${repo}/actions/workflows/check.yml/runs?event=pull_request&head_sha=${head}&per_page=100`,
        ]),
      ),
    );
  } catch {
    return no("the pull request runs could not be read with gh");
  }
  if (typeof runs === "string") return no(runs);
  const run = latestRun(runs, { repo, head });
  if (typeof run === "string") return no(run);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-plan-verdict-"));
  try {
    // The latest attempt that ran the comparison wrote the artifact named for it; an attempt that reused the job wrote none
    let attempt = run.run_attempt;
    for (; attempt >= 1; attempt--) {
      try {
        gh([
          "run",
          "download",
          String(run.id),
          "--repo",
          repo,
          "-n",
          `release-verdict-${attempt}`,
          "-D",
          dir,
        ]);
        break;
      } catch {}
    }
    if (attempt < 1) return no(`run ${run.id} left no release verdict`);
    const read = JSON.parse(fs.readFileSync(path.join(dir, "release-verdict.json"), "utf8"));
    const version = JSON.parse(at(ref, "plugin/package.json") ?? "{}").version;
    const why = verdictMismatch(read, { run, attempt, tree: git("write-tree"), version });
    return why
      ? no(why)
      : { same: true, reason: `run ${run.id} found the packed tarball the same as ${version}` };
  } catch {
    return no(`the verdict of run ${run.id} could not be read`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const actions =
  kind === "none"
    ? []
    : [
        "fill in the PR's Release notes, pass PR CI (check, pr-body, and the release dry run), and merge main into the branch",
        "the owner checks the Codex review of the last head; fix or decline each finding and resolve every thread",
        `git tag v${packageVersion} <PR head> && git push origin v${packageVersion}`,
        "hand the run URL release.yml comments on the PR to the owner",
        "owner: approve the npm-release environment on the run page (the run then publishes, merges, and creates the GitHub Release)",
        "gh run watch <run-id> --exit-status",
        "bun run release:status",
        "update the Claude and Codex plugin caches and restart sessions",
      ];
const unseen = { status: null, body: null };
const settings =
  kind === "none"
    ? []
    : settingsState({
        immutable: repo ? observe(gh, `repos/${repo}/immutable-releases`) : unseen,
        actions: repo ? observe(gh, `repos/${repo}/actions/permissions`) : unseen,
      });
const plan = {
  base: ref,
  compared: "index",
  commit: git("rev-parse", "HEAD"),
  kind,
  verdict,
  files,
  unstaged,
  versions,
  actions,
  settings,
};

if (json) {
  process.stdout.write(`${JSON.stringify(plan)}\n`);
} else {
  const label = { none: "none (no release)", plugin: "plugin" }[kind];
  console.log(`release kind: ${label}`);
  console.log(`compared: ${ref}..index (HEAD ${plan.commit})`);
  console.log(
    `version: npm ${packageVersion} / plugin ${versions.claude} / marketplace ${versions.marketplace} / Codex ${versions.codex}`,
  );
  if (files.length) console.log(`inputs: ${files.map(shown).join(", ")}`);
  if (verdict) console.log(`release verdict: ${verdict.same ? "same" : "not usable"}: ${verdict.reason}`);
  if (unstaged.length) {
    console.log(`not staged, not counted (git add them first): ${unstaged.length}`);
    for (const file of unstaged) console.log(`  ${shown(file)}`);
  }
  for (const action of actions) console.log(`  ${action}`);
  for (const { name, state } of settings)
    console.log(`${state === "on" ? "" : "fix before releasing: "}${name}: ${state}`);
}
if (settings.some(({ state }) => state !== "on")) process.exitCode = 1;
