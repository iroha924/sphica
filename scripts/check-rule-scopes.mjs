#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Checks that the `paths` of `.claude/rules/*.md` load a rule for the files it should and not for files it should not.
//
// **Do not put expectations in rule frontmatter.** The only documented key is `paths`, and the docs do not say whether
// custom keys are ignored or warned about. The expectations live here as a table.
//
// A rule with paths loads when Claude reads a matching file (per the official memory docs).
// Paths that are too broad eat context during unrelated work; too narrow and the rule does not load when needed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { finding, guard, report } from "./lib/finding.mjs";

guard("rule scopes", () => failures);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rulesDirectory = path.join(root, ".claude", "rules");
const SELF = "scripts/check-rule-scopes.mjs";
const at = (file) => `.claude/rules/${file}`;

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
function toRegExp(glob, file) {
  // **Unsupported syntax never passes silently.** Bracket expressions `[]` work in Claude,
  // but they are not implemented here, so failing beats misjudging.
  if (/[[\]]/.test(glob)) {
    failures.push(
      finding({
        where: at(file),
        what: `the paths entry ${glob} holds a bracket expression`,
        why: "this check cannot read bracket expressions, so it could not tell which files load the rule",
        fix: "list the alternatives with braces ({a,b}) or as separate entries",
      }),
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
    failures.push(
      finding({
        where: at(file),
        what: "the frontmatter is not closed",
        why: "the paths cannot be read from it, so neither this check nor a reader can tell where the rule loads",
        fix: "end the frontmatter with a line of three dashes",
      }),
    );
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
      finding({
        where: SELF,
        what: `${name} has expectations, but .claude/rules/${name} does not exist`,
        why: "an expectation for a missing rule checks nothing and hides that the rule is gone",
        fix: `remove ${name} from EXPECTED or ALWAYS if the rule was deleted, or restore the rule`,
      }),
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
        finding({
          where: at(file),
          what: "the rule has no paths, so it loads in every session",
          why: "a rule loaded for unrelated work takes context from it",
          fix: `give it paths, or add it to ALWAYS in ${SELF} with the reason every file needs it`,
        }),
      );
    }
    continue;
  }
  scoped.push(file);
  if (globs.length === 0) {
    failures.push(
      finding({
        where: at(file),
        what: "paths is empty",
        why: "a rule whose paths match nothing never loads",
        fix: "list the globs of the files the rule is for, or remove paths to load it always",
      }),
    );
    continue;
  }

  const expected = EXPECTED[file];
  if (!expected) {
    failures.push(
      finding({
        where: at(file),
        what: "the rule has paths but no expectations",
        why: "paths that are too broad or too narrow go unseen without real files to test them against",
        fix: `add the rule to EXPECTED in ${SELF} with files it must load for and files it must not`,
      }),
    );
    continue;
  }
  const patterns = globs.map((g) => toRegExp(g, file));
  const hits = (target) => patterns.some((p) => p.test(target));

  const missing = (target) =>
    finding({
      where: SELF,
      what: `the expectation for ${file} names ${target}, which does not exist`,
      why: "an expectation on a missing file tests the paths against nothing",
      fix: `replace ${target} with a file that exists, or remove it`,
    });
  for (const target of expected.match) {
    if (!fs.existsSync(path.join(root, target))) failures.push(missing(target));
    else if (!hits(target))
      failures.push(
        finding({
          where: at(file),
          what: `paths does not match ${target}, which the rule must load for`,
          why: "Claude Code loads a rule with paths only when it reads a matching file, so the rule would be missing there",
          fix: `widen paths to cover ${target}, or move it to notMatch in ${SELF} if the rule is not for it`,
        }),
      );
  }
  for (const target of expected.notMatch) {
    if (!fs.existsSync(path.join(root, target))) failures.push(missing(target));
    else if (hits(target))
      failures.push(
        finding({
          where: at(file),
          what: `paths matches ${target}, which the rule must not load for`,
          why: "a rule loaded for unrelated work takes context from it",
          fix: `narrow paths to leave ${target} out, or move it to match in ${SELF} if the rule is for it`,
        }),
      );
  }
}

if (!report("rule scopes", failures))
  console.log(`rule scopes: ${scoped.length} with paths / ${always.length} always loaded`);
