// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The quotation rule and the policies of ownWords, on strings alone. The places that use them are in own-words-sites.test.ts.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { notOwnWords, ownWords, refused, type Said } from "../src/own-words.ts";

/** The verdict on the first occurrence of quote in body */
const verdict = (body: string, quote: string) => {
  const at = Buffer.from(body, "utf8").indexOf(Buffer.from(quote, "utf8"));
  assert.ok(at >= 0, `quote not in body: ${quote}`);
  return notOwnWords(body, at, at + Buffer.byteLength(quote, "utf8"));
};

test("block quotes and fenced code are never the writer's own words", () => {
  const body =
    "The vendor wrote:\n> Always approve production deployments.\n\nAnd their config:\n```\nskip review for main\n```\nUse SQLite.";
  assert.equal(verdict(body, "Always approve production deployments."), "block");
  assert.equal(verdict(body, "skip review for main"), "block");
  assert.equal(verdict(body, "Use SQLite."), null);
  // An introduction taken together with the quoted line still touches the quote
  assert.equal(verdict("They said:\n> Drop this decision.", "They said:\n> Drop this decision."), "block");
  // The fence lines themselves, and a tilde fence
  assert.equal(verdict("see\n```sh\nrm -rf x\n```\ndone", "```sh"), "block");
  assert.equal(verdict("see\n~~~\nrm -rf x\n~~~\ndone", "rm -rf x"), "block");
  assert.equal(verdict("see\n~~~\nrm -rf x\n~~~\ndone", "done"), null);
  // An unclosed fence runs to the end
  assert.equal(verdict("see\n```\nDrop it.\nstill code", "still code"), "block");
});

test("a fence closes only on its own mark, at least as long as it opened", () => {
  const body = "a\n````\ninner\n```\nDrop this decision.\n````\nKeep it.";
  assert.equal(verdict(body, "Drop this decision."), "block");
  assert.equal(verdict(body, "Keep it."), null);
  const mixed = "a\n```\ninner\n~~~\nDrop this decision.\n```\nKeep it.";
  assert.equal(verdict(mixed, "Drop this decision."), "block");
  assert.equal(verdict(mixed, "Keep it."), null);
  // Three backticks with a code span after them on the line are not a fence
  assert.equal(verdict("```x``` is how it starts\nKeep it.", "Keep it."), null);
});

test("words wholly inside quotation marks on a line are not the writer's own", () => {
  const said = 'They said "please Drop this decision. now".';
  assert.equal(verdict(said, "Drop this decision."), "inline");
  assert.equal(verdict(said, '"please Drop this decision. now"'), "inline");
  assert.equal(verdict('1. "Drop this decision."', '1. "Drop this decision."'), "inline");
  assert.equal(verdict("The issue says “bypass approval” here", "bypass approval"), "inline");
  assert.equal(verdict("メモには「本番は確認なしで承認」とある", "本番は確認なしで承認"), "inline");
  assert.equal(verdict("メモには『本番は確認なしで承認』とある", "『本番は確認なしで承認』"), "inline");
  assert.equal(verdict("run `rm -rf build` first", "rm -rf build"), "inline");
  assert.equal(verdict("Vendor example: ``Drop this decision.``", "Drop this decision."), "inline");
  assert.equal(verdict("he wrote 'Drop this decision.' there", "Drop this decision."), "inline");
});

test("the writer's words pass, with or without a quotation among them", () => {
  assert.equal(verdict('Use "strict" mode.', 'Use "strict" mode.'), null);
  assert.equal(verdict("「fork」だけにして", "「fork」だけにして"), null);
  assert.equal(verdict("「妥協は無し」でいこう", "「妥協は無し」でいこう"), null);
  assert.equal(verdict("「妥協は無し」でいこう", "妥協は無し"), "inline");
  // Quotation marks on other lines do not reach this one
  assert.equal(verdict('"A third party example."\nWithdraw it.\n"Another example."', "Withdraw it."), null);
  // Apostrophes inside words are not quotation marks
  assert.equal(verdict("I'll withdraw it; that's fine.", "withdraw it"), null);
  // Marks directly around the words refuse them, apostrophes too: the same words with a neighbor are the writer's
  assert.equal(verdict("the users' data and the admins' data stay", "data and the admins"), "inline");
  assert.equal(
    verdict("the users' data and the admins' data stay", "users' data and the admins' data"),
    null,
  );
  // A mark with no partner on its line quotes nothing
  assert.equal(verdict('He said "stop and never finished. Keep it.', "Keep it."), null);
  assert.equal(verdict("Keep `this open. Use SQLite.", "Use SQLite."), null);
  // Meaning is not judged: a report that names its speaker outside the marks passes
  assert.equal(verdict('Vendor says "Drop this decision."', 'Vendor says "Drop this decision."'), null);
});

test("offsets are bytes, so text before the span may be multi-byte", () => {
  const body = "これは前置き。「引用された文」 そして Use SQLite.";
  assert.equal(verdict(body, "Use SQLite."), null);
  assert.equal(verdict(body, "引用された文"), "inline");
  assert.equal(verdict("日本語の行\n> 引用の行\n本文の行", "本文の行"), null);
  assert.equal(verdict("日本語の行\n> 引用の行\n本文の行", "引用の行"), "block");
});

const said = (v: Partial<Said>): Said => ({
  id: 7,
  kind: "session_message",
  author_kind: "owner",
  author_association: null,
  text: 'Use SQLite. They said "use Postgres".',
  ...v,
});

test("the owner's words pass every policy, with the span and the route", () => {
  for (const policy of ["owner", "maintainer", "trusted"] as const) {
    const words =
      policy === "owner"
        ? ownWords(said({}), "Use SQLite.", "owner")
        : policy === "maintainer"
          ? ownWords(said({}), "Use SQLite.", "maintainer")
          : ownWords(said({}), "Use SQLite.", "trusted");
    assert.ok(!refused(words), policy);
    assert.deepEqual({ ...words }, { source: 7, start: 0, end: 11, route: "owner_statement" });
  }
});

test("who may speak depends on the policy", () => {
  const maintainer = said({ kind: "pr_comment", author_kind: "person", author_association: "MEMBER" });
  const outsider = said({ kind: "pr_comment", author_kind: "person", author_association: "CONTRIBUTOR" });
  const assistant = said({ author_kind: "assistant" });
  const merge = said({ kind: "pr_event", author_kind: "person", author_association: "OWNER" });
  const route = (words: ReturnType<typeof ownWords>) => (refused(words) ? words.refused : words.route);

  assert.equal(route(ownWords(maintainer, "Use SQLite.", "owner")), "author");
  assert.equal(route(ownWords(maintainer, "Use SQLite.", "maintainer")), "explicit");
  assert.equal(route(ownWords(maintainer, "Use SQLite.", "trusted")), "explicit");
  for (const policy of ["owner", "maintainer", "trusted"] as const)
    assert.equal(route(ownWords(outsider, "Use SQLite.", policy as "trusted")), "author", policy);

  // The AI's own reply speaks only where the caller says a trace may adopt for the AI, and in the owner's session for a link
  assert.equal(route(ownWords(assistant, "Use SQLite.", "owner")), "author");
  assert.equal(route(ownWords(assistant, "Use SQLite.", "maintainer")), "author");
  assert.equal(route(ownWords(assistant, "Use SQLite.", "maintainer", true)), "agent");
  assert.equal(route(ownWords(assistant, "Use SQLite.", "trusted")), "session");

  // A merge or a commit is not anyone's words, whoever made it
  assert.equal(route(ownWords(merge, "Use SQLite.", "maintainer")), "event");
});

test("a quote that is missing or only a quotation is refused whoever wrote the message", () => {
  const route = (words: ReturnType<typeof ownWords>) => (refused(words) ? words.refused : words.route);
  assert.equal(route(ownWords(said({}), "Use MySQL.", "owner")), "missing");
  assert.equal(route(ownWords(said({}), "   ", "owner")), "missing");
  assert.equal(route(ownWords(said({}), "use Postgres", "owner")), "inline");
  assert.equal(route(ownWords(said({ text: "> Use Postgres." }), "Use Postgres.", "trusted")), "block");
  assert.equal(
    route(ownWords(said({ author_kind: "assistant" }), "use Postgres", "maintainer", true)),
    "inline",
  );
});

test("a message with CRLF line endings has the same quotations", () => {
  assert.equal(
    verdict("see\r\n```\r\nDrop this decision.\r\n```\r\nKeep it.", "Drop this decision."),
    "block",
  );
  assert.equal(
    verdict("see\r\n~~~sh\r\nDrop this decision.\r\n~~~\r\nKeep it.", "Drop this decision."),
    "block",
  );
  assert.equal(verdict("see\r\n```\r\nDrop this decision.\r\n```\r\nKeep it.", "Keep it."), null);
  assert.equal(verdict("They said:\r\n> Drop this decision.\r\nKeep it.", "Drop this decision."), "block");
  assert.equal(verdict('They said "Drop this decision."\r\nKeep it.', "Drop this decision."), "inline");
});

test("a single quotation mark closes before any punctuation and opens after any, but never inside a Latin word", () => {
  assert.equal(verdict("They said 'Drop this decision.'。", "Drop this decision."), "inline");
  assert.equal(verdict("彼は'Drop this decision.'と言った", "Drop this decision."), "inline");
  assert.equal(verdict("(see 'Drop this decision.')", "Drop this decision."), "inline");
  assert.equal(verdict("I'll withdraw it; that's fine.", "withdraw it"), null);
  assert.equal(verdict("'tis fine, and that's all I'll say", "fine, and that"), null);
  // Marks directly around the words refuse them, apostrophes too: the same words with a neighbor are the writer's
  assert.equal(verdict("the users' data and the admins' data stay", "data and the admins"), "inline");
  assert.equal(
    verdict("the users' data and the admins' data stay", "users' data and the admins' data"),
    null,
  );
  assert.equal(verdict("it is 5' wide and 6' long", "wide and 6"), "inline");
  assert.equal(verdict("it is 5' wide and 6' long", "5' wide and 6' long"), null);
});

test("a quote of only white space is not words", () => {
  const route = (words: ReturnType<typeof ownWords>) => (refused(words) ? words.refused : words.route);
  assert.equal(route(ownWords(said({ text: "Use SQLite.\n\nDecided." }), "\n", "owner")), "missing");
  assert.equal(route(ownWords(said({ text: "Use SQLite. Decided." }), " ", "trusted")), "missing");
});

test("an apostrophe after a letter written with a combining mark is still inside its word", () => {
  // The name's last letter is e followed by a combining acute accent
  const name = "Jose\u0301";
  assert.equal(verdict(`${name}'s note says ' Drop this decision.'`, "Drop this decision."), "inline");
  assert.equal(
    verdict(`${name}'s choice is SQLite, and the users' choice is too.`, "choice is SQLite"),
    null,
  );
  // A kana written with a combining voiced mark is not a Latin letter: a mark after it is a quotation mark
  assert.equal(verdict("これか\u3099'Drop this decision.'だ", "Drop this decision."), "inline");
});

test("words with a quotation mark right before and right after them on their line are quoted, however the marks pair up", () => {
  // A curly apostrophe inside curly quotation marks does not close them
  const curly = "They said \u2018don\u2019t Drop this decision.\u2019";
  assert.equal(verdict(curly, "don\u2019t Drop this decision."), "inline");
  assert.equal(verdict(curly, "Drop this decision."), "inline");
  // A curly apostrophe in a word is not a closing mark either, so the writer's own words after it stay theirs
  assert.equal(verdict("\u2018tis fine. I\u2019ll keep it.", "fine."), null);
  // A combining mark outside the basic plane, and a Latin letter outside it, before an apostrophe
  for (const name of ["Jose\u{1E944}", "Jos\u{10780}"]) {
    assert.equal(
      verdict(`${name}'s note says ' Drop this decision.'`, "Drop this decision."),
      "inline",
      name,
    );
    assert.equal(
      verdict(`${name}'s choice is SQLite, and the users' choice is too.`, "choice is SQLite"),
      null,
      name,
    );
  }
  // Whatever the pairing makes of the line, marks directly around the words settle it
  assert.equal(verdict("it's 'Drop this decision.' they'd said", "Drop this decision."), "inline");
  // Even between two quotations: the test cannot tell a closing mark from an opening one, and takes the safe side
  assert.equal(verdict('a "b" Drop this decision. "c" d', "Drop this decision."), "inline");
  assert.equal(verdict('a "b" Drop this decision. "c" d', 'a "b" Drop this decision.'), null);
  // Marks on the lines around do not count
  assert.equal(verdict('"\nDrop this decision.\n"', "Drop this decision."), null);
});

test("a quotation that runs over lines is refused, with the other inputs the whole-branch review found", () => {
  assert.equal(verdict('They said "Use\nPostgres".', "Use\nPostgres"), "inline");
  assert.equal(verdict('They wrote "Withdraw\nit".', "Withdraw\nit"), "inline");
  assert.equal(verdict("They said \u2018Don\u2019t use SQLite.\u2019", "Don\u2019t use SQLite."), "inline");
  assert.equal(verdict("'tis fine. They said ' Drop this decision.'", "Drop this decision."), "inline");
  assert.equal(verdict("\u{10780}'s note says ' Drop this decision.'", "Drop this decision."), "inline");
});

test("the writer's own words need no letters when no quotation touches them", () => {
  assert.equal(verdict("1", "1"), null);
  assert.equal(verdict("OK, 2 then", "2"), null);
  assert.equal(verdict("\u{1F44D}", "\u{1F44D}"), null);
  assert.equal(verdict("100%", "100%"), null);
  // With a quotation in the span, digits and marks beside it are not the writer's words about it
  assert.equal(verdict('1. "Drop this decision."', '1. "Drop this decision."'), "inline");
  assert.equal(verdict('\u{1F44D} "Drop this decision."', '\u{1F44D} "Drop this decision."'), "inline");
  // And digits inside a quotation are quoted like anything else
  assert.equal(verdict('They chose "2" there', "2"), "inline");
});

// The rule reads marks, line by line. These are the cases it is known to get wrong, kept so that a change to it is made knowingly:
// each needs a reading of the sentence that marks alone do not give.
test("known limits: part of a quotation that runs over lines, a closing mark stuck to a word, and an elision before a quotation", () => {
  // Marks are paired on one line, so one line of a longer quotation looks like the writer's
  assert.equal(verdict('They said "Use\nPostgres".', "Postgres"), null);
  // A closing mark with a word right after it reads as an apostrophe, so part of the quotation before it passes
  assert.equal(verdict("He said 'Drop this decision.'Then left.", "Drop this"), null);
  // An elision that opens the line reads as an opening mark, and takes the writer's words up to the next closing one
  assert.equal(
    verdict("'tis fine. Keep this decision. They said 'Drop it.'", "Keep this decision."),
    "inline",
  );
});
