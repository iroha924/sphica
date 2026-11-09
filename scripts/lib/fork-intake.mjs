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
  // Claude Code ends the frontmatter at the first three dashes anywhere, and its YAML breaks a line or stops at characters a line reader passes over
  if (block.includes("---"))
    problems.push("the frontmatter holds --- before its closing line, where the host stops reading");
  const control = [...block].find((ch) => ch !== "\n" && /\p{Cc}|\p{Cf}|\p{Zl}|\p{Zp}/u.test(ch));
  if (control !== undefined) {
    const code = (control.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
    problems.push(`the frontmatter holds a control character (U+${code})`);
  }
  const seen = new Map();
  for (const line of block.split("\n")) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const match = /^([A-Za-z][A-Za-z0-9-]*):(.*)$/.exec(line);
    if (!match) {
      problems.push(`a frontmatter line is not one key and its value: ${line.trim()}`);
      continue;
    }
    const [, key, raw] = match;
    const value = raw.trim();
    // Only values YAML reads the way this line reader does: one line, no quoting, nothing YAML would take as a key, a comment, or a list
    if (
      !/^ \S/.test(raw) ||
      /\t/.test(raw) ||
      /^[!&*[\]{}|>'"%@`#,?:-]/.test(value) ||
      /: | #|:$/.test(value)
    )
      problems.push(`the value of ${key} is not a plain value on its line`);
    if (seen.has(key)) problems.push(`the key ${key} is written twice`);
    else if (!READER_KEYS.includes(key)) problems.push(`the key ${key} is not one the reader may carry`);
    seen.set(key, value);
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

/** Step 3 as the Skill writes it: a copy elsewhere, or a step 3 that starts the reader only sometimes, does not stand in for it */
const STEP3 =
  "3. **Have the reader read it.** Start the `fork-reader` agent by its name and give it the directory and the pull request number, nothing else. Do not use a fork of this session for this: a fork holds every tool this session holds. If the Agent tool does not list `fork-reader`, start a new session, and do not read the text yourself in its place (a session has been seen not to list a definition added while it ran). The reader reports in five sections, with a file and line for every claim.";
/** The steps before the owner's approval run from `## Steps` down to this line, which itself still runs before the approval */
const APPROVAL = "6. **The owner approves taking it in.**";
/**
 * Words that start a reader with more tools than fork-reader, with or without a path or package in front, but not the `.claude/`,
 * `.codex`, or `.agents/` directories. A launcher not named here passes
 */
const LAUNCHER =
  /(?<!\.)\b(?:codex|claude|gemini|subagents?|agents?|explore)\b|sphica:|general-purpose|--print\b|\btask tool\b/i;
/** Spellings that name a launcher without starting a reader: a version check, instruction files, and what a pull request may change */
const NAMED = ["`claude --version`", "`CLAUDE.md`", "`AGENTS.md`", "agent settings"];

/**
 * Until the owner approves a head, the fork-reader agent is the one reader of the fork's text: step 3 starts it, and no other line
 * from `## Steps` down to the approval names another launcher. Step 3 is held to STEP3 instead, so the launcher search skips it.
 * @param {string} source
 * @returns {string[]}
 */
export function readerStepProblems(source) {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  if (lines.filter((line) => line === "## Steps").length !== 1)
    return ["must hold the heading ## Steps once"];
  const approvals = lines.filter((line) => line.startsWith(APPROVAL)).length;
  if (approvals !== 1) return [`must hold the approval step once (found ${approvals}): ${APPROVAL}`];
  const steps = lines.slice(
    lines.indexOf("## Steps") + 1,
    lines.findIndex((line) => line.startsWith(APPROVAL)) + 1,
  );
  const problems = steps.includes(STEP3) ? [] : ["step 3 is not word for word the one this check knows"];
  const other = steps.find(
    (line) =>
      !line.startsWith("3. ") &&
      LAUNCHER.test(NAMED.reduce((text, known) => text.replaceAll(known, ""), line)),
  );
  if (other !== undefined) problems.push(`starts another reader before the owner approves: ${other.trim()}`);
  return problems;
}
