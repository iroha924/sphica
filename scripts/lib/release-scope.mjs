// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Decides whether a change needs a release. If it does, every place VERSION_SOURCES names moves to the same version (kind plugin).
// The version gate, the release plan, and manual release preparation all use this decision.
// README.md is not listed: bundle copies it into the tarball, but a change to it alone ships with the next release.

export const EXACT_PACKAGE_INPUTS = new Set([
  "server/package.json",
  "server/bun.lock",
  "server/tsconfig.json",
  "scripts/bundle.mjs",
  "scripts/third-party-notices.mjs",
  // Changing the source (such as the npm package name) changes what users install
  ".claude-plugin/marketplace.json",
]);

export const PACKAGE_PREFIXES = ["plugin/", "server/src/", "db/", "scripts/licenses/"];

const entry = (j, name) => (Array.isArray(j?.plugins) ? j.plugins.find((x) => x?.name === name) : undefined);

/**
 * Every place a release writes its version, by name: the npm package and the 3 plugin channel manifests.
 * A release moves them all to one version; each check reads them from here.
 */
export const VERSION_SOURCES = {
  package: { file: "plugin/package.json", pick: (j) => j?.version },
  claude: { file: "plugin/.claude-plugin/plugin.json", pick: (j) => j?.version },
  codex: { file: "plugin/.codex-plugin/plugin.json", pick: (j) => j?.version },
  // The version lives in the entry's source: a version in the entry too makes Claude Code prefer plugin.json without a word
  marketplace: { file: ".claude-plugin/marketplace.json", pick: (j) => entry(j, "sphica")?.source?.version },
};

/** The files VERSION_SOURCES reads, each once */
export const VERSION_FILES = new Set(Object.values(VERSION_SOURCES).map((v) => v.file));

/** Each VERSION_SOURCES name with the version read through `read(file)` (parsed JSON), undefined where it is missing */
export function releaseVersions(read) {
  return Object.fromEntries(Object.entries(VERSION_SOURCES).map(([name, v]) => [name, v.pick(read(v.file))]));
}

/** Package inputs whose change ships nothing new unless the packed tarball shows it (scripts/check-mcp-version.mjs --verdict) */
export const DEPENDENCY_INPUTS = new Set(["server/package.json", "server/bun.lock"]);

export function isPackageInput(file) {
  return EXACT_PACKAGE_INPUTS.has(file) || PACKAGE_PREFIXES.some((prefix) => file.startsWith(prefix));
}

export function releaseKind(files) {
  const inputs = files.filter(isPackageInput);
  return inputs.length === 0 ? "none" : "plugin";
}

export function withoutReleaseVersion(text) {
  if (text === null) return null;
  try {
    const value = JSON.parse(text);
    delete value.version;
    for (const plugin of Array.isArray(value.plugins) ? value.plugins : []) {
      delete plugin.version;
      if (plugin.source && typeof plugin.source === "object") delete plugin.source.version;
    }
    return JSON.stringify(value);
  } catch {
    return text;
  }
}
