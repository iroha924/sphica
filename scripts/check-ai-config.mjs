// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withoutComments } from "./lib/english.mjs";
import { finding, report } from "./lib/finding.mjs";
import { readerProblems, reviewCommandProblems, settingsProblems } from "./lib/fork-intake.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const developmentSkills = ["knowledge-schema", "plugin-agent-authoring", "plugin-release"];

const SELF = "scripts/check-ai-config.mjs";

function fail(parts) {
  failures.push(finding(parts));
}

function read(relative) {
  const file = path.join(root, relative);
  try {
    return fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  } catch (error) {
    fail({
      where: relative,
      what: `the file cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      why: "the checks of this file would run on nothing",
      fix: `restore the file, or remove what expects it from ${SELF}`,
    });
    return "";
  }
}

const FRONTMATTER_WHY =
  "the host reads the name and description from the frontmatter, and offers nothing without them";

function frontmatter(relative, source) {
  if (!source.startsWith("---\n")) {
    fail({
      where: relative,
      what: "no YAML frontmatter",
      why: FRONTMATTER_WHY,
      fix: "start the file with a block between --- lines holding name and description",
    });
    return {};
  }
  const end = source.indexOf("\n---\n", 4);
  if (end === -1) {
    fail({
      where: relative,
      what: "the YAML frontmatter is not closed",
      why: FRONTMATTER_WHY,
      fix: "end the frontmatter with a line of three dashes",
    });
    return {};
  }
  const fields = {};
  let listKey = null;
  for (const line of source.slice(4, end).split("\n")) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    // Read a block sequence (`- value` lines after `skills:`) as an array.
    const item = /^\s+-\s*(.+)$/.exec(line);
    if (item && listKey) {
      fields[listKey].push(item[1].replace(/^['"]|['"]$/g, ""));
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line);
    if (!match) {
      fail({
        where: relative,
        what: `a frontmatter line cannot be read: ${line}`,
        why: "this check reads only `key: value` lines and `- item` lists, so it cannot judge what the line sets",
        fix: "write it as `key: value` on one line, or as `- item` lines under `key:`",
      });
      continue;
    }
    if (match[2] === "") {
      listKey = match[1];
      fields[listKey] = [];
      continue;
    }
    listKey = null;
    fields[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return fields;
}

const agents = read("AGENTS.md");
const lines = agents.trimEnd().split("\n").length;
const bytes = Buffer.byteLength(agents);
if (lines >= 200)
  fail({
    where: "AGENTS.md",
    what: `the file has ${lines} lines`,
    why: "Codex loads AGENTS.md in every session, so each line is context spent on every task",
    fix: "move procedures into .agents/skills/ until it is under 200 lines",
  });
for (const [rule, what] of [
  [
    "Read `plugin/skills/review/SKILL.md` from the checkout",
    "the rule that Codex reads the review Skill from the checkout is missing",
  ],
  [
    "join the value of `rN` in `Skill roots` with the rest exactly as written",
    "the rule that Codex resolves shortened Skill paths literally is missing",
  ],
])
  if (!agents.includes(rule))
    fail({
      where: "AGENTS.md",
      what,
      why: "Codex follows only what AGENTS.md says, so without the rule it reads another copy or guesses the path",
      fix: `restore the line that says: ${rule}`,
    });

// **Codex concatenates AGENTS.md files from global through repo root to CWD and cuts off at 32 KiB.**
// Checking only the root would let nested files be cut silently. This checks the repository's total
// (the owner's ~/.codex/AGENTS.md differs per machine, so a margin for it is subtracted).
const CODEX_LIMIT = 32 * 1024;
// The allowance for the owner's ~/.codex/AGENTS.md: measured 18,638 bytes (2026-09-20) plus 1 KiB of growth.
// **Raising it shrinks the repository's margin.** When space runs out, move long procedures into Skills.
// There is no nested AGENTS.md. If one is added, add it here too.
const USER_RESERVE = 19 * 1024;
if (bytes > CODEX_LIMIT - USER_RESERVE) {
  fail({
    where: "AGENTS.md",
    what: `the file is ${bytes} bytes, over ${CODEX_LIMIT - USER_RESERVE}`,
    why: `Codex joins every AGENTS.md from the global one down and cuts the whole off at 32 KiB, and ${USER_RESERVE} bytes are kept for the owner's global file`,
    fix: `move long procedures into .agents/skills/ until it is within ${CODEX_LIMIT - USER_RESERVE} bytes`,
  });
}
// **CLAUDE.md is for Claude Code only, and AGENTS.md for Codex only.** Claude Code skips AGENTS.md when CLAUDE.md exists,
// and Codex does not read CLAUDE.md (both confirmed by experiment on 2026-09-23). Importing one into the other makes both read both.
const claudeMd = read("CLAUDE.md");
// An import works mid-sentence too (`see @AGENTS.md`). Code spans are not imported, so strip them before checking.
if (/(?:^|\s)@\S*AGENTS\.md\b/m.test(claudeMd.replace(/```[\s\S]*?```|`[^`\n]*`/g, "")))
  fail({
    where: "CLAUDE.md",
    what: "CLAUDE.md imports AGENTS.md",
    why: "Claude Code reads only CLAUDE.md and Codex only AGENTS.md, and an import makes Claude read the Codex rules too",
    fix: "remove the @AGENTS.md import and keep each rule in the file of the host it is for",
  });
const claudeLines = claudeMd.trimEnd().split("\n").length;
// The official guideline is under 200 lines. Always-loaded rules without paths add to it, so CLAUDE.md alone stays at half.
if (claudeLines >= 100)
  fail({
    where: "CLAUDE.md",
    what: `the file has ${claudeLines} lines`,
    why: "always-loaded rules add to CLAUDE.md in every session, so it keeps to half the official guideline of 200",
    fix: "move procedures into Skills and file-specific rules into .claude/rules with paths until it is under 100 lines",
  });
// Codex cannot use Claude Code features (rules, reviewers, Claude-only Skills). Mentioning them makes it look for things that do not exist or start another AI instead.
for (const word of [".claude/rules", ".claude/agents", "review-shipping", "docs-author"])
  if (agents.includes(word))
    fail({
      where: "AGENTS.md",
      what: `the file mentions ${word}, a Claude Code feature`,
      why: "Codex cannot use it, so it looks for what does not exist or starts another AI instead",
      fix: "remove the mention, or say what Codex does in its place",
    });

// Compare the sets of `<!-- invariant: name -->` markers so a rule copied to both sides cannot vanish from one.
// Real case: when the config repository was split, a rewrite dropped one clause from one side unnoticed.
const invariants = (source) =>
  new Set([...source.matchAll(/<!-- invariant: ([a-z0-9-]+) -->/g)].map((m) => m[1]));
const claudeSide = new Set(
  ["CLAUDE.md", ...fs.readdirSync(path.join(root, ".claude/rules")).map((f) => `.claude/rules/${f}`)].flatMap(
    (f) => [...invariants(read(f))],
  ),
);
const codexSide = invariants(agents);
const SIDES = "a rule both hosts share must not vanish from one (invariant host-parity)";
if (codexSide.size < 20)
  fail({
    where: "AGENTS.md",
    what: `only ${codexSide.size} invariant markers were found`,
    why: "if the marker format broke, the comparison of the two sides would compare nothing",
    fix: "end each rule both hosts share with <!-- invariant: <name> -->",
  });
for (const id of claudeSide)
  if (!codexSide.has(id))
    fail({
      where: "AGENTS.md",
      what: `invariant ${id} is in CLAUDE.md or .claude/rules but not here`,
      why: SIDES,
      fix: `add the rule to AGENTS.md ending with <!-- invariant: ${id} -->, or remove it from the Claude side too`,
    });
for (const id of codexSide)
  if (!claudeSide.has(id))
    fail({
      where: "CLAUDE.md, .claude/rules",
      what: `invariant ${id} is in AGENTS.md but not here`,
      why: SIDES,
      fix: `add the rule to CLAUDE.md or a rule ending with <!-- invariant: ${id} -->, or remove it from AGENTS.md too`,
    });
// The comment rules are the same words on both sides, not only the same markers.
const commentRules = ["comment-length", "comment-refs", "comment-history"];
const markedLines = (source, id) =>
  source.split("\n").filter((line) => line.endsWith(`<!-- invariant: ${id} -->`));
const commentsRule = read(".claude/rules/comments.md");
for (const id of commentRules) {
  const claude = markedLines(commentsRule, id);
  const codex = markedLines(agents, id);
  if (claude.length !== 1 || codex.length !== 1)
    fail({
      where: ".claude/rules/comments.md, AGENTS.md",
      what: `invariant ${id} is not on exactly one line in each`,
      why: "the comment rules are compared line for line, so each must be one line",
      fix: `keep one line ending with <!-- invariant: ${id} --> in each file`,
    });
  else if (claude[0] !== codex[0])
    fail({
      where: "AGENTS.md",
      what: `the ${id} line differs from .claude/rules/comments.md`,
      why: "both hosts write comments by the same words",
      fix: "copy the line from .claude/rules/comments.md word for word",
    });
}
const claudeVerification = read(".claude/rules/verification.md");
for (const required of [
  "bun run release:plan -- --base <previous release commit>",
  "`plugin`: a change that goes into the package",
  "the tarball `.github/workflows/release.yml` publishes",
  "Before each release step, reopen the `plugin-release` Skill",
]) {
  if (!claudeVerification.includes(required)) {
    fail({
      where: ".claude/rules/verification.md",
      what: `Claude's release rules lack \`${required}\``,
      why: "Claude ships by these rules, so a lost line lets it skip a release step (invariant release-plan)",
      fix: `restore the rule that says \`${required}\``,
    });
  }
}

/** The checks every Skill takes: its name, its description, and, unless it ships in the plugin, its trigger examples and placeholders */
function skillProblems(relative, name, fields, source, examples) {
  if (fields.name !== name)
    fail({
      where: relative,
      what: `name is ${fields.name ?? "missing"}, not the directory name ${name}`,
      why: "the host finds a Skill by its directory, and another name in the file makes it look like a different Skill",
      fix: `set name: ${name}`,
    });
  if (!fields.description)
    fail({
      where: relative,
      what: "no description",
      why: "the host decides whether to invoke a Skill from its description alone",
      fix: "add a description that says what the Skill does and when to use it",
    });
  if ((fields.description ?? "").length > 1024)
    fail({
      where: relative,
      what: `the description has ${fields.description.length} characters`,
      why: "the Skill format allows a description of at most 1024 characters",
      fix: "shorten the description to 1024 characters or fewer",
    });
  if (!examples) return;
  if (!source.includes("## Triggers") || !source.includes("## Does not trigger"))
    fail({
      where: relative,
      what: "the Triggers or Does not trigger section is missing",
      why: "examples on both sides keep the Skill from starting on the wrong task or missing the right one",
      fix: "add ## Triggers and ## Does not trigger sections with examples",
    });
  if (/\b(TODO|TBD)\b/.test(source))
    fail({
      where: relative,
      what: "TODO or TBD remains",
      why: "an agent follows a Skill as written, placeholders included",
      fix: "finish or remove the placeholder",
    });
}

// Claude Code-only Skills (not in .agents/skills, invisible to Codex): the directories that are not symlinks.
const claudeSkills = fs
  .readdirSync(path.join(root, ".claude/skills"))
  .filter((name) => !fs.lstatSync(path.join(root, ".claude/skills", name)).isSymbolicLink());
for (const name of claudeSkills) {
  const relative = `.claude/skills/${name}/SKILL.md`;
  const source = read(relative);
  skillProblems(relative, name, frontmatter(relative, source), source, true);
}

for (const name of developmentSkills) {
  const relative = `.agents/skills/${name}/SKILL.md`;
  const source = read(relative);
  skillProblems(relative, name, frontmatter(relative, source), source, true);

  const shared = {
    where: `.claude/skills/${name}`,
    why: "Claude Code and Codex read one copy of a development Skill, so the two cannot drift (invariant host-parity)",
    fix: `make it a symlink to ../../.agents/skills/${name}`,
  };
  const claudePath = path.join(root, `.claude/skills/${name}`);
  try {
    if (!fs.lstatSync(claudePath).isSymbolicLink()) fail({ ...shared, what: "not a symlink" });
    if (fs.realpathSync(claudePath) !== fs.realpathSync(path.join(root, `.agents/skills/${name}`)))
      fail({ ...shared, what: `it does not lead to .agents/skills/${name}` });
  } catch (error) {
    fail({
      ...shared,
      what: `it cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

const releaseGuide = read(".agents/skills/plugin-release/SKILL.md");
const releaseStart = releaseGuide.indexOf("## Shipping");
const releaseEnd = releaseGuide.indexOf("## Confirming it arrived");
const releaseSteps =
  releaseStart === -1 || releaseEnd === -1 ? "" : releaseGuide.slice(releaseStart, releaseEnd);
const releaseOrder = [
  "git tag v<version> <head>",
  "npm publish <tgz> --tag latest --provenance",
  "--match-head-commit <head>",
  "git diff --exit-code <head> <merge commit>",
  "gh run watch <run-id> --exit-status",
];
const RELEASE_GUIDE = ".agents/skills/plugin-release/SKILL.md";
const RELEASE_WHY =
  "agents ship by following these steps as written, in order (invariant release-owner-steps)";
let releaseCursor = -1;
for (const [i, step] of releaseOrder.entries()) {
  const position = releaseSteps.indexOf(step);
  if (position === -1) {
    fail({
      where: RELEASE_GUIDE,
      what: `the Shipping steps lack \`${step}\``,
      why: RELEASE_WHY,
      fix: `restore the step with \`${step}\` in the Shipping section`,
    });
  } else if (position <= releaseCursor) {
    fail({
      where: RELEASE_GUIDE,
      what: `the step \`${step}\` is out of order`,
      why: RELEASE_WHY,
      fix: `move it after \`${releaseOrder[i - 1]}\``,
    });
  } else {
    releaseCursor = position;
  }
}
const OWNER_GATE =
  "the owner's approval of npm-release is the only gate before npm, and Claude never gives it (invariant release-owner-steps)";
// The owner's approval of npm-release is the only gate before npm.
// It is tied to the numbered step that holds the publish command, so a summary elsewhere cannot stand in for it.
const numberedSteps = releaseSteps.split(/^(?=\d+\. )/m).filter((step) => /^\d+\. /.test(step));
for (const [anchor, owner] of [["npm publish <tgz>", "The owner approves the `npm-release` environment"]]) {
  const step = numberedSteps.find((text) => text.includes(anchor));
  if (!step?.includes(owner)) {
    fail({
      where: RELEASE_GUIDE,
      what: `the step with \`${anchor}\` does not say \`${owner}\``,
      why: OWNER_GATE,
      fix: `say \`${owner}\` in the same numbered step`,
    });
  }
}
// Sentences end at a period before whitespace, not at the dots in `release.yml` or `npm@11.19.0`. Each table cell counts as one.
const releaseSentences = releaseSteps.split(/\.(?=\s)|\n\s*\n|\n(?=\s*(?:\d+\.|-) )|\|/);
for (const sentence of releaseSentences) {
  if (/\bClaude\b/i.test(sentence) && /\bapprov|dist-tag add/i.test(sentence)) {
    fail({
      where: RELEASE_GUIDE,
      what: `a sentence has Claude approve or promote: ${sentence.trim()}`,
      why: OWNER_GATE,
      fix: "say the owner approves, and that Claude only watches the run",
    });
  }
}
if (releaseSteps.includes("npm stage")) {
  fail({
    where: RELEASE_GUIDE,
    what: "the steps mention an npm stage",
    why: "release.yml publishes directly, so there is no stage to follow",
    fix: "remove the npm stage step",
  });
}
if (/`!\s*npm /.test(releaseSteps)) {
  fail({
    where: RELEASE_GUIDE,
    what: "an npm command is written after `!`",
    why: "`!` is Claude Code's input syntax, and in a shell it inverts the exit code",
    fix: "write the command without `!`",
  });
}
const releasePlanScript = read("scripts/release-plan.mjs");
const owners = releasePlanScript.match(/"owner: [^"]*"/g) ?? [];
if (owners.length !== 1 || !owners[0].startsWith('"owner: approve the npm-release environment')) {
  fail({
    where: "scripts/release-plan.mjs",
    what: `the owner actions are not exactly one \`owner: approve the npm-release environment\` (found ${owners.length})`,
    why: OWNER_GATE,
    fix: "keep one owner line in the plan, the one that starts `owner: approve the npm-release environment`",
  });
}
// release.yml is the only place that publishes; the steps may name its command, never a local one
for (const [publish] of releaseSteps.matchAll(/npm publish [^\n`]*/g)) {
  if (publish !== "npm publish <tgz> --tag latest --provenance") {
    fail({
      where: RELEASE_GUIDE,
      what: `a step publishes another way: \`${publish}\``,
      why: "only the tarball release.yml publishes from the tag goes to npm",
      fix: "name only release.yml's `npm publish <tgz> --tag latest --provenance`",
    });
  }
}

try {
  const pluginManifest = JSON.parse(read("plugin/.codex-plugin/plugin.json"));
  if (pluginManifest.skills !== "./skills/") {
    fail({
      where: "plugin/.codex-plugin/plugin.json",
      what: `skills is ${JSON.stringify(pluginManifest.skills)}`,
      why: "Codex finds the plugin's Skills only where the manifest points, and they live in plugin/skills",
      fix: 'set "skills": "./skills/"',
    });
  }
  if (pluginManifest.hooks !== "./hooks/codex.json") {
    fail({
      where: "plugin/.codex-plugin/plugin.json",
      what: `hooks is ${JSON.stringify(pluginManifest.hooks)}`,
      why: "Codex reads its hooks only from the file the manifest names",
      fix: 'set "hooks": "./hooks/codex.json"',
    });
  }
  const CODEX_HOOKS = "plugin/hooks/codex.json";
  const codexHooks = JSON.parse(read(CODEX_HOOKS)).hooks;
  // Codex runs commandWindows through the session's shell (PowerShell, cmd, or Git Bash). The path stays in the environment and the
  // shell sees only base64, so no character in the path is parsed as code. A node that never starts leaves $LASTEXITCODE null.
  const windowsCommand = (name) =>
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(
      `& node "$env:PLUGIN_ROOT/dist/${name}.js" codex; if ($null -eq $LASTEXITCODE) { exit 1 }; exit $LASTEXITCODE`,
      "utf16le",
    ).toString("base64")}`;
  for (const [event, groups] of Object.entries(codexHooks ?? {}))
    for (const hook of groups.flatMap((group) => group.hooks ?? [])) {
      const name = /dist\/(capture|deliver)\.js/.exec(hook.command ?? "")?.[1];
      if (!name || hook.commandWindows !== windowsCommand(name))
        fail({
          where: CODEX_HOOKS,
          what: `a ${event} hook's commandWindows is not the encoded launch of its bundle`,
          why: "Codex runs commandWindows through the session's shell, and only base64 keeps the plugin path from being read as code (invariant windows)",
          fix: `set it to the command windowsCommand in ${SELF} builds for the bundle the hook runs`,
        });
    }
  const codexCapture = ["$", '{PLUGIN_ROOT}/dist/capture.js" codex'].join("");
  const codexCaptureWindows = windowsCommand("capture");
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "Interrupt"]) {
    const commands = codexHooks?.[event]?.flatMap((group) => group.hooks ?? []) ?? [];
    if (!commands.some((hook) => hook.command?.includes(codexCapture))) {
      fail({
        where: CODEX_HOOKS,
        what: `${event} does not run capture`,
        why: "Codex sessions are recorded from these events, so the part a missing one covers is lost (invariant host-parity)",
        fix: `add a ${event} hook that runs node "${codexCapture}`,
      });
    }
    if (!commands.some((hook) => hook.commandWindows === codexCaptureWindows)) {
      fail({
        where: CODEX_HOOKS,
        what: `${event} has no Windows capture command`,
        why: "Codex on Windows runs commandWindows, so without it nothing is captured there (invariant windows)",
        fix: `give the ${event} capture hook the commandWindows windowsCommand("capture") in ${SELF} builds`,
      });
    }
    if (commands.some((hook) => hook.async)) {
      fail({
        where: CODEX_HOOKS,
        what: `a ${event} capture hook is async`,
        why: "async hooks can finish out of order, and the conversation would be saved out of order",
        fix: "remove async from the hook",
      });
    }
  }
  const codexDeliver = ["$", '{PLUGIN_ROOT}/dist/deliver.js" codex'].join("");
  const codexDeliverWindows = windowsCommand("deliver");
  for (const event of ["SessionStart", "SubagentStart", "UserPromptSubmit", "PreToolUse"]) {
    const groups = (codexHooks?.[event] ?? []).filter((group) =>
      (group.hooks ?? []).some((hook) => hook.command?.includes(codexDeliver)),
    );
    if (!groups.length)
      fail({
        where: CODEX_HOOKS,
        what: `${event} does not run delivery`,
        why: "Codex gets past records only from these events, so a missing one delivers nothing there (invariant host-parity)",
        fix: `add a ${event} hook that runs node "${codexDeliver}`,
      });
    if (!groups.some((group) => group.hooks.some((hook) => hook.commandWindows === codexDeliverWindows))) {
      fail({
        where: CODEX_HOOKS,
        what: `${event} has no Windows delivery command`,
        why: "Codex on Windows runs commandWindows, so without it nothing is delivered there (invariant windows)",
        fix: `give the ${event} delivery hook the commandWindows windowsCommand("deliver") in ${SELF} builds`,
      });
    }
    // Codex edits arrive as apply_patch and reads only as shell commands (Bash)
    if (
      event === "PreToolUse" &&
      !groups.some((group) => ["apply_patch", "Bash"].every((t) => new RegExp(group.matcher ?? "").test(t)))
    ) {
      fail({
        where: CODEX_HOOKS,
        what: "the PreToolUse delivery matcher does not match both apply_patch and Bash",
        why: "Codex edits files with apply_patch and reads them with shell commands, so records for a file arrive only on those",
        fix: "make the matcher match apply_patch and Bash",
      });
    }
  }
  if (
    (codexHooks?.PostToolUse ?? []).some((group) =>
      (group.hooks ?? []).some((hook) => hook.command?.includes(codexDeliver)),
    )
  )
    fail({
      where: CODEX_HOOKS,
      what: "PostToolUse runs delivery",
      why: "delivering after a tool call was tried and removed: most of what it delivered was noise",
      fix: "remove the delivery hook from PostToolUse; records are delivered before a tool call",
    });
  const claudeHooks = JSON.parse(read("plugin/hooks/hooks.json")).hooks ?? {};
  // Exec form: Claude Code starts node with the script path as one argument, with no shell (PowerShell on Windows without Git Bash
  // adds about 230 ms per launch). Each event's hooks are pinned, so a lost timeout, async, or matcher fails here too.
  const script = (name) => [["$", "{CLAUDE_PLUGIN_ROOT}"].join(""), "dist", `${name}.js`].join("/");
  const hook = (name, extra) => ({ type: "command", command: "node", args: [script(name)], ...extra });
  const claudeExpected = {
    SessionStart: [
      { hooks: [hook("capture", { timeout: 10 })] },
      { hooks: [hook("deliver", { timeout: 5 })] },
    ],
    // A subagent starts without the main conversation's context, so it is told to search Sphica's records first
    SubagentStart: [{ hooks: [hook("deliver", { timeout: 5 })] }],
    // Turn start and end are synchronous so the working tree is read before the model works and right as the turn ends. The timeout
    // leaves room for the git calls that find the project before the prompt is queued (5 seconds each at most)
    UserPromptSubmit: [
      { hooks: [hook("capture", { timeout: 30 })] },
      { hooks: [hook("deliver", { timeout: 5 })] },
    ],
    PostToolUse: [
      {
        matcher: "Edit|Write|MultiEdit|NotebookEdit|AskUserQuestion",
        hooks: [hook("capture", { async: true })],
      },
    ],
    Stop: [{ hooks: [hook("capture", { timeout: 30 })] }],
    // Claude Code reads with Read and, often, shell commands: Bash, or PowerShell on Windows without Git Bash
    PreToolUse: [
      // Synchronous: the record server joins its log of each record tool call to the session and turn this hook writes first
      { matcher: "mcp__plugin_sphica_record__.*", hooks: [hook("capture", { timeout: 10 })] },
      {
        matcher: "Edit|Write|MultiEdit|NotebookEdit|Read|Skill|Bash|PowerShell",
        hooks: [hook("deliver", { timeout: 5 })],
      },
    ],
    UserPromptExpansion: [{ hooks: [hook("deliver", { timeout: 5 })] }],
  };
  const sorted = (v) =>
    Array.isArray(v)
      ? v.map(sorted)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sorted(v[k])]),
          )
        : v;
  for (const event of new Set([...Object.keys(claudeExpected), ...Object.keys(claudeHooks)])) {
    const want = JSON.stringify(sorted(claudeExpected[event] ?? null));
    const got = JSON.stringify(sorted(claudeHooks[event] ?? null));
    if (want !== got)
      fail({
        where: "plugin/hooks/hooks.json",
        what: `${event} is ${got}`,
        why: "each event's hooks are pinned, so a lost timeout, async, or matcher cannot slip through (exec form starts node without a shell)",
        fix: `set ${event} to ${want}, or change claudeExpected in ${SELF} if the change is meant`,
      });
  }
  const MARKETPLACE = ".claude-plugin/marketplace.json";
  const marketplace = JSON.parse(read(MARKETPLACE));
  const entry = marketplace.plugins?.[0];
  const src = entry?.source;
  if (src?.source !== "npm" || src?.package !== "sphica") {
    fail({
      where: MARKETPLACE,
      what: `the source is ${JSON.stringify(src)}`,
      why: "the marketplace installs Sphica from npm, so its source must name that package",
      fix: 'set source to { "source": "npm", "package": "sphica", "version": "<exact version>" }',
    });
  } else if (!/^\d+\.\d+\.\d+$/.test(src.version ?? "")) {
    fail({
      where: MARKETPLACE,
      what: `source.version is ${JSON.stringify(src.version)}, not an exact version`,
      why: "a range or latest would make the same commit install different tarballs over time",
      fix: "set source.version to the exact version the package is at",
    });
  }
  if (entry?.version !== undefined) {
    fail({
      where: MARKETPLACE,
      what: "the plugin entry has a version beside the one in source",
      why: "with both set, Claude Code takes plugin.json's version without a warning and ignores the marketplace value",
      fix: "remove version from the entry and keep it only inside source",
    });
  }
} catch (error) {
  fail({
    where: "plugin manifests",
    what: `a manifest cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    why: "the hook and marketplace checks cannot run on a manifest that does not parse",
    fix: "make the manifest named in the error valid JSON",
  });
}

// Sphica's MCP tools by server, read from where they are registered, so a Skill can be held against the tools that exist.
const registeredTools = (file) =>
  [...withoutComments(read(file)).matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
const sphicaTools = new Map([
  ["sphica", registeredTools("server/src/mcp.ts")],
  ["record", registeredTools("server/src/mcp-record.ts")],
]);
for (const [server, tools] of sphicaTools)
  if (!tools.length)
    fail({
      where: server === "sphica" ? "server/src/mcp.ts" : "server/src/mcp-record.ts",
      what: `no registerTool calls were found for the ${server} server`,
      why: "the Skills' allowed-tools are held against these tools, and with none found that check would compare nothing",
      fix: `fix registeredTools in ${SELF} to match how the server registers its tools`,
    });
const toolId = new Map(
  [...sphicaTools].flatMap(([server, tools]) => tools.map((t) => [t, `mcp__plugin_sphica_${server}__${t}`])),
);
// The read tools any Skill's turn may reach for: the read server's instructions send an agent to status after an empty search
const alwaysAllowed = ["status", "search", "read"].map((t) => toolId.get(t));

const skillDirectory = path.join(root, "plugin/skills");
const pluginSkills = fs
  .readdirSync(skillDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
for (const name of pluginSkills) {
  const relative = `plugin/skills/${name}/SKILL.md`;
  const source = read(relative);
  const fields = frontmatter(relative, source);
  skillProblems(relative, name, fields, source, false);
  // The whole review SKILL enters context on every call. This limit guards against **growth by appending**;
  // it does not measure quality. Steps read only when using the other model live in references/.
  // If it is exceeded, remove duplicated concepts before raising the limit.
  if (name === "review" && source.split("\n").length > 497) {
    fail({
      where: relative,
      what: `the file has ${source.split("\n").length} lines`,
      why: "the whole review Skill enters context on every call, and the limit stops it growing by appending",
      fix: "remove duplicated concepts or move steps read only with the other model into references/ until it is at 497 lines or fewer",
    });
  }

  // allowed-tools pre-approves tools for the Skill's own turn; a tool the body names but the list lacks is denied in a headless run.
  // Reviewers under reviewers/ get their tools from the launch table in SKILL.md, so their names are checked through SKILL.md.
  const referenceDir = path.join(skillDirectory, name, "references");
  const body = [
    source,
    ...(fs.existsSync(referenceDir)
      ? fs
          .readdirSync(referenceDir)
          .filter((f) => f.endsWith(".md"))
          .map((f) => read(`plugin/skills/${name}/references/${f}`))
      : []),
  ].join("\n");
  // Hosts take a comma-separated line; a YAML list parses here as an array
  const listed = fields["allowed-tools"] ?? [];
  const allowed = new Set(
    (Array.isArray(listed) ? listed : listed.split(",")).map((t) => t.trim()).filter(Boolean),
  );
  const named = [
    ...[...body.matchAll(/`([a-z_]+)`/g)].map((m) => toolId.get(m[1])).filter(Boolean),
    ...[...body.matchAll(/\bmcp__plugin_sphica_[a-z]+__[a-z_]+/g)].map((m) => m[0]),
    ...(/\bAskUserQuestion\b/.test(body) ? ["AskUserQuestion"] : []),
  ];
  for (const id of new Set([...alwaysAllowed, ...named]))
    if (!allowed.has(id))
      fail({
        where: relative,
        what: `allowed-tools lacks ${id}`,
        why: "allowed-tools approves tools for the Skill's own turn, and a tool the body names but the list lacks is denied in a headless run",
        fix: `add ${id} to allowed-tools`,
      });
  for (const id of allowed)
    if (id.startsWith("mcp__plugin_sphica_") && ![...toolId.values()].includes(id))
      fail({
        where: relative,
        what: `allowed-tools names ${id}, which no Sphica server registers`,
        why: "an approval for a tool that does not exist hides a renamed or removed tool",
        fix: `remove ${id}, or name the tool as the server registers it`,
      });

  // Codex ignores disable-model-invocation, so explicit-only invocation also needs openai.yaml.
  const policy = path.join(skillDirectory, name, "agents/openai.yaml");
  const codexExplicitOnly =
    fs.existsSync(policy) &&
    /^policy:\n\s+allow_implicit_invocation:\s*false\s*$/m.test(
      fs.readFileSync(policy, "utf8").replaceAll("\r\n", "\n"),
    );
  // Codex may be stricter than Claude Code (it picks trace on its own only when the session-start notice names the file), never looser
  if (fields["disable-model-invocation"] === "true" && !codexExplicitOnly) {
    fail({
      where: relative,
      what: "disable-model-invocation is true, but agents/openai.yaml does not set allow_implicit_invocation: false",
      why: "Codex ignores disable-model-invocation, so it would start the Skill on its own (invariant host-parity)",
      fix: "add agents/openai.yaml beside it holding policy: with allow_implicit_invocation: false",
    });
  }
  // The description is what an agent reads to decide whether to invoke it, so it must say what the settings allow
  if (
    (fields["disable-model-invocation"] === "true") !==
    /\bUse only when the user explicitly asks\b/.test(fields.description ?? "")
  ) {
    fail({
      where: relative,
      what: 'the description and disable-model-invocation disagree on "Use only when the user explicitly asks"',
      why: "an agent reads the description to decide whether to invoke the Skill, so it must say what the settings allow",
      fix: 'say "Use only when the user explicitly asks" in the description exactly when disable-model-invocation is true',
    });
  }

  // Sphica is not on Codex's PATH (exit 127 observed). **Start the JS in the package directly, without a shell script.**
  // npm `bin` has no contract to be on PATH inside a plugin, and POSIX shells do not run on Windows.
  if (/\}\/bin\/sphica|\.\.\/\.\.\/bin\/sphica/m.test(source)) {
    fail({
      where: relative,
      what: "the Skill runs bin/sphica",
      why: "npm's bin is not on PATH inside a plugin, and a shell script does not run on Windows (invariant windows)",
      fix: `start the CLI as node "\${CLAUDE_PLUGIN_ROOT}/dist/cli.js"`,
    });
  }
  if (/Bash\(sphica |^sphica /m.test(source)) {
    fail({
      where: relative,
      what: "the Skill runs a bare sphica command",
      why: "sphica is not on Codex's PATH (it exits 127)",
      fix: `start the CLI as node "\${CLAUDE_PLUGIN_ROOT}/dist/cli.js", with ../../dist/cli.js for Codex`,
    });
  }
  if (/dist\/cli\.js/.test(source) && !source.includes("../../dist/cli.js")) {
    fail({
      where: relative,
      what: "the Skill runs the CLI but gives Codex no ../../dist/cli.js",
      why: "Codex has no CLAUDE_PLUGIN_ROOT, so it reaches the CLI only by the path from the Skill (invariant host-parity)",
      fix: "add the ../../dist/cli.js path beside the Claude Code one",
    });
  }
}

// The choices from claude --help. An invalid value only warns and falls back to the session default.
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

// Checks what guards a fork's pull request before the owner approves it. The project settings reach every session started in this
// repository, cloud ones included, so they hold the checkout deny and nothing else.
const FORK_RULES = "scripts/lib/fork-intake.mjs";
const forkIntake = [
  [
    ".claude/settings.json",
    settingsProblems,
    "the project settings reach every session started here, cloud ones included, so they hold the checkout deny and nothing else (invariant fork-pr-as-data)",
    `keep the file to permissions.deny holding exactly CHECKOUT_DENY from ${FORK_RULES}`,
  ],
  // The agent that reads a fork's text for this session holds read tools only
  [
    ".claude/agents/fork-reader.md",
    readerProblems,
    "the reader reads a fork's text before the owner approves it, so it holds the read tools and nothing that acts (invariant fork-pr-as-data)",
    "keep the frontmatter to one plain value each of name, description, tools, model, effort, and maxTurns, with tools: Read, Grep, Glob",
  ],
  // Codex reads a fork's diff without the tools that reach outside its sandbox
  [
    ".claude/skills/fork-pr/SKILL.md",
    reviewCommandProblems,
    "Codex reads a fork's diff with this one command, so a flag dropped or added changes what it can reach (invariant fork-pr-as-data)",
    `write REVIEW_COMMAND from ${FORK_RULES} once, word for word, in a bash block right after the mark, and keep the step that starts the fork-reader agent`,
  ],
];
for (const [file, problemsOf, why, fix] of forkIntake) {
  const text = read(file);
  // A missing file was already reported by the read; an empty one still has to be judged
  if (fs.existsSync(path.join(root, file)))
    for (const problem of problemsOf(text)) fail({ where: file, what: problem, why, fix });
}

// Checks the repository-only agents (.claude/agents). Shipped reviewers are not Agent definitions but
// the bodies in plugin/skills/review/reviewers/, which have no frontmatter
// (check-pairs.mjs checks those).
const agentDirectories = [".claude/agents"];
const agentEntries = agentDirectories.flatMap((directory) => {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) return [];
  return fs
    .readdirSync(absolute)
    .filter((file) => file.endsWith(".md"))
    .map((file) => `${directory}/${file}`);
});
const agentFiles = agentEntries;
for (const relative of agentEntries) {
  const file = path.basename(relative);
  const source = read(relative);
  const fields = frontmatter(relative, source);
  for (const required of ["name", "description", "tools", "model", "effort", "maxTurns"]) {
    if (!fields[required])
      fail({
        where: relative,
        what: `no ${required}`,
        why: "an agent left to the session's defaults runs with tools, model, effort, or turns nobody chose for it",
        fix: `set ${required} in the frontmatter`,
      });
  }
  if (fields.name !== path.basename(file, ".md"))
    fail({
      where: relative,
      what: `name is ${fields.name ?? "missing"}, not the file name`,
      why: "agents are started by name, and a name that differs from the file is hard to find",
      fix: `set name: ${path.basename(file, ".md")}`,
    });
  if (fields.model === "inherit")
    fail({
      where: relative,
      what: "model is inherit",
      why: "the agent would run on whatever model the session uses, not the one chosen for its job",
      fix: "name the model the agent runs on",
    });
  if (!EFFORT_LEVELS.has(fields.effort)) {
    fail({
      where: relative,
      what: `effort is ${fields.effort}`,
      why: "Claude Code only warns on an unknown effort and falls back to the session's",
      fix: `set effort to one of ${[...EFFORT_LEVELS].join(", ")}`,
    });
  }
  // Some definitions also name the effort in the body with a reason. Fixing only one makes readers and the CLI see different values.
  const named = /`effort: ([a-z]+)`/.exec(source.replace(/^---\n[\s\S]*?\n---\n/, ""));
  if (named && named[1] !== fields.effort) {
    fail({
      where: relative,
      what: `the frontmatter's effort is ${fields.effort}, but the body says ${named[1]}`,
      why: "readers follow the body and the host follows the frontmatter, so they would see different values",
      fix: "make the two say the same effort",
    });
  }
  // If a preloaded Skill does not exist, the name does not resolve and the body's premise breaks.
  for (const name of Array.isArray(fields.skills) ? fields.skills : []) {
    const repoSkill = fs.existsSync(path.join(root, ".agents/skills", name, "SKILL.md"));
    const pluginSkill = fs.existsSync(path.join(root, "plugin/skills", name, "SKILL.md"));
    if (!repoSkill && !pluginSkill)
      fail({
        where: relative,
        what: `the preloaded skill ${name} does not exist`,
        why: "a skill name that does not resolve leaves the agent without what its body assumes it has",
        fix: `name a Skill in .agents/skills or plugin/skills, or remove ${name}`,
      });
  }
  if (!Number.isInteger(Number(fields.maxTurns)) || Number(fields.maxTurns) <= 0) {
    fail({
      where: relative,
      what: `maxTurns is ${fields.maxTurns}`,
      why: "only a positive integer bounds how long the agent runs",
      fix: "set maxTurns to a positive integer",
    });
  }
}

// Checks that removed premises (the old storage and keys, the terminal screen) have not returned to documents AIs read. If they return, AIs
// point to commands and keys that no longer exist. Documents that mention the old setup should call it the old setup and avoid these spellings.
const GONE = [
  /pgvector/i,
  /VOYAGE_API_KEY/,
  /SPHICA_DB_URL/,
  /docker compose/i,
  /halfvec/i,
  /tsvector/i,
  /db:roles/,
  /sphica dashboard/,
  /sphica search/,
  /sphica project add/,
  /\bInk\b/,
  /server\/src\/tui/,
];
const docs = [
  "AGENTS.md",
  "CLAUDE.md",
  ...fs.readdirSync(path.join(root, ".claude/rules")).map((f) => `.claude/rules/${f}`),
  ...developmentSkills.map((name) => `.agents/skills/${name}/SKILL.md`),
  ...claudeSkills.map((name) => `.claude/skills/${name}/SKILL.md`),
  ...pluginSkills.map((name) => `plugin/skills/${name}/SKILL.md`),
  ...pluginSkills.flatMap((name) => {
    const dir = path.join(root, "plugin/skills", name, "references");
    return fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((f) => f.endsWith(".md"))
          .map((f) => `plugin/skills/${name}/references/${f}`)
      : [];
  }),
  ...agentFiles,
  // Shipped manifest keywords and descriptions also show the old setup to users
  "plugin/package.json",
  "plugin/.claude-plugin/plugin.json",
  "plugin/.codex-plugin/plugin.json",
];
for (const relative of docs) {
  const source = read(relative);
  for (const word of GONE)
    if (word.test(source))
      fail({
        where: relative,
        what: `a removed premise is back: ${word.source}`,
        why: "agents that read it point to commands, keys, or storage that no longer exist",
        fix: "describe the current setup, or call the old one the old setup without these spellings",
      });
}

if (!report("AI config", failures))
  console.log(
    `AI config: CLAUDE ${claudeLines} lines, AGENTS ${lines} lines / ${bytes} bytes, ${codexSide.size} invariants, ${developmentSkills.length} development Skills, ${pluginSkills.length} plugin Skills, ${agentFiles.length} Agents`,
  );
