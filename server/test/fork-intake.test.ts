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
import { readerProblems, settingsProblems } from "../../scripts/lib/fork-intake.mjs";
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
  // The order and the quoting are the host's to read; the set is what counts
  assert.deepEqual(
    withReader("tools:", () => 'tools: "Glob, Read,Grep"'),
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
    ["tools must be Read, Grep, Glob and nothing else (found *)"],
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
  assert.match(emptied.output, /\.claude\/settings\.json: not JSON/);
  const removed = aiConfig((root) => fs.rmSync(file(root)));
  assert.equal(removed.status, 1);
  assert.match(removed.output, /\.claude\/settings\.json: ENOENT/);
  const widened = aiConfig((root) =>
    fs.writeFileSync(
      file(root),
      JSON.stringify({ permissions: { deny: settings().permissions.deny, allow: ["Bash"] } }),
    ),
  );
  assert.equal(widened.status, 1);
  assert.match(widened.output, /\.claude\/settings\.json: the only key of permissions must be deny/);
});

test("check-ai-config fails once the reader's definition is emptied, removed, or given another tool", () => {
  const file = (root: string) => path.join(root, ".claude", "agents", "fork-reader.md");
  const emptied = aiConfig((root) => fs.writeFileSync(file(root), ""));
  assert.equal(emptied.status, 1);
  assert.match(emptied.output, /fork-reader\.md: no closed YAML frontmatter/);
  const removed = aiConfig((root) => fs.rmSync(file(root)));
  assert.equal(removed.status, 1);
  assert.match(removed.output, /fork-reader\.md: ENOENT/);
  const armed = aiConfig((root) =>
    fs.writeFileSync(
      file(root),
      reader().replace("tools: Read, Grep, Glob", "tools: Read, Grep, Glob, Bash"),
    ),
  );
  assert.equal(armed.status, 1);
  assert.match(armed.output, /fork-reader\.md: tools must be Read, Grep, Glob and nothing else/);
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
    ["the frontmatter holds a carriage return that is not part of a line ending"],
  );
  assert.deepEqual(
    withReader("description:", (l) => l.replace("description: ", 'description: "')),
    ["the value of description opens a quote it does not close on its line"],
  );
  assert.deepEqual(
    withReader("model:", () => "model: 'opus' # 'x'"),
    ["the value of model opens a quote it does not close on its line"],
  );
});
