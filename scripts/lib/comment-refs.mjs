// Finds comments that point at issues, pull requests, or plan files instead of stating the reason.

import { commentLines } from "./english.mjs";

/** What a comment must not point at. Each is a form of reference, not a word that happens to contain a number. */
const REFERENCES = [
  { re: /\.claude\/plans\//, reason: "a plan path" },
  { re: /\bissues? #?\d+/i, reason: "an issue number" },
  { re: /\b(?:PRs?|pull requests?) #?\d+/i, reason: "a pull request number" },
  { re: /\(#\d+\)/, reason: "an issue or pull request number" },
  { re: /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?) #\d+/i, reason: "a closing reference" },
  { re: /[\w.-]+\/[\w.-]+#\d+/, reason: "an issue or pull request reference" },
  { re: /github\.com\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/\d+/, reason: "an issue or pull request URL" },
];

/**
 * @param {string} source
 * @param {"js" | "sql"} kind SQL is read line by line: only lines that start with `--` count, so a `--` inside a string is not a comment
 * @returns {{ line: number, text: string, reason: string }[]}
 */
export function referenceProblems(source, kind) {
  const lines =
    kind === "js"
      ? commentLines(source)
      : source
          .split(/\r\n|\r|\n/)
          .map((text, i) => ({ line: i + 1, text }))
          .filter((l) => l.text.trimStart().startsWith("--"));
  const problems = [];
  for (const { line, text } of lines) {
    const hit = REFERENCES.find((r) => r.re.test(text));
    if (hit) problems.push({ line, text: text.trim().slice(0, 80), reason: hit.reason });
  }
  return problems;
}
