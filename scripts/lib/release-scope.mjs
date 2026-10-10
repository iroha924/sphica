// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Decides whether a change goes into the npm package. If it does, npm and the 3 plugin channel manifests move to the same version (kind plugin).
// The version gate, the release plan, and manual release preparation all use this decision.

export const EXACT_PACKAGE_INPUTS = new Set([
  "server/package.json",
  "server/bun.lock",
  "server/tsconfig.json",
  "scripts/bundle.mjs",
  "scripts/third-party-notices.mjs",
  // Changing the source (such as the npm package name) changes what users install
  ".claude-plugin/marketplace.json",
  // bundle copies it to plugin/README.md, and it shows on the npm package page
  "README.md",
]);

export const PACKAGE_PREFIXES = ["plugin/", "server/src/", "db/", "scripts/licenses/"];

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
