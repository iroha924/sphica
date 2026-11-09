// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// What guards a fork's pull request before the owner approves it stays in the shape the checks expect: each test breaks the tracked
// file one way and expects the check to say so
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readerProblems, readerStepProblems, settingsProblems } from "../../scripts/lib/fork-intake.mjs";
import { assertFindings } from "./finding-shape.ts";
import { tempDir } from "./temp-dir.ts";

const REPO = path.join(import.meta.dirname, "..", "..");
const tracked = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

type Settings = { permissions: { deny: string[] } & Record<string, unknown> } & Record<string, unknown>;
const settings = () => JSON.parse(tracked(".claude/settings.json")) as Settings;
const withSettings = (change: (s: Settings) => void) => {
  const s = settings();
  change(s);
  return settingsProblems(JSON.stringify(s));
};

test("the project settings deny gh pr checkout and its two other names, and hold nothing else", () => {
  assert.deepEqual(settingsProblems(tracked(".claude/settings.json")), []);
  assert.deepEqual(settings().permissions.deny, [
    "Bash(gh pr checkout *)",
    "Bash(gh pr co *)",
    "Bash(gh co *)",
  ]);
});

test("a deny rule taken out of the project settings is named", () => {
  for (const rule of settings().permissions.deny)
    assert.deepEqual(
      withSettings((s) => {
        s.permissions.deny = s.permissions.deny.filter((r) => r !== rule);
      }),
      [`permissions.deny lacks ${rule}`],
    );
});

test("anything added to the project settings is named: a key, an allow rule, another deny rule, a repeated one", () => {
  assert.deepEqual(
    withSettings((s) => {
      s.hooks = {};
    }),
    ["the only key must be permissions (found permissions, hooks)"],
  );
  assert.deepEqual(
    withSettings((s) => {
      s.permissions.allow = ["Bash(gh *)"];
    }),
    ["the only key of permissions must be deny (found deny, allow)"],
  );
  assert.deepEqual(
    withSettings((s) => {
      s.permissions.deny.push("Bash(rm *)");
    }),
    ["permissions.deny holds a rule this check does not know: Bash(rm *)"],
  );
  assert.deepEqual(
    withSettings((s) => {
      s.permissions.deny.push("Bash(gh co *)");
    }),
    ["permissions.deny repeats a rule"],
  );
});

test("project settings that are not an object with a deny list are refused", () => {
  assert.deepEqual(settingsProblems(""), ["not JSON"]);
  assert.deepEqual(settingsProblems("[]"), ["not an object"]);
  assert.deepEqual(settingsProblems('{"permissions":[]}'), ["permissions is not an object"]);
  assert.deepEqual(settingsProblems('{"permissions":{"deny":"Bash(gh co *)"}}'), [
    "permissions.deny is not a list",
  ]);
});

const reader = () => tracked(".claude/agents/fork-reader.md");
/** The reader's definition with one frontmatter line swapped, or a line put after it */
const withReader = (line: string, change: (found: string) => string) => {
  const lines = reader().split("\n");
  const at = lines.findIndex((l) => l.startsWith(line));
  assert.notEqual(at, -1, `the reader has no line starting with ${line}`);
  lines.splice(at, 1, ...change(lines[at] ?? "").split("\n"));
  return readerProblems(lines.join("\n"));
};

test("the reader of a fork's text holds the three read tools and no key that adds another", () => {
  assert.deepEqual(readerProblems(reader()), []);
  assert.match(reader(), /^tools: Read, Grep, Glob$/m);
  // The order is the host's to read; the set is what counts
  assert.deepEqual(
    withReader("tools:", () => "tools: Glob, Read,Grep"),
    [],
  );
});

test("a tool added to the reader, or one taken away, is named", () => {
  assert.deepEqual(
    withReader("tools:", (l) => `${l}, Bash`),
    ["tools must be Read, Grep, Glob and nothing else (found Bash, Glob, Grep, Read)"],
  );
  assert.deepEqual(
    withReader("tools:", () => "tools: Read, Grep"),
    ["tools must be Read, Grep, Glob and nothing else (found Grep, Read)"],
  );
  assert.deepEqual(
    withReader("tools:", () => "tools: *"),
    [
      "the value of tools is not a plain value on its line",
      "tools must be Read, Grep, Glob and nothing else (found *)",
    ],
  );
  assert.deepEqual(
    withReader("tools:", () => "# tools: Read, Grep, Glob"),
    ["tools must be Read, Grep, Glob and nothing else (found none)"],
  );
});

test("a key that gives the reader more than its tools is named, and so is a key written twice", () => {
  for (const key of ["memory", "skills", "mcpServers", "hooks", "permissionMode", "disallowedTools"])
    assert.deepEqual(
      withReader("tools:", (l) => `${l}\n${key}: project`),
      [`the key ${key} is not one the reader may carry`],
    );
  assert.deepEqual(
    withReader("tools:", (l) => `tools: Read, Grep, Glob, Bash\n${l}`),
    ["the key tools is written twice"],
  );
  assert.deepEqual(
    withReader("tools:", (l) => `${l}\ntools: Read, Grep, Glob, Bash`),
    [
      "the key tools is written twice",
      "tools must be Read, Grep, Glob and nothing else (found Bash, Glob, Grep, Read)",
    ],
  );
});

test("a reader whose tools are a list under the key, or that has no frontmatter, is refused", () => {
  assert.deepEqual(
    withReader("tools:", () => "tools:\n  - Read\n  - Bash"),
    [
      "the value of tools is not a plain value on its line",
      "a frontmatter line is not one key and its value: - Read",
      "a frontmatter line is not one key and its value: - Bash",
      "tools must be Read, Grep, Glob and nothing else (found none)",
    ],
  );
  assert.deepEqual(readerProblems("tools: Read, Grep, Glob\n"), ["no closed YAML frontmatter"]);
  // A closing line with no opening one is not frontmatter either
  assert.deepEqual(readerProblems(reader().replace(/^---\n/, "")), ["no closed YAML frontmatter"]);
  assert.deepEqual(
    withReader("tools:", (l) => `${l}\n  memory: project`),
    ["a frontmatter line is not one key and its value: memory: project"],
  );
  assert.deepEqual(readerProblems(reader().replaceAll("\n", "\r\n")), []);
});

/** What check-ai-config.mjs reads, copied so the script itself can be run on a broken tree: its calls are under test, not only the functions */
const READ_BY_CHECK = [
  ".agents",
  ".claude/agents",
  ".claude/rules",
  ".claude/skills",
  ".claude/settings.json",
  ".claude-plugin",
  "AGENTS.md",
  "CLAUDE.md",
  "plugin",
  "scripts",
  "server/package.json",
  "server/src",
];

function aiConfig(change: (root: string) => void): { status: number | null; output: string } {
  const root = tempDir("sphica-ai-config-");
  for (const rel of READ_BY_CHECK)
    fs.cpSync(path.join(REPO, rel), path.join(root, rel), {
      recursive: true,
      verbatimSymlinks: true,
      filter: (src) => !/[\\/](?:node_modules|dist)$/.test(src),
    });
  // The check's English rules load a package from the server's dependencies
  fs.symlinkSync(path.join(REPO, "server", "node_modules"), path.join(root, "server", "node_modules"));
  change(root);
  const run = spawnSync(process.execPath, [path.join(root, "scripts", "check-ai-config.mjs")], {
    encoding: "utf8",
  });
  return { status: run.status, output: run.stdout + run.stderr };
}

test("check-ai-config passes on a copy of the tree, and fails once the project settings are emptied, removed, or widened", () => {
  assert.equal(aiConfig(() => {}).status, 0);
  const file = (root: string) => path.join(root, ".claude", "settings.json");
  const emptied = aiConfig((root) => fs.writeFileSync(file(root), ""));
  assert.equal(emptied.status, 1);
  assert.match(emptied.output, /^\.claude\/settings\.json: not JSON\. Why: .+\. Fix: .+$/m);
  const removed = aiConfig((root) => fs.rmSync(file(root)));
  assert.equal(removed.status, 1);
  assert.match(removed.output, /^\.claude\/settings\.json: the file cannot be read: ENOENT/m);
  assertFindings(removed.output, "check-ai-config");
  const widened = aiConfig((root) =>
    fs.writeFileSync(
      file(root),
      JSON.stringify({ permissions: { deny: settings().permissions.deny, allow: ["Bash"] } }),
    ),
  );
  assert.equal(widened.status, 1);
  assert.match(widened.output, /^\.claude\/settings\.json: the only key of permissions must be deny/m);
});

test("check-ai-config fails once the reader's definition is emptied, removed, or given another tool", () => {
  const file = (root: string) => path.join(root, ".claude", "agents", "fork-reader.md");
  const emptied = aiConfig((root) => fs.writeFileSync(file(root), ""));
  assert.equal(emptied.status, 1);
  assert.match(
    emptied.output,
    /^\.claude\/agents\/fork-reader\.md: no closed YAML frontmatter\. Why: .+\. Fix: .+$/m,
  );
  const removed = aiConfig((root) => fs.rmSync(file(root)));
  assert.equal(removed.status, 1);
  assert.match(removed.output, /^\.claude\/agents\/fork-reader\.md: the file cannot be read: ENOENT/m);
  const armed = aiConfig((root) =>
    fs.writeFileSync(
      file(root),
      reader().replace("tools: Read, Grep, Glob", "tools: Read, Grep, Glob, Bash"),
    ),
  );
  assert.equal(armed.status, 1);
  assert.match(
    armed.output,
    /^\.claude\/agents\/fork-reader\.md: tools must be Read, Grep, Glob and nothing else/m,
  );
});

test("a reader whose frontmatter the host would read differently from this check is refused", () => {
  const early = "the frontmatter holds --- before its closing line, where the host stops reading";
  // The host stops at the first three dashes, so everything below them, the tools included, would be body
  assert.deepEqual(
    withReader("description:", (l) => l.replace("from files,", "from files --- and")),
    [early],
  );
  assert.deepEqual(
    withReader("tools:", (l) => `# --- tools ---\n${l}`),
    [early],
  );
  // The host's YAML starts a new line at a lone carriage return: this one would add a key
  assert.deepEqual(
    withReader("model:", () => "model:\rmemory: project"),
    [
      "the frontmatter holds a control character (U+000D)",
      "a frontmatter line is not one key and its value: model:\rmemory: project",
    ],
  );
  // Values YAML reads differently from a line reader: quoted, holding a second key or a comment, a list, a block, or nothing
  for (const value of [
    '"Reads the text',
    "'opus' # 'x'",
    '"Read, Grep, Glob"',
    "Reads title: body and diff.",
    "Reads the text # of a fork",
    "# Fill this in",
    "[Read, Grep, Glob]",
    ">",
    "|",
    "*anchor",
    "ends with a colon:",
  ])
    assert.ok(
      withReader("description:", () => `description: ${value}`).includes(
        "the value of description is not a plain value on its line",
      ),
      value,
    );
  for (const first of "!&*[]{}|>'\"%@`#,?:-")
    assert.deepEqual(
      withReader("description:", () => `description: ${first}x`),
      ["the value of description is not a plain value on its line"],
      first,
    );
  for (const line of ["description:", "description:Reads the text"])
    assert.deepEqual(
      withReader("description:", () => line),
      ["the value of description is not a plain value on its line"],
      line,
    );
  assert.deepEqual(
    withReader("tools:", () => "tools:Read, Grep, Glob"),
    ["the value of tools is not a plain value on its line"],
  );
  // Characters the host's YAML stops at or breaks a line on, which a line reader passes over
  for (const [ch, code] of [
    ["\0", "0000"],
    ["\t", "0009"],
    ["\u0085", "0085"],
    ["\u2028", "2028"],
    ["\u2029", "2029"],
    ["\ufeff", "FEFF"],
    ["\u00ad", "00AD"],
    ["\u200b", "200B"],
    ["\u001b", "001B"],
    ["\u007f", "007F"],
  ])
    assert.ok(
      withReader("description:", (l) => l.replace("Reads the text", `Reads${ch} the text`)).includes(
        `the frontmatter holds a control character (U+${code})`,
      ),
      code,
    );
});

const skill = () => tracked(".claude/skills/fork-pr/SKILL.md");

const STEP3 =
  skill()
    .split("\n")
    .find((l) => l.startsWith("3. **Have the reader read it.**")) ?? "";
const APPROVAL = "6. **The owner approves taking it in.**";
const STEP3_DIFFERS = "step 3 is not word for word the one this check knows";

test("the fork-pr Skill hands the fork's text to the reader in step 3, word for word", () => {
  assert.ok(STEP3);
  assert.deepEqual(readerStepProblems(skill()), []);
  assert.deepEqual(readerStepProblems(skill().replaceAll("\n", "\r\n")), []);
  // A changed step 3 is no longer left out of the launcher search, so the second problem may follow
  const differs = (source: string, message?: string) =>
    assert.equal(readerStepProblems(source)[0], STEP3_DIFFERS, message);
  differs(skill().replace("Start the `fork-reader` agent by its name", "Read the files"));
  // A copy of the sentence elsewhere, negated, does not stand in for step 3
  differs(
    skill().replace(STEP3, "3. Read the files yourself.") +
      "\n- Do not Start the `fork-reader` agent by its name\n",
  );
  // Nor does a step 3 that starts the reader only sometimes, inside the first sentence or after it
  for (const [from, to] of [
    ["by its name and give it", "by its name only when the diff is long, and give it"],
    ["nothing else. ", "nothing else. When the diff is short, skip the reader and Read the files yourself. "],
  ] as const)
    differs(skill().replace(STEP3, STEP3.replace(from, to)), to);
  assert.deepEqual(readerStepProblems(skill().replace("## Steps\n", "## Steps \n")), [
    "must hold the heading ## Steps once",
  ]);
});

test("the fork-pr Skill starts no other reader of the fork's text before the owner approves it", () => {
  const added = (line: string) => skill().replace("4. **", `${line}\n4. **`);
  for (const line of [
    "   Also run `codex exec - < <dir>/pr-<N>.diff` with the owner's config.",
    "   Then have Codex read `body.md`.",
    "   Or start `claude -p` on the directory.",
    "   Or `claude --agent other` on the directory.",
    "   Or run `claude --print` on the directory.",
    "   Or run `claude --model opus -p` on the directory.",
    '   Or run `claude "review <dir>"`.',
    "   Or run `gemini -p` on the directory.",
    "   Then run `/sphica:review <N>` on the fork's pull request.",
    "   Also start a general-purpose subagent on `<dir>`.",
    "   Or hand `<dir>` to the Agent tool with another type.",
    "   Or hand `<dir>` to an Explore agent through the Task tool.",
    "   Also run `/usr/local/bin/codex exec - < <dir>/pr-<N>.diff`.",
    "   Or run `./node_modules/.bin/claude -p` on the directory.",
    "   Or run `npx @openai/codex exec - < <dir>/pr-<N>.diff`.",
    "   Or run `bunx @anthropic-ai/claude-code -p` on the directory.",
    "3. Also run `codex exec - < <dir>/pr-<N>.diff`.",
  ])
    assert.deepEqual(
      readerStepProblems(added(line)),
      [`starts another reader before the owner approves: ${line.trim()}`],
      line,
    );
  // A heading moved up does not end the steps early, and the approval line itself still runs before the approval
  const moved = added("## Measured behavior\n   Run `codex exec - < <dir>/pr-<N>.diff`.");
  assert.deepEqual(readerStepProblems(moved), [
    "starts another reader before the owner approves: Run `codex exec - < <dir>/pr-<N>.diff`.",
  ]);
  const onApproval = skill().replace(APPROVAL, `${APPROVAL} Before asking, run \`codex exec\` on the diff.`);
  assert.equal(readerStepProblems(onApproval).length, 1);
  assert.deepEqual(readerStepProblems(skill().replace(APPROVAL, "6. **Ask the owner.**")), [
    `must hold the approval step once (found 0): ${APPROVAL}`,
  ]);
  // After the approval the Skill may name GitHub's Codex review, which reads the approved tree
  assert.ok(skill().slice(skill().indexOf(APPROVAL)).includes("GitHub's Codex"));
});

test("check-ai-config fails once the Skill is emptied", () => {
  const file = (root: string) => path.join(root, ".claude", "skills", "fork-pr", "SKILL.md");
  const emptied = aiConfig((root) => fs.writeFileSync(file(root), ""));
  assert.equal(emptied.status, 1);
  assert.match(emptied.output, /fork-pr\/SKILL\.md: must hold the heading ## Steps once/);
});
