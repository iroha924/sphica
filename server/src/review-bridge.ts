// The bridge into the user's own review commands (Claude Code, a prototype): which hook calls are a review, and the local change to check.
// A typed /name reaches UserPromptExpansion; a skill the model calls reaches PreToolUse on Skill, which typing /name bypasses.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { HookInput } from "./capture.ts";
import { type FileDiff, parseDiff } from "./review.ts";
import { sha256 } from "./text.ts";

export type ReviewInput = HookInput & {
  expansion_type?: string;
  command_name?: string;
  command_args?: string;
};

const NAME = /^[\w.:/-]{1,100}$/;
const MAX_DIFF = 4 * 1024 * 1024;
const MAX_FILES = 500;
const MAX_UNTRACKED_BYTES = 256 * 1024;

/** The review command this hook call starts, or null. Sphica's own review is left out: it already checks the change itself. */
export function reviewCall(input: ReviewInput): { name: string; args: string } | null {
  let name: unknown;
  let args: unknown;
  if (input.hook_event_name === "UserPromptExpansion" && input.expansion_type === "slash_command") {
    name = input.command_name;
    args = input.command_args;
  } else if (input.hook_event_name === "PreToolUse" && input.tool_name === "Skill") {
    // Not in the hook reference; observed in transcripts as { skill, args }. Any other shape is not read
    name = input.tool_input?.skill;
    args = input.tool_input?.args;
  }
  if (typeof name !== "string" || !NAME.test(name)) return null;
  const lower = name.toLowerCase();
  if (lower === "sphica:review") return null;
  const names = (list: string | undefined) =>
    (list ?? "")
      .split(",")
      .map((n) => n.trim().toLowerCase())
      .filter((n) => NAME.test(n));
  // The plugin's review_commands setting (Claude Code exports only a saved value); without a valid command name in it, the environment variable
  const option = names(process.env.CLAUDE_PLUGIN_OPTION_REVIEW_COMMANDS);
  const named = option.length > 0 ? option : names(process.env.SPHICA_REVIEW_COMMANDS);
  if (!named.includes(lower) && !lower.includes("review")) return null;
  return { name, args: typeof args === "string" ? args.slice(0, 1000) : "" };
}

/** A local change, with a digest of what was read so a review of the same change is told once */
export type Change = { base: string; files: FileDiff[]; digest: string } | { problem: string };

// Pinned against user settings that change what diff prints: path quoting, prefixes (diff.mnemonicPrefix, diff.dstPrefix), and textconv
const git = (root: string, args: string[], maxBuffer = 1024 * 1024) =>
  execFileSync("git", ["-C", root, "-c", "core.quotePath=false", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer,
  });

/**
 * The local change a review covers: the working tree against the merge base with the default branch (origin/HEAD, else the upstream),
 * plus untracked files. When the base or the whole change cannot be read, says why instead of checking a smaller range.
 */
export function localChange(root: string, args: string): Change {
  if (/^\s*#?\d+\s*$|(^|\s)#\d+\b|\/pull\/\d+/.test(args))
    return { problem: "it names a pull request, and Sphica sees only the local change" };
  let base = "";
  for (const ref of [
    ["--abbrev-ref", "origin/HEAD"],
    ["--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
  ]) {
    try {
      base = git(root, ["rev-parse", ...ref]).trim();
      if (base) break;
    } catch {
      // try the next
    }
  }
  if (!base) return { problem: "there is no default branch (origin/HEAD) or upstream to compare with" };
  let from: string;
  try {
    from = git(root, ["merge-base", "HEAD", base]).trim();
  } catch {
    return { problem: `HEAD shares no history with ${base}` };
  }
  let diff: string;
  let names: string[];
  let untracked: string[];
  try {
    const plain = [
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
    ];
    diff = git(root, ["diff", ...plain, from], MAX_DIFF);
    // Every changed path, including binary and empty files that print no ---/+++ lines
    names = git(root, ["diff", "--name-only", "-z", "--no-renames", from], MAX_DIFF)
      .split("\0")
      .filter(Boolean);
    untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"], MAX_DIFF)
      .split("\0")
      .filter(Boolean);
  } catch {
    return { problem: "the change is too large to read (over 4 MB of diff or file names)" };
  }
  const files = parseDiff(diff);
  for (const name of names)
    if (!files.some((f) => f.path === name)) files.push({ path: name, added: [], lines: [] });
  if (files.length + untracked.length > MAX_FILES)
    return { problem: `the change has more than ${MAX_FILES} files` };
  const read = [from, diff];
  for (const rel of untracked) {
    let text = "";
    try {
      // Only a regular file is read: a symlink is added as a link (not its target), and a FIFO would block the hook
      const file = path.join(root, rel);
      const st = fs.lstatSync(file);
      if (st.isFile() && st.size <= MAX_UNTRACKED_BYTES) text = fs.readFileSync(file, "utf8");
    } catch {
      // unreadable: the path still counts
    }
    const added = text ? text.split(/\r?\n/) : [];
    files.push({ path: rel, added, lines: added.map((_, i) => i + 1) });
    read.push(rel, text);
  }
  return { base, files, digest: sha256(read.join("\0")).toString("hex") };
}
