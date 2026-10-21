#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Fails when shipped plugin files changed without a version bump. pre-commit checks the whole work branch including the commit
// being made (on main, against the previous commit), and CI checks everything from the `--base` commit to HEAD.
//
// .agents/skills/plugin-release/SKILL.md is the source of truth for delivery paths and failure modes.
// It judges by everything that goes into the bundle, not by the entry source alone: `mcp.js` folds in search.ts and db.ts,
// so judging only by whether `mcp.ts` changed leaves a hole (one did open).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { parseArgs } from "node:util";
import { fail, finding, report, runCheck } from "./lib/finding.mjs";
import { DEPENDENCY_INPUTS, isPackageInput, withoutReleaseVersion } from "./lib/release-scope.mjs";

// A change whose only package inputs are server/package.json and server/bun.lock ships nothing new when the packed tarball matches the
// last release. --defer-deps lets it through without a bump and leaves that to CI; --verdict takes the verdict
// scripts/release-verdict.mjs wrote and lets it through only when it says same for this tree and base. Neither: today's rule.
const {
  base,
  "defer-deps": deferDeps,
  verdict: verdictFile,
} = parseArgs({
  options: {
    base: { type: "string" },
    "defer-deps": { type: "boolean", default: false },
    verdict: { type: "string" },
  },
}).values;

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const at = (ref, file) => {
  try {
    return git("show", `${ref}:${file}`);
  } catch {
    return null;
  }
};

await runCheck("version", () => {
  let skipped = null;
  try {
    git("rev-parse", "HEAD");
  } catch {
    // The first commit. There is nothing to compare with.
    return;
  }

  // The plugin channel version lives in 3 places. Bumping only some of them does not deliver, so check all of them.
  // Measured (2026-09-09): while the Claude side was bumped 13 times, **the Codex side stayed at its initial 0.1.0
  // and was never bumped.** This gate only checked the Claude side, so the promise to stop a forgotten bump
  // held for one side only. The npm package and the 3 plugin channel manifests move to the same version whenever shipped files change.
  const PACKAGE = "plugin/package.json";
  const PLUGIN_MANIFESTS = {
    // **The version lives in source.** Putting it directly in the entry too makes Claude Code use plugin.json without warning
    // and silently ignore the marketplace value (official plugin-marketplaces docs). Keep it in one place.
    ".claude-plugin/marketplace.json": (j) => j.plugins?.find((x) => x.name === "sphica")?.source?.version,
    "plugin/.claude-plugin/plugin.json": (j) => j.version,
    "plugin/.codex-plugin/plugin.json": (j) => j.version,
  };

  // Read versions from the index too. A version bumped only in the working tree does not go into the commit.
  const read = (f) => JSON.parse(git("show", `:${f}`));
  /** The file as staged in the index (what the commit will contain). An empty ref gives `git show :path`. */
  const staged = (f) => at("", f);
  const packageVersion = read(PACKAGE).version;
  const packageName = read(PACKAGE).name;
  // Versions order within one package name. A ref that shipped another name started another line, so it is not compared
  const sameName = (ref) => {
    const text = at(ref, PACKAGE);
    return text !== null && JSON.parse(text).name === packageName;
  };
  const versions = Object.entries(PLUGIN_MANIFESTS).map(([f, pick]) => [f, pick(read(f))]);
  const distinct = [...new Set(versions.map(([, v]) => v))];
  if (distinct.length !== 1)
    fail({
      where: Object.keys(PLUGIN_MANIFESTS).join(", "),
      what: `the plugin channel versions differ: ${versions.map(([f, v]) => `${v} in ${f}`).join(", ")}`,
      why: "each host installs from its own manifest, so bumping only some keeps old content reaching the others (invariant version-sync)",
      fix: `set all 3 manifests to the same version as ${PACKAGE}`,
    });
  const pluginVersion = distinct[0];
  if (pluginVersion.localeCompare(packageVersion, undefined, { numeric: true }) > 0)
    fail({
      where: PACKAGE,
      what: `the plugin channel is at ${pluginVersion}, ahead of the npm package at ${packageVersion}`,
      why: "the marketplace installs the npm version its manifest names, so a channel ahead of npm points at a release that does not exist",
      fix: `set ${PACKAGE} to ${pluginVersion}, or bring the 3 manifests back to ${packageVersion}`,
    });

  // **Changed files are also read from the index (what the commit will contain).** Reading the working tree could read before bundle
  // finishes writing and pass. In CI the index equals HEAD right after checkout, so switching the base to
  // `--base` gives the same comparison.
  // Manifests are compared without their version (withoutReleaseVersion in release-scope.mjs).
  // Without a base, a work branch compares against its fork point from main (one bump in the branch covers later commits).
  // On main, or when the fork point is unavailable, compare with HEAD. CI checks the whole PR range with `--base`.
  function defaultBase() {
    try {
      if (git("symbolic-ref", "--quiet", "--short", "HEAD").trim() === "main") return "HEAD";
      return git("merge-base", "HEAD", "refs/remotes/origin/main").trim();
    } catch {
      return "HEAD";
    }
  }
  const ref = base ?? defaultBase();
  const changed = git("diff", "--cached", "--name-only", ref)
    .split("\n")
    .filter(Boolean)
    .filter(isPackageInput)
    .filter(
      (f) =>
        (f !== PACKAGE && !(f in PLUGIN_MANIFESTS)) ||
        withoutReleaseVersion(at(ref, f)) !== withoutReleaseVersion(staged(f)),
    );
  /** Compares major.minor.patch numerically (as strings, 1.10.0 would be less than 1.9.0). */
  const compare = (a, b) => {
    const [x, y] = [a, b].map((v) => String(v).split(".").map(Number));
    for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  };
  // Without a base, the version must also exceed any version main shipped after the fork point (CI compares the PR with the current main).
  // origin/main can be older than the local main, so check both and take the newest
  const versionRefs = base ? [ref] : [ref, "refs/heads/main", "refs/remotes/origin/main"];
  const newest = (file) =>
    versionRefs
      .filter(sameName)
      .map((r) => at(r, file))
      .filter((text) => text !== null)
      .map((text) => JSON.parse(text).version)
      .filter((v) => typeof v === "string")
      .reduce((a, b) => (a === undefined || compare(b, a) > 0 ? b : a), undefined);
  const oldPackageVersion = newest(PACKAGE);
  const oldPluginVersion = newest("plugin/.claude-plugin/plugin.json");

  // **Lowering the version fails even without shipped changes.** User caches only move to newer versions.
  // Compare with the previous commit as well as the base (fork point), so a drop after a bump in the branch is caught.
  const versionAt = (r, file) => {
    const text = sameName(r) ? at(r, file) : null;
    return text ? JSON.parse(text).version : undefined;
  };
  const headVersion = (file) => versionAt("HEAD", file);
  // Do not compare with main's newer version here (that would block commits that do not change shipped files). That is checked only when shipped files change
  for (const [was, now] of [
    [versionAt(ref, PACKAGE), packageVersion],
    [versionAt(ref, "plugin/.claude-plugin/plugin.json"), pluginVersion],
    [headVersion(PACKAGE), packageVersion],
    [headVersion("plugin/.claude-plugin/plugin.json"), pluginVersion],
  ]) {
    if (was && compare(now, was) < 0)
      fail({
        where: PACKAGE,
        what: `the version goes down from ${was} to ${now}`,
        why: "hosts move a plugin's cache only to newer versions, so a lower one never reaches anyone",
        fix: `set ${PACKAGE} and the 3 plugin manifests to one version above ${was}`,
      });
  }
  if (changed.length === 0) return;

  const bumped =
    (!oldPackageVersion || compare(packageVersion, oldPackageVersion) > 0) &&
    (!oldPluginVersion || compare(pluginVersion, oldPluginVersion) > 0) &&
    packageVersion === pluginVersion;
  // The exemption covers the bump only: npm and the plugin channel still have to agree
  const dependenciesOnly = changed.every((f) => DEPENDENCY_INPUTS.has(f)) && packageVersion === pluginVersion;
  // On main there is no pull request CI to leave the decision to, so a direct commit there gets today's rule
  const onMain = (() => {
    try {
      return git("symbolic-ref", "--quiet", "--short", "HEAD").trim() === "main";
    } catch {
      return false;
    }
  })();
  if (!bumped && dependenciesOnly && deferDeps && !onMain) {
    console.log(
      `only ${changed.join(" and ")} changed: CI compares the packed tarball with the last release and asks for a bump if it differs`,
    );
    return;
  }
  if (!bumped && dependenciesOnly && verdictFile) {
    skipped = verdictProblem(verdictFile);
    if (!skipped) {
      console.log(
        `only ${changed.join(" and ")} changed, and the packed tarball matches the last release: no bump needed`,
      );
      return;
    }
  }

  if (bumped) return;

  report("version", [
    ...(skipped
      ? [
          finding({
            where: verdictFile,
            what: `the dependency change cannot skip the bump: ${skipped}`,
            why: "only a verdict that the packed tarball is the same as the last release, for this tree and base, shows the change ships nothing",
            fix: "bump the version as below, or run scripts/release-verdict.mjs again for this tree",
          }),
        ]
      : []),
    finding({
      where: changed[0],
      what: `${changed.length} package input(s) changed, but the npm package and the 3 plugin manifests were not bumped together (${changed.join(", ")})`,
      why: "Claude Code and Codex run a marketplace plugin from a copy cached per version, so without a bump the change never reaches a session (invariant version-sync)",
      fix: `bump ${PACKAGE} and the 3 plugin manifests to one new version above ${oldPackageVersion ?? packageVersion}, after \`bun run release:plan\` reports the release kind`,
    }),
  ]);

  /** Why the verdict file does not let this tree skip the bump, or null when it says same for this tree and base */
  function verdictProblem(file) {
    let v;
    try {
      v = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return `the verdict ${file} cannot be read`;
    }
    if (v?.verdict !== "same")
      return `the verdict is ${v?.verdict ?? "missing"}: ${v?.reason ?? "no reason"}`;
    // The index is what this check reads and what the commit will hold, so the verdict has to be for its tree
    if (v.tree !== git("write-tree").trim()) return "the verdict is for another tree";
    // The base's release is what the tarball was compared with; a push to main reuses its pull request's verdict, whose base commit differs
    const released = sameName(ref) ? JSON.parse(at(ref, PACKAGE)).version : undefined;
    if (v.npm?.version !== released)
      return `the verdict compared with ${v.npm?.version ?? "no release"}, not the base's ${released ?? "release"}`;
    return null;
  }
});
