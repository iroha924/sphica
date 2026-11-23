// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// GitHub links an issue to a pull request from a closing keyword before its number anywhere in the body, without reading the sentence,
// and the release run closes every linked issue. So the check takes the issues GitHub actually linked (closingIssuesReferences) and
// fails on any the body does not declare on a line of its own: GitHub's parser decides, not a copy of it.

const KEYWORD = String.raw`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)`;
const ITEM = String.raw`(${KEYWORD}|refs?):?[ \t]+#(\d+)[.,;]?`;
/** A line made only of reference items: a closing keyword or Refs, then a number, repeated */
const REFERENCES = new RegExp(String.raw`^(?:${ITEM}[ \t]*)+$`, "i");
const CLOSING_ITEM = new RegExp(String.raw`^${KEYWORD}$`, "i");

/**
 * Issue numbers the body declares as closed: closing items on lines made only of references. A keyword inside a sentence declares
 * nothing, so the issue it links counts as undeclared.
 * @param {string} body
 * @returns {number[]}
 */
export function declaredClosing(body) {
  const text = body.replace(/\r\n?/g, "\n").replace(/<!--(?:-?>|[\s\S]*?-->)/g, "");
  const declared = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!REFERENCES.test(line)) continue;
    for (const m of line.matchAll(new RegExp(ITEM, "gi")))
      if (CLOSING_ITEM.test(m[1] ?? "")) declared.push(Number(m[2]));
  }
  return declared;
}

/**
 * Linked issues the body does not declare on a line of its own: the release run would close each one.
 * @param {string} body
 * @param {readonly number[]} linked
 * @returns {number[]}
 */
export function undeclaredClosing(body, linked) {
  const declared = new Set(declaredClosing(body));
  return [...new Set(linked)].filter((n) => !declared.has(n)).sort((a, b) => a - b);
}
