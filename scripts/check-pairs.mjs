#!/usr/bin/env node
// Compares places where the same knowledge is copied into several interfaces.
//
// Fixing only one interface goes unnoticed, because the other still works.
//
// **Only pairs that can be listed as sets are handled.** Whether prose matches cannot be judged through wording
// differences, so those copies are removed instead of compared (the README has no CLI list and points to `sphica --help`). Pairs that are not sets
// (the same check at each stage of a path, the same data built in different shapes by two interfaces) are not caught here. A section in AGENTS.md covers them.

import fs from "node:fs";

const read = (f) => fs.readFileSync(f, "utf8");
const fail = [];

// **Never pass silently when extraction fails.** If a regex drifts from the real file, extraction finds nothing
// and reads as no difference. Report a broken check as loudly as a difference.
const grab = (file, re, what) => {
  const m = read(file).match(re);
  if (!m?.[1]) {
    fail.push(`cannot extract ${what} from ${file}. The regex in check-pairs.mjs has drifted from the file`);
    return null;
  }
  return m[1];
};
/** Lists the quoted words. Finding none is reported as an extraction failure. */
const words = (text, quote, what) => {
  const got = [...(text ?? "").matchAll(new RegExp(`${quote}([a-z_-]+)${quote}`, "g"))].map((m) => m[1]);
  if (text !== null && got.length === 0) fail.push(`cannot extract any values from ${what}`);
  return got;
};
const same = (a, b) => [...a].sort().join() === [...b].sort().join();

// ---- Value domains match between the database CHECKs and the code ----
//
// The source of truth is the CHECKs in db/schema.sql. The copy in code (server/src/knowledge.ts) is used by capture, the save paths,
// and search filters. **Catches adding to one side and forgetting the other.** Adding only to the code makes saves fail the CHECK;
// adding only to the database leaves values the code never writes or filters on
// (a real case: files that were Read were sent as action 'read', the CHECK allowed only edit / review, and capture stopped).
const PAIRS = [
  ["unit.kind", /kind text not null check \(kind in \(('decision'[^)]*)\)\)/, "UNIT_KINDS"],
  ["unit.stance", /stance text check \(stance in \(([^)]*)\)\)/, "STANCES"],
  [
    "unit.lifecycle",
    /lifecycle text not null default 'candidate' check \(lifecycle in \(([^)]*)\)\)/,
    "LIFECYCLES",
  ],
  [
    "unit_option.outcome",
    /outcome text not null check \(outcome in \(('chosen'[^)]*)\)\)/,
    "OPTION_OUTCOMES",
  ],
  ["session.host", /host text not null check \(host in \(([^)]*)\)\)/, "HOSTS"],
  ["unit_evidence.role", /role text not null check \(role in \(('states'[^)]*)\)\)/, "EVIDENCE_ROLES"],
  ["work.status", /status text not null check \(status in \(('active', 'blocked'[^)]*)\)\)/, "WORK_STATUSES"],
  ["source.kind", /kind text not null check \(kind in \(('session_message'[^)]*)\)\)/, "SOURCE_KINDS"],
  ["field_def.type", /type text not null check \(type in \(('text'[^)]*)\)\)/, "FIELD_TYPES"],
  ["field_def.kinds", /or value not in \(('decision'[^)]*)\)\)/, "UNIT_KINDS"],
];
for (const [column, re, constant] of PAIRS) {
  const db = words(grab("db/schema.sql", re, `the ${column} CHECK`), "'", `the ${column} CHECK`);
  const code = words(
    grab(
      "server/src/knowledge.ts",
      new RegExp(`export const ${constant} = \\[([^\\]]*)\\]`),
      `${constant} in knowledge.ts`,
    ),
    '"',
    `${constant} in knowledge.ts`,
  );
  if (db.length && code.length && !same(db, code))
    fail.push(
      `${column} does not match: the database has ${db.join(" / ")}, and ${constant} in knowledge.ts has ${code.join(" / ")}`,
    );
}

// ---- Status glyphs match between the CLI and the review ledger ----
//
// The source of truth is MARKS in server/src/panel.ts. The review Skill writes the same glyphs for the ledger's 4 states (a Skill cannot read panel.ts).
// Changing only one side gives the same state different glyphs in CLI and Skill reports. Glyphs may appear only in the one legend line and
// in the state cells of the ledger table in the format example (the table whose header has Claude and Codex columns; notes excluded, as the Skill says).
// Those are read in a fixed form and paired up, and a glyph anywhere else fails. The check reads the working tree and looks only for the current glyphs.
// Glyphs written elsewhere before a glyph change fail the check when written. What it cannot see: old glyphs added after changing the glyph
// in the working tree (even across commits), and commits that skip the hook (CI sees only the PR and main tips).
// Non-glyph symbols next to state names (such as a bullet before a state) are not checked. Telling prose styles apart would never end.
const LEDGER = { ok: "ran", warn: "cut short", fail: "unable", none: "not run" };
const marks = Object.fromEntries(
  [
    ...(
      grab("server/src/panel.ts", /const MARKS = \{([\s\S]*?)\} as const;/, "MARKS in panel.ts") ?? ""
    ).matchAll(/(\w+): \["(.)",/g),
  ].map((m) => [m[1], m[2]]),
);
if (Object.keys(LEDGER).every((k) => marks[k])) {
  const states = Object.values(LEDGER).join("|");
  const skill = "plugin/skills/review/SKILL.md";
  const lines = read(skill).split("\n");
  const pairs = [];
  const legendAt = lines.findIndex((l) => l.includes("states use marks ("));
  const legend = lines[legendAt]?.match(/states use marks \((.*?)\)/)?.[1];
  if (legend === undefined) fail.push("cannot extract the ledger legend line from the review Skill");
  for (const part of legend?.split(" / ") ?? []) {
    const m = part.match(new RegExp(`^\`([^\`]+)\` (${states})$`));
    if (m) pairs.push([m[1], m[2], "legend"]);
    else fail.push(`write the review Skill ledger legend entry "${part}" as "\`glyph\` state"`);
  }
  const missing = Object.values(LEDGER).filter((state) => !pairs.some(([, s]) => s === state));
  if (legend !== undefined && missing.length)
    fail.push(`the review Skill ledger legend is missing ${missing.join(" / ")}`);
  const at = lines.indexOf("### Format");
  const open = at < 0 ? -1 : lines.indexOf("```", at);
  const close = open < 0 ? -1 : lines.indexOf("```", open + 1);
  if (close < 0) fail.push("cannot extract the format example (the ``` block) from the review Skill");
  // A GFM table may omit the outer |, and \| is a | inside a cell. The table runs until a blank line.
  const cells = (line) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/(?<!\\)\|$/, "")
      .split(/(?<!\\)\|/)
      .map((c) => c.trim());
  // Text where glyphs must not appear. Only the legend content and the ledger table state cells (notes excluded) are removed.
  const outside = [...lines];
  if (legend !== undefined) outside[legendAt] = lines[legendAt].replace(/states use marks \(.*?\)/, "");
  let tables = 0;
  for (let i = open + 1; i < close; i++) {
    const head = cells(lines[i]);
    if (!head.includes("Claude") || !head.includes("Codex")) continue;
    // In GFM, it is a table only when a separator row with the same column count follows the header. Without one, it is not a table header.
    const sep = cells(lines[i + 1] ?? "");
    if (!sep.every((c) => /^:?-+:?$/.test(c))) continue;
    if (sep.length !== head.length) {
      fail.push(
        `give the separator row on line ${i + 2} of the review Skill the same ${head.length} columns as the ledger table header`,
      );
      continue;
    }
    tables++;
    // The check reads rows until a blank line (GFM also ends a table at a list or quote, but glyphs written there are paired
    // too, so no old glyph survives). The first column is the aspect.
    for (i += 2; i < close && lines[i].trim(); i++) {
      const [aspect, ...row] = cells(lines[i]);
      outside[i] = aspect;
      for (const cell of row) {
        const m = cell.match(new RegExp(`^(\\S+) (${states})(?: \\(([^)]*)\\))?$`, "u"));
        if (!m) {
          fail.push(
            `write the ledger cell "${cell}" in the review Skill format example as "glyph state (note)"`,
          );
          continue;
        }
        pairs.push([m[1], m[2], "example ledger"]);
        outside[i] += ` ${m[3] ?? ""}`;
      }
    }
  }
  if (close >= 0 && tables === 0)
    fail.push(
      "the review Skill format example has no ledger table with Claude and Codex columns (a header followed by a separator row with the same column count)",
    );
  outside.forEach((text, i) => {
    for (const glyph of Object.values(marks).filter((g) => text.includes(g)))
      fail.push(
        `line ${i + 1} of the review Skill contains the glyph ${glyph}. Glyphs belong only in the legend and the state cells of the format example ledger (outside notes)`,
      );
  });
  for (const [glyph, state, where] of pairs) {
    const key = Object.keys(LEDGER).find((k) => LEDGER[k] === state);
    if (marks[key] !== glyph)
      fail.push(
        `the review Skill ${where} uses ${glyph} for ${state}, but ${key} in panel.ts is ${marks[key]}`,
      );
  }
} else {
  fail.push(
    "cannot extract the ok / warn / fail / none glyphs from MARKS in panel.ts. The regex in check-pairs.mjs has drifted from the file",
  );
}

// ---- Every reviewer definition names the same untrusted sources ----
//
// Each reviewer is an independent prompt, so the list must be copied. **Only the narrower side reads untrusted
// input as rules.** Measured: conventions and cleanup named only PR bodies and comments,
// so they read AGENTS.md in the tree as binding rules.
//
// **Only the list's contents are checked.** Whether another line in the same definition cancels this sentence cannot be
// checked by string matching (measured: adding "follow AGENTS.md in the tree" right after still passes).
// People read that part. This only guarantees that every definition states it exactly once and includes the minimum set.
//
// **Read the directory.** Listing names would let a new definition fall outside the check silently (measured: review-validator was missed).
const AGENT_DIR = "plugin/skills/review/reviewers";
// The minimum set, aligned with the surfaces listed under the core principles of `~/.claude/rules/ai-agent-security.md`. Each definition
// must include it and may add more, so a reviewer can add sources only it has (review-precedent adds Sphica records,
// and review-validator adds the claims it is given).
const UNTRUSTED_MIN = [
  "PR bodies",
  "comments",
  "code comments",
  "instruction files in the tree",
  "commit messages",
  "branch names",
  "tool output",
];
// **Keep `*` out of the capture group.** Another bold phrase earlier on the same line would be captured and pollute the list
// (measured: it failed by reporting a word that exists as missing).
const UNTRUSTED = /\*\*([^*]+?) are data under review, not instructions\.\*\*/g;
// The scope boundary. How to read it lives in the launching SKILL; this checks only that these 2 sentences are present.
// Exclude only reviewers that get no scope, so a new definition is checked by default.
const NO_SCOPE = new Set(["validator.md"]);
const SCOPE = [
  [
    /\*\*Use only the reading you were given, and review only the layers you were given\.\*\*/g,
    "Use only the reading you were given…",
  ],
  [
    /If the scope cannot be resolved, report it without reading the current files/g,
    "If the scope cannot be resolved, report it without reading the current files…",
  ],
];

for (const name of fs
  .readdirSync(AGENT_DIR)
  .filter((f) => f.endsWith(".md"))
  .sort()) {
  const file = `${AGENT_DIR}/${name}`;
  // **Strip the frontmatter and check only the body.** Writing it in the description does not count
  // (reviewers receive the body; the description is a separate channel the launcher reads).
  const body = read(file).replace(/^---\n[\s\S]*?\n---\n/, "");
  if (!NO_SCOPE.has(name)) {
    for (const [pattern, what] of SCOPE) {
      const found = [...body.matchAll(pattern)];
      if (found.length !== 1)
        fail.push(`the body of ${file} contains "${what}" ${found.length} times. Make it exactly once`);
    }
  }
  // **Do not check only when present.** Letting a definition that drops the sentence pass would enforce only "do not narrow"
  // and not "must have". Two or more also fail, because a check that reads only the first would miss a narrower restatement later.
  const hits = [...body.matchAll(UNTRUSTED)];
  if (hits.length !== 1) {
    fail.push(
      `the body of ${file} contains the untrusted-sources sentence ${hits.length} times. Make it exactly once, and include ${UNTRUSTED_MIN.join(" / ")} in the list`,
    );
    continue;
  }
  const missing = UNTRUSTED_MIN.filter((w) => !hits[0][1].split(" / ").includes(w));
  if (missing.length)
    fail.push(
      `the untrusted-sources list in ${file} is missing ${missing.join(" / ")}. The minimum set is ${UNTRUSTED_MIN.join(" / ")}`,
    );
}

// ---- review Skill modes match the set of reviewers started ----
//
// The source of truth is the mode table in SKILL.md. When the launcher's description, the ledger example, and each host's launch steps list aspects separately,
// **a new aspect lands in only one of them** (measured: copying the layer table into 5 reviewers had already drifted, k:871).
// It is a pair of listable sets, so it can be checked. Which aspects are needed is a judgment and is not checked.
const REVIEW_SKILL = "plugin/skills/review/SKILL.md";
const MODE_TABLE = grab(
  REVIEW_SKILL,
  /\| mode \| required aspects \|\n\|[-| ]+\|\n([\s\S]*?)\n\n/,
  "the review Skill mode table",
);
if (MODE_TABLE !== null) {
  const modes = new Map();
  for (const line of MODE_TABLE.split("\n")) {
    const m = line.match(/^\| `([a-z]+)` \| (.+?) \|$/);
    if (!m) {
      fail.push(
        `write the review Skill mode table row "${line.trim()}" as "| \`mode\` | \`name\` / \`name\` |"`,
      );
      continue;
    }
    modes.set(m[1], words(m[2], "`", `${m[1]} in the review Skill mode table`));
  }
  for (const name of ["standard", "full"]) {
    if (!modes.has(name)) fail.push(`the review Skill mode table has no ${name}`);
  }
  const standard = modes.get("standard") ?? [];
  const full = modes.get("full") ?? [];
  // **standard must be a subset of full.** Listed separately, an aspect added only to full drops out of standard.
  const outside = standard.filter((n) => !full.includes(n));
  if (outside.length)
    fail.push(`review Skill mode table: ${outside.join(" / ")} in standard is missing from full`);
  // The validator is not an aspect. It starts only when a candidate needs it; mixing it into a mode's plan would start it every time.
  for (const [mode, names] of modes) {
    if (names.includes("validator")) fail.push(`review Skill mode table: do not put validator in ${mode}`);
    for (const name of names) {
      if (!fs.existsSync(`${AGENT_DIR}/${name}.md`)) {
        fail.push(`review Skill mode table: ${AGENT_DIR}/${name}.md for ${name} does not exist`);
      }
    }
    if (new Set(names).size !== names.length)
      fail.push(`review Skill mode table: ${mode} lists the same aspect twice`);
  }
  if (standard.length === 0) fail.push("review Skill mode table: standard has no aspects");
  // **full starts every shipped finder.** Which ones go in standard is a judgment and is not checked, but
  // listing names here would **let a new finder pass while missing from the mode table** (the same shape as k:871).
  const finders = fs
    .readdirSync(AGENT_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .filter((n) => n !== "validator");
  const missing = finders.filter((n) => !full.includes(n));
  if (missing.length) fail.push(`review Skill mode table: full is missing ${missing.join(" / ")}`);
}

// ---- The overall state and continuation words match between the source tables and the format example ----
//
// Examples get copied, so **if the source words change but the example stays old, copies use the old words.**
// Which failure maps to which state is meaning and is not checked. Doing that with regexes
// would mean checking the meaning of prose (k:879: it passed even with every reading removed or the table moved to an appendix).
const REVIEW_SRC = read(REVIEW_SKILL);
const vocab = (re, what) => {
  const table = grab(REVIEW_SKILL, re, what);
  if (table === null) return null;
  const got = [...table.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]);
  if (got.length === 0) {
    fail.push(`cannot extract any words from ${what}`);
    return null;
  }
  const dup = got.filter((v, i) => got.indexOf(v) !== i);
  if (dup.length) fail.push(`${what} lists ${dup.join(" / ")} twice`);
  return new Set(got);
};
const OVERALL = vocab(
  /\| overall \| condition \|\n\|[-| ]+\|\n([\s\S]*?)\n\n/,
  "the review Skill overall state table",
);
const CONTINUE = vocab(
  /\| continuation \| condition \|\n\|[-| ]+\|\n([\s\S]*?)\n\n/,
  "the review Skill continuation table",
);
// Whether the overall and continuation lines in the example use words from the source tables. Catches an example left with old words.
for (const [label, allowed] of [
  ["Overall", OVERALL],
  ["Continuation", CONTINUE],
]) {
  if (allowed === null) continue;
  const used = [...REVIEW_SRC.matchAll(new RegExp(`^${label}: ([A-Z_]+)`, "gm"))].map((m) => m[1]);
  if (used.length === 0) fail.push(`the review Skill format example has no "${label}: …" line`);
  for (const v of used) {
    if (!allowed.has(v))
      fail.push(
        `"${label}: ${v}" in the review Skill example is not in the table. The table has ${[...allowed].join(" / ")}`,
      );
  }
}
// Lane coverage. Only ran and cut short get coverage; not run and unable do not (do not mix "could not observe" with "not planned").
const COVERAGE = new Set(["COMPLETE", "PARTIAL", "UNKNOWN"]);
const coverageTable = grab(
  REVIEW_SKILL,
  /\| state \| meaning \| coverage \|\n\|[-| ]+\|\n([\s\S]*?)\n\n/,
  "the review Skill state and coverage table",
);
for (const line of (coverageTable ?? "").split("\n")) {
  const m = line.match(/^\| `([^`]+)` \| .* \| (.+?) \|$/);
  if (!m) continue;
  const [, state, cov] = m;
  const got = [...cov.matchAll(/`([A-Z]+)`/g)].map((x) => x[1]);
  if (["not run", "unable"].includes(state)) {
    if (got.length) fail.push(`review Skill: ${state} must not have coverage (${got.join(" / ")})`);
    continue;
  }
  if (got.length === 0) fail.push(`review Skill: ${state} has no coverage`);
  const unknown = got.filter((g) => !COVERAGE.has(g));
  if (unknown.length) fail.push(`review Skill: ${unknown.join(" / ")} is not a valid coverage for ${state}`);
}

// Whether each status word in the body appears in some table. **Renaming a word only in a table leaves the old word in the body**
// (measured: renaming DEGRADED did not fail the example comparison, because the example used another word).
const VERDICTS = vocab(/\| \| meaning \|\n\|[-| ]+\|\n([\s\S]*?)\n\n/, "the review Skill verdict table");
if (OVERALL && CONTINUE && VERDICTS) {
  const known = new Set([...OVERALL, ...CONTINUE, ...COVERAGE, ...VERDICTS]);
  const orphan = [...new Set([...REVIEW_SRC.matchAll(/`([A-Z][A-Z_]+)`/g)].map((m) => m[1]))].filter(
    (w) => !known.has(w),
  );
  if (orphan.length) {
    fail.push(
      `${orphan.join(" / ")} in the review Skill body is in none of the overall, continuation, coverage, or verdict tables`,
    );
  }
}

// ---- The extracted peer model launch steps and the safety conditions left behind match ----
//
// The launch commands live in references/peer-model.md, **read only when the other model is used**.
// **Flags whose removal widens permissions are also written in SKILL.md.** The duplication is deliberate, so forgetting to read the reference
// never widens permissions directly; this is not a one-sided "if not in SKILL.md, it is in the reference" check.
const PEER = "plugin/skills/review/references/peer-model.md";
const links = [...REVIEW_SRC.matchAll(/\(references\/peer-model\.md\)/g)].length;
if (links !== 1)
  fail.push(`the review Skill links to references/peer-model.md ${links} times (make it once)`);
if (!fs.existsSync(PEER)) {
  fail.push(`${PEER} does not exist`);
} else {
  const peer = read(PEER);
  // Flags whose removal widens permissions. Both the SKILL.md safety conditions and the reference's commands need them.
  for (const flag of ["--no-session-persistence", "--ephemeral", "-s read-only"]) {
    if (!REVIEW_SRC.includes(flag)) fail.push(`the review Skill safety conditions are missing ${flag}`);
  }
  // **Check the command text itself.** Searching the whole file passes as soon as prose mentions the same word
  // (measured: dropping a flag from the table went undetected because a paragraph below still spelled it).
  const command = (needle, what) => {
    const found = [...peer.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).filter((c) => c.includes(needle));
    if (found.length === 0) fail.push(`${PEER} has no ${what} launch command`);
    return found;
  };
  for (const [needle, what, flags] of [
    ["claude -p", "claude", ["--agents", "--agent", "--no-session-persistence", "--output-format json"]],
    ["codex exec", "codex", ["--ephemeral", "-s read-only", "--output-schema", "-o "]],
  ]) {
    for (const flag of flags) {
      if (!command(needle, what).some((c) => c.includes(flag))) {
        fail.push(`the ${what} launch command in ${PEER} is missing ${flag}`);
      }
    }
  }
  // --resume opens a path where, if --agent is dropped, the reviewer runs with Edit and Write.
  if (/`[^`]*claude -p[^`]*--resume/.test(peer)) fail.push(`the claude launch in ${PEER} uses --resume`);
  // **Limit the tools that can write to Bash** (measured: a reviewer with only Read and Bash created a file).
  // Bash goes only to aspects that need to run things, so it is allowed, but no aspect needs Edit or Write.
  for (const tool of ["Edit", "Write", "NotebookEdit"]) {
    if (new RegExp(`"tools"[^\\]]*${tool}`).test(peer)) {
      fail.push(`"tools" in ${PEER} includes ${tool}. Reviewers do not modify files`);
    }
  }
  for (const shell of ["# POSIX", "# PowerShell"]) {
    if (!peer.includes(shell)) fail.push(`${PEER} has no ${shell} launch example`);
  }
}

// ---- There is exactly one source for the completion line ----
//
// **Do not copy it into reviewer definitions.** Copies would get keys the launcher adds on one side only (the same shape as k:876;
// the launcher owns the output contract). The key set is listable, so it can be checked.
const TRAILER = grab(REVIEW_SKILL, /^completion: (.+)$/m, "the review Skill completion line");
if (TRAILER !== null) {
  const keys = [...TRAILER.matchAll(/(\w+)=/g)].map((m) => m[1]);
  for (const key of ["lane", "model", "coverage", "unfinished", "findings"]) {
    if (!keys.includes(key)) fail.push(`the review Skill completion line is missing ${key}=`);
  }
  const trailers = [...REVIEW_SRC.matchAll(/^completion: /gm)].length;
  if (trailers !== 1)
    fail.push(`the review Skill defines the completion line ${trailers} times (make it once)`);
  for (const file of fs.readdirSync(AGENT_DIR).map((f) => `${AGENT_DIR}/${f}`)) {
    if (/^completion: /m.test(read(file)))
      fail.push(`${file}: the completion line belongs only in the launching Skill`);
  }
}

// ---- Tool versions copied between mise.toml, package.json, and the workflows ----
//
// mise.toml pins the local toolchain. Bumping one copy and not the others leaves local runs and CI on different tools.
{
  const mise = read("mise.toml");
  const tool = (name) => grab("mise.toml", new RegExp(`^${name} = "([^"]+)"$`, "m"), `mise.toml ${name}`);
  const node = tool("node");
  const bun = tool("bun");
  const actionlint = tool("actionlint");
  if (mise && node && bun && actionlint) {
    const packageManager = grab("package.json", /"packageManager": "bun@([^"]+)"/, "packageManager");
    if (packageManager !== bun)
      fail.push(`mise.toml bun ${bun} differs from package.json packageManager bun@${packageManager}`);
    const engines = grab("server/package.json", /"node": ">=([^"]+)"/, "engines.node");
    if (engines && !node.startsWith(`${engines}.`))
      fail.push(`mise.toml node ${node} is not on the engines floor ${engines}`);
    // Workflows that install Bun must keep pinning it, so a deleted pin fails too.
    for (const file of [".github/workflows/check.yml", ".github/workflows/release.yml"]) {
      const pins = [...read(file).matchAll(/bun-version: (\S+)/g)].map((m) => m[1]);
      if (pins.length === 0) fail.push(`${file}: no bun-version pin`);
      for (const pin of pins)
        if (pin !== bun) fail.push(`${file}: bun-version ${pin} differs from mise.toml bun ${bun}`);
    }
    const ci = grab(".github/workflows/check.yml", /node: \["([^"]+)"/, "check.yml node matrix");
    if (ci && !node.startsWith(`${ci}.`))
      fail.push(`mise.toml node ${node} is not the check.yml node floor ${ci}`);
    const pinned = grab(".github/workflows/zizmor.yml", /ACTIONLINT: "([^"]+)"/, "zizmor.yml ACTIONLINT");
    if (pinned !== actionlint)
      fail.push(`mise.toml actionlint ${actionlint} differs from zizmor.yml ACTIONLINT ${pinned}`);
  }
}

if (fail.length) {
  console.error(`\n${fail.map((f) => `  ${f}`).join("\n\n")}\n`);
  process.exit(1);
}
