#!/usr/bin/env node
// Checks that the `paths` of `.claude/rules/*.md` load a rule for the files it should and not for files it should not.
//
// **Do not put expectations in rule frontmatter.** The only documented key is `paths`, and the docs do not say whether
// custom keys are ignored or warned about. The expectations live here as a table.
//
// A rule with paths loads when Claude reads a matching file (per the official memory docs).
// Paths that are too broad eat context during unrelated work; too narrow and the rule does not load when needed.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rulesDirectory = path.join(root, ".claude", "rules");

/** Real files each rule must load for, and real files it must not. **List only paths that exist.** */
const EXPECTED = {
  "comments.md": {
    match: [
      "server/src/db.ts",
      "server/src/cli/view.ts",
      "scripts/bundle.mjs",
      "lefthook.yml",
      "db/schema.sql",
    ],
    notMatch: ["README.md", "AGENTS.md", "package.json"],
  },
};

/** Rules without paths. They always load, so their number and reasons are pinned. */
const ALWAYS = {
  "verification.md": "tests and package checks are needed whatever file is touched",
};

/** Converts a glob to a regex. `**` crosses directories, and `*` stays within one. */
function toRegExp(glob) {
  // **Unsupported syntax never passes silently.** Bracket expressions `[]` work in Claude,
  // but they are not implemented here, so failing beats misjudging.
  if (/[[\]]/.test(glob)) {
    failures.push(
      `paths entry ${glob} contains a bracket expression. This check does not support it, so do not use it`,
    );
    return /$^/;
  }
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more directories, and a trailing `**` matches anything
        if (glob[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (c === "{") {
      const close = glob.indexOf("}", i);
      if (close !== -1) {
        out += `(?:${glob
          .slice(i + 1, close)
          .split(",")
          .map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&"))
          .join("|")})`;
        i = close;
        continue;
      }
    }
    out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function frontmatterPaths(source, file) {
  if (!source.startsWith("---\n")) return null;
  const end = source.indexOf("\n---\n", 4);
  if (end === -1) {
    failures.push(`${file}: frontmatter is not closed`);
    return null;
  }
  const lines = source.slice(4, end).split("\n");
  if (!lines.some((l) => l.trim() === "paths:")) return null;
  const globs = [];
  let inPaths = false;
  for (const line of lines) {
    if (line.trim() === "paths:") {
      inPaths = true;
      continue;
    }
    if (inPaths) {
      const m = /^\s*-\s*["']?([^"']+)["']?\s*$/.exec(line);
      if (m) {
        globs.push(m[1]);
        continue;
      }
      if (line.trim() !== "") break;
    }
  }
  return globs;
}

const failures = [];

/** `.claude/rules/` is searched recursively (per the docs). Rules in subdirectories follow the same checks. */
function walk(directory, prefix = "") {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const next = path.join(directory, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return walk(next, relative);
    return entry.name.endsWith(".md") ? [relative] : [];
  });
}
const files = walk(rulesDirectory);

// **Expectations and real files must match exactly.** Checking only one side lets a deleted rule pass with a stale expectation.
const declared = new Set([...Object.keys(EXPECTED), ...Object.keys(ALWAYS)]);
for (const name of declared) {
  if (!files.includes(name)) {
    failures.push(
      `${name}: listed in the expectations but missing from .claude/rules/. If you deleted it, remove the expectation too`,
    );
  }
}
const scoped = [];
const always = [];

for (const file of files) {
  const source = fs.readFileSync(path.join(rulesDirectory, file), "utf8").replaceAll("\r\n", "\n");
  const globs = frontmatterPaths(source, file);

  if (globs === null) {
    always.push(file);
    if (!ALWAYS[file]) {
      failures.push(
        `${file}: has no paths, so it always loads. If every file needs it, add it with a reason to ALWAYS in ` +
          "scripts/check-rule-scopes.mjs. Otherwise give it paths",
      );
    }
    continue;
  }
  scoped.push(file);
  if (globs.length === 0) {
    failures.push(`${file}: paths is empty`);
    continue;
  }

  const expected = EXPECTED[file];
  if (!expected) {
    failures.push(`${file}: add its expectations to EXPECTED in scripts/check-rule-scopes.mjs`);
    continue;
  }
  const patterns = globs.map(toRegExp);
  const hits = (target) => patterns.some((p) => p.test(target));

  for (const target of expected.match) {
    if (!fs.existsSync(path.join(root, target))) {
      failures.push(`${file}: expected file ${target} does not exist`);
      continue;
    }
    if (!hits(target)) failures.push(`${file}: should load for ${target}, but paths does not match it`);
  }
  for (const target of expected.notMatch) {
    if (!fs.existsSync(path.join(root, target))) {
      failures.push(`${file}: expected file ${target} does not exist`);
      continue;
    }
    if (hits(target)) failures.push(`${file}: must not load for ${target}, but paths matches it`);
  }
}

if (failures.length > 0) {
  console.error(failures.map((f) => `- ${f}`).join("\n"));
  process.exit(1);
}

console.log(`rule scopes: ${scoped.length} with paths / ${always.length} always loaded`);
