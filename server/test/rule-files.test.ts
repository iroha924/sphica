// Whether an anchored file is still there apart from its symbol, and which instruction files a stale-marker check reads: git's tracked and
// untracked files it does not ignore, or a bounded walk outside git, with every file it could not read counted.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { checkAnchor, fileState } from "../src/anchors.ts";
import { isRuleFile, RULE_LIMITS, ruleFiles } from "../src/rule-files.ts";

let root: string;
let outside: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-rules-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-outside-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const put = (rel: string, text = "x\n") => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const git = (...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], {
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });

test("a gone file is told apart from a symbol that is gone from a file still there", () => {
  put("src/db.ts", "export function open() {}\n");
  assert.equal(fileState(root, "src/db.ts"), "present");
  assert.equal(fileState(root, "src/gone.ts"), "gone");
  assert.equal(fileState(root, "nowhere/gone.ts"), "gone");
  // checkAnchor says missing for both; only fileState separates them
  assert.equal(checkAnchor(root, { path: "src/db.ts", symbol: "close", line_start: null }).state, "missing");
  assert.equal(fileState(null, "src/db.ts"), "unknown");
  assert.equal(fileState(root, "../x.ts"), "unknown");
  // A symlinked directory leading outside the repository is not checked, even when the file behind it is gone
  fs.symlinkSync(outside, path.join(root, "link"));
  assert.equal(fileState(root, "link/gone.ts"), "unknown");
  fs.symlinkSync(path.join(root, "src"), path.join(root, "inside"));
  assert.equal(fileState(root, "inside/db.ts"), "present");
  assert.equal(fileState(root, "inside/gone.ts"), "gone");
  fs.symlinkSync(path.join(root, "missing-target"), path.join(root, "dangling"));
  assert.equal(fileState(root, "dangling/a.ts"), "unknown");
});

test("the instruction files are CLAUDE.md, AGENTS.md, AGENTS.override.md at any depth and markdown under .claude/rules", () => {
  for (const yes of [
    "CLAUDE.md",
    "a/b/AGENTS.md",
    "AGENTS.override.md",
    ".claude/rules/x.md",
    "pkg/.claude/rules/a/b.md",
  ])
    assert.equal(isRuleFile(yes), true, yes);
  for (const no of [
    "README.md",
    "claude.md",
    ".claude/rules.md",
    ".claude/rules/x.txt",
    ".claude/CLAUDE.local.md.bak",
  ])
    assert.equal(isRuleFile(no), false, no);
});

test("in git, tracked and untracked files are read and ignored ones are not", () => {
  git("init", "-q");
  put(".gitignore", "ignored/\n");
  put("CLAUDE.md", "tracked\n");
  git("add", "-A");
  git("commit", "-qm", "c");
  put("AGENTS.md", "untracked, not yet committed\n");
  put(".claude/rules/new.md", "rule\n");
  put("ignored/CLAUDE.md", "ignored\n");
  put("docs/README.md", "not an instruction file\n");
  const r = ruleFiles(root);
  assert.deepEqual(
    r.files.map((f) => [f.path, f.text]),
    [
      [".claude/rules/new.md", "rule\n"],
      ["AGENTS.md", "untracked, not yet committed\n"],
      ["CLAUDE.md", "tracked\n"],
    ],
  );
  assert.deepEqual([r.skipped, r.incomplete], [0, null]);
  // A tracked file deleted in the working tree is simply not there
  fs.rmSync(path.join(root, "CLAUDE.md"));
  assert.deepEqual(
    ruleFiles(root).files.map((f) => f.path),
    [".claude/rules/new.md", "AGENTS.md"],
  );
});

test("files it cannot read are counted: too large, binary, a symlink, or leading outside the repository", () => {
  git("init", "-q");
  put("CLAUDE.md", "ok\n");
  put("big/CLAUDE.md", "x".repeat(RULE_LIMITS.bytes + 1));
  put("bin/AGENTS.md", "a\0b");
  fs.writeFileSync(path.join(outside, "AGENTS.md"), "outside\n");
  fs.symlinkSync(path.join(outside, "AGENTS.md"), path.join(root, "AGENTS.md"));
  fs.symlinkSync(outside, path.join(root, "out"));
  const r = ruleFiles(root);
  assert.deepEqual(
    r.files.map((f) => f.path),
    ["CLAUDE.md"],
  );
  assert.equal(r.skipped, 3);
});

test("past the file cap, the rest are counted, never silently dropped", () => {
  for (let i = 0; i <= RULE_LIMITS.files; i++) put(`d${String(i).padStart(3, "0")}/CLAUDE.md`);
  const r = ruleFiles(root);
  assert.equal(r.files.length, RULE_LIMITS.files);
  assert.equal(r.skipped, 1);
});

test("outside git, a walk skips node_modules and dot-directories but .claude, never follows a symlink, and says where it stopped", () => {
  put("CLAUDE.md");
  put(".claude/rules/a.md");
  put("node_modules/pkg/CLAUDE.md");
  put(".hidden/AGENTS.md");
  put("a/b/AGENTS.md");
  fs.writeFileSync(path.join(outside, "CLAUDE.md"), "outside\n");
  fs.symlinkSync(outside, path.join(root, "linked"));
  const r = ruleFiles(root);
  assert.deepEqual(
    r.files.map((f) => f.path),
    [".claude/rules/a.md", "CLAUDE.md", "a/b/AGENTS.md"],
  );
  assert.equal(r.incomplete, null);
  put(`${Array.from({ length: RULE_LIMITS.depth + 1 }, (_, i) => `l${i}`).join("/")}/CLAUDE.md`);
  assert.match(String(ruleFiles(root).incomplete), /did not look deeper than 8 directories/);
});

test("outside git, a walk stops after its entry budget and says so", () => {
  const many = path.join(root, "many");
  fs.mkdirSync(many);
  for (let i = 0; i <= RULE_LIMITS.entries; i++) fs.writeFileSync(path.join(many, `f${i}`), "");
  assert.match(String(ruleFiles(root).incomplete), /stopped after 5000 directory entries/);
});

test("a path through a regular file is gone, not an error", () => {
  put("src/db.ts");
  assert.equal(fileState(root, "src/db.ts/child.ts"), "gone");
});

test("the file cap counts every file looked at, so many unreadable files do not all get read", (t) => {
  for (let i = 0; i <= RULE_LIMITS.files; i++) put(`d${String(i).padStart(3, "0")}/AGENTS.md`, "a\0b");
  const read = t.mock.method(fs, "readFileSync");
  const r = ruleFiles(root);
  assert.deepEqual(
    [r.files.length, r.skipped, read.mock.callCount()],
    [0, RULE_LIMITS.files + 1, RULE_LIMITS.files],
  );
});

test("outside git, an unreadable directory makes the listing incomplete, and a symlink with a rule file's name is counted", () => {
  put("CLAUDE.md");
  fs.writeFileSync(path.join(outside, "AGENTS.md"), "outside\n");
  fs.symlinkSync(path.join(outside, "AGENTS.md"), path.join(root, "AGENTS.md"));
  const r = ruleFiles(root);
  assert.deepEqual([r.files.map((f) => f.path), r.skipped], [["CLAUDE.md"], 1]);
  put("locked/CLAUDE.md");
  fs.chmodSync(path.join(root, "locked"), 0);
  try {
    assert.match(String(ruleFiles(root).incomplete), /could not read 1 directory/);
  } finally {
    fs.chmodSync(path.join(root, "locked"), 0o755);
  }
});

test("a file that cannot be read is unknown to the anchor check, not an error", () => {
  put("secret.ts", "export function open() {}\n");
  fs.chmodSync(path.join(root, "secret.ts"), 0);
  try {
    assert.equal(fileState(root, "secret.ts"), "present");
    assert.equal(checkAnchor(root, { path: "secret.ts", symbol: "open", line_start: null }).state, "unknown");
  } finally {
    fs.chmodSync(path.join(root, "secret.ts"), 0o644);
  }
});

test("outside git, a branch past the depth cap does not stop the walk from reading the directories after it", () => {
  put(`a/${Array.from({ length: RULE_LIMITS.depth }, (_, i) => `l${i}`).join("/")}/CLAUDE.md`);
  put("z/AGENTS.md");
  const r = ruleFiles(root);
  assert.deepEqual(
    r.files.map((f) => f.path),
    ["z/AGENTS.md"],
  );
  assert.match(String(r.incomplete), /did not look deeper than/);
});
