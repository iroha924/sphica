// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Whose words a quotation is, wherever those words carry authority. Every such place takes an OwnWords, and only ownWords makes one.
// It checks where the words sit (in the message, by a writer who may speak there, not only inside a quotation), never what they mean.
// The quotation rule reads the message's own markup and is an approximation: unmarked pastes, indented code, nesting, and escapes pass.

const MAINTAINERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** As much of a source row as tells whose words it holds. */
export type Said = {
  id: number;
  kind: string;
  author_kind: string;
  author_association: string | null;
  text: string;
};

/**
 * Who may speak with authority at a place: `owner` only the owner; `maintainer` the owner or a maintainer, never an event (a merge or a
 * commit is not anyone's words); `trusted` what a link from harvest or glean may rest on: a message of the owner's session, the owner,
 * or a maintainer.
 */
export type Policy = "owner" | "maintainer" | "trusted";

declare const checked: unique symbol;
/**
 * A byte span of a source that passed ownWords under one policy, with the way its writer came to speak there. Only ownWords makes one.
 */
export type OwnWords<Route extends string = "owner_statement" | "explicit" | "agent" | "session"> = {
  readonly source: number;
  readonly start: number;
  readonly end: number;
  readonly route: Route;
  readonly [checked]: true;
};

/**
 * Why words do not carry authority: `event` the source is an event, `author` its writer may not speak here, `missing` the quote is not
 * in it, `block` the quote touches a block quote or fenced code, `inline` nothing of it is outside quotation marks.
 */
export type NotOwn = { refused: "event" | "author" | "missing" | "block" | "inline" };

export const refused = (words: OwnWords | NotOwn): words is NotOwn => "refused" in words;

/** The byte span of quote in text, or null. The first occurrence is taken, white space and all: what a quote may be is the caller's rule. */
export function locate(body: string, quote: string): [number, number] | null {
  const at = Buffer.from(body, "utf8").indexOf(Buffer.from(quote, "utf8"));
  return at < 0 ? null : [at, at + Buffer.byteLength(quote, "utf8")];
}

/**
 * The quote as the source's writer's own words under the policy, or why it is not. `agent` lets an assistant's session message through
 * the `maintainer` policy: the AI's own decision, which the caller allows only in a trace an interactive session began.
 */
export function ownWords(s: Said, quote: string, policy: "owner"): OwnWords<"owner_statement"> | NotOwn;
export function ownWords(
  s: Said,
  quote: string,
  policy: "maintainer",
  agent?: boolean,
): OwnWords<"owner_statement" | "explicit" | "agent"> | NotOwn;
export function ownWords(s: Said, quote: string, policy: "trusted"): OwnWords | NotOwn;
export function ownWords(s: Said, quote: string, policy: Policy, agent = false): OwnWords | NotOwn {
  if (policy === "maintainer" && s.kind === "pr_event") return { refused: "event" };
  const route =
    s.author_kind === "owner"
      ? "owner_statement"
      : policy !== "owner" && MAINTAINERS.has(s.author_association ?? "")
        ? "explicit"
        : policy === "maintainer" && agent && s.author_kind === "assistant" && s.kind === "session_message"
          ? "agent"
          : policy === "trusted" && s.kind === "session_message"
            ? "session"
            : null;
  if (!route) return { refused: "author" };
  // White space alone is in every message and says nothing
  const at = quote.trim() ? locate(s.text, quote) : null;
  if (!at) return { refused: "missing" };
  const quoted = notOwnWords(s.text, at[0], at[1]);
  if (quoted) return { refused: quoted };
  return { source: s.id, start: at[0], end: at[1], route } as OwnWords;
}

type Range = [number, number];

/** Pairs of marks that open and close a quotation on one line. A straight mark closes itself. */
// english-exempt: Japanese quotation brackets are quotation marks too
const PAIRS: Record<string, string> = { '"': '"', "“": "”", "‘": "’", "「": "」", "『": "』" };

/** A character an apostrophe can sit against inside a word or a measure: `it's`, `users'`, `5'` */
const WORD = /[\p{Script=Latin}\p{N}]/u;

/** The character that starts at index `at`, whole even when it takes two code units, or "" past the end */
const charAt = (line: string, at: number): string =>
  at < line.length ? String.fromCodePoint(line.codePointAt(at) as number) : "";

/** Whether the text before index `end` ends in a Latin word or a number. Combining marks belong to the letter before them, so they are stepped over. */
function endsWord(line: string, end: number): boolean {
  for (let i = end; i > 0; ) {
    const low = line.charCodeAt(i - 1);
    const from = low >= 0xdc00 && low <= 0xdfff && i > 1 ? i - 2 : i - 1;
    const c = charAt(line, from);
    if (!/\p{M}/u.test(c)) return WORD.test(c);
    i = from;
  }
  return false;
}

/** Whether a mark at index `at` has a Latin word or a number right after it: then it is an apostrophe, not the end of a quotation */
const startsWord = (line: string, at: number): boolean => WORD.test(charAt(line, at + 1));

/** The ranges of one line, in characters, that sit inside quotation marks or a code span, marks included. */
function inlineRanges(line: string): Range[] {
  const found: Range[] = [];
  for (let i = 0; i < line.length; ) {
    const c = line[i] as string;
    let close = -1;
    let width = 1;
    if (c === "`") {
      // A run of backticks is one delimiter, closed by the next run of the same length
      while (line[i + width] === "`") width++;
      for (let j = i + width; j < line.length; ) {
        if (line[j] !== "`") {
          j++;
          continue;
        }
        let run = 1;
        while (line[j + run] === "`") run++;
        if (run === width) {
          close = j;
          break;
        }
        j += run;
      }
    } else if (c === "'") {
      // An apostrophe inside a Latin word or after a number is not a quotation mark; beside anything else, in any script, it is one
      if (!endsWord(line, i))
        for (let j = i + 1; j < line.length; j++)
          if (line[j] === "'" && !startsWord(line, j)) {
            close = j;
            break;
          }
    } else if (PAIRS[c]) {
      close = line.indexOf(PAIRS[c], i + 1);
      // The closing single mark is also the typographic apostrophe: inside a word it closes nothing
      while (c === "\u2018" && close >= 0 && startsWord(line, close))
        close = line.indexOf(PAIRS[c], close + 1);
    }
    if (close < 0) {
      i += width;
      continue;
    }
    found.push([i, close + width]);
    i = close + width;
  }
  return found;
}

/** A quotation mark as the character right before a span, and right after one */
// english-exempt: Japanese quotation brackets are quotation marks too
const OPENS = /["“'‘`「『]/;
// english-exempt: Japanese quotation brackets are quotation marks too
const CLOSES = /["”'’`」』]/;

/**
 * Why the byte span [start, end) of a message is not its writer's own words, or null when it is: "block" when it touches a line of a
 * block quote or a fenced code block; "inline" when a quotation mark stands right before it and right after it on its line, or it runs
 * into a quotation and nothing but digits and marks is left of it outside. The first inline test needs no pairing of marks, which an
 * apostrophe can throw off; the second catches part of a quotation. A span that mixes the writer's words with a quotation passes.
 */
export function notOwnWords(body: string, start: number, end: number): "block" | "inline" | null {
  const bytes = Buffer.from(body, "utf8");
  let fence: { mark: string; length: number } | null = null;
  let own = "";
  let quoting = false;
  let before = "";
  let after = "";
  for (let at = 0; at <= bytes.length; ) {
    const nl = bytes.indexOf(0x0a, at);
    const stop = nl < 0 ? bytes.length : nl;
    // A CRLF message keeps its carriage return at the end of each line; it is part of the break, not of the line
    const raw = bytes.subarray(at, stop).toString("utf8").replace(/\r$/, "");
    const line = raw.trimStart();
    let block = fence !== null || line.startsWith(">");
    if (fence) {
      const closing = /^(`+|~+)\s*$/.exec(line)?.[1];
      if (closing && closing[0] === fence.mark && closing.length >= fence.length) fence = null;
    } else {
      const opening = /^(`{3,}|~{3,})(.*)$/.exec(line);
      // A backtick fence cannot have a backtick after it on its line: that is a code span
      if (opening && !(opening[1]?.startsWith("`") && opening[2]?.includes("`"))) {
        fence = { mark: (opening[1] as string)[0] as string, length: (opening[1] as string).length };
        block = true;
      }
    }
    if (at < end && stop > start) {
      if (block) return "block";
      // The part of this line the span covers, in characters, with what sits inside quotation marks taken out
      const from = Buffer.from(raw, "utf8")
        .subarray(0, Math.max(start - at, 0))
        .toString("utf8").length;
      const to = Buffer.from(raw, "utf8")
        .subarray(0, Math.min(end, stop) - at)
        .toString("utf8").length;
      if (start >= at) before = raw.slice(0, from).trimEnd().slice(-1);
      if (end <= stop) after = raw.slice(to).trimStart().slice(0, 1);
      let cursor = from;
      for (const [a, b] of inlineRanges(raw)) {
        if (b <= cursor || a >= to) continue;
        quoting = true;
        own += raw.slice(cursor, Math.max(a, cursor));
        cursor = Math.max(cursor, b);
      }
      own += `${raw.slice(cursor, Math.max(to, cursor))}\n`;
    }
    if (nl < 0) break;
    at = nl + 1;
  }
  if (OPENS.test(before) && CLOSES.test(after)) return "inline";
  // Words no quotation touches are the writer's, a bare number or a symbol included; beside a quotation, only letters count as words
  return !quoting || /\p{L}/u.test(own) ? null : "inline";
}
