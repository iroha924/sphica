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

const purl = (p) => `pkg:npm/${p.name.startsWith("@") ? `%40${p.name.slice(1)}` : p.name}@${p.version}`;
const component = (p) => {
  const [group, name] = p.name.startsWith("@") ? p.name.split("/") : [undefined, p.name];
  return {
    type: "library",
    "bom-ref": purl(p),
    ...(group ? { group } : {}),
    name,
    version: p.version,
    purl: purl(p),
    licenses: [{ license: { id: p.license } }],
  };
};

/**
 * The SBOM with the packages the MCP SDK carries inside its dist added as libraries, each a dependency of the SDK package that
 * carries it. Throws when that package is not in the SBOM or a package is listed already, so the result never misstates what ships.
 * @param {any} bom
 * @param {{ name: string, version: string, license: string, in: string }[]} packages
 */
export function withEmbedded(bom, packages) {
  if (bom?.bomFormat !== "CycloneDX" || !Array.isArray(bom.components))
    throw new Error("SBOM is not CycloneDX JSON");
  const components = [...bom.components];
  const dependencies = [...(bom.dependencies ?? [])];
  const named = (c) => (c.group ? `${c.group}/${c.name}` : c.name);
  for (const p of packages) {
    if (components.some((c) => named(c) === p.name && c.version === p.version))
      throw new Error(`SBOM already lists ${p.name} ${p.version}`);
    const parent = components.find((c) => named(c) === p.in);
    if (!parent?.["bom-ref"]) throw new Error(`SBOM has no ${p.in} to carry ${p.name} ${p.version}`);
    components.push(component(p));
    const i = dependencies.findIndex((d) => d.ref === parent["bom-ref"]);
    const entry = i === -1 ? { ref: parent["bom-ref"], dependsOn: [] } : dependencies[i];
    const next = { ...entry, dependsOn: [...(entry.dependsOn ?? []), purl(p)] };
    if (i === -1) dependencies.push(next);
    else dependencies[i] = next;
  }
  return { ...bom, components, dependencies };
}

/**
 * A CycloneDX SBOM of only the packages the MCP SDK carries inside its dist, for a scanner that reads lockfiles and SBOMs.
 * @param {{ name: string, version: string, license: string }[]} packages
 */
export function embeddedBom(packages) {
  return { bomFormat: "CycloneDX", specVersion: "1.6", version: 1, components: packages.map(component) };
}
