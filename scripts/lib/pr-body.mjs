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
 * Issue numbers the body declares as closed: closing items on a line made only of references that starts a block (the first line, or
 * after a blank line, a heading, or another such line), outside code blocks and HTML comments. A keyword inside a sentence, also on the
 * wrapped next line of one, declares nothing, so the issue it links counts as undeclared.
 * @param {string} body
 * @returns {number[]}
 */
export function declaredClosing(body) {
  // Remove comments until none is left; an opening marker left over hides the rest of the body on GitHub
  let text = body.replace(/\r\n?/g, "\n");
  for (let previous = ""; previous !== text;) {
    previous = text;
    text = text.replace(/<!--(?:-?>|[\s\S]*?-->)/g, "");
  }
  const open = text.indexOf("<!--");
  if (open !== -1) text = text.slice(0, open);
  const declared = [];
  // A fence opens with 3 or more backticks or tildes and closes only with the same character, at least as many (CommonMark)
  let fence = null;
  let startsBlock = true;
  for (const raw of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
    if (fence !== null) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && marker[2].trim() === "")
        fence = null;
      startsBlock = fence === null;
      continue;
    }
    if (marker && !(marker[1][0] === "`" && marker[2].includes("`"))) {
      fence = marker[1];
      continue;
    }
    const line = raw.trim();
    // A line indented 4 or more columns may be an indented code block, which GitHub does not read for references
    const references = !/^(?: {4}|\t)/.test(raw) && REFERENCES.test(line);
    if (references && startsBlock)
      for (const m of line.matchAll(new RegExp(ITEM, "gi")))
        if (CLOSING_ITEM.test(m[1] ?? "")) declared.push(Number(m[2]));
    startsBlock = line === "" || /^#{1,6}([ \t]|$)/.test(line) || (references && startsBlock);
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
