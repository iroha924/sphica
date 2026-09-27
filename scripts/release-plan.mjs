#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { isPackageInput, releaseKind, withoutReleaseVersion } from "./lib/release-scope.mjs";

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
const versionFiles = new Set([
  "plugin/package.json",
  "plugin/.claude-plugin/plugin.json",
  "plugin/.codex-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
]);
const at = (revision, file) => {
  try {
    return git("show", `${revision}:${file}`);
  } catch {
    return null;
  }
};
const files = git("diff", "--name-only", ref, "--cached")
  .split("\n")
  .filter(Boolean)
  .filter(isPackageInput)
  .filter(
    (file) =>
      !versionFiles.has(file) || withoutReleaseVersion(at(ref, file)) !== withoutReleaseVersion(at("", file)),
  );
const kind = releaseKind(files);
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const packageVersion = read("plugin/package.json").version;
const claudeVersion = read("plugin/.claude-plugin/plugin.json").version;
const codexVersion = read("plugin/.codex-plugin/plugin.json").version;
const marketplaceVersion = read(".claude-plugin/marketplace.json").plugins.find(
  (entry) => entry.name === "sphica",
)?.source?.version;
const actions =
  kind === "none"
    ? []
    : [
        "fill in the PR's Release notes, pass PR CI (check, pr-body) and the Codex review, and merge main into the branch",
        `git tag v${packageVersion} <PR head> && git push origin v${packageVersion}`,
        "hand the run URL release.yml comments on the PR to the owner",
        "owner: approve the npm-release environment on the run page (the run then publishes, merges, and creates the GitHub Release)",
        "gh run watch <run-id> --exit-status",
        "bun run release:status",
        "update the Claude and Codex plugin caches and restart sessions",
      ];
const plan = {
  base: ref,
  commit: git("rev-parse", "HEAD"),
  kind,
  files,
  versions: {
    package: packageVersion,
    claude: claudeVersion,
    codex: codexVersion,
    marketplace: marketplaceVersion,
  },
  actions,
};

if (json) {
  process.stdout.write(`${JSON.stringify(plan)}\n`);
} else {
  const label = { none: "none (no release)", plugin: "plugin" }[kind];
  console.log(`release kind: ${label}`);
  console.log(`compared: ${ref}..${plan.commit}`);
  console.log(
    `version: npm ${packageVersion} / plugin ${claudeVersion} / marketplace ${marketplaceVersion} / Codex ${codexVersion}`,
  );
  if (files.length) console.log(`inputs: ${files.join(", ")}`);
  for (const action of actions) console.log(`  ${action}`);
}
