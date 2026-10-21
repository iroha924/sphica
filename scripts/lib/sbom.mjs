// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Checks that the SBOM (CycloneDX) lists every bundled dependency. The source of truth is the table in THIRD_PARTY_NOTICES.md
// (built from node_modules by scripts/third-party-notices.mjs). Missing or extra entries both misstate what ships.

import { finding } from "./finding.mjs";

/** Packages and versions from the THIRD_PARTY_NOTICES.md table, plus malformed rows. Malformed rows are never silently skipped. */
function noticed(text) {
  const out = new Set();
  const broken = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("|") || line.startsWith("| package |") || /^\|[-| ]+\|$/.test(line)) continue;
    const m = /^\| (\S+) \| (\S+) \| [^|]+ \|$/.exec(line);
    if (m) out.add(`${m[1]} ${m[2]}`);
    else broken.push(line);
  }
  return { out, broken };
}

const NOTICES = "plugin/THIRD_PARTY_NOTICES.md";
const REBUILD_NOTICES =
  "rebuild the table with `node scripts/third-party-notices.mjs` (it reads the bundled node_modules)";
const SAME_LIST =
  "the SBOM and the notices must list exactly what ships, or the release misstates its supply chain";

/** Findings of the comparison of the SBOM at `file` with the notices table. Empty means it passes. */
export function sbomProblems(noticesText, bom, file) {
  if (bom?.bomFormat !== "CycloneDX" || !Array.isArray(bom.components))
    return [
      finding({
        where: file,
        what: "the SBOM is not CycloneDX JSON with a components list",
        why: "the comparison reads CycloneDX components, so another format would compare nothing",
        fix: "pass the cyclonedx-json file the release workflow's sbom job builds with syft",
      }),
    ];
  const { out: want, broken } = noticed(noticesText);
  if (broken.length)
    return broken.map((l) =>
      finding({
        where: NOTICES,
        what: `a table row cannot be read: ${l}`,
        why: "a row left out of the comparison would let a bundled package go unlisted",
        fix: REBUILD_NOTICES,
      }),
    );
  if (want.size === 0)
    return [
      finding({
        where: NOTICES,
        what: "no packages can be read from the table",
        why: "an empty list would make the comparison pass while comparing nothing",
        fix: REBUILD_NOTICES,
      }),
    ];
  const have = new Set(
    bom.components
      .filter((c) => c.type === "library")
      .map((c) => `${c.group ? `${c.group}/${c.name}` : c.name} ${c.version}`),
  );
  return [
    ...[...want]
      .filter((p) => !have.has(p))
      .map((p) =>
        finding({
          where: file,
          what: `the SBOM is missing ${p}, which ${NOTICES} lists as bundled`,
          why: SAME_LIST,
          fix: `check that server/bun.lock pins ${p} as the bundle uses it, then ${REBUILD_NOTICES}`,
        }),
      ),
    ...[...have]
      .filter((p) => !want.has(p))
      .map((p) =>
        finding({
          where: file,
          what: `the SBOM lists ${p}, which ${NOTICES} does not list as bundled`,
          why: SAME_LIST,
          fix: `${REBUILD_NOTICES}, or remove ${p} from server/package.json if nothing bundles it`,
        }),
      ),
  ];
}
