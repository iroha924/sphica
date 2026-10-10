#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { observe, settingsState } from "./lib/repo-settings.mjs";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const attempt = (command, args, options = {}) => {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
      ...options,
    }).trim();
  } catch {
    return null;
  }
};
const manifestVersion = (where, manifest) => {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(where, manifest), "utf8"));
    return typeof value.version === "string"
      ? { status: "ok", version: value.version }
      : { status: "unknown", version: null };
  } catch (error) {
    return error && typeof error === "object" && "code" in error && error.code === "ENOENT"
      ? { status: "missing", version: null }
      : { status: "unknown", version: null };
  }
};
const dirs = (where) => {
  try {
    return fs.readdirSync(where, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch (error) {
    return error && typeof error === "object" && "code" in error && error.code === "ENOENT" ? [] : null;
  }
};

const packageVersion = read("plugin/package.json").version;
const claudeManifest = read("plugin/.claude-plugin/plugin.json").version;
const codexManifest = read("plugin/.codex-plugin/plugin.json").version;
const marketplace = read(".claude-plugin/marketplace.json").plugins.find((entry) => entry.name === "sphica")
  ?.source?.version;
const tagsText = attempt("npm", ["view", "sphica", "dist-tags", "--json"]);
let tags = null;
try {
  tags = tagsText ? JSON.parse(tagsText) : null;
} catch {
  tags = null;
}
const remoteTags = attempt("git", ["ls-remote", "--tags", "origin"]);
const globalRoot = attempt("npm", ["root", "-g"]);
const globalPackage = globalRoot
  ? manifestVersion(path.join(globalRoot, "sphica"), "package.json")
  : { status: "unknown", version: null };
const claudeText = attempt("claude", ["plugin", "list", "--json"]);
let claudeCache = null;
let claudeObserved = false;
try {
  const plugins = claudeText ? JSON.parse(claudeText) : [];
  claudeObserved = claudeText !== null;
  claudeCache =
    plugins.find((entry) => entry.id?.startsWith("sphica@") && entry.scope === "user")?.version ?? null;
} catch {
  claudeCache = null;
}
const codexRoot = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "plugins", "cache");
const codexCaches = [];
let codexObserved = true;
let codexInvalid = false;
const markets = dirs(codexRoot);
if (markets === null) codexObserved = false;
for (const market of markets ?? []) {
  const versions = dirs(path.join(codexRoot, market.name, "sphica"));
  if (versions === null) {
    codexObserved = false;
    continue;
  }
  for (const version of versions) {
    const cache = path.join(codexRoot, market.name, "sphica", version.name);
    const actual = manifestVersion(cache, path.join(".codex-plugin", "plugin.json"));
    if (actual.status === "ok") codexCaches.push(actual.version);
    else if (actual.status === "unknown") codexObserved = false;
    else codexInvalid = true;
  }
}

console.log("npm package");
console.log(`  repository: ${packageVersion}`);
console.log(`  registry latest: ${tags?.latest ?? "unknown"}`);
console.log(
  `  npm i -g: ${
    globalPackage.status === "ok"
      ? globalPackage.version
      : globalPackage.status === "missing"
        ? "not found"
        : "unknown"
  }`,
);
console.log(
  `  remote tag v${tags?.latest ?? packageVersion}: ${
    remoteTags === null
      ? "unknown"
      : remoteTags.includes(`refs/tags/v${tags?.latest ?? packageVersion}`)
        ? "present"
        : "none"
  }`,
);
console.log("plugin channel");
console.log(`  marketplace: ${marketplace ?? "unknown"}`);
console.log(`  Claude manifest: ${claudeManifest}`);
console.log(`  Codex manifest: ${codexManifest}`);
console.log(`  Claude cache: ${claudeObserved ? (claudeCache ?? "not found") : "unknown"}`);
console.log(
  `  Codex cache: ${
    codexObserved
      ? codexCaches.length
        ? codexCaches.join(", ")
        : codexInvalid
          ? "no manifest"
          : "not found"
      : "unknown"
  }`,
);

// Only an admin can read these, so they are checked here with the owner's gh rather than in release.yml
const repo = attempt("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
const gh = (args) =>
  execFileSync("gh", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
const settings = repo
  ? settingsState({
      immutable: observe(gh, `repos/${repo}/immutable-releases`),
      actions: observe(gh, `repos/${repo}/actions/permissions`),
    })
  : settingsState({ immutable: { status: null, body: null }, actions: { status: null, body: null } });
console.log("repository settings");
for (const { name, state } of settings) console.log(`  ${name}: ${state}`);

const issues = [];
const unknowns = [];
for (const { name, state } of settings) {
  if (state === "off") issues.push(`${name} is off`);
  if (state === "unknown") unknowns.push(`cannot observe ${name}`);
}
if (tags && tags.latest !== packageVersion) issues.push("repository and npm latest differ");
if (tags?.latest && globalPackage.status !== "unknown" && globalPackage.version !== tags.latest) {
  issues.push("the npm i -g CLI differs from npm latest");
}
if (remoteTags !== null && !remoteTags.includes(`refs/tags/v${tags?.latest ?? packageVersion}`)) {
  issues.push("no remote tag for npm latest");
}
if (claudeManifest !== codexManifest || claudeManifest !== marketplace) {
  issues.push("plugin channel manifests and marketplace differ");
}
if (marketplace && claudeObserved && claudeCache !== marketplace) {
  issues.push("Claude cache differs from marketplace");
}
if (marketplace && codexObserved && (codexCaches.length !== 1 || codexCaches[0] !== marketplace)) {
  issues.push("Codex cache differs from marketplace");
}
if (marketplace && tags?.latest && marketplace.localeCompare(tags.latest, undefined, { numeric: true }) > 0) {
  issues.push("plugin channel is ahead of npm latest");
}
if (tags === null) unknowns.push("cannot observe npm dist-tags");
if (remoteTags === null) unknowns.push("cannot observe remote tags");
if (globalPackage.status === "unknown") unknowns.push("cannot observe the npm i -g CLI");
if (!claudeObserved) unknowns.push("cannot observe the Claude cache");
if (!codexObserved) unknowns.push("cannot observe the Codex cache");
if (issues.length) {
  console.log("remaining");
  for (const issue of issues) console.log(`  ${issue}`);
}
if (unknowns.length) {
  console.log("cannot confirm");
  for (const unknown of unknowns) console.log(`  ${unknown}`);
}
if (!issues.length && !unknowns.length) {
  console.log("release ledger is consistent");
}
if (issues.length || unknowns.length) process.exitCode = 1;
