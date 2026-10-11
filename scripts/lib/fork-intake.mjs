// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The shape of what guards a fork's pull request before the owner approves it. Each function takes a file's text and returns what is
// wrong with it. They keep a step from being dropped by accident; whoever can edit the files can edit these checks too.

/** `gh pr checkout` and the two other names gh gives it: a deny rule matches a command only as it is written */
const CHECKOUT_DENY = ["Bash(gh pr checkout *)", "Bash(gh pr co *)", "Bash(gh co *)"];

/** @param {unknown} value */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {string[]} keys */
const named = (keys) => (keys.length ? keys.join(", ") : "none");

/**
 * The project settings hold the checkout deny and nothing else, so a hook or an allow rule cannot arrive without this check changing too.
 * @param {string} text
 * @returns {string[]}
 */
export function settingsProblems(text) {
  let settings;
  try {
    settings = JSON.parse(text);
  } catch {
    return ["not JSON"];
  }
  if (!isRecord(settings)) return ["not an object"];
  const problems = [];
  const keys = Object.keys(settings);
  if (keys.length !== 1 || keys[0] !== "permissions")
    problems.push(`the only key must be permissions (found ${named(keys)})`);
  if (!isRecord(settings.permissions)) return [...problems, "permissions is not an object"];
  const inner = Object.keys(settings.permissions);
  if (inner.length !== 1 || inner[0] !== "deny")
    problems.push(`the only key of permissions must be deny (found ${named(inner)})`);
  const deny = settings.permissions.deny;
  if (!Array.isArray(deny)) return [...problems, "permissions.deny is not a list"];
  for (const rule of CHECKOUT_DENY) if (!deny.includes(rule)) problems.push(`permissions.deny lacks ${rule}`);
  for (const rule of deny)
    if (!CHECKOUT_DENY.includes(rule))
      problems.push(`permissions.deny holds a rule this check does not know: ${String(rule)}`);
  if (deny.length !== new Set(deny).size) problems.push("permissions.deny repeats a rule");
  return problems;
}

/** The frontmatter keys the reader may carry: `memory` adds write tools, and `skills`, `mcpServers`, and `hooks` add things that act */
const READER_KEYS = ["name", "description", "tools", "model", "effort", "maxTurns"];
const READER_TOOLS = ["Glob", "Grep", "Read"];

/**
 * The reader of a fork's text holds the three read tools and no key that could add another. A repeated key is refused, since which one
 * the host takes is not ours to say.
 * @param {string} source
 * @returns {string[]}
 */
export function readerProblems(source) {
  const text = source.replaceAll("\r\n", "\n");
  const end = text.indexOf("\n---\n", 4);
  if (!text.startsWith("---\n") || end === -1) return ["no closed YAML frontmatter"];
  const block = text.slice(4, end);
  const problems = [];
  // Claude Code ends the frontmatter at the first three dashes anywhere, and its YAML breaks a line at a lone carriage return
  if (block.includes("---"))
    problems.push("the frontmatter holds --- before its closing line, where the host stops reading");
  if (block.includes("\r"))
    problems.push("the frontmatter holds a carriage return that is not part of a line ending");
  const seen = new Map();
  for (const line of block.split("\n")) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const match = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line);
    if (!match) {
      problems.push(`a frontmatter line is not one key and its value: ${line.trim()}`);
      continue;
    }
    const [, key, value] = match;
    // A quote left open would carry the value over the lines below it
    const quote = /^['"]/.exec(value)?.[0];
    if (quote && (value.length < 2 || !value.endsWith(quote) || value.slice(1, -1).includes(quote)))
      problems.push(`the value of ${key} opens a quote it does not close on its line`);
    if (seen.has(key)) problems.push(`the key ${key} is written twice`);
    else if (!READER_KEYS.includes(key)) problems.push(`the key ${key} is not one the reader may carry`);
    seen.set(key, value.replace(/^(['"])(.*)\1$/, "$2"));
  }
  const tools = (seen.get("tools") ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean)
    .sort();
  if (tools.join(", ") !== READER_TOOLS.join(", "))
    problems.push(`tools must be Read, Grep, Glob and nothing else (found ${named(tools)})`);
  return problems;
}
