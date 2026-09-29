import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { withoutComments } from "./lib/english.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const developmentSkills = ["knowledge-schema", "plugin-agent-authoring", "plugin-release"];

function fail(message) {
  failures.push(message);
}

function read(relative) {
  const file = path.join(root, relative);
  try {
    return fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  } catch (error) {
    fail(`${relative}: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  }
}

function frontmatter(relative, source) {
  if (!source.startsWith("---\n")) {
    fail(`${relative}: no YAML frontmatter`);
    return {};
  }
  const end = source.indexOf("\n---\n", 4);
  if (end === -1) {
    fail(`${relative}: YAML frontmatter is not closed`);
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
      fail(`${relative}: cannot parse frontmatter line: ${line}`);
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

function checkLocalLinks(relative, source) {
  for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].split("#", 1)[0];
    if (!target || /^(https?:|mailto:)/.test(target)) continue;
    const resolved = path.resolve(root, path.dirname(relative), target);
    if (!fs.existsSync(resolved)) fail(`${relative}: link target does not exist: ${target}`);
  }
}

const agents = read("AGENTS.md");
const lines = agents.trimEnd().split("\n").length;
const bytes = Buffer.byteLength(agents);
if (lines >= 200) fail(`AGENTS.md: ${lines} lines. Keep it under 200`);
if (!agents.includes("Read `plugin/skills/review/SKILL.md` from the checkout")) {
  fail(
    "AGENTS.md: missing the rule that Codex reads the review Skill from the checkout as the source of truth",
  );
}
if (!agents.includes("join the value of `rN` in `Skill roots` with the rest exactly as written")) {
  fail("AGENTS.md: missing the rule that Codex resolves shortened Skill paths literally");
}

// **Codex concatenates AGENTS.md files from global through repo root to CWD and cuts off at 32 KiB.**
// Checking only the root would let nested files be cut silently. This checks the repository's total
// (the owner's ~/.codex/AGENTS.md differs per machine, so a margin for it is subtracted).
const CODEX_LIMIT = 32 * 1024;
// The allowance for the owner's ~/.codex/AGENTS.md: measured 18,638 bytes (2026-09-20) plus 1 KiB of growth.
// **Raising it shrinks the repository's margin.** When space runs out, move long procedures into Skills.
// There is no nested AGENTS.md. If one is added, add it here too.
const USER_RESERVE = 19 * 1024;
if (bytes > CODEX_LIMIT - USER_RESERVE) {
  fail(
    `AGENTS.md is ${bytes} bytes. Keep it within ${CODEX_LIMIT - USER_RESERVE}, Codex's 32 KiB minus the global allowance of ${USER_RESERVE}. ` +
      "Move long procedures into .agents/skills/",
  );
}
// **CLAUDE.md is for Claude Code only, and AGENTS.md for Codex only.** Claude Code skips AGENTS.md when CLAUDE.md exists,
// and Codex does not read CLAUDE.md (both confirmed by experiment on 2026-09-23). Importing one into the other makes both read both.
const claudeMd = read("CLAUDE.md");
// An import works mid-sentence too (`see @AGENTS.md`). Code spans are not imported, so strip them before checking.
if (/(?:^|\s)@\S*AGENTS\.md\b/m.test(claudeMd.replace(/```[\s\S]*?```|`[^`\n]*`/g, "")))
  fail("CLAUDE.md: imports AGENTS.md. Keep the two separate");
const claudeLines = claudeMd.trimEnd().split("\n").length;
// The official guideline is under 200 lines. Always-loaded rules without paths add to it, so CLAUDE.md alone stays at half.
if (claudeLines >= 100)
  fail(
    `CLAUDE.md: ${claudeLines} lines. Keep it under 100 by moving procedures to Skills and file-specific rules to rules with paths`,
  );
// Codex cannot use Claude Code features (rules, reviewers, Claude-only Skills). Mentioning them makes it look for things that do not exist or start another AI instead.
for (const word of [".claude/rules", ".claude/agents", "review-shipping", "docs-author"])
  if (agents.includes(word))
    fail(`AGENTS.md: mentions a Claude Code feature (${word}) that Codex cannot use`);

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
if (codexSide.size < 20)
  fail(`AGENTS.md: only ${codexSide.size} invariants found. Check whether the marker format broke`);
for (const id of claudeSide)
  if (!codexSide.has(id)) fail(`AGENTS.md: invariant ${id} exists only on the CLAUDE.md side`);
for (const id of codexSide)
  if (!claudeSide.has(id))
    fail(`CLAUDE.md, .claude/rules: invariant ${id} exists only on the AGENTS.md side`);
// The comment rules are the same words on both sides, not only the same markers.
const commentRules = ["comment-length", "comment-refs", "comment-history"];
const markedLines = (source, id) =>
  source.split("\n").filter((line) => line.endsWith(`<!-- invariant: ${id} -->`));
const commentsRule = read(".claude/rules/comments.md");
for (const id of commentRules) {
  const claude = markedLines(commentsRule, id);
  const codex = markedLines(agents, id);
  if (claude.length !== 1 || codex.length !== 1)
    fail(`.claude/rules/comments.md, AGENTS.md: keep exactly one line for invariant ${id} in each`);
  else if (claude[0] !== codex[0])
    fail(`AGENTS.md: the ${id} line differs from .claude/rules/comments.md. Keep the words the same`);
}
const claudeVerification = read(".claude/rules/verification.md");
for (const required of [
  "bun run release:plan -- --base <previous release commit>",
  "`plugin`: a change that goes into the package",
  "the tarball `.github/workflows/release.yml` publishes",
  "Before each release step, reopen the `plugin-release` Skill",
]) {
  if (!claudeVerification.includes(required)) {
    fail(`.claude/rules/verification.md: Claude's release rules are missing \`${required}\``);
  }
}

// Claude Code-only Skills (not in .agents/skills, invisible to Codex): the directories that are not symlinks.
const claudeSkills = fs
  .readdirSync(path.join(root, ".claude/skills"))
  .filter((name) => !fs.lstatSync(path.join(root, ".claude/skills", name)).isSymbolicLink());
for (const name of claudeSkills) {
  const relative = `.claude/skills/${name}/SKILL.md`;
  const source = read(relative);
  const fields = frontmatter(relative, source);
  if (fields.name !== name) fail(`${relative}: name does not match the directory name`);
  if (!fields.description) fail(`${relative}: no description`);
  if ((fields.description ?? "").length > 1024) fail(`${relative}: description exceeds 1024 characters`);
  if (!source.includes("## Triggers") || !source.includes("## Does not trigger")) {
    fail(`${relative}: needs Triggers and Does not trigger sections`);
  }
  if (/\b(TODO|TBD)\b/.test(source)) fail(`${relative}: TODO / TBD remains`);
  checkLocalLinks(relative, source);
}

for (const name of developmentSkills) {
  const relative = `.agents/skills/${name}/SKILL.md`;
  const source = read(relative);
  const fields = frontmatter(relative, source);
  if (fields.name !== name) fail(`${relative}: name does not match the directory name`);
  if (!fields.description) fail(`${relative}: no description`);
  if ((fields.description ?? "").length > 1024) fail(`${relative}: description exceeds 1024 characters`);
  if (!source.includes("## Triggers") || !source.includes("## Does not trigger")) {
    fail(`${relative}: trigger and non-trigger examples are incomplete`);
  }
  if (/\b(TODO|TBD)\b/.test(source)) fail(`${relative}: an unfinished placeholder remains`);
  checkLocalLinks(relative, source);

  const claudePath = path.join(root, `.claude/skills/${name}`);
  try {
    if (!fs.lstatSync(claudePath).isSymbolicLink()) fail(`.claude/skills/${name}: not a symlink`);
    if (fs.realpathSync(claudePath) !== fs.realpathSync(path.join(root, `.agents/skills/${name}`))) {
      fail(`.claude/skills/${name}: does not point to the same directory as the Codex source of truth`);
    }
  } catch (error) {
    fail(`.claude/skills/${name}: ${error instanceof Error ? error.message : String(error)}`);
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
let releaseCursor = -1;
for (const step of releaseOrder) {
  const position = releaseSteps.indexOf(step);
  if (position === -1) {
    fail(`.agents/skills/plugin-release/SKILL.md: release steps are missing \`${step}\``);
  } else if (position <= releaseCursor) {
    fail(`.agents/skills/plugin-release/SKILL.md: release step \`${step}\` is out of order`);
  } else {
    releaseCursor = position;
  }
}
// The owner's approval of npm-release is the only gate before npm.
// It is tied to the numbered step that holds the publish command, so a summary elsewhere cannot stand in for it.
const numberedSteps = releaseSteps.split(/^(?=\d+\. )/m).filter((step) => /^\d+\. /.test(step));
for (const [anchor, owner] of [["npm publish <tgz>", "The owner approves the `npm-release` environment"]]) {
  const step = numberedSteps.find((text) => text.includes(anchor));
  if (!step?.includes(owner)) {
    fail(`.agents/skills/plugin-release/SKILL.md: the step with \`${anchor}\` must say \`${owner}\``);
  }
}
// Sentences end at a period before whitespace, not at the dots in `release.yml` or `npm@11.19.0`. Each table cell counts as one.
const releaseSentences = releaseSteps.split(/\.(?=\s)|\n\s*\n|\n(?=\s*(?:\d+\.|-) )|\|/);
for (const sentence of releaseSentences) {
  if (/\bClaude\b/i.test(sentence) && /\bapprov|dist-tag add/i.test(sentence)) {
    fail(`.agents/skills/plugin-release/SKILL.md: Claude must not approve or promote: ${sentence.trim()}`);
  }
}
if (releaseSteps.includes("npm stage")) {
  fail(
    ".agents/skills/plugin-release/SKILL.md: release.yml publishes directly; there is no npm stage to follow",
  );
}
if (/`!\s*npm /.test(releaseSteps)) {
  fail(
    ".agents/skills/plugin-release/SKILL.md: `!` is Claude Code input syntax; in a shell it inverts the exit code",
  );
}
const releasePlanScript = read("scripts/release-plan.mjs");
const owners = releasePlanScript.match(/"owner: [^"]*"/g) ?? [];
if (owners.length !== 1 || !owners[0].startsWith('"owner: approve the npm-release environment')) {
  fail(
    "scripts/release-plan.mjs: the only owner action must be `owner: approve the npm-release environment`",
  );
}
// release.yml is the only place that publishes; the steps may name its command, never a local one
for (const [publish] of releaseSteps.matchAll(/npm publish [^\n`]*/g)) {
  if (publish !== "npm publish <tgz> --tag latest --provenance") {
    fail(`.agents/skills/plugin-release/SKILL.md: only release.yml publishes (found \`${publish}\`)`);
  }
}

try {
  const pluginManifest = JSON.parse(read("plugin/.codex-plugin/plugin.json"));
  if (pluginManifest.skills !== "./skills/") {
    fail("plugin/.codex-plugin/plugin.json: user-facing Skills must live in ./skills/");
  }
  if (pluginManifest.hooks !== "./hooks/codex.json") {
    fail("plugin/.codex-plugin/plugin.json: Codex hooks must read ./hooks/codex.json");
  }
  const codexHooks = JSON.parse(read("plugin/hooks/codex.json")).hooks;
  const codexCapture = ["$", '{PLUGIN_ROOT}/dist/capture.js" codex'].join("");
  const codexCaptureWindows =
    "powershell.exe -NoProfile -NonInteractive -Command node $env:PLUGIN_ROOT/dist/capture.js codex";
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "Interrupt"]) {
    const commands = codexHooks?.[event]?.flatMap((group) => group.hooks ?? []) ?? [];
    if (!commands.some((hook) => hook.command?.includes(codexCapture))) {
      fail(`plugin/hooks/codex.json: ${event} is not wired to Codex capture`);
    }
    if (!commands.some((hook) => hook.commandWindows === codexCaptureWindows)) {
      fail(`plugin/hooks/codex.json: ${event} has no Windows capture command`);
    }
    if (commands.some((hook) => hook.async)) {
      fail(`plugin/hooks/codex.json: making ${event} async would break conversation order`);
    }
  }
  const codexDeliver = ["$", '{PLUGIN_ROOT}/dist/deliver.js" codex'].join("");
  const codexDeliverWindows =
    "powershell.exe -NoProfile -NonInteractive -Command node $env:PLUGIN_ROOT/dist/deliver.js codex";
  for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse"]) {
    const groups = (codexHooks?.[event] ?? []).filter((group) =>
      (group.hooks ?? []).some((hook) => hook.command?.includes(codexDeliver)),
    );
    if (!groups.length) fail(`plugin/hooks/codex.json: ${event} is not wired to Codex delivery`);
    if (!groups.some((group) => group.hooks.some((hook) => hook.commandWindows === codexDeliverWindows))) {
      fail(`plugin/hooks/codex.json: ${event} has no Windows delivery command`);
    }
    // Codex edits arrive as apply_patch and reads only as shell commands (Bash)
    if (
      event === "PreToolUse" &&
      !groups.some((group) => ["apply_patch", "Bash"].every((t) => new RegExp(group.matcher ?? "").test(t)))
    ) {
      fail("plugin/hooks/codex.json: the PreToolUse delivery matcher must cover apply_patch and Bash");
    }
  }
  // Claude Code reads with the Read tool and, often, with shell commands (Bash): the delivery hook must see both
  const claudeDeliver = (JSON.parse(read("plugin/hooks/hooks.json")).hooks?.PreToolUse ?? []).filter(
    (group) => (group.hooks ?? []).some((hook) => hook.command?.includes("/dist/deliver.js")),
  );
  if (
    !claudeDeliver.some((group) =>
      ["Read", "Bash"].every((t) => new RegExp(`^(?:${group.matcher ?? ""})$`).test(t)),
    )
  ) {
    fail("plugin/hooks/hooks.json: the PreToolUse delivery matcher must cover Read and Bash");
  }
  const marketplace = JSON.parse(read(".claude-plugin/marketplace.json"));
  const entry = marketplace.plugins?.[0];
  const src = entry?.source;
  if (src?.source !== "npm" || src?.package !== "sphica") {
    fail(".claude-plugin/marketplace.json: the source must be the sphica npm package");
  } else if (!/^\d+\.\d+\.\d+$/.test(src.version ?? "")) {
    // A range or latest would make the same commit resolve to different tarballs over time.
    fail(`.claude-plugin/marketplace.json: version must be exact (got: ${src.version})`);
  }
  if (entry?.version !== undefined) {
    // With both set, Claude Code uses plugin.json without warning and silently ignores the marketplace value.
    fail(".claude-plugin/marketplace.json: version belongs only inside source");
  }
} catch (error) {
  fail(`plugin manifest: ${error instanceof Error ? error.message : String(error)}`);
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
    fail(`server/src: no registerTool calls found for the ${server} server. Check how tools are registered`);
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
  if (fields.name !== name) fail(`${relative}: name does not match the directory name`);
  if (!fields.description) fail(`${relative}: no description`);
  if ((fields.description ?? "").length > 1024) fail(`${relative}: description exceeds 1024 characters`);
  // The whole review SKILL enters context on every call. This limit guards against **growth by appending**;
  // it does not measure quality. Steps read only when using the other model live in references/.
  // If it is exceeded, remove duplicated concepts before raising the limit.
  if (name === "review" && source.split("\n").length > 497) {
    fail(
      `${relative}: ${source.split("\n").length} lines. Keep it at 497 or fewer (if you added a section, remove duplicated concepts)`,
    );
  }
  checkLocalLinks(relative, source);

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
    if (!allowed.has(id)) fail(`${relative}: allowed-tools lacks ${id}`);
  for (const id of allowed)
    if (id.startsWith("mcp__plugin_sphica_") && ![...toolId.values()].includes(id))
      fail(`${relative}: allowed-tools names ${id}, which no Sphica server registers`);

  // Codex ignores disable-model-invocation, so explicit-only invocation also needs openai.yaml.
  const policy = path.join(skillDirectory, name, "agents/openai.yaml");
  const codexExplicitOnly =
    fs.existsSync(policy) &&
    /^policy:\n\s+allow_implicit_invocation:\s*false\s*$/m.test(
      fs.readFileSync(policy, "utf8").replaceAll("\r\n", "\n"),
    );
  if ((fields["disable-model-invocation"] === "true") !== codexExplicitOnly) {
    fail(
      `${relative}: disable-model-invocation: true and allow_implicit_invocation: false in agents/openai.yaml do not match`,
    );
  }

  // Sphica is not on Codex's PATH (exit 127 observed). **Start the JS in the package directly, without a shell script.**
  // npm `bin` has no contract to be on PATH inside a plugin, and POSIX shells do not run on Windows.
  if (/\}\/bin\/sphica|\.\.\/\.\.\/bin\/sphica/m.test(source)) {
    fail(`${relative}: do not use bin/sphica. Call it as node "\${CLAUDE_PLUGIN_ROOT}/dist/cli.js"`);
  }
  if (/Bash\(sphica |^sphica /m.test(source)) {
    fail(`${relative}: bare sphica is not on Codex's PATH. Start dist/cli.js in the package directly`);
  }
  if (/dist\/cli\.js/.test(source) && !source.includes("../../dist/cli.js")) {
    fail(`${relative}: calls the sphica CLI but has no ../../dist/cli.js for Codex`);
  }
}

// The choices from claude --help. An invalid value only warns and falls back to the session default.
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

// Checks the repository-only reviewers (.claude/agents). Shipped reviewers are not Agent definitions but
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
    if (!fields[required]) fail(`${relative}: no ${required}`);
  }
  if (fields.name !== path.basename(file, ".md")) fail(`${relative}: name does not match the file name`);
  if (fields.model === "inherit") fail(`${relative}: model must not inherit from the session`);
  if (!EFFORT_LEVELS.has(fields.effort)) {
    fail(`${relative}: effort must be one of ${[...EFFORT_LEVELS].join(" / ")} (${fields.effort})`);
  }
  // Some definitions also name the effort in the body with a reason. Fixing only one makes readers and the CLI see different values.
  const named = /`effort: ([a-z]+)`/.exec(source.replace(/^---\n[\s\S]*?\n---\n/, ""));
  if (named && named[1] !== fields.effort) {
    fail(`${relative}: frontmatter effort is ${fields.effort}, but the body says ${named[1]}`);
  }
  // If a preloaded Skill does not exist, the name does not resolve and the body's premise breaks.
  for (const name of Array.isArray(fields.skills) ? fields.skills : []) {
    const repoSkill = fs.existsSync(path.join(root, ".agents/skills", name, "SKILL.md"));
    const pluginSkill = fs.existsSync(path.join(root, "plugin/skills", name, "SKILL.md"));
    if (!repoSkill && !pluginSkill) fail(`${relative}: skill ${name} does not exist`);
  }
  if (!Number.isInteger(Number(fields.maxTurns)) || Number(fields.maxTurns) <= 0) {
    fail(`${relative}: maxTurns must be a positive integer`);
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
    if (word.test(source)) fail(`${relative}: a removed premise (${word.source}) has returned`);
}

if (failures.length > 0) {
  console.error(failures.map((message) => `- ${message}`).join("\n"));
  process.exit(1);
}

console.log(
  `AI config: CLAUDE ${claudeLines} lines, AGENTS ${lines} lines / ${bytes} bytes, ${codexSide.size} invariants, ${developmentSkills.length} development Skills, ${pluginSkills.length} plugin Skills, ${agentFiles.length} Agents`,
);
