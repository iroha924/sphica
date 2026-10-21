#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Keeps English-only files free of Japanese. sphica is moving to English one area at a time,
// and a file that was translated drifts back unless something stops it.
//
// Records that users write stay in their own language. Only the text sphica itself writes is checked.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { englishProblems, JAPANESE } from "./lib/english.mjs";
import { finding, guard, report } from "./lib/finding.mjs";

guard("english");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every file under dir whose name matches re, as a repository path. New files are checked without being listed. */
const filesUnder = (dir, re) =>
  fs
    .readdirSync(path.join(root, dir), { recursive: true })
    .map((f) => `${dir}/${f.split(path.sep).join("/")}`)
    .filter((f) => re.test(f))
    // Symlinked directories (.claude/skills -> .agents/skills) would list the same file twice; keep only the real path.
    .filter((f) => fs.realpathSync(path.join(root, f)) === path.join(fs.realpathSync(root), f))
    .sort();

/** Strings, templates, and comments must be English. Grows with each translation stage. */
const ENGLISH = [
  ...filesUnder("server/src", /\.tsx?$/),
  ...filesUnder("scripts", /\.(c?js|mjs|m?ts|tsx)$/),
  "server/test/assets.test.ts",
  "server/test/check-mcp-version.test.ts",
  "server/test/comments-check.test.ts",
  "server/test/plugin.test.ts",
  "server/test/project.test.ts",
  "server/test/release-gate.test.ts",
  "server/test/release-scope.test.ts",
  "server/test/sbom.test.ts",
  "server/test/tarball.test.ts",
  "server/test/temp-db.ts",
  "server/test/temp-repo.ts",
  "server/test/acceptance-cases.test.ts",
  "server/evals/acceptance/load.ts",
  "server/evals/acceptance/run.ts",
  "server/evals/acceptance/cases-run.ts",
  "server/evals/acceptance/driver.ts",
];

/** Comments must be English. Tests keep Japanese fixtures, and evals keep their measured prompts. */
const COMMENTS = [
  ...[...filesUnder("server/test", /\.ts$/), ...filesUnder("server/evals", /\.ts$/)].filter(
    (f) => !ENGLISH.includes(f),
  ),
];

/** Markdown, YAML, SQL, JSON, and config files Sphica writes. Checked line by line, since they are not JavaScript. */
const TEXT = [
  ...filesUnder("plugin/skills", /\.(md|json|ya?ml)$/),
  ".github/pull_request_template.md",
  ...filesUnder(".github/ISSUE_TEMPLATE", /\.(md|ya?ml)$/),
  ...filesUnder(".github/workflows", /\.ya?ml$/),
  ".github/dependabot.yml",
  ".gitignore",
  "lefthook.yml",
  "renovate.json",
  "server/bunfig.toml",
  "tools/mutation/bunfig.toml",
  "db/schema.sql",
  "CLAUDE.md",
  "AGENTS.md",
  ...filesUnder(".claude/rules", /\.md$/),
  ...filesUnder(".claude/agents", /\.md$/),
  ...filesUnder(".claude/skills", /\.md$/),
  ...filesUnder(".agents/skills", /\.(md|ya?ml)$/),
];

/** A comment line (`#`, `--`, `//`, or `<!-- -->`) that allows Japanese on the next line. The reason is required. */
const TEXT_EXEMPT = /^\s*(?:#|--|\/\/|<!--)\s*english-exempt:\s*\S/;

/** Japanese outside exempted lines, plus markers with no Japanese on the next line. */
function textProblems(source) {
  const lines = source.split(/\r?\n/);
  const problems = [];
  lines.forEach((line, i) => {
    const marked = TEXT_EXEMPT.test(lines[i - 1] ?? "");
    if (TEXT_EXEMPT.test(line) && !JAPANESE.test(lines[i + 1] ?? ""))
      problems.push({
        line: i + 1,
        text: "english-exempt",
        reason: "exemption with no Japanese on the next line",
      });
    if (JAPANESE.test(line) && !marked && !TEXT_EXEMPT.test(line))
      problems.push({ line: i + 1, text: line.trim().slice(0, 80), reason: "Japanese text" });
  });
  return problems;
}

const WHY =
  "Sphica writes its own code, strings, comments, and documents in English, file by file (invariant english-code)";
const FIX = {
  all: "write it in English, or put `// english-exempt: <reason>` on the line before a Japanese literal the code needs",
  comments:
    "write the comment in English; Japanese stays only in strings, as test fixtures and measured prompts",
  text: "write it in English, or put an `english-exempt: <reason>` comment (#, --, //, or <!--) on the line before one that must stay",
};
const STALE = {
  what: "an english-exempt marker has no Japanese on the next line",
  why: "a marker left behind would let Japanese written there later pass unseen",
  fix: "remove the marker, or move it to the line just before the Japanese it exempts",
};

const toFinding = (file, mode) => (p) =>
  p.reason === "Japanese text"
    ? finding({ where: `${file}:${p.line}`, what: `Japanese text: ${p.text}`, why: WHY, fix: FIX[mode] })
    : finding({ where: `${file}:${p.line}`, ...STALE });

const fail = [
  ...TEXT.flatMap((file) =>
    textProblems(fs.readFileSync(path.join(root, file), "utf8")).map(toFinding(file, "text")),
  ),
  ...[
    [ENGLISH, "all"],
    [COMMENTS, "comments"],
  ].flatMap(([files, mode]) =>
    files.flatMap((file) =>
      englishProblems(fs.readFileSync(path.join(root, file), "utf8"), mode).map(toFinding(file, mode)),
    ),
  ),
];
if (!report("english", fail))
  console.log(
    `english: ${ENGLISH.length} English-only files, ${COMMENTS.length} files with English comments, ${TEXT.length} text files`,
  );
