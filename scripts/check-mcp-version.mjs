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
import { parseArgs } from "node:util";
import { isPackageInput, withoutReleaseVersion } from "./lib/release-scope.mjs";

const { base } = parseArgs({ options: { base: { type: "string" } } }).values;

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const at = (ref, file) => {
  try {
    return git("show", `${ref}:${file}`);
  } catch {
    return null;
  }
};

try {
  git("rev-parse", "HEAD");
} catch {
  // The first commit. There is nothing to compare with.
  process.exit(0);
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
if (distinct.length !== 1) {
  console.error(
    [
      "plugin channel versions do not match.",
      "",
      ...versions.map(([f, v]) => `  ${v}  ${f}`),
      "",
      "  Each destination has its own manifest. Bumping only some keeps delivering",
      "  old content to users of the others. Set all 3 plugin channel manifests to the same version.",
    ].join("\n"),
  );
  process.exit(1);
}
const pluginVersion = distinct[0];
if (pluginVersion.localeCompare(packageVersion, undefined, { numeric: true }) > 0) {
  console.error(
    `the plugin channel (${pluginVersion}) cannot be ahead of the npm package (${packageVersion}).`,
  );
  process.exit(1);
}

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
  if (was && compare(now, was) < 0) {
    console.error(`the version goes down from ${was} to ${now}. Use a value above the published version.`);
    process.exit(1);
  }
}
if (changed.length === 0) process.exit(0);

if (
  (!oldPackageVersion || compare(packageVersion, oldPackageVersion) > 0) &&
  (!oldPluginVersion || compare(pluginVersion, oldPluginVersion) > 0) &&
  packageVersion === pluginVersion
) {
  process.exit(0);
}

console.error(
  [
    `${changed.length} plugin channel inputs changed, but the npm package and plugin versions were not bumped together (for example ${changed[0]}).`,
    "",
    "  A plugin installed from the marketplace (GitHub) runs from a copy at <cache>/sphica/sphica/<version>/ in both Claude Code and Codex.",
    "  The copy is made only when the version changes, so as is, the change never reaches sessions.",
    "",
    "  Bump the npm package and the 3 plugin channel manifests to the same new version.",
    '  After it reaches the marketplace source, run the update steps under "Plugin channel versions" in `sphica doctor` and restart sessions.',
  ].join("\n"),
);
process.exit(1);
