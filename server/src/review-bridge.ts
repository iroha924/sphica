// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The bridge into the user's own review commands (a prototype): which hook calls are a review, and the local change to check.
// Claude Code: a typed /name reaches UserPromptExpansion; a skill the model calls reaches PreToolUse on Skill, which typing /name bypasses.
// Codex has no event for a review or a skill: its built-in review shows as a prompt in a child thread, a skill the user names as $name
// in the prompt, and a skill the model picks as a shell command that names the skill's file.
import fs from "node:fs";
import path from "node:path";
import type { HookInput } from "./capture.ts";
import { type CodexThread, childThread } from "./codex-log.ts";
import { baseRef, listFiles, mergeBase, refusalText, type Unread, unreadOf, worktreeDiff } from "./git.ts";
import { type FileDiff, parseDiff } from "./review.ts";
import { sha256 } from "./text.ts";

export type ReviewInput = HookInput & {
  expansion_type?: string;
  command_name?: string;
  command_args?: string;
};

const NAME = /^[\w.:/-]{1,100}$/;
const MAX_DIFF = 4 * 1024 * 1024;
/** The diff read, its isolated git directory included, ends within this or the review is told the change could not be read */
const DIFF_DEADLINE = 5_000;
const MAX_FILES = 500;
const MAX_UNTRACKED_BYTES = 256 * 1024;

/** The command names a comma-separated setting lists, lowercased; anything that is not a command name is left out */
const names = (list: string | undefined): string[] =>
  (list ?? "")
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter((n) => NAME.test(n));

/** Whether a command or skill of this name is a review of the user's own: one that says so in its name, or one the user listed */
const isReview = (name: string, named: string[]): boolean => {
  const lower = name.toLowerCase();
  return lower !== "sphica:review" && (named.includes(lower) || lower.includes("review"));
};

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
  // The plugin's review_commands setting (Claude Code exports only a saved value); without a valid command name in it, the environment variable
  const option = names(process.env.CLAUDE_PLUGIN_OPTION_REVIEW_COMMANDS);
  const named = option.length > 0 ? option : names(process.env.SPHICA_REVIEW_COMMANDS);
  if (!isReview(name, named)) return null;
  return { name, args: typeof args === "string" ? args.slice(0, 1000) : "" };
}

/** A skill named in a prompt as $name, at the start or after white space, so `a$b` and a price are not one */
const NAMED_SKILL = /(?<!\S)\$([\w.:/-]{1,100})/g;
/** A name written as shells write a variable ($REVIEW_DIR), which no skill is */
const VARIABLE = /^[A-Z0-9_]+$/;
/** A skill's file as a shell command names it, in either slash: the directory under skills/ is the skill's name */
const SKILL_FILE = /skills[\\/]([\w.-]{1,100})[\\/]SKILL\.md(?![\w.-])/g;
/**
 * Commands that only print files. Finding, staging, or counting a skill's file is not reading the skill, and sed is left out because
 * it also edits in place.
 */
const READERS = new Set(["cat", "head", "tail", "nl", "less", "more", "bat", "type", "get-content", "gc"]);
const slashes = (p: string): string => p.replaceAll("\\", "/");
/**
 * What makes a shell line more than one plain command: chaining, piping, redirecting, substituting, or a second line. Such a line is
 * not read at all, since telling what it prints would take a shell's grammar; a review skill read that way gets no delivery.
 */
const NOT_PLAIN = /[;|&<>\n`]|\$\(/;

/** The command a shell line starts with, by its name alone: `/bin/cat` and `cat.exe` are cat */
const starts = (part: string): string =>
  (
    slashes(part.trim().split(/\s+/)[0] ?? "")
      .split("/")
      .pop() ?? ""
  )
    .toLowerCase()
    .replace(/\.exe$/, "");

/**
 * The review a Codex hook call starts, or null. `thread` is what the session log's first line says of the call; `own` holds the paths
 * of Sphica's own review skill, which checks the change itself. Names beyond those holding "review" come from SPHICA_REVIEW_COMMANDS
 * alone: Codex has no plugin setting.
 */
export function codexReviewCall(
  input: ReviewInput,
  thread: CodexThread | null,
  own: string[] = [],
): { name: string; args: string } | null {
  // Reviews inside a subagent are left to the conversation that started it
  if (input.agent_id) return null;
  const named = names(process.env.SPHICA_REVIEW_COMMANDS);
  if (input.hook_event_name === "UserPromptSubmit") {
    // The built-in review's prompt is written by Codex, whatever it says; no other child thread is a review
    if (childThread(input, thread) !== null)
      return thread?.subagent === "review" ? { name: "review", args: "" } : null;
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    for (const m of prompt.matchAll(NAMED_SKILL)) {
      // A name ends a sentence as often as not: `$my-review.` names my-review
      const name = (m[1] ?? "").replace(/[.:/-]+$/, "");
      if (NAME.test(name) && !VARIABLE.test(name) && isReview(name, named))
        return { name, args: prompt.slice(0, 1000) };
    }
    return null;
  }
  if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return null;
  const command = input.tool_input?.command;
  if (typeof command !== "string") return null;
  // One plain command that prints files, as agents read a skill (`cat <path>`, `nl -ba <path>`); anything else is no review
  const line = command.trim();
  if (NOT_PLAIN.test(line) || !READERS.has(starts(line))) return null;
  const mine = own.map(slashes);
  for (const m of line.matchAll(SKILL_FILE)) {
    const upTo = slashes(line.slice(0, m.index + m[0].length));
    if (mine.some((file) => upTo.endsWith(file))) continue;
    if (isReview(m[1] ?? "", named)) return { name: m[1] ?? "", args: "" };
  }
  return null;
}

/** A local change, with a digest of what was read so a review of the same change is told once */
export type Change = { base: string; files: FileDiff[]; digest: string } | { problem: string };

/** Why the local change could not be read, as the review's reply puts it: a slow or large change is not blamed for a refusal or a failure */
function unreadText(why: Unread): string {
  if (why.unread === "refused")
    return `Sphica's git worker would not start, because ${refusalText(why.code)} (run sphica doctor in this work tree)`;
  if (why.unread === "failed") return "the change could not be read (git failed or could not be started)";
  return "the change could not be read in time, or is too large to read (over 4 MB of diff or file names)";
}

/**
 * The local change a review covers: the working tree against the merge base with the default branch (origin/HEAD, else the upstream),
 * plus untracked files. When the base or the whole change cannot be read by `until`, says why instead of checking a smaller range.
 */
export async function localChange(
  root: string,
  args: string,
  until: number = Date.now() + DIFF_DEADLINE,
): Promise<Change> {
  if (/^\s*#?\d+\s*$|(^|\s)#\d+\b|\/pull\/\d+/.test(args))
    return { problem: "it names a pull request, and Sphica sees only the local change" };
  // One deadline for every git the review's change takes, the isolated diff included: `until`, when the hook has less time than that
  const left = () => Math.max(1, until - Date.now());
  let base = "";
  // A git that ran out of time found nothing either way: that is said as time, not as a branch or a history that is missing
  let late = false;
  for (const which of ["origin/HEAD", "upstream"] as const) {
    try {
      base = baseRef(root, which, { timeout: left() });
      if (base) break;
    } catch (e) {
      // try the next
      late ||= unreadOf(e).unread === "timeout";
    }
  }
  if (!base)
    return {
      problem: late
        ? unreadText({ unread: "timeout" })
        : "there is no default branch (origin/HEAD) or upstream to compare with",
    };
  let from: string;
  try {
    from = mergeBase(root, "HEAD", base, { timeout: left() });
  } catch (e) {
    const why = unreadOf(e);
    return { problem: why.unread === "timeout" ? unreadText(why) : `HEAD shares no history with ${base}` };
  }
  // Prefixes and quoting pinned against settings that change what diff prints; names hold every changed path, including binary and
  // empty files that print no ---/+++ lines
  const got = await worktreeDiff(root, from, { max: MAX_DIFF, deadline: left() });
  if ("unread" in got) return { problem: unreadText(got) };
  let untracked: string[];
  try {
    untracked = listFiles(root, "untracked", { max: MAX_DIFF, timeout: left() });
  } catch (e) {
    return { problem: unreadText(unreadOf(e)) };
  }
  const { patch: diff, names } = got;
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
