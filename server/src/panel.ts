// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The shape of what the capture hook shows people (✦ for the title, │ at the start of content lines, ╰─ for the closing line), plus marks and text cleanup shared with the CLI.
// CLI output is drawn with Clack (server/src/cli/view.ts). The hook does not load Clack, so strings are built here.
// MCP results, which only AIs read, use neither shape.

import { stripVTControlCharacters, styleText } from "node:util";
import { visible } from "./text.ts";

/** ok is good, warn needs a look, fail is broken, none is information (missing, unknown, or just waiting). Glyphs are written only in MARKS. */
export type Mark = "ok" | "warn" | "fail" | "none";

// The review Skill ledger writes the same glyphs (a Skill cannot read this file). scripts/check-pairs.mjs compares them.
const MARKS = {
  ok: ["✓", "green"],
  warn: ["△", "yellow"],
  fail: ["✗", "red"],
  none: ["○", "gray"],
} as const;

/**
 * Color only when both stdout and stderr are terminals (if either goes to a file or pipe, neither gets color).
 * When both are terminals, styleText handles NO_COLOR, FORCE_COLOR=0, and TERM=dumb. The named colors match the ones Clack draws.
 */
const colored = () => Boolean(process.stdout.isTTY && process.stderr.isTTY);

export const mark = (m: Mark): string => (colored() ? styleText(MARKS[m][1], MARKS[m][0]) : MARKS[m][0]);

/** Dims skippable details (such as paths). Same color conditions as mark */
export const faint = (text: string): string => (colored() ? styleText("dim", text) : text);

/** Shows the reason to fix something in yellow, like the warn mark. Same color conditions as mark */
export const caution = (text: string): string => (colored() ? styleText("yellow", text) : text);

const title = (text: string): string => `✦ ${text}`;

/** Content lines. Each line of multi-line text gets the marker, and blank lines get only the marker (no trailing space). */
export const rule = (text: string): string =>
  text
    .split("\n")
    .map((line) => (line ? `│ ${line}` : "│"))
    .join("\n");

const foot = (text: string): string => `╰─ ${text}`;

export const panel = (head: string, lines: string[], end: string): string =>
  [title(head), ...lines.map(rule), foot(end)].join("\n");

/**
 * Makes external text (PR and issue bodies, error messages stored in the database) safe to put inside a terminal box. CR cannot overwrite
 * the │ at the line start, and control characters cannot disrupt the terminal. Line breaks (CR, VT, FF, NEL, line separators) become LF, control characters
 * are dropped, and visible drops invisible characters (so agents reading this output never see text people on the terminal cannot).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: drops terminal string sequences (OSC, DCS, APC, PM, SOS) through their terminator
export const STRING_SEQUENCE = /\u001b[\]P_^X][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;

export const plain = (s: string): string =>
  visible(
    // Dropping only ESC from color and title sequences leaves their payload (such as [31m) as text, so drop whole sequences first.
    // stripVTControlCharacters cannot fully drop an OSC with non-ASCII payload, so string sequences are dropped here first
    stripVTControlCharacters(s.replace(STRING_SEQUENCE, ""))
      .replace(/\r\n?|[\v\f\u0085\p{Zl}\p{Zp}]/gu, "\n")
      .replace(/(?![\t\n])\p{Cc}/gu, ""),
  );

/**
 * Text kept on one line (such as names). External text goes through plain, and newlines and tabs become one space. Other spaces (such as ideographic spaces)
 * stay as stored, so a name without newlines, tabs, control characters, or invisible characters that visible drops can be copied back as typed.
 */
export const inline = (s: string): string => plain(s).replace(/[\n\t]+/g, " ");

/**
 * An approximation of terminal display width. Characters above U+00FF count as 2 columns, so full-width text is right and extended Latin and symbols are overcounted
 * (columns only shift slightly). length and padEnd count full-width characters as 1 column, which misaligns columns with full-width text.
 */
export const width = (text: string): number =>
  [...text].reduce((w, c) => w + ((c.codePointAt(0) ?? 0) > 0xff ? 2 : 1), 0);

export const pad = (text: string, to: number): string => text + " ".repeat(Math.max(1, to - width(text)));
