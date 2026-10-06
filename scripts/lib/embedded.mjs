// Packages the MCP SDK carries inside its own dist files. npm lists none of them as dependencies, so the notices and the SBOM learn
// of them only from scripts/licenses/embedded/index.json, and this check holds that list to what the bundles really contain.

import fs from "node:fs";
import path from "node:path";

const DIR = path.join(import.meta.dirname, "..", "licenses", "embedded");

/**
 * The listed packages, each with its license text, or the problems found reading them. A listed package without its text is a problem.
 * @param {string} dir
 * @returns {{ packages: { name: string, version: string, license: string, source: string, in: string, text: string }[], problems: string[] }}
 */
export function embeddedPackages(dir = DIR) {
  const problems = [];
  let list;
  try {
    list = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
  } catch (e) {
    return { packages: [], problems: [`cannot read ${path.join(dir, "index.json")}: ${e.message}`] };
  }
  const packages = [];
  for (const p of list) {
    const file = path.join(dir, `${p.name.replace("/", "+")}@${p.version}.txt`);
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8").trim();
    } catch {}
    if (!text) problems.push(`${p.name} ${p.version} has no license text in ${file}`);
    else packages.push({ ...p, text });
  }
  return { packages, problems };
}

// The bundler that builds the SDK's dist opens each source module with a region comment naming its pnpm store directory
const MARKER = /^\/\/#region (?:\.\.\/)*node_modules\/\.pnpm\/((?:@[^/+]+\+)?[^/@]+)@([^/_]+)/gm;

/**
 * "name version" for every package a dist file's region comments name, with pnpm's peer suffix (`_ajv@8.18.0`) left out.
 * @param {string} text
 */
export function markedPackages(text) {
  return new Set([...text.matchAll(MARKER)].map((m) => `${m[1].replace("+", "/")} ${m[2]}`));
}

/**
 * Problems with the list against the bundles: a package a bundled SDK file carries but the list lacks, or one listed but not bundled.
 * metas maps each entry to its parsed metafile (null when missing), read is how a metafile input's text is read.
 * @param {Record<string, unknown>} metas
 * @param {(input: string) => string} read
 * @param {{ name: string, version: string }[]} listed
 */
export function embeddedProblems(metas, read, listed) {
  const problems = [];
  const found = new Set();
  for (const [entry, meta] of Object.entries(metas)) {
    const outputs = meta && typeof meta === "object" ? meta.outputs : undefined;
    if (!outputs || typeof outputs !== "object") {
      problems.push(`${entry}: no metafile to find the SDK's embedded packages in`);
      continue;
    }
    for (const out of Object.values(outputs))
      for (const input of Object.keys(out?.inputs ?? {}))
        if (/node_modules\/@modelcontextprotocol\/[^/]+\/dist\//.test(input.replaceAll("\\", "/")))
          for (const p of markedPackages(read(input))) found.add(p);
  }
  const want = new Set(listed.map((p) => `${p.name} ${p.version}`));
  for (const p of found)
    if (!want.has(p))
      problems.push(`the bundles carry ${p} inside the MCP SDK, but scripts/licenses/embedded lacks it`);
  for (const p of want)
    if (!found.has(p)) problems.push(`scripts/licenses/embedded lists ${p}, which no bundle carries`);
  return problems;
}
