// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Checks commit messages: one Conventional Commits line in English.
// The commit-msg hook sees the message before Git strips comments, so in hook mode an editor template (a blank line
// followed only by comment lines) and the `git commit -v` diff are ignored. Stored messages (CI) are checked as they are.

import { JAPANESE } from "./japanese.mjs";

const TYPES = "feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert";
const CONVENTIONAL = new RegExp(`^(?:${TYPES})(?:\\([a-z0-9-]+\\))?!?: \\S`);
const MAX = 100;
const MERGE = /^Merge (?:branches|branch|remote-tracking branch|tag|commit|pull request) \S/;
/** The whole message `git revert` writes, including the merge form (`git revert -m`). */
const REVERT =
  /^Revert ".+"\n\nThis reverts commit [0-9a-f]{40}(?:\.|, reversing\nchanges made to [0-9a-f]{40}\.)$/;
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Problems in a message, empty when fine. `hook`: the hook input before Git's cleanup; `merge`: MERGE_HEAD or 2+ parents. */
export function commitMessageProblems(text, opts = {}) {
  let kept = text.replace(/\r\n/g, "\n");
  // Git's commit.cleanup: verbatim and whitespace keep comments and the scissors section, scissors keeps comments.
  const cleanup = opts.cleanup ?? "default";
  const cutScissors = opts.hook && cleanup !== "verbatim" && cleanup !== "whitespace";
  const stripComments = cutScissors && cleanup !== "scissors";
  if (cutScissors) {
    const c = escapeRegExp(opts.commentChar ?? "#");
    // `git commit -v` appends the diff below this line; Git drops it and everything after it.
    const cut = kept.search(new RegExp(`^${c} -+ >8 -+$`, "m"));
    if (cut !== -1) kept = kept.slice(0, cut);
  }
  let lines = kept.replace(/\n+$/, "").split("\n");
  const blank = lines.indexOf("");
  const comment = opts.commentChar ?? "#";
  if (stripComments && blank > 0 && lines.slice(blank + 1).every((l) => l === "" || l.startsWith(comment)))
    lines = lines.slice(0, blank);
  const [subject = "", ...rest] = lines;
  const problems = [];
  if (JAPANESE.test(lines.join("\n"))) problems.push("write the message in English");
  if ((opts.merge && MERGE.test(subject)) || REVERT.test(lines.join("\n"))) return problems;
  if (rest.some((l) => l !== "")) problems.push("use a one-line subject with no body");
  if (!CONVENTIONAL.test(subject))
    problems.push(`start with <type>(<scope>)?: where type is one of ${TYPES.replaceAll("|", ", ")}`);
  if (subject.length > MAX)
    problems.push(`keep the subject within ${MAX} characters (it has ${subject.length})`);
  return problems;
}
