// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Checks that the SBOM (CycloneDX) lists every bundled dependency. The source of truth is the table in THIRD_PARTY_NOTICES.md
// (built from node_modules by scripts/third-party-notices.mjs). Missing or extra entries both misstate what ships.

/** Packages and versions from the THIRD_PARTY_NOTICES.md table, plus malformed rows. Malformed rows are never silently skipped. */
function noticed(text) {
  const out = new Set();
  const broken = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("|") || /^\| package \|/.test(line) || /^\|[-| ]+\|$/.test(line)) continue;
    const m = /^\| (\S+) \| (\S+) \| [^|]+ \|$/.exec(line);
    if (m) out.add(`${m[1]} ${m[2]}`);
    else broken.push(line);
  }
  return { out, broken };
}

/** Problems found by the comparison. Empty means it passes. */
export function sbomProblems(noticesText, bom) {
  if (bom?.bomFormat !== "CycloneDX" || !Array.isArray(bom.components)) return ["SBOM is not CycloneDX JSON"];
  const { out: want, broken } = noticed(noticesText);
  if (broken.length) return broken.map((l) => `cannot read a THIRD_PARTY_NOTICES.md table row: ${l}`);
  if (want.size === 0) return ["cannot read any packages from THIRD_PARTY_NOTICES.md"];
  const have = new Set(
    bom.components
      .filter((c) => c.type === "library")
      .map((c) => `${c.group ? `${c.group}/${c.name}` : c.name} ${c.version}`),
  );
  return [
    ...[...want].filter((p) => !have.has(p)).map((p) => `SBOM is missing ${p}`),
    ...[...have].filter((p) => !want.has(p)).map((p) => `SBOM lists ${p}, which is not bundled`),
  ];
}
