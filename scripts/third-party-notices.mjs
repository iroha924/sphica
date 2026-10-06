#!/usr/bin/env node
// Collects the copyright notices and license texts of bundled dependencies.
//
// **Bundling into one file does not remove the obligation to include them.** MIT requires the copyright notice and permission notice,
// and Apache-2.0 section 4 requires a copy of the License and the NOTICE contents, if any. The package ships the following, so they apply.
//
//   dist/{cli,mcp,capture}.js  the server's dependencies, bundled
//
// **Do not drop optional dependencies.** Assuming they are not included would miss ones that are bundled.
// Err toward listing more: only listing too few violates the obligation. Peer dependencies are listed only when resolved in node_modules.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { embeddedPackages } from "./lib/embedded.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Workspaces whose code is bundled. */
const WORKSPACES = ["server"];

const read = (p) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

/**
 * Resolves name starting from from. Like node's resolution, it searches the nearest node_modules and moves up.
 * Several versions of one name can coexist (such as nested chalk 4 and 5), so counting anything but the resolved copy would list a version that does not ship.
 */
const resolveFrom = (from, name) => {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const cand = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(cand, "package.json"))) return cand;
    if (path.dirname(dir) === dir || dir === root) return null;
  }
};
const manifestAt = (dir) => {
  const raw = dir && read(path.join(dir, "package.json"));
  return raw ? JSON.parse(raw) : null;
};

// Transitive closure, counted by resolved path (different versions of one name are not merged).
// Follows both dependencies and optionalDependencies.
const seen = new Map();
const queue = [];
for (const w of WORKSPACES) {
  const base = path.join(root, w);
  const p = JSON.parse(read(path.join(base, "package.json")));
  for (const n of Object.keys({ ...p.dependencies, ...p.optionalDependencies })) queue.push([base, n]);
}
while (queue.length) {
  const [from, name] = queue.shift();
  const dir = resolveFrom(from, name);
  if (!dir || seen.has(dir)) continue; // unresolved optional or peer dependencies are not in the output either
  const m = manifestAt(dir);
  if (!m) continue;
  seen.set(dir, name);
  for (const n of Object.keys({ ...m.dependencies, ...m.optionalDependencies })) queue.push([dir, n]);
}

/**
 * The license text the package ships.
 * **Check the README too.** Some packages keep the text only in their README,
 * and looking only for LICENSE files would lose the text and leave only a source URL.
 */
// **Do not list fixed names.** Spellings vary, such as `LICENSE-MIT.txt`, `LICENSE.BSD`, and `LICENCE`,
// and a fixed list misses some (measured: it missed 6 packages). Match names starting with licen or copying.
const LICENSE_NAME = /^(licen[cs]e|copying)([-._].*)?$/i;
const README_FILES = ["README.md", "Readme.md", "readme.md", "README"];

/** Extracts only the license section from a README, from its heading to the next heading of the same level. */
function fromReadme(dir) {
  for (const f of README_FILES) {
    const text = read(path.join(dir, f));
    if (!text) continue;
    const m = text.match(/^(#{1,6})\s*(?:The\s+)?(?:MIT\s+)?Licen[cs]e.*$/im);
    if (!m) continue;
    const start = m.index + m[0].length;
    const rest = text.slice(start);
    const next = rest.search(new RegExp(`^#{1,${m[1].length}}\\s`, "m"));
    const body = (next === -1 ? rest : rest.slice(0, next)).trim();
    // A bare "MIT" does not count as the text. The actual permission notice must be there.
    if (body.length > 200 && /permission is hereby granted|copyright/i.test(body)) return body;
  }
  return null;
}

const licenseText = (dir) => {
  if (!dir) return null;
  let names = [];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return null;
  }
  // When there are several (such as dual licensing with LICENSE-MIT and LICENSE-APACHE), include all of them.
  const found = names.filter((f) => LICENSE_NAME.test(f)).sort();
  const texts = found.map((f) => ({ f, t: read(path.join(dir, f))?.trim() })).filter((x) => x.t);
  if (texts.length) {
    return {
      text: texts.map((x) => (texts.length > 1 ? `--- ${x.f} ---\n${x.t}` : x.t)).join("\n\n"),
      from: texts.map((x) => x.f).join(" / "),
    };
  }
  const readme = fromReadme(dir);
  return readme ? { text: readme, from: "README" } : null;
};

/** The NOTICE contents that Apache-2.0 section 4(d) requires. */
const noticeText = (dir) => read(path.join(dir, "NOTICE"))?.trim() ?? null;

/**
 * Copies for packages that ship no license text.
 * **Apache-2.0 section 4(a) requires giving a copy of the License**, so the redistributor provides one even if the package does not.
 * It is the ASF template itself (with the Appendix copyright line left as a template);
 * **never a copy where some package filled in its own name**, which would put that name in another rights holder's section.
 */
const SPARE = path.join(path.dirname(fileURLToPath(import.meta.url)), "licenses");
const spareText = (spdx) => read(path.join(SPARE, `${spdx}.txt`))?.trim() ?? null;

const source = (m) => {
  const r = typeof m?.repository === "string" ? m.repository : m?.repository?.url;
  return (
    r
      ?.replace(/^git\+/, "")
      .replace(/^git:\/\//, "https://")
      .replace(/\.git$/, "") ?? null
  );
};

const entries = [...seen]
  .map(([dir, name]) => ({ dir, name }))
  .sort((a, b) => a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir))
  .map(({ dir, name }) => {
    const m = manifestAt(dir);
    const spdx = typeof m?.license === "string" ? m.license : (m?.license?.type ?? "unknown");
    const own = licenseText(dir);
    const spare = own ? null : spareText(spdx);
    return {
      name,
      version: m?.version ?? "unknown",
      spdx,
      text: own?.text ?? spare,
      from: own?.from ?? (spare ? `${spdx} template` : null),
      notice: noticeText(dir),
      source: source(m),
    };
  });

// Packages the MCP SDK carries inside its dist ship as bundled code too, though npm lists none of them as dependencies
const embedded = embeddedPackages();
for (const p of embedded.packages)
  entries.push({
    name: p.name,
    version: p.version,
    spdx: p.license,
    text: p.text,
    from: "LICENSE",
    notice: null,
    source: p.source,
  });
if (embedded.problems.length) {
  console.error(embedded.problems.join("\n"));
  process.exit(1);
}

const missing = entries.filter((e) => !e.text);
const out = [
  "# Third-party software included",
  "",
  "The package includes code and fonts from the following packages. Copyright belongs to each rights holder,",
  "and the licenses are listed below. sphica's own license is in `LICENSE` (MIT).",
  "",
  "This file is generated by `node scripts/third-party-notices.mjs`. Do not edit it by hand.",
  "",
  "| package | version | license |",
  "|---|---|---|",
  ...entries.map((e) => `| ${e.name} | ${e.version} | ${e.spdx} |`),
  "",
];
for (const e of entries) {
  out.push(`## ${e.name} ${e.version}`, "", `SPDX: ${e.spdx}`);
  if (e.source) out.push(`Source: ${e.source}`);
  out.push("");
  if (e.notice) out.push("NOTICE:", "", "```", e.notice, "```", "");
  if (e.from === `${e.spdx} template`) {
    out.push(
      `_This package ships no license text with a copyright notice (declared as ${e.spdx}). ` +
        `The ${e.spdx} template is included. Copyright belongs to the rights holder at the source above._`,
      "",
    );
  }
  if (e.text) out.push("```", e.text, "```");
  out.push("");
}

const dest = path.join(root, "plugin", "THIRD_PARTY_NOTICES.md");
fs.writeFileSync(dest, `${out.join("\n").trimEnd()}\n`);
console.log(`third-party notices: ${entries.length} packages`);

// **Fail if even one text is missing.** Pointing to a source URL does not replace including the text.
if (missing.length) {
  console.error(
    [
      `${missing.length} packages have no license text.`,
      "",
      ...missing.map((e) => `  ${e.name}@${e.version}  ${e.spdx}  ${e.source ?? ""}`),
      "",
      "  If the package's own LICENSE or README has none, put the SPDX template in",
      "  scripts/licenses/<SPDX>.txt (one without a filled-in copyright holder).",
    ].join("\n"),
  );
  process.exit(1);
}
const unknown = entries.filter((e) => e.spdx === "unknown");
if (unknown.length) {
  console.error(`cannot read the license of some packages: ${unknown.map((e) => e.name).join(", ")}`);
  process.exit(1);
}
