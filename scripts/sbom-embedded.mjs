#!/usr/bin/env node
// Adds the packages the MCP SDK carries inside its dist to a release SBOM, or writes an SBOM of only those for the vulnerability scan.
// Usage: node scripts/sbom-embedded.mjs <in.cdx.json> <out.cdx.json> | --only-embedded <out.cdx.json>

import fs from "node:fs";
import { embeddedPackages } from "./lib/embedded.mjs";
import { embeddedBom, withEmbedded } from "./lib/sbom.mjs";

const args = process.argv.slice(2);
const { packages, problems } = embeddedPackages();
if (problems.length || packages.length === 0) {
  console.error(problems.length ? problems.join("\n") : "scripts/licenses/embedded lists no packages");
  process.exit(1);
}
if (args[0] === "--only-embedded" && args[1]) {
  fs.writeFileSync(args[1], `${JSON.stringify(embeddedBom(packages), null, 2)}\n`);
} else if (args.length === 2) {
  const bom = withEmbedded(JSON.parse(fs.readFileSync(args[0], "utf8")), packages);
  fs.writeFileSync(args[1], `${JSON.stringify(bom, null, 2)}\n`);
} else {
  console.error(
    "usage: node scripts/sbom-embedded.mjs <in.cdx.json> <out.cdx.json> | --only-embedded <out.cdx.json>",
  );
  process.exit(1);
}
console.log(`SBOM: ${packages.length} packages the MCP SDK carries in its dist`);
