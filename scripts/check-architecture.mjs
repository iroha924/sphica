#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Checks that the read MCP server has no write connection (server/src/db-write.ts); writes go through the record server (mcp-record.ts).
//
// **Connection roles are separated by import direction.** If imports from a reader entry reach db-write.ts, text it reads
// could steer it into writing (the execution boundary in CLAUDE.md and AGENTS.md). Neither types nor the authorizer stop this: once a write
// connection is open, the authorizer allows that role's writes.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import url from "node:url";

const repo = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
// --root points the check at a copy of the sources, so a test can show it failing
const at = process.argv.indexOf("--root");
const root = at > 0 ? path.resolve(process.argv[at + 1] ?? "") : repo;
// js-tokens is a devDependency of server. Resolve it from there instead of adding a root dependency.
const jsTokens = createRequire(path.join(repo, "server/package.json"))("js-tokens");
/** Read-only interfaces. No module reachable from these may import the write connection. */
const READERS = ["server/src/mcp.ts"];
const WRITER = "server/src/db-write.ts";

// Four forms: `import x from`, `export ... from`, side-effect-only `import "..."`, and `import(...)`.
const IMPORT =
  /(?:import|export)\s[^;]*?from\s+["'](\.[^"']+)["']|import\s+["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)/g;
const rel = (abs) => path.relative(root, abs).split(path.sep).join("/");

/** Modules reachable from an entry, each with the module that first imported it. */
function reach(entry) {
  const via = new Map([[entry, null]]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    const text = fs.readFileSync(path.join(root, file), "utf8");
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3];
      const next = rel(path.resolve(path.dirname(path.join(root, file)), spec));
      if (!next.startsWith("server/src/") || via.has(next)) continue;
      via.set(next, file);
      queue.push(next);
    }
  }
  return via;
}

const fail = [];
for (const entry of READERS) {
  if (!fs.existsSync(path.join(root, entry))) {
    fail.push(`${entry} does not exist. Fix READERS in check-architecture.mjs`);
    continue;
  }
  const via = reach(entry);
  if (!via.has(WRITER)) continue;
  const chain = [];
  for (let at = WRITER; at; at = via.get(at)) chain.unshift(at);
  fail.push(`${entry} reaches the write connection: ${chain.join(" → ")}`);
}
// If the import regex broke and matched nothing, the check would pass while looking at nothing. Confirm each entry imports a src module.
for (const entry of READERS)
  if (fs.existsSync(path.join(root, entry)) && reach(entry).size < 3)
    fail.push(`cannot follow the imports of ${entry}`);

// Lifecycles and replacements are judged, never written directly: only reconcile writes them, after judging the facts a save changed
const JUDGED =
  /insertInto\(\s*["'](unit_state|unit_replacement)["']|updateTable\(\s*["']unit_replacement["']|into\s+(unit_state|unit_replacement)\b/;
const RECONCILE = "server/src/reconcile.ts";
const SPARED = new Set([RECONCILE]);
const sources = fs
  .readdirSync(path.join(root, "server/src"), { recursive: true })
  .map((f) => `server/src/${String(f).split(path.sep).join("/")}`)
  .filter((f) => f.endsWith(".ts"));
if (!sources.includes(RECONCILE))
  fail.push(`${RECONCILE} does not exist. Fix RECONCILE in check-architecture.mjs`);
for (const f of sources)
  if (!SPARED.has(f) && JUDGED.test(fs.readFileSync(path.join(root, f), "utf8")))
    fail.push(`${f} writes unit_state or unit_replacement; only ${RECONCILE} may`);

// git runs outside the agent's sandbox in a repository whose config the agent writes: only GIT_STARTERS start it, with the options and
// environment that keep that config from running a command. Two layers, read as tokens so comments do not count: only the modules in
// SPAWNERS may load node:child_process at all (an import, a dynamic import, or a require all name it as a string), and in those, only
// the starters may hold a string that is the program name or a command line that begins with it, escapes decoded. A name built at run
// time from pieces is beyond what this sees; such a module is still one of the few SPAWNERS a review reads.
const GIT_STARTERS = new Set(["server/src/git.ts", "server/src/git-worker.ts"]);
const SPAWNERS = new Set([
  ...GIT_STARTERS,
  "server/src/capture.ts",
  "server/src/github.ts",
  "server/src/plugin.ts",
]);
/** A string token's text as the program reads it: quotes removed and escapes decoded */
const ESCAPES = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", 0: "\0" };
const cooked = (raw) =>
  raw.replace(
    /\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|(\r\n|[\s\S]))/g,
    (_, x, u1, u4, c) =>
      x || u1 || u4
        ? String.fromCodePoint(Number.parseInt(x ?? u1 ?? u4, 16))
        : // A backslash before a line break continues the line: both are dropped
          /^(?:\r\n|[\n\r\u2028\u2029])$/.test(c)
          ? ""
          : (ESCAPES[c] ?? c),
  );
/** Each string and each piece of a template in a source, cooked */
const strings = (source) =>
  [...jsTokens(source)].flatMap((t) => {
    if (t.type === "StringLiteral") return [cooked(t.value.slice(1, -1))];
    if (t.type === "NoSubstitutionTemplate") return [cooked(t.value.slice(1, -1))];
    if (t.type === "TemplateHead") return [cooked(t.value.slice(1, -2))];
    if (t.type === "TemplateMiddle") return [cooked(t.value.slice(1, -2))];
    if (t.type === "TemplateTail") return [cooked(t.value.slice(1, -1))];
    return [];
  });
const loadsSpawn = (texts) => texts.some((s) => s === "node:child_process" || s === "child_process");
const namesGit = (texts) => texts.some((s) => /^git(?:\.exe)?$/i.test(s) || /^git(?:\.exe)?\s/i.test(s));
for (const f of sources) {
  const texts = strings(fs.readFileSync(path.join(root, f), "utf8"));
  if (!SPAWNERS.has(f) && loadsSpawn(texts))
    fail.push(`${f} loads node:child_process; only ${[...SPAWNERS].join(", ")} may start processes`);
  else if (SPAWNERS.has(f) && !GIT_STARTERS.has(f) && namesGit(texts))
    fail.push(`${f} starts git; only ${[...GIT_STARTERS].join(" and ")} may`);
}
// If the tokens stopped being read, the check would pass while looking at nothing: each starter must still load node:child_process and
// name git
for (const f of GIT_STARTERS) {
  const texts = sources.includes(f) ? strings(fs.readFileSync(path.join(root, f), "utf8")) : [];
  if (!loadsSpawn(texts) || !namesGit(texts))
    fail.push(`${f} names no git to start where check-architecture.mjs looks; fix GIT_STARTERS`);
}

// Words that carry authority are checked in one place: only OWN_WORDS makes an OwnWords, and only AUTHORITY_WRITERS write the rows that
// keep such words. The types ask each writer for one; this stops the plain ways around them. It does not see a table name held in a
// variable, a cast through a type alias or in angle brackets, or SQL in a string that is never run.
const OWN_WORDS = "server/src/own-words.ts";
const AUTHORITY_WRITERS = new Set(["server/src/record.ts", "server/src/glean.ts"]);
/** A source with each comment turned into a space: a note about a cast or a write is not one, and it still parts the words around it */
const code = (source) =>
  [...jsTokens(source)]
    .map((t) => (t.type === "MultiLineComment" || t.type === "SingleLineComment" ? " " : t.value))
    .join("");
// A cast to the type, under its own name or one it was imported or exported as. Only a list in braces right after `import` or `export`
// renames it, and that list is taken out before looking for the cast, since it reads `OwnWords as W` itself
const CLAUSE = /\b(?:import|export)\s+(?:type\s+)?\{[^}]*\}/g;
const forged = (text) => {
  const names = [
    "OwnWords",
    ...(text.match(CLAUSE) ?? []).flatMap((c) =>
      [...c.matchAll(/\bOwnWords\s+as\s+([\w$]+)/g)].map((m) => m[1].replaceAll("$", "\\$")),
    ),
  ];
  return new RegExp(`\\bas\\s+(?:${names.join("|")})(?![\\w$])`).test(text.replace(CLAUSE, ""));
};
// A row written, changed, or removed through the query builder or as SQL: in any case, with the table's name quoted any way SQLite takes
// or under its schema's name, and in any of the spellings of a write (insert or ignore, replace into, update or ignore, delete from).
// Evidence is here too: an option's reconsider condition is evidence
const TABLES = "(?:unit_adoption|unit_evidence|unit_anchor_retirement|field_def)";
const AUTHORITY = new RegExp(
  `(?:insertInto|updateTable|replaceInto|deleteFrom)\\s*\\(\\s*["'\`]${TABLES}["'\`]|\\b(?:(?:insert(?:\\s+or\\s+\\w+)?|replace)\\s+into|update(?:\\s+or\\s+\\w+)?|delete\\s+from)\\s+(?:main\\s*\\.\\s*)?\\\\?["'\`[]?${TABLES}\\b`,
  "i",
);
for (const f of sources) {
  const text = code(fs.readFileSync(path.join(root, f), "utf8"));
  if (f !== OWN_WORDS && forged(text))
    fail.push(
      `${f} casts a value to OwnWords or imports it under another name; only ${OWN_WORDS} makes one, by checking the words`,
    );
  if (!AUTHORITY_WRITERS.has(f) && AUTHORITY.test(text))
    fail.push(
      `${f} writes evidence, an adoption, a retraction, an anchor's reason, or a field definition; only ${[...AUTHORITY_WRITERS].join(" and ")} may, from an OwnWords`,
    );
}
// If the patterns stopped matching, the check would pass while looking at nothing
if (!sources.includes(OWN_WORDS) || !forged(code(fs.readFileSync(path.join(root, OWN_WORDS), "utf8"))))
  fail.push(`${OWN_WORDS} makes no OwnWords where check-architecture.mjs looks; fix OWN_WORDS`);
for (const f of AUTHORITY_WRITERS)
  if (!sources.includes(f) || !AUTHORITY.test(code(fs.readFileSync(path.join(root, f), "utf8"))))
    fail.push(`${f} writes no authority row where check-architecture.mjs looks; fix AUTHORITY_WRITERS`);

if (fail.length) {
  console.error(`architecture:\n${fail.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(`lifecycle writers: only ${RECONCILE} writes unit_state and unit_replacement`);
console.log(
  `authority rows: only ${[...AUTHORITY_WRITERS].join(" and ")} write them, from words ${OWN_WORDS} checked`,
);
console.log(
  `git starters: only ${[...GIT_STARTERS].join(" and ")} start git, among the ${SPAWNERS.size} modules that start processes`,
);
const count = new Set(READERS.flatMap((e) => [...reach(e).keys()])).size;
console.log(
  `reader boundary: none of the ${count} modules reachable from ${READERS.join(" / ")} import the write connection`,
);
