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

const REVIEW_MARK = "<!-- fork-review-command -->";
/** The sentence of step 3 that hands the text to the reader: naming the agent somewhere else in the Skill does not stand in for it */
const READER_STEP = "Start the `fork-reader` agent by its name";
/** Codex features that act outside its sandbox or hand work on. `multi_agent` alone leaves the kind of delegation the model's catalog entry picks */
const REVIEW_OFF = [
  "apps",
  "plugins",
  "remote_plugin",
  "hooks",
  "multi_agent",
  "multi_agent_v2",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "image_generation",
];
const REVIEW_FLAGS = [
  "-s read-only",
  "--ignore-rules",
  "--ephemeral",
  "--ignore-user-config",
  ...REVIEW_OFF.map((name) => `--disable ${name}`),
  "-c agents.enabled=false",
  "-c 'web_search=\"disabled\"'",
  '-c model_reasoning_effort="high"',
];
/** Where the Skill may name the command besides the marked line: another Skill's name, the places that configure Codex, and two commands that only print */
const REVIEW_NAMED = [
  "codex-review",
  "~/.codex/config.toml",
  "~/.codex/hooks.json",
  "/etc/codex",
  " .codex ",
  "`codex --version`",
  "`codex features list`",
];
const REVIEW_COMMAND = `codex exec ${REVIEW_FLAGS.join(" ")} - < <request file> > <output file> 2>&1`;

/**
 * The fork-pr Skill starts Codex on a fork's diff with one command, written once under a mark, and that command is the one above
 * word for word: a flag kept in the prose but dropped from the command, or one added to it, changes what Codex holds.
 * @param {string} source
 * @returns {string[]}
 */
export function reviewCommandProblems(source) {
  const text = source.replaceAll("\r\n", "\n");
  const problems = [];
  if (!text.includes(READER_STEP)) problems.push(`does not say: ${READER_STEP}`);
  const marks = text.split(REVIEW_MARK).length - 1;
  if (marks !== 1) return [...problems, `must hold the mark ${REVIEW_MARK} once (found ${marks})`];
  const block = /^\n[ \t]*```bash\n([\s\S]*?)\n[ \t]*```[ \t]*(?:\n|$)/.exec(
    text.slice(text.indexOf(REVIEW_MARK) + REVIEW_MARK.length),
  );
  if (!block) return [...problems, "the mark is not followed at once by a bash code block"];
  // Any other way of starting Codex written into the Skill, in a block or in the prose, would be followed as readily as the marked one.
  // So outside the marked block the command's name may stand only in the spellings REVIEW_NAMED lists
  const marked = new Set((block[1] ?? "").split("\n").map((line) => line.trim()));
  const others = text
    .split("\n")
    .filter((line) => !marked.has(line.trim()))
    .filter((line) =>
      /\bcodex\b/.test(REVIEW_NAMED.reduce((rest, known) => rest.replaceAll(known, ""), line)),
    );
  if (others.length)
    problems.push(
      `names the codex command outside the marked block in a way this check does not know: ${(others[0] ?? "").trim().slice(0, 80)}`,
    );
  const command = (block[1] ?? "").trim();
  // The marked line is left out of the search above wherever it stands, so a second copy has to be counted here
  const copies = text.split("\n").filter((line) => line.trim() === command).length;
  if (copies > 1) problems.push(`the marked command is written ${copies} times`);
  if (command === REVIEW_COMMAND) return problems;
  const missing = REVIEW_FLAGS.filter((flag) => !` ${command} `.includes(` ${flag} `));
  return [
    ...problems,
    missing.length
      ? `the marked command lacks ${missing.join(", ")}`
      : "the marked command differs from the one this check knows",
  ];
}
